/**
 * pi-workflows — slice 11 GC: walk + dry-run/apply.
 *
 * Per PRD §6.7 — `/workflows gc` deletes runs that meet ALL:
 *
 *   - Final state is terminal (`done`, `failed`, `stopped`,
 *     `cancelled-pre-run`).
 *   - `endedAt` (read from `result.json` if present, else manifest's
 *     last `transition` timestamp) older than `gcAfterDays` days.
 *
 * Slice 11 implementation choices:
 *
 *   - `apply: false` (default) is a dry-run — returns the list of
 *     candidates without touching disk.
 *   - `apply: true` actually `rm -rf` each candidate's run dir.
 *   - **Mid-resume safety**: a run with no `result.json` is excluded
 *     even if its ledger says terminal. The `result.json` write is the
 *     last act of `deliverRunResult`; absence implies the deliver path
 *     never completed. Ergo: the run might be mid-resume on another
 *     process. Skip.
 *   - **Active-resume safety**: a run with a non-stale `.resume.lock`
 *     is excluded. Stale locks are NOT honored.
 *
 * GC is not automatic in v1 (PRD §6.7 last paragraph). The handler
 * must be invoked explicitly via `/workflows gc [--apply]`.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LedgerReader, TERMINAL_STATES } from "./ledger.js";
import { runsHome } from "../util/paths.js";
import { resumeLockPath, readResumeLock, isParentAlive } from "./runLock.js";
import { pruneAgentWorktree, type ExecFileLike } from "./worktree.js";
import type { RunOutcome, RunState, RunManifest } from "../types/internal.js";

export interface GcCandidate {
  readonly runId: string;
  readonly runDir: string;
  readonly outcome: RunOutcome | "unknown";
  readonly endedAt: string | null;
  readonly ageDays: number;
  readonly reason: "older-than-cutoff" | "matches-criteria";
}

export interface GcSkipped {
  readonly runId: string;
  readonly reason:
    | "non-terminal"
    | "missing-result-json"
    | "active-resume-lock"
    | "younger-than-cutoff"
    | "missing-manifest"
    | "read-error"
    | "has-fork-children";
  readonly details?: string;
}

export interface GcResult {
  readonly scanned: number;
  readonly candidates: ReadonlyArray<GcCandidate>;
  readonly skipped: ReadonlyArray<GcSkipped>;
  readonly deleted: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<{ readonly runId: string; readonly message: string }>;
  readonly cutoffDays: number;
  readonly applied: boolean;
}

export interface GcOptions {
  /** Override runs root. Default: `~/.pi/agent/workflows/runs/`. */
  readonly runsRootOverride?: string;
  /** Number of days a run must be older than to qualify. Default 30. */
  readonly cutoffDays?: number;
  /** Test seam: `now()` for age calculation. */
  readonly nowMs?: () => number;
  /** Actually delete (`rm -rf`) candidates. Default false. */
  readonly apply?: boolean;
  /** Test seam — override resolveLedgerPath. */
  readonly resolveLedgerPath?: (runId: string) => string;
  /**
   * ZONE_WORKTREE follow-up #1 — when true, `git worktree remove` is
   * invoked on each entry in `manifest.agentWorktrees` BEFORE the
   * runDir is deleted (apply mode). Skips dirty worktrees with a warn.
   * No effect when `apply` is false. Default true.
   */
  readonly pruneWorktrees?: boolean;
  /**
   * ZONE_WORKTREE follow-up #1 — when true, dirty worktrees are
   * removed via `git worktree remove --force`. Use this when the
   * operator has confirmed the diffs are no longer needed (e.g.
   * scripted batch GC). Default false.
   */
  readonly forceRemoveDirtyWorktrees?: boolean;
  /**
   * ZONE_TIMETRAVEL polish (recursive-fork GC). When `false` (default),
   * a candidate that has surviving forks (any other run's manifest
   * carries `parentRunId === <this>`) is REFUSED — the candidate is
   * moved to `skipped` with reason `"has-fork-children"`. When `true`,
   * the parent is deleted anyway and each surviving fork's manifest
   * is patched with `parentDeletedAt: <iso>` plus a `log: warn`
   * tombstone ledger line so observability tools can render the
   * broken-lineage state. Has no effect when `apply` is false.
   */
  readonly force?: boolean;
  /** Test seam: replace execFile for git invocations during prune. */
  readonly _execFile?: ExecFileLike;
  /** Log sink. */
  readonly log?: (
    level: "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;
}

