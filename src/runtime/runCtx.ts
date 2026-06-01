/**
 * pi-workflows — host-side `RunCtxHost` factory (slice 8a).
 *
 * Builds the `RunCtxHost` object the sandbox installs as a closure-
 * captured bridge. Every method returns a tagged
 * `{ ok, value | error }` envelope so realm errors travel as plain
 * JSON; the Context-realm wrapper reconstructs Errors locally
 * (see `src/runtime/sandbox.ts` `__pi_reconstruct_error`).
 *
 * Wiring this slice glues together:
 *   - slice 2 sandbox → host bridge
 *   - slice 3 cache    → ctx.cache.* + agent-result memoization
 *   - slice 4 semaphore → phase concurrency gate
 *   - slice 6 dispatcher → ctx.phase agent runs
 *   - slice 7 ledger    → log + phase_start/end + agent_start/end +
 *                         agent_error + agent_cache_hit
 *
 * ─── LAYOUT ──────────────────────────────────────────────────
 * createRunCtxHost is now an orchestrator: it owns the run-scoped
 * mutable state (PhaseState bag plus a few small lets) and wires
 * each ctx.* method via a per-cluster factory under src/runtime/ctx/.
 *
 *   ctx/agent.ts            — ctx.agent (handle builder)
 *   ctx/phase.ts            — ctx.phase + runOneAgent (the heart;
 *                              shares PhaseState with the orchestrator)
 *   ctx/cache.ts            — ctx.cache.{get,set,has,delete}
 *   ctx/logProgress.ts      — ctx.log + ctx.finishCallback + ctx.progress
 *   ctx/gate.ts             — ctx.gate (HITL approval)
 *   ctx/interrupt.ts        — ctx.interrupt + parseInterruptOpts
 *   ctx/memo.ts             — ctx.memo.check + ctx.memo.set
 *   ctx/memory.ts           — ctx.memory.{read,append,compact} + ctx.promote
 *   ctx/checkpointReport.ts — ctx.checkpoint + ctx.report
 *   ctx/utils.ts            — isLikeArray + requireString helpers
 *   schema.ts (sibling)     — extractJson, validateAgainstSchema,
 *                              SchemaValidationError,
 *                              InterruptValueValidationError
 *
 * Cumulative reduction: 2,329 → ~530 lines (-77%).
 *
 * The orchestrator's job is now strictly to:
 *   1. Resolve options (dispatch, nowIso, nowMs, newAgentId).
 *   2. Construct the per-run mutable state (PhaseState, finishPrompt,
 *      interruptCounter).
 *   3. Build each cluster factory and capture its returned methods.
 *   4. Hand the wired host object back to the sandbox bridge.
 *
 * Per `slice_8a_concerns` (note in scratchpad):
 *   - SC1: Every method here is wrapped Context-side via wrapHostSync /
 *     wrapHostAsync so the script's `ctx.agent.constructor` walks land
 *     on Context-realm `Function`. Verified by the new
 *     host-realm-eval.workflow.js fixture rows.
 *   - F4: Phase rejection builds an `AggregateError` whose `.errors`
 *     are MalformedAgentOutputError / AgentSubprocessError instances
 *     captured via `realmError.captureError`. The reconstruction
 *     inside the Context (sandbox.ts) preserves
 *     `errors[i].name`, `errors[i].message`, `errors[i].cause` chains
 *     verbatim.
 *   - F6: `cached: boolean` is derived in `ctx.agent.run()` not in the
 *     dispatcher.
 *   - R7: phase's #drain logic runs through `Semaphore.acquire`'s
 *     microtask scheduling — re-entrancy witness lives in tests.
 */

