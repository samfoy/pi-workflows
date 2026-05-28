/**
 * tests/unit/ctxPhaseReentrancy.test.ts — slice 8a concern R7.
 *
 * Slice 4 critic-t1c3 found that removing `queueMicrotask` from
 * `Semaphore.release()` does NOT fail the existing reentrancy test
 * (Promise.then is intrinsically microtask-deferred). This test adds
 * a stronger synchronous-window witness:
 *
 * After `release()` returns, an immediate synchronous read of
 * `inFlight` + `queueDepth` MUST observe the post-decrement,
 * pre-promote window: `inFlight=0, queueDepth=1`. If a future patch
 * makes #drain synchronous, the same read would observe `inFlight=1,
 * queueDepth=0` and the assertion fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeSemaphore } from "../../src/runtime/semaphore.js";

test("Semaphore mutation-killer: release() decrements synchronously, drains in microtask", async () => {
  const s = makeSemaphore({ cap: 1 });
  const root = await s.acquire();
  const w1Prom = s.acquire();

  // Read state immediately after release() but before any microtask.
  root.release();

  // Synchronous read MUST see the inFlight=0 / queueDepth=1 window
  // (release decrements inFlight, but drain queued via microtask
  // hasn't run yet). If drain ran synchronously, this reads
  // inFlight=1 / queueDepth=0 — mutation-killer.
  assert.equal(
    s.inFlight,
    0,
    "release decrements inFlight synchronously",
  );
  assert.equal(
    s.queueDepth,
    1,
    "but drain is microtask-deferred (queueDepth still 1)",
  );

  // Now let the microtask run.
  const tok = await w1Prom;
  assert.equal(s.inFlight, 1);
  assert.equal(s.queueDepth, 0);
  tok.release();
});

test("FIFO at cap>1 with random release order resolves monotonically", async () => {
  // Slice 6 concern: slice-4 reformulated FIFO test only verifies
  // cap=1. The original load-bearing claim "FIFO survives out-of-order
  // releases" wasn't tested at cap>1. Cover it here.
  const cap = 4;
  const totalWaiters = 16;
  const s = makeSemaphore({ cap });
  // Take cap slots so all 16 enqueue.
  const held: { release(): void }[] = [];
  for (let i = 0; i < cap; i++) held.push(await s.acquire());
  assert.equal(s.inFlight, cap);

  const arrival: number[] = [];
  const resolution: number[] = [];
  const waiterPromises: Promise<{ release(): void }>[] = [];
  for (let i = 0; i < totalWaiters; i++) {
    arrival.push(i);
    waiterPromises.push(
      s.acquire().then((tok) => {
        resolution.push(i);
        return tok;
      }),
    );
  }
  assert.equal(s.queueDepth, totalWaiters);

  // Release the cap held tokens in a non-arrival order. The first
  // `cap` waiters should now be FIFO-promoted regardless of which
  // held slot freed up.
  const order = [3, 0, 2, 1];
  for (const idx of order) held[idx]!.release();

  // Drain the remaining 16 waiters in lockstep (each released token
  // frees one slot for the next queued waiter).
  for (const p of waiterPromises) {
    const tok = await p;
    tok.release();
  }

  // Resolution order must equal arrival (FIFO).
  assert.deepEqual(resolution, arrival);
  await new Promise<void>((r) => queueMicrotask(r));
  assert.equal(s.inFlight, 0);
  assert.equal(s.queueDepth, 0);
});
