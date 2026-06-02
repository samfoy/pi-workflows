/**
 * pi-workflows — overlay action dispatcher and key router.
 *
 * Extracted from `overlay.ts`. `handleAction` maps a {@link HotkeyAction}
 * (returned by `dispatchHotkey`) to side effects against the registry,
 * phase registry, and host callbacks. `handleKey` is the full key
 * pipeline: GC-dialog / filter / gate-prompt intercepts before calling
 * `dispatchHotkey` and forwarding to `handleAction`.
 *
 * Design notes:
 *   - All per-mount state is reachable via the `state` struct
 *     ({@link OverlayInstanceState}).
 *   - Side effects (render, banner, close) live behind
 *     {@link OverlayHelpers} so callers can swap implementations
 *     (e.g. test seams, smoke harnesses).
 *   - Module-level HITL state ({@link _pendingInterrupts},
 *     gate-prompt) lives in `overlayState.ts`.
 */

import type { ExtensionAPI } from "../types/internal.js";
import type { ActiveRunsRegistry } from "./activeRuns.js";
import { isTerminalState } from "./activeRuns.js";
import {
  dispatchHotkey,
  type HotkeyAction,
} from "./hotkeys.js";
import { renderAgentDetail, MAX_LOG_LINES as AGENT_DETAIL_MAX_LOG_LINES } from "./agentDetail.js";
import { loadGcCandidates, applyGc } from "./gcDialog.js";
import { agentTranscriptPath } from "./transcriptOpen.js";
import type { PhaseRegistry } from "./phaseRegistry.js";
import { readPeekLines } from "./peek.js";
import {
  _pendingInterrupts,
  DEFAULT_BANNER_TTL_MS,
  getGatePromptState,
  setGatePromptState,
  shortenId,
  sortAndClamp,
  type OverlayInstanceState,
  type PendingInterruptPayload,
  type InterruptAnswerResult,
} from "./overlayState.js";
import type { OverlayComponentOpts } from "./overlay.js";

export interface OverlayHelpers {
  requestRender: () => void;
  setBanner: (text: string, ttl?: number) => void;
  clearBanner: () => void;
  close: () => void;
  liveBanner: () => string | undefined;
}

/** P2-S4 — cap on visible Completed rows when collapsed. Mirrors
 * `runsList.ts:COMPLETED_COLLAPSED_LIMIT` so the overlay knows when
 * a `… N more` sentinel is being rendered without re-running the
 * full layout pass. */
const COMPLETED_COLLAPSED_LIMIT = 3;

/**
 * P2-S4 — returns true when the runs-list is rendering a
 * `… N more` sentinel below the Completed section. Used by
 * `navigate-down` to extend the cursor's max position by 1, and by
 * `open-phase-view` (Enter) to detect when the cursor is on the
 * sentinel and toggle `expandCompleted` instead of opening a run.
 */
function hasMoreSentinel(state: OverlayInstanceState): boolean {
  if (state.view !== "runs-list") return false;
  if (state.expandCompleted) return false;
  let completed = 0;
  for (const s of state.lastSnapshot) {
    if (isTerminalState(s.state)) completed++;
    if (completed > COMPLETED_COLLAPSED_LIMIT) return true;
  }
  return false;
}

