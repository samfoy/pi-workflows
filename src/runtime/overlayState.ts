/**
 * pi-workflows — overlay state primitives.
 *
 * Extracted from `overlay.ts` to keep the orchestrator focused on
 * mount/lifecycle. This module owns:
 *
 *   - Per-mount state (`OverlayInstanceState`) — the mutable struct
 *     threaded through render and action handlers.
 *   - Module-level HITL state that survives overlay close/reopen
 *     (`_pendingInterrupts`, `_gatePromptState`, `_spinnerFrame`).
 *   - Pure helpers (`sortAndClamp`, `shortenId`).
 *   - Ledger-feed narrowers (`narrowEntry`, `narrowPhaseEntry`) plus
 *     the IPC ledger writer (`appendEntryToLedger`) used by
 *     `bindRegistryToFeed`.
 *   - `applyOverlayEvent` — the appendEntry shim body that updates
 *     overlay state from `pi-workflows.*` events.
 *
 * The interface deviates from the spec'd field list in two ways:
 *   - Adds phaseCursor, openedAgentId, agentLogTail,
 *     agentLogScrollOffset, agentDetailDebounceTimer, gcDialogState,
 *     gcBusy, lastSnapshot — these are mutated by handlers and would
 *     otherwise need closure access.
 *   - Omits bannerText/bannerExpiresAt — banner state is owned by
 *     the `setBanner`/`liveBanner` helper closures (kept in
 *     overlay.ts), reached via `OverlayHelpers`.
 */

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  ActiveRunsRegistry,
  type RunFeedEntry,
  type RunSummary,
} from "./activeRuns.js";
import type { OverlayView } from "./hotkeys.js";
import { renderRunsList } from "./runsList.js";
import type { PhaseFeedEntry } from "./phaseRegistry.js";
import type { GcDialogState } from "./gcDialog.js";

/**
 * ZONE_HITL TUI surface — payload an `interrupt_requested` carries
 * forward to the overlay's interrupt-answer callback.
 */
export interface PendingInterruptPayload {
  readonly key: string;
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly default?: unknown;
}

/**
 * Slice 15/16 (I1+I2) — result of an interrupt-answer prompt
 * dispatched by the overlay to the host. Bare string / undefined
 * preserves legacy semantics.
 */
export type InterruptAnswerResult =
  | string
  | undefined
  | {
      readonly banner?: string;
      readonly outcome?: "resolved" | "snoozed" | "cancelled";
    };

/**
 * Per-mount overlay state, threaded as a single struct through render
 * and action handlers so they can stay top-level functions.
 */
export interface OverlayInstanceState {
  cursor: number;
  view: OverlayView;
  phaseCursor: number;
  pendingG: boolean;
  pendingGAt: number;
  openedRunId: string | undefined;
  openedAgentId: string | undefined;
  agentLogTail: string[];
  agentLogScrollOffset: number;
  agentDetailDebounceTimer: ReturnType<typeof setTimeout> | null;
  gcDialogState: GcDialogState | null;
  gcBusy: boolean;
  helpVisible: boolean;
  filterMode: boolean;
  filterText: string;
  /**
   * P2-S4 — when `true`, the runs-list Completed section renders
   * every terminal run; when `false` (default) it caps at 3 with a
   * `… N more` sentinel. Toggled by Enter on the sentinel row.
   */
  expandCompleted: boolean;
  lastSnapshot: ReadonlyArray<RunSummary>;
}

export function makeOverlayState(initialSnapshot: ReadonlyArray<RunSummary>): OverlayInstanceState {
  return {
    cursor: 0,
    view: "runs-list",
    phaseCursor: 0,
    pendingG: false,
    pendingGAt: 0,
    openedRunId: undefined,
    openedAgentId: undefined,
    agentLogTail: [],
    agentLogScrollOffset: 0,
    agentDetailDebounceTimer: null,
    gcDialogState: null,
    gcBusy: false,
    helpVisible: true,
    filterMode: false,
    filterText: "",
    expandCompleted: false,
    lastSnapshot: initialSnapshot,
  };
}

/**
 * Module-level HITL state — survives overlay close/reopen so a closed
 * overlay doesn't drop the "operator must answer" signal.
 */
export const _pendingInterrupts: Map<string, PendingInterruptPayload[]> = new Map();

