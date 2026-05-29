/**
 * pi-workflows — slice 13 hotkey dispatcher.
 *
 * **State-guarded** by design (concern F1): the same physical key can
 * mean different things on different runs and means *nothing* on some.
 * E.g. `p` (pause) is a no-op on a `done` run; `r` (restart) only
 * applies to terminal states. Slice 12's race carry-forward — pause()
 * silently no-ops on terminated runs at the Run-handle layer — is
 * mirrored here at the input layer so the overlay can also gray the
 * hotkey hint for clarity (concern F1, second sentence).
 *
 * Pure function design. No mounting, no IO, no overlay state — the
 * dispatcher is fed `(key, state, view)` and returns an `Action`
 * descriptor the overlay then executes. This keeps the matrix
 * exhaustively unit-testable.
 *
 * Hotkey table (slice 13 subset of PRD §10.4 — phase/agent detail are
 * slices 14/15 territory):
 *
 *   ↑/k  navigate-up           any view, any state
 *   ↓/j  navigate-down         any view, any state
 *   Enter open-phase-view      runs-list (slice 14 wires the view)
 *   Esc  close-overlay         runs-list
 *   p    pause | resume        runs-list, running → pause; paused → resume
 *   x    stop                  runs-list, running | paused
 *   r    restart-requested     runs-list, terminal states (done/failed/stopped/cancelled-pre-run)
 *   g    open-gc-dialog        runs-list (slice 15 wires the dialog)
 *   ?    toggle-help           any view
 *
 * F1 consequence: when a state-disabled key is pressed, the dispatcher
 * returns `{ kind: "noop", reason: "disabled-for-state" }` so the
 * overlay can flash a one-line warning ("p has no effect on done runs")
 * instead of silently swallowing.
 *
 * Refs: PRD §10.4, plan.md §4 Slice 13 acceptance, slice_13_concerns F1+F4.
 */

import type { RunSummaryState } from "./activeRuns.js";

/**
 * Logical actions the dispatcher emits. The overlay maps these to
 * concrete callbacks. Every action carries `runId` when meaningful
 * (most do; navigate-up/down/help-toggle don't).
 */
export type HotkeyActionKind =
  | "noop"
  | "navigate-up"
  | "navigate-down"
  | "open-phase-view"
  | "close-overlay"
  | "pause"
  | "resume"
  | "stop"
  | "restart-requested"
  | "open-gc-dialog"
  | "toggle-help";

export interface HotkeyAction {
  readonly kind: HotkeyActionKind;
  readonly runId?: string;
  /** When `kind === "noop"`, why the key was a no-op. Exposed so the
   * overlay can render an appropriate hint. */
  readonly reason?:
    | "disabled-for-state"
    | "no-selection"
    | "unknown-key";
}

/** The overlay views slice 13 understands. Phase/agent are slices 14/15. */
export type OverlayView = "runs-list" | "phase-view" | "agent-detail";

/**
 * Inputs to the dispatcher. `runState` is undefined when there is no
 * selected run (empty list); state-guarded keys then return noop with
 * `reason="no-selection"`.
 */
export interface DispatchInput {
  readonly key: string;
  readonly view: OverlayView;
  readonly runState?: RunSummaryState | undefined;
  readonly runId?: string | undefined;
}

