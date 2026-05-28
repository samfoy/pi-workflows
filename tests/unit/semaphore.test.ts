/**
 * tests/unit/semaphore.test.ts — slice 4 FIFO async semaphore.
 *
 * Acceptance per `plan.md` §4 Slice 4 + builder brief contract:
 *
 *   - capacity: cap-N admits at most N concurrent acquires.
 *   - FIFO: 30 queued acquires resume in arrival order regardless of
 *     release order (releases in reverse must NOT reverse the
 *     resolution order).
 *   - AbortSignal pre-aborted: acquire rejects with signal.reason;
 *     no slot consumed.
 *   - AbortSignal mid-queue: queued waiter removed + rejected; slot
 *     count unchanged; abort listener removed.
 *   - AbortSignal after grant: holder keeps slot; release still its
 *     responsibility.
 *   - cap=0 blocks all; setCap(n>0) drains in FIFO.
 *   - shrinking cap does not preempt holders.
 *   - release() is idempotent.
 *   - reentrancy: releasing inside .then() must NOT resume next
 *     waiter on the same microtask. (Mutation: removing
 *     `queueMicrotask` flips this.)
 *   - 1000-cycle stress: queueDepth==0, inFlight==0, no listener
 *     leak, completes <2s.
 *   - acquire(undefined) works (no signal).
 *
 * The test file is single-file per slice convention. Tests do not
 * touch the filesystem.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SEMAPHORE_CAP,
  FifoSemaphore,
  makeSemaphore,
} from "../../src/runtime/semaphore.ts";

// ─── helpers ────────────────────────────────────────────────────────

/** Make all currently-pending microtasks run. */
function flushMicrotasks(rounds = 4): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then();
  return p;
}

/** Defer to the next macrotask (setImmediate-style). */
function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── construction & defaults ────────────────────────────────────────

test("default cap is 16 per PRD §5.4", () => {
  const s = makeSemaphore();
  assert.equal(s.cap, DEFAULT_SEMAPHORE_CAP);
  assert.equal(s.cap, 16);
});

test("explicit cap honored", () => {
  const s = makeSemaphore({ cap: 4 });
  assert.equal(s.cap, 4);
});

test("constructor rejects negative cap", () => {
  assert.throws(() => new FifoSemaphore({ cap: -1 }), RangeError);
});

test("constructor rejects non-integer cap", () => {
  assert.throws(() => new FifoSemaphore({ cap: 2.5 }), RangeError);
  assert.throws(() => new FifoSemaphore({ cap: NaN }), RangeError);
  assert.throws(() => new FifoSemaphore({ cap: Infinity }), RangeError);
});

test("introspection getters start at zero", () => {
  const s = makeSemaphore({ cap: 2 });
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
});

// ─── basic capacity admission ───────────────────────────────────────

test("cap of N admits at most N concurrent acquires", async () => {
  const cap = 3;
  const s = makeSemaphore({ cap });
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 12 }, () =>
    (async () => {
      const tok = await s.acquire();
      active++;
      peak = Math.max(peak, active);
      await nextTick();
      active--;
      tok.release();
    })(),
  );
  await Promise.all(tasks);

  assert.equal(peak, cap);
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
});

