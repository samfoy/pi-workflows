/**
 * tests/unit/overlayHitlFork.test.ts — ZONE_TUI_HITL_FORK overlay tests.
 *
 *   - HITL: when the run emits `pi-workflows.interrupt.requested` via
 *     pi.appendEntry, the overlay tracks it and `i` dispatches the
 *     `interrupt-answer-requested` action through onInterruptAnswerRequested.
 *     A subsequent `pi-workflows.interrupt.resolved` event clears the
 *     pending entry so `i` becomes a noop again.
 *   - Fork: `f` dispatches `fork-requested` through onForkRequested
 *     with the selected runId.
 *
 * These tests exercise the in-overlay state machine. End-to-end
 * coverage of the workflowCmd.ts wiring (real ctx.ui.confirm / select /
 * input + forkFromCheckpoint) lives in the integration test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeFakePi } from "../helpers/makeFakePi.js";
import {
  ActiveRunsRegistry,
} from "../../src/runtime/activeRuns.js";
import {
  mountOverlay,
  __resetOverlayOpenForTest,
} from "../../src/runtime/overlay.js";
import type { PendingInterruptPayload } from "../../src/runtime/overlay.js";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";
import type { Run, RunTerminalInfo } from "../../src/runManager.js";

function fakeRun(opts: {
  runId: string;
  respondInterrupt?: (value: unknown, key?: string) => boolean;
}): Run {
  let resolveTerm!: (info: RunTerminalInfo) => void;
  const term = new Promise<RunTerminalInfo>((res) => {
    resolveTerm = res;
  });
  const run: Run & { _terminate: () => void } = {
    runId: opts.runId,
    runDirAbs: `/tmp/${opts.runId}`,
    workflowName: "demo",
    workflowSourceSha256: "deadbeef",
    startedAt: "2026-05-31T00:00:00Z",
    promise: Promise.resolve(undefined),
    terminated: term,
    pause: async () => true,
    resumePaused: async () => true,
    stop: () => {},
    respondGate: () => {},
    respondInterrupt: opts.respondInterrupt ?? (() => true),
    stopAgent: () => {},
    restartAgent: () => {},
    approvalDecision: null,
    _terminate: () => resolveTerm({ outcome: "done" } as RunTerminalInfo),
  } as unknown as Run & { _terminate: () => void };
  return run;
}

async function setupOverlay(pi: ReturnType<typeof makeFakePi>) {
  __resetOverlayOpenForTest();
  let capturedCtx: NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]> | null = null;
  pi.registerCommand("c", {
    handler: async (_a, c) => {
      capturedCtx = c as unknown as typeof capturedCtx;
    },
  });
  await pi.invokeCommand("c", "");
  return capturedCtx!;
}

test("ZONE_HITL: overlay tracks pending interrupt + i dispatches onInterruptAnswerRequested", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();
  const run = fakeRun({ runId: "wf-hitl00001" });
  registry.register("wf-hitl00001", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-31T00:00:00Z",
  });
  const ctx = await setupOverlay(pi);

  const interruptCalls: { runId: string; payload: PendingInterruptPayload }[] = [];
  await mountOverlay({
    pi,
    ctx,
    registry,
    phaseRegistry,
    forceTTY: true,
    onInterruptAnswerRequested: (runId, payload) => {
      interruptCalls.push({ runId, payload });
      return "answered ok";
    },
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);

  // Press `i` BEFORE any interrupt event → must be a noop (no banner change other than the hint).
  mount!.component.handleInput!("i");
  assert.equal(interruptCalls.length, 0, "i with no pending interrupt is a noop");

  // Emit the interrupt.requested event the way runCtx::interruptFn does.
  pi.appendEntry("pi-workflows.interrupt.requested", {
    runId: "wf-hitl00001",
    key: "int-0",
    question: "Approve plan?",
    choices: ["yes", "no"],
  });

  // Press `i` again → callback must fire with the payload.
  mount!.component.handleInput!("i");
  assert.equal(interruptCalls.length, 1, "i must dispatch onInterruptAnswerRequested");
  assert.equal(interruptCalls[0]!.runId, "wf-hitl00001");
  assert.equal(interruptCalls[0]!.payload.key, "int-0");
  assert.equal(interruptCalls[0]!.payload.question, "Approve plan?");
  assert.deepEqual([...(interruptCalls[0]!.payload.choices ?? [])], ["yes", "no"]);

  // After resolve event, pending count drops; `i` becomes a noop again.
  pi.appendEntry("pi-workflows.interrupt.resolved", {
    runId: "wf-hitl00001",
    key: "int-0",
    value: "yes",
    source: "ipc",
  });
  mount!.component.handleInput!("i");
  assert.equal(
    interruptCalls.length,
    1,
    "i is a noop after the matching interrupt is resolved",
  );

  mount!.done();
});

test("ZONE_HITL: multiple pending interrupts are FIFO (oldest answered first)", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();
  const run = fakeRun({ runId: "wf-hitl00002" });
  registry.register("wf-hitl00002", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-31T00:00:00Z",
  });
  const ctx = await setupOverlay(pi);
  const interruptCalls: { runId: string; payload: PendingInterruptPayload }[] = [];
  await mountOverlay({
    pi,
    ctx,
    registry,
    phaseRegistry,
    forceTTY: true,
    onInterruptAnswerRequested: (runId, payload) => {
      interruptCalls.push({ runId, payload });
      return undefined;
    },
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);

  pi.appendEntry("pi-workflows.interrupt.requested", {
    runId: "wf-hitl00002",
    key: "int-0",
    question: "first",
  });
  pi.appendEntry("pi-workflows.interrupt.requested", {
    runId: "wf-hitl00002",
    key: "int-1",
    question: "second",
  });

  mount!.component.handleInput!("i");
  assert.equal(interruptCalls[0]!.payload.key, "int-0", "FIFO: int-0 first");

  // Resolve int-0; next i should pick int-1.
  pi.appendEntry("pi-workflows.interrupt.resolved", {
    runId: "wf-hitl00002",
    key: "int-0",
    value: 1,
    source: "ipc",
  });
  mount!.component.handleInput!("i");
  assert.equal(interruptCalls[1]!.payload.key, "int-1", "FIFO: int-1 next");
  mount!.done();
});

test("ZONE_HITL: interrupt.requested with same key is deduped", async () => {
  // Replay or double-emission must not produce two pending entries
  // (two requested events for the same key should still resolve in
  // exactly one resolved event).
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();
  const run = fakeRun({ runId: "wf-hitl00003" });
  registry.register("wf-hitl00003", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-31T00:00:00Z",
  });
  const ctx = await setupOverlay(pi);
  let calls = 0;
  await mountOverlay({
    pi,
    ctx,
    registry,
    phaseRegistry,
    forceTTY: true,
    onInterruptAnswerRequested: () => {
      calls++;
      return undefined;
    },
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);

  pi.appendEntry("pi-workflows.interrupt.requested", {
    runId: "wf-hitl00003",
    key: "int-7",
    question: "duplicate",
  });
  pi.appendEntry("pi-workflows.interrupt.requested", {
    runId: "wf-hitl00003",
    key: "int-7",
    question: "duplicate",
  });
  // Resolve the (single, deduped) entry.
  pi.appendEntry("pi-workflows.interrupt.resolved", {
    runId: "wf-hitl00003",
    key: "int-7",
    value: "answered",
    source: "ipc",
  });
  // After dedup + single resolve, pressing `i` should be a noop.
  mount!.component.handleInput!("i");
  assert.equal(calls, 0, "after dedup + resolve, no pending entries remain");
  mount!.done();
});

test("ZONE_TIMETRAVEL: f on runs-list dispatches onForkRequested with the runId", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();
  const run = fakeRun({ runId: "wf-fork00001" });
  registry.register("wf-fork00001", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-31T00:00:00Z",
  });
  const ctx = await setupOverlay(pi);
  const forkCalls: string[] = [];
  await mountOverlay({
    pi,
    ctx,
    registry,
    phaseRegistry,
    forceTTY: true,
    onForkRequested: (runId) => {
      forkCalls.push(runId);
      return "forked: wf-someforkid";
    },
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);

  mount!.component.handleInput!("f");
  assert.deepEqual(forkCalls, ["wf-fork00001"], "f must dispatch fork-requested with the runId");
  mount!.done();
});

test("ZONE_TIMETRAVEL: f without a wired callback is a silent no-op (no throw)", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();
  const run = fakeRun({ runId: "wf-fork00002" });
  registry.register("wf-fork00002", run, {
    workflowName: "demo",
    state: "done",
    startedAt: "2026-05-31T00:00:00Z",
  });
  const ctx = await setupOverlay(pi);
  await mountOverlay({
    pi,
    ctx,
    registry,
    phaseRegistry,
    forceTTY: true,
    // onForkRequested intentionally omitted
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);

  // Should not throw, and rendering should still produce a valid run row.
  assert.doesNotThrow(() => mount!.component.handleInput!("f"));
  const lines = mount!.component.render(80);
  assert.ok(
    lines.some((l) => /wf-fork00002/.test(l)),
    `runs-list still renders the run after a no-op f press; got:\n${lines.join("\n")}`,
  );
  mount!.done();
});
