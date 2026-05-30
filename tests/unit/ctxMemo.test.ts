/**
 * Unit tests for ctx.memo() — cross-run memoization bridge (gap/ctx-memo).
 *
 * Tests the sandbox↔host bridge: memo_check / memo_set integration and
 * the sandbox-side wrapper logic (hit path, miss path, TTL, scope).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Sandbox } from "../../src/runtime/sandbox.ts";
import type { RunCtxHost, RunCtxBridgeResult } from "../../src/types/internal.d.ts";

type OkResult<T> = { ok: true; value: T };
type ErrResult = { ok: false; error: { name: string; message: string; stack: string | null; wrappedNonError: boolean } };

function ok<T>(v: T): OkResult<T> {
  return { ok: true, value: v };
}
function err(msg: string): ErrResult {
  return { ok: false, error: { name: "Error", message: msg, stack: null, wrappedNonError: false } };
}

/** Build a minimal RunCtxHost with controllable memo_check / memo_set stubs. */
function makeHost(overrides: Partial<RunCtxHost> = {}): RunCtxHost {
  const base: RunCtxHost = {
    runMeta: {
      id: "wf-test",
      workflowName: "test",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: "/tmp/test",
      resumed: false,
    },
    input: "",
    agent: () => ok({ kind: "agent" as const, id: "a1", prompt: "", opts: Object.freeze({}) }),
    phase: async () => ok([]),
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
    memo_check: async () => ok({ hit: false }),
    memo_set: async () => ok(null),
  };
  return { ...base, ...overrides };
}

function makeSandbox(host: RunCtxHost): Sandbox {
  const ctrl = new AbortController();
  return new Sandbox({ signal: ctrl.signal, runCtxHost: host });
}

// ─── cache miss: fn() is called, result stored ───────────────────────────────

test("ctx.memo: cache miss — fn() runs and returns its value", async () => {
  let memoSetCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];

  const host = makeHost({
    memo_check: async () => ok({ hit: false }),
    memo_set: async (key, value, opts) => {
      memoSetCalls.push({ key, value, opts });
      return ok(null);
    },
  });
  const sb = makeSandbox(host);
  const result = await sb.runScript(`
    return ctx.memo('my-key', async function() { return 42; });
  `);
  assert.equal(result.returnValue, 42, "should return fn() result on miss");
  assert.equal(memoSetCalls.length, 1, "memo_set should be called once");
  assert.equal(memoSetCalls[0]?.value, 42, "memo_set should store fn() result");
});

// ─── cache hit: fn() is NOT called ───────────────────────────────────────────

test("ctx.memo: cache hit — fn() is never called", async () => {
  let fnCalled = false;
  const host = makeHost({
    memo_check: async () => ok({ hit: true, value: "cached-value" }),
    memo_set: async () => {
      throw new Error("memo_set must not be called on a hit");
    },
  });
  const sb = makeSandbox(host);
  const result = await sb.runScript(`
    return ctx.memo('my-key', async function() {
      // This should NOT run.
      __fnWasCalled = true;
      return 'fresh-value';
    });
  `);
  assert.equal(result.returnValue, "cached-value", "should return cached value on hit");
  assert.equal(fnCalled, false, "fn should not be invoked on hit");
});

// ─── TTL and scope are forwarded to memo_check ────────────────────────────────

test("ctx.memo: TTL and scope opts are forwarded to memo_check", async () => {
  let checkOpts: unknown = null;
  const host = makeHost({
    memo_check: async (_key, opts) => {
      checkOpts = opts;
      return ok({ hit: false });
    },
    memo_set: async () => ok(null),
  });
  const sb = makeSandbox(host);
  await sb.runScript(`
    return ctx.memo('keyx', async function() { return 1; }, { ttl: 12345, scope: 'project' });
  `);
  assert.ok(checkOpts !== null, "opts should be forwarded");
  const o = checkOpts as Record<string, unknown>;
  assert.equal(o.ttl, 12345, "ttl should match");
  assert.equal(o.scope, "project", "scope should match");
});

test("ctx.memo: TTL and scope opts are forwarded to memo_set", async () => {
  let setOpts: unknown = null;
  const host = makeHost({
    memo_check: async () => ok({ hit: false }),
    memo_set: async (_key, _value, opts) => {
      setOpts = opts;
      return ok(null);
    },
  });
  const sb = makeSandbox(host);
  await sb.runScript(`
    return ctx.memo('keyx', async function() { return 7; }, { ttl: 9999, scope: 'global' });
  `);
  const o = setOpts as Record<string, unknown>;
  assert.equal(o.ttl, 9999);
  assert.equal(o.scope, "global");
});

// ─── error propagation ────────────────────────────────────────────────────────

test("ctx.memo: non-string key throws TypeError", async () => {
  const sb = makeSandbox(makeHost());
  await assert.rejects(
    () => sb.runScript(`return ctx.memo(42, async function() { return 1; });`),
    /ctx\.memo: key must be a string/,
    "should throw on non-string key",
  );
});

test("ctx.memo: non-function fn throws TypeError", async () => {
  const sb = makeSandbox(makeHost());
  await assert.rejects(
    () => sb.runScript(`return ctx.memo('key', 'not-a-function');`),
    /ctx\.memo: fn must be a function/,
    "should throw on non-function fn",
  );
});

test("ctx.memo: memo_check returning error envelope propagates as throw", async () => {
  const host = makeHost({
    memo_check: async () => err("storage read failed"),
  });
  const sb = makeSandbox(host);
  await assert.rejects(
    () => sb.runScript(`return ctx.memo('key', async function() { return 1; });`),
    /storage read failed/,
    "should propagate memo_check error",
  );
});

test("ctx.memo: memo_set returning error envelope propagates as throw", async () => {
  const host = makeHost({
    memo_check: async () => ok({ hit: false }),
    memo_set: async () => err("storage write failed"),
  });
  const sb = makeSandbox(host);
  await assert.rejects(
    () => sb.runScript(`return ctx.memo('key', async function() { return 1; });`),
    /storage write failed/,
    "should propagate memo_set error",
  );
});

// ─── stub branch (no runtime) ────────────────────────────────────────────────

test("ctx.memo: stub branch throws 'no runtime' when sandbox has no host", async () => {
  const ctrl = new AbortController();
  const sb = new Sandbox({ signal: ctrl.signal });
  await assert.rejects(
    () => sb.runScript(`return ctx.memo('key', async function() { return 1; });`),
    /no runtime/,
    "should throw 'no runtime' when no host provided",
  );
});