/**
 * **F2** — kill a run by id. Both `/workflows kill <id>` and the `x`
 * hotkey route through here. Idempotent at the Run-handle level.
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


export function handleAction(
  action: HotkeyAction,
  state: OverlayInstanceState,
  opts: OverlayComponentOpts,
  helpers: OverlayHelpers,
): void {
    switch (action.kind) {
      case "navigate-up":
        // BUG-034: scroll the log in agent-detail, don't mutate runs-list state.cursor.
        if (state.view === "agent-detail") {
          const maxOffset = Math.max(0, state.agentLogTail.length - AGENT_DETAIL_MAX_LOG_LINES);
          if (state.agentLogScrollOffset < maxOffset) {
            state.agentLogScrollOffset++;
            helpers.requestRender();
          }
          return;
        }
        if (state.view === "phase-view") {
          if (state.phaseCursor > 0) {
            state.phaseCursor--;
            helpers.requestRender();
          }
          return;
        }
        if (state.cursor > 0) {
          state.cursor--;
          helpers.requestRender();
        }
        return;
      case "navigate-down": {
        // BUG-034: scroll the log in agent-detail, don't mutate runs-list state.cursor.
        if (state.view === "agent-detail") {
          if (state.agentLogScrollOffset > 0) {
            state.agentLogScrollOffset--;
            helpers.requestRender();
          }
          return;
        }
        if (state.view === "phase-view") {
          if (state.openedRunId !== undefined) {
            const snap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
            // P2-S9: cursor indexes phases[] (cards), not running-agent rows.
            const phaseCount = snap?.phases.length ?? 0;
            if (state.phaseCursor < Math.max(0, phaseCount - 1)) {
              state.phaseCursor++;
              helpers.requestRender();
            }
          }
          return;
        }
        const sorted = sortAndClamp(state.lastSnapshot, {
          groupBy: "state",
          expandCompleted: state.expandCompleted,
        });
        // P2-S4: when the Completed section is collapsed and there
        // are hidden completed runs, the cursor may land on the
        // `… N more` sentinel (one past the last visible row).
        const maxCursor = sorted.length - 1 + (hasMoreSentinel(state) ? 1 : 0);
        if (state.cursor < maxCursor) {
          state.cursor++;
          helpers.requestRender();
        }
        return;
      }
      case "navigate-first":
        // Slice 11 (VQ-2): `gg` chord — jump state.cursor to the first row.
        if (state.view === "phase-view") {
          if (state.phaseCursor !== 0) {
            state.phaseCursor = 0;
            helpers.requestRender();
          }
          return;
        }
        if (state.view === "runs-list") {
          if (state.cursor !== 0) {
            state.cursor = 0;
            helpers.requestRender();
          }
        }
        return;
      case "navigate-back":
        // Agent detail (slice 15): Esc returns to phase state.view.
        if (state.view === "agent-detail") {
          // BUG-124: clear pending debounce so it doesn't fire after transition.
          if (state.agentDetailDebounceTimer !== null) {
            clearTimeout(state.agentDetailDebounceTimer);
            state.agentDetailDebounceTimer = null;
          }
          state.view = "phase-view";
          state.openedAgentId = undefined;
          state.agentLogTail = [];
          // BUG-034: reset scroll offset when leaving agent-detail.
          state.agentLogScrollOffset = 0;
          helpers.clearBanner();
          helpers.requestRender();
          return;
        }
        // Slice 14 — Esc on phase state.view returns to runs-list.
        if (state.view === "phase-view") {
          state.view = "runs-list";
          state.openedRunId = undefined;
          state.phaseCursor = 0;
          helpers.clearBanner();
          helpers.requestRender();
          return;
        }
        return;
      case "toggle-help":
        state.helpVisible = !state.helpVisible;
        helpers.requestRender();
        return;
      // P2-S7 — filter mode actions.
      case "filter-enter":
        if (state.view === "filter") {
          // Lock filter — exit text-input mode, stay in runs-list.
          state.filterMode = false;
          state.view = "runs-list";
        } else {
          state.filterMode = true;
          state.filterText = "";
          state.view = "filter";
        }
        helpers.requestRender();
        return;
      case "filter-append":
        if (action.char !== undefined) {
          state.filterText += action.char;
          helpers.requestRender();
        }
        return;
      case "filter-backspace":
        if (state.filterText.length > 0) {
          state.filterText = state.filterText.slice(0, -1);
          helpers.requestRender();
        }
        return;
      case "filter-clear":
        state.filterText = "";
        state.filterMode = false;
        if (state.view === "filter") state.view = "runs-list";
        helpers.requestRender();
        return;
      // P2-S6 — peek panel toggle. Sticky: cursor navigation does
      // NOT clear the peek; only a second Space on the same row
      // closes it, and Space on a different row replaces it.
      case "peek-toggle": {
        const targetRunId = action.runId;
        if (targetRunId === undefined) return;
        if (state.peekRunId === targetRunId) {
          // Toggle off.
          state.peekRunId = undefined;
          state.peekLines = [];
          helpers.requestRender();
          return;
        }
        const summary = opts.registry.getSummary(targetRunId);
        const dir = summary?.runDir;
        const lines = dir !== undefined ? readPeekLines(dir, 5) : [];
        state.peekRunId = targetRunId;
        state.peekLines = lines;
        helpers.requestRender();
        return;
      }
      case "close-overlay":
        helpers.close();
        return;
      case "open-phase-view":
        // P2-S4: Enter on the `… N more` sentinel toggles the
        // collapsed Completed section. Detect by `runId === undefined`
        // (no run under the cursor) AND `state.cursor === sorted.length`
        // (one past the last visible row) AND a sentinel actually
        // being rendered. Without all three, fall through to the
        // existing no-op-on-undefined behavior.
        if (action.runId === undefined && state.view === "runs-list" && hasMoreSentinel(state)) {
          const sorted = sortAndClamp(state.lastSnapshot, {
            groupBy: "state",
            expandCompleted: state.expandCompleted,
          });
          if (state.cursor === sorted.length) {
            state.expandCompleted = !state.expandCompleted;
            helpers.requestRender();
            return;
          }
        }
        // Slice 14: actually open the phase state.view in this overlay.
        if (action.runId) {
          state.openedRunId = action.runId;
          state.view = "phase-view";
          state.phaseCursor = 0;
          helpers.clearBanner();
          if (typeof opts.pi.appendEntry === "function") {
            try {
              opts.pi.appendEntry("pi-workflows.overlay.open-phase-view", {
                runId: action.runId,
              });
            } catch {
              /* swallow */
            }
          }
          helpers.requestRender();
        }
        return;
      case "open-agent-detail":
        // P2-S9: cursor indexes phases[] now. Resolve the cursor phase's
        // first running agent (or first agent of any state) and drill in.
        // Pending phases / phases with no agents = no-op.
        if (action.runId && state.openedRunId !== undefined) {
          const phaseSnap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
          const cursorPhase = phaseSnap?.phases[state.phaseCursor];
          if (cursorPhase !== undefined && cursorPhase.status !== "pending") {
            const agentEntry =
              cursorPhase.agents.find((a) => a.state === "running") ??
              cursorPhase.agents[0];
            if (agentEntry !== undefined) {
              state.openedAgentId = agentEntry.agentId;
              state.agentLogTail = [];
              state.view = "agent-detail";
              helpers.clearBanner();
              helpers.requestRender();
            }
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
      case "stop-agent": {
        if (!action.runId || !action.agentId) return;
        opts.onStopAgent?.(action.runId, action.agentId);
        helpers.setBanner(`stopping agent ${action.agentId.slice(0, 12)}…`);
        helpers.requestRender();
        return;
      }
      case "restart-agent": {
        if (!action.runId || !action.agentId) return;
        opts.onRestartAgent?.(action.runId, action.agentId);
        helpers.setBanner(`restarting agent ${action.agentId.slice(0, 12)}…`);
        helpers.requestRender();
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
            helpers.setBanner(`restarting run ${shortenId(runIdCopy)}…`);
            helpers.requestRender();
          }
        }
        return;
      case "save-script-requested":
        if (action.runId && opts.onSaveScriptRequested !== undefined) {
          const runIdCopy = action.runId;
          Promise.resolve(opts.onSaveScriptRequested(runIdCopy)).catch(
            () => undefined,
          );
          helpers.setBanner(`saving script for run ${shortenId(runIdCopy)}…`);
          helpers.requestRender();
        } else if (action.runId) {
          // No callback wired — surface a clear, time-limited message
          // rather than a stub literal. Production callers always wire
          // `onSaveScriptRequested` (see workflowCmd.ts).
          helpers.setBanner("save-script: no handler wired");
          helpers.requestRender();
        }
        return;
      case "visualize-requested":
        if (action.runId && opts.onVisualizeRequested !== undefined) {
          const runIdCopy = action.runId;
          helpers.setBanner(`rendering DAG for run ${shortenId(runIdCopy)}…`);
          helpers.requestRender();
          Promise.resolve(opts.onVisualizeRequested(runIdCopy))
            .then((target) => {
              if (typeof target === "string" && target.length > 0) {
                // Long banner TTL so the user has time to copy the path.
                helpers.setBanner(`viz → ${target}`, 8000);
                helpers.requestRender();
              }
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              helpers.setBanner(`viz failed: ${msg}`);
              helpers.requestRender();
            });
        } else if (action.runId) {
          helpers.setBanner("viz: no handler wired");
          helpers.requestRender();
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
        if (!state.gcBusy) {
          state.gcBusy = true;
          // BUG-121: query live registry instead of stale state.lastSnapshot so
          // runs started after the last debounce cycle are protected.
          const activeIds = new Set(
            opts.registry.listSummaries()
              .filter((s) => s.state === "running" || s.state === "paused")
              .map((s) => s.runId),
          );
          loadGcCandidates({
            ...(opts.gcCutoffDays !== undefined ? { cutoffDays: opts.gcCutoffDays } : {}),
            ...(opts.gcRunsRootOverride !== undefined ? { runsRootOverride: opts.gcRunsRootOverride } : {}),
            activeRunIds: activeIds,
          })
            .then((result) => {
              state.gcDialogState = {
                candidates: result.candidates,
                skippedCount: result.skipped.length,
                totalScanned: result.scanned,
                cutoffDays: result.cutoffDays,
                confirming: false,
              };
              helpers.requestRender();
            })
            .catch(() => {
              helpers.setBanner("gc: error loading candidates");
              helpers.requestRender();
            })
            .finally(() => {
              state.gcBusy = false;
            });
        }
        return;
      case "gc-apply":
        if (state.gcDialogState !== null && !state.gcBusy) {
          if (!state.gcDialogState.confirming) {
            state.gcDialogState = { ...state.gcDialogState, confirming: true };
            helpers.requestRender();
          } else {
            state.gcBusy = true;
            const toDelete = [...state.gcDialogState.candidates];
            // BUG-036: re-query active run IDs fresh at confirmation time
            // so any run resumed/retried since dialog-open is protected.
            const freshActiveIds = new Set(
              opts.registry.listSummaries()
                .filter((s) => s.state === "running" || s.state === "paused")
                .map((s) => s.runId),
            );
            applyGc(toDelete, {
              ...(opts.gcCutoffDays !== undefined ? { cutoffDays: opts.gcCutoffDays } : {}),
              ...(opts.gcRunsRootOverride !== undefined ? { runsRootOverride: opts.gcRunsRootOverride } : {}),
              activeRunIds: freshActiveIds,
            })
              .then(({ deleted, errors }) => {
                state.gcDialogState = {
                  candidates: [],
                  skippedCount: state.gcDialogState?.skippedCount ?? 0,
                  totalScanned: state.gcDialogState?.totalScanned ?? 0,
                  cutoffDays: state.gcDialogState?.cutoffDays ?? 30,
                  confirming: false,
                  done: { deleted: deleted.length, errors: errors.length },
                };
                helpers.requestRender();
              })
              .catch(() => {
                helpers.setBanner("gc: delete failed");
                state.gcDialogState = null;
                helpers.requestRender();
              })
              .finally(() => {
                state.gcBusy = false;
              });
          }
        }
        return;
      case "gc-cancel":
        state.gcDialogState = null;
        helpers.requestRender();
        return;
      case "open-transcript":
        // The overlay computes the transcript path and delegates the
        // actual open to the host-supplied `onOpenTranscript` callback
        // (production wiring: `openTranscriptInEditor` in workflowCmd.ts).
        // The callback returns the banner text to surface; if it isn't
        // wired we still show the path so the user can `tail -f` it.
        if (action.runId !== undefined && state.openedRunId !== undefined && state.openedAgentId !== undefined) {
          const summary = opts.registry.getSummary(state.openedRunId);
          const path = agentTranscriptPath(summary?.runDir, state.openedAgentId);
          if (path === undefined) {
            helpers.setBanner("transcript: path unknown");
          } else if (opts.onOpenTranscript !== undefined) {
            const msg = opts.onOpenTranscript(path);
            helpers.setBanner(msg ?? `transcript: ${path}`);
          } else {
            helpers.setBanner(`transcript: ${path}`);
          }
          helpers.requestRender();
        }
        return;
      case "copy-prompt":
        // The overlay extracts the prompt text from the phase snapshot
        // and delegates the clipboard write to `onCopyPrompt` (production
        // wiring: `copyToClipboard` in workflowCmd.ts). No more fake
        // "copied:" stub — the callback's return value tells us whether
        // the copy actually succeeded.
        if (state.openedRunId !== undefined && state.openedAgentId !== undefined) {
          const phaseSnap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
          const agent = phaseSnap?.phases
            .flatMap((p) => p.agents)
            .find((a) => a.agentId === state.openedAgentId);
          const promptText = agent?.summary;
          if (promptText === undefined || promptText.length === 0) {
            helpers.setBanner("no prompt to copy");
          } else if (opts.onCopyPrompt !== undefined) {
            const msg = opts.onCopyPrompt(promptText);
            helpers.setBanner(msg ?? "clipboard: no handler wired");
          } else {
            helpers.setBanner("clipboard: no handler wired");
          }
          helpers.requestRender();
        }
        return;
      case "interrupt-answer-requested": {
        // ZONE_HITL TUI: dispatch the oldest pending interrupt for the
        // run to the host callback. The callback owns the actual
        // ctx.ui.input/select prompting; the overlay just hands off
        // the payload + runId. We pop the entry optimistically here
        // so a second `i` press doesn't try the same one while the
        // modal is open.
        //
        // Slice 15 (I1): `i` also re-opens a deferred gate prompt
        // (getGatePromptState()!.deferred === true). Re-opening just
        // clears the deferred flag and re-renders; the modal
        // intercept handler picks up subsequent y/n/Esc presses.
        //
        // Slice 16 (I2): when the host returns `{ outcome: "snoozed" }`
        // — e.g. the operator dismissed the modal with `Esc`, no
        // `default` was available, no `respondInterrupt` was called —
        // we **restore** the payload to the head of the FIFO so the
        // run isn't wedged in a dead state. A subsequent `i` press
        // re-runs the same prompt; `x` still stops the run.
        if (!action.runId) return;
        // Slice 15 (I1): re-open a deferred gate prompt for this run.
        if (
          getGatePromptState() !== null &&
          getGatePromptState()!.deferred === true &&
          getGatePromptState()!.runId === action.runId
        ) {
          setGatePromptState({ ...getGatePromptState()!, deferred: false });
          helpers.requestRender();
          return;
        }
        const list = _pendingInterrupts.get(action.runId);
        const payload = list && list.length > 0 ? list[0] : undefined;
        if (payload === undefined) {
          helpers.setBanner("no pending interrupt to answer");
          helpers.requestRender();
          return;
        }
        if (opts.onInterruptAnswerRequested === undefined) {
          helpers.setBanner("interrupt: no handler wired");
          helpers.requestRender();
          return;
        }
        const runIdCopy = action.runId;
        (list as NonNullable<typeof list>).splice(0, 1); // pop optimistically so a second `i` press skips this entry
        helpers.setBanner(
          `answering interrupt ${payload.key} on ${shortenId(runIdCopy)}\u2026`,
        );
        helpers.requestRender();
        const restorePayload = (): void => {
          // Re-attach to the head of the FIFO. Use the live list
          // reference if it still exists; otherwise re-create.
          const cur = _pendingInterrupts.get(runIdCopy);
          if (cur === undefined) {
            _pendingInterrupts.set(runIdCopy, [payload]);
          } else if (!cur.some((e) => e.key === payload.key)) {
            // Idempotent restore: the runtime may have re-emitted the
            // request via `interrupt.requested` while we were prompting;
            // dedupe on key to avoid double-stacking the same entry.
            cur.unshift(payload);
          }
          helpers.requestRender();
        };
        Promise.resolve(
          opts.onInterruptAnswerRequested(runIdCopy, payload),
        )
          .then((result) => {
            // Slice 16 (I2): support the `{ outcome, banner }` shape.
            // Bare string or undefined preserves legacy semantics
            // (treated as resolved — no restore).
            let outcome: "resolved" | "snoozed" | "cancelled" = "resolved";
            let bannerText: string | undefined;
            if (typeof result === "string") {
              bannerText = result;
            } else if (result !== undefined && result !== null) {
              outcome = result.outcome ?? "resolved";
              bannerText = result.banner;
            }
            if (outcome === "snoozed" || outcome === "cancelled") {
              restorePayload();
            }
            if (typeof bannerText === "string" && bannerText.length > 0) {
              helpers.setBanner(bannerText);
              helpers.requestRender();
            }
          })
          .catch((err: unknown) => {
            // Slice 16 (I2): a thrown prompt is the same dead-state
            // hazard as a dismissed prompt — restore the payload so
            // the run can still be answered.
            restorePayload();
            const msg = err instanceof Error ? err.message : String(err);
            helpers.setBanner(`interrupt failed: ${msg} — [i] retry, [x] stop`);
            helpers.requestRender();
          });
        return;
      }
      case "fork-requested": {
        // ZONE_TIMETRAVEL TUI: hand off to the host's fork dialog
        // (workflowCmd.ts wires the multi-step prompt: select phase,
        // input overrides JSON, call forkFromCheckpoint). The
        // callback returns a banner string with the new runId on
        // success or an error message on failure.
        if (!action.runId) return;
        if (opts.onForkRequested === undefined) {
          helpers.setBanner("fork: no handler wired");
          helpers.requestRender();
          return;
        }
        const runIdCopy = action.runId;
        helpers.setBanner(`opening fork dialog for ${shortenId(runIdCopy)}…`);
        helpers.requestRender();
        Promise.resolve(opts.onForkRequested(runIdCopy))
          .then((banner) => {
            if (typeof banner === "string" && banner.length > 0) {
              // Forks may produce long banners ("forked: wf-xxxxxxxx");
              // give the user time to read.
              helpers.setBanner(banner, 8000);
              helpers.requestRender();
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            helpers.setBanner(`fork failed: ${msg}`);
            helpers.requestRender();
          });
        return;
      }
      case "noop":
        // Intentional — disabled hotkey or no-selection. The help
        // line already conveys the disabled state visually.
        // Exception: remote runs silently reject r/s — show a toast
        // so the user knows why nothing happened.
        if (action.reason === "disabled-for-remote") {
          helpers.setBanner("operation requires a local run (r/s unavailable on remote sessions)");
          helpers.requestRender();
        }
        // Slice 11 (VQ-2): first `g` of a `gg` chord — record state so
        // the next `g` within 300ms emits navigate-first. The caller
        // path (handleKey) already cleared state.pendingG before dispatch;
        // we set it here only for the pending-g reason.
        if (action.reason === "pending-g") {
          state.pendingG = true;
          state.pendingGAt = Date.now();
        }
        return;
    }
  }

export function handleKey(
  key: string,
  state: OverlayInstanceState,
  opts: OverlayComponentOpts,
  helpers: OverlayHelpers,
): void {
    // Slice 15: GC dialog intercepts keys.
    if (state.gcDialogState !== null) {
      const k = key.toLowerCase();
      if (state.gcDialogState.done !== undefined) {
        // Done screen: any key closes it (BUG-076: must be checked before y/Enter).
        handleAction({ kind: "gc-cancel" }, state, opts, helpers);
      } else if (k === "y" || key === "Enter" || key === "RETURN" || key === "\r" || key === "\n") {
        handleAction({ kind: "gc-apply" }, state, opts, helpers);
      } else if (k === "n" || key === "Escape" || key === "ESC" || key === "\u001b") {
        handleAction({ kind: "gc-cancel" }, state, opts, helpers);
      }
      return;
    }
    // P2-S7 — filter input mode intercepts all keys; route directly
    // to the dispatcher with state.view='filter'.
    if (state.view === "filter") {
      const action = dispatchHotkey({ key, view: "filter" });
      handleAction(action, state, opts, helpers);
      return;
    }
    // gap/ctx-gate: gate prompt intercepts keys when a gate is pending
    // AND the prompt is currently visible. When the operator has
    // deferred (Esc) the prompt, fall through so they can navigate +
    // press `i` to re-open or `x` to stop the run (Slice 15 / I1).
    if (getGatePromptState() !== null && getGatePromptState()!.deferred !== true) {
      const k = key.toLowerCase();
      const g = getGatePromptState()!;
      const run = opts.registry.getRun(g.runId);
      if (k === "y" || key === "Enter" || key === "RETURN" || key === "\r" || key === "\n") {
        // Y or Enter → approve (Enter uses defaultAnswer).
        const approved = k === "n" ? false : (k === "y" ? true : g.defaultAnswer);
        setGatePromptState(null);
        run?.respondGate(approved);
      } else if (k === "n") {
        // Slice 15 (I1): only `n` is an explicit deny; `Esc` no
        // longer routes to deny — see the snooze branch below.
        setGatePromptState(null);
        run?.respondGate(false);
      } else if (key === "Escape" || key === "ESC" || key === "\u001b") {
        // Slice 15 (I1): Esc = snooze. Hide the modal but leave the
        // gate unresolved. The persistent banner cues the operator
        // to press `i` to re-open or `x` to stop. The workflow
        // keeps blocking on `respondGate` until they decide.
        setGatePromptState({ ...g, deferred: true });
        helpers.setBanner(
          "gate snoozed — [i] to re-open, [x] to stop run",
          DEFAULT_BANNER_TTL_MS * 4,
        );
      }
      helpers.requestRender();
      return;
    }
    // Agent detail state.view.
    if (state.view === "agent-detail" && state.openedRunId !== undefined) {
      // Slice 11 (VQ-2): snapshot+clear chord state per keypress; the
      // dispatcher consumes the snapshot and the noop handler re-arms
      // state.pendingG when it sees reason=pending-g.
      const wasPendingG = state.pendingG;
      const wasPendingGAt = state.pendingGAt;
      state.pendingG = false;
      state.pendingGAt = 0;
      const action = dispatchHotkey({
        key,
        view: state.view,
        pendingG: wasPendingG,
        pendingGAt: wasPendingGAt,
      });
      handleAction(action, state, opts, helpers);
      return;
    }
    if (state.view === "phase-view" && state.openedRunId !== undefined) {
      const summary = opts.registry.getSummary(state.openedRunId);
      const isRemote = !opts.registry.wasLocalRun(state.openedRunId);
      // P2-S9: cursor indexes phases[]. The agent under the cursor for
      // per-agent hotkeys (s/r) is the cursor phase's first running
      // agent (or first agent of any state).
      const phaseSnapForKey = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
      const cursorPhaseForKey = phaseSnapForKey?.phases[state.phaseCursor];
      const selectedAgent =
        cursorPhaseForKey?.agents.find((a) => a.state === "running") ??
        cursorPhaseForKey?.agents[0];
      // Slice 15 (I1): a deferred gate prompt also enables `i` (re-open).
      const deferredGateForOpened =
        getGatePromptState() !== null &&
        getGatePromptState()!.deferred === true &&
        getGatePromptState()!.runId === state.openedRunId
          ? 1
          : 0;
      const pendingCount =
        (_pendingInterrupts.get(state.openedRunId)?.length ?? 0) +
        deferredGateForOpened;
      // Slice 11 (VQ-2): snapshot+clear chord state per keypress.
      const wasPendingG = state.pendingG;
      const wasPendingGAt = state.pendingGAt;
      state.pendingG = false;
      state.pendingGAt = 0;
      const action = dispatchHotkey({
        key,
        view: state.view,
        isRemote,
        pendingInterruptCount: pendingCount,
        pendingG: wasPendingG,
        pendingGAt: wasPendingGAt,
        ...(summary !== undefined
          ? { runState: summary.state, runId: state.openedRunId }
          : {}),
        ...(selectedAgent !== undefined
          ? { agentId: selectedAgent.agentId, agentState: selectedAgent.state }
          : {}),
      });
      handleAction(action, state, opts, helpers);
      return;
    }
    const sorted = sortAndClamp(state.lastSnapshot, {
      groupBy: "state",
      expandCompleted: state.expandCompleted,
    });
    const selected = sorted[state.cursor];
    const isRemote =
      selected !== undefined && !opts.registry.wasLocalRun(selected.runId);
    // Slice 15 (I1): a deferred gate prompt also enables `i` (re-open).
    const deferredGateForSelected =
      selected !== undefined &&
      getGatePromptState() !== null &&
      getGatePromptState()!.deferred === true &&
      getGatePromptState()!.runId === selected.runId
        ? 1
        : 0;
    const selectedPendingCount =
      (selected !== undefined
        ? _pendingInterrupts.get(selected.runId)?.length ?? 0
        : 0) + deferredGateForSelected;
    // Slice 11 (VQ-2): snapshot+clear chord state per keypress.
    const wasPendingG = state.pendingG;
    const wasPendingGAt = state.pendingGAt;
    state.pendingG = false;
    state.pendingGAt = 0;
    const action = dispatchHotkey({
      key,
      view: state.view,
      isRemote,
      pendingInterruptCount: selectedPendingCount,
      pendingG: wasPendingG,
      pendingGAt: wasPendingGAt,
      ...(selected !== undefined
        ? { runState: selected.state, runId: selected.runId }
        : {}),
    });
    handleAction(action, state, opts, helpers);
  }