const TERMINAL_TO_OUTCOME: Record<string, RunOutcome> = {
  done: "done",
  failed: "failed",
  stopped: "stopped",
  "cancelled-pre-run": "cancelled-pre-run",
};

interface ResultJson {
  readonly endedAt?: string;
  readonly outcome?: RunOutcome;
}

function readResultJson(runDirAbs: string): ResultJson | null {
  const path = join(runDirAbs, "result.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ResultJson;
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface LastTransitionInfo {
  readonly state: RunState;
  readonly at: string | null;
}

async function readLastTransition(
  runId: string,
  resolveLedgerPath?: (runId: string) => string,
): Promise<LastTransitionInfo | null> {
  const reader = new LedgerReader({
    runId,
    ...(resolveLedgerPath ? { resolveLedgerPath } : {}),
  });
  const { entries, finalState } = await reader.read();
  // Walk backwards for the last transition's timestamp.
  let at: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "transition" && e.to === finalState) {
      at = e.at;
      break;
    }
  }
  return { state: finalState, at };
}

function ageDays(endedAtIso: string, nowMs: number): number {
  const t = Date.parse(endedAtIso);
  if (!Number.isFinite(t)) return 0;
  return (nowMs - t) / (1000 * 60 * 60 * 24);
}

/**
 * Walk runs root and identify GC candidates. Returns `GcResult`. When
 * `apply=true` actually deletes each candidate's run dir. The result
 * always lists `candidates` (what would be deleted in a dry-run); on
 * apply, `deleted` is the subset that actually got rm'd.
 */
