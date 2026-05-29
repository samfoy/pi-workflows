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

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { LedgerReader, TERMINAL_STATES } from "./ledger.js";
import { runsHome } from "../util/paths.js";
import { resumeLockPath, readResumeLock, isParentAlive } from "./runLock.js";
import type { RunOutcome, RunState } from "../types/internal.js";

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
    | "read-error";
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
    for (const c of result.candidates) {
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
