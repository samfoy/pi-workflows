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

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
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
import { renderAgentDetail, MAX_LOG_LINES as AGENT_DETAIL_MAX_LOG_LINES, type AgentDetailSnapshot } from "./agentDetail.js";
import { renderGcDialog, loadGcCandidates, applyGc, type GcDialogState } from "./gcDialog.js";
import { agentTranscriptPath } from "./transcriptOpen.js";

/** Module-level flag enforcing PRD §10.1's "second invocation is no-op". */
let _overlayOpen = false;

/**
 * Default banner TTL — 4s feels long enough to read a one-line toast
 * but short enough that a stale banner doesn't read as a stuck UI.
 * Per gap analysis 2026-05-31 ("Banner state has no TTL").
 */
const DEFAULT_BANNER_TTL_MS = 4000;

/** Test-only seam — reset the open flag between tests. */
export function __resetOverlayOpenForTest(): void {
  _overlayOpen = false;
}

/** Test/inspection seam — read the open flag without mutating. */
export function __isOverlayOpenForTest(): boolean {
  return _overlayOpen;
}

/**
 * Test-only seam: pure ledger-narrowing helpers used by the overlay's
 * appendEntry shim. Exported so unit tests can probe the validation
 * matrix (runId required, per-customType field shapes) without
 * mounting the full TUI.
 *
 * Production callers should NOT depend on this surface; the underscore
 * prefix marks it as unstable.
 */
