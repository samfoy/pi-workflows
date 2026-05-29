/**
 * tests/unit/pauseGate.test.ts — slice 12 PauseGate primitive.
 *
 * Pure-coordination tests with no ledger / no state machine / no
 * sandbox. The integration tests (`pauseResume.test.ts`) cover the
 * full path through `RunManager.pause()` + `runOneAgent`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PauseGate } from "../../src/runtime/pauseGate.js";

function flushMicrotasks(n = 4): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

test("starts unpaused; waitWhilePaused resolves immediately", async () => {
  const g = new PauseGate();
  assert.equal(g.paused, false);
  await g.waitWhilePaused();
  assert.equal(g.paused, false);
});

test("pause(): returns true once, then false (idempotent)", () => {
  const g = new PauseGate();
  assert.equal(g.pause(), true);
  assert.equal(g.paused, true);
  assert.equal(g.pause(), false);
  assert.equal(g.pause(), false);
  assert.equal(g.paused, true);
});

test("resume(): returns false on unpaused gate (idempotent)", () => {
  const g = new PauseGate();
  assert.equal(g.resume(), false);
  assert.equal(g.paused, false);
});

test("resume() unblocks pending waitWhilePaused() calls", async () => {
  const g = new PauseGate();
  g.pause();

  const observed: string[] = [];
  const w1 = g.waitWhilePaused().then(() => observed.push("w1"));
  const w2 = g.waitWhilePaused().then(() => observed.push("w2"));
  await flushMicrotasks();
  assert.deepEqual(observed, [], "no waiter should resolve while paused");

  assert.equal(g.resume(), true);
  await Promise.all([w1, w2]);
  assert.deepEqual(observed.sort(), ["w1", "w2"]);
});

test("re-pause after resume re-blocks new waiters", async () => {
  const g = new PauseGate();
  g.pause();
  const w1 = g.waitWhilePaused();
  g.resume();
  await w1; // first cycle resolves

  g.pause();
  let resolved = false;
  const w2 = g.waitWhilePaused().then(() => {
    resolved = true;
  });
  await flushMicrotasks();
  assert.equal(resolved, false, "second cycle must re-block");

  g.resume();
  await w2;
  assert.equal(resolved, true);
});

test("AbortSignal pre-aborted: rejects without entering wait loop", async () => {
  const g = new PauseGate();
  g.pause();
  const ctrl = new AbortController();
  const reason = new Error("abort-pre");
  ctrl.abort(reason);

  await assert.rejects(g.waitWhilePaused(ctrl.signal), reason);
  // gate state unaffected by an aborted waiter
  assert.equal(g.paused, true);
});

test("AbortSignal mid-wait: abort wins the race against resume", async () => {
  const g = new PauseGate();
  g.pause();
  const ctrl = new AbortController();
  const reason = new Error("abort-wins");
  const wait = g.waitWhilePaused(ctrl.signal);

  // abort fires BEFORE resume — abort branch should reject the waiter.
  ctrl.abort(reason);
  await assert.rejects(wait, reason);
});

test("AbortSignal does NOT leak listeners across many cycles", async () => {
  const g = new PauseGate();
  const ctrl = new AbortController();
  // 200 successful resume cycles. If the abort listener wasn't being
  // removed on the resolve branch, MaxListenersExceededWarning would
  // fire by ~10. Node doesn't expose listener count for AbortSignal,
  // so we assert via emitWarning interception.
  const warnings: string[] = [];
  const origEmitWarning = process.emitWarning;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emitWarning = ((w: any, ..._rest: unknown[]) => {
    warnings.push(typeof w === "string" ? w : String(w));
  }) as typeof process.emitWarning;
  try {
    for (let i = 0; i < 200; i++) {
      g.pause();
      const w = g.waitWhilePaused(ctrl.signal);
      g.resume();
      await w;
    }
  } finally {
    process.emitWarning = origEmitWarning;
  }
  // No leak warnings.
  assert.equal(
    warnings.filter((w) => /MaxListenersExceeded/i.test(w)).length,
    0,
  );
});

test("pause + resume sequence with no waiters works", () => {
  const g = new PauseGate();
  assert.equal(g.pause(), true);
  assert.equal(g.resume(), true);
  assert.equal(g.pause(), true);
  assert.equal(g.resume(), true);
});

test("resume of never-paused gate is a clean no-op", async () => {
  const g = new PauseGate();
  assert.equal(g.resume(), false);
  // waitWhilePaused still works
  await g.waitWhilePaused();
});
