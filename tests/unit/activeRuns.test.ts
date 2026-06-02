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

// ─── register: optional-field precedence matrix ────────────────────────
//
// register() folds 6 optional fields (endedAt, durationMs, approvalReason,
// runDir, parentRunId, forkAtPhase) using a 3-state ternary — patch wins,
// else preserve prior, else omit. Each branch matters because the
// summary feeds the runs-list overlay; mis-merging here surfaces stale
// data in the TUI.
//
// Naming convention: 'patch=X / prior=Y → result=Z'.

test("register: patch field WINS over prior (endedAt)", () => {
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-mp1" });
  r.register("wf-mp1", run, { workflowName: "x", endedAt: "prior" });
  r.register("wf-mp1", run, { endedAt: "new" });
  assert.equal(r.getSummary("wf-mp1")?.endedAt, "new");
});

test("register: patch=undefined PRESERVES prior (durationMs)", () => {
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-mp2" });
  r.register("wf-mp2", run, { workflowName: "x", durationMs: 1234 });
  r.register("wf-mp2", run, { state: "paused" }); // no durationMs in patch
  assert.equal(r.getSummary("wf-mp2")?.durationMs, 1234);
});

test("register: BOTH undefined OMITS the field (approvalReason)", () => {
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-mp3" });
  r.register("wf-mp3", run, { workflowName: "x" });
  const s = r.getSummary("wf-mp3")!;
  assert.equal(
    Object.prototype.hasOwnProperty.call(s, "approvalReason"),
    false,
    "approvalReason absent when never supplied",
  );
});

test("register: precedence matrix — each optional field independently", () => {
  // Build a single composite test that walks the table for every field.
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-mp4" });
  // First register with prior values for all 6 optional fields.
  r.register("wf-mp4", run, {
    workflowName: "x",
    endedAt: "E1",
    durationMs: 1,
    approvalReason: "trusted",
    runDir: "/r1",
    parentRunId: "p1",
    forkAtPhase: "f1",
  });
  // Re-register with patch overriding every field with new values.
  r.register("wf-mp4", run, {
    endedAt: "E2",
    durationMs: 2,
    approvalReason: "user-once",
    runDir: "/r2",
    parentRunId: "p2",
    forkAtPhase: "f2",
  });
  const s = r.getSummary("wf-mp4")!;
  assert.equal(s.endedAt, "E2");
  assert.equal(s.durationMs, 2);
  assert.equal(s.approvalReason, "user-once");
  assert.equal(s.runDir, "/r2");
  assert.equal(s.parentRunId, "p2");
  assert.equal(s.forkAtPhase, "f2");
});

// ─── transitioned: terminal-prior short-circuits ──────────────────────

test("applyEntry transitioned: terminal-state prior is locked (out-of-order safety)", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-tterm", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: { runId: "wf-tterm", outcome: "done" },
  });
  // A late transitioned entry must NOT clobber the terminal state.
  r.applyEntry({
    customType: "pi-workflows.run.transitioned",
    data: { runId: "wf-tterm", toState: "running" },
  });
  assert.equal(r.getSummary("wf-tterm")?.state, "done");
});

test("applyEntry transitioned: preserves prior optional fields when no patch", () => {
  const r = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-tprior" });
  r.register("wf-tprior", run, {
    workflowName: "x",
    endedAt: "E",
    durationMs: 99,
    approvalReason: "trusted",
    runDir: "/d",
    parentRunId: "p",
    forkAtPhase: "phase",
  });
  r.applyEntry({
    customType: "pi-workflows.run.transitioned",
    data: { runId: "wf-tprior", toState: "paused" },
  });
  const s = r.getSummary("wf-tprior")!;
  assert.equal(s.state, "paused");
  assert.equal(s.endedAt, "E");
  assert.equal(s.durationMs, 99);
  assert.equal(s.approvalReason, "trusted");
  assert.equal(s.runDir, "/d");
  assert.equal(s.parentRunId, "p");
  assert.equal(s.forkAtPhase, "phase");
});

// ─── applyEntry runId guard ───────────────────────────────────

test("applyEntry: missing runId is a silent no-op (no summary created)", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    // @ts-expect-error — missing runId
    data: { workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.transitioned",
    // @ts-expect-error
    data: { toState: "paused" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    // @ts-expect-error
    data: { outcome: "done" },
  });
  assert.equal(r.total, 0);
});

// ─── writeActiveIndex ───────────────────────────────────

test("writeActiveIndex: only non-terminal runs land in the active list", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: p } = await import("node:path");
  const tmp = mkdtempSync(p(tmpdir(), "pi-wf-act-"));
  const r = new ActiveRunsRegistry();
  // Two running, one done.
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-w1", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-w2", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-w3", workflowName: "x" },
  });
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: { runId: "wf-w3", outcome: "done" },
  });
  const path = p(tmp, ".active");
  r.writeActiveIndex(path);
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual([...parsed.runs].sort(), ["wf-w1", "wf-w2"]);
  assert.equal(typeof parsed.updatedAt, "string");
});

test("writeActiveIndex: never throws even if path is unwritable", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-fail", workflowName: "x" },
  });
  // Path inside a nonexistent unwritable parent. mkdir attempt is in
  // a try/catch and the open/write itself in another — must not throw.
  assert.doesNotThrow(() => {
    r.writeActiveIndex("/nonexistent/cannot/write/here/.active");
  });
});

