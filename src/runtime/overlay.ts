/**
 * pi-workflows — slice 13 TUI overlay framework.
 *
 * Mounts the `/workflows` overlay via `ctx.ui.custom`. Glue layer
 * binding three pure modules:
 *
 *   - `activeRuns.ts` (data) — Map of in-process Run handles + summary
 *     view subscribed to the appendEntry feed.
 *   - `hotkeys.ts`    (input) — state-guarded `(key, view, runState) →
 *     Action` dispatcher.
 *   - `runsList.ts`   (view)  — pure `(state) → string[]` render.
 *
 * Runtime responsibilities the orchestrator owns (all of these are
 * deliberately NOT in the pure modules so they can stay testable):
 *
 *   - Module-level `_overlayOpen` flag — `/workflows` is a no-op while
 *     already mounted (PRD §10.1).
 *   - 30-50ms requestRender debounce — rapid run-state churn from a
 *     1000-agent run won't redraw at line rate.
 *   - Non-TTY fallback (PRD §10.9): if `process.stdout.isTTY === false`,
 *     print the runs-list lines to chat via `pi.sendMessage` instead
 *     of mounting; the SDK/`pi -p` user sees the same data.
 *   - Keystroke routing: forwards every input to `dispatchHotkey`,
 *     then maps the returned Action to the appropriate side-effect
 *     (`run.pause()` / `run.stop()` / `appendEntry` / etc).
 *
 * Concern thread:
 *
 *   - **F2** — `/workflows kill` and the `x` hotkey BOTH funnel through
 *     `runKill()` below, which calls `registry.getRun(runId)?.stop("user-kill")`.
 *     The slice-11 stub appendEntry is preserved for cross-process
 *     awareness but is no longer load-bearing.
 *   - **F4** — `p` hotkey toggles between pause and resumePaused based
 *     on observed state via `dispatchHotkey`; the dispatcher returns
 *     either `kind: "pause"` or `kind: "resume"` so we don't second-
 *     guess state here.
 *   - **S8** — overlay subscribes to the in-process registry via
 *     `subscribe()`, NOT to ledger.jsonl file watching. The registry
 *     itself accepts appendEntry feed events through its `applyEntry`
 *     surface (called by `bindRegistryToFeed` below).
 *
 * Refs: PRD §10.1, §10.5, §10.6, §10.9, plan.md §4 Slice 13.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContextLike,
  TuiKeybindingsLike,
  TuiThemeLike,
  TuiInstanceLike,
  TuiComponentLike,
} from "../types/internal.js";
import {
  ActiveRunsRegistry,
  getActiveRuns,
  type RunFeedEntry,
  type RunSummary,
} from "./activeRuns.js";
import {
  dispatchHotkey,
  helpForState,
  type HotkeyAction,
  type OverlayView,
} from "./hotkeys.js";
import { renderRunsList } from "./runsList.js";
import {
  PhaseRegistry,
  getPhaseRegistry,
  type PhaseFeedEntry,
} from "./phaseRegistry.js";
import { renderPhaseView } from "./phaseView.js";
import { renderAgentDetail, type AgentDetailSnapshot } from "./agentDetail.js";
import { renderGcDialog, loadGcCandidates, applyGc, type GcDialogState } from "./gcDialog.js";
import { agentTranscriptPath } from "./transcriptOpen.js";

/** Module-level flag enforcing PRD §10.1's "second invocation is no-op". */
let _overlayOpen = false;

/** Test-only seam — reset the open flag between tests. */
export function __resetOverlayOpenForTest(): void {
  _overlayOpen = false;
}

/** Test/inspection seam — read the open flag without mutating. */
export function __isOverlayOpenForTest(): boolean {
  return _overlayOpen;
}

