/**
 * pi-workflows — RunManager (slice 8a).
 *
 * Top-level orchestration. Glue between:
 *
 *   - slice 1 registry (workflow file discovery + sourceText)
 *   - slice 2 sandbox  (vm.Context + frozen globals)
 *   - slice 3 cache    (cache.jsonl reader/writer)
 *   - slice 4 semaphore
 *   - slice 6 dispatcher (subprocess fan-out)
 *   - slice 7 ledger    (state machine + append-only log)
 *   - slice 8a runCtx  (the host bridge for the sandbox)
 *
 * Lifecycle of a run:
 *
 *   1. `RunManager.start(workflowFile, args, opts)` returns a `Run`.
 *   2. RunManager mints `runId`, creates `<runDir>`, hashes the
 *      workflow source, writes `<runDir>/manifest.json` with all
 *      slice-8a-owned fields. Slice 6's dispatcher will merge in
 *      parent-liveness fields on its first call.
 *   3. RunManager constructs `LedgerWriter`, `CacheStore`, semaphore,
 *      `RunCtxHost`, then `Sandbox`.
 *   4. State machine: pending → approved → running. Slice 9 will
 *      insert the approval dialog; slice 8a accepts a `preApproved`
 *      flag that bypasses (with a `console.warn` notice).
 *   5. Sandbox runScript fires. main() resolves → terminal `done`.
 *      Throws → terminal `failed` with `error` ledger entry.
 *   6. `finally`: dispose sandbox + ledger flush + state-machine
 *      transition, regardless of outcome (vm.Context teardown is the
 *      slice-8a critic checklist item).
 *
 * The `Run` handle exposes `.promise` (resolves AFTER ledger fsync of
 * the terminal entry), `.signal` (forwards aborts), and `.runId`.
 *
 * Slice 8a is intentionally NOT resume-aware (slice 11) and NOT
 * approval-aware (slice 9). It also doesn't yet wire approval to
 * settings/trust storage. The `--mock-agents` mode IS plumbed since
 * the integration test relies on it.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type {
  ApprovalDecision,
  ApprovalDialog,
  ApprovalGateOptions,
  RunManifest,
  RunMetaData,
  RunOptions,
  RunOutcome,
  TrustStore,
  WorkflowFile,
} from "./types/internal.js";
import { CacheStore } from "./runtime/cache.js";
import { LedgerWriter, RunStateMachine, buildResultEntry } from "./runtime/ledger.js";
import { Sandbox } from "./runtime/sandbox.js";
import { captureError } from "./runtime/realmError.js";
import { createRunCtxHost } from "./runtime/runCtx.js";
import { makeSemaphore } from "./runtime/semaphore.js";
import { runApprovalGate } from "./runtime/approval.js";
import { sha256 } from "./util/hash.js";
import { newRunId } from "./util/runId.js";
import { runDir as runDirFor } from "./util/paths.js";

/** Public-ish handle returned by `RunManager.start`. */
export interface Run {
  readonly runId: string;
  readonly runDirAbs: string;
  /** Resolves with the workflow's `main()` return value. */
  readonly promise: Promise<unknown>;
  readonly signal: AbortSignal;
  /** Captured `ctx.finishCallback(prompt)` if the script called it. */
  readonly getFinishCallbackPrompt: () => string | null;
  /** Cancels the run by aborting the controller. */
  cancel(reason?: unknown): void;
  /** Slice 9: how the run was approved (or `null` for `preApproved`). */
  readonly approvalDecision: ApprovalDecision | null;
  /**
   * Slice 10: resolves AFTER `promise` settles AND the ledger has
   * been flushed. Always resolves (never rejects) with the full
   * terminal classification. Slice 10's `deliverRunResult` consumes
   * this; slice 13's TUI overlay subscribes via runs-index entries
   * but can also await this directly.
   */
  readonly terminated: Promise<RunTerminalInfo>;
}

/** Slice 10: full terminal classification of a finished run. */
export interface RunTerminalInfo {
  readonly runId: string;
  readonly workflowName: string;
  readonly runDirAbs: string;
  readonly outcome: RunOutcome;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Defined for `outcome=done`; `undefined` otherwise. */
  readonly result: unknown;
  /** Defined for `failed` and `cancelled-pre-run`; `null` otherwise. */
  readonly error:
    | { readonly name: string; readonly message: string; readonly stack?: string }
    | null;
  readonly agentCount: number;
  readonly finishCallbackPrompt: string | null;
  readonly approval: ApprovalDecision | null;
}

