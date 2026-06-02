/**
 * tests/unit/hotkeys.test.ts — slice 13/F1 + F4.
 *
 * Exhaustive (key × runState) matrix. The disabled-vs-enabled outcomes
 * are the contract; if a disabled hotkey starts firing, this test
 * immediately catches it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchHotkey,
  helpForState,
  isHotkeyEnabled,
  type HotkeyAction,
} from "../../src/runtime/hotkeys.js";
import type { RunSummaryState } from "../../src/runtime/activeRuns.js";

const STATES: RunSummaryState[] = [
  "pending",
  "approved",
  "running",
  "paused",
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
];

const TERMINAL: ReadonlySet<RunSummaryState> = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

function dispatch(
  key: string,
  state: RunSummaryState,
  runId = "wf-test01",
): HotkeyAction {
  return dispatchHotkey({
    key,
    view: "runs-list",
    runState: state,
    runId,
  });
}

// ─── Universal navigation ──────────────────────────────────────────

test("↑/k always emits navigate-up regardless of state", () => {
  for (const state of STATES) {
    assert.equal(dispatch("ArrowUp", state).kind, "navigate-up");
    assert.equal(dispatch("k", state).kind, "navigate-up");
  }
});

test("↓/j always emits navigate-down regardless of state", () => {
  for (const state of STATES) {
    assert.equal(dispatch("ArrowDown", state).kind, "navigate-down");
    assert.equal(dispatch("j", state).kind, "navigate-down");
  }
});

test("Esc emits close-overlay on the runs-list view", () => {
  for (const state of STATES) {
    assert.equal(dispatch("Escape", state).kind, "close-overlay");
    assert.equal(dispatch("\u001b", state).kind, "close-overlay");
  }
});

test("? always emits toggle-help", () => {
  for (const state of STATES) {
    assert.equal(dispatch("?", state).kind, "toggle-help");
  }
});

test("Enter on runs-list opens phase view (slice 14 owns the actual view)", () => {
  for (const state of STATES) {
    const action = dispatch("Enter", state);
    assert.equal(action.kind, "open-phase-view");
    assert.equal(action.runId, "wf-test01");
  }
});

// ─── State-guarded `p` (pause only — slice 11 VQ-4) ──────────────

test("F1+F4: `p` matrix — only running enables pause; paused is now noop (use `u`)", () => {
  const expected: Record<RunSummaryState, "pause" | "noop"> = {
    pending: "noop",
    approved: "noop",
    running: "pause",
    paused: "noop",
    done: "noop",
    failed: "noop",
    stopped: "noop",
    "cancelled-pre-run": "noop",
  };
  for (const state of STATES) {
    const action = dispatch("p", state);
    assert.equal(action.kind, expected[state], `state=${state} for key=p`);
    if (action.kind === "noop") {
      assert.equal(
        action.reason,
        "disabled-for-state",
        `noop reason for state=${state}`,
      );
    }
  }
});

// ─── State-guarded `u` (unpause — slice 11 VQ-4) ─────────────────

test("VQ-4: `u` matrix — only paused emits resume; everything else noop", () => {
  for (const state of STATES) {
    const action = dispatch("u", state);
    if (state === "paused") {
      assert.equal(action.kind, "resume", `state=${state}`);
    } else {
      assert.equal(action.kind, "noop", `state=${state}`);
      assert.equal(action.reason, "disabled-for-state");
    }
  }
});

// ─── State-guarded `x` (stop) ──────────────────────────────────────

test("F1: `x` matrix — only running/paused are stoppable", () => {
  for (const state of STATES) {
    const action = dispatch("x", state);
    if (state === "running" || state === "paused") {
      assert.equal(action.kind, "stop", `state=${state} should stop`);
    } else {
      assert.equal(action.kind, "noop");
      assert.equal(action.reason, "disabled-for-state");
    }
  }
});

// ─── State-guarded `r` (restart-requested) ─────────────────────────

test("F1: `r` matrix — paused noop (use `u`); terminal emits restart-requested (slice 11 VQ-4)", () => {
  for (const state of STATES) {
    const action = dispatch("r", state);
    if (TERMINAL.has(state)) {
      assert.equal(action.kind, "restart-requested", `state=${state}`);
    } else {
      assert.equal(action.kind, "noop", `state=${state}`);
      assert.equal(action.reason, "disabled-for-state");
    }
  }
});

// ─── Slice 11 VQ-2: `G` opens GC dialog; `g` is the chord initiator ─

test("VQ-2: `G` (uppercase) emits open-gc-dialog on runs-list", () => {
  for (const state of STATES) {
    const action = dispatch("G", state);
    assert.equal(action.kind, "open-gc-dialog");
  }
});

test("VQ-2: `g` (lowercase) alone emits noop reason=pending-g", () => {
  const action = dispatchHotkey({
    key: "g",
    view: "runs-list",
    runState: "running",
    runId: "wf-1",
    pendingG: false,
    pendingGAt: 0,
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "pending-g");
});

test("VQ-2: `gg` chord within 300ms emits navigate-first", () => {
  const action = dispatchHotkey({
    key: "g",
    view: "runs-list",
    runState: "running",
    runId: "wf-1",
    pendingG: true,
    pendingGAt: Date.now() - 100,
  });
  assert.equal(action.kind, "navigate-first");
});

test("VQ-2: `gg` chord after 300ms produces noop pending-g (chord timed out)", () => {
  // Expired chord: dispatcher treats it as a fresh first-tap.
  const expired = dispatchHotkey({
    key: "g",
    view: "runs-list",
    runState: "running",
    runId: "wf-1",
    pendingG: true,
    pendingGAt: Date.now() - 400,
  });
  assert.equal(expired.kind, "noop");
  assert.equal(expired.reason, "pending-g");
  // Two separate first-taps each emit noop pending-g.
  const first = dispatchHotkey({
    key: "g",
    view: "runs-list",
    runState: "running",
    runId: "wf-1",
    pendingG: false,
    pendingGAt: 0,
  });
  assert.equal(first.kind, "noop");
  assert.equal(first.reason, "pending-g");
});

test("VQ-2: `g` outside runs-list is disabled-for-state", () => {
  const action = dispatchHotkey({
    key: "g",
    view: "phase-view",
    runState: "running",
    runId: "wf-1",
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-state");
});

// ─── Slice 11 VQ-4: `u` unpause / `r` terminal-only / `p` pause-only ─

test("VQ-4: `u` on paused run emits resume", () => {
  const action = dispatch("u", "paused");
  assert.equal(action.kind, "resume");
  assert.equal(action.runId, "wf-test01");
});

test("VQ-4: `u` on running run is noop disabled-for-state", () => {
  const action = dispatch("u", "running");
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-state");
});

test("VQ-4: `p` on paused run is noop disabled-for-state (no longer resumes)", () => {
  const action = dispatch("p", "paused");
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-state");
});

test("VQ-4: `p` on running run still emits pause", () => {
  const action = dispatch("p", "running");
  assert.equal(action.kind, "pause");
});

test("VQ-4: `r` on paused run is noop (no longer resumes — use `u`)", () => {
  const action = dispatch("r", "paused");
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-state");
});

test("VQ-4: `r` on terminal run still emits restart-requested", () => {
  for (const state of ["done", "failed", "stopped", "cancelled-pre-run"] as const) {
    const action = dispatch("r", state);
    assert.equal(action.kind, "restart-requested", `state=${state}`);
  }
});

// ─── No selection short-circuit ────────────────────────────────────

test("State-guarded keys with no selection emit noop reason=no-selection", () => {
  for (const k of ["p", "x", "r", "Enter"]) {
    const action = dispatchHotkey({
      key: k,
      view: "runs-list",
      runState: undefined,
      runId: undefined,
    });
    assert.equal(action.kind, "noop");
    assert.equal(action.reason, "no-selection");
  }
});

// ─── isHotkeyEnabled symmetry with dispatchHotkey ──────────────────

test("isHotkeyEnabled === !noop-for-disabled-state for state-guarded keys", () => {
  const guarded = ["p", "x", "r"];
  for (const key of guarded) {
    for (const state of STATES) {
      const enabled = isHotkeyEnabled({
        key,
        view: "runs-list",
        runState: state,
        runId: "wf-test01",
      });
      const action = dispatch(key, state);
      assert.equal(
        enabled,
        action.kind !== "noop",
        `mismatch for key=${key} state=${state}`,
      );
    }
  }
});

// ─── helpForState renders disabled bullets per F1 second sentence ──

test("helpForState marks disabled bullets per state", () => {
  const runningHelp = helpForState("runs-list", "running");
  const p = runningHelp.find((b) => b.key === "p");
  assert.equal(p?.disabled, false);
  assert.equal(p?.label, "pause");

  const doneHelp = helpForState("runs-list", "done");
  const pDone = doneHelp.find((b) => b.key === "p");
  assert.equal(
    pDone?.disabled,
    true,
    "p must be grayed out for terminal runs",
  );
  const rDone = doneHelp.find((b) => b.key === "r");
  assert.equal(
    rDone?.disabled,
    false,
    "r is enabled for terminal runs (restart)",
  );

  const noSel = helpForState("runs-list", undefined);
  // All state-guarded keys are disabled when nothing is selected.
  for (const k of ["Enter", "p", "x", "r"]) {
    const b = noSel.find((bb) => bb.key === k);
    assert.equal(
      b?.disabled,
      true,
      `${k} must be disabled when no run is selected`,
    );
  }
});

// ─── Slice 15 F2: r/s disabled on remote runs ──────────────────

test("F2: r on runs-list is noop for remote runs (terminal state)", () => {
  const action = dispatchHotkey({
    key: "r",
    view: "runs-list",
    runState: "done",
    runId: "wf-ext000001",
    isRemote: true,
  });
  assert.equal(action.kind, "noop", `r should be noop on remote runs; got ${action.kind}`);
});

test("F2: r on runs-list fires restart-requested for local terminal runs", () => {
  const action = dispatchHotkey({
    key: "r",
    view: "runs-list",
    runState: "done",
    runId: "wf-loc000001",
    isRemote: false,
  });
  assert.equal(action.kind, "restart-requested");
});

test("F2: s on phase-view is noop for remote runs (terminal state)", () => {
  const action = dispatchHotkey({
    key: "s",
    view: "phase-view",
    runState: "done",
    runId: "wf-ext000001",
    isRemote: true,
  });
  assert.equal(action.kind, "noop", `s should be noop on remote runs; got ${action.kind}`);
});

test("F2: s on phase-view fires save-script-requested for local terminal runs", () => {
  const action = dispatchHotkey({
    key: "s",
    view: "phase-view",
    runState: "done",
    runId: "wf-loc000001",
    isRemote: false,
  });
  assert.equal(action.kind, "save-script-requested");
});

test("F2: isHotkeyEnabled r=false for remote runs", () => {
  const enabled = isHotkeyEnabled({
    key: "r",
    view: "runs-list",
    runState: "done",
    runId: "wf-ext000001",
    isRemote: true,
  });
  assert.equal(enabled, false, "r should not be enabled for remote runs");
});

// ─── Slice 15: t/c hotkeys in agent-detail ─────────────────

test("t on agent-detail dispatches open-transcript", () => {
  const action = dispatchHotkey({
    key: "t",
    view: "agent-detail",
    runId: "wf-abc0000001",
  });
  assert.equal(action.kind, "open-transcript");
});

test("c on agent-detail dispatches copy-prompt", () => {
  const action = dispatchHotkey({
    key: "c",
    view: "agent-detail",
    runId: "wf-abc0000001",
  });
  assert.equal(action.kind, "copy-prompt");
});

test("t on runs-list is noop", () => {
  const action = dispatchHotkey({
    key: "t",
    view: "runs-list",
    runState: "done",
    runId: "wf-abc0000001",
  });
  assert.equal(action.kind, "noop");
});

test("Enter on phase-view dispatches open-agent-detail", () => {
  const action = dispatchHotkey({
    key: "Enter",
    view: "phase-view",
    runState: "running",
    runId: "wf-abc0000001",
  });
  assert.equal(action.kind, "open-agent-detail");
});

// ─── Slice 15 F1: U3 remote-badge mutation guard (hotkey layer) ───
// (The render-layer mutation test lives in runsList.test.ts)

test("F2 mutation-guard: G is still enabled for remote runs", () => {
  // G (GC) should be unaffected by isRemote — it's not restricted to local.
  const action = dispatchHotkey({
    key: "G",
    view: "runs-list",
  });
  assert.equal(action.kind, "open-gc-dialog", "G should open GC dialog");
});

// ─── disabled-for-remote reason (UX toast gap fix) ───────────────────────────

test("r on remote terminal run returns reason=disabled-for-remote", () => {
  const action = dispatchHotkey({
    key: "r",
    view: "phase-view",
    runState: "done",
    runId: "wf-abc0000001",
    isRemote: true,
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-remote");
});

test("s on remote terminal run returns reason=disabled-for-remote", () => {
  const action = dispatchHotkey({
    key: "s",
    view: "phase-view",
    runState: "done",
    runId: "wf-abc0000001",
    isRemote: true,
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-remote");
});

test("r on local terminal run still fires restart-requested (not noop)", () => {
  const action = dispatchHotkey({
    key: "r",
    view: "phase-view",
    runState: "done",
    runId: "wf-abc0000001",
    isRemote: false,
  });
  assert.equal(action.kind, "restart-requested");
});

// ─── Per-agent stop / restart ─────────────────────────────────────

test("x on phase-view with running agent selected → stop-agent", () => {
  const action = dispatchHotkey({
    key: "x",
    view: "phase-view",
    runState: "running",
    runId: "wf-test01",
    agentId: "agent-abc123",
    agentState: "running",
  });
  assert.equal(action.kind, "stop-agent");
  assert.equal(action.runId, "wf-test01");
  assert.equal(action.agentId, "agent-abc123");
});

test("r on phase-view with running agent selected → restart-agent", () => {
  const action = dispatchHotkey({
    key: "r",
    view: "phase-view",
    runState: "running",
    runId: "wf-test01",
    agentId: "agent-abc123",
    agentState: "running",
  });
  assert.equal(action.kind, "restart-agent");
  assert.equal(action.runId, "wf-test01");
  assert.equal(action.agentId, "agent-abc123");
});

test("x on phase-view without agent cursor falls through to run-level stop", () => {
  const action = dispatchHotkey({
    key: "x",
    view: "phase-view",
    runState: "running",
    runId: "wf-test01",
    // no agentId
  });
  assert.equal(action.kind, "stop");
  assert.equal(action.runId, "wf-test01");
});

test("r on phase-view without agent cursor: paused → noop, terminal → restart-requested", () => {
  // Slice 11 (VQ-4): paused without agent cursor → noop (use `u` instead).
  const paused = dispatchHotkey({
    key: "r",
    view: "phase-view",
    runState: "paused",
    runId: "wf-test01",
  });
  assert.equal(paused.kind, "noop");
  assert.equal(paused.reason, "disabled-for-state");

  // terminal run without agent cursor → restart-requested (not restart-agent)
  const terminal = dispatchHotkey({
    key: "r",
    view: "phase-view",
    runState: "done",
    runId: "wf-test01",
  });
  assert.equal(terminal.kind, "restart-requested");
});

test("x on phase-view with queued agent (not running) falls through to run-level stop", () => {
  const action = dispatchHotkey({
    key: "x",
    view: "phase-view",
    runState: "running",
    runId: "wf-test01",
    agentId: "agent-abc123",
    agentState: "queued",
  });
  assert.equal(action.kind, "stop"); // run-level, not agent-level
});

test("isHotkeyEnabled: x in phase-view with running agent is enabled", () => {
  assert.equal(
    isHotkeyEnabled({
      key: "x",
      view: "phase-view",
      runState: "running",
      agentId: "agent-abc",
      agentState: "running",
    }),
    true,
  );
});

test("isHotkeyEnabled: r in phase-view with running agent is enabled", () => {
  assert.equal(
    isHotkeyEnabled({
      key: "r",
      view: "phase-view",
      runState: "running",
      agentId: "agent-abc",
      agentState: "running",
    }),
    true,
  );
});

// ZONE_HITL TUI surface — `i` answers a pending interrupt.
test("ZONE_HITL: `i` is enabled on runs-list when pendingInterruptCount > 0", () => {
  assert.equal(
    isHotkeyEnabled({
      key: "i",
      view: "runs-list",
      runState: "running",
      runId: "wf-1",
      pendingInterruptCount: 1,
    }),
    true,
  );
});

test("ZONE_HITL: `i` is disabled when no pending interrupts", () => {
  assert.equal(
    isHotkeyEnabled({
      key: "i",
      view: "runs-list",
      runState: "running",
      runId: "wf-1",
      pendingInterruptCount: 0,
    }),
    false,
  );
});

test("ZONE_HITL: `i` dispatches interrupt-answer-requested with runId", () => {
  const action = dispatchHotkey({
    key: "i",
    view: "runs-list",
    runState: "running",
    runId: "wf-abc",
    pendingInterruptCount: 2,
  });
  assert.equal(action.kind, "interrupt-answer-requested");
  assert.equal(action.runId, "wf-abc");
});

test("ZONE_HITL: `i` is also enabled in phase-view", () => {
  // Operator may have drilled into the phase view when the workflow
  // pauses. The hotkey works there too — same dispatch.
  const action = dispatchHotkey({
    key: "i",
    view: "phase-view",
    runState: "running",
    runId: "wf-abc",
    pendingInterruptCount: 1,
  });
  assert.equal(action.kind, "interrupt-answer-requested");
});

test("ZONE_HITL: `i` in agent-detail is noop", () => {
  const action = dispatchHotkey({
    key: "i",
    view: "agent-detail",
    runState: "running",
    runId: "wf-abc",
    pendingInterruptCount: 1,
  });
  assert.equal(action.kind, "noop");
});

// ZONE_TIMETRAVEL TUI surface — `f` opens fork dialog.
test("ZONE_TIMETRAVEL: `f` on runs-list dispatches fork-requested", () => {
  const action = dispatchHotkey({
    key: "f",
    view: "runs-list",
    runState: "done",
    runId: "wf-parent01",
  });
  assert.equal(action.kind, "fork-requested");
  assert.equal(action.runId, "wf-parent01");
});

test("ZONE_TIMETRAVEL: `f` is enabled regardless of run state (forking running runs is allowed)", () => {
  for (const state of ["running", "paused", "done", "failed", "stopped", "cancelled-pre-run"] as const) {
    assert.equal(
      isHotkeyEnabled({ key: "f", view: "runs-list", runState: state, runId: "wf-1" }),
      true,
      `f must be enabled for state=${state}`,
    );
  }
});

test("ZONE_TIMETRAVEL: `f` outside runs-list is noop", () => {
  const action = dispatchHotkey({
    key: "f",
    view: "phase-view",
    runState: "running",
    runId: "wf-1",
  });
  assert.equal(action.kind, "noop");
});

test("ZONE_TIMETRAVEL: `f` with no runId is noop (no-selection)", () => {
  const action = dispatchHotkey({ key: "f", view: "runs-list" });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "no-selection");
});

// ----- P2-S7: filter mode -----------------------------------------------

test("P2-S7: `/` in runs-list emits filter-enter", () => {
  const action = dispatchHotkey({ key: "/", view: "runs-list", runState: "running", runId: "wf-1" });
  assert.equal(action.kind, "filter-enter");
});

test("P2-S7: printable char in filter view emits filter-append with char", () => {
  const action = dispatchHotkey({ key: "a", view: "filter" });
  assert.equal(action.kind, "filter-append");
  assert.equal(action.char, "a");
});

test("P2-S7: Escape in filter view emits filter-clear", () => {
  const action = dispatchHotkey({ key: "Escape", view: "filter" });
  assert.equal(action.kind, "filter-clear");
});

test("P2-S7: Backspace in filter view emits filter-backspace", () => {
  const action = dispatchHotkey({ key: "Backspace", view: "filter" });
  assert.equal(action.kind, "filter-backspace");
});

test("P2-S7: Enter in filter view emits filter-enter (lock)", () => {
  const action = dispatchHotkey({ key: "Enter", view: "filter" });
  assert.equal(action.kind, "filter-enter");
});

// ----- P2-S6: peek panel -----------------------------------------------

test("P2-S6: Space on a runs-list row emits peek-toggle with runId", () => {
  const action = dispatchHotkey({
    key: " ",
    view: "runs-list",
    runState: "running",
    runId: "wf-peek00000001",
  });
  assert.equal(action.kind, "peek-toggle");
  assert.equal(action.runId, "wf-peek00000001");
});

test("P2-S6: Space without a selected run is a no-op (no-selection)", () => {
  const action = dispatchHotkey({ key: " ", view: "runs-list" });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "no-selection");
});

test("P2-S6: Space outside runs-list view is disabled-for-state", () => {
  const action = dispatchHotkey({
    key: " ",
    view: "phase-view",
    runState: "running",
    runId: "wf-peek00000001",
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.reason, "disabled-for-state");
});

test("P2-S6: Space fires regardless of run state (peek is read-only)", () => {
  for (const state of STATES) {
    const action = dispatchHotkey({
      key: " ",
      view: "runs-list",
      runState: state,
      runId: "wf-peek00000001",
    });
    assert.equal(action.kind, "peek-toggle", `expected peek-toggle for state=${state}`);
  }
});
