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
  | "navigate-first"
  | "navigate-back"
  | "open-phase-view"
  | "open-agent-detail"
  | "close-overlay"
  | "pause"
  | "resume"
  | "stop"
  | "stop-agent"
  | "restart-agent"
  | "restart-requested"
  | "save-script-requested"
  | "visualize-requested"
  | "interrupt-answer-requested"
  // Slice 15 (I1): explicit "defer / leave-pending" semantics for
  // gate + interrupt prompts. Esc on a HITL prompt no longer denies;
  // it snoozes — the run stays blocked, the overlay queue stays
  // intact, and the user can re-open with `i` or stop with `x`.
  // Overlay state machines emit this kind from the gate-prompt
  // intercept (overlay.ts) and from the interrupt callback's snooze
  // result path (workflowCmd.ts onInterruptAnswerRequested).
  | "snooze"
  | "fork-requested"
  | "open-gc-dialog"
  | "open-transcript"
  | "copy-prompt"
  | "gc-apply"
  | "gc-cancel"
  | "toggle-help"
  // P2-S7 — filter mode actions.
  | "filter-enter"
  | "filter-append"
  | "filter-backspace"
  | "filter-clear"
  // P2-S6 — peek panel toggle (Space on a runs-list row).
  | "peek-toggle";

export interface HotkeyAction {
  readonly kind: HotkeyActionKind;
  readonly runId?: string;
  /** Populated for `stop-agent` and `restart-agent` actions. */
  readonly agentId?: string;
  /** P2-S7 — the character appended for `filter-append`. */
  readonly char?: string;
  /** When `kind === "noop"`, why the key was a no-op. Exposed so the
   * overlay can render an appropriate hint. */
  readonly reason?:
    | "disabled-for-state"
    | "disabled-for-remote"
    | "no-selection"
    | "unknown-key"
    | "pending-g";
}

/** The overlay views slice 13 understands. Phase/agent are slices 14/15.
 * P2-S7 added `'filter'` for filter-input mode. */
export type OverlayView = "runs-list" | "phase-view" | "agent-detail" | "filter";

/**
 * Inputs to the dispatcher. `runState` is undefined when there is no
 * selected run (empty list); state-guarded keys then return noop with
 * `reason="no-selection"`.
 *
 * F2 (slice 15): `isRemote` signals the selected run is a cross-process
 * summary (no local handle). Restart and save-script are disabled for
 * remote runs — we can't restart a run we don't own, and the script.js
 * may not be accessible on this machine.
 */
