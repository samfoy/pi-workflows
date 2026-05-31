/**
 * pi-workflows — ZONE_TIMETRAVEL: fork-from-checkpoint.
 *
 * `forkFromCheckpoint(parentRunId, opts)` mints a new run that
 * inherits the parent's ledger + cache state up to (but not
 * including) the `phase_start` for `opts.atPhase`. The new run
 * shares the parent's workflow source — the source path is read
 * from the parent's `manifest.json` and re-hashed by RunManager —
 * but starts with a fresh state machine.
 *
 *   parent run                 fork run
 *   ─────────────              ─────────
 *   phase_start p1     ┐
 *   agent_end a1@p1    │  copied verbatim into the fork's
 *   phase_end p1       │  ledger.jsonl (BEFORE startWorkflowRun
 *   phase_start p2     │  appends the fork's own init/transitions)
 *   agent_end a2@p2    ✗  (cut here — atPhase = "p2")
 *   …                  ✗
 *
 * The cache is copied wholesale. Phase-1 agents in the fork have
 * the same `cacheKey` as the parent (same workflow sha + phaseName
 * + agentId + prompt + opts) → cache hit, no re-dispatch. Phase-2+
 * agents whose prompts depend on `overrides` get a different
 * `cacheKey` and re-dispatch with the override values. Agents
 * whose prompts DON'T depend on overrides will hit the parent's
 * cache — that's the workflow author's choice (call it cache reuse,
 * not a bug).
 *
 * `overrides` is exposed to the workflow as
 * `await ctx.cache.get('__fork_overrides__')`. The author reads it
 * in the post-fork phase to branch behavior (typically by varying
 * an agent prompt). The reserved `__chk__` prefix is owned by
 * `ctx.checkpoint`; the parallel `__fork__` prefix lives here.
 *
 * Manifest records `parentRunId` + `forkAtPhase` so audit / GC can
 * walk the lineage. The new ledger's `init` entry's `manifest`
 * field also carries those keys via the runManager merge.
 *
 * Deferred (TODO):
 *   - TUI hotkey to launch a fork from the runs-list view (see
 *     `docs/time-travel.md`).
 *   - Strict cache filtering (currently full-cache copy; relies on
 *     overrides changing prompt → different cacheKey).
 *   - Resume of a forked run (the resumeRun path doesn't yet
 *     surface lineage in error messages).
 */

import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ApprovalGateOptions,
  RunManifest,
} from "../types/internal.js";
import { LedgerReader } from "./ledger.js";
import { CacheStore } from "./cache.js";
import { runDir as runDirFor } from "../util/paths.js";
import {
  startWorkflowRun,
  type Run,
  type RunManagerStartOptions,
} from "../runManager.js";

/** Reserved cache key — `ctx.cache.get('__fork_overrides__')` reads this. */
export const FORK_OVERRIDES_KEY = "__fork_overrides__";

export class ForkRunNotFoundError extends Error {
  readonly parentRunId: string;
  constructor(parentRunId: string) {
    super(`forkFromCheckpoint: parent run ${parentRunId} not found`);
    this.name = "ForkRunNotFoundError";
    this.parentRunId = parentRunId;
  }
}

export class ForkPhaseNotFoundError extends Error {
  readonly parentRunId: string;
  readonly atPhase: string;
  readonly availablePhases: readonly string[];
  constructor(parentRunId: string, atPhase: string, available: readonly string[]) {
    super(
      `forkFromCheckpoint: parent run ${parentRunId} has no phase_start for "${atPhase}". ` +
        `Available phases in parent ledger: [${available.join(", ")}]`,
    );
    this.name = "ForkPhaseNotFoundError";
    this.parentRunId = parentRunId;
    this.atPhase = atPhase;
    this.availablePhases = available;
  }
}

export interface ForkFromCheckpointOptions {
  /**
   * Phase name to fork at. The parent's ledger is truncated BEFORE
   * the first `phase_start` entry whose `phaseName === atPhase`. The
   * fork re-runs from that boundary.
   */
  readonly atPhase: string;
  /**
   * Arbitrary JSON-cloneable value made available to the forked
   * workflow as `await ctx.cache.get('__fork_overrides__')`. Use
   * this to vary post-fork agent prompts (which is also what makes
   * their cache miss instead of replaying the parent's results).
   */
  readonly overrides?: unknown;
  /**
   * Optional override for the new run's input string. Defaults to
   * the parent's input from its manifest. Independent from
   * `overrides` (which lives in cache) — workflow authors who want
   * to vary the entire input pass it here.
   */
  readonly input?: string;
  /**
   * Same approval/preApproved/dispatch contract as
   * `startWorkflowRun`. The fork re-prompts unless `preApproved` is
   * set (or the script's hash matches an existing trust row).
   */
  readonly preApproved?: boolean;
  readonly approval?: Pick<
    ApprovalGateOptions,
    | "dialog"
    | "viewer"
    | "env"
    | "home"
    | "trustOverride"
    | "projectSettingsPathOverride"
    | "personalSettingsPathOverride"
    | "onPersistError"
  >;
  readonly mockAgents?: boolean;
  readonly seedFixturesJsonl?: string;
  readonly dispatch?: RunManagerStartOptions["dispatch"];
  readonly newRunIdFactory?: () => string;
  readonly nowIso?: () => string;
  readonly nowMs?: () => number;
  readonly resolveRunDir?: (runId: string) => string;
  readonly cwd?: string;
  readonly maxConcurrent?: number;
  readonly perRunAgentCap?: number;
  readonly tokenBudget?: number | null;
  readonly enableGlobalCache?: boolean;
  readonly emitOverlayEvent?: RunManagerStartOptions["emitOverlayEvent"];
  readonly emitBanner?: (banner: string) => void;
  readonly activeRuns?: RunManagerStartOptions["activeRuns"];
}

