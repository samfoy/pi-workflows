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
import type { AgentResult, DispatcherOptions } from "../../src/types/internal.js";

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
    const r = results.value[0] as AgentResult & { output?: unknown };
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
    const r = results.value[0] as AgentResult & { output?: unknown };
    assert.equal(r.output, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