export interface DispatchInput {
  readonly key: string;
  readonly view: OverlayView;
  readonly runState?: RunSummaryState | undefined;
  readonly runId?: string | undefined;
  /**
   * Slice 15 F2 — true when the selected run has no local handle
   * (cross-process / remote-registry summary). `r` (restart) and
   * `s` (save-script) are no-ops on remote runs.
   */
  readonly isRemote?: boolean | undefined;
  /**
   * Per-agent stop/restart: the agentId under the phase-view cursor.
   * When set (and agentState === "running"), `x` → stop-agent and
   * `r` → restart-agent instead of the run-level actions.
   */
  readonly agentId?: string | undefined;
  /** State of the cursor-selected agent (queued | running | done). */
  readonly agentState?: "queued" | "running" | "done" | undefined;
  /**
   * ZONE_HITL TUI surface — number of pending interrupts on the
   * selected run. When > 0, `i` is enabled and emits
   * `interrupt-answer-requested`. The overlay populates this from
   * the local pending-interrupt map driven by `interrupt_requested`
   * / `interrupt_resolved` ledger events.
   */
  readonly pendingInterruptCount?: number | undefined;
  /**
   * Slice 11 (VQ-2): chord state for the `gg` jump-to-first sequence.
   * The overlay tracks `pendingG` (set after the first `g` tap) and
   * `pendingGAt` (wall-clock ms of that tap) and threads them in.
   * The dispatcher emits `navigate-first` when a second `g` arrives
   * within 300ms; otherwise it emits `noop` with reason `pending-g`
   * and the overlay sets `pendingG=true; pendingGAt=Date.now()`.
   */
  readonly pendingG?: boolean | undefined;
  readonly pendingGAt?: number | undefined;
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
  // Slice 11 (VQ-2): G is now its own normalized key — opens the GC
  // dialog. Lowercase `g` is the `gg` chord initiator (jump-first).
  ["G", "G"],
  // Slice 11 (VQ-4): u is the unpause/resume key. p no longer resumes.
  ["u", "u"],
  ["U", "u"],
  ["?", "?"],
  ["s", "s"], // save-script
  ["S", "s"],
  ["t", "t"],  // slice 15: open transcript in $EDITOR
  ["T", "t"],
  ["c", "c"],  // slice 15: copy prompt to clipboard
  ["C", "c"],
  ["y", "y"],  // slice 15: GC dialog apply confirm
  ["Y", "y"],
  ["n", "n"],  // slice 15: GC dialog cancel
  ["N", "n"],
  ["v", "v"], // gap/viz: write Mermaid DAG to tmp file
  ["V", "v"],
  // ZONE_HITL TUI surface: 'i' answers the oldest pending interrupt.
  ["i", "i"],
  ["I", "i"],
  // ZONE_TIMETRAVEL TUI surface: 'f' opens the fork-from-checkpoint dialog.
  ["f", "f"],
  ["F", "f"],
  // P2-S6: peek panel toggle (Space on a runs-list row).
  [" ", "space"],
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
      return input.view === "runs-list" || input.view === "phase-view" || input.view === "agent-detail" || input.view === "filter";
    case "enter":
      if (input.view === "runs-list") return input.runState !== undefined;
      if (input.view === "phase-view") return input.runState !== undefined;
      return false;
    case "p":
      // Slice 11 (VQ-4): `p` only pauses; `u` is the new unpause key.
      return input.runState === "running";
    case "u":
      // Slice 11 (VQ-4): `u` resumes a paused run; otherwise disabled.
      return input.runState === "paused";
    case "x":
      // Agent-level: enabled in phase-view when cursor selects a running agent.
      if (input.view === "phase-view" && input.agentId !== undefined && input.agentState === "running")
        return true;
      return input.runState === "running" || input.runState === "paused";
    case "r":
      if (input.isRemote) return false; // F2: remote runs can't be restarted
      // Agent-level restart: enabled in phase-view when cursor selects a running agent.
      if (input.view === "phase-view" && input.agentId !== undefined && input.agentState === "running")
        return true;
      // Slice 11 (VQ-4): `r` no longer resumes paused runs (use `u`).
      // Only terminal states fire `restart-requested`.
      if (input.view === "runs-list" || input.view === "phase-view") {
        return input.runState !== undefined && TERMINAL.has(input.runState);
      }
      return false;
    case "g":
      // Slice 11 (VQ-2): `g` is the chord initiator — always "enabled"
      // on runs-list (it either advances the chord or starts one).
      return input.view === "runs-list";
    case "G":
      // Slice 11 (VQ-2): `G` opens the GC dialog (was lowercase `g`).
      return input.view === "runs-list";
    case "s":
      // Slice 14: `s` (save) is enabled on phase-view, ONLY for terminal
      // states (per PRD §10.4 — `s` saves the run's frozen script.js).
      // Slice 15 F2: disabled on remote runs.
      if (input.view !== "phase-view") return false;
      if (input.isRemote) return false;
      return input.runState !== undefined && TERMINAL.has(input.runState);
    case "t":
      return input.view === "agent-detail";
    case "c":
      return input.view === "agent-detail";
    case "v":
      // gap/viz: `v` writes the run's DAG to a tmp .mmd file.
      // Enabled on runs-list and phase-view whenever a run is selected,
      // including terminal states (the diagram is the most useful
      // post-mortem artefact).
      if (input.view === "runs-list") return input.runId !== undefined;
      if (input.view === "phase-view") return input.runId !== undefined;
      return false;
    case "i":
      // ZONE_HITL: 'i' answers the oldest pending interrupt for the
      // selected run. Enabled only when there's at least one pending
      // interrupt; available on runs-list AND phase-view since either
      // is a reasonable place to be when the workflow pauses.
      if (input.view !== "runs-list" && input.view !== "phase-view") return false;
      if (input.runId === undefined) return false;
      return (input.pendingInterruptCount ?? 0) > 0;
    case "f":
      // ZONE_TIMETRAVEL: 'f' forks the selected run from a chosen
      // checkpoint. Available on runs-list when a run is selected,
      // regardless of state — forking a running run is fine (the
      // parent keeps running independently).
      if (input.view !== "runs-list") return false;
      return input.runId !== undefined;
    case "space":
      // P2-S6: Space toggles the peek panel for the selected run.
      // Read-only — enabled in any state, only on runs-list.
      if (input.view !== "runs-list") return false;
      return input.runId !== undefined;
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
  // P2-S7 — filter input mode short-circuits all other dispatch.
  if (input.view === "filter") {
    if (input.key === "Escape" || input.key === "ESC" || input.key === "\u001b") {
      return { kind: "filter-clear" };
    }
    if (
      input.key === "Enter" ||
      input.key === "RETURN" ||
      input.key === "\r" ||
      input.key === "\n"
    ) {
      return { kind: "filter-enter" };
    }
    if (input.key === "Backspace" || input.key === "\u007f" || input.key === "\b") {
      return { kind: "filter-backspace" };
    }
    // Printable ASCII (32–126) — single char only.
    if (input.key.length === 1) {
      const code = input.key.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        return { kind: "filter-append", char: input.key };
      }
    }
    return { kind: "noop", reason: "unknown-key" };
  }

  // P2-S7 — `/` enters filter mode from runs-list.
  if (input.key === "/" && input.view === "runs-list") {
    return { kind: "filter-enter" };
  }

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
      // Phase view: Esc returns to runs list. Slice 14 wires this.
      if (input.view === "phase-view") return { kind: "navigate-back" };
      // Agent detail (slice 15): Esc returns to phase view.
      return { kind: "navigate-back" };
  }

  // From here on, every key needs a selected run *or* operates on
  // overlay-level chrome. Universal-no-selection short-circuit.
  // Slice 11 (VQ-2): `g` (chord) and `G` (gc) are runs-list chrome
  // and don't require a selection.
  if (input.runId === undefined && k !== "g" && k !== "G") {
    return { kind: "noop", reason: "no-selection" };
  }

  if (k === "G") {
    if (input.view !== "runs-list") return { kind: "noop", reason: "disabled-for-state" };
    return { kind: "open-gc-dialog" };
  }

  if (k === "g") {
    // Slice 11 (VQ-2): `gg` chord. A second `g` within 300ms of the
    // first emits navigate-first; the first tap is a noop with reason
    // pending-g so the overlay can record chord state.
    if (input.view !== "runs-list") {
      return { kind: "noop", reason: "disabled-for-state" };
    }
    const at = input.pendingGAt ?? 0;
    if (input.pendingG === true && at > 0 && Date.now() - at < 300) {
      return { kind: "navigate-first" };
    }
    return { kind: "noop", reason: "pending-g" };
  }

  if (k === "enter" && input.view === "runs-list") {
    return {
      kind: "open-phase-view",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
  }

  if (k === "enter" && input.view === "phase-view") {
    // Slice 15: Enter on phase-view opens agent detail.
    return {
      kind: "open-agent-detail",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
  }

  // State-guarded actions — runId is now guaranteed non-undefined.
  const runId = input.runId!;

  switch (k) {
    case "p": {
      // Slice 11 (VQ-4): `p` only pauses; paused→resume moved to `u`.
      if (input.runState === "running")
        return { kind: "pause", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "u": {
      // Slice 11 (VQ-4): `u` resumes a paused run.
      if (input.runState === "paused")
        return { kind: "resume", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "x": {
      // Agent-level stop in phase-view when cursor is on a running agent.
      if (
        input.view === "phase-view" &&
        input.agentId !== undefined &&
        input.agentState === "running"
      ) {
        return { kind: "stop-agent", runId, agentId: input.agentId };
      }
      if (input.runState === "running" || input.runState === "paused")
        return { kind: "stop", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "r": {
      // Slice 11 (VQ-4): `r` no longer resumes paused runs — use `u`.
      // `r` fires `restart-requested` only on terminal states, or
      // `restart-agent` for a cursor-selected running agent.
      // F2: `r` (restart) is disabled on remote runs.
      if (input.isRemote) {
        return { kind: "noop", runId, reason: "disabled-for-remote" };
      }
      // Agent-level restart in phase-view when cursor is on a running agent.
      if (
        input.view === "phase-view" &&
        input.agentId !== undefined &&
        input.agentState === "running"
      ) {
        return { kind: "restart-agent", runId, agentId: input.agentId };
      }
      if (input.runState !== undefined && TERMINAL.has(input.runState))
        return { kind: "restart-requested", runId };
      return { kind: "noop", runId, reason: "disabled-for-state" };
    }
    case "s":
      // Slice 14: `s` on phase-view is enabled only for terminal
      // states per PRD §10.4. On runs-list it remains a no-op.
      // Slice 15 F2: `s` disabled on remote runs.
      if (input.view !== "phase-view") {
        return { kind: "noop", runId, reason: "disabled-for-state" };
      }
      if (input.isRemote) {
        return { kind: "noop", runId, reason: "disabled-for-remote" };
      }
      if (input.runState !== undefined && TERMINAL.has(input.runState)) {
        return { kind: "save-script-requested", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "t":
      // Slice 15: open transcript in $EDITOR — only agent-detail view.
      if (input.view === "agent-detail") {
        return { kind: "open-transcript", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "c":
      // Slice 15: copy prompt to clipboard — only agent-detail view.
      if (input.view === "agent-detail") {
        return { kind: "copy-prompt", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "v":
      // gap/viz: emit the Mermaid DAG. Available on runs-list and
      // phase-view; agent-detail's `c`/`t` already use the row, so we
      // keep the action scoped to where there's something to render.
      if (input.view === "runs-list" || input.view === "phase-view") {
        return { kind: "visualize-requested", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "i":
      // ZONE_HITL: answer the oldest pending interrupt.
      if (
        (input.view === "runs-list" || input.view === "phase-view") &&
        (input.pendingInterruptCount ?? 0) > 0
      ) {
        return { kind: "interrupt-answer-requested", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "f":
      // ZONE_TIMETRAVEL: open the fork dialog for this run.
      if (input.view === "runs-list") {
        return { kind: "fork-requested", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
    case "space":
      // P2-S6: peek panel toggle. Runs-list only — read-only,
      // enabled regardless of run state.
      if (input.view === "runs-list") {
        return { kind: "peek-toggle", runId };
      }
      return { kind: "noop", runId, reason: "disabled-for-state" };
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
  /** When an agent row is selected in phase-view, set its state for agent-level hints. */
  agentState?: "queued" | "running" | "done" | undefined,
  /**
   * ZONE_HITL TUI: count of pending interrupts on the selected run.
   * When > 0, the help line surfaces an enabled `i` bullet.
   */
  pendingInterruptCount?: number,
): HelpBullet[] {
  const dis = (
    key: string,
    label: string,
    disabled: boolean,
  ): HelpBullet => ({ key, label, disabled });
  const enabled = (key: string, label: string): HelpBullet =>
    dis(key, label, false);

  if (view !== "runs-list" && view !== "filter") {
    // Phase view (slice 14): full hotkey set.
    if (view === "phase-view") {
      const noSel = runState === undefined;
      const isRunning = runState === "running";
      const isPaused = runState === "paused";
      const isTerminal = runState !== undefined && TERMINAL.has(runState);
      const agentRunning = agentState === "running";
      return [
        enabled("↑↓ jk", "agents"),
        dis("Enter", "agent detail", noSel),
        // Slice 11 (VQ-4): p only pauses; u unpauses; r is terminal-only.
        dis("p", "pause", noSel || !isRunning),
        dis("u", "unpause", noSel || !isPaused),
        dis(
          "r",
          agentRunning ? "restart agent" : "restart",
          noSel || (!agentRunning && !isTerminal),
        ),
        dis("x", agentRunning ? "stop agent" : "stop", noSel || (!agentRunning && !isRunning && !isPaused)),
        dis("s", "save script", noSel || !isTerminal),
        dis("v", "viz", noSel),
        dis("i", "answer prompt (Esc=later)", noSel || (pendingInterruptCount ?? 0) === 0),
        enabled("Esc", "back"),
        enabled("?", "help"),
      ];
    }
    // Slice 15 (agent detail): transcript open + copy prompt.
    return [
      enabled("↑↓ jk", "scroll"),
      enabled("t", "open transcript"),
      enabled("c", "copy prompt"),
      enabled("Esc", "back"),
      enabled("?", "help"),
    ];
  }

  const noSel = runState === undefined;
  const isRunning = runState === "running";
  const isPaused = runState === "paused";
  const isTerminal = runState !== undefined && TERMINAL.has(runState);

  return [
    enabled("↑↓ jk", "navigate"),
    dis("Enter", "open run", noSel),
    // Slice 11 (VQ-4): p only pauses; u unpauses; r is terminal-only.
    dis("p", "pause", noSel || !isRunning),
    dis("u", "unpause", noSel || !isPaused),
    dis("x", "stop", noSel || (!isRunning && !isPaused)),
    dis("r", "restart", noSel || !isTerminal),
    dis("v", "viz", noSel),
    dis("i", "answer prompt (Esc=later)", noSel || (pendingInterruptCount ?? 0) === 0),
    dis("f", "fork", noSel),
    // Slice 11 (VQ-2): G opens GC; gg jumps to first row.
    enabled("G", "gc"),
    enabled("Esc", "close"),
    enabled("?", "help"),
  ];
}