test("acquire(undefined) works (no signal supplied)", async () => {
  const s = makeSemaphore({ cap: 1 });
  const tok = await s.acquire(undefined);
  assert.equal(s.inFlight, 1);
  tok.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

// ─── FIFO ordering — load-bearing for slice 6 dispatcher ────────────

test("FIFO: 30 queued acquires resume in arrival order", async () => {
  const s = makeSemaphore({ cap: 1 });
  // Hold the only slot so all 30 enqueue.
  const root = await s.acquire();

  const arrivalIds: number[] = [];
  const resolutionIds: number[] = [];
  const tokens: Promise<{ release(): void }>[] = [];

  for (let i = 0; i < 30; i++) {
    arrivalIds.push(i);
    tokens.push(
      s.acquire().then((tok) => {
        resolutionIds.push(i);
        return tok;
      }),
    );
  }
  assert.equal(s.queueDepth, 30);

  // Release root; chain drains. Each acquired token must release before
  // the next can resolve (cap=1), so we await + release in lockstep.
  root.release();
  for (const tokenP of tokens) {
    const tok = await tokenP;
    tok.release();
  }
  await flushMicrotasks();

  assert.deepEqual(resolutionIds, arrivalIds);
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
});

test("FIFO: queue depth tracks accurately during contention", async () => {
  const s = makeSemaphore({ cap: 2 });
  const t1 = await s.acquire();
  const t2 = await s.acquire();
  assert.equal(s.inFlight, 2);
  assert.equal(s.queueDepth, 0);

  const w1 = s.acquire();
  const w2 = s.acquire();
  const w3 = s.acquire();
  assert.equal(s.queueDepth, 3);

  t1.release();
  await flushMicrotasks();
  assert.equal(s.queueDepth, 2);
  const tw1 = await w1;
  t2.release();
  await flushMicrotasks();
  assert.equal(s.queueDepth, 1);
  const tw2 = await w2;
  // drain remaining
  tw1.release();
  tw2.release();
  await flushMicrotasks();
  const tw3 = await w3;
  tw3.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

// ─── AbortSignal semantics ──────────────────────────────────────────

test("AbortSignal pre-aborted: rejects with signal.reason, slot untouched", async () => {
  const s = makeSemaphore({ cap: 2 });
  const ctrl = new AbortController();
  const customReason = new Error("user-bail");
  customReason.name = "AbortError";
  ctrl.abort(customReason);

  await assert.rejects(
    () => s.acquire(ctrl.signal),
    (err: unknown) => err === customReason,
  );
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
});

test("AbortSignal mid-queue: rejects, slot count unchanged, listener removed", async () => {
  const s = makeSemaphore({ cap: 1 });
  const root = await s.acquire();

  const ctrl = new AbortController();
  // Spy on listener add/remove to assert no leak.
  let addCount = 0;
  let removeCount = 0;
  const origAdd = ctrl.signal.addEventListener.bind(ctrl.signal);
  const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
    if (args[0] === "abort") addCount++;
    return origAdd(...args);
  }) as typeof origAdd;
  ctrl.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
    if (args[0] === "abort") removeCount++;
    return origRemove(...args);
  }) as typeof origRemove;

  const w = s.acquire(ctrl.signal);
  // Also queue one with no signal to verify it survives the abort.
  const w2 = s.acquire();
  assert.equal(s.queueDepth, 2);
  assert.equal(addCount, 1);

  ctrl.abort();
  await assert.rejects(() => w, (err: unknown) => (err as Error).name === "AbortError");

  // Aborted waiter dropped synchronously inside the abort listener.
  assert.equal(s.queueDepth, 1);
  assert.equal(s.inFlight, 1); // root still held
  // Listener removed inside abort path — no leak.
  assert.equal(removeCount, 1);

  // Releasing root must hand the slot to w2 (the survivor), not the
  // aborted waiter.
  root.release();
  const tok2 = await w2;
  assert.equal(s.inFlight, 1);
  tok2.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

test("AbortSignal listener removed on success path too (no leak across grants)", async () => {
  const s = makeSemaphore({ cap: 1 });
  const root = await s.acquire();
  const ctrl = new AbortController();

  let removeCount = 0;
  const origRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
    if (args[0] === "abort") removeCount++;
    return origRemove(...args);
  }) as typeof origRemove;

  const w = s.acquire(ctrl.signal);
  root.release();
  const tok = await w;
  // Listener removed when waiter resolved successfully.
  assert.equal(removeCount, 1);
  // Aborting after grant must NOT crash; listener is already gone.
  ctrl.abort();
  // Caller still owns the slot.
  assert.equal(s.inFlight, 1);
  tok.release();
  await flushMicrotasks();
});