export async function runGc(opts: GcOptions = {}): Promise<GcResult> {
  const runsRoot = opts.runsRootOverride ?? runsHome();
  const cutoffDays = opts.cutoffDays ?? 30;
  const nowMs = (opts.nowMs ?? (() => Date.now()))();
  const apply = opts.apply === true;
  const log = opts.log;

  const result: {
    scanned: number;
    candidates: GcCandidate[];
    skipped: GcSkipped[];
    deleted: string[];
    errors: { runId: string; message: string }[];
    cutoffDays: number;
    applied: boolean;
  } = {
    scanned: 0,
    candidates: [],
    skipped: [],
    deleted: [],
    errors: [],
    cutoffDays,
    applied: apply,
  };

  // GC is opt-in via cutoffDays >= 1; cutoffDays=0 means "disabled"
  // per PRD §6.7. We surface this as a no-op rather than a delete-all.
  if (cutoffDays === 0) {
    log?.("info", "gc: disabled (cutoffDays=0)");
    return result;
  }
  // Sanity clamp: cap at 15 years per PRD §6.7.
  const effectiveCutoff = cutoffDays > 5475 ? 5475 : cutoffDays;
  if (effectiveCutoff !== cutoffDays) {
    log?.(
      "warn",
      `gc: cutoffDays=${cutoffDays} clamped to 5475 (15y) per PRD \u00a76.7`,
    );
  }
  result.cutoffDays = effectiveCutoff;

  if (!existsSync(runsRoot)) {
    return result;
  }
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch (err) {
    result.errors.push({
      runId: "<runsRoot>",
      message: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  // ZONE_TIMETRAVEL polish — build a fork-children index BEFORE
  // scanning candidates. For each `wf-...` run dir, read its
  // manifest's `parentRunId` and bucket the child runId under the
  // parent. Children whose `parentRunId` doesn't appear in the
  // runs-root set are surfaced as orphans (a log warning) but still
  // included in the index so they don't block any GC of OTHER runs.
  const childrenByParent = new Map<string, string[]>();
  const runIdSet = new Set<string>(
    entries.filter((e) => e.startsWith("wf-")),
  );
  for (const entry of entries) {
    if (!entry.startsWith("wf-")) continue;
    const childManifest = readManifestForGc(join(runsRoot, entry));
    if (
      childManifest === null ||
      typeof childManifest.parentRunId !== "string" ||
      childManifest.parentRunId.length === 0
    ) {
      continue;
    }
    const parentId = childManifest.parentRunId;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(entry);
    childrenByParent.set(parentId, list);
    if (!runIdSet.has(parentId)) {
      log?.(
        "warn",
        `gc: orphan fork ${entry} — parent ${parentId} not present in runs root`,
        { child: entry, parent: parentId },
      );
    }
  }

  for (const entry of entries) {
    if (!entry.startsWith("wf-")) continue;
    const runDir = join(runsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(runDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    result.scanned++;
    try {
      await scanOne({
        runId: entry,
        runDir,
        nowMs,
        cutoffDays: effectiveCutoff,
        result,
        log,
        ...(opts.resolveLedgerPath ? { resolveLedgerPath: opts.resolveLedgerPath } : {}),
      });
    } catch (err) {
      result.errors.push({
        runId: entry,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Optionally delete candidates.
  if (apply) {
    const pruneWorktrees = opts.pruneWorktrees !== false; // default ON
    const force = opts.force === true;
    // ZONE_TIMETRAVEL polish — first pass: any candidate that has
    // surviving forks is moved to `skipped` (when `force === false`).
    // We do this BEFORE the worktree-prune loop so refused candidates
    // never have their worktrees removed. "Surviving" = the fork's
    // run dir is on disk RIGHT NOW; whether the fork is itself a GC
    // candidate in this same pass is irrelevant. The user-visible
    // contract is "don't silently break a lineage chain on a single
    // pass" — if both A and B are eligible, the operator can re-run
    // GC after B is deleted (lineage is auto-broken on the next pass).
    const survivors: GcCandidate[] = [];
    for (const c of result.candidates) {
      const liveChildren = (childrenByParent.get(c.runId) ?? []).filter(
        (childId) => runIdSet.has(childId),
      );
      if (liveChildren.length === 0) {
        survivors.push(c);
        continue;
      }
      if (!force) {
        result.skipped.push({
          runId: c.runId,
          reason: "has-fork-children",
          details: `forks: [${liveChildren.join(", ")}]; pass force:true to override`,
        });
        log?.(
          "warn",
          `gc: refused ${c.runId} — ${liveChildren.length} surviving fork(s); pass force:true to override`,
          { children: liveChildren },
        );
        continue;
      }
      // force === true — mark each surviving fork's manifest with
      // `parentDeletedAt: <iso>` AND append a `log: warn` tombstone
      // ledger line. Both are best-effort — a single fork-side
      // failure must not abort the parent's GC.
      const tombstoneAt = new Date(nowMs).toISOString();
      for (const childId of liveChildren) {
        const childDir = join(runsRoot, childId);
        try {
          patchManifestParentDeletedAt(childDir, c.runId, tombstoneAt);
        } catch (err) {
          log?.(
            "warn",
            `gc: failed to patch tombstone in ${childId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          appendTombstoneLedgerLine(
            childDir,
            c.runId,
            tombstoneAt,
          );
        } catch (err) {
          log?.(
            "warn",
            `gc: failed to append tombstone ledger line in ${childId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        log?.(
          "warn",
          `gc: force-delete — marked ${childId} with parentDeletedAt=${tombstoneAt} (parent ${c.runId})`,
          { child: childId, parent: c.runId, at: tombstoneAt },
        );
      }
      survivors.push(c);
    }
    // Replace the candidates list with the survivor subset — callers
    // see exactly which runs were both eligible AND not blocked by
    // surviving forks.
    result.candidates = survivors;
    for (const c of survivors) {
      // ZONE_WORKTREE follow-up #1: prune any per-agent worktrees
      // recorded in this run's manifest BEFORE rm-rf'ing the runDir.
      // Otherwise `git worktree list` keeps stale entries pointing into
      // a non-existent dir until the next `git worktree prune`.
      if (pruneWorktrees) {
        const manifest = readManifestForGc(c.runDir);
        const agentTrees = manifest?.agentWorktrees ?? null;
        if (agentTrees && manifest?.cwd) {
          for (const [agentId, dir] of Object.entries(agentTrees)) {
            if (typeof dir !== "string" || dir.length === 0) continue;
            try {
              const r = await pruneAgentWorktree({
                worktreePath: dir,
                sourceCwd: manifest.cwd,
                ...(opts.forceRemoveDirtyWorktrees ? { force: true } : {}),
                ...(opts._execFile ? { _execFile: opts._execFile } : {}),
              });
              if (r.removed) {
                log?.(
                  "info",
                  `gc: pruned worktree ${agentId} (${c.runId})`,
                  { dir, reason: r.reason },
                );
              } else if (r.skippedDirty) {
                log?.(
                  "warn",
                  `gc: skipped dirty worktree ${agentId} (${c.runId}); pass forceRemoveDirtyWorktrees:true to override`,
                  { dir, reason: r.reason },
                );
              } else {
                log?.(
                  "info",
                  `gc: worktree ${agentId} (${c.runId}) noop`,
                  { dir, reason: r.reason },
                );
              }
            } catch (err) {
              log?.(
                "warn",
                `gc: prune worktree ${agentId} (${c.runId}) failed: ${err instanceof Error ? err.message : String(err)}`,
                { dir },
              );
            }
          }
        }
      }
      try {
        rmSync(c.runDir, { recursive: true, force: true });
        result.deleted.push(c.runId);
        log?.("info", `gc: deleted ${c.runId}`, { runDir: c.runDir });
      } catch (err) {
        result.errors.push({
          runId: c.runId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/**
 * Read just the worktree-relevant fields out of `<runDir>/manifest.json`
 * for GC's prune step. Returns `null` if the file is absent or unreadable
 * (the caller treats both as "no worktrees to prune").
 *
 * Also surfaces fork-lineage fields (`parentRunId`, `forkAtPhase`,
 * `parentDeletedAt`) so the recursive-fork GC pass can index children
 * by parent without re-parsing the manifest.
 */
function readManifestForGc(
  runDirAbs: string,
): (Pick<RunManifest, "cwd"> & {
  agentWorktrees?: Record<string, string>;
  parentRunId?: string;
  forkAtPhase?: string;
  parentDeletedAt?: string;
}) | null {
  const path = join(runDirAbs, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Pick<RunManifest, "cwd"> & {
        agentWorktrees?: Record<string, string>;
        parentRunId?: string;
        forkAtPhase?: string;
        parentDeletedAt?: string;
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * ZONE_TIMETRAVEL polish — tombstone helpers for force-delete of a
 * parent run that has surviving forks. Patch the child fork's
 * `manifest.json` with `parentDeletedAt: <iso>` and append a
 * `log: warn` ledger line documenting the broken lineage. Both are
 * synchronous (the caller is in the apply loop, which is sync
 * w.r.t. each candidate); both throw on disk error so the caller's
 * try/catch can surface the failure as a `gc.errors` entry.
 */
function patchManifestParentDeletedAt(
  childRunDirAbs: string,
  parentRunId: string,
  atIso: string,
): void {
  const target = join(childRunDirAbs, "manifest.json");
  if (!existsSync(target)) return; // child manifest gone — nothing to do
  const raw = readFileSync(target, "utf-8");
  let parsed: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    const candidate = JSON.parse(raw) as unknown;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      parsed = candidate as Record<string, unknown>;
    }
  }
  // Idempotent: don't overwrite a prior tombstone (the earlier write
  // wins; force-deleting an already-orphaned parent again is a no-op
  // for the manifest payload).
  if (typeof parsed["parentDeletedAt"] === "string") return;
  parsed["parentDeletedAt"] = atIso;
  // Sanity: the parent we're tombstoning should match the child's
  // recorded parentRunId. If the manifest doesn't carry one (caller
  // bug), still write the field — the caller has surfaced the
  // intent.
  if (
    typeof parsed["parentRunId"] !== "string" ||
    parsed["parentRunId"] !== parentRunId
  ) {
    // Don't refuse — just record the attempted parent so debugging
    // can pinpoint the mismatch.
    parsed["parentDeletedFrom"] = parentRunId;
  }
  // Atomic tmp+rename so a concurrent reader never sees a torn JSON.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  renameSync(tmp, target);
}

function appendTombstoneLedgerLine(
  childRunDirAbs: string,
  parentRunId: string,
  atIso: string,
): void {
  const target = join(childRunDirAbs, "ledger.jsonl");
  // Append a single `log: warn` line. We use the existing `log`
  // discriminator (no schema change required) so existing readers
  // surface the message verbatim.
  const line =
    JSON.stringify({
      type: "log",
      at: atIso,
      level: "warn",
      message: `parent run ${parentRunId} deleted by force GC at ${atIso}`,
    }) + "\n";
  appendFileSync(target, line, { encoding: "utf-8", mode: 0o644 });
}

async function scanOne(args: {
  runId: string;
  runDir: string;
  nowMs: number;
  cutoffDays: number;
  result: {
    candidates: GcCandidate[];
    skipped: GcSkipped[];
  };
  log?: GcOptions["log"];
  resolveLedgerPath?: (runId: string) => string;
}): Promise<void> {
  // 1. Active-resume lock check — never delete a run that's being
  //    actively resumed (lockfile exists + holder is alive).
  if (existsSync(resumeLockPath(args.runDir))) {
    const lock = readResumeLock(args.runDir);
    if (
      lock &&
      isParentAlive({ parentPid: lock.pid, parentBootId: lock.bootId })
    ) {
      args.result.skipped.push({
        runId: args.runId,
        reason: "active-resume-lock",
      });
      return;
    }
    // Stale lock — fall through. v1 leaves the stale lock for the
    // operator; gc doesn't unlink locks itself.
  }

  // 2. Ledger replay → terminal-state check.
  const last = await readLastTransition(args.runId, args.resolveLedgerPath);
  if (last === null || !TERMINAL_STATES.has(last.state)) {
    args.result.skipped.push({
      runId: args.runId,
      reason: "non-terminal",
    });
    return;
  }

  // 3. result.json must exist (mid-resume safety).
  const resultJson = readResultJson(args.runDir);
  if (resultJson === null) {
    args.result.skipped.push({
      runId: args.runId,
      reason: "missing-result-json",
    });
    return;
  }

  // 4. Age calculation. Prefer result.json's endedAt; fall back to
  //    the last transition's `at`.
  const endedAtIso =
    typeof resultJson.endedAt === "string" && resultJson.endedAt.length > 0
      ? resultJson.endedAt
      : last.at;
  if (endedAtIso === null) {
    args.result.skipped.push({
      runId: args.runId,
      reason: "missing-result-json",
      details: "no endedAt in result.json or ledger transition",
    });
    return;
  }
  const age = ageDays(endedAtIso, args.nowMs);
  if (age < args.cutoffDays) {
    args.result.skipped.push({
      runId: args.runId,
      reason: "younger-than-cutoff",
      details: `age=${age.toFixed(2)}d cutoff=${args.cutoffDays}d`,
    });
    return;
  }

  // Outcome — prefer result.json, fall back to mapping the state.
  const outcome: RunOutcome | "unknown" =
    typeof resultJson.outcome === "string"
      ? resultJson.outcome
      : (TERMINAL_TO_OUTCOME[last.state] ?? "unknown");

  args.result.candidates.push({
    runId: args.runId,
    runDir: args.runDir,
    outcome,
    endedAt: endedAtIso,
    ageDays: age,
    reason: "older-than-cutoff",
  });
  args.log?.("info", `gc: candidate ${args.runId}`, {
    age,
    cutoff: args.cutoffDays,
    outcome,
  });
}
