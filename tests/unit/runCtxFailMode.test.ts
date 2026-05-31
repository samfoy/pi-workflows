/**
 * tests/unit/runCtxFailMode.test.ts — unit tests for ctx.phase failMode option
 * and budget tracking in the runCtx host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createRunCtxHost } from "../../src/runtime/runCtx.js";
import { CacheStore } from "../../src/runtime/cache.js";
import { LedgerWriter } from "../../src/runtime/ledger.js";
import { makeSemaphore } from "../../src/runtime/semaphore.js";
import type { AgentResult, AgentResultLike, DispatcherOptions } from "../../src/types/internal.js";

/** A fake dispatcher that always rejects. */
function failingDispatch(_opts: DispatcherOptions): Promise<AgentResult> {
  return Promise.reject(new Error("agent-always-fails"));
}

/** A fake dispatcher that succeeds with fixed usage. */
function successDispatch(opts: DispatcherOptions): Promise<AgentResult> {
  return Promise.resolve({
    ok: true,
    agentId: opts.agentId,
    text: "ok-" + opts.agentId,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    toolCalls: 0,
    durationMs: 1,
    transcriptPath: "",
    exitCode: 0,
  });
}

async function makeCtx(
  runDir: string,
  dispatch: typeof failingDispatch,
) {
  return makeCtxWithBudget(runDir, dispatch, null);
}

async function makeCtxWithBudget(
  runDir: string,
  dispatch: typeof failingDispatch,
  tokenBudget: number | null,
) {
  const runId = "wf-fmtest";
  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  const cache = await CacheStore.open({
    runId,
    resolveCachePath: () => join(runDir, "cache.jsonl"),
    log: () => {},
  });
  const semaphore = makeSemaphore({ cap: 16 });
  const ctrl = new AbortController();
  return createRunCtxHost({
    runMeta: {
      id: "wf-test",
      workflowName: "test",
      startedAt: new Date().toISOString(),
      cwd: runDir,
      resumed: false,
    },
    input: "",
    runDirAbs: runDir,
    workflowSourceSha256: "deadbeef",
    cache,
    ledger,
    semaphore,
    signal: ctrl.signal,
    perRunAgentCap: 100,
    tokenBudget,
    mockAgents: false,
    cwd: runDir,
    dispatch,
  });
}

