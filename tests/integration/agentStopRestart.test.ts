/**
 * tests/integration/agentStopRestart.test.ts — per-agent stop + restart.
 *
 * Verifies that:
 *   - `ctxHost.stopAgent(agentId)` fires the per-agent abort so only that
 *     agent is aborted while other agents in the same phase continue.
 *   - `ctxHost.restartAgent(agentId)` triggers stop-then-re-dispatch of the
 *     same agent, and the phase eventually resolves with the restarted result.
 *
 * Uses a controllable mock dispatcher — no real `pi -p` subprocesses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunCtxHost } from "../../src/runtime/runCtx.js";
import { LedgerWriter } from "../../src/runtime/ledger.js";
import { CacheStore } from "../../src/runtime/cache.js";
import { makeSemaphore } from "../../src/runtime/semaphore.js";
import type { DispatcherOptions, AgentResult } from "../../src/types/internal.js";

// ─── Helpers ──────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-agent-stop-"));
}

async function makeCtxHost(
  runDir: string,
  dispatch: (opts: DispatcherOptions) => Promise<AgentResult>,
) {
  const runId = "wf-agent-stop";
  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  const cache = await CacheStore.open({
    runId,
    resolveCachePath: () => join(runDir, "cache.jsonl"),
  });
  const ctrl = new AbortController();
  const ctxHost = createRunCtxHost({
    runMeta: {
      id: runId,
      workflowName: "test",
      startedAt: new Date().toISOString(),
      cwd: runDir,
      resumed: false,
    },
    input: "",
    runDirAbs: runDir,
    workflowSourceSha256: "abc123",
    cache,
    ledger,
    semaphore: makeSemaphore({ cap: 8 }),
    signal: ctrl.signal,
    perRunAgentCap: 100,
    mockAgents: false,
    cwd: runDir,
    dispatch,
  });
  return { ctxHost, ctrl };
}

// ─── stopAgent ────────────────────────────────────────────────────

test("stopAgent: aborting one agent does not abort the run-level signal", async () => {
  const runDir = makeTmpDir();
  try {
    // pending holds the in-flight dispatch promises so tests can resolve them.
    const pending = new Map<
      string,
      { resolve: (r: AgentResult) => void; reject: (e: Error) => void }
    >();

    const dispatch = (opts: DispatcherOptions): Promise<AgentResult> => {
      return new Promise<AgentResult>((resolve, reject) => {
        pending.set(opts.agentId, { resolve, reject });
        if (opts.signal?.aborted) {
          const e = new Error("pre-aborted"); (e as { name: string }).name = "AbortError";
          reject(e); return;
        }
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("aborted"); (e as { name: string }).name = "AbortError";
          reject(e);
        }, { once: true });
      });
    };

    const { ctxHost, ctrl } = await makeCtxHost(runDir, dispatch);

    const agentA = ctxHost.host.agent("prompt-a", { id: "agent-stop-a" });
    assert.ok(agentA.ok);

    // failMode: null so the phase error envelope comes back rather than throw.
    const phasePromise = ctxHost.host.phase(
      "test-stop-phase",
      [agentA.value],
      { failMode: "null" },
    );

    // Give the mock dispatcher a tick to register.
    await new Promise((r) => setTimeout(r, 10));

    // Stop only agent-a — the per-agent AC fires.
    ctxHost.stopAgent("agent-stop-a");

    const result = await phasePromise;
    // failMode=null: phase resolves ok with [null] for failed agents.
    assert.ok(result.ok, "phase should resolve with failMode=null");
    assert.equal((result.value as unknown[])[0], null, "failed agent maps to null");

    // The run-level abort signal must NOT fire — only the agent was aborted.
    assert.ok(!ctrl.signal.aborted, "run-level abort should NOT fire on per-agent stop");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── restartAgent ─────────────────────────────────────────────────

test("restartAgent: re-dispatches the same agent and returns the restarted result", async () => {
  const runDir = makeTmpDir();
  try {
    let dispatchCallCount = 0;
    // The first dispatch will be aborted by restartAgent; the second succeeds.
    const dispatch = (opts: DispatcherOptions): Promise<AgentResult> => {
      dispatchCallCount++;
      const callN = dispatchCallCount;
      return new Promise<AgentResult>((resolve, reject) => {
        if (opts.signal?.aborted) {
          const e = new Error("pre-aborted"); (e as { name: string }).name = "AbortError";
          reject(e); return;
        }
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("aborted"); (e as { name: string }).name = "AbortError";
          reject(e);
        }, { once: true });
        // Second (and later) calls resolve immediately to simulate success.
        if (callN >= 2) {
          resolve({
            ok: true,
            agentId: opts.agentId,
            text: "restarted-result",
            usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
            toolCalls: 0,
            durationMs: 1,
            transcriptPath: "",
            exitCode: 0,
          });
        }
        // First call: test will call restartAgent to abort it.
      });
    };

    const { ctxHost } = await makeCtxHost(runDir, dispatch);

    const agentH = ctxHost.host.agent("restart-prompt", { id: "agent-restart" });
    assert.ok(agentH.ok);

    // failMode: null so we get back the result even if first attempt failed.
    const phasePromise = ctxHost.host.phase(
      "restart-phase",
      [agentH.value],
      { failMode: "null" },
    );

    // Give dispatch a tick to register.
    await new Promise((r) => setTimeout(r, 10));

    // Trigger restart — this aborts the first dispatch and queues a re-dispatch.
    ctxHost.restartAgent("agent-restart");

    const result = await phasePromise;
    assert.ok(result.ok, `phase should succeed after restart: ${JSON.stringify(result)}`);
    const vals = result.value as Array<{ text?: string } | null>;
    assert.equal(vals.length, 1);
    assert.ok(vals[0] !== null, "result should not be null — restart succeeded");
    assert.equal(vals[0]?.text, "restarted-result");
    assert.ok(
      dispatchCallCount >= 2,
      `expected ≥2 dispatch calls for restart, got ${dispatchCallCount}`,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
