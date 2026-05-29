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

// ─── State-guarded `p` (pause / resume) ────────────────────────────

test("F1+F4: `p` matrix — only running/paused are enabled, with correct action kind", () => {
  const expected: Record<RunSummaryState, "pause" | "resume" | "noop"> = {
    pending: "noop",
    approved: "noop",
    running: "pause",
    paused: "resume",
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

test("F1: `r` matrix — only terminal states emit restart-requested", () => {
  for (const state of STATES) {
    const action = dispatch("r", state);
    if (TERMINAL.has(state)) {
      assert.equal(action.kind, "restart-requested", `state=${state}`);
    } else {
      assert.equal(action.kind, "noop");
      assert.equal(action.reason, "disabled-for-state");
    }
  }
});

// ─── State-independent `g` (gc dialog) ─────────────────────────────

test("`g` always emits open-gc-dialog on runs-list", () => {
  for (const state of STATES) {
    const action = dispatch("g", state);
    assert.equal(action.kind, "open-gc-dialog");
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