/** Slice 9: emitted to the caller (workflowCmd) when a run is denied. */
export class RunCancelledError extends Error {
  readonly runId: string;
  readonly runDirAbs: string;
  readonly cancelCause: "user-N" | "disabled";
  readonly approvalDecision: ApprovalDecision;
  constructor(opts: {
    runId: string;
    runDirAbs: string;
    cancelCause: "user-N" | "disabled";
    decision: ApprovalDecision;
    message: string;
  }) {
    super(opts.message);
    this.name = "RunCancelledError";
    this.runId = opts.runId;
    this.runDirAbs = opts.runDirAbs;
    this.cancelCause = opts.cancelCause;
    this.approvalDecision = opts.decision;
  }
}

export interface RunManagerStartOptions {
  /**
   * `--mock-agents` mode. When true, the dispatcher reads from
   * `<runDir>/fixtures.jsonl` instead of spawning real `pi -p`.
   * Required by slice-8a's integration test.
   */
  readonly mockAgents?: boolean;
  /**
   * Skip the approval dialog WITHOUT going through the slice-9 gate.
   * Tests still use this; production callers should pass an `approval`
   * object instead so bypass detection + trust storage fire.
   */
  readonly preApproved?: boolean;
  /**
   * Slice 9: full approval gate. When supplied, RunManager runs
   * `runApprovalGate` BEFORE transitioning `pending → approved`. If
   * the decision denies the run, RunManager appends a `cancelled`
   * ledger entry, transitions `pending → cancelled-pre-run`, and
   * rejects the run promise with `RunCancelledError`.
   *
   * `preApproved: true` skips this entirely; `preApproved: false`
   * (default) requires `approval` to be set.
   */
  readonly approval?: Pick<
    ApprovalGateOptions,
    "dialog" | "viewer" | "env" | "home" | "trustOverride" |
    "projectSettingsPathOverride" | "personalSettingsPathOverride" |
    "onPersistError"
  >;
  /**
   * Slice 9: emit the bypass banner via this hook. Caller is
   * responsible for translating to `pi.sendMessage`. Receives the
   * banner string verbatim. Optional — if unset, the banner is
   * still attached to the returned `approvalDecision`.
   */
  readonly emitBanner?: (banner: string) => void;
  /** PRD §1.2 pin 6 — overridden in tests. Default 1000. */
  readonly perRunAgentCap?: number;
  /** PRD §5.4 default — overridden in tests. Default 16. */
  readonly maxConcurrent?: number;
  readonly cwd?: string;
  /** Test seam — plug a dispatcher mock when integration tests need it. */
  readonly dispatch?: Parameters<typeof createRunCtxHost>[0]["dispatch"];
  /** Test seam — deterministic id generation. */
  readonly newRunIdFactory?: () => string;
  /** Test seam — deterministic ISO timestamps. */
  readonly nowIso?: () => string;
  /** Test seam — deterministic ms clock. */
  readonly nowMs?: () => number;
  /** Test seam — replace `runDir` resolver. Used for tmpdir runs. */
  readonly resolveRunDir?: (runId: string) => string;
  /**
   * Test seam — pre-write a fixtures.jsonl file into the run dir.
   * String content is written verbatim (so authors can craft canned
   * fixture lines that include the right `agentId`/`promptHash` keys).
   */
  readonly seedFixturesJsonl?: string;
  /**
   * Slice 8a accepts this so the integration test can also pre-seed
   * an `author_cache` entry + assert it survives. Tests only.
   */
  readonly preWriteCacheJsonl?: string;
  /** Slice 8a doesn't flush approval dialogs; this is purely for tests. */
  readonly trustedAtStart?: boolean;
}

const SLICE_PROJECT_VERSION = "0.1.0";
const PI_BUILTIN_VERSION_PROBE = "unknown";

/**
 * Start a workflow run. Returns a `Run` handle whose `.promise`
 * resolves with the script's `main()` return value (or rejects with
 * the reconstructed Context-realm Error).
 *
 * Per `slice_8a_concerns#H8`: the dead `Waiter.cleanup()` method on
 * `semaphore.ts` was reviewed and left in place \u2014 it's deliberately
 * dead per slice-2 critic rj18 (the inline removeEventListener calls
 * in resolve/reject ARE the cleanup, so the method is a vestige). A
 * later cleanup pass should drop it; out of scope for slice 8a (no
 * functional dependency).
 */
