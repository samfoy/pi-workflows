/**
 * pi-workflows — slice 13 active-runs registry.
 *
 * The canonical "find Run by runId" surface used by the TUI overlay's
 * hotkey wiring (`p` pause, `x` stop, `r` restart) and `/workflows
 * kill <id>`. Slices 11/12 only emitted appendEntry stubs; slice 13
 * connects them to actual in-process `Run` handles so user input
 * actually controls the run.
 *
 * Two distinct datastores live behind one façade:
 *
 *   1. `Map<runId, Run>` — in-process Run handles, populated when
 *      `runManager.startWorkflowRun` resolves AND when slice 11's
 *      `resumeRun` produces a live handle. Hotkeys that need to call
 *      `pause()`/`resumePaused()`/`stop()` look up here.
 *
 *   2. `Map<runId, RunSummary>` — the runs-list view. Includes runs
 *      this process never owned (e.g. recent runs from a previous
 *      session, or runs being driven from another pi window) so the
 *      list view can show them. Driven by `applyEntry()` from the
 *      `pi-workflows.run.{started,transitioned,ended}` appendEntry
 *      feed (PRD §6.6 active-runs index).
 *
 * Subscription model — slice 13's overlay subscribes via `subscribe()`;
 * `unsubscribe()` returns the listener teardown. We use a thin
 * Set-of-listeners rather than `events.EventEmitter` to keep the
 * Context-realm contract narrow (the overlay is host-realm so this is
 * only style, but it matches the rest of the runtime).
 *
 * **Carry-forward concerns honored:**
 *
 *   - **F3** — single canonical "find Run by runId" surface. Subscribes
 *     to `pi-workflows.run.{started,ended,transitioned}` so cross-process
 *     awareness lands here without piggy-backing on file watchers.
 *   - **F2** — `/workflows kill <id>` calls `getRun(runId)?.stop("user-kill")`
 *     directly on the live handle. The in-process Map is the source of
 *     truth (the appendEntry-driven summary is read-only for kill).
 *   - **W6** — `markEnded()` flips the summary to `outcome=...` on the
 *     `run.ended` entry so a hotkey that lands microseconds late
 *     observes the same terminal state the SM already entered.
 *
 * Refs: PRD §10.1, §10.5, plan.md §4 Slice 13, slice_13_concerns.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Run } from "../runManager.js";
import type { RunOutcome } from "../types/internal.js";
import { isParentAlive } from "./crashSweep.js";
import { manifestPath } from "../util/paths.js";

/**
 * Stale-PID liveness check (B6). Thin wrapper around `isParentAlive`
 * from crashSweep, exposed here so `sweepStalePids` and tests share a
 * single import point rather than pulling in the full sweep stack.
 *
 * Synchronous throughout; never throws (returns `true` on error to
 * prefer false-negative over false-positive for live runs).
 */
export function isAlive(opts: {
  parentPid: number;
  parentBootId: string;
}): boolean {
  return isParentAlive(opts);
}

/** Lightweight state used by hotkey/state-guard dispatch. Same labels
 * as `RunStateMachine.state` in slice 7's ledger — kept in sync via
 * `applyEntry()` from `run.transitioned`/`run.ended`. */
export type RunSummaryState =
  | "pending"
  | "approved"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "cancelled-pre-run";

const TERMINAL_STATES: ReadonlySet<RunSummaryState> = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

