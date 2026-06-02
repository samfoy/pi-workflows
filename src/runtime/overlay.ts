/**
 * pi-workflows — slice 13 TUI overlay framework.
 *
 * Mounts the `/workflows` overlay via `ctx.ui.custom`. Glue layer
 * binding three pure modules:
 *
 *   - `activeRuns.ts` (data) — Map of in-process Run handles + summary
 *     state.view subscribed to the appendEntry feed.
 *   - `hotkeys.ts`    (input) — state-guarded `(key, state.view, runState) →
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
  hydrateRegistryFromDisk,
} from "./activeRuns.js";
import { type OverlayView } from "./hotkeys.js";
import { renderRunsList } from "./runsList.js";
import {
  PhaseRegistry,
  getPhaseRegistry,
} from "./phaseRegistry.js";
import {
  handleAction as handleAction_ext,
  handleKey as handleKey_ext,
  type OverlayHelpers,
} from "./overlayActions.js";
import { buildRender as buildRender_ext } from "./overlayRender.js";
export { runKill } from "./overlayActions.js";
import {
  makeOverlayState,
  _resetModuleState,
  appendEntryToLedger,
  applyOverlayEvent,
  DEFAULT_BANNER_TTL_MS,
  narrowEntry,
  narrowPhaseEntry,
  shortenId,
  sortAndClamp,
  tickSpinnerFrame,
  type InterruptAnswerResult,
  type PendingInterruptPayload,
} from "./overlayState.js";
export type { InterruptAnswerResult, PendingInterruptPayload } from "./overlayState.js";

/** Module-level flag enforcing PRD §10.1's "second invocation is no-op". */
let _overlayOpen = false;

/**
 * Slice 16 (I2) — module-scope HITL state that survives overlay
 * close/reopen. The previous mount's per-run pending interrupts and
 * any deferred gate prompt remain visible when the user re-opens
 * `w`. Without this, closing the overlay would silently lose the
 * “operator must answer” signal even though the run is still blocked.
 *
 * `__resetOverlayOpenForTest()` clears these too so per-test state
 * doesn't leak through the suite.
 *
 * Events that fire between overlay close and re-open are still
 * missed (the appendEntry listener is per-mount); recovering those
 * would require a ledger replay on mount and is out of scope here.
 */
/** Test-only seam — reset the open flag between tests. */
export function __resetOverlayOpenForTest(): void {
  _overlayOpen = false;
  _resetModuleState();
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
   * agent in phase-state.view. The overlay doesn't own abort logic — it just
   * signals intent to the Run handle.
   */
  readonly onStopAgent?: (runId: string, agentId: string) => void;
  /**
   * Per-agent restart: called when the user hits `r` on a selected running
   * agent in phase-state.view. The overlay doesn't own dispatch logic — it just
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
   * runs-list / phase-state.view. Receives the runId plus the pending
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
  ) =>
    | Promise<InterruptAnswerResult>
    | InterruptAnswerResult;
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
  /**
   * Async disk hydration root (B1). Defaults to
   * `~/.pi/agent/workflows/runs`. Tests override with a tmp dir.
   */
  readonly runsDir?: string;
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
/**
 * Public entry point. The slash-command handler awaits this; on success

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
      // P2-S4 — mirror interrupt.requested/resolved into
      // `RunSummary.hasPendingInterrupt` so the runs-list state
      // grouping buckets the run under ⚠  Needs input. Patches are
      // load-once via bindRegistryToFeed (not per-mount) so the flag
      // survives overlay close/reopen.
      if (
        (customType === "pi-workflows.interrupt.requested" ||
          customType === "pi-workflows.interrupt.resolved") &&
        data !== null &&
        typeof data === "object"
      ) {
        const d = data as { runId?: unknown };
        if (typeof d.runId === "string") {
          registry.patchSummary(d.runId, {
            hasPendingInterrupt:
              customType === "pi-workflows.interrupt.requested",
          });
        }
      }
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

  // Async disk hydration (B1): populate the registry with recent runs
  // from disk so the runs-list shows non-zero totals on first open
  // even before any in-process Run has been registered. Fire-and-forget;
  // hydration yields via setImmediate so it never blocks first paint.
  hydrateRegistryFromDisk(registry, opts.runsDir).catch(() => {
    /* silent — disk hydration is best-effort */
  });

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
    // VQ-1 — strip any ANSI escapes from the plain `lines[]` payload
    // so non-TTY consumers (sendMessage card, logs) get clean text.
    // `lines[]` is plain row text by contract, but `header` carries
    // bold ANSI (VQ-7); strip both unconditionally for safety.
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*m/g, "");
    opts.pi.sendMessage(
      {
        customType: "pi-workflows.overlay-fallback",
        content: view.lines.map(stripAnsi).join("\n"),
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

export interface OverlayComponentOpts {
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
      ) =>
        | Promise<InterruptAnswerResult>
        | InterruptAnswerResult)
    | undefined;
  readonly onForkRequested?:
    | ((runId: string) => Promise<string | undefined> | string | undefined)
    | undefined;
  readonly gcCutoffDays?: number;
  readonly gcRunsRootOverride?: string;
}

