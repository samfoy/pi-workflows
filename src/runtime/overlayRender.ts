/**
 * pi-workflows — overlay render assembly.
 *
 * Extracted from `overlay.ts`. `buildRender` reads from
 * {@link OverlayInstanceState} + module-level HITL state and produces
 * the lines drawn by the TUI component. Pure: no side effects beyond
 * the navigate-back fallback when an opened run/agent vanishes from
 * the registry mid-render (delegated to `handleAction`).
 */

import {
  helpForState,
} from "./hotkeys.js";
import { renderRunsList } from "./runsList.js";
import { renderPhaseViewCards } from "./phaseView.js";
import { renderAgentDetail, type AgentDetailSnapshot } from "./agentDetail.js";
import { renderGcDialog } from "./gcDialog.js";
import { agentTranscriptPath } from "./transcriptOpen.js";
import {
  _pendingInterrupts,
  getGatePromptState,
  getSpinnerFrame,
  sortAndClamp,
  type OverlayInstanceState,
} from "./overlayState.js";
import { handleAction, type OverlayHelpers } from "./overlayActions.js";
import type { OverlayComponentOpts } from "./overlay.js";

export function buildRender(
  state: OverlayInstanceState,
  opts: OverlayComponentOpts,
  helpers: OverlayHelpers,
  width?: number,
): { lines: string[]; rows?: ReadonlyArray<{ runId: string; line: string; coloredLine: string }> } {
    // Slice 15: GC dialog takes priority when open.
    if (state.gcDialogState !== null) {
      return { lines: renderGcDialog(state.gcDialogState).lines };
    }

    // gap/ctx-gate: gate prompt takes priority over other views.
    // Slice 15 (I1): when the prompt was deferred via Esc, yield to
    // the underlying state.view so the user can navigate / press `x` to
    // stop / press `i` to re-open. The persistent banner reminds
    // them the gate is still pending.
    if (getGatePromptState() !== null && getGatePromptState()!.deferred !== true) {
      const dflt = getGatePromptState()!.defaultAnswer ? "Y/n" : "y/N";
      return {
        lines: [
          "",
          "  ⏸  Workflow paused — human approval required",
          "",
          `  ${getGatePromptState()!.message}`,
          "",
          `  [y] Approve    [n] Deny    [Esc] later    (default: ${dflt})`,
          "",
        ],
      };
    }

    // Compute the live banner text once per render so an expired
    // banner is dropped (and cleared from `banner`) atomically.
    const liveBannerText = helpers.liveBanner();

    // Slice 15: agent detail state.view.
    if (state.view === "agent-detail" && state.openedRunId !== undefined && state.openedAgentId !== undefined) {
      const summary = opts.registry.getSummary(state.openedRunId);
      const phaseSnap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
      // Find agent across all phases.
      let foundAgent = phaseSnap?.phases
        .flatMap((p) => p.agents)
        .find((a) => a.agentId === state.openedAgentId);
      if (foundAgent !== undefined) {
        const phaseName =
          phaseSnap?.phases.find((p) =>
            p.agents.some((a) => a.agentId === state.openedAgentId),
          )?.phaseName ?? "";
        const transcriptPath =
          summary?.runDir !== undefined
            ? agentTranscriptPath(summary.runDir, state.openedAgentId)
            : undefined;
        const snap: AgentDetailSnapshot = {
          runId: state.openedRunId,
          phaseName,
          agent: foundAgent,
          logTail: state.agentLogTail,
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        };
        const detailHelp = state.helpVisible ? helpForState("agent-detail", undefined) : [];
        const detailOpts: { nowMs?: number; width?: number; help?: typeof detailHelp; banner?: string; scrollOffset?: number; spinnerFrame?: number } = {
          nowMs: opts.nowMs(),
          help: detailHelp,
          // BUG-034: pass current scroll offset so log state.view respects j/k navigation.
          scrollOffset: state.agentLogScrollOffset,
          // P2-S3: thread the spinner frame through.
          spinnerFrame: getSpinnerFrame(),
        };
        if (width !== undefined) detailOpts.width = width;
        if (liveBannerText !== undefined) detailOpts.banner = liveBannerText;
        const rendered = renderAgentDetail(snap, detailOpts);
        return { lines: rendered.lines };
      }
      // Agent vanished — fall back to phase state.view.
      // BUG-074: use handleAction to clear all stale state atomically.
      handleAction({ kind: "navigate-back" }, state, opts, helpers);
      return { lines: [] };
    }

    if (state.view === "phase-view" && state.openedRunId !== undefined) {
      const summary = opts.registry.getSummary(state.openedRunId);
      if (summary !== undefined) {
        const phaseSnap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
        // P2-S9: cursor now indexes into phases[] (cards), not agentRows.
        // For context-sensitive help, resolve the cursor phase's first
        // running agent (or first agent of any state) to derive the
        // agentState used by the help line.
        const cursorPhase = phaseSnap?.phases[state.phaseCursor];
        const cursorPhaseAgent =
          cursorPhase?.agents.find((a) => a.state === "running") ??
          cursorPhase?.agents[0];
        const selectedAgentState = cursorPhaseAgent?.state;
        // Slice 15 (I1): include a deferred gate in the `i`-enable
        // count so the help line shows `[i] answer prompt` when only
        // a snoozed gate is outstanding (no pending interrupt list).
        const deferredGateHere =
          getGatePromptState() !== null &&
          getGatePromptState()!.deferred === true &&
          getGatePromptState()!.runId === state.openedRunId
            ? 1
            : 0;
        const phasePendingInterrupts =
          (_pendingInterrupts.get(state.openedRunId)?.length ?? 0) + deferredGateHere;
        const help = state.helpVisible
          ? helpForState(
              "phase-view",
              summary.state,
              selectedAgentState,
              phasePendingInterrupts,
            )
          : [];
        const opts2: Parameters<typeof renderPhaseViewCards>[2] = {
          nowMs: opts.nowMs(),
          help,
          // P2-S3: thread the spinner frame through to phase state.view.
          spinnerFrame: getSpinnerFrame(),
        };
        if (width !== undefined) (opts2 as { width?: number }).width = width;
        if (liveBannerText !== undefined) (opts2 as { banner?: string }).banner = liveBannerText;
        // P2-S9: cursor binds to phases[] now — use phases.length, not agentRows.
        if (
          phaseSnap !== undefined &&
          state.phaseCursor >= 0 &&
          phaseSnap.phases.length > 0
        ) {
          (opts2 as { cursor?: number }).cursor = state.phaseCursor;
        }
        const rendered = renderPhaseViewCards(summary, phaseSnap, opts2);
        return { lines: rendered.lines };
      }
      // Run vanished from registry — fall back to runs list.
      // BUG-074: use handleAction to clear state.openedRunId, state.phaseCursor, banner atomically.
      handleAction({ kind: "navigate-back" }, state, opts, helpers);
      return { lines: [] };
    }
    const sorted = sortAndClamp(state.lastSnapshot, {
      groupBy: "state",
      expandCompleted: state.expandCompleted,
    });
    const selected = sorted[state.cursor];
    // Slice 15 (I1): include a deferred gate in the `i`-enable count.
    const deferredGateForListSelected =
      selected !== undefined &&
      getGatePromptState() !== null &&
      getGatePromptState()!.deferred === true &&
      getGatePromptState()!.runId === selected.runId
        ? 1
        : 0;
    const selectedPendingInterrupts =
      (selected !== undefined
        ? _pendingInterrupts.get(selected.runId)?.length ?? 0
        : 0) + deferredGateForListSelected;
    const help = state.helpVisible
      ? helpForState(state.view, selected?.state, undefined, selectedPendingInterrupts)
      : [];
    const localIds = new Set(
      state.lastSnapshot.filter((s) => opts.registry.wasLocalRun(s.runId)).map((s) => s.runId),
    );
    // Build token totals from phase registry for the tokens column.
    const tokenTotals = new Map<string, number>();
    for (const s of sorted) {
      const phSnap = opts.phaseRegistry.getRunSnapshot(s.runId);
      if (phSnap !== undefined && phSnap.totalTokens > 0) {
        tokenTotals.set(s.runId, phSnap.totalTokens);
      }
    }
    const rendered = renderRunsList(sorted, {
      title: "pi-workflows  ·  /workflows overlay",
      nowMs: opts.nowMs(),
      ...(sorted.length > 0 ? { cursor: state.cursor } : {}),
      ...(width !== undefined ? { width } : {}),
      help,
      localRunIds: localIds,
      tokenTotals,
      // P2-S3: thread the spinner frame through to the runs list.
      spinnerFrame: getSpinnerFrame(),
      // P2-S4: state grouping is the default for the live overlay.
      groupBy: "state",
      expandCompleted: state.expandCompleted,
      // P2-S7: thread filter text when in filter mode.
      ...(state.filterMode ? { filterText: state.filterText } : {}),
      // P2-S6: thread peek panel when active.
      ...(state.peekRunId !== undefined
        ? { peekRunId: state.peekRunId, peekLines: state.peekLines }
        : {}),
    });
    // VQ-1 — swap plain `row.line` entries in `lines[]` for their
    // ANSI-colored equivalents so state labels render with color in
    // the TTY overlay. `lines[]` from renderRunsList is plain by
    // contract; we rebuild it here for the TTY render path. The
    // non-TTY fallback above (`view.lines.join("\n")`) keeps using
    // the plain `lines[]`.
    const byPlain = new Map<string, string>();
    for (const r of rendered.rows) byPlain.set(r.line, r.coloredLine);
    const ttyLines = rendered.lines.map((ln) => byPlain.get(ln) ?? ln);
    return { ...rendered, lines: ttyLines };
  }
