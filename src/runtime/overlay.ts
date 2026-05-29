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
}

function makeOverlayComponent(opts: OverlayComponentOpts): TuiComponentLike {
  let view: OverlayView = "runs-list";
  let cursor = 0;
  let phaseCursor = 0;
  let openedRunId: string | undefined;
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
      requestRender();
    }, opts.debounceMs);
  };

  const unsub = opts.registry.subscribe(debouncedRender);
  const unsubPhase = opts.phaseRegistry.subscribe((rid) => {
    // Coalesce phase-view repaints through the same debounce.
    if (view === "phase-view" && rid === openedRunId) {
      debouncedRender();
    }
  });

  const close = () => {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    unsub();
    unsubPhase();
    try {
      opts.done();
    } catch {
      /* swallow — done() may throw on race with manual unmount */
    }
  };

  const buildRender = () => {
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
      view = "runs-list";
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const help = helpVisible ? helpForState(view, selected?.state) : [];
    const localIds = new Set(
      lastSnapshot.filter((s) => opts.registry.hasHandle(s.runId)).map((s) => s.runId),
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
            const total = snap?.totalAgents ?? 0;
            if (phaseCursor < Math.max(0, total - 1)) {
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
        // Slice 14 — Esc on phase view returns to runs-list.
        if (view === "phase-view") {
          view = "runs-list";
          openedRunId = undefined;
          phaseCursor = 0;
          banner = undefined;
          requestRender();
          return;
        }
        // Agent detail (slice 15): would return to phase-view here.
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
        return;
      case "noop":
        // Intentional — disabled hotkey or no-selection. The help
        // line already conveys the disabled state visually.
        return;
    }
  };

  const handleKey = (key: string): void => {
    if (view === "phase-view" && openedRunId !== undefined) {
      const summary = opts.registry.getSummary(openedRunId);
      const action = dispatchHotkey({
        key,
        view,
        ...(summary !== undefined
          ? { runState: summary.state, runId: openedRunId }
          : {}),
      });
      handleAction(action);
      return;
    }
    const sorted = sortAndClamp(lastSnapshot);
    const selected = sorted[cursor];
    const action = dispatchHotkey({
      key,
      view,
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
      // pi-tui calls dispose() if the host tears down; we mirror our
      // own cleanup so listeners don't leak.
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      unsub();
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
