/**
 * pi-workflows — async FIFO semaphore (PRD §5.4, §6.7; plan §4 Slice 4).
 *
 * Single-process, single-threaded primitive. Bounds the number of
 * concurrent acquisitions to `cap`; over-cap callers queue and resume
 * in arrival order. Used by:
 *
 *   - Slice 6 (dispatcher) to bound concurrent `pi -p` sub-agent
 *     subprocesses (PRD §5.4 default 16).
 *   - Slice 8a (`ctx.phase`) to gate phase agent fan-outs (per-run
 *     cap from PRD §6.7).
 *
 * Contract (locked):
 *
 * 1. `acquire(signal?)` returns `Promise<AcquireToken>`. Token is a
 *    `{ release(): void }` shape; release is idempotent (extra calls
 *    are silent no-ops, never under-counted).
 *
 * 2. FIFO under contention: when slots free, queued waiters resume in
 *    the order their `acquire()` was called. The implementation keeps
 *    an explicit deque (array shifted from the head) — Promise-chain
 *    ordering is *not* relied on.
 *
 * 3. AbortSignal:
 *    - If `signal.aborted` is true on entry, `acquire` rejects
 *      synchronously-after-microtask with the signal's `reason`
 *      (defaults to `AbortError` per WebAPI). Active count is
 *      untouched; no token is created.
 *    - For a queued waiter, an `abort` listener removes the waiter
 *      from the queue and rejects the pending promise. The slot was
 *      never granted, so active count is untouched. Listener is
 *      removed in BOTH paths (success + abort) to prevent leaks
 *      across long-running runs.
 *    - Once a slot is granted, the signal is **not** observed —
 *      releasing the slot is the caller's responsibility (per brief).
 *
 * 4. Reentrancy: dequeueing from `release()` is scheduled via
 *    `queueMicrotask` so callers releasing inside their own resolver
 *    do not re-enter the next waiter on the same call stack. (Tested
 *    via mutation: removing the microtask makes the reentrancy test
 *    fail.)
 *
 * 5. `setCap(n)` is supported per plan §4 Slice 4 acceptance:
 *    - Raising the cap immediately drains as many queued waiters as
 *      the new headroom allows, in FIFO order, via microtask.
 *    - Lowering the cap below `inFlight` does NOT preempt holders;
 *      new acquires queue until `inFlight` falls under the new cap.
 *    - `cap=0` blocks all new acquires; existing holders unaffected.
 *    - Negative caps throw `RangeError`.
 *
 * 6. Introspection (for slice 7 ledger + slice 13 overlay):
 *    - `inFlight` — currently-held slot count.
 *    - `queueDepth` — number of waiters currently queued.
 *    - `cap` — current capacity (always ≥ 0).
 *
 * 7. Memory: aborted waiters drop their queue slot synchronously
 *    inside the `abort` listener. `release()` shifts from the head.
 *    A 1000-cycle stress test in `tests/unit/semaphore.test.ts`
 *    asserts `queueDepth === 0` and `inFlight === 0` at exit.
 */

import type { AcquireToken, Semaphore } from "../types/internal.d.ts";

/**
 * Internal queue entry. `cleanup()` is called both when the waiter
 * resolves (success path) and when it's aborted (failure path) — it's
 * the listener-removal hook so AbortSignal subscriptions don't leak.
 */
interface Waiter {
  resolve(token: AcquireToken): void;
  reject(reason: unknown): void;
  cleanup(): void;
  /** Set true when this waiter has already been settled (resolve or
   * reject) — guards against double-settle when an abort fires
   * concurrently with release-driven resolution. */
  settled: boolean;
}

export interface SemaphoreOptions {
  /**
   * Initial capacity. Defaults to 16 per PRD §5.4. Must be a
   * non-negative integer.
   */
  readonly cap?: number;
}

/** Default capacity from PRD §5.4 ("default 16"). */
export const DEFAULT_SEMAPHORE_CAP = 16;

/**
 * Concrete `Semaphore` implementation. Exposed as a class so future
 * tooling (e.g. slice 13's overlay) can `instanceof`-check. The
 * runtime API surface is the `Semaphore` interface in `internal.d.ts`.
 */