test("ctx.phase failMode='null': returns [null] when agent fails", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-fm-"));
  try {
    const { host } = await makeCtx(runDir, failingDispatch);

    const h = host.agent("test prompt", { id: "a" });
    assert.ok(h.ok);

    const phaseResult = await host.phase("work", [h.value], { failMode: "null" });
    assert.ok(phaseResult.ok, "failMode=null should not reject the phase");
    assert.equal(phaseResult.value.length, 1);
    assert.equal(phaseResult.value[0], null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.phase default failMode: error envelope when agent fails", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-fm-"));
  try {
    const { host } = await makeCtx(runDir, failingDispatch);

    const h = host.agent("test prompt", { id: "b" });
    assert.ok(h.ok);

    const phaseResult = await host.phase("work", [h.value]);
    assert.ok(!phaseResult.ok, "default failMode should return error envelope");
    assert.ok(
      phaseResult.error.message.includes("failed"),
      `error message should mention 'failed', got: ${phaseResult.error.message}`,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.phase failMode='null': success results still returned alongside nulls", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-fm-"));
  try {
    const { host } = await makeCtx(runDir, successDispatch);

    const h1 = host.agent("task 1", { id: "s1" });
    const h2 = host.agent("task 2", { id: "s2" });
    assert.ok(h1.ok && h2.ok);

    const phaseResult = await host.phase(
      "work",
      [h1.value, h2.value],
      { failMode: "null" },
    );
    assert.ok(phaseResult.ok);
    assert.equal(phaseResult.value.length, 2);
    // Both succeeded — no nulls
    assert.notEqual(phaseResult.value[0], null);
    assert.notEqual(phaseResult.value[1], null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// BUG-056: invalid failMode values must be rejected with a TypeError
test("ctx.phase: invalid failMode value throws TypeError", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-fm-invalid-"));
  try {
    const { host } = await makeCtx(runDir, successDispatch);
    const h = host.agent("test", { id: "x" });
    assert.ok(h.ok);

    // Typo: 'NULL' instead of 'null'
    const r1 = await host.phase("work", [h.value], { failMode: "NULL" });
    assert.ok(!r1.ok, "expect error envelope for invalid failMode");
    assert.match(r1.error.message, /failMode.*must be.*throw.*null/i);

    // Typo: 'Throw' instead of 'throw'
    const h2 = host.agent("test2", { id: "y" });
    assert.ok(h2.ok);
    const r2 = await host.phase("work", [h2.value], { failMode: "Throw" });
    assert.ok(!r2.ok, "expect error envelope for invalid failMode");
    assert.match(r2.error.message, /failMode.*must be.*throw.*null/i);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("getBudgetSpent: starts at 0, accumulates totalTokens after phase", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-budget-"));
  try {
    const { host, getAgentCount } = await makeCtx(runDir, successDispatch);

    assert.equal(host.getBudgetSpent(), 0);

    const h = host.agent("task 1", { id: "t1" });
    assert.ok(h.ok);
    await host.phase("work", [h.value]);

    // successDispatch returns totalTokens: 2
    assert.equal(host.getBudgetSpent(), 2);
    assert.equal(getAgentCount(), 1);

    const h2 = host.agent("task 2", { id: "t2" });
    assert.ok(h2.ok);
    await host.phase("work2", [h2.value]);

    assert.equal(host.getBudgetSpent(), 4);
    assert.equal(getAgentCount(), 2);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── opts.schema integration ─────────────────────────────────────────────────

test("opts.schema: output is parsed from ```json fence in agent text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schema-"));
  try {
    const jsonText = '```json\n{"items":["x","y"],"count":2}\n```';
    const dispatch = (opts: DispatcherOptions): Promise<AgentResult> =>
      Promise.resolve({
        ok: true,
        agentId: opts.agentId,
        text: jsonText,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        toolCalls: 0,
        durationMs: 1,
        transcriptPath: "",
        exitCode: 0,
      });
    const { host } = await makeCtx(dir, dispatch);
    const handleRes = host.agent("list items", { id: "lister", schema: { type: "object" } });
    assert.ok(handleRes.ok);
    const results = await host.phase("work", [handleRes.value]);
    assert.ok(results.ok);
    const r = results.value[0] as AgentResultLike & { output?: unknown };
    assert.equal(r.text, jsonText);
    assert.deepEqual(r.output, { items: ["x", "y"], count: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opts.schema: no output field when schema absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-noschema-"));
  try {
    const { host } = await makeCtx(dir, successDispatch);
    const handleRes = host.agent("do thing", { id: "worker" });
    assert.ok(handleRes.ok);
    const results = await host.phase("work", [handleRes.value]);
    assert.ok(results.ok);
    const r = results.value[0] as AgentResultLike & { output?: unknown };
    assert.equal(r.output, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// gap-fix: post-parse schema validation throws SchemaValidationError
// on a shape mismatch (e.g. JSON parses but is missing a required field).
test("opts.schema: shape mismatch throws SchemaValidationError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-schema-bad-"));
  try {
    // Agent returns valid JSON but the wrong shape: required `count` missing.
    const dispatch = (opts: DispatcherOptions): Promise<AgentResult> =>
      Promise.resolve({
        ok: true,
        agentId: opts.agentId,
        text: '```json\n{"items":["x"]}\n```',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        toolCalls: 0,
        durationMs: 1,
        transcriptPath: "",
        exitCode: 0,
      });
    const { host } = await makeCtx(dir, dispatch);
    const handleRes = host.agent("list", {
      id: "lister",
      schema: {
        type: "object",
        properties: {
          items: { type: "array" },
          count: { type: "integer" },
        },
        required: ["items", "count"],
      },
    });
    assert.ok(handleRes.ok);
    const results = await host.phase("work", [handleRes.value]);
    assert.equal(results.ok, false);
    if (!results.ok) {
      // The phase rejection is an AggregateError wrapping the schema validation error.
      const errMsg = JSON.stringify(results.error);
      assert.match(errMsg, /SchemaValidationError|validation failed/);
      assert.match(errMsg, /count/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── budget.total enforcement ─────────────────────────────────────────────────

test("tokenBudget: throws when budget exhausted before dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-budget-"));
  try {
    // Budget of 1 token — first agent succeeds (spending 2), second should throw
    let callCount = 0;
    const countingDispatch = (opts: DispatcherOptions): Promise<AgentResult> => {
      callCount++;
      return successDispatch(opts); // spends totalTokens=2 per call
    };
    const { host } = await makeCtxWithBudget(dir, countingDispatch, 1);

    const h1 = host.agent("first", { id: "a" });
    const h2 = host.agent("second", { id: "b" });
    assert.ok(h1.ok && h2.ok);

    // First phase succeeds but spends 2 tokens (over budget of 1)
    const r1 = await host.phase("first", [h1.value]);
    assert.ok(r1.ok);

    // Second phase should throw because budget is exhausted (2 >= 1)
    const r2 = await host.phase("second", [h2.value]);
    assert.ok(!r2.ok, "Expected budget exhausted error");
    // The budget error is wrapped inside a phase AggregateError
    assert.match(r2.error.message + (r2.error.errors?.[0]?.message ?? ""), /budget exhausted|perRunAgentCap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budget: total and remaining reflect configured tokenBudget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-budgetval-"));
  try {
    const { host } = await makeCtxWithBudget(dir, successDispatch, 500);
    assert.equal(host.tokenBudget, 500);
    assert.equal(host.getBudgetSpent(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// BUG-055: parallel phase budget race
test("tokenBudget: budgetReserved prevents parallel overshoot (BUG-055)", async () => {
  // Budget=1. Each agent spends totalTokens=2 (via successDispatch).
  // Without budgetReserved: all 3 agents check budgetSpent=0 < 1 simultaneously
  // (synchronously during .map()), all pass, all run → 6 tokens spent.
  // With budgetReserved: agent 1 increments budgetReserved=1 before its first
  // await; agents 2+3 check budgetSpent+budgetReserved=0+1=1 >= 1 → throw.
  // Only 1 dispatch should occur.
  const dir = mkdtempSync(join(tmpdir(), "wf-bug055-"));
  try {
    let dispatchCount = 0;
    const countingDispatch = (opts: DispatcherOptions): Promise<AgentResult> => {
      dispatchCount++;
      return successDispatch(opts);
    };
    const { host } = await makeCtxWithBudget(dir, countingDispatch, 1);

    const h1 = host.agent("a1", { id: "p1" });
    const h2 = host.agent("a2", { id: "p2" });
    const h3 = host.agent("a3", { id: "p3" });
    assert.ok(h1.ok && h2.ok && h3.ok);

    // All three launched in a single parallel phase with failMode:'null' so
    // budget-throws for agents 2+3 become nulls instead of aborting the phase.
    const r = await host.phase("work", [h1.value, h2.value, h3.value], { failMode: "null" });
    assert.ok(r.ok, "phase should succeed in failMode:null even with budget blocks");

    // Only the first agent should have reached the real dispatcher.
    assert.equal(dispatchCount, 1, `expected 1 dispatch (got ${dispatchCount}); budgetReserved not preventing parallel overshoot`);

    // One real result, two nulls (blocked by budget).
    const nonNull = r.value.filter((v) => v !== null);
    assert.equal(nonNull.length, 1, "expected exactly 1 non-null result");
    assert.equal(r.value[0]?.agentId, "p1");
    assert.equal(r.value[1], null);
    assert.equal(r.value[2], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── extractMetaPhases static parser ────────────────────────────────────────

import { extractMetaPhases } from "../../src/runManager.js";

test("extractMetaPhases: extracts single-quoted phase titles", () => {
  const src = `export const meta = {
  name: "audit",
  phases: [
    { title: 'Recon' },
    { title: 'Analyze' },
    { title: 'Report' },
  ],
};`;
  const phases = extractMetaPhases(src);
  assert.deepEqual(phases, [{ title: "Recon" }, { title: "Analyze" }, { title: "Report" }]);
});

test("extractMetaPhases: extracts double-quoted phase titles", () => {
  const src = `export const meta = { name: "x", phases: [{ title: "Alpha" }, { title: "Beta" }] };`;
  assert.deepEqual(extractMetaPhases(src), [{ title: "Alpha" }, { title: "Beta" }]);
});

test("extractMetaPhases: returns empty array when no phases declared", () => {
  const src = `export const meta = { name: "x", description: "y" };`;
  assert.deepEqual(extractMetaPhases(src), []);
});