import type {
  AgentHandleData,
  AgentResult,
  AgentResultLike,
  AgentUsage,
  RunCtxBridgeResult,
  RunCtxHost,
  RunMetaData,
  Semaphore,
  SettledAgent,
} from "../types/internal.js";
import { CacheStore } from "./cache.js";
import { getMemoStore } from "./memoStore.js";
import {
  appendMemoryUpdate,
  buildPromptWithMemory,
  compactMemoryFile,
  MEMORY_READ_CAP_BYTES,
  parseMemoryOpts,
  memoryReadOnlyKey,
  ReadOnlyMemoryError,
  readMemoryFileWithMeta,
  resolveMemoryDir,
  type MemoryScope,
} from "./agentMemory.js";
import { recordAgentMemoryDir, recordAgentWorktreePath } from "./manifestWriter.js";
import { LedgerWriter, log as ledgerLog } from "./ledger.js";
import { agentErrorFromException } from "./ledger.js";
import { dispatchAgent, recoverFromTranscript } from "./dispatcher.js";
import type { PauseGate } from "./pauseGate.js";
import { captureError } from "./realmError.js";
import { cacheKey } from "../util/hash.js";
import { sha256 } from "../util/hash.js";
import { makeSemaphore } from "./semaphore.js";
import { agentTranscriptPath } from "../util/paths.js";
import { MAX_PROMPT_LENGTH } from "../util/limits.js";
import { renderMermaidSync } from "./visualize.js";
import { createCacheMethods } from "./ctx/cache.js";
import { createLogProgressMethods } from "./ctx/logProgress.js";
import { createGateMethod } from "./ctx/gate.js";
import { createMemoMethods } from "./ctx/memo.js";
import { createCheckpointReportMethods } from "./ctx/checkpointReport.js";
import { createMemoryMethods } from "./ctx/memory.js";
import { createInterruptMethod } from "./ctx/interrupt.js";
import { createAgentMethod } from "./ctx/agent.js";
import { createPhaseMethods, type PhaseState } from "./ctx/phase.js";
import { isLikeArray, requireString } from "./ctx/utils.js";
import {
  assertGitRepo,
  createWorktreeForAgent,
  emitWorktreeDiff,
  parseIsolation,
  promoteAgentWorktree,
  resolveWorktreeDiffPath,
} from "./worktree.js";

/**
 * Construction options for `createRunCtxHost`. Mostly DI seams so
 * tests can swap out the dispatcher, semaphore, etc.
 */
