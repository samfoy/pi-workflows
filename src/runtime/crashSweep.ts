/**
 * pi-workflows — slice 11 crash-sweep on session_start.
 *
 * Per PRD §5.8.2 every `session_start { reason: "new" | "resume" }`
 * scans `~/.pi/agent/workflows/runs/<runId>/manifest.json` for non-terminal
 * runs whose owning pi process is no longer alive. For each:
 *
 *   1. Read `parentPid` + `parentBootId` from the manifest (slice 6
 *      wrote those).
 *   2. Liveness check via `isParentAlive`:
 *        - bootId mismatch → host rebooted; parent is gone.
 *        - PID exists but in a different boot → gone.
 *        - PID exists in the current boot → alive (an unrelated pi
 *          process owns the run; leave it).
 *        - PID does not exist → gone.
 *   3. If gone, append a `transition <latest> → failed` entry with
 *      `reason: "parent-crash"` to the ledger (and update manifest's
 *      `crashSweepAt` field — slice 11-extended manifest).
 *   4. If still alive, leave the run alone.
 *
 * Concurrency: two pi processes hitting the same orphan during their
 * respective `session_start` is safe because (a) ledger appends are
 * atomic at the OS write boundary and (b) the second sweep sees a
 * terminal state and skips. The worst case is two `parent-crash`
 * transition lines, which the reader already de-duplicates by virtue
 * of `replayState` skipping `<terminal> → failed` (illegal).
 *
 * Slice 11 [C4]: `cancelled-pre-run` is a terminal state and is NEVER
 * touched by sweep (skipped via `TERMINAL_STATES`).
 *
 * Liveness-check substrate exposed for `runLock.ts` to share the
 * exact same staleness rules.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerWriter,
  LedgerReader,
  TERMINAL_STATES,
} from "./ledger.js";
import { runsHome, manifestPath } from "../util/paths.js";
import type { LedgerEntry, RunState } from "../types/internal.js";
import type { ResumeOptions } from "./resumeRun.js";
import type { Run } from "../runManager.js";
import type { ActiveRunsRegistry } from "./activeRuns.js";

// ─── Liveness primitives ──────────────────────────────────────────────

/**
 * Read `/proc/sys/kernel/random/boot_id` on Linux. Returns empty
 * string on macOS / containers / chroot / any error. The empty string
 * is a sentinel meaning "we don't know the boot id for this host" —
 * pair it with parentBootId="" to skip the bootId check.
 */
