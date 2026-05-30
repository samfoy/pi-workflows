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

import { promises as fs, watch as fsWatch, readFileSync } from "node:fs";
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
import { PauseGate } from "./runtime/pauseGate.js";
import { runApprovalGate } from "./runtime/approval.js";
import { sha256 } from "./util/hash.js";
import { newRunId } from "./util/runId.js";
import { runDir as runDirFor } from "./util/paths.js";

/**
 * Lightweight static extractor for `meta.phases` titles from a workflow script.
 * Uses a regex rather than a full AST parse — only handles the common literal
 * array shape. Returns empty array if not found or unparseable.
 */
export function extractMetaPhases(source: string): Array<{ title: string }> {
  // Match: phases: [ { title: '...' }, ... ] or phases: [{ title: "..." }, ...]
  const phasesBlock = /phases\s*:\s*(\[[\s\S]*?\])/m.exec(source);
  if (!phasesBlock?.[1]) return [];
  const block = phasesBlock[1];
  const titles: Array<{ title: string }> = [];
  const titleRe = /title\s*:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic exec loop
  while ((m = titleRe.exec(block)) !== null) {
    const t = m[1];
    if (t !== undefined) titles.push({ title: t });
  }
  return titles;
}

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
   * Slice 12: cooperatively pause the run. New agent spawns block
   * until {@link resumePaused} is called; in-flight agents finish
   * naturally. Idempotent — a second `pause()` while already paused
   * is a no-op (no second ledger entry, returns `false`).
   *
   * Returns `true` if state changed (was running, now paused),
   * `false` if no-op (already paused, or run is past `running`).
   * Awaits the ledger fsync of the `pause` entry + the `running →
   * paused` transition before resolving.
   *
   * Refs: PRD §5.7, plan.md §4 Slice 12.
   */
  pause(reason?: string): Promise<boolean>;
  /**
   * Slice 12: cooperatively resume a paused run. Distinct from
   * slice 11's `resumeRun(runId)` which loads from disk — this
   * operates on the live in-process Run handle. Idempotent — if
   * not paused, returns `false` and emits no ledger entry.
   *
   * Returns `true` if state changed (was paused, now running),
   * `false` if no-op. Awaits the ledger fsync of the `resume`
   * entry + the `paused → running` transition before resolving.
   *
   * **slice_12_concerns B1**: uses the dedicated `paused → running`
   * edge per PRD §5.7 — NOT the `failed → running` advisory
   * rollback edge added by slice 11.
   */
  resumePaused(reason?: string): Promise<boolean>;
  /**
   * Slice 12: cooperatively stop the run. Aborts the per-run
   * controller (in-flight subprocesses receive SIGTERM via slice 6's
   * dispatcher), unblocks any paused waiters, and lets the natural
   * promise rejection drive the `stopped` terminal classification
   * inside the existing `runManager` finally block.
   *
   * Distinct from {@link cancel} only in that it accepts a reason
   * string for ledger forensics. Use `stop()` from the TUI overlay
   * (`x` hotkey) and CLI `/workflows kill`. Both methods are
   * idempotent if already aborted.
   */
  stop(reason?: string): void;
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
  /** Token budget cap for this run, or `null` for uncapped. Default null. */
  readonly tokenBudget?: number | null;
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
  /**
   * Slice 13: register the live `Run` handle into the per-process
   * active-runs registry so the TUI overlay's `p`/`x`/`r` hotkeys and
   * `/workflows kill <id>` can call `pause()`/`stop()` on it. When
   * undefined, runs aren't tracked (slice-8a tests that never want
   * registry side-effects pass `undefined` here).
   */
  readonly activeRuns?: import("./runtime/activeRuns.js").ActiveRunsRegistry;
  /** Slice 8a doesn't flush approval dialogs; this is purely for tests. */
  readonly trustedAtStart?: boolean;
  /**
   * Slice 14 — lineage marker set by the `r` (restart) hotkey. When
   * set, RunManager writes `restartedFrom: <prior runId>` into the
   * manifest.json so audit + GC can identify the chain.
   */
  readonly restartedFrom?: string;
  /**
   * Slice 14 — callback fired when the run emits a phase/agent
   * overlay event. Defaults to a no-op when undefined; the extension
   * wires this to `pi.appendEntry` at registration so the TUI
   * overlay's `bindRegistryToFeed` picks them up. Tests can capture.
   */
  readonly emitOverlayEvent?: (
    customType:
      | "pi-workflows.phase.started"
      | "pi-workflows.phase.ended"
      | "pi-workflows.agent.started"
      | "pi-workflows.agent.ended"
      | "pi-workflows.meta.phases",
    data: Readonly<Record<string, unknown>>,
  ) => void;
}

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pkg = _require("../package.json") as { version: string };

