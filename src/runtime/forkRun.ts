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
 * Cache copy is **strictly filtered by phase boundary**. Walk the
 * parent ledger to find the `phase_start` timestamp for `atPhase`;
 * any `agent_result` cache record whose `at` is at-or-after that
 * cutoff is dropped from the seed (it would belong to a post-fork
 * phase). Phase-1 agents in the fork share the same `cacheKey` as
 * the parent and cache-hit. Post-fork agents always re-dispatch —
 * they cannot silently reuse the parent's results even when the
 * agent prompt does not depend on `overrides`. Author-controlled
 * records (`author_cache` / `author_cache_delete`) are kept verbatim
 * since they are not auto-derived from agent execution and may
 * legitimately encode pre-run state the workflow expects.
 *
 * See `_classifyParentCacheLine()` for the per-record decision and
 * `docs/time-travel.md` for the broader rationale.
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
 *   - Resume of a forked run (the resumeRun path doesn't yet
 *     surface lineage in error messages — see docs/time-travel.md).
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, promises as fs, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import type {
  ApprovalGateOptions,
  RunManifest,
} from "../types/internal.js";
import { LedgerReader } from "./ledger.js";
import { CacheStore } from "./cache.js";
import { runDir as runDirFor } from "../util/paths.js";
import { isRunId } from "../util/runId.js";
import {
  startWorkflowRun,
  type Run,
  type RunManagerStartOptions,
} from "../runManager.js";

/** Reserved cache key — `ctx.cache.get('__fork_overrides__')` reads this. */
export const FORK_OVERRIDES_KEY = "__fork_overrides__";

/**
 * Thrown when the parent runId in `forkFromCheckpoint(parent, ...)` doesn't
 * resolve to a run directory.
 */
export class ForkRunNotFoundError extends Error {
  readonly parentRunId: string;
  constructor(parentRunId: string) {
    super(`forkFromCheckpoint: parent run ${parentRunId} not found`);
    this.name = "ForkRunNotFoundError";
    this.parentRunId = parentRunId;
  }
}

/**
 * Thrown when `opts.atPhase` is not present in the parent ledger; carries
 * `availablePhases` for recovery.
 */
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

