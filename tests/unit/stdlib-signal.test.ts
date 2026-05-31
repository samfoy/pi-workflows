/**
 * tests/unit/stdlib-signal.test.ts — gap-fix coverage for the
 * ctx.signal polyfill upgrades:
 *
 *   - signal.throwIfAborted()
 *   - signal.dispatchEvent({type:'abort'}) actually invokes listeners
 *   - AbortSignal.timeout(ms)
 *   - AbortSignal.any([signals])
 *
 * The sandbox's ctx.signal is a duck-typed object literal (not a real
 * AbortSignal class instance) so these tests assert behavioral parity
 * with the web AbortSignal API rather than constructor identity.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import type {
  AgentResultLike,
  RunCtxHost,
} from "../../src/types/internal.js";

function stubHost(): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-signal",
      workflowName: "signal",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: ".",
      resumed: false,
    },
    input: "",
    agent: () =>
      ok({
        kind: "agent" as const,
        id: "auto",
        prompt: "",
        opts: Object.freeze({ id: "auto" }),
      }),
    phase: async () => ok([] as AgentResultLike[]),
    cacheGet: async () => ok(undefined),
    cacheSet: async () => ok(null),
    cacheHas: async () => ok(false),
    cacheDelete: async () => ok(null),
    log: () => ok(null),
    finishCallback: () => ok(null),
    getBudgetSpent: () => 0,
    tokenBudget: null,
    progress: () => ok(null),
    checkpoint: async () => ok(false),
    report: () => ok(null),
    gate: async () => ok(true),
    interrupt: async () => ok({ key: "int-0", value: null }),
    memo_check: async () => ok({ hit: false as const }),
    memo_set: async () => ok(null),
  };
}

async function runWith(
  source: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const ctrl = new AbortController();
  const r = await runScript(source, {
    signal: signal ?? ctrl.signal,
    runCtxHost: stubHost(),
  });
  return r.returnValue;
}

// ─── throwIfAborted ───────────────────────────────────────────────

test("ctx.signal.throwIfAborted is a no-op when not aborted", async () => {
  const out = await runWith(`
    let threw = false;
    try { ctx.signal.throwIfAborted(); }
    catch (_) { threw = true; }
    return threw;
  `);
  assert.equal(out, false);
});

test("ctx.signal.throwIfAborted throws when an AbortSignal.timeout fires", async () => {
  // We can't directly trigger ctx.signal.aborted from the host without
  // also tearing the worker down (raceWithAbort). Instead exercise the
  // method on a synthetic AbortSignal.timeout signal which uses the
  // same factory and validates the same throwIfAborted method.
  const out = await runWith(`
    const sig = AbortSignal.timeout(5);
    await new Promise(r => setTimeout(r, 30));
    let caught = null;
    try { sig.throwIfAborted(); }
    catch (e) { caught = { name: e.name, message: e.message }; }
    return caught;
  `);
  const caught = out as { name: string; message: string } | null;
  assert.ok(caught !== null);
  assert.equal(caught!.name, "TimeoutError");
  assert.equal(caught!.message, "signal timed out");
});

// ─── dispatchEvent ────────────────────────────────────────────────

test("ctx.signal.dispatchEvent({type:'abort'}) invokes registered listeners", async () => {
  const out = await runWith(`
    // Build a fresh signal pair via AbortSignal.timeout (won't fire — 1 hour).
    const sig = AbortSignal.timeout(3600000);
    let count = 0;
    sig.addEventListener('abort', () => { count++; });
    sig.addEventListener('abort', () => { count += 10; });
    const ok = sig.dispatchEvent({ type: 'abort', target: sig });
    return { count, ok };
  `);
  const r = out as { count: number; ok: boolean };
  assert.equal(r.count, 11);
  assert.equal(r.ok, true);
});

test("ctx.signal.dispatchEvent ignores non-abort events", async () => {
  const out = await runWith(`
    const sig = AbortSignal.timeout(3600000);
    let count = 0;
    sig.addEventListener('abort', () => { count++; });
    sig.dispatchEvent({ type: 'random' });
    return count;
  `);
  assert.equal(out, 0);
});

// ─── AbortSignal.timeout ──────────────────────────────────────────

test("AbortSignal.timeout(ms): aborts after the deadline", async () => {
  const out = await runWith(`
    const sig = AbortSignal.timeout(15);
    const t0 = Date.now();
    let caught = null;
    await new Promise(r => setTimeout(r, 50));
    try { sig.throwIfAborted(); }
    catch (e) { caught = { name: e.name, dt: Date.now() - t0 }; }
    return caught;
  `);
  const r = out as { name: string; dt: number } | null;
  assert.ok(r !== null);
  assert.equal(r!.name, "TimeoutError");
  assert.ok(r!.dt >= 15, `aborted before ms (${r!.dt})`);
});

test("AbortSignal.timeout(0): aborts on next tick", async () => {
  const out = await runWith(`
    const sig = AbortSignal.timeout(0);
    await new Promise(r => setTimeout(r, 5));
    return { aborted: sig.aborted, name: sig.reason ? sig.reason.name : null };
  `);
  const r = out as { aborted: boolean; name: string | null };
  assert.equal(r.aborted, true);
  assert.equal(r.name, "TimeoutError");
});

test("AbortSignal.timeout: rejects negative ms", async () => {
  await assert.rejects(
    runWith(`return AbortSignal.timeout(-5);`),
    /ms must be a non-negative finite number/,
  );
});

test("AbortSignal.timeout: integrates with ctx.sleep cancellation", async () => {
  const out = await runWith(`
    const sig = AbortSignal.timeout(10);
    const t0 = Date.now();
    let caught = null;
    try { await ctx.sleep(1000, { signal: sig }); }
    catch (e) { caught = { name: e.name, dt: Date.now() - t0 }; }
    return caught;
  `);
  const r = out as { name: string; dt: number } | null;
  assert.ok(r !== null);
  assert.equal(r!.name, "TimeoutError");
  assert.ok(r!.dt < 500, `should have aborted by 10ms not waited 1000 (${r!.dt})`);
});

// ─── AbortSignal.any ──────────────────────────────────────────────

test("AbortSignal.any: aborts when any input fires", async () => {
  const out = await runWith(`
    const a = AbortSignal.timeout(3600000);   // never within test
    const b = AbortSignal.timeout(15);        // fires fast
    const combined = AbortSignal.any([a, b]);
    await new Promise(r => setTimeout(r, 50));
    return { aborted: combined.aborted, name: combined.reason ? combined.reason.name : null };
  `);
  const r = out as { aborted: boolean; name: string | null };
  assert.equal(r.aborted, true);
  assert.equal(r.name, "TimeoutError");
});

test("AbortSignal.any: aborts synchronously if input is already aborted", async () => {
  const out = await runWith(`
    const a = AbortSignal.timeout(0);
    await new Promise(r => setTimeout(r, 5));
    // a is now aborted. Combine it.
    const combined = AbortSignal.any([a]);
    return combined.aborted;
  `);
  assert.equal(out, true);
});

test("AbortSignal.any: rejects non-array input", async () => {
  await assert.rejects(
    runWith(`return AbortSignal.any('nope');`),
    /signals must be an array/,
  );
});

// ─── ctx.signal feature parity (web AbortSignal surface) ──────────

test("ctx.signal has all the expected web AbortSignal members", async () => {
  const out = await runWith(`
    return {
      hasAborted: 'aborted' in ctx.signal,
      hasReason: 'reason' in ctx.signal,
      hasAdd: typeof ctx.signal.addEventListener === 'function',
      hasRemove: typeof ctx.signal.removeEventListener === 'function',
      hasDispatch: typeof ctx.signal.dispatchEvent === 'function',
      hasThrow: typeof ctx.signal.throwIfAborted === 'function',
      hasTimeout: typeof AbortSignal.timeout === 'function',
      hasAny: typeof AbortSignal.any === 'function',
    };
  `);
  const r = out as Record<string, boolean>;
  assert.equal(r.hasAborted, true);
  assert.equal(r.hasReason, true);
  assert.equal(r.hasAdd, true);
  assert.equal(r.hasRemove, true);
  assert.equal(r.hasDispatch, true);
  assert.equal(r.hasThrow, true);
  assert.equal(r.hasTimeout, true);
  assert.equal(r.hasAny, true);
});
