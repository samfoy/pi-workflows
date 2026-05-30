/**
 * pi-workflows — slice 11 resume orchestration.
 *
 * `/workflows resume <runId>` reconstructs a Run handle from disk and
 * re-executes the workflow with `ctx.run.resumed = true`. Per PRD
 * \u00a75.8 the resume contract is:
 *
 *   1. Validate runId (existing run-dir, manifest readable, ledger
 *      replayable).
 *   2. Validate resumability — state must be in `{paused, running,
 *      failed (with reason=parent-crash)}`. Other terminal states
 *      (`done`, `failed` w/o sweep reason, `stopped`,
 *      `cancelled-pre-run`) error with a clear message.
 *   3. Acquire `<runDir>/.resume.lock` to prevent concurrent resume
 *      from a sibling pi process.
 *   4. Approval gate: re-prompt unless the script's sha256 matches
 *      a previously-trusted entry.
 *   5. Read FROZEN `<runDir>/script.js` (NOT the live workflow file)
 *      so author edits don't break bit-exact replay. `--latest`
 *      switches to the live file and emits the documented warning.
 *   6. Construct fresh sandbox + RunCtx with `resumed=true`. Append
 *      a `resume` ledger entry. State machine starts at `running`
 *      (no `pending\u2192approved` transitions). Sweep-flipped runs
 *      (`failed: parent-crash`) get a `failed\u2192running` reset
 *      transition (illegal under \u00a75.2 strictly, but slice 11 documents
 *      this as the resume "advisory rollback").
 *   7. The cache is the resume primitive: cache hits cover already-
 *      completed agents; only the still-pending phase agents are
 *      dispatched.
 *
 * Resume idempotency (plan slice 11 \u00a7D): per-runDir lockfile prevents
 * two pi processes from concurrent resume.
 *
 * Slice 11 [C4]: `cancelled-pre-run` is terminal-non-resumable; the
 * resume command MUST error with a clear message.
 */

import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";

import type {
  ApprovalDialog,
  ApprovalGateOptions,
  ExtensionAPI,
  RunManifest,
  RunMetaData,
  RunOptions,
  RunOutcome,
  WorkflowFile,
} from "../types/internal.js";
import { CacheStore } from "./cache.js";
import {
  LedgerWriter,
  LedgerReader,
  RunStateMachine,
  RESUMABLE_STATES,
  buildResultEntry,
} from "./ledger.js";
import { Sandbox } from "./sandbox.js";
import { captureError } from "./realmError.js";
import { createRunCtxHost } from "./runCtx.js";
import { PauseGate } from "./pauseGate.js";
import { makeSemaphore } from "./semaphore.js";
import { runApprovalGate } from "./approval.js";
import { acquireResumeLock, ResumeLockedError } from "./runLock.js";
import { sha256 } from "../util/hash.js";
import { runDir as runDirFor } from "../util/paths.js";
import {
  Run,
  RunCancelledError,
  RunTerminalInfo,
} from "../runManager.js";

/** Verbatim warning per PRD \u00a75.8.1 \u2014 emitted on `--latest`. */
export const LATEST_CACHE_WARNING =
  "\u26a0  /workflows resume <runId> --latest: cache will mostly miss (script\n" +
  "   sha256 differs). To preserve cache across edits, use explicit\n" +
  "   cacheKeyExtra on individual agents.";

/**
 * Thrown when resume is attempted on a non-resumable run. Carries
 * enough info for the slash-command handler to print a useful
 * message + the result-file path.
 */