/**
 * Options accepted by `forkFromCheckpoint` and
 * `WorkflowClient.forkFromCheckpoint`.
 */
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
  // Reject anything that isn't the wf-<12 hex> shape so an attacker
  // can't pass `../../../etc/passwd` and have resolveRunDir(id) join it
  // into a path outside ~/.pi/agent/workflows/runs/. The default
  // resolveRunDir is `path.join(runsHome(), id)`, which silently accepts
  // `..` segments. Validating here covers both forkFromCheckpoint() and
  // WorkflowClient.forkFromCheckpoint() (which delegates here).
  if (!isRunId(parentRunId)) {
    throw new TypeError(
      `forkFromCheckpoint: parentRunId must match the wf-<12 hex> shape (got: ${JSON.stringify(parentRunId)})`,
    );
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

  // Strict cache filtering boundary: the timestamp of the cut-point
  // `phase_start` entry. Any `agent_result` cache record whose `at`
  // is at-or-after this timestamp belongs to a post-fork phase and
  // must NOT inherit. Below we use it in `_classifyParentCacheLine`.
  const cutPhaseStart = entries[cutIndex];
  if (!cutPhaseStart || cutPhaseStart.type !== "phase_start") {
    throw new Error(
      `forkRun invariant violated: entry at cutIndex ${cutIndex} is not a phase_start ` +
        `(got ${cutPhaseStart ? cutPhaseStart.type : "undefined"}). ` +
        "Cannot safely compute cache-filtering boundary — aborting fork.",
    );
  }
  const cutAt = cutPhaseStart.at;

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
      try {

      // Pre-seed ledger.jsonl.
      const ledgerLines = inheritedEntries.map((e) => JSON.stringify(e)).join("\n");
      if (ledgerLines.length > 0) {
        let ledgerFd: number | undefined;
        try {
          ledgerFd = openSync(join(d, "ledger.jsonl"), "w", 0o644);
          writeSync(ledgerFd, ledgerLines + "\n");
          fsyncSync(ledgerFd);
        } finally {
          if (ledgerFd !== undefined) closeSync(ledgerFd);
        }
      }

      // Pre-seed cache.jsonl: copy parent's cache + append the
      // overrides record. We copy raw lines (rather than via
      // CacheStore.replay) so we don't lose any record types this
      // code doesn't know about (forward-compat). Each line goes
      // through `_classifyParentCacheLine` for strict-phase
      // filtering: agent_result records with `at >= cutAt` are
      // dropped (they belong to post-fork phases). Other record
      // types (author_cache*, unknown future types) are kept.
      const parentCachePath = join(parentRunDirAbs, "cache.jsonl");
      const lines: string[] = [];
      if (existsSync(parentCachePath)) {
        const buf = readFileSync(parentCachePath, "utf8");
        for (const raw of buf.split("\n")) {
          const line = raw.trim();
          if (line.length === 0) continue;
          if (_classifyParentCacheLine(line, cutAt) === "keep") {
            lines.push(line);
          }
        }
      }
      // Append the overrides record (always — even when overrides is
      // undefined we record `null` so the workflow can detect it
      // explicitly via `ctx.cache.has(FORK_OVERRIDES_KEY)`).
      //
      // Validate JSON-serializability before the seed write (BUG-166):
      //   (1) circular refs  — JSON.stringify would throw a raw TypeError
      //       with no mention of opts.overrides or the callsite.
      //   (2) function/Symbol values — JSON.stringify silently drops them,
      //       so ctx.cache.get(FORK_OVERRIDES_KEY) would return a
      //       structurally different object with no warning to the caller.
      // Using a custom replacer lets us catch (2) before stringification;
      // wrapping in try/catch gives a descriptive error for both cases.
      let overridesValue: unknown = null;
      if (opts.overrides !== undefined) {
        let rawOverrides: string;
        try {
          rawOverrides = JSON.stringify(opts.overrides, (_key, val: unknown) => {
            if (typeof val === "function" || typeof val === "symbol") {
              throw new TypeError(
                `opts.overrides contains a non-JSON-serializable ${typeof val} value ` +
                  `which would be silently dropped by JSON.stringify, causing ` +
                  `ctx.cache.get('${FORK_OVERRIDES_KEY}') to differ from the provided opts.overrides`,
              );
            }
            return val;
          });
        } catch (err) {
          throw new TypeError(
            `forkFromCheckpoint: opts.overrides is not JSON-serializable (${(err as Error).message})`,
          );
        }
        overridesValue = JSON.parse(rawOverrides) as unknown;
      }
      const overridesRecord = {
        type: "author_cache" as const,
        key: FORK_OVERRIDES_KEY,
        value: overridesValue,
        at: (opts.nowIso ?? (() => new Date().toISOString()))(),
      };
      lines.push(JSON.stringify(overridesRecord));
      let cacheFd: number | undefined;
      try {
        cacheFd = openSync(join(d, "cache.jsonl"), "w", 0o644);
        writeSync(cacheFd, lines.join("\n") + "\n");
        fsyncSync(cacheFd);
      } finally {
        if (cacheFd !== undefined) closeSync(cacheFd);
      }

      seedDone = true;
      } catch (err) {
        // Seed write failed — remove the partially-created directory so
        // it doesn't appear as an orphaned run dir. GC would eventually
        // collect it, but a prompt cleanup is cleaner.
        rmSync(d, { recursive: true, force: true });
        throw err;
      }
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

  // If startWorkflowRun throws (approval denied, hash mismatch, etc.)
  // after wrappedResolveRunDir has already created and seeded the run
  // directory, remove the orphan so GC scans and /workflows list stay
  // clean.
  let run: Run;
  try {
    run = await startWorkflowRun(workflow, inputArg, startOpts);
  } catch (err) {
    if (mintedRunId !== null) {
      await fs.rm(resolveRunDir(mintedRunId), { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
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

/**
 * Decide whether a single `cache.jsonl` line from the parent run
 * should be inherited by the fork.
 *
 * Rules (strict cache filtering for ZONE_TIMETRAVEL):
 *   - `agent_result` with `at >= cutAt` → "drop" (post-fork phase;
 *     re-dispatching is the safe behavior).
 *   - `agent_result` with `at < cutAt` → "keep" (pre-fork phase
 *     cache hit candidate).
 *   - any other record type (author_cache, author_cache_delete,
 *     unknown future types) → "keep" (workflow-author-controlled or
 *     forward-compat).
 *   - malformed JSON → "drop" (defensive; a parser error during
 *     seed would corrupt the fork's cache).
 *
 * `cutAt` is the ISO timestamp of the parent's `phase_start` for
 * the fork's `atPhase`. Pass `""` to disable filtering (legacy
 * behavior — never excludes a record).
 *
 * Exported for unit-testability. Not part of the public API.
 */
export function _classifyParentCacheLine(
  line: string,
  cutAt: string,
): "keep" | "drop" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "drop";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return "drop";
  const r = parsed as Record<string, unknown>;
  if (typeof r.type !== "string") return "drop";
  // Checkpoint entries (author_cache with __chk__ key) must be
  // timestamp-filtered just like agent_result — a post-fork checkpoint
  // seeded into the fork's cache would cause ctx.checkpoint() to return
  // true and silently skip re-execution of the guarded block.
  if (
    r.type === "author_cache" &&
    typeof r.key === "string" &&
    r.key.startsWith("__chk__")
  ) {
    if (cutAt.length === 0) return "keep"; // filtering disabled
    if (typeof r.at !== "string") return "drop"; // malformed; drop defensively
    return r.at < cutAt ? "keep" : "drop";
  }
  if (r.type !== "agent_result") return "keep";
  // agent_result without an `at` field is malformed; drop defensively.
  if (typeof r.at !== "string") return "drop";
  // Lexicographic ISO comparison is correct here — UTC timestamps
  // sort the same as their epoch-ms counterparts.
  if (cutAt.length === 0) return "keep"; // disabled
  return r.at < cutAt ? "keep" : "drop";
}
