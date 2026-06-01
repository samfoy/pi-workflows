/**
 * pi-workflows — timer callback-handle table (host side).
 *
 * Implements PRD §8.3.5 (timer-based escape mitigation). The Context
 * (sandbox) sees only Context-realm wrappers around setTimeout /
 * setInterval / queueMicrotask / setImmediate; the host owns the
 * actual Node timer IDs.
 *
 * Design (per redteam-revised brief):
 *
 *   - Per-run `callbackTable: Map<number, () => void>` — the wrapped
 *     callbacks queued for execution. Indexed by a numeric handle.
 *   - Per-run `timerIds: Map<number, NodeJS.Timeout>` — Node-side IDs
 *     so we can `clearTimeout` on AbortSignal.
 *   - Per-run `intervalIds: Map<number, NodeJS.Timeout>` — same, for
 *     `setInterval` (intervals fire repeatedly so the table entry
 *     survives multiple invocations).
 *   - On AbortSignal: `disposeAll()` clears every Node timer, deletes
 *     every callback. After `disposeAll`, scheduling new timers is a
 *     no-op (returns handle 0).
 *
 * The trampoline path: inside the sandbox, `globalThis.setTimeout` is
 * a Context-realm function defined at init that:
 *
 *   1. validates `cb` is a function,
 *   2. wraps `cb(...args)` in a Context-realm arrow `() => cb(...args)`,
 *   3. calls `__hostBridge.scheduleTimeout(wrapped, ms)` which returns
 *      a numeric handle.
 *
 * The bridge captures `wrapped` (a Context-realm fn — invoking it from
 * host realm starts execution in Context realm), schedules a Node
 * timer that, on fire, invokes the wrapper with `this === undefined`
 * (we use a host arrow `() => wrapped()` so timer's `this`-injection
 * doesn't leak; the inner arrow is in Context realm so calling `cb`
 * from there sees Context realm).
 *
 * Errors thrown from `cb` (via the Context-realm wrapped) bubble out
 * of the host's `wrapped()` invocation. The host catches and reports
 * to the run-level `onTimerError` hook (slice 2 = test sink, slice 7 =
 * ledger writer, slice 8a = run failure path).
 */

import vm from "node:vm";

import type { SandboxViolationError } from "../types/internal.js";
import { rethrowAcrossRealm } from "./realmError.js";

/**
 * Host-side handle used by the sandbox's bridge. The sandbox treats
 * these as opaque numbers; the bridge uses them to look up Node
 * timer IDs.
 */
export type TimerHandle = number;

export interface TimerTableOpts {
  readonly signal: AbortSignal;
  /**
   * Invoked when a timer callback throws. The host has already
   * caught the error; the hook decides whether to fail the run, log
   * a ledger entry, etc. Slice 2 wires this to a test-side sink;
   * slice 7 replaces with the ledger writer.
   */
  readonly onTimerError?: (err: unknown) => void;
  /**
   * Optional — receives the Context-realm Error from which the host
   * timer error was reconstructed, for unit tests that want to assert
   * the realm-boundary contract held.
   */
  readonly onTimerContextError?: (ctxErr: Error) => void;
}

/**
 * Returned by `installTimerBridge`. The sandbox keeps the bridge
 * object alive in a closure so the script can't reach it; the host
 * holds the table for cleanup.
 */
export interface TimerBridge {
  /**
   * Sandbox-facing functions. These are HOST-realm functions but they
   * accept Context-realm callbacks safely:
   *
   *   - `scheduleTimeout(wrapped, ms)` — `wrapped` is a Context-realm
   *     `() => cb(...args)` arrow. Bridge schedules a Node timer that
   *     invokes `wrapped()` (Context-realm execution) with `this`
   *     unset.
   *
   *   - `cancelTimeout(handle)` — clears the Node timer associated
   *     with the handle. No-op if the handle is unknown / already
   *     fired.
   *
   *   - similar for setInterval / clearInterval / setImmediate /
   *     clearImmediate / queueMicrotask.
   */
  readonly bridge: {
    scheduleTimeout(wrapped: () => void, ms: number): TimerHandle;
    cancelTimeout(handle: TimerHandle): void;
    scheduleInterval(wrapped: () => void, ms: number): TimerHandle;
    cancelInterval(handle: TimerHandle): void;
    scheduleImmediate(wrapped: () => void): TimerHandle;
    cancelImmediate(handle: TimerHandle): void;
    queueMicrotask(wrapped: () => void): void;
  };

  /**
   * Tear down: clears every outstanding timer and revokes the bridge.
   * Safe to call multiple times. Called automatically when the
   * AbortSignal fires.
   */
  dispose(): void;

  /**
   * For tests/diagnostics. Counts of currently outstanding timers
   * (does not include already-fired one-shots).
   */
  readonly stats: {
    readonly outstandingTimeouts: number;
    readonly outstandingIntervals: number;
    readonly outstandingImmediates: number;
  };

  /**
   * For tests: did the AbortSignal fire and dispose the bridge?
   */
  readonly disposed: boolean;
}

/**
 * Construct the bridge for one Context. The bridge object's methods
 * are host-realm closures that capture the table. The Context-realm
 * `setTimeout` / `clearTimeout` wrappers are installed by `sandbox.ts`
 * at Context init — they're the ones that delegate to this bridge.
 *
 * `context` is the vm.Context the bridge serves. It's needed for
 * realm-error reconstruction when a callback throws (we want to
 * surface a Context-realm error to the script's error handlers, even
 * though our test hooks see the host-realm capture).
 */
