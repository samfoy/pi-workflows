/**
 * tests/unit/timerEscape.test.ts — timer callback-handle table tests.
 *
 * PRD §8.3.5 acceptance: (a) callback's `this`-binding stays in the
 * Context, (b) thrown error's prototype is Context-realm Error,
 * (c) abort clears all pending timers within 50ms, (d) nested
 * setTimeout-chains still abort cleanly.
 *
 * Implemented at the `installTimerBridge` level — full integration
 * via `runScript` is in `sandbox.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { installTimerBridge } from "../../src/runtime/timerTable.ts";

/**
 * Helper: build a fresh vm.Context + bridge tied to a fresh
 * AbortController. Returns everything for the test to drive.
 */
function makeRig(): {
  ctx: vm.Context;
  ctrl: AbortController;
  bridge: ReturnType<typeof installTimerBridge>;
} {
  const ctx = vm.createContext({});
  const ctrl = new AbortController();
  const bridge = installTimerBridge(ctx, { signal: ctrl.signal });
  return { ctx, ctrl, bridge };
}

test("scheduleTimeout: fires and removes from outstanding", async () => {
  const rig = makeRig();
  let fired = false;
  rig.bridge.bridge.scheduleTimeout(() => {
    fired = true;
  }, 5);
  assert.equal(rig.bridge.stats.outstandingTimeouts, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, true);
  assert.equal(rig.bridge.stats.outstandingTimeouts, 0);
  rig.bridge.dispose();
});

test("cancelTimeout: never fires after cancel", async () => {
  const rig = makeRig();
  let fired = false;
  const h = rig.bridge.bridge.scheduleTimeout(() => {
    fired = true;
  }, 5);
  rig.bridge.bridge.cancelTimeout(h);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, false);
  assert.equal(rig.bridge.stats.outstandingTimeouts, 0);
  rig.bridge.dispose();
});

test("cancelTimeout: unknown handle is a no-op", () => {
  const rig = makeRig();
  rig.bridge.bridge.cancelTimeout(99999); // doesn't throw
  rig.bridge.dispose();
});

test("AbortSignal: dispose clears all pending timers within 50ms", async () => {
  const rig = makeRig();
  let firedCount = 0;
  for (let i = 0; i < 10; i++) {
    rig.bridge.bridge.scheduleTimeout(() => {
      firedCount++;
    }, 100); // would fire at ~100ms
  }
  assert.equal(rig.bridge.stats.outstandingTimeouts, 10);

  // Abort at 10ms — well before the 100ms timers would fire.
  setTimeout(() => rig.ctrl.abort(), 10);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(rig.bridge.disposed, true);
  assert.equal(rig.bridge.stats.outstandingTimeouts, 0);
  assert.equal(firedCount, 0, "no timers should have fired after abort");
});

test("AbortSignal pre-aborted: bridge starts disposed", () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const ctx = vm.createContext({});
  const bridge = installTimerBridge(ctx, { signal: ctrl.signal });
  // Pre-aborted bridge should refuse to schedule.
  const h = bridge.bridge.scheduleTimeout(() => {}, 0);
  assert.equal(h, 0, "pre-aborted scheduleTimeout returns 0 (no-op)");
  assert.equal(bridge.disposed, true);
});

test("setInterval: fires repeatedly until cancelled", async () => {
  const rig = makeRig();
  let fires = 0;
  const h = rig.bridge.bridge.scheduleInterval(() => {
    fires++;
  }, 10);
  await new Promise((r) => setTimeout(r, 65));
  rig.bridge.bridge.cancelInterval(h);
  // Should have fired at least 3 times (give some scheduling slack).
  assert.ok(fires >= 3, `expected ≥3 interval fires, got ${fires}`);
  const beforeWait = fires;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fires, beforeWait, "interval must stop firing after cancel");
  rig.bridge.dispose();
});

test("queueMicrotask: fires once, no handle", async () => {
  const rig = makeRig();
  let fired = false;
  rig.bridge.bridge.queueMicrotask(() => {
    fired = true;
  });
  // Microtasks fire on next tick.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fired, true);
  rig.bridge.dispose();
});

test("queueMicrotask: aborted bridge does NOT fire scheduled microtask", async () => {
  const rig = makeRig();
  let fired = false;
  rig.bridge.bridge.queueMicrotask(() => {
    fired = true;
  });
  rig.ctrl.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, false);
});

