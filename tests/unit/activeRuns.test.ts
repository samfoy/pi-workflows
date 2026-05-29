/**
 * tests/unit/activeRuns.test.ts — slice 13/F3.
 *
 * The active-runs registry is the canonical "find Run by runId" surface
 * for the TUI overlay. This test pins:
 *
 *   - register/lookup/unregister semantics
 *   - applyEntry idempotency for cross-process awareness (S8)
 *   - `pi-workflows.run.kill-requested` triggers `Run.stop` on the
 *     held in-process handle (F2 cross-process kill path)
 *   - subscribers fire on mutation (debounced into a microtask, so
 *     coalescing N synchronous mutations produces one notification)
 *   - terminal states block earlier `started`/`transitioned` entries
 *     from clobbering the summary (defensive against out-of-order
 *     appendEntry feeds — slice_13_concerns W6)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ActiveRunsRegistry,
  isTerminalState,
} from "../../src/runtime/activeRuns.js";
import type { Run, RunTerminalInfo } from "../../src/runManager.js";

function fakeRun(opts: {
  runId: string;
  terminated?: Promise<RunTerminalInfo>;
  stop?: () => void;
}): Run {
  let stopCalls = 0;
  const stop = () => {
    stopCalls++;
    opts.stop?.();
  };
  const run: Run & { stopCalls: () => number } = {
    runId: opts.runId,
    runDirAbs: `/tmp/${opts.runId}`,
    promise: Promise.resolve(undefined),
    signal: AbortSignal.abort(),
    getFinishCallbackPrompt: () => null,
    cancel: () => undefined,
    approvalDecision: null,
    pause: async () => false,
    resumePaused: async () => false,
    stop,
    terminated:
      opts.terminated ??
      new Promise(() => {
        /* never resolves in tests */
      }),
    stopCalls: () => stopCalls,
  } as Run & { stopCalls: () => number };
  return run;
}

test("register / getRun / hasHandle round-trip", () => {
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-aaaaaaaaaaaa" });
  r.register("wf-aaaaaaaaaaaa", run, { workflowName: "demo" });
  assert.equal(r.getRun("wf-aaaaaaaaaaaa"), run);
  assert.equal(r.hasHandle("wf-aaaaaaaaaaaa"), true);
  const summary = r.getSummary("wf-aaaaaaaaaaaa");
  assert.equal(summary?.workflowName, "demo");
  assert.equal(summary?.state, "running");
});

test("unregister drops the live handle but keeps the summary", () => {
  const r = new ActiveRunsRegistry();
  r.register("wf-bb", fakeRun({ runId: "wf-bb" }), {
    workflowName: "x",
    state: "running",
  });
  assert.equal(r.unregister("wf-bb"), true);
  assert.equal(r.getRun("wf-bb"), undefined);
  // Summary stays so the runs-list view can still render it.
  assert.notEqual(r.getSummary("wf-bb"), undefined);
  assert.equal(r.unregister("wf-bb"), false, "second unregister returns false");
});

test("applyEntry: started → transitioned → ended is idempotent", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: {
      runId: "wf-cc",
      workflowName: "demo",
      startedAt: "2026-05-29T00:00:00Z",
    },
  });
  assert.equal(r.getSummary("wf-cc")?.state, "running");

  r.applyEntry({
    customType: "pi-workflows.run.transitioned",
    data: { runId: "wf-cc", toState: "paused" },
  });
  assert.equal(r.getSummary("wf-cc")?.state, "paused");

  // Replaying the same transitioned entry is idempotent.
  r.applyEntry({
    customType: "pi-workflows.run.transitioned",
    data: { runId: "wf-cc", toState: "paused" },
  });
  assert.equal(r.getSummary("wf-cc")?.state, "paused");

  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: {
      runId: "wf-cc",
      outcome: "done",
      endedAt: "2026-05-29T00:00:10Z",
      durationMs: 10_000,
    },
  });
  assert.equal(r.getSummary("wf-cc")?.state, "done");
  assert.equal(isTerminalState(r.getSummary("wf-cc")!.state), true);
});

test("W6: terminal state blocks late `started` / `transitioned` from clobbering", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: {
      runId: "wf-dd",
      outcome: "failed",
      endedAt: "2026-05-29T00:00:05Z",
    },
  });
  assert.equal(r.getSummary("wf-dd")?.state, "failed");
  // Late-arriving `started` (e.g. crash-sweep races) MUST NOT undo the
  // terminal state.
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: {
      runId: "wf-dd",
      workflowName: "late",
      startedAt: "2026-05-29T00:00:00Z",
    },
  });
  assert.equal(r.getSummary("wf-dd")?.state, "failed");
});

test("F2: kill-requested entry triggers stop() on the held handle", () => {
  const r = new ActiveRunsRegistry();
  let stops = 0;
  const run = fakeRun({ runId: "wf-ee", stop: () => stops++ });
  r.register("wf-ee", run, { workflowName: "demo" });
  r.applyEntry({
    customType: "pi-workflows.run.kill-requested",
    data: { runId: "wf-ee" },
  });
  assert.equal(stops, 1, "stop() invoked exactly once");
  // No-op for unknown runId — must not throw.
  r.applyEntry({
    customType: "pi-workflows.run.kill-requested",
    data: { runId: "wf-not-known" },
  });
});

test("subscribe: coalesced microtask notification", async () => {
  const r = new ActiveRunsRegistry();
  let fires = 0;
  const unsub = r.subscribe(() => fires++);
  // Three synchronous mutations.
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-f1", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-f2", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-f3", workflowName: "x" },
  });
  // No fire yet — coalesced.
  assert.equal(fires, 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fires, 1, "three synchronous mutations → one listener fire");
  unsub();
  // After unsub, further mutations don't fire.
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-f4", workflowName: "x" },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fires, 1);
});

test("auto-cleanup: live handle dropped on `terminated`", async () => {
  const r = new ActiveRunsRegistry();
  let resolveTerm!: (info: RunTerminalInfo) => void;
  const term = new Promise<RunTerminalInfo>((res) => {
    resolveTerm = res;
  });
  const run = fakeRun({ runId: "wf-gg", terminated: term });
  r.register("wf-gg", run, { workflowName: "demo" });
  assert.equal(r.hasHandle("wf-gg"), true);
  resolveTerm({
    runId: "wf-gg",
    workflowName: "demo",
    runDirAbs: "/tmp/wf-gg",
    outcome: "done",
    startedAt: "2026-05-29T00:00:00Z",
    endedAt: "2026-05-29T00:00:01Z",
    durationMs: 1000,
    result: undefined,
    error: null,
    agentCount: 0,
    finishCallbackPrompt: null,
    approval: null,
  });
  // Handle dropped after terminated; summary state flipped to outcome.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(r.hasHandle("wf-gg"), false);
  assert.equal(r.getSummary("wf-gg")?.state, "done");
});

test("inFlight / total counters", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-h1", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-h2", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: { runId: "wf-h2", outcome: "done" },
  });
  assert.equal(r.inFlight, 1);
  assert.equal(r.total, 2);
});