const NORM_KEY = new Map<string, string>([
  ["ArrowUp", "up"],
  ["UP", "up"],
  ["k", "up"],
  ["ArrowDown", "down"],
  ["DOWN", "down"],
  ["j", "down"],
  ["Enter", "enter"],
  ["RETURN", "enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["Escape", "escape"],
  ["ESC", "escape"],
  ["\u001b", "escape"],
  ["p", "p"],
  ["P", "p"],
  ["r", "r"],
  ["R", "r"],
  ["x", "x"],
  ["X", "x"],
  ["g", "g"],
  ["G", "g"],
  ["?", "?"],
  ["s", "s"], // slice 14 owns the action; slice 13 emits noop with reason
  ["S", "s"],
]);

function normalize(key: string): string {
  return NORM_KEY.get(key) ?? key.toLowerCase();
}

const TERMINAL: ReadonlySet<RunSummaryState> = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

/**
 * Returns whether the (key, view, state) tuple is a real, enabled
 * hotkey. Pure — used by the help-line render to gray-out disabled
 * entries (F1 second sentence).
 *
 * Universal keys (navigation, esc, help-toggle) are always enabled.
 * State-guarded keys are enabled only on states the table specifies.
 */
export function isHotkeyEnabled(input: DispatchInput): boolean {
  const k = normalize(input.key);
  switch (k) {
    case "up":
    case "down":
    case "?":
      return true;
    case "escape":
      return input.view === "runs-list";
    case "enter":
      return input.view === "runs-list" && input.runState !== undefined;
    case "p":
      // pause/resume only on the runs list, only for running/paused.
      if (input.view !== "runs-list") return false;
      return input.runState === "running" || input.runState === "paused";
    case "x":
      if (input.view !== "runs-list") return false;
      return input.runState === "running" || input.runState === "paused";
    case "r":
      if (input.view !== "runs-list") return false;
      return input.runState !== undefined && TERMINAL.has(input.runState);
    case "g":
      return input.view === "runs-list";
    case "s":
      // Slice 14 wires `s` on the phase view; on the runs list it's
      // disabled per PRD §10.4 (the `s` row is `(no-op)` for runs list).
      return false;
    default:
      return false;
  }
}

/**
 * Single entry point. Pure, deterministic, no IO. The overlay layer
 * is responsible for translating actions into Run-handle calls
 * (`pause`/`resumePaused`/`stop`) — see overlay.ts.
 */
export function dispatchHotkey(input: DispatchInput): HotkeyAction {
  const k = normalize(input.key);

  // Universal navigation / chrome — independent of state.
  switch (k) {
    case "up":
      return { kind: "navigate-up" };
    case "down":
      return { kind: "navigate-down" };
    case "?":
      return { kind: "toggle-help" };
    case "escape":
      if (input.view === "runs-list") return { kind: "close-overlay" };
      // Phase/agent detail will return their own actions in slices
      // 14/15; for slice 13 the overlay only mounts runs-list and
      // close-overlay is the only Esc that's wired.
      return { kind: "close-overlay" };
  }

  // From here on, every key needs a selected run *or* operates on
  // overlay-level chrome. Universal-no-selection short-circuit:
  if (input.runId === undefined && k !== "g") {
    return { kind: "noop", reason: "no-selection" };
  }

  if (k === "g") {
    return { kind: "open-gc-dialog" };
  }

  if (k === "enter" && input.view === "runs-list") {
    return {
      kind: "open-phase-view",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
  }

  // State-guarded actions — runId is now guaranteed non-undefined.
  const runId = input.runId!;

  switch (k) {
    case "p": {
      if (input.runState === "running")
        return { kind: "pause", runId };
      if (input.runState === "paused")
        return { kind: "resume", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "x": {
      if (input.runState === "running" || input.runState === "paused")
        return { kind: "stop", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "r": {
      // Slice 13 emits `restart-requested` only — the actual restart
      // (script.js copy + new runId mint) lives in slice 14/15 per the
      // brief. Disabled if not terminal.
      if (input.runState !== undefined && TERMINAL.has(input.runState))
        return { kind: "restart-requested", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "s": {
      // Slice 13 doesn't wire `s` (slice 14 owns save-script). Always
      // a no-op; surface a `disabled-for-state` reason so help can
      // call out "save lives in phase view".
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    default:
      return { kind: "noop", runId, reason: "unknown-key" };
  }
}

/**
 * Returns the help-line bullets for the given view+selected-run state.
 * Disabled hotkeys are still surfaced (with a `disabled` flag) so the
 * overlay can render them grayed out per F1 second sentence.
 */
export interface HelpBullet {
  readonly key: string;
  readonly label: string;
  readonly disabled: boolean;
}

export function helpForState(
  view: OverlayView,
  runState: RunSummaryState | undefined,
): HelpBullet[] {
  const dis = (
    key: string,
    label: string,
    disabled: boolean,
  ): HelpBullet => ({ key, label, disabled });
  const enabled = (key: string, label: string): HelpBullet =>
    dis(key, label, false);

  if (view !== "runs-list") {
    // Slices 14/15 own these views; we stub a help line that closes.
    return [enabled("Esc", "back"), enabled("?", "help")];
  }

  const noSel = runState === undefined;
  const isRunning = runState === "running";
  const isPaused = runState === "paused";
  const isTerminal = runState !== undefined && TERMINAL.has(runState);

  return [
    enabled("↑↓ jk", "navigate"),
    dis("Enter", "open run", noSel),
    dis(
      "p",
      isPaused ? "resume" : "pause",
      noSel || (!isRunning && !isPaused),
    ),
    dis("x", "stop", noSel || (!isRunning && !isPaused)),
    dis("r", "restart", noSel || !isTerminal),
    enabled("g", "gc"),
    enabled("Esc", "close"),
    enabled("?", "help"),
  ];
}