export class ResumeNotAllowedError extends Error {
  readonly runId: string;
  readonly runDirAbs: string;
  readonly currentState: string;
  readonly resultFilePath: string | null;
  constructor(opts: {
    runId: string;
    runDirAbs: string;
    currentState: string;
    resultFilePath: string | null;
  }) {
    super(
      `cannot resume run ${opts.runId}: state=${opts.currentState} is terminal-non-resumable. ` +
        (opts.resultFilePath
          ? `See result.json at ${opts.resultFilePath}.`
          : "No result.json was produced."),
    );
    this.name = "ResumeNotAllowedError";
    this.runId = opts.runId;
    this.runDirAbs = opts.runDirAbs;
    this.currentState = opts.currentState;
    this.resultFilePath = opts.resultFilePath;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} not found in runs root`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export interface ResumeOptions {
  /** Test seam \u2014 override runDir resolver. */
  readonly resolveRunDir?: (runId: string) => string;
  /** Test seam \u2014 override ledger path resolver. */
  readonly resolveLedgerPath?: (runId: string) => string;
  /**
   * `--latest` flag \u2014 read the live workflow file instead of the
   * frozen `<runDir>/script.js`. Cache will mostly miss because the
   * script's sha256 will likely differ. The warning is emitted via
   * `onLatestWarning` (which the slash-command handler routes to
   * `pi.sendMessage`).
   */
  readonly useLatest?: boolean;
  /** Test seam: warning emitter when `--latest` is used. */
  readonly onLatestWarning?: (warning: string) => void;
  /**
   * Approval block (slice 9 shape). Required: resume re-prompts unless
   * the script hash matches an existing trust row. Tests can pass a
   * dialog that always returns "always" to bypass.
   */
  readonly approval?: Pick<
    ApprovalGateOptions,
    "dialog" | "viewer" | "env" | "home" | "trustOverride" |
    "projectSettingsPathOverride" | "personalSettingsPathOverride" |
    "onPersistError"
  >;
  /** Test-only: skip approval entirely (matches startWorkflowRun's contract). */
  readonly preApproved?: boolean;
  /**
   * Override the cwd used for trust scope detection. Default: the
   * `cwd` field in the manifest.
   */
  readonly cwdOverride?: string;
  readonly mockAgents?: boolean;
  readonly nowIso?: () => string;
  readonly nowMs?: () => number;
  /** Test seam \u2014 dispatcher mock. */
  readonly dispatch?: Parameters<typeof createRunCtxHost>[0]["dispatch"];
  /** Banner emitter for `bypass-permissions` paths. */
  readonly emitBanner?: (banner: string) => void;
  /**
   * pi.sendUserMessage for finishCallback delivery. Optional; the
   * slash-command handler usually wires it.
   */
  readonly pi?: ExtensionAPI;
  /**
   * Slice 13/F3: same registry hookup as `startWorkflowRun`. When
   * supplied, the resumed `Run` handle is registered for hotkey/
   * `/workflows kill` discovery.
   */
  readonly activeRuns?: import("./activeRuns.js").ActiveRunsRegistry;
}

interface ResumeManifest extends Partial<RunManifest> {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowAbsPath: string;
  readonly workflowSourceSha256: string;
}

async function readManifestStrict(runDirAbs: string): Promise<ResumeManifest> {
  const path = join(runDirAbs, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`manifest.json missing in ${runDirAbs}`);
  }
  const raw = await fs.readFile(path, "utf-8");
  if (raw.trim().length === 0) {
    throw new Error(`manifest.json empty in ${runDirAbs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `manifest.json corrupt in ${runDirAbs}: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`manifest.json shape invalid in ${runDirAbs}`);
  }
  const m = parsed as Partial<RunManifest>;
  if (
    typeof m.runId !== "string" ||
    typeof m.workflowName !== "string" ||
    typeof m.workflowAbsPath !== "string" ||
    typeof m.workflowSourceSha256 !== "string"
  ) {
    throw new Error(
      `manifest.json missing required slice-8a fields (runId/workflowName/workflowAbsPath/workflowSourceSha256) in ${runDirAbs}`,
    );
  }
  return m as ResumeManifest;
}

/**
 * Resume a workflow run from disk. Returns a `Run` handle whose
 * lifecycle mirrors `startWorkflowRun` \u2014 same `terminated` Promise
 * shape so slice 10's `deliverRunResult` can consume it without a
 * branch.
 */
export async function resumeRun(
  runId: string,
  opts: ResumeOptions = {},
): Promise<Run> {
  const resolveRunDir = opts.resolveRunDir ?? runDirFor;
  const runDirAbs = resolveRunDir(runId);

  if (!existsSync(runDirAbs)) {
    throw new RunNotFoundError(runId);
  }

  const manifest = await readManifestStrict(runDirAbs);
  const cwd = opts.cwdOverride ?? manifest.cwd ?? process.cwd();

  // 1. Read ledger \u2014 derive current state.
  const reader = new LedgerReader({
    runId,
    ...(opts.resolveLedgerPath
      ? { resolveLedgerPath: opts.resolveLedgerPath }
      : {}),
  });
  const { entries, finalState } = await reader.read();

  // 2. Resumability check.
  // - cancelled-pre-run, done, stopped: terminal-non-resumable.
  // - failed: resumable ONLY if the most recent transition's reason
  //   is "parent-crash" (advisory crash-sweep rollback).
  // - paused, running, approved, pending: resumable.
  let resumable = false;
  if (RESUMABLE_STATES.has(finalState)) {
    resumable = true;
  } else if (finalState === "failed") {
    // Look for the latest transition with `to=failed` and check its
    // reason field.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "transition" && e.to === "failed") {
        if (e.reason === "parent-crash") resumable = true;
        break;
      }
    }
  }
  if (!resumable) {
    const resultFile = join(runDirAbs, "result.json");
    throw new ResumeNotAllowedError({
      runId,
      runDirAbs,
      currentState: finalState,
      resultFilePath: existsSync(resultFile) ? resultFile : null,
    });
  }

  // 3. Lock the runDir.
  const lock = acquireResumeLock({ runDirAbs, runId });

  try {
    // 4. Source resolution \u2014 frozen vs live.
    let sourceText: string;
    let workflowAbsPath: string;
    if (opts.useLatest) {
      // Live file. Emit the warning verbatim per PRD \u00a75.8.1.
      workflowAbsPath = manifest.workflowAbsPath;
      sourceText = await fs.readFile(workflowAbsPath, "utf-8");
      try {
        opts.onLatestWarning?.(LATEST_CACHE_WARNING);
      } catch {
        /* hook errors must not block resume */
      }
    } else {
      const frozenPath = join(runDirAbs, "script.js");
      if (!existsSync(frozenPath)) {
        // Fallback: read from the live file if we never wrote a
        // frozen copy (older slice didn't, slice 11 does). Document
        // this clearly in logs.
        workflowAbsPath = manifest.workflowAbsPath;
        sourceText = await fs.readFile(workflowAbsPath, "utf-8");
      } else {
        workflowAbsPath = frozenPath;
        sourceText = await fs.readFile(frozenPath, "utf-8");
      }
    }
    const liveSha = sha256(sourceText);

    // 5. Approval gate. Re-prompt unless trust matches.
    const workflow: WorkflowFile = {
      name: manifest.workflowName,
      absPath: manifest.workflowAbsPath,
      scope: "personal",
    };
    let approvalReason:
      | "trusted"
      | "user-always"
      | "user-once"
      | "bypass-permissions"
      | "sdk"
      | "pi-p-trusted"
      | "mock-agents"
      | null = null;
    if (opts.preApproved !== true && opts.approval !== undefined) {
      const decision = await runApprovalGate({
        workflowName: workflow.name,
        absPath: workflow.absPath,
        sha256: liveSha,
        cwd,
        ...(opts.mockAgents !== undefined ? { mockAgents: opts.mockAgents } : {}),
        ...opts.approval,
      });
      if (!decision.approved) {
        throw new RunCancelledError({
          runId,
          runDirAbs,
          cancelCause: decision.cancelCause,
          decision,
          message: decision.error ?? "resume cancelled by user",
        });
      }
      approvalReason = decision.reason;
      if (decision.banner !== undefined && opts.emitBanner) {
        try {
          opts.emitBanner(decision.banner);
        } catch {
          /* swallow */
        }
      }
    }

    // 6. Substrate.
    const startedAt = manifest.startedAt ?? new Date().toISOString();
    const resumedAt =
      (opts.nowIso ?? (() => new Date().toISOString()))();
    const runOptions: RunOptions = manifest.options ?? {
      mockAgents: opts.mockAgents === true,
      maxConcurrent: 16,
      perRunAgentCap: 1000,
      tokenBudget: null,
    };

    const ledger = new LedgerWriter({
      runId,
      ...(opts.resolveLedgerPath
        ? { resolveLedgerPath: opts.resolveLedgerPath }
        : { resolveLedgerPath: (id: string) => join(resolveRunDir(id), "ledger.jsonl") }),
    });
    const cacheStore = await CacheStore.open({
      runId,
      resolveCachePath: (id) => join(resolveRunDir(id), "cache.jsonl"),
      resolveCacheTmpPath: (id) => join(resolveRunDir(id), "cache.jsonl.tmp"),
    });
    const semaphore = makeSemaphore({ cap: runOptions.maxConcurrent });

    // 7. Append a `resume` ledger entry.
    await ledger.append({ type: "resume", at: resumedAt });

    // 8. State-machine reset for sweep-rollback. If we were `failed:
    //    parent-crash`, append an explicit transition to `running`
    //    with reason="resume-rollback". This is technically illegal
    //    under \u00a75.2 strict reading; document as the slice-11 advisory
    //    rollback (the sweep itself was advisory \u2014 PRD \u00a75.8.2).
    let initialState = finalState;
    if (finalState === "failed") {
      await ledger.append({
        type: "transition",
        at: resumedAt,
        from: "failed",
        to: "running",
        reason: "resume-rollback",
      });
      initialState = "running";
    } else if (finalState === "paused") {
      // paused \u2192 running is a legal user-initiated transition; record
      // it through the validator so replay sees a consistent log.
      await ledger.append({
        type: "transition",
        at: resumedAt,
        from: "paused",
        to: "running",
      });
      initialState = "running";
    } else if (finalState === "running") {
      // Already running \u2014 no transition entry.
      initialState = "running";
    } else if (finalState === "approved") {
      await ledger.append({
        type: "transition",
        at: resumedAt,
        from: "approved",
        to: "running",
      });
      initialState = "running";
    } else if (finalState === "pending") {
      await ledger.append({
        type: "transition",
        at: resumedAt,
        from: "pending",
        to: "approved",
      });
      await ledger.append({
        type: "transition",
        at: resumedAt,
        from: "approved",
        to: "running",
      });
      initialState = "running";
    }
    const sm = new RunStateMachine({
      writer: ledger,
      initialState,
      ...(opts.nowIso ? { now: opts.nowIso } : {}),
    });

    const ctrl = new AbortController();
    let userStopRequested = false;

    // Slice 12: resumed runs also get pause/stop primitives so the
    // TUI overlay can pause a previously-resumed run identically to
    // a fresh one.
    const pauseGate = new PauseGate();
    let controlChain: Promise<unknown> = Promise.resolve();
    function withControlLock<T>(fn: () => Promise<T>): Promise<T> {
      const next = controlChain.then(fn, fn);
      controlChain = next.catch(() => undefined);
      return next;
    }

    const runMeta: RunMetaData = {
      id: runId,
      workflowName: workflow.name,
      startedAt,
      cwd,
      resumed: true,
    };
    const ctxHost = createRunCtxHost({
      runMeta,
      input: manifest.input ?? "",
      runDirAbs,
      workflowSourceSha256: liveSha,
      cache: cacheStore,
      ledger,
      semaphore,
      signal: ctrl.signal,
      pauseGate,
      perRunAgentCap: runOptions.perRunAgentCap,
      tokenBudget: runOptions.tokenBudget ?? null,
      mockAgents: runOptions.mockAgents,
      cwd,
      ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
      ...(opts.nowIso ? { nowIso: opts.nowIso } : {}),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });

    const sandbox = new Sandbox({
      signal: ctrl.signal,
      runCtxHost: ctxHost.host,
      log: (entry) => {
        void ledger
          .append({
            type: "log",
            at: entry.t,
            level:
              entry.level === "warn" || entry.level === "error"
                ? entry.level
                : "info",
            message: entry.args.join(" "),
          })
          .catch(() => undefined);
      },
    });

    let terminalResolve!: (info: RunTerminalInfo) => void;
    const terminated = new Promise<RunTerminalInfo>((res) => {
      terminalResolve = res;
    });
    const promise = (async () => {
      let result: unknown;
      let runError: unknown = null;
      let outcome: RunOutcome = "done";
      try {
        try {
          const out = await sandbox.runScript(sourceText);
          result =
            out.returnValue === undefined
              ? undefined
              : JSON.parse(JSON.stringify(out.returnValue));
        } catch (e) {
          runError = e;
          const captured = captureError(e);
          await ledger
            .append({
              type: "error",
              at: (opts.nowIso ?? (() => new Date().toISOString()))(),
              error: {
                name: captured.name,
                message: captured.message,
                ...(captured.stack !== null ? { stack: captured.stack } : {}),
              },
            })
            .catch(() => undefined);
          outcome = userStopRequested ? "stopped" : "failed";
          try {
            await sm.go(outcome === "stopped" ? "stopped" : "failed");
          } catch {
            /* already terminal */
          }
        }
        if (runError === null) {
          const resultEntry = buildResultEntry(
            result,
            opts.nowIso ?? (() => new Date().toISOString()),
          );
          await ledger.append(resultEntry).catch(() => undefined);
          try {
            await sm.go("done");
          } catch {
            /* already done */
          }
        }
        await ledger.flush();
      } finally {
        sandbox.dispose();
        const endedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
        const startMs = Date.parse(startedAt);
        const endMs = Date.parse(endedAt);
        const durationMs =
          Number.isFinite(startMs) && Number.isFinite(endMs)
            ? Math.max(0, endMs - startMs)
            : 0;
        const captured = runError === null ? null : captureError(runError);
        const errOut =
          captured === null
            ? null
            : {
                name: captured.name,
                message: captured.message,
                ...(captured.stack !== null ? { stack: captured.stack } : {}),
              };
        terminalResolve({
          runId,
          workflowName: workflow.name,
          runDirAbs,
          outcome,
          startedAt,
          endedAt,
          durationMs,
          result: outcome === "done" ? result : undefined,
          error: errOut,
          agentCount: ctxHost.getAgentCount(),
          finishCallbackPrompt: ctxHost.getFinishCallbackPrompt(),
          // slice 9: resume's approval is captured here; might be null
          // when preApproved.
          approval:
            approvalReason === null
              ? null
              : {
                  approved: true,
                  reason: approvalReason,
                  persisted: false,
                },
        });
        // Release the resume lock once the run settles.
        try {
          lock.release();
        } catch {
          /* swallow */
        }
      }
      if (runError !== null) throw runError;
      return result;
    })();

    const run: Run = {
      runId,
      runDirAbs,
      promise,
      signal: ctrl.signal,
      getFinishCallbackPrompt: ctxHost.getFinishCallbackPrompt,
      cancel: (reason?: unknown) => {
        userStopRequested = true;
        ctrl.abort(reason);
      },
      approvalDecision: null,
      terminated,
      pause: (reason?: string) =>
        withControlLock(async () => {
          if (sm.state !== "running" || ctrl.signal.aborted) return false;
          if (!pauseGate.pause()) return false;
          const at = (opts.nowIso ?? (() => new Date().toISOString()))();
          await ledger.append(
            reason !== undefined
              ? { type: "pause", at, reason }
              : { type: "pause", at },
          );
          try {
            await sm.go("paused");
          } catch {
            pauseGate.resume();
            return false;
          }
          return true;
        }),
      resumePaused: (reason?: string) =>
        withControlLock(async () => {
          if (sm.state !== "paused") return false;
          if (!pauseGate.resume()) return false;
          const at = (opts.nowIso ?? (() => new Date().toISOString()))();
          await ledger.append(
            reason !== undefined
              ? { type: "resume", at, reason }
              : { type: "resume", at },
          );
          // slice_14_concerns W2: re-check sm.state AND signal.aborted
          // AFTER ledger.append so a stop() that races mid-flush can't
          // re-enter running.
          if (sm.state !== "paused" || ctrl.signal.aborted) {
            pauseGate.pause();
            await ledger
              .append({
                type: "log",
                at: (opts.nowIso ?? (() => new Date().toISOString()))(),
                level: "warn",
                message: `resumePaused aborted: state=${sm.state} aborted=${ctrl.signal.aborted} during ledger append`,
              })
              .catch(() => undefined);
            return false;
          }
          // slice_12_concerns B1: dedicated paused→running edge.
          try {
            await sm.go("running");
          } catch {
            return false;
          }
          return true;
        }),
      stop: (reason?: string) => {
        userStopRequested = true;
        ctrl.abort(
          reason !== undefined
            ? new Error(`stopped: ${reason}`)
            : undefined,
        );
      },
    };

    // Slice 13/F3: register the resumed run in the active-runs
    // registry just like a fresh run. The overlay's hotkeys then
    // route through the same Run.pause/stop primitives whether the
    // run was started this session or resumed from disk.
    if (opts.activeRuns !== undefined) {
      opts.activeRuns.register(runId, run, {
        workflowName: workflow.name,
        state:
          initialState === "approved" || initialState === "pending"
            ? "running"
            : initialState,
        startedAt,
        runDir: runDirAbs,
      });
    }

    return run;
  } catch (err) {
    // Release the lock if we never made it to the run.
    try {
      lock.release();
    } catch {
      /* swallow */
    }
    throw err;
  }
}

// Re-export ResumeLockedError so callers can identify the specific
// concurrent-resume rejection without importing from runLock.
export { ResumeLockedError };