const SLICE_PROJECT_VERSION = _pkg.version;
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

  // Slice 11 (resume support): freeze a copy of the script bytes into
  // `<runDir>/script.js`. PRD §6.1 declares this the canonical resume
  // input; §5.8 step 2 mandates that resume reads from this frozen
  // copy (NOT the live `.pi/workflows/`) so author edits don't break
  // bit-exact replay. Atomic via writeFile (the file is small).
  await fs.writeFile(join(runDirAbs, "script.js"), sourceText, "utf8");

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
    tokenBudget: opts.tokenBudget ?? null,
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
    ...(opts.restartedFrom !== undefined ? { restartedFrom: opts.restartedFrom } : {}),
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
      // Slice 12: pre-run-cancelled runs never enter `running`, so
      // pause/resume/stop are pure no-ops (return false / undefined).
      // No ledger entries; the cancelled state is already terminal.
      pause: () => Promise.resolve(false),
      resumePaused: () => Promise.resolve(false),
      stop: () => undefined,
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

  // Slice 12: cooperative pause gate. Construct BEFORE ctxHost so we
  // can pass it through. RunManager owns this; the gate is exposed
  // to author code only via the `pause`/`resumePaused`/`stop` Run
  // handle methods (NOT through ctx) per PRD §5.7 — author scripts
  // can't pause themselves.
  const pauseGate = new PauseGate();
  // Serialize pause/resume against each other so two concurrent
  // `pause()` calls can't both decide they won the gate (the gate
  // itself is idempotent, but the ledger-write + sm.go() pair must
  // run atomically per call).
  let controlChain: Promise<unknown> = Promise.resolve();
  function withControlLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = controlChain.then(fn, fn);
    controlChain = next.catch(() => undefined);
    return next;
  }

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
    pauseGate,
    perRunAgentCap: runOptions.perRunAgentCap,
    tokenBudget: runOptions.tokenBudget,
    mockAgents: runOptions.mockAgents,
    cwd,
    ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
    ...(opts.nowIso ? { nowIso: opts.nowIso } : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    ...(opts.emitOverlayEvent
      ? { emitOverlayEvent: opts.emitOverlayEvent }
      : {}),
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
      // Pre-seed pending phases from meta.phases declaration.
      const declaredPhases = extractMetaPhases(sourceText);
      if (declaredPhases.length > 0 && opts.emitOverlayEvent) {
        try {
          opts.emitOverlayEvent("pi-workflows.meta.phases" as any, {
            runId: runId,
            phases: declaredPhases,
          });
        } catch { /* emission failures must not abort the run */ }
      }
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

  const run: Run = {
    runId,
    runDirAbs,
    promise,
    signal: ctrl.signal,
    getFinishCallbackPrompt: ctxHost.getFinishCallbackPrompt,
    cancel: (reason?: unknown) => {
      userStopRequested = true;
      // Slice 12: unblock pause-waiters before abort lands so the
      // race in `PauseGate.waitWhilePaused` resolves cleanly via
      // the abort branch (rejects with `reason`).
      ctrl.abort(reason);
    },
    approvalDecision,
    terminated,
    pause: (reason?: string) =>
      withControlLock(async () => {
        // Don't pause a terminated/aborted run — the gate would
        // never release because in-flight is already empty.
        if (sm.state !== "running" || ctrl.signal.aborted) {
          return false;
        }
        const changed = pauseGate.pause();
        if (!changed) return false;
        const at = (opts.nowIso ?? (() => new Date().toISOString()))();
        // Order: ledger `pause` entry first (so a TUI tail observes
        // the pause before the transition), then `running → paused`
        // transition. Both writes go through the same writeQueue so
        // ordering is preserved across fsyncs.
        await ledger.append(
          reason !== undefined
            ? { type: "pause", at, reason }
            : { type: "pause", at },
        );
        try {
          await sm.go("paused");
        } catch {
          // Race: state changed between the gate check and the
          // transition (e.g. abort fired). Roll back the gate so a
          // future resume() doesn't enter an inconsistent state.
          pauseGate.resume();
          return false;
        }
        return true;
      }),
    resumePaused: (reason?: string) =>
      withControlLock(async () => {
        if (sm.state !== "paused") return false;
        const changed = pauseGate.resume();
        if (!changed) return false;
        const at = (opts.nowIso ?? (() => new Date().toISOString()))();
        await ledger.append(
          reason !== undefined
            ? { type: "resume", at, reason }
            : { type: "resume", at },
        );
        // slice_14_concerns W2: re-check `sm.state === "paused"` AND
        // `ctrl.signal.aborted` AFTER ledger.append. A concurrent
        // `stop()` / `cancel()` flips `aborted` synchronously even
        // though the corresponding sm.go("stopped") is queued behind
        // our resume entry on the ledger writeQueue. Without this
        // recheck we'd transition paused→running for a doomed run.
        if (sm.state !== "paused" || ctrl.signal.aborted) {
          // Roll back the gate so the run isn't left in a half-released
          // state if a future control op observes it.
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
        // slice_12_concerns B1: this is the dedicated `paused →
        // running` edge per PRD §5.7. Slice 11's `failed → running`
        // advisory rollback is reachable ONLY from `failed` state
        // — since pause never enters `failed`, this transition can't
        // accidentally route through that path.
        try {
          await sm.go("running");
        } catch {
          // Race: state already advanced. Re-engaging the gate would
          // be wrong (state might be `stopped`/`failed`). Leave
          // gate released and absorb — caller sees `false`.
          return false;
        }
        return true;
      }),
    stop: (reason?: string) => {
      userStopRequested = true;
      // Unblock pause-waiters; abort wins per plan §4 Slice 12 risk.
      // The abort propagates through phaseCtrl to running
      // dispatcher subprocesses (SIGTERM via slice 6).
      ctrl.abort(
        reason !== undefined ? new Error(`stopped: ${reason}`) : undefined,
      );
    },
  };

  // Slice 13/F3: register the run handle into the per-process active
  // runs registry so the TUI overlay's hotkeys and `/workflows kill`
  // can find it. Idempotent — re-registration replaces the prior
  // handle (e.g. on resume). The registry's auto-cleanup hook drops
  // the live handle on `run.terminated`.
  const activeRunsRegistry = opts.activeRuns;
  if (activeRunsRegistry !== undefined) {
    const summaryPatch: Parameters<typeof activeRunsRegistry.register>[2] = {
      workflowName: workflow.name,
      state: "running",
      startedAt,
      runDir: runDirAbs,
      ...(approvalDecision !== null && approvalDecision.reason !== undefined
        ? { approvalReason: approvalDecision.reason }
        : {}),
    };
    activeRunsRegistry.register(runId, run, summaryPatch);
  }

  // IPC inspection surface: watch <runDir>/ctrl.jsonl for commands
  // from a supervisor process. The watcher is best-effort — if it
  // fails to start, the run continues normally.
  startCtrlWatcher(runDirAbs, run);

  return run;
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

// ─── IPC ctrl-file watcher ─────────────────────────────────────────────────

/**
 * Watch `<runDir>/ctrl.jsonl` for control commands emitted by a
 * supervisor process. New lines are parsed as `CtrlCommand` objects
 * and dispatched to the appropriate `Run` method:
 *
 *   `{ type: "pause" }`  → `run.pause(reason ?? "ctrl-ipc")`
 *   `{ type: "resume" }` → `run.resumePaused(reason ?? "ctrl-ipc")`
 *   `{ type: "stop" }`   → `run.stop(reason ?? "ctrl-ipc")`
 *
 * The watcher is mounted on the run **directory** (not the file) so
 * it fires even when `ctrl.jsonl` is created for the first time by a
 * supervisor. `fs.watch()` on a non-existent file throws; watching the
 * directory avoids that while staying event-driven.
 *
 * The watcher is torn down when `run.terminated` resolves. All errors
 * are swallowed — a watcher failure must never affect the run itself.
 */
function startCtrlWatcher(runDirAbs: string, run: Run): void {
  const ctrlFile = join(runDirAbs, "ctrl.jsonl");
  let bytesRead = 0;

  function processNewLines(): void {
    try {
      const buf = readFileSync(ctrlFile);
      if (buf.length <= bytesRead) return;
      const newData = buf.slice(bytesRead).toString("utf8");
      bytesRead = buf.length;
      for (const rawLine of newData.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let cmd: { type: string; reason?: string } | null = null;
        try {
          cmd = JSON.parse(line) as { type: string; reason?: string };
        } catch { /* malformed JSON — skip */ }
        if (!cmd || typeof cmd.type !== "string") continue;
        const reason = typeof cmd.reason === "string" ? cmd.reason : "ctrl-ipc";
        if (cmd.type === "pause") {
          void run.pause(reason).catch(() => undefined);
        } else if (cmd.type === "resume") {
          void run.resumePaused(reason).catch(() => undefined);
        } else if (cmd.type === "stop") {
          try { run.stop(reason); } catch { /* idempotent */ }
        }
      }
    } catch { /* ENOENT or other — file not yet created */ }
  }

  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(runDirAbs, (_event, filename) => {
      if (filename === "ctrl.jsonl") processNewLines();
    });
    // Unref so the watcher doesn't keep the process alive after the
    // session ends (matches the pattern used by fs.watch in slice 16).
    watcher.unref();
  } catch {
    /* best-effort — watch not available on all platforms */
  }

  // Tear down on run termination.
  run.terminated.then(() => {
    try { watcher?.close(); } catch { /* already closed */ }
  }).catch(() => undefined);
}