/**
 * Fork a new run from `parentRunId` at `atPhase`. Returns the
 * resulting `Run` handle whose `.runDirAbs` exposes the fork's run
 * directory (the parent is left untouched).
 *
 * Steps (in order):
 *   1. Read parent manifest.json — needed for workflow path + input.
 *   2. Read parent ledger.jsonl — find the cut point.
 *   3. Mint new runId, mkdir new runDir.
 *   4. Pre-write `<newRunDir>/ledger.jsonl` with the parent's
 *      pre-fork events EXCLUDING `init` and `transition` entries
 *      (those would clash with the fresh state machine).
 *   5. Pre-write `<newRunDir>/cache.jsonl` with the parent's full
 *      cache + a synthetic `author_cache` entry recording the
 *      overrides under `FORK_OVERRIDES_KEY`.
 *   6. Call `startWorkflowRun(...)` with `parentRunId` + `forkAtPhase`
 *      hints — the runManager merges them into the manifest.
 */
export async function forkFromCheckpoint(
  parentRunId: string,
  opts: ForkFromCheckpointOptions,
): Promise<Run> {
  if (typeof parentRunId !== "string" || parentRunId.length === 0) {
    throw new TypeError("forkFromCheckpoint: parentRunId must be a non-empty string");
  }
  if (typeof opts.atPhase !== "string" || opts.atPhase.length === 0) {
    throw new TypeError("forkFromCheckpoint: opts.atPhase must be a non-empty string");
  }

  const resolveRunDir = opts.resolveRunDir ?? runDirFor;
  const parentRunDirAbs = resolveRunDir(parentRunId);
  if (!existsSync(parentRunDirAbs)) {
    throw new ForkRunNotFoundError(parentRunId);
  }

  // 1. Parent manifest.
  const parentManifestPath = join(parentRunDirAbs, "manifest.json");
  if (!existsSync(parentManifestPath)) {
    throw new Error(
      `forkFromCheckpoint: parent run ${parentRunId} has no manifest.json at ${parentManifestPath}`,
    );
  }
  const parentManifestRaw = await fs.readFile(parentManifestPath, "utf8");
  const parentManifest = JSON.parse(parentManifestRaw) as Partial<RunManifest>;
  if (
    typeof parentManifest.workflowName !== "string" ||
    typeof parentManifest.workflowAbsPath !== "string"
  ) {
    throw new Error(
      `forkFromCheckpoint: parent manifest missing workflowName/workflowAbsPath`,
    );
  }

  // 2. Parent ledger — find the cut point.
  const parentLedgerReader = new LedgerReader({
    runId: parentRunId,
    resolveLedgerPath: () => join(parentRunDirAbs, "ledger.jsonl"),
  });
  const { entries } = await parentLedgerReader.read();

  let cutIndex = -1;
  const seenPhases: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === "phase_start") {
      if (!seenPhases.includes(e.phaseName)) seenPhases.push(e.phaseName);
      if (e.phaseName === opts.atPhase) {
        cutIndex = i;
        break;
      }
    }
  }
  if (cutIndex === -1) {
    throw new ForkPhaseNotFoundError(parentRunId, opts.atPhase, seenPhases);
  }

  // Subset of the parent ledger we want to inherit. We DROP `init`
  // and `transition` entries — those would clash with the fresh
  // state machine startWorkflowRun installs (and would also corrupt
  // the OTel exporter's per-run grouping). Everything else (phase_*,
  // agent_*, log, agent_log, report, appendEntry) carries forward
  // for forensics.
  const inheritedEntries = entries.slice(0, cutIndex).filter(
    (e) => e.type !== "init" && e.type !== "transition" && e.type !== "result"
      && e.type !== "error" && e.type !== "shutdown" && e.type !== "cancelled",
  );

  // 3. Mint new runId + create new runDir.
  // We let startWorkflowRun mint the runId via its own factory so
  // there's a single source of truth for runId formatting.

  // 4 & 5. Pre-seed ledger + cache. Because startWorkflowRun creates
  // the runDir and writes script.js + manifest itself, we have to do
  // the pre-seed by hooking into `resolveRunDir`: when it's called
  // for the new runId, we mkdir, write our seed files, then return
  // the path so startWorkflowRun's own mkdir/writes layer on top.
  let seedDone = false;
  let mintedRunId: string | null = null;
  const wrappedResolveRunDir = (id: string): string => {
    const d = resolveRunDir(id);
    if (!seedDone) {
      mintedRunId = id;
      // resolveRunDir is sync, so the seed must be sync too. We use
      // the synchronous fs primitives imported at module top.
      mkdirSync(d, { recursive: true });

      // Pre-seed ledger.jsonl.
      const ledgerLines = inheritedEntries.map((e) => JSON.stringify(e)).join("\n");
      if (ledgerLines.length > 0) {
        writeFileSync(join(d, "ledger.jsonl"), ledgerLines + "\n", "utf8");
      }

      // Pre-seed cache.jsonl: copy parent's cache + append the
      // overrides record. We copy raw lines (rather than via
      // CacheStore.replay) so we don't lose any record types this
      // code doesn't know about (forward-compat).
      const parentCachePath = join(parentRunDirAbs, "cache.jsonl");
      const lines: string[] = [];
      if (existsSync(parentCachePath)) {
        const buf = readFileSync(parentCachePath, "utf8");
        // Drop only the trailing empty line; preserve every well-
        // formed record verbatim.
        for (const raw of buf.split("\n")) {
          const line = raw.trim();
          if (line.length > 0) lines.push(line);
        }
      }
      // Append the overrides record (always — even when overrides is
      // undefined we record `null` so the workflow can detect it
      // explicitly via `ctx.cache.has(FORK_OVERRIDES_KEY)`).
      const overridesValue =
        opts.overrides === undefined ? null : opts.overrides;
      const overridesRecord = {
        type: "author_cache" as const,
        key: FORK_OVERRIDES_KEY,
        value: overridesValue,
        at: (opts.nowIso ?? (() => new Date().toISOString()))(),
      };
      lines.push(JSON.stringify(overridesRecord));
      writeFileSync(
        join(d, "cache.jsonl"),
        lines.join("\n") + "\n",
        "utf8",
      );

      seedDone = true;
    }
    return d;
  };

  // 6. Hand off to startWorkflowRun. We pass parentRunId + forkAtPhase
  // so the manifest carries lineage; we also pass the parent's
  // workflowAbsPath via a synthesized WorkflowFile.
  const workflow = {
    name: parentManifest.workflowName,
    absPath: parentManifest.workflowAbsPath,
    scope: "personal" as const,
  };

  const inputArg = opts.input ?? parentManifest.input ?? "";

  const cwdResolved = opts.cwd ?? parentManifest.cwd ?? process.cwd();

  const startOpts: RunManagerStartOptions = {
    parentRunId,
    forkAtPhase: opts.atPhase,
    resolveRunDir: wrappedResolveRunDir,
    cwd: cwdResolved,
    ...(opts.preApproved !== undefined ? { preApproved: opts.preApproved } : {}),
    ...(opts.approval !== undefined ? { approval: opts.approval } : {}),
    ...(opts.mockAgents !== undefined ? { mockAgents: opts.mockAgents } : {}),
    ...(opts.seedFixturesJsonl !== undefined
      ? { seedFixturesJsonl: opts.seedFixturesJsonl }
      : {}),
    ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
    ...(opts.newRunIdFactory !== undefined
      ? { newRunIdFactory: opts.newRunIdFactory }
      : {}),
    ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.perRunAgentCap !== undefined ? { perRunAgentCap: opts.perRunAgentCap } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.enableGlobalCache !== undefined
      ? { enableGlobalCache: opts.enableGlobalCache }
      : {}),
    ...(opts.emitOverlayEvent !== undefined
      ? { emitOverlayEvent: opts.emitOverlayEvent }
      : {}),
    ...(opts.emitBanner !== undefined ? { emitBanner: opts.emitBanner } : {}),
    ...(opts.activeRuns !== undefined ? { activeRuns: opts.activeRuns } : {}),
  };

  const run = await startWorkflowRun(workflow, inputArg, startOpts);
  // Post-condition guard: if startWorkflowRun never called our
  // wrapped resolver (e.g. mocked in a test), fail loud — the
  // contract guarantees the seed lands BEFORE the run starts.
  if (!seedDone) {
    throw new Error(
      `forkFromCheckpoint: internal invariant violated — pre-seed did not run for ${mintedRunId ?? "(unknown runId)"}`,
    );
  }
  return run;
}

// CacheStore is imported only for the side-effect of being a
// dependency clue; tests that reach into the cache to verify the
// overrides record may want to use it directly.
export { CacheStore };