export class FifoSemaphore implements Semaphore {
  /** Active count — number of outstanding acquisitions. Never negative. */
  #active = 0;
  /** Current cap. Mutated only via `setCap`. Always ≥ 0. */
  #cap: number;
  /** FIFO queue of waiting acquires. Head = oldest. */
  readonly #queue: Waiter[] = [];

  constructor(options: SemaphoreOptions = {}) {
    const cap = options.cap ?? DEFAULT_SEMAPHORE_CAP;
    if (!Number.isInteger(cap) || cap < 0) {
      throw new RangeError(
        `pi-workflows semaphore: cap must be a non-negative integer, got ${String(cap)}`,
      );
    }
    this.#cap = cap;
  }

  get cap(): number {
    return this.#cap;
  }

  get inFlight(): number {
    return this.#active;
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  /**
   * Acquire a slot. Resolves with a release token when capacity is
   * available. Rejects if `signal` aborts before the slot is granted.
   *
   * Once a token is returned, `signal` is no longer observed — the
   * caller is responsible for releasing.
   */
  acquire(signal?: AbortSignal): Promise<AcquireToken> {
    // Pre-aborted: synchronous rejection. We still return a Promise
    // (Promise.reject), so callers can chain uniformly.
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    // Fast path: slot available, take it.
    if (this.#active < this.#cap) {
      this.#active++;
      return Promise.resolve(this.#makeToken());
    }

    // Slow path: queue.
    return new Promise<AcquireToken>((resolve, reject) => {
      // We need a forward-declared `waiter` so the abort listener can
      // reference it. The closure is `let`-capturing the same binding.
      let waiter: Waiter;

      const onAbort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        // Remove from the queue. Index lookup is O(n) but n is bounded
        // by the queue depth, which in practice is ≤ a few hundred.
        const idx = this.#queue.indexOf(waiter);
        if (idx !== -1) this.#queue.splice(idx, 1);
        // No host-side state changes — slot was never granted.
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal!));
      };

      waiter = {
        resolve: (token) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve(token);
        },
        reject: (reason) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          reject(reason);
        },
        cleanup: () => {
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
        },
        settled: false,
      };

      this.#queue.push(waiter);
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * Reset the cap. See class doc for shrink/grow semantics. Throws
   * `RangeError` for non-integers and negatives.
   */
  setCap(next: number): void {
    if (!Number.isInteger(next) || next < 0) {
      throw new RangeError(
        `pi-workflows semaphore: cap must be a non-negative integer, got ${String(next)}`,
      );
    }
    this.#cap = next;
    // Grew? Drain as many as the new headroom allows. Scheduled via
    // microtask to keep release semantics uniform.
    if (this.#active < this.#cap && this.#queue.length > 0) {
      queueMicrotask(() => this.#drain());
    }
  }

  // ─── private ─────────────────────────────────────────────────────

  #makeToken(): AcquireToken {
    let released = false;
    const release = (): void => {
      if (released) return; // idempotent
      released = true;
      this.#active--;
      // Schedule the next waiter on a fresh microtask — never on the
      // current call stack — so callers can release inside their own
      // resolver without re-entering the next acquire.
      queueMicrotask(() => this.#drain());
    };
    return { release };
  }

  /**
   * Wake queued waiters until either the queue is empty or `inFlight`
   * reaches the cap. Already-settled waiters (e.g. aborted between
   * the schedule and the drain) are skipped.
   */
  #drain(): void {
    while (this.#queue.length > 0 && this.#active < this.#cap) {
      const w = this.#queue.shift();
      if (w === undefined || w.settled) continue;
      this.#active++;
      w.resolve(this.#makeToken());
    }
  }
}

/**
 * Convenience factory mirroring the public-typed surface. Lets call
 * sites that don't care about the class form import a free function.
 */
export function makeSemaphore(options?: SemaphoreOptions): Semaphore {
  return new FifoSemaphore(options);
}

/**
 * Resolve `signal.reason` to a rejection value. WebAPI guarantees
 * `reason` is set to a DOMException-shaped `AbortError` when aborted
 * without an explicit reason; we forward whatever the signal carries.
 */
function abortReason(signal: AbortSignal): unknown {
  // Defensive: some test harnesses produce signals without `reason`.
  if ("reason" in signal && signal.reason !== undefined) return signal.reason;
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}