export type GatePromptState = {
  runId: string;
  message: string;
  defaultAnswer: boolean;
  deferred?: boolean;
};

// Module-level — exported via getter/setter so consumers can mutate.
let _gatePromptState: GatePromptState | null = null;
export function getGatePromptState(): GatePromptState | null {
  return _gatePromptState;
}
export function setGatePromptState(s: GatePromptState | null): void {
  _gatePromptState = s;
}

let _spinnerFrame = 0;
export function getSpinnerFrame(): number {
  return _spinnerFrame;
}
export function tickSpinnerFrame(): void {
  _spinnerFrame = (_spinnerFrame + 1) % 10;
}
export function resetSpinnerFrame(): void {
  _spinnerFrame = 0;
}

/** Test seam — clears all module-level state. */
export function _resetModuleState(): void {
  _pendingInterrupts.clear();
  _gatePromptState = null;
  _spinnerFrame = 0;
}

/** Default banner TTL — 4s. */
export const DEFAULT_BANNER_TTL_MS = 4000;

/**
 * Sort the snapshot the same way `runsList.ts` does so cursor
 * indexing matches the rendered view.
 *
 * P2-S4: when `groupBy: 'state'` is passed, `renderRunsList` groups
 * runs into Needs-input/Working/Completed sections and may collapse
 * the Completed bucket to 3 entries with a `… N more` sentinel below.
 * Threading the same opts here keeps `state.cursor` indexing aligned
 * with what the user sees — the visible runs come first (in render
 * order), then any collapsed Completed runs (in their would-be
 * render order, so they re-appear in place when expanded).
 */
export function sortAndClamp(
  snap: ReadonlyArray<RunSummary>,
  opts: { readonly groupBy?: "state" | "time"; readonly expandCompleted?: boolean } = {},
): RunSummary[] {
  const view = renderRunsList(snap, { nowMs: 0, ...opts });
  const ids = new Map(view.rows.map((r, i) => [r.runId, i] as const));
  const sortedAll = [...snap].sort((a, b) => {
    const ia = ids.get(a.runId);
    const ib = ids.get(b.runId);
    if (ia === undefined || ib === undefined) return 0;
    return ia - ib;
  });
  return sortedAll;
}

/** Trim a runId to its `wf-XXXXXXXX` prefix for log/banner display. */
export function shortenId(runId: string): string {
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

/**
 * Narrow a `pi-workflows.*` ledger event to a {@link PhaseFeedEntry}
 * the {@link PhaseRegistry} can consume. Returns `null` for
 * unrecognised customTypes / shapes.
 */
export function narrowPhaseEntry(
  customType: string,
  data: unknown,
): PhaseFeedEntry | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== "string") return null;
  switch (customType) {
    case "pi-workflows.meta.phases":
      if (!Array.isArray(d.phases)) return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    case "pi-workflows.phase.started":
      if (typeof d.phaseName !== "string" || typeof d.agentCount !== "number")
        return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    case "pi-workflows.phase.ended":
      if (typeof d.phaseName !== "string") return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    case "pi-workflows.agent.started":
      if (typeof d.phaseName !== "string" || typeof d.agentId !== "string")
        return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    case "pi-workflows.agent.ended":
      if (typeof d.phaseName !== "string" || typeof d.agentId !== "string")
        return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    case "pi-workflows.run.log":
      if (typeof d.message !== "string") return null;
      return { customType, data: d as never } as PhaseFeedEntry;
    default:
      return null;
  }
}

export function narrowEntry(customType: string, data: unknown): RunFeedEntry | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== "string") return null;
  switch (customType) {
    case "pi-workflows.run.started":
      return {
        customType,
        data: d as RunFeedEntry["data"] & {
          runId: string;
          workflowName: string;
        },
      } as RunFeedEntry;
    case "pi-workflows.run.transitioned":
      if (typeof d.toState !== "string") return null;
      return { customType, data: d as never } as RunFeedEntry;
    case "pi-workflows.run.ended":
      if (typeof d.outcome !== "string") return null;
      return { customType, data: d as never } as RunFeedEntry;
    case "pi-workflows.run.kill-requested":
      return { customType, data: d as never } as RunFeedEntry;
    default:
      return null;
  }
}

