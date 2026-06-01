/**
 * src/types/internal/concurrency.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the concurrency slice is needed.
 */

// ───────────────────────────────────────────────────────────────────────
// Slice 4 — FIFO async semaphore
// ───────────────────────────────────────────────────────────────────────

/**
 * Token returned by `Semaphore.acquire()`. The caller must invoke
 * `release()` exactly once (extra calls are silent no-ops). The slot
 * is held until release; the original `acquire`'s AbortSignal is no
 * longer observed once a token is granted.
 */
export interface AcquireToken {
  release(): void;
}

/**
 * Async FIFO semaphore. Slice 4 publishes the concrete impl; slices 6
 * (dispatcher) and 8a (`ctx.phase`) are the consumers. Slice 7 reads
 * `inFlight` / `queueDepth` for ledger accounting; slice 13 reads them
 * for the overlay.
 *
 * `setCap(n)` is supported. Shrinking does NOT preempt holders —
 * inFlight may legitimately exceed `cap` until natural release. v2:
 * dynamic per-phase caps would land here.
 */
export interface Semaphore {
  /** Currently-held slot count. Never negative. */
  readonly inFlight: number;
  /** Currently-queued (un-resumed) waiter count. */
  readonly queueDepth: number;
  /** Current capacity. */
  readonly cap: number;

  /**
   * Acquire a slot. If `signal.aborted` on entry, rejects with the
   * signal's `reason`. If signal aborts while queued, the waiter is
   * removed from the queue and the promise rejects. If the signal
   * aborts AFTER a token is granted, the rejection is *not* delivered
   * — the caller still owns the slot and is responsible for release.
   */
  acquire(signal?: AbortSignal): Promise<AcquireToken>;

  /**
   * Reset the cap. Raising drains queued waiters in FIFO order.
   * Lowering does not preempt active holders; new acquires queue
   * until inFlight drops under the new cap. Throws `RangeError` for
   * non-integers or negatives.
   */
  setCap(next: number): void;
}