export function isTerminalState(state: RunSummaryState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Read-only summary surfaced by the runs list view. */
export interface RunSummary {
  readonly runId: string;
  readonly workflowName: string;
  readonly state: RunSummaryState;
  /** ISO-8601 UTC timestamp; falls back to "" if unknown. */
  readonly startedAt: string;
  /** ISO-8601 UTC; defined only on terminal states. */
  readonly endedAt?: string;
  /** Duration up to last update (ms). For terminal states this is
   * `endedAt - startedAt`; for active runs it's recomputed by the
   * caller via `Date.now()` so the summary stays cache-friendly. */
  readonly durationMs?: number;
  /** Optional one-line approval reason for the runs list. */
  readonly approvalReason?: string;
  /** Working directory at run start (used by overlay metadata). */
  readonly runDir?: string;
  /**
   * ZONE_TIMETRAVEL polish — when this run was created by
   * `forkFromCheckpoint`, this is the parent's runId. The runs-list
   * renderer surfaces it as a `fork of <short>` badge next to the
   * workflow name. Populated from `manifest.parentRunId` on register
   * (both fresh starts and resume).
   */
  readonly parentRunId?: string;
  /**
   * ZONE_TIMETRAVEL polish — the phase the fork branched at. Paired
   * with `parentRunId`; absent on non-fork runs.
   */
  readonly forkAtPhase?: string;
}

export type ActiveRunsListener = () => void;

/** Inputs accepted by `applyEntry`, narrowed by `customType`. */
export type RunFeedEntry =
  | {
      readonly customType: "pi-workflows.run.started";
      readonly data: {
        readonly runId: string;
        readonly workflowName: string;
        readonly runDir?: string;
        readonly approval?: { readonly reason?: string } | null;
        readonly startedAt?: string;
      };
    }
  | {
      readonly customType: "pi-workflows.run.transitioned";
      readonly data: {
        readonly runId: string;
        readonly fromState?: RunSummaryState;
        readonly toState: RunSummaryState;
        readonly reason?: string;
      };
    }
  | {
      readonly customType: "pi-workflows.run.ended";
      readonly data: {
        readonly runId: string;
        readonly workflowName?: string;
        readonly outcome: RunOutcome;
        readonly endedAt?: string;
        readonly durationMs?: number;
      };
    }
  | {
      readonly customType: "pi-workflows.run.kill-requested";
      readonly data: { readonly runId: string };
    };

/**
 * The registry. **Singleton per-process** via the module-level
 * `getActiveRuns()` accessor; tests construct fresh instances via
 * `new ActiveRunsRegistry()` to keep state isolated.
 */
export class ActiveRunsRegistry {
  readonly #handles = new Map<string, Run>();
  readonly #summaries = new Map<string, RunSummary>();
  readonly #listeners = new Set<ActiveRunsListener>();
  /**
   * Track run IDs that were ever registered locally (even after the
   * live handle is deleted post-termination). Used by the overlay to
   * distinguish "was local, now terminal" (r/s OK) from "never had a
   * local handle" (remote, r/s disabled).
   */
  readonly #everLocal = new Set<string>();
  /** Whether `applyEntry` is currently mid-dispatch — used to coalesce
   * notifications when multiple entries arrive in the same microtask. */
  #notifyScheduled = false;

  /**
   * Register a live in-process Run handle. Idempotent — a second call
   * with the same runId replaces the prior handle (e.g. resume paths
   * that re-enter through `runManager.start`).
   */
  register(runId: string, run: Run, summaryPatch?: Partial<RunSummary>): void {
    this.#handles.set(runId, run);
    this.#everLocal.add(runId); // F2: track local ownership even after handle drops
    const prior = this.#summaries.get(runId);
    const startedAt = summaryPatch?.startedAt ?? prior?.startedAt ?? "";
    const next: RunSummary = {
      runId,
      workflowName:
        summaryPatch?.workflowName ?? prior?.workflowName ?? "<unknown>",
      state: summaryPatch?.state ?? prior?.state ?? "running",
      startedAt,
      ...(summaryPatch?.endedAt !== undefined
        ? { endedAt: summaryPatch.endedAt }
        : prior?.endedAt !== undefined
          ? { endedAt: prior.endedAt }
          : {}),
      ...(summaryPatch?.durationMs !== undefined
        ? { durationMs: summaryPatch.durationMs }
        : prior?.durationMs !== undefined
          ? { durationMs: prior.durationMs }
          : {}),
      ...(summaryPatch?.approvalReason !== undefined
        ? { approvalReason: summaryPatch.approvalReason }
        : prior?.approvalReason !== undefined
          ? { approvalReason: prior.approvalReason }
          : {}),
      ...(summaryPatch?.runDir !== undefined
        ? { runDir: summaryPatch.runDir }
        : prior?.runDir !== undefined
          ? { runDir: prior.runDir }
          : {}),
      ...(summaryPatch?.parentRunId !== undefined
        ? { parentRunId: summaryPatch.parentRunId }
        : prior?.parentRunId !== undefined
          ? { parentRunId: prior.parentRunId }
          : {}),
      ...(summaryPatch?.forkAtPhase !== undefined
        ? { forkAtPhase: summaryPatch.forkAtPhase }
        : prior?.forkAtPhase !== undefined
          ? { forkAtPhase: prior.forkAtPhase }
          : {}),
    };
    this.#summaries.set(runId, next);
    this.#notify();

    // Auto-cleanup: when this run terminates, drop the live handle but
    // keep the summary so the runs list still shows the recent run.
    void run.terminated.then((info) => {
      // Slice 13/F3: handle teardown is keyed off `terminated`. The
      // matching `pi-workflows.run.ended` appendEntry from
      // resultDelivery may arrive on a different microtask; whichever
      // observes first wins, both are idempotent.
      this.#handles.delete(runId);
      const cur = this.#summaries.get(runId);
      if (cur && !isTerminalState(cur.state)) {
        const updated: RunSummary = {
          ...cur,
          state: info.outcome,
          endedAt: info.endedAt,
          durationMs: info.durationMs,
        };
        this.#summaries.set(runId, updated);
      }
      this.#notify();
    });
  }

  /** Remove a registered handle without touching the summary. Used by
   * hot-reload teardown (slice 16) and tests. */
  unregister(runId: string): boolean {
    const removed = this.#handles.delete(runId);
    if (removed) this.#notify();
    return removed;
  }

  getRun(runId: string): Run | undefined {
    return this.#handles.get(runId);
  }

  getSummary(runId: string): RunSummary | undefined {
    return this.#summaries.get(runId);
  }

  listSummaries(): RunSummary[] {
    return Array.from(this.#summaries.values());
  }

  hasHandle(runId: string): boolean {
    return this.#handles.has(runId);
  }

  /**
   * Slice 15 F2 — returns `true` if this run was ever registered with a
   * live handle in this process (even if the handle has since been
   * dropped on termination). Used by the overlay to distinguish
   * "local-then-terminal" (r/s allowed) from "remote summary only"
   * (r/s disabled).
   */
  wasLocalRun(runId: string): boolean {
    return this.#everLocal.has(runId);
  }

  /**
   * **F3 cross-process awareness** — drive a summary update from an
   * `appendEntry` event the host emitted. Idempotent; tolerates
   * out-of-order/duplicate entries because the state machine's monotonic
   * order (running → paused → ... → terminal) means later entries
   * always win for the matching `state` field.
   */
  applyEntry(entry: RunFeedEntry): void {
    switch (entry.customType) {
      case "pi-workflows.run.started": {
        const d = entry.data;
        if (!d.runId) return;
        const prior = this.#summaries.get(d.runId);
        // Defensive: if a `run.ended` already landed (e.g. crash-sweep
        // emitted transitioned-to-failed before a delayed started entry),
        // don't undo terminal state.
        if (prior && isTerminalState(prior.state)) return;
        const next: RunSummary = {
          runId: d.runId,
          workflowName: d.workflowName,
          state: prior?.state ?? "running",
          startedAt: d.startedAt ?? prior?.startedAt ?? "",
          ...(d.runDir !== undefined ? { runDir: d.runDir } : {}),
          ...(d.approval?.reason !== undefined
            ? { approvalReason: d.approval.reason }
            : {}),
          ...(prior?.parentRunId !== undefined
            ? { parentRunId: prior.parentRunId }
            : {}),
          ...(prior?.forkAtPhase !== undefined
            ? { forkAtPhase: prior.forkAtPhase }
            : {}),
        };
        this.#summaries.set(d.runId, next);
        this.#notify();
        return;
      }
      case "pi-workflows.run.transitioned": {
        const d = entry.data;
        if (!d.runId) return;
        const prior = this.#summaries.get(d.runId);
        if (prior && isTerminalState(prior.state)) return;
        const next: RunSummary = {
          runId: d.runId,
          workflowName: prior?.workflowName ?? "<unknown>",
          state: d.toState,
          startedAt: prior?.startedAt ?? "",
          ...(prior?.endedAt !== undefined ? { endedAt: prior.endedAt } : {}),
          ...(prior?.durationMs !== undefined
            ? { durationMs: prior.durationMs }
            : {}),
          ...(prior?.approvalReason !== undefined
            ? { approvalReason: prior.approvalReason }
            : {}),
          ...(prior?.runDir !== undefined ? { runDir: prior.runDir } : {}),
          ...(prior?.parentRunId !== undefined
            ? { parentRunId: prior.parentRunId }
            : {}),
          ...(prior?.forkAtPhase !== undefined
            ? { forkAtPhase: prior.forkAtPhase }
            : {}),
        };
        this.#summaries.set(d.runId, next);
        this.#notify();
        return;
      }
      case "pi-workflows.run.ended": {
        const d = entry.data;
        if (!d.runId) return;
        const prior = this.#summaries.get(d.runId);
        // BUG-071: guard against duplicate/out-of-order entries overwriting
        // a correct terminal summary, consistent with the started/transitioned cases.
        // Exception: if run.transitioned already set the terminal state, still merge
        // endedAt/durationMs — run.ended is the sole carrier of those fields.
        if (prior && isTerminalState(prior.state)) {
          const updates: Partial<RunSummary> = {
            ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {}),
            ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
          };
          if (Object.keys(updates).length > 0) {
            this.#summaries.set(d.runId, { ...prior, ...updates });
            this.#handles.delete(d.runId);
            this.#notify();
          }
          return;
        }
        const next: RunSummary = {
          runId: d.runId,
          workflowName: d.workflowName ?? prior?.workflowName ?? "<unknown>",
          state: d.outcome,
          startedAt: prior?.startedAt ?? "",
          ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {}),
          ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
          ...(prior?.approvalReason !== undefined
            ? { approvalReason: prior.approvalReason }
            : {}),
          ...(prior?.runDir !== undefined ? { runDir: prior.runDir } : {}),
          ...(prior?.parentRunId !== undefined
            ? { parentRunId: prior.parentRunId }
            : {}),
          ...(prior?.forkAtPhase !== undefined
            ? { forkAtPhase: prior.forkAtPhase }
            : {}),
        };
        this.#summaries.set(d.runId, next);
        this.#handles.delete(d.runId);
        this.#notify();
        return;
      }
      case "pi-workflows.run.kill-requested": {
        // **F2**: when a kill is requested via the cross-process feed
        // (e.g. `/workflows kill` in another window emitted the entry),
        // call `stop()` on the local Run handle if we hold one.
        // Idempotent — if already terminal, no-op.
        const d = entry.data;
        const run = this.#handles.get(d.runId);
        if (run !== undefined) {
          try {
            run.stop("kill-request");
          } catch {
            /* swallow — stop() is idempotent at the Run level */
          }
        }
        return;
      }
    }
  }

  /** Subscribe a listener; returns the unsubscribe function. */
  subscribe(listener: ActiveRunsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Internal: schedule a coalesced notification to all listeners on
   * the next microtask. Multiple state mutations in the same tick
   * collapse into one observer fire — slice 10's debounce contract
   * (PRD §10.6) is enforced at the overlay layer; this is a separate
   * sync→async barrier so listeners never reenter mid-mutation.
   */
  #notify(): void {
    if (this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      // Snapshot to a list before calling so unsubscribes mid-dispatch
      // don't perturb the iteration.
      for (const l of Array.from(this.#listeners)) {
        try {
          l();
        } catch {
          /* listener errors must not break siblings */
        }
      }
    });
  }

  /**
   * IPC inspection surface: write the active-runs index file atomically.
   *
   * Writes `{ runs: [...], updatedAt }` to `<path>.tmp`, fsyncs,
   * then renames over `<path>`. Callers (index.ts subscriber) call this
   * on every registry notification so the file stays current.
   * Best-effort: all errors are swallowed so a filesystem hiccup never
   * disrupts the running workflow.
   */
  /**
   * Sweep all `running` summaries for stale parent PIDs (TUI B6).
   *
   * For each summary with state `"running"`, reads `manifest.json` to
   * find `parentPid` + `parentBootId`, then calls the liveness predicate.
   * If the parent process is dead, coerces the summary state to `"failed"`
   * in the display layer — **no ledger mutation**.
   *
   * Runs are skipped (graceful degradation) when:
   *   - `manifest.json` is missing or unreadable
   *   - `parentPid` is absent from the manifest
   *
   * Called by `mountOverlay` to clean up stuck `running` rows left after
   * a parent pi-process crash (PRD TUI B6).
   *
   * @returns Number of summaries coerced to `"failed"`.
   */
  sweepStalePids(opts?: {
    /** Override liveness predicate (test seam). Defaults to `isAlive`. */
    readonly isAlive?: (opts: { parentPid: number; parentBootId: string }) => boolean;
    /** Override manifest path resolver (test seam). */
    readonly manifestPathFn?: (runId: string) => string;
  }): number {
    const aliveFn = opts?.isAlive ?? isParentAlive;
    const manifestFn = opts?.manifestPathFn ?? manifestPath;
    let coerced = 0;
    for (const [runId, summary] of this.#summaries) {
      if (summary.state !== "running") continue;
      let parentPid: number | undefined;
      let parentBootId = "";
      try {
        const raw = readFileSync(manifestFn(runId), "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.parentPid === "number") parentPid = parsed.parentPid;
        if (typeof parsed.parentBootId === "string") parentBootId = parsed.parentBootId;
      } catch {
        // manifest missing or unreadable — skip this run
        continue;
      }
      if (parentPid === undefined) continue;
      if (aliveFn({ parentPid, parentBootId })) continue;
      // Parent is dead — coerce to failed (display-layer only, no ledger write).
      this.#summaries.set(runId, { ...summary, state: "failed" });
      coerced++;
    }
    if (coerced > 0) this.#notify();
    return coerced;
  }

  writeActiveIndex(path: string): void {
    const runs: string[] = [];
    for (const [id, s] of this.#summaries) {
      if (!isTerminalState(s.state)) runs.push(id);
    }
    const payload =
      JSON.stringify({ runs, updatedAt: new Date().toISOString() }) + "\n";
    const tmp = path + ".tmp";
    const dir = dirname(path);
    try {
      // Ensure the runs dir exists (it may not on first startup).
      mkdirSync(dir, { recursive: true });
    } catch { /* swallow */ }
    try {
      const fd = openSync(tmp, "w", 0o644);
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch { /* best-effort — never disrupt a running workflow */ }
  }

  /**
   * Async disk hydration insert-if-absent helper (B1).
   *
   * Adds a {@link RunSummary} to the registry only when no entry for
   * that runId exists yet — live runs always take precedence so this
   * is safe to call after the registry has already been populated by
   * fresh starts. Does NOT call `#notify`; batch hydration callers
   * should invoke {@link flushNotify} once at the end.
   */
  hydrateRun(summary: RunSummary): void {
    if (this.#summaries.has(summary.runId)) return;
    this.#summaries.set(summary.runId, summary);
  }

  /**
   * Fire the coalesced listener notification once after a batch of
   * {@link hydrateRun} calls. Safe to call when no mutations occurred
   * (notification still coalesces via `#notifyScheduled`).
   */
  flushNotify(): void {
    this.#notify();
  }

  /** Test seam: clear all state (handles + summaries + listeners). */
  reset(): void {
    this.#handles.clear();
    this.#summaries.clear();
    this.#listeners.clear();
    this.#everLocal.clear();
  }

  /** Visible counts for the overlay header. */
  get inFlight(): number {
    let n = 0;
    for (const s of this.#summaries.values()) {
      if (!isTerminalState(s.state)) n++;
    }
    return n;
  }

  get total(): number {
    return this.#summaries.size;
  }
}

/* ───────────────────────────────────────────────────────────────────
 *  Async disk hydration (B1) — populate registry from on-disk runDirs
 * ─────────────────────────────────────────────────────────────────── */

/** Hard cap on the number of runs hydrated from disk per call. */
const HYDRATION_CAP = 200;

/**
 * Hydrate the registry with summaries reconstructed from on-disk
 * `manifest.json` files. Runs already present in the registry (live
 * runs) are skipped; fresh entries are added via
 * {@link ActiveRunsRegistry.hydrateRun}.
 *
 * The implementation yields once via `setImmediate` before touching
 * the filesystem so the overlay's first paint is never blocked by
 * disk latency. All errors are swallowed — a missing or malformed
 * runs directory must never disrupt the overlay.
 *
 * State inference is conservative: if `result.json` is absent
 * alongside the manifest, terminal non-done states are coerced to
 * `"failed"` (a clean completion always writes `result.json`).
 */
export async function hydrateRegistryFromDisk(
  registry: ActiveRunsRegistry,
  runsDir?: string,
): Promise<void> {
  const root = runsDir ?? join(homedir(), ".pi/agent/workflows/runs");
  // Yield first so the overlay can render before we hit the filesystem.
  await new Promise<void>((r) => setImmediate(r));

  if (!existsSync(root)) return;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  // Decorate each candidate with its mtime so we can sort newest-first
  // and cap at HYDRATION_CAP.
  const candidates: { name: string; path: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    const p = join(root, name);
    try {
      const s = statSync(p);
      if (!s.isDirectory()) continue;
      candidates.push({ name, path: p, mtimeMs: s.mtimeMs });
    } catch {
      /* skip unreadable entries */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = candidates.slice(0, HYDRATION_CAP);

  for (const c of limited) {
    let manifest: Record<string, unknown>;
    try {
      const raw = readFileSync(join(c.path, "manifest.json"), "utf-8");
      manifest = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // missing / unreadable / malformed — skip silently
    }

    const runId =
      typeof manifest.runId === "string" ? manifest.runId : c.name;
    if (registry.getSummary(runId) !== undefined) continue; // live run wins

    const workflowName =
      typeof manifest.workflowName === "string"
        ? manifest.workflowName
        : "<unknown>";
    const startedAt =
      typeof manifest.startedAt === "string" ? manifest.startedAt : "";
    const finishedAt =
      typeof manifest.finishedAt === "string" ? manifest.finishedAt : undefined;
    const parentRunId =
      typeof manifest.parentRunId === "string"
        ? manifest.parentRunId
        : undefined;

    // State inference: result.json present → done; otherwise failed.
    const hasResult = existsSync(join(c.path, "result.json"));
    const rawState =
      typeof manifest.state === "string" ? manifest.state : undefined;
    let state: RunSummaryState;
    if (hasResult) {
      state = "done";
    } else if (rawState && isTerminalState(rawState as RunSummaryState)) {
      // Manifest claims terminal but no result.json — coerce to failed.
      state = "failed";
    } else if (rawState === "done") {
      // Defensive: claimed done without result.json → failed.
      state = "failed";
    } else {
      state = "failed";
    }

    const summary: RunSummary = {
      runId,
      workflowName,
      state,
      startedAt,
      ...(finishedAt !== undefined ? { endedAt: finishedAt } : {}),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      runDir: c.path,
    };
    registry.hydrateRun(summary);
  }

  registry.flushNotify();
}

/* ───────────────────────────────────────────────────────────────────
 *  Per-process singleton
 * ─────────────────────────────────────────────────────────────────── */

let _singleton: ActiveRunsRegistry | null = null;

/** Get the per-process singleton. Lazy — never null after first call. */
export function getActiveRuns(): ActiveRunsRegistry {
  if (_singleton === null) {
    _singleton = new ActiveRunsRegistry();
  }
  return _singleton;
}

/** Replace the singleton (test-only). Returns the prior instance so
 * tests can snapshot+restore. */
export function __setActiveRunsSingletonForTest(
  next: ActiveRunsRegistry | null,
): ActiveRunsRegistry | null {
  const prior = _singleton;
  _singleton = next;
  return prior;
}