/**
 * IPC inspection surface: write a `pi.appendEntry` event as an
 * `"appendEntry"` ledger entry to the run's `ledger.jsonl`.
 *
 * Sync + fsync so a supervisor polling the file sees the entry
 * immediately. All errors swallowed — a filesystem hiccup must
 * never disrupt a running workflow.
 */
export function appendEntryToLedger(
  customType: string,
  data: unknown,
  registry: ActiveRunsRegistry,
): void {
  const d = data as Record<string, unknown> | null | undefined;
  if (typeof d?.runId !== "string") return;
  const runId = d.runId;
  const summary = registry.getSummary(runId);
  const dir = summary?.runDir ?? null;
  if (!dir) return;
  const line =
    JSON.stringify({
      type: "appendEntry",
      at: new Date().toISOString(),
      customType,
      data: d,
    }) + "\n";
  try {
    const fd = openSync(join(dir, "ledger.jsonl"), "a", 0o644);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch { /* best-effort */ }
}

/**
 * Local appendEntry shim body — peeks at agent.log / gate / interrupt
 * events to keep overlay state fresh. Mutates `state` and the
 * module-level HITL state. Calls helpers.requestRender / setBanner so
 * the live view reflects updates.
 */
export interface ApplyOverlayEventHelpers {
  requestRender: () => void;
}

export function applyOverlayEvent(
  state: OverlayInstanceState,
  customType: string,
  data: unknown,
  helpers: ApplyOverlayEventHelpers,
): void {
  if (
    customType === "pi-workflows.agent.log" &&
    state.view === "agent-detail" &&
    data !== null &&
    typeof data === "object"
  ) {
    const d = data as Record<string, unknown>;
    if (
      typeof d.line === "string" &&
      d.runId === state.openedRunId &&
      d.agentId === state.openedAgentId
    ) {
      state.agentLogTail = [...state.agentLogTail, d.line].slice(-50);
      // Debounce per PRD §10.6 — 100ms per (runId, agentId).
      if (state.agentDetailDebounceTimer !== null) {
        clearTimeout(state.agentDetailDebounceTimer);
      }
      state.agentDetailDebounceTimer = setTimeout(() => {
        state.agentDetailDebounceTimer = null;
        helpers.requestRender();
      }, 100);
    }
  }
  // gap/ctx-gate: track pending gate prompts.
  if (
    customType === "pi-workflows.gate.requested" &&
    data !== null &&
    typeof data === "object"
  ) {
    const d = data as Record<string, unknown>;
    if (typeof d.runId === "string" && typeof d.message === "string") {
      setGatePromptState({
        runId: d.runId,
        message: d.message,
        defaultAnswer: d.defaultAnswer !== false,
      });
      helpers.requestRender();
    }
  }
  if (customType === "pi-workflows.gate.resolved") {
    setGatePromptState(null);
    helpers.requestRender();
  }
  // ZONE_HITL TUI: track pending ctx.interrupt() requests per run.
  if (
    customType === "pi-workflows.interrupt.requested" &&
    data !== null &&
    typeof data === "object"
  ) {
    const d = data as Record<string, unknown>;
    if (typeof d.runId === "string" && typeof d.key === "string") {
      const list = _pendingInterrupts.get(d.runId) ?? [];
      const payload: PendingInterruptPayload = {
        key: d.key,
        question:
          typeof d.question === "string" ? d.question : "(no question)",
        ...(Array.isArray(d.choices)
          ? { choices: d.choices.filter((c): c is string => typeof c === "string") }
          : {}),
        ...("default" in d ? { default: d.default } : {}),
      };
      // Idempotent: dedupe on key (re-emits during resume don't double-up).
      if (!list.some((e) => e.key === payload.key)) {
        list.push(payload);
        _pendingInterrupts.set(d.runId, list);
        helpers.requestRender();
      }
    }
  }
  if (
    customType === "pi-workflows.interrupt.resolved" &&
    data !== null &&
    typeof data === "object"
  ) {
    const d = data as Record<string, unknown>;
    if (typeof d.runId === "string" && typeof d.key === "string") {
      const list = _pendingInterrupts.get(d.runId);
      if (list !== undefined) {
        const idx = list.findIndex((e) => e.key === d.key);
        if (idx >= 0) {
          list.splice(idx, 1);
          if (list.length === 0) _pendingInterrupts.delete(d.runId);
          else _pendingInterrupts.set(d.runId, list);
          helpers.requestRender();
        }
      }
    }
  }
}