export interface MountOverlayOpts {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionCommandContextLike;
  readonly registry?: ActiveRunsRegistry;
  /** Slice 14 — phase registry (per-run state). Defaults to singleton. */
  readonly phaseRegistry?: PhaseRegistry;
  /** Render debounce window in ms (PRD §10.6 — defaults to 30). */
  readonly renderDebounceMs?: number;
  /** Test seam — `false` forces non-TTY path even when stdout is a TTY. */
  readonly forceTTY?: boolean | "auto";
  /** Test seam — explicit time source. Default `Date.now`. */
  readonly nowMs?: () => number;
  /** Test seam — capture overlay handle for stale-tick smoke. */
  readonly onMounted?: (api: OverlayHandleForTest) => void;
  /**
   * Slice 14 — callback fired when the user hits `r` (restart) on a
   * terminal run. Production wiring: `runtime/restart.ts`. The overlay
   * doesn't own the dispatch loop — it just signals intent.
   */
  readonly onRestartRequested?: (runId: string) => void | Promise<void>;
  /**
   * Slice 14 — callback fired when the user hits `s` (save) on a
   * terminal run. Production wiring: `runtime/saveScript.ts`. The
   * overlay doesn't own the file ops — it just signals intent.
   */
  readonly onSaveScriptRequested?: (runId: string) => void | Promise<void>;
  /**
   * Slice 15 — GC options forwarded to loadGcCandidates / applyGc.
   * Defaults to system GC settings.
   */
  readonly gcCutoffDays?: number;
  readonly gcRunsRootOverride?: string;
}

/** Test-only handle exposing internal overlay state for assertion. */
export interface OverlayHandleForTest {
  readonly close: () => void;
  readonly handleKey: (key: string) => void;
  readonly currentLines: () => string[];
  readonly currentSelection: () => string | undefined;
}

export interface MountResult {
  readonly mounted: boolean;
  readonly mode: "tui" | "non-tty" | "already-open" | "no-custom-api";
}

/**
 * **F3 / S8** — bind the registry to the appendEntry feed. Should be
 * called once at extension load (not per-overlay-mount). Wraps
 * `pi.appendEntry` so that emissions from this process also drive the
 * local registry. Cross-process feed (other windows' emissions) would
 * need a real pub/sub channel; this binding is the in-process
 * mirror that gets us 100% of the slice-13 acceptance.
 *
 * Slice 14 extends the binding to also drive the per-run
 * {@link PhaseRegistry} from `pi-workflows.phase.{started,ended}` and
 * `pi-workflows.agent.{started,ended}` events.
 */
export function bindRegistryToFeed(
  pi: ExtensionAPI,
  registry: ActiveRunsRegistry = getActiveRuns(),
  phaseRegistry: PhaseRegistry = getPhaseRegistry(),
): () => void {
  const original = pi.appendEntry;
  if (typeof original !== "function") {
    return () => undefined; // older pi build with no appendEntry — overlay still works without
  }
  // @ts-ignore -- runtime monkeypatch; we restore on dispose.
  pi.appendEntry = (customType: string, data?: unknown) => {
    try {
      original.call(pi, customType, data);
    } finally {
      // Apply to the registry on the SAME tick so the overlay's
      // listener observes both the host-side state and our local
      // registry update atomically.
      const entry = narrowEntry(customType, data);
      if (entry !== null) registry.applyEntry(entry);
      const phaseEntry = narrowPhaseEntry(customType, data);
      if (phaseEntry !== null) phaseRegistry.applyEntry(phaseEntry);
    }
  };
  return () => {
    // @ts-ignore -- restoring original
    pi.appendEntry = original;
  };
}