export async function startWorkflowRun(
  workflow: WorkflowFile,
  args: string,
  opts: RunManagerStartOptions = {},
): Promise<Run> {
  const cwd = opts.cwd ?? process.cwd();
  const runId = (opts.newRunIdFactory ?? newRunId)();
  const resolveRunDir = opts.resolveRunDir ?? runDirFor;
  const runDirAbs = resolveRunDir(runId);
  const startedAt = (opts.nowIso ?? (() => new Date().toISOString()))();

  await fs.mkdir(runDirAbs, { recursive: true });

  // Read the workflow source + hash it.
  const sourceText = await fs.readFile(workflow.absPath, "utf8");
  const workflowSourceSha256 = sha256(sourceText);

  // Optional fixture seeding (mock-agents tests).
  if (opts.seedFixturesJsonl !== undefined) {
    await fs.writeFile(
      join(runDirAbs, "fixtures.jsonl"),
      opts.seedFixturesJsonl,
      "utf8",
    );
  }
  if (opts.preWriteCacheJsonl !== undefined) {
    await fs.writeFile(
      join(runDirAbs, "cache.jsonl"),
      opts.preWriteCacheJsonl,
      "utf8",
    );
  }

  // ─── Slice 9 approval gate ───────────────────────────
  // Decision happens BEFORE we touch the ledger or write the manifest's
  // first transition. `pending → approved` (or `pending → cancelled-pre-run`)
  // is the first transition; if denied we still create runDir + ledger
  // so the overlay (slice 13) sees the cancelled run, but no sandbox
  // spawns.
  let approvalDecision: ApprovalDecision | null = null;
  if (opts.preApproved) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pi-workflows] approval bypassed via preApproved=true — test-only path; " +
        "production callers should pass an `approval` block instead.",
    );
  } else if (opts.approval !== undefined) {
    approvalDecision = await runApprovalGate({
      workflowName: workflow.name,
      absPath: workflow.absPath,
      sha256: workflowSourceSha256,
      cwd,
      ...(opts.mockAgents !== undefined ? { mockAgents: opts.mockAgents } : {}),
      ...opts.approval,
    });
    if (approvalDecision.approved && approvalDecision.banner !== undefined) {
      try {
        opts.emitBanner?.(approvalDecision.banner);
      } catch {
        /* hook failure must not abort the run */
      }
    }
  } else {
    throw new Error(
      "startWorkflowRun: must supply `preApproved: true` or an `approval` block (slice 9)",
    );
  }

  // Slice 8a-owned manifest fields. Slice 6's dispatcher will merge in
  // parent-liveness on first agent dispatch; we never overwrite those.
  const runOptions: RunOptions = {
    mockAgents: opts.mockAgents === true,
    maxConcurrent: opts.maxConcurrent ?? 16,
    perRunAgentCap: opts.perRunAgentCap ?? 1000,
  };
  // Slice-8a fields are a SUBSET of RunManifest; the remaining 3 fields
  // (parent-*) are written by the dispatcher on first agent. We use a
  // Partial<RunManifest> for the on-disk payload and trust the merge.
  const partialManifest: Partial<RunManifest> = {
    runId,
    workflowName: workflow.name,
    workflowAbsPath: workflow.absPath,
    workflowSourceSha256,
    input: args,
    startedAt,
    cwd,
    piVersion: PI_BUILTIN_VERSION_PROBE,
    piWorkflowsVersion: SLICE_PROJECT_VERSION,
    options: runOptions,
    trustedAtStart:
      opts.trustedAtStart === true ||
      (approvalDecision !== null &&
        approvalDecision.approved &&
        (approvalDecision.reason === "trusted" ||
          approvalDecision.reason === "user-always" ||
          approvalDecision.reason === "pi-p-trusted")),
  };
  await writeManifestPartial(runDirAbs, partialManifest);

  // ─── Substrate ────────────────────────────────────────────────
  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: (id) => join(resolveRunDir(id), "ledger.jsonl"),
  });
  const cacheStore = await CacheStore.open({
    runId,
    resolveCachePath: (id) => join(resolveRunDir(id), "cache.jsonl"),
    resolveCacheTmpPath: (id) => join(resolveRunDir(id), "cache.jsonl.tmp"),
  });
  const semaphore = makeSemaphore({ cap: runOptions.maxConcurrent });

  // Append the `init` ledger entry (PRD §6.4 init carries the manifest
  // shape so resume can rebuild without parsing manifest.json).
  await ledger.append({
    type: "init",
    at: startedAt,
    manifest: partialManifest as Readonly<Record<string, unknown>>,
  });

  // ─── Slice 9 cancellation path ─────────────────────────
  // If the gate denied the run, emit `cancelled` + transition to
  // `cancelled-pre-run` and return a rejected-promise handle. No
  // sandbox is constructed; no semaphore acquisitions happen.
  if (approvalDecision !== null && !approvalDecision.approved) {
    const sm = new RunStateMachine({
      writer: ledger,
      ...(opts.nowIso ? { now: opts.nowIso } : {}),
    });
    const cancelledAt = (opts.nowIso ?? (() => new Date().toISOString()))();
    await ledger.append({
      type: "cancelled",
      at: cancelledAt,
      cause: approvalDecision.cancelCause,
    });
    try {
      await sm.go("cancelled-pre-run");
    } catch {
      /* defensive */
    }
    await ledger.flush();
    const errMsg = approvalDecision.error ?? "workflow run cancelled by user";
    const cancelled = new RunCancelledError({
      runId,
      runDirAbs,
      cancelCause: approvalDecision.cancelCause,
      decision: approvalDecision,
      message: errMsg,
    });
    const terminalInfo: RunTerminalInfo = {
      runId,
      workflowName: workflow.name,
      runDirAbs,
      outcome: "cancelled-pre-run",
      startedAt,
      endedAt: cancelledAt,
      durationMs: 0,
      result: undefined,
      error: { name: cancelled.name, message: cancelled.message },
      agentCount: 0,
      finishCallbackPrompt: null,
      approval: approvalDecision,
    };
    // Pre-suppress unhandled rejection on the synthetic Promise.reject.
    const rejectedPromise = Promise.reject(cancelled);
    rejectedPromise.catch(() => undefined);
    return {
      runId,
      runDirAbs,
      promise: rejectedPromise,
      signal: AbortSignal.abort(cancelled),
      getFinishCallbackPrompt: () => null,
      cancel: () => undefined,
      approvalDecision,
      terminated: Promise.resolve(terminalInfo),
    };
  }

  // State machine: pending → approved → running.
  const sm = new RunStateMachine({ writer: ledger, ...(opts.nowIso ? { now: opts.nowIso } : {}) });
  await sm.go("approved");
  await sm.go("running");

  // Run-level abort. Slice 10: track whether `cancel()` was called so
  // the terminal classifier can distinguish `stopped` (user) from
  // `failed` (script error).
  const ctrl = new AbortController();
  let userStopRequested = false;

  // Build runCtx host bridge.
  const runMeta: RunMetaData = {
    id: runId,
    workflowName: workflow.name,
    startedAt,
    cwd,
    resumed: false,
  };
  const ctxHost = createRunCtxHost({
    runMeta,
    input: args,
    runDirAbs,
    workflowSourceSha256,
    cache: cacheStore,
    ledger,
    semaphore,
    signal: ctrl.signal,
    perRunAgentCap: runOptions.perRunAgentCap,
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
      // console.log inside the script → ledger log.
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

  // Drive the run with a real try { ... } finally { sandbox.dispose() }
  // per slice_8a_concerns#H4 — if ledger.flush() throws, we still
  // tear down the Context (no host vm.Context leak).
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
        // Clone returnValue back to host realm so callers (and slice-7
        // ledger.buildResultEntry) don't trip over Context-realm proto-
        // type chains. JSON-only is fine — PRD §4.2.1 declares main()'s
        // resolution as JSON-cloneable.
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
        // Distinguish user-cancel (stopped) from script error (failed).
        outcome = userStopRequested ? "stopped" : "failed";
        try {
          await sm.go(outcome === "stopped" ? "stopped" : "failed");
        } catch {
          // already terminal — ignore
        }
      }

      if (runError === null) {
        // Success path — `result` entry + transition to done.
        const resultEntry = buildResultEntry(
          result,
          opts.nowIso ?? (() => new Date().toISOString()),
        );
        await ledger.append(resultEntry).catch(() => undefined);
        try {
          await sm.go("done");
        } catch {
          // already done — ignore
        }
      }
      await ledger.flush();
    } finally {
      // Slice_8a_concerns#H4: real try/finally so a flush() throw still
      // runs dispose. Idempotent — safe to call twice.
      sandbox.dispose();
      // Resolve the terminal info regardless of whether ledger.flush()
      // threw — slice 10's deliverRunResult must always observe a
      // settled run.
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
        approval: approvalDecision,
      });
    }
    if (runError !== null) {
      throw runError;
    }
    return result;
  })();

  return {
    runId,
    runDirAbs,
    promise,
    signal: ctrl.signal,
    getFinishCallbackPrompt: ctxHost.getFinishCallbackPrompt,
    cancel: (reason?: unknown) => {
      userStopRequested = true;
      ctrl.abort(reason);
    },
    approvalDecision,
    terminated,
  };
}

/**
 * Atomically write the slice-8a partial manifest. Mirrors slice 6's
 * tmp+rename pattern so concurrent writes never tear the JSON.
 *
 * If a manifest already exists (e.g. dispatcher already wrote
 * parent-liveness), we deep-merge \u2014 8a's fields go on top of any
 * pre-existing fields, so 8a's snapshot wins for shared keys.
 */
async function writeManifestPartial(
  runDirAbs: string,
  fields: Partial<RunManifest>,
): Promise<void> {
  const target = join(runDirAbs, "manifest.json");
  let existing: Partial<RunManifest> = {};
  try {
    const buf = await fs.readFile(target, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Partial<RunManifest>;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // unreadable existing file \u2014 overwrite is the documented merge.
    }
  }
  const merged: Partial<RunManifest> = { ...existing, ...fields };
  const tmp = join(runDirAbs, `manifest.json.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}
