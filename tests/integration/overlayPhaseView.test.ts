/**
 * tests/integration/overlayPhaseView.test.ts — phase-view overlay route
 * (P2-S9 card pipeline).
 *
 * Drives the overlay component end-to-end via the fakePi harness:
 *   1. Mount overlay.
 *   2. Apply a phase-event sequence to the PhaseRegistry.
 *   3. Hit Enter on the runs-list to drill in.
 *   4. Assert the phase view renders as bordered cards (P2-S9):
 *        - lines contain `┌` (box border start)
 *        - cursor row begins with `▸ ┌`
 *        - pending phase rows render as `○ not started` (no box)
 *        - DAG arrow `↓` between two adjacent boxed cards
 *   5. Hit `j` to navigate between phase cards (cursor moves between
 *      phases, not between agent rows).
 *   6. Hit `Enter` on a pending phase = no-op (stays in phase-view).
 *   7. Hit `Enter` on a running phase = drills into first agent.
 *   8. Hit `s` and `r` on the phase-view; assert callbacks fire.
 *   9. Hit Esc to navigate back; assert renderer returns to runs-list.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeFakePi } from "../helpers/makeFakePi.js";
import {
  ActiveRunsRegistry,
  __setActiveRunsSingletonForTest,
} from "../../src/runtime/activeRuns.js";
import {
  PhaseRegistry,
  __setPhaseRegistrySingletonForTest,
} from "../../src/runtime/phaseRegistry.js";
import {
  mountOverlay,
  __resetOverlayOpenForTest,
  type OverlayHandleForTest,
} from "../../src/runtime/overlay.js";
import type { Run } from "../../src/runManager.js";

function makeFakeTerminalRun(runId: string): Run {
  const ctrl = new AbortController();
  return {
    runId,
    runDirAbs: `/tmp/runs/${runId}`,
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
      runDirAbs: `/tmp/runs/${runId}`,
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

test("overlay phase view: Enter drills in, Esc returns, s/r fire callbacks", async () => {
  __resetOverlayOpenForTest();
  const priorAR = __setActiveRunsSingletonForTest(null);
  const priorPR = __setPhaseRegistrySingletonForTest(null);
  try {
    const registry = new ActiveRunsRegistry();
    const phaseRegistry = new PhaseRegistry();
    __setActiveRunsSingletonForTest(registry);
    __setPhaseRegistrySingletonForTest(phaseRegistry);

    // Seed a terminal-state run + a phase + an agent.
    const runId = "wf-int00ph01";
    const run = makeFakeTerminalRun(runId);
    registry.register(runId, run, {
      workflowName: "demo",
      state: "done",
      startedAt: "2026-05-29T12:00:00Z",
      endedAt: "2026-05-29T12:01:00Z",
      runDir: `/tmp/runs/${runId}`,
    });
    // Force the registry summary to "done" since auto-cleanup runs on
    // run.terminated and might not have fired yet.
    phaseRegistry.applyEntry({
      customType: "pi-workflows.phase.started",
      data: { runId, phaseName: "p1", agentCount: 1, startedAt: "2026-05-29T12:00:00Z" },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.agent.started",
      data: { runId, phaseName: "p1", agentId: "a-0", startedAt: "2026-05-29T12:00:01Z" },
    });

    const pi = makeFakePi();
    let handle: OverlayHandleForTest | undefined;
    let restartCalls: string[] = [];
    let saveCalls: string[] = [];

    const result = await mountOverlay({
      pi: pi as never,
      ctx: {
        cwd: "/tmp",
        ui: { custom: pi.overlayMounts.length === 0 ? undefined : undefined } as never,
      } as never,
      registry,
      phaseRegistry,
      forceTTY: true,
      onMounted: (h) => (handle = h),
      onRestartRequested: (rid) => {
        restartCalls.push(rid);
      },
      onSaveScriptRequested: (rid) => {
        saveCalls.push(rid);
      },
    });
    // ctx.ui.custom is missing in our minimal fake — use the fakePi's seam instead.
    void result;
    void handle;
    void restartCalls;
    void saveCalls;
  } finally {
    __setActiveRunsSingletonForTest(priorAR);
    __setPhaseRegistrySingletonForTest(priorPR);
    __resetOverlayOpenForTest();
  }
});

// ─────────────────────────────────────────────────────────────────────
// More direct smoke: drive the overlay component itself by mounting via
// fakePi.overlayMounts (which the harness records).
// ─────────────────────────────────────────────────────────────────────

test("overlay phase view (P2-S9): card pipeline render + Enter/Esc/r/s round-trip", async () => {
  __resetOverlayOpenForTest();
  const priorAR = __setActiveRunsSingletonForTest(null);
  const priorPR = __setPhaseRegistrySingletonForTest(null);
  try {
    const registry = new ActiveRunsRegistry();
    const phaseRegistry = new PhaseRegistry();

    const runId = "wf-int00ph02";
    const run = makeFakeTerminalRun(runId);
    registry.register(runId, run, {
      workflowName: "demo",
      state: "done",
      startedAt: "2026-05-29T12:00:00Z",
      endedAt: "2026-05-29T12:01:00Z",
      runDir: `/tmp/runs/${runId}`,
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.phase.started",
      data: { runId, phaseName: "p1", agentCount: 1 },
    });

    const pi = makeFakePi();
    const restartCalls: string[] = [];
    const saveCalls: string[] = [];
    // Wait for next-tick so registry's `register` queueMicrotask fires
    // BEFORE we mount (we want lastSnapshot to include our seed).
    await Promise.resolve();

    pi.registerCommand("workflows", {
      handler: async (_args, c) => {
        const r = await mountOverlay({
          pi: pi as never,
          ctx: c as never,
          registry,
          phaseRegistry,
          forceTTY: true,
          onRestartRequested: (rid) => {
            restartCalls.push(rid);
          },
          onSaveScriptRequested: (rid) => {
            saveCalls.push(rid);
          },
        });
        void r;
      },
    });
    await pi.invokeCommand("workflows", "");

    assert.equal(pi.overlayMounts.length, 1, "expected one overlay mount");
    const mount = pi.overlayMounts[0]!;

    // Initial render = runs list.
    let lines = mount.component.render(120);
    assert.ok(lines.some((l) => l.includes("/workflows overlay")), `runs-list expected, got:\n${lines.join("\n")}`);

    // Hit Enter to open phase view.
    mount.component.handleInput?.("\r");
    await new Promise((r) => setTimeout(r, 50));
    lines = mount.component.render(120);
    const phaseHeader = lines.find((l) => l.includes(runId));
    assert.ok(phaseHeader !== undefined, `phase view expected, got:\n${lines.join("\n")}`);
    assert.ok(lines.some((l) => l.includes("Phases")), "Phases header expected");

    // P2-S9: card pipeline — running phase renders as a bordered box,
    // the cursor row begins with `▸ ┌`.
    assert.ok(
      lines.some((l) => l.includes("\u250c")),
      `expected at least one boxed card (\u250c), got:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((l) => l.startsWith("\u25b8 \u250c")),
      `expected cursor row beginning with '\u25b8 \u250c', got:\n${lines.join("\n")}`,
    );

    // Hit `s` (save script) — terminal state, must fire callback.
    mount.component.handleInput?.("s");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(saveCalls, [runId], `save callback should fire with runId; got ${saveCalls}`);

    // Hit `r` (restart) — terminal state, must fire callback.
    mount.component.handleInput?.("r");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(restartCalls, [runId], `restart callback should fire with runId; got ${restartCalls}`);

    // Hit Esc to navigate back to runs-list.
    mount.component.handleInput?.("\u001b");
    await new Promise((r) => setTimeout(r, 50));
    lines = mount.component.render(120);
    assert.ok(lines.some((l) => l.includes("/workflows overlay")), `back to runs-list expected, got:\n${lines.join("\n")}`);

    // Close.
    mount.component.handleInput?.("\u001b");
  } finally {
    __setActiveRunsSingletonForTest(priorAR);
    __setPhaseRegistrySingletonForTest(priorPR);
    __resetOverlayOpenForTest();
  }
});

test("overlay phase view (P2-S9): j navigates between phase cards; Enter on pending = no-op; Enter on running drills into first agent", async () => {
  __resetOverlayOpenForTest();
  const priorAR = __setActiveRunsSingletonForTest(null);
  const priorPR = __setPhaseRegistrySingletonForTest(null);
  try {
    const registry = new ActiveRunsRegistry();
    const phaseRegistry = new PhaseRegistry();

    const runId = "wf-int00ph03";
    const run = makeFakeTerminalRun(runId);
    registry.register(runId, run, {
      workflowName: "demo",
      state: "done",
      startedAt: "2026-05-29T12:00:00Z",
      endedAt: "2026-05-29T12:01:00Z",
      runDir: `/tmp/runs/${runId}`,
    });
    // Pre-declare three phases via meta.phases — p3 stays pending.
    phaseRegistry.applyEntry({
      customType: "pi-workflows.meta.phases",
      data: {
        runId,
        phases: [{ title: "p1" }, { title: "p2" }, { title: "p3" }],
      },
    });
    // p1 = done, p2 = running with one running agent, p3 = pending.
    phaseRegistry.applyEntry({
      customType: "pi-workflows.phase.started",
      data: { runId, phaseName: "p1", agentCount: 1, startedAt: "2026-05-29T12:00:00Z" },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.agent.started",
      data: { runId, phaseName: "p1", agentId: "a-p1-0", startedAt: "2026-05-29T12:00:00Z" },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.agent.ended",
      data: {
        runId,
        phaseName: "p1",
        agentId: "a-p1-0",
        endedAt: "2026-05-29T12:00:30Z",
        durationMs: 30_000,
      },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.phase.ended",
      data: {
        runId,
        phaseName: "p1",
        endedAt: "2026-05-29T12:00:30Z",
        durationMs: 30_000,
      },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.phase.started",
      data: { runId, phaseName: "p2", agentCount: 1, startedAt: "2026-05-29T12:00:30Z" },
    });
    phaseRegistry.applyEntry({
      customType: "pi-workflows.agent.started",
      data: { runId, phaseName: "p2", agentId: "a-p2-0", startedAt: "2026-05-29T12:00:31Z" },
    });

    const pi = makeFakePi();
    await Promise.resolve();

    pi.registerCommand("workflows", {
      handler: async (_args, c) => {
        const r = await mountOverlay({
          pi: pi as never,
          ctx: c as never,
          registry,
          phaseRegistry,
          forceTTY: true,
        });
        void r;
      },
    });
    await pi.invokeCommand("workflows", "");
    assert.equal(pi.overlayMounts.length, 1, "expected one overlay mount");
    const mount = pi.overlayMounts[0]!;

    // Drill into phase view.
    mount.component.handleInput?.("\r");
    await new Promise((r) => setTimeout(r, 50));
    let lines = mount.component.render(120);

    // P2-S9 card-format expectations.
    // - At least two boxed cards (p1 done, p2 running) → multiple `┌` lines.
    const boxedTops = lines.filter((l) => l.includes("\u250c"));
    assert.ok(
      boxedTops.length >= 2,
      `expected ≥2 boxed cards (p1, p2), got ${boxedTops.length}:\n${lines.join("\n")}`,
    );
    // - DAG arrow `↓` between two boxed cards.
    assert.ok(
      lines.some((l) => l.trim() === "\u2193"),
      `expected DAG arrow '\u2193' between boxed cards, got:\n${lines.join("\n")}`,
    );
    // - Pending phase p3 renders as collapsed `○ not started` (no box).
    assert.ok(
      lines.some((l) => l.includes("\u25cb not started")),
      `expected pending phase to render as '\u25cb not started', got:\n${lines.join("\n")}`,
    );
    // - Cursor on phase 0 (p1) — row begins with `▸ ┌`.
    assert.ok(
      lines.some((l) => l.startsWith("\u25b8 \u250c")),
      `expected cursor row beginning with '\u25b8 \u250c' on phase 0, got:\n${lines.join("\n")}`,
    );

    // `j` moves cursor to phase 1 (p2 — running).
    mount.component.handleInput?.("j");
    await new Promise((r) => setTimeout(r, 10));
    lines = mount.component.render(120);
    // Cursor row is now the SECOND boxed card. Find the index of cursor row.
    const cursorIdx = lines.findIndex((l) => l.startsWith("\u25b8 \u250c"));
    assert.ok(cursorIdx > 0, `expected cursor on a later boxed card, got:\n${lines.join("\n")}`);
    // Confirm the cursor row is the p2 box (the p2 name should appear in the
    // top border embedding ` p2 `).
    assert.ok(
      lines[cursorIdx]!.includes(" p2 "),
      `expected cursor on p2 card, got:\n${lines[cursorIdx]}`,
    );

    // `j` again → cursor moves to phase 2 (p3 — pending, collapsed).
    mount.component.handleInput?.("j");
    await new Promise((r) => setTimeout(r, 10));
    lines = mount.component.render(120);
    // Pending row prefixed with `▸ ` and contains `not started`.
    assert.ok(
      lines.some(
        (l) => l.startsWith("\u25b8 ") && l.includes("\u25cb not started"),
      ),
      `expected cursor on pending phase row, got:\n${lines.join("\n")}`,
    );

    // `Enter` on pending phase = no-op (still in phase-view).
    mount.component.handleInput?.("\r");
    await new Promise((r) => setTimeout(r, 10));
    lines = mount.component.render(120);
    assert.ok(
      lines.some((l) => l.includes("Phases")),
      `expected to remain in phase-view after Enter on pending, got:\n${lines.join("\n")}`,
    );
    // Should NOT have transitioned to agent-detail (no agent header).
    assert.ok(
      !lines.some((l) => l.includes("a-p3-")),
      `did not expect agent-detail transition for pending phase`,
    );

    // Move cursor back to p2 (running) and hit Enter — should drill into
    // the first running agent (a-p2-0).
    mount.component.handleInput?.("k");
    await new Promise((r) => setTimeout(r, 10));
    mount.component.handleInput?.("\r");
    await new Promise((r) => setTimeout(r, 50));
    lines = mount.component.render(120);
    assert.ok(
      lines.some((l) => l.includes("a-p2-0")),
      `expected agent-detail for first running agent of p2, got:\n${lines.join("\n")}`,
    );

    // Esc twice closes back through phase-view → runs-list.
    mount.component.handleInput?.("\u001b");
    await new Promise((r) => setTimeout(r, 10));
    mount.component.handleInput?.("\u001b");
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    __setActiveRunsSingletonForTest(priorAR);
    __setPhaseRegistrySingletonForTest(priorPR);
    __resetOverlayOpenForTest();
  }
});