function narrowPhaseEntry(
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

function narrowEntry(customType: string, data: unknown): RunFeedEntry | null {
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
 * Public entry point. The slash-command handler awaits this; on success
 * it returns immediately (the overlay continues running until the user
 * presses Esc).
 */
export async function mountOverlay(
  opts: MountOverlayOpts,
): Promise<MountResult> {
  const registry = opts.registry ?? getActiveRuns();

  if (_overlayOpen) {
    return { mounted: false, mode: "already-open" };
  }

  // Non-TTY fallback per PRD §10.9: print runs-list to chat.
  const isTTY = (() => {
    if (opts.forceTTY === false) return false;
    if (opts.forceTTY === true) return true;
    return Boolean(process.stdout?.isTTY);
  })();

  const customApi = opts.ctx.ui.custom;
  if (!isTTY || typeof customApi !== "function") {
    // Render the list once, send as a sendMessage card.
    const view = renderRunsList(registry.listSummaries(), {
      ...(opts.nowMs ? { nowMs: opts.nowMs() } : {}),
      localRunIds: new Set(
        registry.listSummaries()
          .filter((s) => registry.hasHandle(s.runId))
          .map((s) => s.runId),
      ),
    });
    opts.pi.sendMessage(
      {
        customType: "pi-workflows.overlay-fallback",
        content: view.lines.join("\n"),
        display: true,
        details: { rows: view.rows.length, mode: "non-tty", slice: 13 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return {
      mounted: false,
      mode: typeof customApi !== "function" ? "no-custom-api" : "non-tty",
    };
  }

  _overlayOpen = true;
  // Fire-and-forget; the `custom` Promise resolves on `done()`.
  const factory: Parameters<typeof customApi>[0] = (
    tui,
    theme,
    kb,
    done,
  ) => makeOverlayComponent({
    tui: tui as unknown as TuiInstanceLike,
    theme: theme as unknown as TuiThemeLike,
    kb: kb as unknown as TuiKeybindingsLike,
    done: done as () => void,
    registry,
    phaseRegistry: opts.phaseRegistry ?? getPhaseRegistry(),
    pi: opts.pi,
    nowMs: opts.nowMs ?? Date.now,
    debounceMs: opts.renderDebounceMs ?? 30,
    onMounted: opts.onMounted,
    onRestartRequested: opts.onRestartRequested,
    onSaveScriptRequested: opts.onSaveScriptRequested,
    ...(opts.gcCutoffDays !== undefined ? { gcCutoffDays: opts.gcCutoffDays } : {}),
    ...(opts.gcRunsRootOverride !== undefined ? { gcRunsRootOverride: opts.gcRunsRootOverride } : {}),
  }) as unknown as TuiComponentLike;
  // The custom() return type is Promise<T>; we don't await — the user
  // closing the overlay is what resolves it.
  customApi(factory, { overlay: true })
    .catch(() => undefined)
    .finally(() => {
      _overlayOpen = false;
    });
  return { mounted: true, mode: "tui" };
}

interface OverlayComponentOpts {
  readonly tui: TuiInstanceLike;
  readonly theme: TuiThemeLike;
  readonly kb: TuiKeybindingsLike;
  readonly done: () => void;
  readonly registry: ActiveRunsRegistry;
  readonly phaseRegistry: PhaseRegistry;
  readonly pi: ExtensionAPI;
  readonly nowMs: () => number;
  readonly debounceMs: number;
  readonly onMounted?: ((api: OverlayHandleForTest) => void) | undefined;
  readonly onRestartRequested?:
    | ((runId: string) => void | Promise<void>)
    | undefined;
  readonly onSaveScriptRequested?:
    | ((runId: string) => void | Promise<void>)
    | undefined;
  readonly gcCutoffDays?: number;
  readonly gcRunsRootOverride?: string;
}

function makeOverlayComponent(opts: OverlayComponentOpts): TuiComponentLike {
  let view: OverlayView = "runs-list";
  let cursor = 0;
  let phaseCursor = 0;
  let openedRunId: string | undefined;
  // Slice 15: agent detail state
  let openedAgentId: string | undefined;
  let agentLogTail: string[] = [];
  let agentDetailDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Slice 15: GC dialog state
  let gcDialogState: GcDialogState | null = null;
  let gcBusy = false;
  let helpVisible = true;
  let banner: string | undefined;
  let lastSnapshot: ReadonlyArray<RunSummary> = opts.registry.listSummaries();

  const requestRender = () => {
    if (typeof opts.tui.requestRender === "function") opts.tui.requestRender();
  };

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedRender = () => {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      lastSnapshot = opts.registry.listSummaries();
      const sorted = sortAndClamp(lastSnapshot);
      if (cursor >= sorted.length) cursor = Math.max(0, sorted.length - 1);
      // BUG-073: clamp phaseCursor when the running-phase agent list shrinks.
      if (openedRunId !== undefined) {
        const snap = opts.phaseRegistry.getRunSnapshot(openedRunId);
        const visibleAgents =
          snap?.phases
            .filter((p) => p.status === "running")
            .flatMap((p) => p.agents).length ?? 0;
        if (phaseCursor >= visibleAgents) {
          phaseCursor = Math.max(0, visibleAgents - 1);
        }
      }
      requestRender();
    }, opts.debounceMs);
  };

  const unsub = opts.registry.subscribe(debouncedRender);
  const unsubPhase = opts.phaseRegistry.subscribe((rid) => {
    // Coalesce phase-view repaints through the same debounce.
    if ((view === "phase-view" || view === "agent-detail") && rid === openedRunId) {
      debouncedRender();
    }
  });

  // Slice 15: Intercept pi-workflows.agent.log to feed agentLogTail
  // when agent-detail is open. We wrap appendEntry locally in a thin
  // shim that peeks at agent.log events; this avoids re-wrapping the
  // bindRegistryToFeed wrapper.
  const originalAppendEntry = opts.pi.appendEntry;
  if (typeof originalAppendEntry === "function") {
    // @ts-ignore -- runtime shim
    opts.pi.appendEntry = (customType: string, data?: unknown) => {
      try {
        originalAppendEntry.call(opts.pi, customType, data);
      } finally {
        if (
          customType === "pi-workflows.agent.log" &&
          view === "agent-detail" &&
          data !== null &&
          typeof data === "object"
        ) {
          const d = data as Record<string, unknown>;
          if (
            typeof d.line === "string" &&
            d.runId === openedRunId &&
            d.agentId === openedAgentId
          ) {
            agentLogTail = [...agentLogTail, d.line].slice(-50);
            // Debounce per PRD §10.6 — 100ms per (runId, agentId).
            if (agentDetailDebounceTimer !== null) {
              clearTimeout(agentDetailDebounceTimer);
            }
            agentDetailDebounceTimer = setTimeout(() => {
              agentDetailDebounceTimer = null;
              requestRender();
            }, 100);
          }
        }
      }
    };
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (agentDetailDebounceTimer !== null) {
      clearTimeout(agentDetailDebounceTimer);
      agentDetailDebounceTimer = null;
    }
    // Restore the original appendEntry shim (slice 15 agent.log intercept).
    if (typeof originalAppendEntry === "function") {
      // @ts-ignore -- restoring original
      opts.pi.appendEntry = originalAppendEntry;
    }
    unsub();
    unsubPhase();
  };

  const close = () => {
    cleanup();
    try {
      opts.done();
    } catch {
      /* swallow — done() may throw on race with manual unmount */
    }
  };

  const buildRender = () => {
    // Slice 15: GC dialog takes priority when open.
    if (gcDialogState !== null) {
      return { lines: renderGcDialog(gcDialogState).lines };
    }

    // Slice 15: agent detail view.
    if (view === "agent-detail" && openedRunId !== undefined && openedAgentId !== undefined) {
      const summary = opts.registry.getSummary(openedRunId);
      const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
      // Find agent across all phases.
      let foundAgent = phaseSnap?.phases
        .flatMap((p) => p.agents)
        .find((a) => a.agentId === openedAgentId);
      if (foundAgent !== undefined) {
        const phaseName =
          phaseSnap?.phases.find((p) =>
            p.agents.some((a) => a.agentId === openedAgentId),
          )?.phaseName ?? "";
        const transcriptPath =
          summary?.runDir !== undefined
            ? agentTranscriptPath(summary.runDir, openedAgentId)
            : undefined;
        const snap: AgentDetailSnapshot = {
          runId: openedRunId,
          phaseName,
          agent: foundAgent,
          logTail: agentLogTail,
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        };
        const detailHelp = helpVisible ? helpForState("agent-detail", undefined) : [];
        const detailOpts: { nowMs?: number; help?: typeof detailHelp; banner?: string } = {
          nowMs: opts.nowMs(),
          help: detailHelp,
        };
        if (banner !== undefined) detailOpts.banner = banner;
        const rendered = renderAgentDetail(snap, detailOpts);
        return { lines: rendered.lines };
      }
      // Agent vanished — fall back to phase view.
      // BUG-074: use handleAction to clear all stale state atomically.
      handleAction({ kind: "navigate-back" });
    }

    if (view === "phase-view" && openedRunId !== undefined) {
      const summary = opts.registry.getSummary(openedRunId);
      if (summary !== undefined) {
        const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
        const help = helpVisible
          ? helpForState("phase-view", summary.state)
          : [];
        const opts2: Parameters<typeof renderPhaseView>[2] = {
          nowMs: opts.nowMs(),
          help,
        };
        if (banner !== undefined) (opts2 as { banner?: string }).banner = banner;
        if (
          phaseSnap !== undefined &&
          phaseCursor >= 0 &&
          phaseSnap.totalAgents > 0
        ) {
          (opts2 as { cursor?: number }).cursor = phaseCursor;
        }
        const rendered = renderPhaseView(summary, phaseSnap, opts2);
        return { lines: rendered.lines };
      }
      // Run vanished from registry — fall back to runs list.
      // BUG-074: use handleAction to clear openedRunId, phaseCursor, banner atomically.
      handleAction({ kind: "navigate-back" });
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const help = helpVisible ? helpForState(view, selected?.state) : [];
    const localIds = new Set(
      lastSnapshot.filter((s) => opts.registry.wasLocalRun(s.runId)).map((s) => s.runId),
    );
    return renderRunsList(sorted, {
      title: "pi-workflows  ·  /workflows overlay",
      nowMs: opts.nowMs(),
      ...(sorted.length > 0 ? { cursor } : {}),
      help,
      localRunIds: localIds,
    });
  };

  const handleAction = (action: HotkeyAction): void => {
    switch (action.kind) {
      case "navigate-up":
        if (view === "phase-view") {
          if (phaseCursor > 0) {
            phaseCursor--;
            requestRender();
          }
          return;
        }
        if (cursor > 0) {
          cursor--;
          requestRender();
        }
        return;
      case "navigate-down": {
        if (view === "phase-view") {
          if (openedRunId !== undefined) {
            const snap = opts.phaseRegistry.getRunSnapshot(openedRunId);
            // Only agents in the running phase are rendered as agentRows;
            // use that count as the bound, not totalAgents (all phases).
            const visibleAgents =
              snap?.phases
                .filter((p) => p.status === "running")
                .flatMap((p) => p.agents).length ?? 0;
            if (phaseCursor < Math.max(0, visibleAgents - 1)) {
              phaseCursor++;
              requestRender();
            }
          }
          return;
        }
        const sorted = sortAndClamp(lastSnapshot);
        if (cursor < sorted.length - 1) {
          cursor++;
          requestRender();
        }
        return;
      }
      case "navigate-back":
        // Agent detail (slice 15): Esc returns to phase view.
        if (view === "agent-detail") {
          view = "phase-view";
          openedAgentId = undefined;
          agentLogTail = [];
          banner = undefined;
          requestRender();
          return;
        }
        // Slice 14 — Esc on phase view returns to runs-list.
        if (view === "phase-view") {
          view = "runs-list";
          openedRunId = undefined;
          phaseCursor = 0;
          banner = undefined;
          requestRender();
          return;
        }
        return;
      case "toggle-help":
        helpVisible = !helpVisible;
        requestRender();
        return;
      case "close-overlay":
        close();
        return;
      case "open-phase-view":
        // Slice 14: actually open the phase view in this overlay.
        if (action.runId) {
          openedRunId = action.runId;
          view = "phase-view";
          phaseCursor = 0;
          banner = undefined;
          if (typeof opts.pi.appendEntry === "function") {
            try {
              opts.pi.appendEntry("pi-workflows.overlay.open-phase-view", {
                runId: action.runId,
              });
            } catch {
              /* swallow */
            }
          }
          requestRender();
        }
        return;
      case "open-agent-detail":
        // Slice 15: Enter on phase view opens agent detail for cursor-pointed agent.
        if (action.runId && openedRunId !== undefined) {
          const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
          // Index into only the running-phase agents — the same set that
          // renderPhaseView emits as agentRows — so cursor and target stay in sync.
          const agentEntry = phaseSnap?.phases
            .filter((p) => p.status === "running")
            .flatMap((p) => p.agents)
            .find((_, idx) => idx === phaseCursor);
          if (agentEntry !== undefined) {
            openedAgentId = agentEntry.agentId;
            agentLogTail = [];
            view = "agent-detail";
            banner = undefined;
            requestRender();
          }
        }
        return;
      case "pause": {
        if (!action.runId) return;
        const run = opts.registry.getRun(action.runId);
        if (run !== undefined) {
          run.pause("user-overlay").catch(() => undefined);
        }
        return;
      }
      case "resume": {
        if (!action.runId) return;
        const run = opts.registry.getRun(action.runId);
        if (run !== undefined) {
          run.resumePaused("user-overlay").catch(() => undefined);
        }
        return;
      }
      case "stop": {
        if (!action.runId) return;
        runKill(opts.pi, opts.registry, action.runId, "user-overlay");
        return;
      }
      case "restart-requested":
        // Slice 14: emit the appendEntry stub for cross-process awareness
        // AND fire the on-restart callback so the host can start a fresh run.
        if (action.runId) {
          if (typeof opts.pi.appendEntry === "function") {
            try {
              opts.pi.appendEntry("pi-workflows.overlay.restart-requested", {
                runId: action.runId,
              });
            } catch {
              /* swallow */
            }
          }
          if (opts.onRestartRequested !== undefined) {
            const runIdCopy = action.runId;
            Promise.resolve(opts.onRestartRequested(runIdCopy)).catch(() => undefined);
            banner = `restarting run ${shortenId(runIdCopy)}…`;
            requestRender();
          }
        }
        return;
      case "save-script-requested":
        if (action.runId && opts.onSaveScriptRequested !== undefined) {
          const runIdCopy = action.runId;
          Promise.resolve(opts.onSaveScriptRequested(runIdCopy)).catch(
            () => undefined,
          );
          banner = `saving script for run ${shortenId(runIdCopy)}…`;
          requestRender();
        } else if (action.runId) {
          banner = `save-script not wired (slice 14 callback missing)`;
          requestRender();
        }
        return;
      case "open-gc-dialog":
        if (typeof opts.pi.appendEntry === "function") {
          try {
            opts.pi.appendEntry("pi-workflows.overlay.gc-requested", {});
          } catch {
            /* swallow */
          }
        }
        // Slice 15: actually load candidates and show the dialog.
        if (!gcBusy) {
          gcBusy = true;
          const activeIds = new Set(
            lastSnapshot
              .filter((s) => s.state === "running" || s.state === "paused")
              .map((s) => s.runId),
          );
          loadGcCandidates({
            ...(opts.gcCutoffDays !== undefined ? { cutoffDays: opts.gcCutoffDays } : {}),
            ...(opts.gcRunsRootOverride !== undefined ? { runsRootOverride: opts.gcRunsRootOverride } : {}),
            activeRunIds: activeIds,
          })
            .then((result) => {
              gcDialogState = {
                candidates: result.candidates,
                skippedCount: result.skipped.length,
                totalScanned: result.scanned,
                cutoffDays: result.cutoffDays,
                confirming: false,
              };
              requestRender();
            })
            .catch(() => {
              banner = "gc: error loading candidates";
              requestRender();
            })
            .finally(() => {
              gcBusy = false;
            });
        }
        return;
      case "gc-apply":
        if (gcDialogState !== null && !gcBusy) {
          if (!gcDialogState.confirming) {
            gcDialogState = { ...gcDialogState, confirming: true };
            requestRender();
          } else {
            gcBusy = true;
            const toDelete = [...gcDialogState.candidates];
            applyGc(toDelete, {
              ...(opts.gcCutoffDays !== undefined ? { cutoffDays: opts.gcCutoffDays } : {}),
              ...(opts.gcRunsRootOverride !== undefined ? { runsRootOverride: opts.gcRunsRootOverride } : {}),
            })
              .then(({ deleted, errors }) => {
                gcDialogState = {
                  candidates: [],
                  skippedCount: gcDialogState?.skippedCount ?? 0,
                  totalScanned: gcDialogState?.totalScanned ?? 0,
                  cutoffDays: gcDialogState?.cutoffDays ?? 30,
                  confirming: false,
                  done: { deleted: deleted.length, errors: errors.length },
                };
                requestRender();
              })
              .catch(() => {
                banner = "gc: delete failed";
                gcDialogState = null;
                requestRender();
              })
              .finally(() => {
                gcBusy = false;
              });
          }
        }
        return;
      case "gc-cancel":
        gcDialogState = null;
        requestRender();
        return;
      case "open-transcript":
        // Slice 15: the overlay can't block for the editor; signal to
        // the banner and let the caller wire a real editor open.
        // Production: workflowCmd.ts wraps with openTranscriptInEditor.
        if (action.runId !== undefined && openedRunId !== undefined && openedAgentId !== undefined) {
          const summary = opts.registry.getSummary(openedRunId);
          const path = agentTranscriptPath(summary?.runDir, openedAgentId);
          banner = path !== undefined
            ? `transcript: ${path}`
            : "transcript: path unknown";
          requestRender();
        }
        return;
      case "copy-prompt":
        // Slice 15: banner with prompt text (clipboard wiring in workflowCmd.ts).
        if (openedRunId !== undefined && openedAgentId !== undefined) {
          const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
          const agent = phaseSnap?.phases
            .flatMap((p) => p.agents)
            .find((a) => a.agentId === openedAgentId);
          banner = agent?.summary
            ? `copied: ${agent.summary.slice(0, 60)}…`
            : "no prompt to copy";
          requestRender();
        }
        return;
      case "noop":
        // Intentional — disabled hotkey or no-selection. The help
        // line already conveys the disabled state visually.
        return;
    }
  };

  const handleKey = (key: string): void => {
    // Slice 15: GC dialog intercepts keys.
    if (gcDialogState !== null) {
      const k = key.toLowerCase();
      if (k === "y" || key === "Enter" || key === "RETURN" || key === "\r") {
        handleAction({ kind: "gc-apply" });
      } else if (k === "n" || key === "Escape" || key === "ESC" || key === "\u001b") {
        handleAction({ kind: "gc-cancel" });
      } else if (gcDialogState.done !== undefined) {
        // Any key closes the done screen.
        handleAction({ kind: "gc-cancel" });
      }
      return;
    }
    // Agent detail view.
    if (view === "agent-detail" && openedRunId !== undefined) {
      const action = dispatchHotkey({ key, view });
      handleAction(action);
      return;
    }
    if (view === "phase-view" && openedRunId !== undefined) {
      const summary = opts.registry.getSummary(openedRunId);
      const isRemote = !opts.registry.wasLocalRun(openedRunId);
      const action = dispatchHotkey({
        key,
        view,
        isRemote,
        ...(summary !== undefined
          ? { runState: summary.state, runId: openedRunId }
          : {}),
      });
      handleAction(action);
      return;
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const isRemote =
      selected !== undefined && !opts.registry.wasLocalRun(selected.runId);
    const action = dispatchHotkey({
      key,
      view,
      isRemote,
      ...(selected !== undefined
        ? { runState: selected.state, runId: selected.runId }
        : {}),
    });
    handleAction(action);
  };

  // Expose test handle.
  opts.onMounted?.({
    close,
    handleKey,
    currentLines: () => buildRender().lines,
    currentSelection: () =>
      sortAndClamp(lastSnapshot)[cursor]?.runId,
  });

  // Initial render so `tui` has lines to draw.
  void view; // mark used by closure

  // Component contract per pi-tui's `Component` interface.
  const component: TuiComponentLike = {
    render(_width: number): string[] {
      return buildRender().lines;
    },
    handleInput(data: string): void {
      handleKey(data);
    },
    invalidate(): void {
      requestRender();
    },
    dispose(): void {
      // pi-tui calls dispose() if the host tears down (forced unmount,
      // session end). Delegate to close() — not just cleanup() — so
      // opts.done() is also invoked and the customApi promise resolves,
      // triggering the .finally() handler that clears _overlayOpen.
      // Without this, _overlayOpen stays true forever and every
      // subsequent /workflows invocation returns { mode: 'already-open' }.
      // close() is idempotent via the `cleaned` flag in cleanup().
      close();
    },
  };
  return component;
}

function sortAndClamp(snap: ReadonlyArray<RunSummary>): RunSummary[] {
  // Use the same ordering as runsList for cursor-index stability.
  const view = renderRunsList(snap, { nowMs: 0 });
  const ids = new Map(view.rows.map((r, i) => [r.runId, i] as const));
  const sortedAll = [...snap].sort((a, b) => {
    const ia = ids.get(a.runId);
    const ib = ids.get(b.runId);
    if (ia === undefined || ib === undefined) return 0;
    return ia - ib;
  });
  return sortedAll;
}

function shortenId(runId: string): string {
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

/**
 * **F2** — kill a run by id. Both `/workflows kill <id>` and the `x`
 * hotkey route through here. Idempotent at the Run-handle level (the
 * Run's `stop()` is itself safe to call twice). Always emits an
 * appendEntry so cross-process windows observe the kill request.
 */
export function runKill(
  pi: ExtensionAPI,
  registry: ActiveRunsRegistry,
  runId: string,
  reason: string,
): { found: boolean; emittedEntry: boolean } {
  const run = registry.getRun(runId);
  let emittedEntry = false;
  if (typeof pi.appendEntry === "function") {
    try {
      pi.appendEntry("pi-workflows.run.kill-requested", { runId, reason });
      emittedEntry = true;
    } catch {
      /* swallow */
    }
  }
  if (run !== undefined) {
    try {
      run.stop(reason);
    } catch {
      /* swallow — Run.stop is idempotent */
    }
  }
  return { found: run !== undefined, emittedEntry };
}