export const __narrowForTest = {
  narrowEntry: (customType: string, data: unknown) => narrowEntry(customType, data),
  narrowPhaseEntry: (customType: string, data: unknown) =>
    narrowPhaseEntry(customType, data),
  shortenId: (runId: string) => shortenId(runId),
};

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
   * gap/viz — callback fired when the user hits `v` (visualize) on a
   * selected run. Receives the runId; the host wires this to
   * `runtime/visualize.ts::writeMermaidToTmp` and surfaces the
   * resulting `.mmd` path back to the user via a card / banner.
   * The overlay just signals intent.
   */
  readonly onVisualizeRequested?: (runId: string) => Promise<string | undefined> | string | undefined;
  /**
   * Per-agent stop: called when the user hits `x` on a selected running
   * agent in phase-view. The overlay doesn't own abort logic — it just
   * signals intent to the Run handle.
   */
  readonly onStopAgent?: (runId: string, agentId: string) => void;
  /**
   * Per-agent restart: called when the user hits `r` on a selected running
   * agent in phase-view. The overlay doesn't own dispatch logic — it just
   * signals intent to the Run handle.
   */
  readonly onRestartAgent?: (runId: string, agentId: string) => void;
  /**
   * Hotkey `t` (open transcript) on agent-detail. Receives the absolute
   * transcript path; returns the banner text to display (e.g. "opened in
   * vim" or an error message). Production wiring: workflowCmd.ts wraps
   * with `openTranscriptInEditor` from `runtime/transcriptOpen.ts`.
   */
  readonly onOpenTranscript?: (transcriptPath: string) => string | undefined;
  /**
   * Hotkey `c` (copy prompt) on agent-detail. Receives the prompt text
   * the overlay extracted; returns the banner text to display (e.g.
   * "copied via pbcopy" or fallback). Production wiring: workflowCmd.ts
   * wraps with `copyToClipboard` from `runtime/transcriptOpen.ts`.
   */
  readonly onCopyPrompt?: (text: string) => string | undefined;
  /**
   * ZONE_HITL TUI surface — hotkey `i` (answer pending interrupt) on
   * runs-list / phase-view. Receives the runId plus the pending
   * interrupt payload (question/choices/default and key). The host
   * is responsible for prompting the operator (typically through
   * `pi.ui.input` or `pi.ui.select`) and calling
   * `Run.respondInterrupt(value, key)` with the answer. Returns the
   * banner text to display (e.g. "interrupt resolved" or an error).
   * The overlay does NOT own the prompt UI — keeping the prompt out
   * of the render loop avoids re-entrancy with `ctx.ui.custom`.
   */
  readonly onInterruptAnswerRequested?: (
    runId: string,
    payload: PendingInterruptPayload,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * ZONE_TIMETRAVEL TUI surface — hotkey `f` (fork from checkpoint)
   * on runs-list. Receives the parent runId. The host is responsible
   * for prompting for atPhase + overrides JSON and calling
   * `forkFromCheckpoint(...)`. Returns the banner text to display
   * (e.g. "fork started: <new runId>" or an error).
   */
  readonly onForkRequested?: (
    runId: string,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Slice 15 — GC options forwarded to loadGcCandidates / applyGc.
   * Defaults to system GC settings.
   */
  readonly gcCutoffDays?: number;
  readonly gcRunsRootOverride?: string;
  /**
   * Stale-PID sweep options (B6). Forwarded to `registry.sweepStalePids()`
   * on every mount so stuck `running` rows are cleaned up immediately.
   * Provide `isAlive` + `manifestPathFn` overrides in tests to avoid
   * real filesystem / PID-space access.
   */
  readonly stalePidOpts?: {
    readonly isAlive?: (opts: { parentPid: number; parentBootId: string }) => boolean;
    readonly manifestPathFn?: (runId: string) => string;
  };
}

/**
 * ZONE_HITL TUI surface — the payload an `interrupt_requested`
 * appendEntry carries forward to the overlay's interrupt-answer
 * callback. The overlay tracks one entry per (runId, key) pair and
 * passes the OLDEST pending entry to the callback when the operator
 * presses `i`.
 */
export interface PendingInterruptPayload {
  readonly key: string;
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly default?: unknown;
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
 * IPC inspection surface: write a `pi.appendEntry` event as an
 * `"appendEntry"` ledger entry to the run's `ledger.jsonl`.
 *
 * Only events whose payload contains a `runId` string are routed; all
 * others are silently skipped (we can't know which run's ledger to
 * target). The write is synchronous + fsynced to guarantee the entry is
 * visible to a supervisor that polls the file immediately after.
 *
 * All errors are swallowed — a filesystem hiccup must never disrupt a
 * running workflow. Called from the `bindRegistryToFeed` shim so that
 * the registry's `applyEntry()` (which sets `runDir` on the summary)
 * has already run before we look up the path.
 */
function appendEntryToLedger(
  customType: string,
  data: unknown,
  registry: ActiveRunsRegistry,
): void {
  const d = data as Record<string, unknown> | null | undefined;
  if (typeof d?.runId !== "string") return;
  const runId = d.runId;
  // Prefer the registry's runDir (set by run.started); fall back to
  // the standard path derivation so events that arrive before the
  // summary is populated still land in the right file.
  const summary = registry.getSummary(runId);
  const dir = summary?.runDir ?? null;
  if (!dir) return; // no runDir yet — skip (run.started not seen)
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
      // IPC inspection surface: also write the appendEntry event to
      // the run's ledger.jsonl so a supervisor can observe all events
      // by tailing a single file. Only events with a `runId` payload
      // field are routed to a run's ledger.
      if (customType.startsWith("pi-workflows.")) {
        appendEntryToLedger(customType, data, registry);
      }
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

  // Stale-PID sweep (B6): coerce stuck `running` rows to `failed` when
  // the parent pi-process is no longer alive. Display-layer only — no
  // ledger mutation. Runs synchronously so the first render already
  // shows the corrected state.
  registry.sweepStalePids(opts.stalePidOpts);

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
    onVisualizeRequested: opts.onVisualizeRequested,
    onStopAgent: opts.onStopAgent,
    onRestartAgent: opts.onRestartAgent,
    onOpenTranscript: opts.onOpenTranscript,
    onCopyPrompt: opts.onCopyPrompt,
    onInterruptAnswerRequested: opts.onInterruptAnswerRequested,
    onForkRequested: opts.onForkRequested,
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
  readonly onVisualizeRequested?:
    | ((runId: string) => Promise<string | undefined> | string | undefined)
    | undefined;
  readonly onStopAgent?: ((runId: string, agentId: string) => void) | undefined;
  readonly onRestartAgent?: ((runId: string, agentId: string) => void) | undefined;
  readonly onOpenTranscript?: ((transcriptPath: string) => string | undefined) | undefined;
  readonly onCopyPrompt?: ((text: string) => string | undefined) | undefined;
  readonly onInterruptAnswerRequested?:
    | ((
        runId: string,
        payload: PendingInterruptPayload,
      ) => Promise<string | undefined> | string | undefined)
    | undefined;
  readonly onForkRequested?:
    | ((runId: string) => Promise<string | undefined> | string | undefined)
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
  // BUG-034: scroll offset for the agent-detail log view (0 = newest).
  let agentLogScrollOffset = 0;
  // Slice 15: GC dialog state
  let gcDialogState: GcDialogState | null = null;
  let gcBusy = false;
  let helpVisible = true;
  /**
   * Banner state — ephemeral one-line message rendered under the
   * subtitle. `expiresAtMs` is wall-clock per `opts.nowMs()`. The
   * render path drops the banner when `nowMs() >= expiresAtMs`, and a
   * `setTimeout(_, ttl)` schedules a redraw at expiry so the banner
   * disappears even when no other event triggers a render.
   */
  type BannerState = { text: string; expiresAtMs: number };
  let banner: BannerState | undefined;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  const setBanner = (text: string, ttlMs: number = DEFAULT_BANNER_TTL_MS): void => {
    banner = { text, expiresAtMs: opts.nowMs() + ttlMs };
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    // +5ms slack so a render that runs at exactly expiresAtMs sees an
    // expired banner rather than a freshly-set one.
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      requestRender();
    }, ttlMs + 5);
  };
  /** Returns the banner text iff still live; clears expired state. */
  const liveBanner = (): string | undefined => {
    if (banner === undefined) return undefined;
    if (opts.nowMs() < banner.expiresAtMs) return banner.text;
    banner = undefined;
    return undefined;
  };
  let lastSnapshot: ReadonlyArray<RunSummary> = opts.registry.listSummaries();
  // gap/ctx-gate: pending gate prompt state.
  let gatePromptState: { runId: string; message: string; defaultAnswer: boolean } | null = null;
  // ZONE_HITL TUI: per-run FIFO of pending interrupts. Driven by
  // intercepted appendEntry events (interrupt.requested / .resolved
  // emitted by runCtx::interruptFn). Cleared per (runId, key) on
  // resolution. Drives the help-line `i` enable bit and the answer
  // dispatch payload.
  const pendingInterrupts: Map<string, PendingInterruptPayload[]> = new Map();

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
        // gap/ctx-gate: track pending gate prompts.
        if (customType === "pi-workflows.gate.requested" &&
          data !== null && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (typeof d.runId === "string" && typeof d.message === "string") {
            gatePromptState = {
              runId: d.runId,
              message: d.message,
              defaultAnswer: d.defaultAnswer !== false,
            };
            requestRender();
          }
        }
        if (customType === "pi-workflows.gate.resolved") {
          gatePromptState = null;
          requestRender();
        }
        // ZONE_HITL TUI: track pending ctx.interrupt() requests per run.
        if (
          customType === "pi-workflows.interrupt.requested" &&
          data !== null &&
          typeof data === "object"
        ) {
          const d = data as Record<string, unknown>;
          if (typeof d.runId === "string" && typeof d.key === "string") {
            const list = pendingInterrupts.get(d.runId) ?? [];
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
              pendingInterrupts.set(d.runId, list);
              requestRender();
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
            const list = pendingInterrupts.get(d.runId);
            if (list !== undefined) {
              const idx = list.findIndex((e) => e.key === d.key);
              if (idx >= 0) {
                list.splice(idx, 1);
                if (list.length === 0) pendingInterrupts.delete(d.runId);
                else pendingInterrupts.set(d.runId, list);
                requestRender();
              }
            }
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
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
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

  const buildRender = (width?: number) => {
    // Slice 15: GC dialog takes priority when open.
    if (gcDialogState !== null) {
      return { lines: renderGcDialog(gcDialogState).lines };
    }

    // gap/ctx-gate: gate prompt takes priority over other views.
    if (gatePromptState !== null) {
      const dflt = gatePromptState.defaultAnswer ? "Y/n" : "y/N";
      return {
        lines: [
          "",
          "  ⏸  Workflow paused — human approval required",
          "",
          `  ${gatePromptState.message}`,
          "",
          `  [y] Approve    [n] Deny    (default: ${dflt})`,
          "",
        ],
      };
    }

    // Compute the live banner text once per render so an expired
    // banner is dropped (and cleared from `banner`) atomically.
    const liveBannerText = liveBanner();

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
        const detailOpts: { nowMs?: number; width?: number; help?: typeof detailHelp; banner?: string; scrollOffset?: number } = {
          nowMs: opts.nowMs(),
          help: detailHelp,
          // BUG-034: pass current scroll offset so log view respects j/k navigation.
          scrollOffset: agentLogScrollOffset,
        };
        if (width !== undefined) detailOpts.width = width;
        if (liveBannerText !== undefined) detailOpts.banner = liveBannerText;
        const rendered = renderAgentDetail(snap, detailOpts);
        return { lines: rendered.lines };
      }
      // Agent vanished — fall back to phase view.
      // BUG-074: use handleAction to clear all stale state atomically.
      handleAction({ kind: "navigate-back" });
      return { lines: [] };
    }

    if (view === "phase-view" && openedRunId !== undefined) {
      const summary = opts.registry.getSummary(openedRunId);
      if (summary !== undefined) {
        const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
        // Determine selected agent's state for context-sensitive help.
        const runningAgentsForHelp = phaseSnap?.phases
          .filter((p) => p.status === "running")
          .flatMap((p) => p.agents) ?? [];
        const selectedAgentState = runningAgentsForHelp[phaseCursor]?.state;
        const phasePendingInterrupts =
          pendingInterrupts.get(openedRunId)?.length ?? 0;
        const help = helpVisible
          ? helpForState(
              "phase-view",
              summary.state,
              selectedAgentState,
              phasePendingInterrupts,
            )
          : [];
        const opts2: Parameters<typeof renderPhaseView>[2] = {
          nowMs: opts.nowMs(),
          help,
        };
        if (width !== undefined) (opts2 as { width?: number }).width = width;
        if (liveBannerText !== undefined) (opts2 as { banner?: string }).banner = liveBannerText;
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
      return { lines: [] };
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const selectedPendingInterrupts =
      selected !== undefined
        ? pendingInterrupts.get(selected.runId)?.length ?? 0
        : 0;
    const help = helpVisible
      ? helpForState(view, selected?.state, undefined, selectedPendingInterrupts)
      : [];
    const localIds = new Set(
      lastSnapshot.filter((s) => opts.registry.wasLocalRun(s.runId)).map((s) => s.runId),
    );
    // Build token totals from phase registry for the tokens column.
    const tokenTotals = new Map<string, number>();
    for (const s of sorted) {
      const phSnap = opts.phaseRegistry.getRunSnapshot(s.runId);
      if (phSnap !== undefined && phSnap.totalTokens > 0) {
        tokenTotals.set(s.runId, phSnap.totalTokens);
      }
    }
    return renderRunsList(sorted, {
      title: "pi-workflows  ·  /workflows overlay",
      nowMs: opts.nowMs(),
      ...(sorted.length > 0 ? { cursor } : {}),
      ...(width !== undefined ? { width } : {}),
      help,
      localRunIds: localIds,
      tokenTotals,
    });
  };

  const handleAction = (action: HotkeyAction): void => {
    switch (action.kind) {
      case "navigate-up":
        // BUG-034: scroll the log in agent-detail, don't mutate runs-list cursor.
        if (view === "agent-detail") {
          const maxOffset = Math.max(0, agentLogTail.length - AGENT_DETAIL_MAX_LOG_LINES);
          if (agentLogScrollOffset < maxOffset) {
            agentLogScrollOffset++;
            requestRender();
          }
          return;
        }
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
        // BUG-034: scroll the log in agent-detail, don't mutate runs-list cursor.
        if (view === "agent-detail") {
          if (agentLogScrollOffset > 0) {
            agentLogScrollOffset--;
            requestRender();
          }
          return;
        }
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
          // BUG-124: clear pending debounce so it doesn't fire after transition.
          if (agentDetailDebounceTimer !== null) {
            clearTimeout(agentDetailDebounceTimer);
            agentDetailDebounceTimer = null;
          }
          view = "phase-view";
          openedAgentId = undefined;
          agentLogTail = [];
          // BUG-034: reset scroll offset when leaving agent-detail.
          agentLogScrollOffset = 0;
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
      case "stop-agent": {
        if (!action.runId || !action.agentId) return;
        opts.onStopAgent?.(action.runId, action.agentId);
        setBanner(`stopping agent ${action.agentId.slice(0, 12)}…`);
        requestRender();
        return;
      }
      case "restart-agent": {
        if (!action.runId || !action.agentId) return;
        opts.onRestartAgent?.(action.runId, action.agentId);
        setBanner(`restarting agent ${action.agentId.slice(0, 12)}…`);
        requestRender();
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
            setBanner(`restarting run ${shortenId(runIdCopy)}…`);
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
          setBanner(`saving script for run ${shortenId(runIdCopy)}…`);
          requestRender();
        } else if (action.runId) {
          // No callback wired — surface a clear, time-limited message
          // rather than a stub literal. Production callers always wire
          // `onSaveScriptRequested` (see workflowCmd.ts).
          setBanner("save-script: no handler wired");
          requestRender();
        }
        return;
      case "visualize-requested":
        if (action.runId && opts.onVisualizeRequested !== undefined) {
          const runIdCopy = action.runId;
          setBanner(`rendering DAG for run ${shortenId(runIdCopy)}…`);
          requestRender();
          Promise.resolve(opts.onVisualizeRequested(runIdCopy))
            .then((target) => {
              if (typeof target === "string" && target.length > 0) {
                // Long banner TTL so the user has time to copy the path.
                setBanner(`viz → ${target}`, 8000);
                requestRender();
              }
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              setBanner(`viz failed: ${msg}`);
              requestRender();
            });
        } else if (action.runId) {
          setBanner("viz: no handler wired");
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
          // BUG-121: query live registry instead of stale lastSnapshot so
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
              setBanner("gc: error loading candidates");
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
                setBanner("gc: delete failed");
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
        // The overlay computes the transcript path and delegates the
        // actual open to the host-supplied `onOpenTranscript` callback
        // (production wiring: `openTranscriptInEditor` in workflowCmd.ts).
        // The callback returns the banner text to surface; if it isn't
        // wired we still show the path so the user can `tail -f` it.
        if (action.runId !== undefined && openedRunId !== undefined && openedAgentId !== undefined) {
          const summary = opts.registry.getSummary(openedRunId);
          const path = agentTranscriptPath(summary?.runDir, openedAgentId);
          if (path === undefined) {
            setBanner("transcript: path unknown");
          } else if (opts.onOpenTranscript !== undefined) {
            const msg = opts.onOpenTranscript(path);
            setBanner(msg ?? `transcript: ${path}`);
          } else {
            setBanner(`transcript: ${path}`);
          }
          requestRender();
        }
        return;
      case "copy-prompt":
        // The overlay extracts the prompt text from the phase snapshot
        // and delegates the clipboard write to `onCopyPrompt` (production
        // wiring: `copyToClipboard` in workflowCmd.ts). No more fake
        // "copied:" stub — the callback's return value tells us whether
        // the copy actually succeeded.
        if (openedRunId !== undefined && openedAgentId !== undefined) {
          const phaseSnap = opts.phaseRegistry.getRunSnapshot(openedRunId);
          const agent = phaseSnap?.phases
            .flatMap((p) => p.agents)
            .find((a) => a.agentId === openedAgentId);
          const promptText = agent?.summary;
          if (promptText === undefined || promptText.length === 0) {
            setBanner("no prompt to copy");
          } else if (opts.onCopyPrompt !== undefined) {
            const msg = opts.onCopyPrompt(promptText);
            setBanner(msg ?? "clipboard: no handler wired");
          } else {
            setBanner("clipboard: no handler wired");
          }
          requestRender();
        }
        return;
      case "interrupt-answer-requested": {
        // ZONE_HITL TUI: dispatch the oldest pending interrupt for the
        // run to the host callback. The callback owns the actual
        // ctx.ui.input/select prompting; the overlay just hands off
        // the payload + runId. We pop the entry optimistically here
        // so a second `i` press doesn't try the same one. If the
        // callback fails, the resolve event from the runtime would
        // re-deliver — but more likely a callback failure means the
        // operator dismissed the prompt; the runtime is still blocked
        // until the next prompt or until the run is killed.
        if (!action.runId) return;
        const list = pendingInterrupts.get(action.runId);
        const payload = list && list.length > 0 ? list[0] : undefined;
        if (payload === undefined) {
          setBanner("no pending interrupt to answer");
          requestRender();
          return;
        }
        if (opts.onInterruptAnswerRequested === undefined) {
          setBanner("interrupt: no handler wired");
          requestRender();
          return;
        }
        const runIdCopy = action.runId;
        (list as NonNullable<typeof list>).splice(0, 1); // pop optimistically so a second `i` press skips this entry
        setBanner(
          `answering interrupt ${payload.key} on ${shortenId(runIdCopy)}…`,
        );
        requestRender();
        Promise.resolve(
          opts.onInterruptAnswerRequested(runIdCopy, payload),
        )
          .then((banner) => {
            // Banner from callback (e.g. "resolved" / "cancelled").
            if (typeof banner === "string" && banner.length > 0) {
              setBanner(banner);
              requestRender();
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setBanner(`interrupt failed: ${msg}`);
            requestRender();
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
          setBanner("fork: no handler wired");
          requestRender();
          return;
        }
        const runIdCopy = action.runId;
        setBanner(`opening fork dialog for ${shortenId(runIdCopy)}…`);
        requestRender();
        Promise.resolve(opts.onForkRequested(runIdCopy))
          .then((banner) => {
            if (typeof banner === "string" && banner.length > 0) {
              // Forks may produce long banners ("forked: wf-xxxxxxxx");
              // give the user time to read.
              setBanner(banner, 8000);
              requestRender();
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setBanner(`fork failed: ${msg}`);
            requestRender();
          });
        return;
      }
      case "noop":
        // Intentional — disabled hotkey or no-selection. The help
        // line already conveys the disabled state visually.
        // Exception: remote runs silently reject r/s — show a toast
        // so the user knows why nothing happened.
        if (action.reason === "disabled-for-remote") {
          setBanner("operation requires a local run (r/s unavailable on remote sessions)");
          requestRender();
        }
        return;
    }
  };

  const handleKey = (key: string): void => {
    // Slice 15: GC dialog intercepts keys.
    if (gcDialogState !== null) {
      const k = key.toLowerCase();
      if (gcDialogState.done !== undefined) {
        // Done screen: any key closes it (BUG-076: must be checked before y/Enter).
        handleAction({ kind: "gc-cancel" });
      } else if (k === "y" || key === "Enter" || key === "RETURN" || key === "\r" || key === "\n") {
        handleAction({ kind: "gc-apply" });
      } else if (k === "n" || key === "Escape" || key === "ESC" || key === "\u001b") {
        handleAction({ kind: "gc-cancel" });
      }
      return;
    }
    // gap/ctx-gate: gate prompt intercepts keys when a gate is pending.
    if (gatePromptState !== null) {
      const k = key.toLowerCase();
      const g = gatePromptState;
      const run = opts.registry.getRun(g.runId);
      if (k === "y" || key === "Enter" || key === "RETURN" || key === "\r" || key === "\n") {
        // Y or Enter → approve (Enter uses defaultAnswer).
        const approved = k === "n" ? false : (k === "y" ? true : g.defaultAnswer);
        gatePromptState = null;
        run?.respondGate(approved);
      } else if (k === "n" || key === "Escape" || key === "ESC" || key === "\u001b") {
        // N or Esc → deny.
        gatePromptState = null;
        run?.respondGate(false);
      }
      requestRender();
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
      // Find the agent under the phase cursor for per-agent actions.
      const phaseSnapForKey = opts.phaseRegistry.getRunSnapshot(openedRunId);
      const runningAgentRows = phaseSnapForKey?.phases
        .filter((p) => p.status === "running")
        .flatMap((p) => p.agents) ?? [];
      const selectedAgent = runningAgentRows[phaseCursor];
      const pendingCount = pendingInterrupts.get(openedRunId)?.length ?? 0;
      const action = dispatchHotkey({
        key,
        view,
        isRemote,
        pendingInterruptCount: pendingCount,
        ...(summary !== undefined
          ? { runState: summary.state, runId: openedRunId }
          : {}),
        ...(selectedAgent !== undefined
          ? { agentId: selectedAgent.agentId, agentState: selectedAgent.state }
          : {}),
      });
      handleAction(action);
      return;
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const isRemote =
      selected !== undefined && !opts.registry.wasLocalRun(selected.runId);
    const selectedPendingCount =
      selected !== undefined
        ? pendingInterrupts.get(selected.runId)?.length ?? 0
        : 0;
    const action = dispatchHotkey({
      key,
      view,
      isRemote,
      pendingInterruptCount: selectedPendingCount,
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
      return buildRender(_width).lines;
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