function makeOverlayComponent(opts: OverlayComponentOpts): TuiComponentLike {
  const state = makeOverlayState(opts.registry.listSummaries());
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
  // gap/ctx-gate: pending gate prompt state.
  // Slice 16 (I2): pending HITL state lives at module scope so it
  // survives overlay close/reopen — see top of file. The local
  // alias keeps the function-body diff small. The deferred-gate
  // hide+banner+`i`-to-reopen flow lives below.
  // getGatePromptState() and _pendingInterrupts are imported from the
  // module-level scope above.

  const requestRender = () => {
    if (typeof opts.tui.requestRender === "function") opts.tui.requestRender();
  };

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedRender = () => {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      state.lastSnapshot = opts.registry.listSummaries();
      const sorted = sortAndClamp(state.lastSnapshot);
      if (state.cursor >= sorted.length) state.cursor = Math.max(0, sorted.length - 1);
      // BUG-073: clamp state.phaseCursor when the running-phase agent list shrinks.
      if (state.openedRunId !== undefined) {
        const snap = opts.phaseRegistry.getRunSnapshot(state.openedRunId);
        const visibleAgents =
          snap?.phases
            .filter((p) => p.status === "running")
            .flatMap((p) => p.agents).length ?? 0;
        if (state.phaseCursor >= visibleAgents) {
          state.phaseCursor = Math.max(0, visibleAgents - 1);
        }
      }
      requestRender();
    }, opts.debounceMs);
  };

  const unsub = opts.registry.subscribe(debouncedRender);
  // P2-S3: drive the braille-spinner frame counter at 120ms while
  // the overlay is mounted. Each tick bumps `getSpinnerFrame()` and
  // schedules a debounced render — the existing `if (renderTimer !==
  // null) return` guard inside `debouncedRender` coalesces concurrent
  // calls so the interval can't stack timers.
  const spinnerInterval: ReturnType<typeof setInterval> = setInterval(() => {
    tickSpinnerFrame();
    debouncedRender();
  }, 120);
  // Don't keep the event loop alive solely for the spinner — if pi
  // is otherwise idle and trying to exit, the overlay must not
  // block shutdown.
  if (typeof spinnerInterval === "object" && spinnerInterval !== null && "unref" in spinnerInterval) {
    (spinnerInterval as { unref: () => void }).unref();
  }
  const unsubPhase = opts.phaseRegistry.subscribe((rid) => {
    // Coalesce phase-state.view repaints through the same debounce.
    if ((state.view === "phase-view" || state.view === "agent-detail") && rid === state.openedRunId) {
      debouncedRender();
    }
  });

  // Slice 15: Intercept pi-workflows.agent.log to feed state.agentLogTail
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
        applyOverlayEvent(state, customType, data, { requestRender });
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
    clearInterval(spinnerInterval);
    if (state.agentDetailDebounceTimer !== null) {
      clearTimeout(state.agentDetailDebounceTimer);
      state.agentDetailDebounceTimer = null;
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

  const clearBanner = (): void => {
    banner = undefined;
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  };

  const helpers: OverlayHelpers = {
    requestRender,
    setBanner,
    clearBanner,
    close,
    liveBanner,
  };

  const buildRender = (width?: number) => buildRender_ext(state, opts, helpers, width);

  const handleKey = (key: string): void => handleKey_ext(key, state, opts, helpers);

  // Expose test handle.
  opts.onMounted?.({
    close,
    handleKey,
    currentLines: () => buildRender().lines,
    currentSelection: () =>
      sortAndClamp(state.lastSnapshot)[state.cursor]?.runId,
  });

  // Initial render so `tui` has lines to draw.
  void state.view; // mark used by closure

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