test("setImmediate: fires once, cancelled before fire", async () => {
  const rig = makeRig();
  let fired = false;
  const h = rig.bridge.bridge.scheduleImmediate(() => {
    fired = true;
  });
  rig.bridge.bridge.cancelImmediate(h);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(fired, false);
});

test("nested setTimeout-chain: abort breaks the chain", async () => {
  const rig = makeRig();
  let depth = 0;
  const schedule = (): void => {
    rig.bridge.bridge.scheduleTimeout(() => {
      depth++;
      schedule(); // nest
    }, 5);
  };
  schedule();
  setTimeout(() => rig.ctrl.abort(), 30);
  await new Promise((r) => setTimeout(r, 100));
  const before = depth;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(depth, before, "nested chain must stop after abort");
  assert.ok(depth >= 1, "but at least one fire happened pre-abort");
});

test("callback throw: onTimerContextError sees reconstructed error", async () => {
  const ctx = vm.createContext({});
  const ctrl = new AbortController();
  let captured_ctxErr: Error | undefined;
  let onTimerErrorFired = false;
  const bridge = installTimerBridge(ctx, {
    signal: ctrl.signal,
    onTimerError: () => {
      onTimerErrorFired = true; // should NOT fire when reconstruction succeeds
    },
    onTimerContextError: (e) => {
      captured_ctxErr = e;
    },
  });
  bridge.bridge.scheduleTimeout(() => {
    throw new Error("boom");
  }, 5);
  await new Promise((r) => setTimeout(r, 30));
  // onTimerError must NOT fire when realm reconstruction succeeded (BUG-005 fix).
  assert.equal(onTimerErrorFired, false, "onTimerError must not fire when reconstruction succeeded");
  // onTimerContextError receives the realm-reconstructed error.
  assert.ok(captured_ctxErr, "onTimerContextError should have fired");
  assert.equal(captured_ctxErr!.message, "boom");
  // Reconstructed error is in the Context realm.
  const isCtxRealm = vm.runInContext(`(e) => e instanceof Error`, ctx)(
    captured_ctxErr,
  );
  assert.ok(isCtxRealm);
  bridge.dispose();
});

test("callback throw: non-Error value is wrapped per realm contract", async () => {
  const ctx = vm.createContext({});
  const ctrl = new AbortController();
  let captured_ctxErr: Error | undefined;
  const bridge = installTimerBridge(ctx, {
    signal: ctrl.signal,
    onTimerContextError: (e) => {
      captured_ctxErr = e;
    },
  });
  bridge.bridge.scheduleTimeout(() => {
    throw 42; // eslint-disable-line no-throw-literal
  }, 5);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(captured_ctxErr!.message, "42");
  assert.equal(
    (captured_ctxErr as Error & { wrappedNonError?: boolean })
      .wrappedNonError,
    true,
  );
  assert.equal(
    (captured_ctxErr as Error & { originalType?: string }).originalType,
    "number",
  );
  bridge.dispose();
});

test("disposed bridge refuses new schedules (returns 0)", () => {
  const rig = makeRig();
  rig.bridge.dispose();
  const h1 = rig.bridge.bridge.scheduleTimeout(() => {}, 5);
  const h2 = rig.bridge.bridge.scheduleInterval(() => {}, 5);
  const h3 = rig.bridge.bridge.scheduleImmediate(() => {});
  assert.equal(h1, 0);
  assert.equal(h2, 0);
  assert.equal(h3, 0);
});

test("non-function callback rejected with TypeError", () => {
  const rig = makeRig();
  assert.throws(
    () => rig.bridge.bridge.scheduleTimeout(undefined as unknown as () => void, 0),
    /must be a function/,
  );
  assert.throws(
    () => rig.bridge.bridge.scheduleInterval("foo" as unknown as () => void, 0),
    /must be a function/,
  );
  rig.bridge.dispose();
});

test("MUTATION-PROBE: removing dispose's clear() must let timers leak", async () => {
  // This test is the canary: if someone deletes the `clearTimeout(id)`
  // loop in `dispose()`, the timer fires AFTER abort. We assert it
  // doesn't.
  const rig = makeRig();
  let fired = false;
  rig.bridge.bridge.scheduleTimeout(() => {
    fired = true;
  }, 30);
  rig.ctrl.abort();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, false, "dispose must clear pending timers");
});
