/**
 * pi-workflows — cooperative pause gate (slice 12).
 *
 * Sits between `runOneAgent` (in `runCtx.ts`) and the run semaphore.
 * Each agent spawn awaits `waitWhilePaused(signal)` BEFORE acquiring
 * a semaphore slot, so a paused run holds no host-realm resources
 * (other runs sharing the cap continue to drain).
 *
 * Design choices:
 *
 *   - **Single shared promise per pause.** Every pending waiter
 *     resolves on the next `resume()`. Avoids per-waiter listener
 *     bookkeeping; resume is O(1) regardless of queue depth.
 *
 *   - **AbortSignal wins races.** If the per-run abort fires while
 *     paused, every waiter rejects with the signal's reason. This
 *     is the "pause + abort race" branch from plan §4 Slice 12 —
 *     stop must override pause.
 *
 *   - **Idempotence.** `pause()` on an already-paused gate is a
 *     no-op (returns false). Same for `resume()` on an unpaused
 *     gate. Callers (RunManager) use the boolean to gate ledger
 *     emissions.
 *
 *   - **No state-machine awareness.** The gate handles only
 *     run/wait coordination; RunManager owns transition writes
 *     through `RunStateMachine.go("paused" | "running")`. This
 *     keeps the gate testable without a ledger.
 *
 * Slice 13 (TUI overlay) will read `paused` to render the badge
 * and call `pause`/`resume` on the Run handle.
 *
 * Refs: plan.md §4 Slice 12, PRD §5.7 (state machine).
 */

/**
 * Internal coordination primitive — not exposed on the author-facing
 * `ctx` surface. RunManager owns one instance per Run; runCtx
 * consumes it through `RunCtxHostOptions.pauseGate`.
 */
export class PauseGate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #paused = false;
  #resumePromise: Promise<void> | null = null;
  #resolveResume: (() => void) | null = null;

  /** True iff the gate currently blocks new spawns. */
  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Engage the gate. Returns `true` if state changed (caller should
   * emit a ledger `pause` entry + `running → paused` transition);
   * `false` if already paused (idempotent — no second ledger entry,
   * matches plan §4 Slice 12 critic checklist).
   */
  pause(): boolean {
    if (this.#paused) return false;
    this.#paused = true;
    this.#resumePromise = new Promise<void>((resolve) => {
      this.#resolveResume = resolve;
    });
    return true;
  }

  /**
   * Release the gate. Returns `true` if state changed (caller should
   * emit a ledger `resume` entry + `paused → running` transition);
   * `false` if not paused (idempotent — no second ledger entry, no
   * synthetic transition, matches plan §4 Slice 12 critic checklist).
   *
   * **Critical (slice_12_concerns B1):** the `paused → running` edge
   * is the dedicated PRD §5.7 pause-cycle transition. It is NOT the
   * `failed → running` edge from slice 11 (advisory rollback for
   * crash-sweep-flipped runs). Pause/resume must NEVER reach the
   * rollback path because pause never enters `failed` to begin with.
   */
  resume(): boolean {
    if (!this.#paused) return false;
    this.#paused = false;
    const r = this.#resolveResume;
    this.#resolveResume = null;
    this.#resumePromise = null;
    if (r) r();
    return true;
  }

  /**
   * Block until either the gate is unpaused OR `signal` aborts.
   * Resolves immediately if not currently paused. Throws the
   * signal's `.reason` (or a generic AbortError-shaped Error) if
   * the abort wins the race.
   *
   * Loops on `paused` so a pause→resume→pause sequence (rare but
   * legal) re-blocks the waiter.
   */
  async waitWhilePaused(signal?: AbortSignal): Promise<void> {
    while (this.#paused) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      const p = this.#resumePromise;
      if (p === null) throw new Error("PauseGate invariant violation: #paused=true but #resumePromise=null");
      if (signal === undefined) {
        await p;
        continue;
      }
      // Race resume vs abort. Local listener is removed in both
      // branches so listener count stays bounded under churn.
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (err: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    }
  }
}
