/**
 * tests/unit/restart.test.ts — slice 14 restart helper.
 *
 * Coverage:
 *   - Terminal state (done) → start invoked with restartedFrom + new runId.
 *   - Non-terminal (running) → blocked.
 *   - Missing script.js in old runDir → blocked.
 *   - source.runDir undefined → blocked with missing-summary.
 *   - onStarted hook fires after start resolves.
 *   - Lineage: startOptions.restartedFrom is set to source.runId.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { restartTerminalRun } from "../../src/runtime/restart.js";
import type { Run } from "../../src/runManager.js";
import type { RunSummary } from "../../src/runtime/activeRuns.js";
import type { WorkflowFile } from "../../src/types/internal.js";

function makeFakeRun(runId: string): Run {
  const ctrl = new AbortController();
  return {
    runId,
    runDirAbs: "/tmp/fake/" + runId,
    promise: Promise.resolve("ok"),
    signal: ctrl.signal,
    getFinishCallbackPrompt: () => null,
    cancel: () => undefined,
    approvalDecision: null,
    pause: async () => false,
    resumePaused: async () => false,
    stop: () => undefined,
    terminated: Promise.resolve({
      runId,
      workflowName: "demo",
      runDirAbs: "/tmp/fake/" + runId,
      outcome: "done",
      startedAt: "2026-05-29T12:00:00Z",
      endedAt: "2026-05-29T12:01:00Z",
      durationMs: 60_000,
      result: "ok",
      error: null,
      agentCount: 0,
      finishCallbackPrompt: null,
      approval: null,
    }),
  } as Run;
}

const baseWorkflow: WorkflowFile = {
  name: "demo",
  absPath: "/home/me/.pi/agent/workflows/demo.js",
  scope: "personal",
};

async function withRunDir(): Promise<{ runDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-restart-"));
  const runDir = join(root, "wf-old01");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "script.js"), "// frozen", "utf8");
  return {
    runDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("restart: terminal state → start invoked, lineage threaded", async () => {
  const { runDir, cleanup } = await withRunDir();
  try {
    const summary: RunSummary = {
      runId: "wf-old01",
      workflowName: "demo",
      state: "done",
      startedAt: "2026-05-29T12:00:00Z",
      endedAt: "2026-05-29T12:01:00Z",
      runDir,
    };
    let observed: { workflow: WorkflowFile; args: string; opts: Record<string, unknown> } | undefined;
    const startedHook: string[] = [];
    const outcome = await restartTerminalRun({
      source: summary,
      input: "audit the auth module",
      workflow: baseWorkflow,
      start: async (workflow, args, opts) => {
        observed = { workflow, args, opts: opts as unknown as Record<string, unknown> };
        return makeFakeRun("wf-new02");
      },
      startOptions: { preApproved: true },
      onStarted: (run) => startedHook.push(run.runId),
    });
    assert.equal(outcome.kind, "started");
    if (outcome.kind === "started") {
      assert.equal(outcome.newRunId, "wf-new02");
      assert.equal(outcome.restartedFrom, "wf-old01");
    }
    assert.deepEqual(startedHook, ["wf-new02"]);
    // Lineage threaded into start opts.
    assert.equal(observed?.opts.restartedFrom, "wf-old01");
    assert.equal(observed?.args, "audit the auth module");
    assert.equal(observed?.workflow.name, "demo");
  } finally {
    await cleanup();
  }
});

test("restart: non-terminal state → blocked", async () => {
  const { runDir, cleanup } = await withRunDir();
  try {
    const summary: RunSummary = {
      runId: "wf-old01",
      workflowName: "demo",
      state: "running",
      startedAt: "2026-05-29T12:00:00Z",
      runDir,
    };
    let startCalled = 0;
    const outcome = await restartTerminalRun({
      source: summary,
      input: "x",
      workflow: baseWorkflow,
      start: async () => {
        startCalled++;
        return makeFakeRun("wf-new02");
      },
      startOptions: { preApproved: true },
    });
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked" && outcome.reason.kind === "not-terminal") {
      assert.equal(outcome.reason.state, "running");
    } else {
      assert.fail(`expected not-terminal blocked outcome`);
    }
    assert.equal(startCalled, 0);
  } finally {
    await cleanup();
  }
});

test("restart: missing script.js → blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-restart-noscript-"));
  try {
    const runDir = join(root, "wf-old01");
    await mkdir(runDir, { recursive: true });
    // NO script.js written.
    const summary: RunSummary = {
      runId: "wf-old01",
      workflowName: "demo",
      state: "done",
      startedAt: "2026-05-29T12:00:00Z",
      runDir,
    };
    const outcome = await restartTerminalRun({
      source: summary,
      input: "x",
      workflow: baseWorkflow,
      start: async () => makeFakeRun("wf-new"),
      startOptions: { preApproved: true },
    });
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") {
      assert.equal(outcome.reason.kind, "missing-script");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart: source.runDir undefined → blocked with missing-summary", async () => {
  const summary: RunSummary = {
    runId: "wf-old01",
    workflowName: "demo",
    state: "done",
    startedAt: "2026-05-29T12:00:00Z",
    // runDir intentionally omitted
  };
  const outcome = await restartTerminalRun({
    source: summary,
    input: "x",
    workflow: baseWorkflow,
    start: async () => makeFakeRun("wf-new"),
    startOptions: { preApproved: true },
  });
  assert.equal(outcome.kind, "blocked");
  if (outcome.kind === "blocked") {
    assert.equal(outcome.reason.kind, "missing-summary");
  }
});