export function installTimerBridge(
  context: vm.Context,
  opts: TimerTableOpts,
): TimerBridge {
  const callbackTable = new Map<TimerHandle, () => void>();
  const timerIds = new Map<TimerHandle, NodeJS.Timeout>();
  const intervalIds = new Map<TimerHandle, NodeJS.Timeout>();
  const immediateIds = new Map<TimerHandle, NodeJS.Immediate>();
  let nextHandle: TimerHandle = 1;
  let disposed = false;

  /**
   * Invoke a Context-realm wrapper safely:
   *   - The wrapper is an arrow defined inside the Context, so
   *     invoking it starts execution in the Context realm.
   *   - We invoke as `wrapped()` (no `this`-binding) so a hostile
   *     timer-injected `this` can't leak.
   *   - On throw: capture host-side, reconstruct as Context-realm
   *     Error (so the script's surrounding Promise / catch sees
   *     same-realm), and forward to `onTimerError` for run-level
   *     bookkeeping.
   */
  function invokeWrapped(handle: TimerHandle, wrapped: () => void): void {
    if (disposed) return;
    try {
      wrapped();
    } catch (hostErr) {
      // Reconstruct as Context-realm error so the test can assert
      // the realm-boundary contract held. We don't actually re-throw
      // into the Context — by the time we got here, the script's
      // setTimeout call has long since returned, and there's no Promise
      // to reject. Slice 8a's `runScript` will cause a top-level
      // rejection if the timer-error fires while the user script's
      // Promise is still pending. Slice 2 just records.
      try {
        const ctxErr = rethrowAcrossRealm(hostErr, context);
        opts.onTimerContextError?.(ctxErr);
        return;
      } catch (reconErr) {
        // Reconstruction itself failed — pass the SandboxViolationError
        // through. Test hook will see it; production wires it to the
        // run-failure path.
        const violation = reconErr as SandboxViolationError;
        opts.onTimerError?.(violation);
        throw violation;
      }
    } finally {
      // For one-shots, the table entry is already removed by the
      // node-timer-callback wrapper. For intervals, we keep the entry
      // so subsequent fires hit it.
    }
  }

  /**
   * AbortSignal cleanup. Idempotent.
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const id of timerIds.values()) clearTimeout(id);
    for (const id of intervalIds.values()) clearInterval(id);
    for (const id of immediateIds.values()) clearImmediate(id);
    timerIds.clear();
    intervalIds.clear();
    immediateIds.clear();
    callbackTable.clear();
  }

  if (opts.signal.aborted) {
    // Already aborted before we were even built — disposed at birth.
    disposed = true;
  } else {
    const onAbort = (): void => dispose();
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const bridge: TimerBridge["bridge"] = {
    scheduleTimeout(wrapped, ms): TimerHandle {
      if (disposed) return 0;
      if (typeof wrapped !== "function") {
        throw new TypeError("scheduleTimeout: wrapped must be a function");
      }
      const h = nextHandle++;
      callbackTable.set(h, wrapped);
      const id = setTimeout(() => {
        // Remove first so a synchronous re-schedule from the callback
        // doesn't see stale state.
        timerIds.delete(h);
        callbackTable.delete(h);
        invokeWrapped(h, wrapped);
      }, ms);
      // We intentionally do NOT `unref()` here — the user script's
      // outer Promise is awaiting this timer, so the host event loop
      // MUST keep alive until it fires. AbortSignal cleanup handles
      // leaked timers; sandbox.dispose() on run end clears any
      // remainder.
      timerIds.set(h, id);
      return h;
    },

    cancelTimeout(handle): void {
      const id = timerIds.get(handle);
      if (id !== undefined) {
        clearTimeout(id);
        timerIds.delete(handle);
        callbackTable.delete(handle);
      }
    },

    scheduleInterval(wrapped, ms): TimerHandle {
      if (disposed) return 0;
      if (typeof wrapped !== "function") {
        throw new TypeError("scheduleInterval: wrapped must be a function");
      }
      const h = nextHandle++;
      callbackTable.set(h, wrapped);
      const id = setInterval(() => {
        // Don't delete on each fire — intervals repeat.
        invokeWrapped(h, wrapped);
      }, ms);
      intervalIds.set(h, id);
      return h;
    },

    cancelInterval(handle): void {
      const id = intervalIds.get(handle);
      if (id !== undefined) {
        clearInterval(id);
        intervalIds.delete(handle);
        callbackTable.delete(handle);
      }
    },

    scheduleImmediate(wrapped): TimerHandle {
      if (disposed) return 0;
      if (typeof wrapped !== "function") {
        throw new TypeError("scheduleImmediate: wrapped must be a function");
      }
      const h = nextHandle++;
      callbackTable.set(h, wrapped);
      const id = setImmediate(() => {
        immediateIds.delete(h);
        callbackTable.delete(h);
        invokeWrapped(h, wrapped);
      });
      immediateIds.set(h, id);
      return h;
    },

    cancelImmediate(handle): void {
      const id = immediateIds.get(handle);
      if (id !== undefined) {
        clearImmediate(id);
        immediateIds.delete(handle);
        callbackTable.delete(handle);
      }
    },

    queueMicrotask(wrapped): void {
      if (disposed) return;
      if (typeof wrapped !== "function") {
        throw new TypeError("queueMicrotask: wrapped must be a function");
      }
      // No handle for microtasks — they can't be cancelled. Schedule a
      // host microtask that invokes the Context-realm wrapper.
      // `queueMicrotask` doesn't pass `this`, so no realm leak.
      queueMicrotask(() => {
        if (disposed) return;
        invokeWrapped(-1, wrapped);
      });
    },
  };

  return {
    bridge,
    dispose,
    get stats() {
      return {
        outstandingTimeouts: timerIds.size,
        outstandingIntervals: intervalIds.size,
        outstandingImmediates: immediateIds.size,
      };
    },
    get disposed() {
      return disposed;
    },
  };
}