// ─── isTerminalState helper ──────────────────────────────────

test("isTerminalState classifies the four user-visible terminal outcomes", () => {
  assert.equal(isTerminalState("done"), true);
  assert.equal(isTerminalState("failed"), true);
  assert.equal(isTerminalState("stopped"), true);
  assert.equal(isTerminalState("cancelled-pre-run"), true);
  assert.equal(isTerminalState("running"), false);
  assert.equal(isTerminalState("paused"), false);
  assert.equal(isTerminalState("approved"), false);
  assert.equal(isTerminalState("pending"), false);
});

// ─── isAlive export + sweepStalePids (B6) ────────────────────────────

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive } from "../../src/runtime/activeRuns.js";
import { currentBootId } from "../../src/runtime/crashSweep.js";

test("isAlive: non-existent PID returns false", () => {
  assert.equal(isAlive({ parentPid: 99999999, parentBootId: "" }), false);
});

test("isAlive: current process PID with matching boot ID returns true", () => {
  assert.equal(
    isAlive({ parentPid: process.pid, parentBootId: currentBootId() }),
    true,
  );
});

test("sweepStalePids: running summary with dead PID coerced to failed", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s1aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });
  assert.equal(r.getSummary("wf-s1aaaaaaaaa0")?.state, "running");

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-stale-test-"));
  writeFileSync(
    join(tmpDir, "manifest.json"),
    JSON.stringify({ parentPid: 99999999, parentBootId: "" }),
  );

  const swept = r.sweepStalePids({
    manifestPathFn: () => join(tmpDir, "manifest.json"),
  });

  assert.equal(swept, 1);
  assert.equal(r.getSummary("wf-s1aaaaaaaaa0")?.state, "failed");
});

test("sweepStalePids: running summary with live PID stays running", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s2aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-live-test-"));
  writeFileSync(
    join(tmpDir, "manifest.json"),
    JSON.stringify({ parentPid: process.pid, parentBootId: currentBootId() }),
  );

  const swept = r.sweepStalePids({
    manifestPathFn: () => join(tmpDir, "manifest.json"),
  });

  assert.equal(swept, 0);
  assert.equal(r.getSummary("wf-s2aaaaaaaaa0")?.state, "running");
});

test("sweepStalePids: missing manifest skips run gracefully", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s3aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });

  const swept = r.sweepStalePids({
    manifestPathFn: () => "/tmp/__nonexistent_wf_manifest_99999__.json",
  });

  assert.equal(swept, 0);
  assert.equal(r.getSummary("wf-s3aaaaaaaaa0")?.state, "running");
});

test("sweepStalePids: manifest without parentPid skips run gracefully", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s4aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-nopid-test-"));
  writeFileSync(
    join(tmpDir, "manifest.json"),
    JSON.stringify({ workflowName: "demo" }), // no parentPid
  );

  const swept = r.sweepStalePids({
    manifestPathFn: () => join(tmpDir, "manifest.json"),
  });

  assert.equal(swept, 0);
  assert.equal(r.getSummary("wf-s4aaaaaaaaa0")?.state, "running");
});

test("sweepStalePids: terminal states are not touched", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.ended",
    data: { runId: "wf-s5aaaaaaaaa0", workflowName: "demo", outcome: "done" },
  });
  assert.equal(r.getSummary("wf-s5aaaaaaaaa0")?.state, "done");

  const swept = r.sweepStalePids({
    isAlive: () => false, // pretend everything is dead
    manifestPathFn: () => "/tmp/__not-called.json",
  });

  assert.equal(swept, 0);
  assert.equal(r.getSummary("wf-s5aaaaaaaaa0")?.state, "done");
});

test("sweepStalePids: isAlive override used as test seam", () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s6aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-seam-test-"));
  writeFileSync(
    join(tmpDir, "manifest.json"),
    JSON.stringify({ parentPid: process.pid, parentBootId: currentBootId() }),
  );

  // Override isAlive to say dead even though PID is live.
  const swept = r.sweepStalePids({
    isAlive: () => false,
    manifestPathFn: () => join(tmpDir, "manifest.json"),
  });

  assert.equal(swept, 1);
  assert.equal(r.getSummary("wf-s6aaaaaaaaa0")?.state, "failed");
});

test("sweepStalePids: subscribers notified when summaries are coerced", async () => {
  const r = new ActiveRunsRegistry();
  r.applyEntry({
    customType: "pi-workflows.run.started",
    data: { runId: "wf-s7aaaaaaaaa0", workflowName: "demo", startedAt: new Date().toISOString() },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-notify-test-"));
  writeFileSync(
    join(tmpDir, "manifest.json"),
    JSON.stringify({ parentPid: 99999999, parentBootId: "" }),
  );

  let notified = 0;
  const unsub = r.subscribe(() => { notified++; });

  r.sweepStalePids({
    manifestPathFn: () => join(tmpDir, "manifest.json"),
  });

  // Notification is microtask-coalesced — drain the queue.
  await Promise.resolve();

  assert.equal(notified >= 1, true, "subscriber should have been called");
  unsub();
});