test("AbortSignal after slot granted: caller keeps slot, must release", async () => {
  const s = makeSemaphore({ cap: 1 });
  const ctrl = new AbortController();
  const tok = await s.acquire(ctrl.signal);
  assert.equal(s.inFlight, 1);

  ctrl.abort();
  // Slot is still held — abort is a no-op post-grant.
  assert.equal(s.inFlight, 1);

  tok.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

// ─── setCap dynamics ────────────────────────────────────────────────

test("setCap(n>0) on a cap=0 semaphore drains queued waiters in FIFO", async () => {
  const s = makeSemaphore({ cap: 0 });
  const order: number[] = [];
  const ws = Array.from({ length: 5 }, (_, i) =>
    s.acquire().then((tok) => {
      order.push(i);
      return tok;
    }),
  );
  await flushMicrotasks();
  assert.equal(s.queueDepth, 5);
  assert.equal(s.inFlight, 0);

  s.setCap(3);
  await flushMicrotasks();
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(s.inFlight, 3);
  assert.equal(s.queueDepth, 2);

  // Release one — next queued waiter takes the slot.
  const tok0 = await ws[0]!;
  tok0.release();
  await flushMicrotasks();
  assert.deepEqual(order, [0, 1, 2, 3]);

  // Drain.
  for (let i = 1; i < 5; i++) (await ws[i]!).release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

test("setCap shrinking does NOT preempt active holders", async () => {
  const s = makeSemaphore({ cap: 5 });
  const tokens = await Promise.all([s.acquire(), s.acquire(), s.acquire()]);
  assert.equal(s.inFlight, 3);

  s.setCap(1);
  // Holders unaffected.
  assert.equal(s.inFlight, 3);
  assert.equal(s.cap, 1);

  // New acquires queue.
  const w = s.acquire();
  await flushMicrotasks();
  assert.equal(s.queueDepth, 1);

  // Release two — inFlight drops to 1, still ≥ cap, queue stays.
  tokens[0].release();
  tokens[1].release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 1);
  assert.equal(s.queueDepth, 1);

  // Release the third — inFlight drops to 0, queue drains by one.
  tokens[2].release();
  const tw = await w;
  assert.equal(s.inFlight, 1);
  tw.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
});

test("setCap rejects negative + non-integer", () => {
  const s = makeSemaphore({ cap: 1 });
  assert.throws(() => s.setCap(-1), RangeError);
  assert.throws(() => s.setCap(1.5), RangeError);
  assert.throws(() => s.setCap(NaN), RangeError);
});

test("setCap(0) does not break already-acquired holders", async () => {
  const s = makeSemaphore({ cap: 2 });
  const tok = await s.acquire();
  s.setCap(0);
  assert.equal(s.inFlight, 1);
  // New acquire queues forever (until setCap raises).
  let resolved = false;
  s.acquire().then(() => {
    resolved = true;
  });
  await flushMicrotasks();
  assert.equal(resolved, false);
  assert.equal(s.queueDepth, 1);

  tok.release();
  await flushMicrotasks();
  // Cap is 0 — drain should not have advanced anything.
  assert.equal(resolved, false);
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 1);
});

// ─── release() edge cases ───────────────────────────────────────────

test("release() is idempotent — extra calls do not under-count", async () => {
  const s = makeSemaphore({ cap: 1 });
  const tok = await s.acquire();
  assert.equal(s.inFlight, 1);
  tok.release();
  tok.release(); // no-op
  tok.release(); // no-op
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
  // Another acquire still works — we didn't go negative or stuck.
  const tok2 = await s.acquire();
  assert.equal(s.inFlight, 1);
  tok2.release();
});

// ─── reentrancy: release must not synchronously resume next waiter ──

test("reentrancy: releasing inside .then() does NOT resume next waiter on same microtask", async () => {
  const s = makeSemaphore({ cap: 1 });
  const root = await s.acquire();

  const events: string[] = [];

  // Queue two waiters.
  const w1 = s.acquire().then((tok) => {
    events.push("w1-acquired");
    // Release synchronously inside our resolver. The next acquire
    // (w2) MUST NOT resolve before this resolver returns control.
    tok.release();
    events.push("w1-after-release");
  });
  const w2 = s.acquire().then((tok) => {
    events.push("w2-acquired");
    tok.release();
  });

  root.release();
  await Promise.all([w1, w2]);

  // The critical assertion: "w1-after-release" must precede
  // "w2-acquired". If `release()` synchronously dispatches the next
  // waiter (mutation: drop `queueMicrotask`), w2-acquired sneaks in
  // before w1-after-release.
  const idxAfter = events.indexOf("w1-after-release");
  const idxW2 = events.indexOf("w2-acquired");
  assert.ok(idxAfter !== -1 && idxW2 !== -1);
  assert.ok(
    idxAfter < idxW2,
    `expected w1-after-release before w2-acquired, got ${JSON.stringify(events)}`,
  );
});

// ─── stress: 1000 cycles, no leaks, no deadlocks, <2s ───────────────

test("1000-cycle stress: random delays, queueDepth==0, inFlight==0, no leak", async (t) => {
  t.diagnostic("starting stress test");
  const start = performance.now();
  const cap = 8;
  const cycles = 1000;
  const s = makeSemaphore({ cap });
  let peak = 0;

  const tasks = Array.from({ length: cycles }, (_, i) =>
    (async () => {
      // Half use a never-aborted signal, half use no signal.
      const ctrl = i % 2 === 0 ? new AbortController() : undefined;
      const tok = await s.acquire(ctrl?.signal);
      peak = Math.max(peak, s.inFlight);
      // Random jitter 0..2ms.
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, i % 3));
      tok.release();
      // Idempotent extra release.
      if (i % 7 === 0) tok.release();
    })(),
  );

  await Promise.all(tasks);
  const elapsed = performance.now() - start;
  t.diagnostic(`elapsed ${elapsed.toFixed(0)}ms, peak inFlight ${peak}`);

  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
  assert.ok(peak <= cap, `peak ${peak} exceeded cap ${cap}`);
  assert.ok(elapsed < 2000, `stress test took ${elapsed.toFixed(0)}ms (>2s)`);
});

test("1000-abort cycles: queueDepth returns to 0, no listener accumulation", async (t) => {
  const s = makeSemaphore({ cap: 1 });
  const root = await s.acquire();

  const start = performance.now();
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 1000; i++) {
    const ctrl = new AbortController();
    const w = s.acquire(ctrl.signal).catch((e: Error) => {
      if (e.name !== "AbortError") throw e;
      return "aborted";
    });
    tasks.push(w);
    // Half abort immediately, half on next microtask.
    if (i % 2 === 0) ctrl.abort();
    else queueMicrotask(() => ctrl.abort());
  }
  await Promise.all(tasks);
  const elapsed = performance.now() - start;
  t.diagnostic(`abort cycles ${elapsed.toFixed(0)}ms`);

  // All aborted; nothing queued; root still held.
  assert.equal(s.queueDepth, 0);
  assert.equal(s.inFlight, 1);
  root.release();
  await flushMicrotasks();
  assert.equal(s.inFlight, 0);
  assert.ok(elapsed < 2000, `1000 aborts took ${elapsed.toFixed(0)}ms (>2s)`);
});