export function currentBootId(): string {
  if (process.platform !== "linux") return "";
  try {
    if (existsSync("/proc/sys/kernel/random/boot_id")) {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Read another process's snapshotted bootId (always empty on macOS). */
export function readBootId(): string {
  return currentBootId();
}

/**
 * Combined liveness predicate per PRD §5.8.2:
 *   - bootId mismatch → host rebooted → parent is dead
 *   - bootId match + PID exists → alive
 *   - bootId match + PID gone → dead
 *
 * If `parentBootId` is empty (macOS / container) we fall back to the
 * pid-only check. Documented limitation: on PID-recycle the sweep can
 * see a foreign live process and decline to sweep an actually-dead
 * parent. The dispatcher's `parentStartTime` field is the v2 fix; v1
 * accepts this footgun.
 */
export function isParentAlive(opts: {
  parentPid: number;
  parentBootId: string;
}): boolean {
  if (!Number.isFinite(opts.parentPid) || opts.parentPid <= 0) return false;
  // BootId mismatch is the strongest signal — host rebooted.
  const myBoot = currentBootId();
  if (
    myBoot.length > 0 &&
    opts.parentBootId.length > 0 &&
    opts.parentBootId !== myBoot
  ) {
    return false;
  }
  // PID-existence check via signal=0 (POSIX). EPERM also implies
  // alive (process exists; we just can't signal it).
  try {
    process.kill(opts.parentPid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

// ─── Sweep implementation ────────────────────────────────────────────

export interface CrashSweepResult {
  /** Number of run-dirs scanned. */
  readonly scanned: number;
  /** Run IDs whose state was flipped to `failed`. */
  readonly transitioned: ReadonlyArray<{
    readonly runId: string;
    readonly fromState: RunState;
  }>;
  /** Run IDs that were already terminal — sweep skipped. */
  readonly skippedTerminal: ReadonlyArray<string>;
  /** Run IDs whose parent was still alive — sweep skipped. */
  readonly skippedAlive: ReadonlyArray<string>;
  /** Errors encountered (per-run; non-fatal). */
  readonly errors: ReadonlyArray<{
    readonly runId: string;
    readonly message: string;
  }>;
  /**
   * Run IDs successfully auto-resumed (only populated when
   * `autoResume: true` was set in options).
   */
  readonly resumed: ReadonlyArray<string>;
  /**
   * Run IDs that failed to auto-resume (only populated when
   * `autoResume: true` was set in options).
   */
  readonly resumeFailed: ReadonlyArray<{
    readonly runId: string;
    readonly message: string;
  }>;
}

export interface CrashSweepOptions {
  /** Override runs root. Defaults to `~/.pi/agent/workflows/runs/`. */
  readonly runsRootOverride?: string;
  /** Override liveness predicate (test seam). */
  readonly isAlive?: (opts: { parentPid: number; parentBootId: string }) => boolean;
  /** Override the resolver from runId → ledger path (test seam). */
  readonly resolveLedgerPath?: (runId: string) => string;
  /** Override the resolver from runId → manifest path (test seam). */
  readonly resolveManifestPath?: (runId: string) => string;
  /** Test seam — deterministic ISO timestamps. */
  readonly nowIso?: () => string;
  /** Log sink for individual sweep events. */
  readonly log?: (
    level: "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;
  /**
   * When true, each run flipped to `failed: parent-crash` is
   * automatically resumed via `resumeRun`. Off by default.
   * Requires `activeRuns` if the resumed run should be registered
   * in the active-runs registry.
   */
  readonly autoResume?: boolean;
  /** Active-runs registry forwarded to each `resumeRun` call. */
  readonly activeRuns?: ActiveRunsRegistry;
  /**
   * Test seam: override the resume implementation so tests don't need
   * to stand up the full sandbox stack. Defaults to the real
   * `resumeRun` when `autoResume: true`.
   */
  readonly resumeRunFn?: (
    runId: string,
    opts: ResumeOptions,
  ) => Promise<Run>;
}

interface ManifestPartial {
  readonly runId?: string;
  readonly workflowName?: string;
  readonly parentPid?: number;
  readonly parentBootId?: string;
  readonly parentStartTime?: string;
}

function readManifest(path: string): ManifestPartial | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ManifestPartial;
    }
  } catch {
    /* ignore — corrupt manifests are surfaced as errors below */
  }
  return null;
}

/**
 * Sweep all runs under `runsRoot`. Per-run errors are collected (not
 * thrown) so a single corrupt directory can't block the sweep.
 */
export async function sweepCrashedRuns(
  opts: CrashSweepOptions = {},
): Promise<CrashSweepResult> {
  const runsRoot = opts.runsRootOverride ?? runsHome();
  const isAlive = opts.isAlive ?? isParentAlive;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());

  const result: {
    scanned: number;
    transitioned: { runId: string; fromState: RunState }[];
    skippedTerminal: string[];
    skippedAlive: string[];
    errors: { runId: string; message: string }[];
    resumed: string[];
    resumeFailed: { runId: string; message: string }[];
  } = {
    scanned: 0,
    transitioned: [],
    skippedTerminal: [],
    skippedAlive: [],
    errors: [],
    resumed: [],
    resumeFailed: [],
  };

  if (!existsSync(runsRoot)) {
    return result;
  }
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ runId: "<runsRoot>", message: msg });
    return result;
  }

  for (const entry of entries) {
    const runDir = join(runsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(runDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!entry.startsWith("wf-")) continue;
    result.scanned++;
    try {
      await sweepOne({
        runId: entry,
        runDir,
        isAlive,
        nowIso,
        result,
        ...(opts.log !== undefined ? { log: opts.log } : {}),
        ...(opts.resolveLedgerPath !== undefined
          ? { resolveLedgerPath: opts.resolveLedgerPath }
          : {}),
        ...(opts.resolveManifestPath !== undefined
          ? { resolveManifestPath: opts.resolveManifestPath }
          : {}),
      });
    } catch (err) {
      result.errors.push({
        runId: entry,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Auto-resume: for each run flipped to `failed: parent-crash`, try
  // to resume it. Fire sequentially so the active-runs registry doesn't
  // get hammered all at once.
  if (opts.autoResume === true && result.transitioned.length > 0) {
    // Lazy-load resumeRun to avoid pulling the sandbox stack when
    // autoResume is off (the common case).
    const resumeFn =
      opts.resumeRunFn ??
      (await import("./resumeRun.js")).resumeRun;

    for (const t of result.transitioned) {
      try {
        const run = await resumeFn(t.runId, {
          useLatest: false,
          preApproved: true,
          ...(opts.activeRuns !== undefined ? { activeRuns: opts.activeRuns } : {}),
        });
        // Fire-and-forget: we don't await the run's completion here.
        run.promise.catch(() => undefined);
        result.resumed.push(t.runId);
        opts.log?.("info", `sweep: auto-resumed ${t.runId}`, {
          runId: t.runId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.resumeFailed.push({ runId: t.runId, message: msg });
        opts.log?.("warn", `sweep: auto-resume failed for ${t.runId}: ${msg}`, {
          runId: t.runId,
        });
      }
    }
  }

  return result;
}

async function sweepOne(args: {
  runId: string;
  runDir: string;
  isAlive: (opts: { parentPid: number; parentBootId: string }) => boolean;
  nowIso: () => string;
  result: {
    transitioned: { runId: string; fromState: RunState }[];
    skippedTerminal: string[];
    skippedAlive: string[];
    errors: { runId: string; message: string }[];
    resumed: string[];
    resumeFailed: { runId: string; message: string }[];
  };
  log?: CrashSweepOptions["log"];
  resolveLedgerPath?: (runId: string) => string;
  resolveManifestPath?: (runId: string) => string;
}): Promise<void> {
  const manifPath = args.resolveManifestPath
    ? args.resolveManifestPath(args.runId)
    : manifestPath(args.runId);
  // Use the actual on-disk path for the manifest (the resolver hints
  // at `~/.pi/agent/workflows/runs/<runId>/manifest.json`; tests
  // override via `resolveManifestPath`).
  const manifest = readManifest(manifPath);
  if (manifest === null) {
    // No manifest in a runs/<wf-id>/ dir is unusual but not fatal —
    // a partially-created run dir from a slice-8a crash before the
    // manifest write. Skip silently.
    return;
  }

  // Read ledger to determine current state.
  const reader = new LedgerReader({
    runId: args.runId,
    ...(args.resolveLedgerPath ? { resolveLedgerPath: args.resolveLedgerPath } : {}),
  });
  const { finalState } = await reader.read();
  if (TERMINAL_STATES.has(finalState)) {
    args.result.skippedTerminal.push(args.runId);
    return;
  }

  const parentPid = manifest.parentPid;
  const parentBootId = manifest.parentBootId ?? "";
  if (typeof parentPid !== "number") {
    args.result.errors.push({
      runId: args.runId,
      message: "manifest missing parentPid; cannot determine liveness",
    });
    return;
  }
  if (args.isAlive({ parentPid, parentBootId })) {
    args.result.skippedAlive.push(args.runId);
    args.log?.("info", `sweep: parent ${parentPid} alive — skipping`, {
      runId: args.runId,
    });
    return;
  }

  // Parent is dead. Append a `transition <finalState> → failed` entry
  // with reason: parent-crash.
  const writer = new LedgerWriter({
    runId: args.runId,
    ...(args.resolveLedgerPath ? { resolveLedgerPath: args.resolveLedgerPath } : {}),
  });
  const entry: LedgerEntry = {
    type: "transition",
    at: args.nowIso(),
    from: finalState,
    to: "failed",
    reason: "parent-crash",
  };
  await writer.append(entry);
  await writer.flush();
  args.result.transitioned.push({ runId: args.runId, fromState: finalState });
  args.log?.("warn", `sweep: ${args.runId} transitioned to failed: parent-crash`, {
    runId: args.runId,
    fromState: finalState,
    parentPid,
  });
}