export interface RunCtxHostOptions {
  readonly runMeta: RunMetaData;
  readonly input: string;
  /** Token budget cap, or `null` for uncapped. Enforced per-agent in `runOneAgent`. */
  readonly tokenBudget?: number | null;
  readonly runDirAbs: string;
  /** SHA-256 of the workflow source (cache-key input + manifest field). */
  readonly workflowSourceSha256: string;
  readonly cache: CacheStore;
  /**
   * Optional cross-run global cache. When supplied, `runOneAgent` checks
   * here before the per-run cache (global hit → skip dispatch) and writes
   * here after a cache miss so future runs of the same workflow version
   * can reuse the result. Disabled by default; opt-in via
   * `RunManagerStartOptions.enableGlobalCache`.
   */
  readonly globalCache?: CacheStore;
  readonly ledger: LedgerWriter;
  readonly semaphore: Semaphore;
  /** Per-run abort signal — propagates to all agent dispatches. */
  readonly signal: AbortSignal;
  /**
   * Slice 12: cooperative pause gate. When paused, `runOneAgent`
   * blocks BEFORE acquiring a semaphore slot so paused runs hold
   * no shared resources. Optional — when absent, behaves as a
   * never-paused gate (back-compat for tests constructed before
   * slice 12).
   */
  readonly pauseGate?: PauseGate;
  /** PRD §1.2 pin 6: hard cap on agent dispatches per run. */
  readonly perRunAgentCap: number;
  /** `--mock-agents` mode flag. */
  readonly mockAgents: boolean;
  /**
   * When true, sets `PI_BYPASS_PERMISSIONS=1` in the child env so file
   * edits are auto-approved. Mirrors `WorkflowMeta.acceptEdits`.
   */
  readonly acceptEdits?: boolean;
  /** cwd to pass to the dispatcher (PRD §6.2 manifest.cwd). */
  readonly cwd: string;
  /**
   * Run-wide default agent timeout in ms. Applied when an individual
   * `ctx.agent()` call does not supply `opts.timeoutMs`. Falls back
   * to the dispatcher's hard-coded 600_000 ms when absent.
   * Improvement 3.
   */
  readonly defaultAgentTimeoutMs?: number;
  /** Test seam: replace the dispatcher. */
  readonly dispatch?: typeof dispatchAgent;
  /** Test seam: replace `Date.now()` for deterministic stamps. */
  readonly nowMs?: () => number;
  /** Test seam: replace `() => new Date().toISOString()`. */
  readonly nowIso?: () => string;
  /** Test seam: id generator for `ctx.agent` when author omits id. */
  readonly newAgentId?: () => string;
  /** Slice 10 will deliver this; slice 8a captures the prompt only. */
  readonly onFinishCallback?: (prompt: string) => void;
  /**
   * Slice 14 — fired on phase/agent state transitions to drive the TUI
   * overlay's phase view. Optional; when absent (most unit tests),
   * `ctx.phase` runs without overlay-event emission. RunManager wires
   * this to `pi.appendEntry` so the phase view's `bindRegistryToFeed`
   * picks the events up.
   */
  readonly emitOverlayEvent?: (
    customType:
      | "pi-workflows.phase.started"
      | "pi-workflows.phase.ended"
      | "pi-workflows.agent.started"
      | "pi-workflows.agent.ended"
      | "pi-workflows.meta.phases"
      | "pi-workflows.progress"
      | "pi-workflows.report"
      | "pi-workflows.agent.log"
      | "pi-workflows.gate.requested"
      | "pi-workflows.gate.resolved"
      | "pi-workflows.interrupt.requested"
      | "pi-workflows.interrupt.resolved",
    data: Readonly<Record<string, unknown>>,
  ) => void;
  /**
   * Slice gap/ctx-gate — optional gate resolver. When provided, ctx.gate()
   * suspends execution until the function resolves (approved) or rejects
   * (abort). When absent, gate() resolves immediately with `opts.default`.
   */
  readonly waitForGate?: (message: string, signal: AbortSignal) => Promise<boolean>;
  /**
   * ZONE_HITL — optional supervisor-injection resolver. Called by
   * `ctx.interrupt(...)` after the request entry is written. Resolves
   * with the JSON-cloneable answer when a `resume-interrupt` control
   * command arrives (or rejects when the run aborts). When absent,
   * `ctx.interrupt()` falls back to `opts.default` (or `null`).
   */
  readonly waitForInterrupt?: (
    key: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /**
   * ZONE_HITL — prior `interrupt_resolved` entries replayed from the
   * ledger on resume. Keyed by the deterministic sequence id
   * (`int-0`, `int-1`, ...). When `ctx.interrupt(...)` is called and a
   * matching key is present, the stored value is returned immediately
   * without writing a new request — this is the replay-perfect HITL
   * contract. Empty for fresh runs.
   */
  readonly replayResolvedInterrupts?: ReadonlyMap<string, unknown>;

  /**
   * Test seam for `ctx.memory.compact(name, scope)`. Replaces the
   * default summarizer (which spawns `pi --mode json -p` via
   * `dispatchAgent`) so unit tests can run without invoking a real
   * sub-agent. Receives the memory `name` and the original file
   * content, must resolve to the new (compacted) content. Errors
   * propagate to the caller as `CompactionError` (caught and turned
   * into a `RunCtxBridgeResult.ok=false` by the bridge).
   */
  readonly compactSummarize?: (
    name: string,
    original: string,
  ) => Promise<string>;
}

/**
 * Build the host bridge. Returned object is consumed by the sandbox
 * via `SandboxOptions.runCtxHost`.
 *
 * Resources owned by the caller, NOT this factory:
 *   - `ledger`, `cache`, `semaphore`, `signal` are all created upstream
 *     by `RunManager`; the factory just wires them.
 */
export function createRunCtxHost(opts: RunCtxHostOptions): {
  readonly host: RunCtxHost;
  /** Captured finish-callback prompt, or `null` if never called. */
  readonly getFinishCallbackPrompt: () => string | null;
  /** Number of agents dispatched so far (used by per-run cap check). */
  readonly getAgentCount: () => number;
  /** Abort a single in-flight agent by id (no-op if not running). */
  readonly stopAgent: (agentId: string) => void;
  /** Abort + restart a single in-flight agent (up to 3 times). */
  readonly restartAgent: (agentId: string) => void;
} {
  const dispatch = opts.dispatch ?? dispatchAgent;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const nowMs = opts.nowMs ?? Date.now;
  const newAgentId = opts.newAgentId ?? defaultAgentIdFactory();

  // Per-cluster method factories. Each takes the host options and
  // returns the bridge-shaped methods. See src/runtime/ctx/ for the
  // implementations — the audit-driven split landed cluster-by-cluster
  // so closure-captured state stays explicit.
  const cacheMethods = createCacheMethods(opts);
  const logProgressMethods = createLogProgressMethods(opts, {
    setFinishPrompt: (p) => {
      finishPrompt = p;
    },
    nowIso,
  });
  const gate = createGateMethod(opts, { nowIso });
  const memoMethods = createMemoMethods(opts);
  const checkpointReportMethods = createCheckpointReportMethods(opts, {
    nowIso,
  });
  const interruptFn = createInterruptMethod(opts, {
    nextInterruptIdx: () => interruptCounter++,
    nowIso,
  });
  const agent = createAgentMethod(opts, { newAgentId });

  // agentCount lives on phaseState (declared below).
  // budgetSpent lives on phaseState (declared below).
  /**
   * BUG-055: budgetReserved tracks in-flight token reservations so that
   * parallel agents cannot all pass the budget check simultaneously.
   *
   * Each agent increments this by 1 BEFORE the first async yield (i.e.,
   * synchronously after the budget check passes). Since JS is single-
   * threaded and Promise.allSettled launches all handles sequentially during
   * the synchronous .map() pass, each subsequent handle sees the previous
   * reservations and the check `budgetSpent + budgetReserved >= tokenBudget`
   * blocks it correctly.
   *
   * Using 1 (not a per-agent estimate) is a soft-cap: it prevents any agent
   * beyond the budget-computed limit from STARTING, but a single in-flight
   * agent can still spend more tokens than the remaining budget. This bounds
   * overshoot to at most 1 × max_agent_spend rather than (N-1) × max_spend.
   */
  // budgetReserved lives on phaseState (declared below).
  let finishPrompt: string | null = null;
  let interruptCounter = 0;
  const tokenBudget: number | null = opts.tokenBudget ?? null;

  // ─── ZONE_MEMORY oversize-warning dedup ('docs/agent-memory.md' #2) ──
  // First time MEMORY.md exceeds the 25 KiB read cap for a given
  // memory `name` within this run, we emit a single `log` warning so
  // authors notice the file outgrew the prompt budget. Subsequent
  // reads silently truncate (the documented contract). Keyed by
  // memory-name only — a per-(run, name) Set is per-instance because
  // this map is scoped to one createRunCtxHost call.
  const memoryOversizeWarned = new Set<string>();

  // gap follow-up #5: track (scope, name) tuples that any ctx.agent()
  // call has mounted with readOnly:true. ctx.memory.append against a
  // tuple in this set throws ReadOnlyMemoryError so a workflow that
  // shares a "playbook" persona can't accidentally clobber it from a
  // sibling agent invocation. Once readonly, always readonly for the
  // life of the run — a fresh process is needed to revoke.
  const readOnlyMemoryKeys = new Set<string>();

  // memory + promote bridge methods (ctx/memory.ts). Initialized
  // here so the closure captures the Sets after they're declared.
  const memoryMethods = createMemoryMethods(opts, {
    memoryOversizeWarned,
    readOnlyMemoryKeys,
    dispatch,
    nowIso,
  });

  // ─── Per-agent abort + restart ──────────────────────────────────
  // Keyed by agentId. Each running agent's AbortController is registered
  // here so `stopAgent(id)` can abort just that agent without touching
  // the phase or run-level controllers.
  const agentAbortMap = new Map<string, AbortController>();
  // Per-agent restart flags: set by restartAgent(), checked in runOneAgent
  // after an AbortError to decide whether to re-dispatch.
  const agentRestartFlags = new Map<string, boolean>();
  // Per-agent restart counts: limit to 3 to prevent infinite loops.
  const agentRestartCounts = new Map<string, number>();
  // Stops that arrived before the agent was registered in agentAbortMap.
  const pendingStops = new Set<string>();

  // Shared mutable state for ctx.phase + runOneAgent. The same Object
  // is read+mutated by the in-orchestrator helpers below (stopAgent,
  // restartAgent) and by the methods on memoryMethods that share
  // memoryOversizeWarned + readOnlyMemoryKeys. JavaScript Object
  // identity is the contract; replacing the reference would break
  // the link.
  const phaseState: PhaseState = {
    agentCount: 0,
    budgetSpent: 0,
    budgetReserved: 0,
    tokenBudget,
    agentAbortMap,
    agentRestartFlags,
    agentRestartCounts,
    pendingStops,
    memoryOversizeWarned,
    readOnlyMemoryKeys,
  };
  const phaseMethods = createPhaseMethods(opts, {
    state: phaseState,
    dispatch,
    nowIso,
    nowMs,
  });
  const phase = phaseMethods.phase;
  const runOneAgent = phaseMethods.runOneAgent;

  function stopAgent(agentId: string): void {
    const ctrl = agentAbortMap.get(agentId);
    if (ctrl !== undefined) {
      ctrl.abort();
    } else {
      // Agent not yet registered — record it so runOneAgent() aborts on entry.
      pendingStops.add(agentId);
    }
  }

  function restartAgent(agentId: string): void {
    agentRestartFlags.set(agentId, true);
    stopAgent(agentId);
  }

  // ─── ctx.agent ──────────────────────────────────────────────────
  // Implementation in ./ctx/agent.ts; `agent` already bound above.

  // ─── ctx.phase + runOneAgent ───────────────────────────────────
  // Implementations in ./ctx/phase.ts. The factory takes the shared
  // PhaseState bag so its mutations to agentCount / budgetSpent /
  // budgetReserved / the agent abort+restart maps land back in the
  // orchestrator's closure. Bound below `agent` because the cluster
  // initialization assumes the state Sets exist.

  // ─── ctx.cache.* ────────────────────────────────────────────────
  async function cacheGet(key: unknown): Promise<RunCtxBridgeResult<unknown>> {
    return cacheMethods.cacheGet(key);
  }
  async function cacheSet(key: unknown, value: unknown): Promise<RunCtxBridgeResult<null>> {
    return cacheMethods.cacheSet(key, value);
  }
  async function cacheHas(key: unknown): Promise<RunCtxBridgeResult<boolean>> {
    return cacheMethods.cacheHas(key);
  }
  async function cacheDelete(key: unknown): Promise<RunCtxBridgeResult<null>> {
    return cacheMethods.cacheDelete(key);
  }

  // ─── ctx.log ────────────────────────────────────────────────────
  // Implementation in ./ctx/logProgress.ts; this binding wires the
  // factory's return into the host return surface unchanged.
  const logFn = logProgressMethods.logFn;

  // ─── ctx.gate ────────────────────────────────────────────────────
  // Implementation in ./ctx/gate.ts — `gate` already bound above.

  // ─── ctx.interrupt (ZONE_HITL) ─────────────────────────────────────────
  // Mid-phase pause-and-route. The Nth `ctx.interrupt(...)` call gets a
  // deterministic key `int-N` so a resumed run can pre-populate the same
  // call site from the prior ledger's `interrupt_resolved` entries.
  //
  // Returns `{ok:true, value: {key, value}}` to the workflow. Authors
  // doing concurrent interrupts in parallel `ctx.phase()` agents can
  // capture `key` and pass it to `WorkflowClient.resume(runId, value,
  // {key})` for explicit disambiguation. Sequential callers can
  // destructure or ignore the wrapping.

  // ─── ctx.finishCallback ──────────────────────────────────────────
  const finishCallback = logProgressMethods.finishCallback;

  // ─── ctx.progress (Improvement 5) ───────────────────────────────
  const progressFn = logProgressMethods.progressFn;

  // ─── ctx.memo (gap/ctx-memo) ─────────────────────────────────────────
  // Implementation in ./ctx/memo.ts.
  const memo_check = memoMethods.memo_check;
  const memo_set = memoMethods.memo_set;

  // ─── ctx.memory.read / append / compact (gap follow-up #6) ──────
  // ─── ctx.promote (ZONE_WORKTREE follow-up #2) ──────────────────
  // Implementations in ./ctx/memory.ts.
  const memoryRead = memoryMethods.memoryRead;
  const memoryAppend = memoryMethods.memoryAppend;
  const memoryCompact = memoryMethods.memoryCompact;
  const promote = memoryMethods.promote;

  // ─── ctx.checkpoint (Improvement 6) ──────────────────────────────
  const checkpointFn = checkpointReportMethods.checkpointFn;

  // ─── ctx.report (Improvement 7) ──────────────────────────────────
  const reportFn = checkpointReportMethods.reportFn;


  const host: RunCtxHost = {
    runMeta: opts.runMeta,
    input: opts.input,
    tokenBudget,
    agent,
    phase,
    cacheGet,
    cacheSet,
    cacheHas,
    cacheDelete,
    log: logFn,
    finishCallback,
    getBudgetSpent: () => phaseState.budgetSpent,
    progress: progressFn,
    checkpoint: checkpointFn,
    report: reportFn,
    gate,
    interrupt: interruptFn,
    memo_check,
    memo_set,
    memory_read: memoryRead,
    memory_append: memoryAppend,
    memory_compact: memoryCompact,
    promote,
  };
  return {
    host,
    getFinishCallbackPrompt: () => finishPrompt,
    getAgentCount: () => phaseState.agentCount,
    stopAgent,
    restartAgent,
  };
}

// ─── Internals ────────────────────────────────────────────────────

function defaultAgentIdFactory(): () => string {
  // Short, collision-resistant, sortable: 6 random hex bytes.
  return () => sha256(String(Math.random()) + ":" + String(Date.now())).slice(0, 12);
}

/**
 * Schema-validation helpers (extractJson, validateAgainstSchema,
 * SchemaValidationError, InterruptValueValidationError) live in
 * `./schema.ts`. Re-exported here for backwards compatibility with
 * existing import paths.
 */
import {
  extractJson,
  validateAgainstSchema,
  SchemaValidationError,
  InterruptValueValidationError,
} from "./schema.js";
export {
  extractJson,
  validateAgainstSchema,
  SchemaValidationError,
  InterruptValueValidationError,
};

/**
 * Build the schema instruction appended to a prompt when `opts.schema`
 * is present. Stays here — it's only used during prompt construction
 * inside createRunCtxHost and would otherwise widen schema.ts's surface
 * unnecessarily.
 */
function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return (
    "\n\nOutput contract: Respond with a JSON code block matching this schema:\n" +
    "```json\n" +
    JSON.stringify(schema, null, 2) +
    "\n```\n" +
    "Place the JSON block at the END of your response. No other content after it."
  );
}
