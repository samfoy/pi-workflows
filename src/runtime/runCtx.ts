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

  let agentCount = 0;
  let budgetSpent = 0;
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
  let budgetReserved = 0;
  let finishPrompt: string | null = null;
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

  function stopAgent(agentId: string): void {
    agentAbortMap.get(agentId)?.abort();
  }

  function restartAgent(agentId: string): void {
    agentRestartFlags.set(agentId, true);
    stopAgent(agentId);
  }

  // ─── ctx.agent ──────────────────────────────────────────────────
  // Pure: builds a handle object. No I/O. Auto-generates id if absent.
  // Validates agentOpts for known fields. Per-run cap is enforced
  // when the handle is actually run (inside ctx.phase) — checking
  // here would let authors construct N handles but only run a few.
  function agent(prompt: unknown, optsArg: unknown): RunCtxBridgeResult<AgentHandleData> {
    try {
      if (typeof prompt !== "string") {
        throw new TypeError(
          `ctx.agent: prompt must be a string (got ${typeof prompt})`,
        );
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new RangeError(
          `ctx.agent: prompt exceeds MAX_PROMPT_LENGTH (got ${prompt.length}, max ${MAX_PROMPT_LENGTH}). Chunk the input across multiple agents instead of relying on a single oversized call.`,
        );
      }
      const ao =
        optsArg === undefined || optsArg === null
          ? ({} as Record<string, unknown>)
          : (optsArg as Record<string, unknown>);
      if (typeof ao !== "object" || Array.isArray(ao)) {
        throw new TypeError("ctx.agent: opts must be a plain object or omitted");
      }
      // Plain JSON-clone to strip Context-realm prototypes — gives the
      // host a safe, mutation-immune snapshot.
      const optsClone: Record<string, unknown> = JSON.parse(
        JSON.stringify(ao),
      );
      const id =
        typeof optsClone.id === "string" && optsClone.id.length > 0
          ? optsClone.id
          : newAgentId();
      // Hand the id back via opts.id so cache-key derivation has it
      // even if the author didn't supply one.
      optsClone.id = id;
      const handle: AgentHandleData = {
        kind: "agent",
        id,
        prompt,
        opts: Object.freeze(optsClone),
      };
      return { ok: true, value: handle };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.phase ──────────────────────────────────────────────────
  async function phase(
    nameArg: unknown,
    agentsArg: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<readonly (AgentResultLike | null)[]>> {
    try {
      // BUG-018 fix: parse failMode INSIDE the try block so a Proxy with a
      // throwing getter cannot escape the RunCtxBridgeResult envelope.
      // BUG-056 fix: reject invalid failMode values so typos like 'NULL' or
      // 'null-on-error' are caught here and returned as an error envelope
      // rather than silently coercing to 'throw'.
      const rawFailMode =
        optsArg !== null && typeof optsArg === 'object'
          ? (optsArg as Record<string, unknown>).failMode
          : undefined;
      const failMode: 'throw' | 'null' = rawFailMode === 'null' ? 'null' : 'throw';
      if (rawFailMode !== undefined && rawFailMode !== 'throw' && rawFailMode !== 'null') {
        throw new TypeError(
          `phase() opts.failMode must be 'throw' or 'null', got: ${JSON.stringify(rawFailMode)}`,
        );
      }
      if (typeof nameArg !== "string" || nameArg.length === 0) {
        throw new TypeError("ctx.phase: name must be a non-empty string");
      }
      if (!isLikeArray(agentsArg)) {
        throw new TypeError("ctx.phase: agents must be an array");
      }
      const handles: AgentHandleData[] = [];
      for (let i = 0; i < (agentsArg as ArrayLike<unknown>).length; i++) {
        const h = (agentsArg as ArrayLike<unknown>)[i];
        if (
          h === null ||
          typeof h !== "object" ||
          (h as { kind?: unknown }).kind !== "agent" ||
          typeof (h as { id?: unknown }).id !== "string" ||
          typeof (h as { prompt?: unknown }).prompt !== "string"
        ) {
          throw new TypeError(
            `ctx.phase: agents[${i}] is not a valid AgentHandle (use ctx.agent(...))`,
          );
        }
        const ho = h as Record<string, unknown>;
        const cleanOpts =
          ho.opts === undefined
            ? {}
            : (JSON.parse(JSON.stringify(ho.opts)) as Record<string, unknown>);
        handles.push({
          kind: "agent",
          id: ho.id as string,
          prompt: ho.prompt as string,
          opts: Object.freeze(cleanOpts),
        });
      }

      // BUG-002 fix: warn when a large phase runs without failMode:'null'
      if (handles.length >= 3 && failMode === 'throw') {
        await opts.ledger.append({
          type: "log",
          at: nowIso(),
          level: "warn",
          message: `phase "${nameArg}" has ${handles.length} agents but failMode:'throw' (default) — a single failure or timeout will discard all results. Pass { failMode: 'null' } as the third arg to ctx.phase() to handle partial failures gracefully.`,
        });
      }

      // Improvement 2: per-phase semaphore cap.
      const rawMaxConcurrent =
        optsArg !== null && typeof optsArg === 'object'
          ? (optsArg as Record<string, unknown>).maxConcurrent
          : undefined;
      const phaseSem =
        typeof rawMaxConcurrent === 'number' && rawMaxConcurrent > 0
          ? makeSemaphore({ cap: rawMaxConcurrent })
          : null;

      // Improvement 1: per-phase timeout.
      const rawPhaseTimeout =
        optsArg !== null && typeof optsArg === 'object'
          ? (optsArg as Record<string, unknown>).timeoutMs
          : undefined;
      const phaseTimeoutMs =
        typeof rawPhaseTimeout === 'number' && rawPhaseTimeout > 0
          ? rawPhaseTimeout
          : undefined;

      // Phase ledger entry.
      const phaseStartedAt = nowIso();
      const phaseT0 = nowMs();
      await opts.ledger.append({
        type: "phase_start",
        at: phaseStartedAt,
        phaseName: nameArg,
        agentCount: handles.length,
      });
      // Slice 14: emit overlay event so the TUI phase view picks it up.
      try {
        opts.emitOverlayEvent?.("pi-workflows.phase.started", {
          runId: opts.runMeta.id,
          phaseName: nameArg,
          agentCount: handles.length,
          startedAt: phaseStartedAt,
        });
      } catch {
        /* emission failures must not abort the phase */
      }

      // Per-phase abort: aborting other agents when one rejects.
      const phaseCtrl = new AbortController();
      // Forward the run-level abort.
      const onRunAbort = (): void => phaseCtrl.abort(opts.signal.reason);
      if (opts.signal.aborted) phaseCtrl.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onRunAbort, { once: true });

      // Run each handle through the run's semaphore.
      // Improvement 1: race allSettled against the phase timeout deadline.
      const allSettled = Promise.allSettled(
        handles.map((h) => runOneAgent(h, nameArg, phaseCtrl, phaseSem)),
      );
      let settled: PromiseSettledResult<SettledAgent>[];
      if (phaseTimeoutMs !== undefined) {
        let deadlineTimer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `phase "${nameArg}" timed out after ${phaseTimeoutMs}ms`,
                ),
              ),
            phaseTimeoutMs,
          );
        });
        settled = await Promise.race([
          allSettled.then((r) => {
            clearTimeout(deadlineTimer);
            return r;
          }),
          deadline.catch(() => {
            phaseCtrl.abort();
            return allSettled;
          }),
        ]);
      } else {
        settled = await allSettled;
      }

      opts.signal.removeEventListener("abort", onRunAbort);

      const errors: unknown[] = [];
      for (const s of settled) {
        if (s.status === "rejected") errors.push(s.reason);
      }

      const okCount = settled.filter((s) => s.status === "fulfilled").length;
      const errCount = errors.length;
      const cacheHitCount = settled.reduce((acc, s) => {
        if (s.status !== "fulfilled") return acc;
        return (s.value as AgentResult & { cached?: boolean }).cached === true
          ? acc + 1
          : acc;
      }, 0);
      const phaseDurationMs = nowMs() - phaseT0;

      if (errors.length > 0) {
        // Abort siblings (best-effort; most are already settled).
        if (!phaseCtrl.signal.aborted) phaseCtrl.abort();
        const phaseEndedAt = nowIso();
        await opts.ledger.append({
          type: "phase_end",
          at: phaseEndedAt,
          phaseName: nameArg,
          durationMs: phaseDurationMs,
          agentResults: { ok: okCount, error: errCount, cacheHit: cacheHitCount },
        });
        try {
          opts.emitOverlayEvent?.("pi-workflows.phase.ended", {
            runId: opts.runMeta.id,
            phaseName: nameArg,
            endedAt: phaseEndedAt,
            durationMs: phaseDurationMs,
          });
        } catch {
          /* swallow */
        }

        if (failMode === 'null') {
          // failMode: 'null' — return nulls for failed agents, continue.
          const out: Array<AgentResultLike | null> = settled.map((s) => {
            if (s.status !== 'fulfilled') return null;
            const v = s.value; // SettledAgent
            const entry: Record<string, unknown> = {
              agentId: v.agentId,
              text: v.text,
              usage: v.usage,
              durationMs: v.durationMs,
              toolCalls: v.toolCalls,
              transcriptPath: v.transcriptPath,
              cached: v.cached === true,
            };
            // Preserve schema output if present (mirror the all-success
            // path below). Without this, fulfilled agents lose their
            // parsed structured output whenever a sibling fails.
            if (v.output !== undefined) entry.output = v.output;
            return entry as AgentResultLike;
          });
          // BUG-057 fix: preserve | null in the bridge result type so the
          // sandbox receives the correct shape and callers can distinguish
          // failed agents from successful ones.
          return { ok: true, value: out as readonly (AgentResultLike | null)[] };
        }

        // Default: throw AggregateError. Preserves MalformedAgentOutputError /
        // AgentSubprocessError class identity for slice-7 ledger distinction.
        const agg = new AggregateError(
          errors,
          `phase "${nameArg}" failed (${errors.length}/${handles.length} agents rejected)`,
        );
        return { ok: false, error: captureError(agg) };
      }

      const results: SettledAgent[] = settled.map((s) => {
        if (s.status !== "fulfilled") {
          // Unreachable in practice: the error branch above returns
          // before this map runs. Throwing here keeps the array type
          // honest — better than `null as unknown as SettledAgent`.
          throw new Error(
            `runCtx phase "${nameArg}": invariant violated — non-fulfilled settled in success path`,
          );
        }
        return s.value;
      });
      const phaseEndedAt = nowIso();
      await opts.ledger.append({
        type: "phase_end",
        at: phaseEndedAt,
        phaseName: nameArg,
        durationMs: phaseDurationMs,
        agentResults: { ok: okCount, error: errCount, cacheHit: cacheHitCount },
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.phase.ended", {
          runId: opts.runMeta.id,
          phaseName: nameArg,
          endedAt: phaseEndedAt,
          durationMs: phaseDurationMs,
        });
      } catch {
        /* swallow */
      }
      // Strip non-JSON fields, return plain JSON-cloneable agent results.
      const out: AgentResultLike[] = results.map(
        (r): AgentResultLike => {
          const entry: Record<string, unknown> = {
            agentId: r.agentId,
            text: r.text,
            usage: r.usage,
            durationMs: r.durationMs,
            toolCalls: r.toolCalls,
            transcriptPath: r.transcriptPath,
            // F6 — slice 8a derives `cached` (dispatcher doesn't).
            cached: r.cached === true,
          };
          // Preserve schema output if present.
          if (r.output !== undefined) entry.output = r.output;
          return entry as AgentResultLike;
        },
      );
      return { ok: true, value: out };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── single-agent runner (cache hit + dispatcher) ───────────────
  async function runOneAgent(
    handle: AgentHandleData,
    phaseName: string,
    phaseCtrl: AbortController,
    /** Improvement 2: optional per-phase semaphore; overrides run semaphore. */
    phaseSem?: Semaphore | null,
  ): Promise<SettledAgent> {
    // Per-run agent cap (PRD §1.2 pin 6).
    if (agentCount >= opts.perRunAgentCap) {
      throw new Error(
        `ctx.phase: per-run agent cap ${opts.perRunAgentCap} exceeded`,
      );
    }
    // Token budget enforcement — checked before dispatch so we don't
    // start an agent we've already budgeted out of.
    // BUG-055: include budgetReserved in the check so concurrent agents in a
    // parallel phase cannot all pass simultaneously before any has updated
    // budgetSpent (race: all N checks fire synchronously during .map()).
    if (tokenBudget !== null && budgetSpent + budgetReserved >= tokenBudget) {
      throw new Error(
        `ctx.phase: token budget exhausted (spent ${budgetSpent}, reserved ${budgetReserved}, budget ${tokenBudget})`,
      );
    }
    // Reserve a slot before the first async yield so sibling parallel callers
    // see a higher committed+reserved value and are blocked at the check above.
    budgetReserved += 1;
    agentCount++;

    const t0 = nowMs();

    // BUG-W04: agent_start is logged AFTER semaphore acquire (see below).
    // BUG-101: strip execution-only fields (timeoutMs, bindToWorkflowVersion)
    // before hashing so innocent changes don't invalidate valid cache entries.
    // Improvement 4: strip bindToWorkflowVersion from cacheable opts too.
    const {
      timeoutMs: _omitTimeout,
      bindToWorkflowVersion: _omitBtv,
      ...cacheableOpts
    } = handle.opts as Record<string, unknown> & { timeoutMs?: unknown; bindToWorkflowVersion?: unknown };
    // Improvement 4: skip workflowSourceSha256 when bindToWorkflowVersion===false.
    const keySha =
      (handle.opts as Record<string, unknown>).bindToWorkflowVersion === false
        ? ''
        : opts.workflowSourceSha256;
    const key = cacheKey({
      workflowSourceSha256: keySha,
      phaseName,
      agentId: handle.id,
      prompt: handle.prompt,
      opts: cacheableOpts,
    });

    // Extract schema from opts (used for prompt injection + output parsing).
    const schema =
      handle.opts.schema !== null &&
      typeof handle.opts.schema === 'object' &&
      !Array.isArray(handle.opts.schema)
        ? (handle.opts.schema as Record<string, unknown>)
        : null;

    // Cache hit short-circuits the dispatcher.
    // Global cache checked first (cross-run hits), then per-run cache.
    const globalCachedResult = opts.globalCache?.getAgentResult(key);
    if (globalCachedResult !== undefined) {
      // Warm the per-run cache so subsequent same-run agents hit locally.
      await opts.cache.setAgentResult(key, globalCachedResult);
      void opts.ledger.append({
        type: "log",
        at: nowIso(),
        level: "info",
        message: `[global cache hit] agent=${handle.id} key=${key.slice(0, 16)}…`,
      }).catch(() => undefined);
    }
    const cached = globalCachedResult ?? opts.cache.getAgentResult(key);
    if (cached !== undefined) {
      await opts.ledger.append({
        type: "agent_cache_hit",
        at: nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
      });
      const result: AgentResult = {
        ok: true,
        agentId: cached.agentId,
        text: cached.text,
        usage: ((cached.usage as unknown) as AgentUsage) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        toolCalls: typeof cached.toolCalls === "number" ? cached.toolCalls : 0,
        durationMs:
          typeof cached.durationMs === "number" ? cached.durationMs : 0,
        transcriptPath:
          typeof cached.transcriptPath === "string"
            ? cached.transcriptPath
            : "",
        exitCode:
          typeof (cached as { exitCode?: unknown }).exitCode === "number" ||
          (cached as { exitCode?: unknown }).exitCode === null
            ? ((cached as { exitCode?: number | null }).exitCode ?? null)
            : null,
      };
      // Tag cached=true for slice-7 ledger.
      const tagged: SettledAgent = { ...result, cached: true };
      // BUG-055: release the reservation and record actual spend together so
      // budgetSpent + budgetReserved always equals committed + in-flight.
      // BUG-100: cache hits consume no real tokens — skip budgetSpent
      // accumulation so cache replays cannot exhaust the token budget.
      budgetReserved -= 1;
      // BUG-053 fix: parse schema output BEFORE logging agent_end so that an
      // extractJson failure logs agent_error (not a silent phase rejection
      // against a ledger that already shows agent_end success).
      try {
        if (schema !== null) {
          const parsed = extractJson(result.text);
          // gap-fix: post-parse schema validation. Throws SchemaValidationError
          // before the result is returned so authors see WHERE the agent
          // drifted, not just that it did.
          validateAgainstSchema(parsed, schema);
          (tagged as AgentResult & { output?: unknown }).output = parsed;
        }
      } catch (e) {
        await opts.ledger.append({
          type: "agent_error",
          at: nowIso(),
          phaseName: phaseName,
          agentId: handle.id,
          error: agentErrorFromException(e),
        });
        throw e;
      }
      await opts.ledger.append({
        type: "agent_end",
        at: nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        cached: true,
        durationMs: nowMs() - t0,
        usage: result.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: nowIso(),
          durationMs: nowMs() - t0,
          cached: true,
          usage: result.usage,
        });
      } catch {
        /* swallow */
      }
      return tagged;
    }

    // Cache miss: before acquiring a semaphore slot and re-dispatching,
    // check whether a complete transcript already exists from a prior run
    // that crashed after the subprocess finished but before
    // `cache.setAgentResult()` flushed (late cache-hit recovery).
    const transcriptPath = agentTranscriptPath(opts.runDirAbs, handle.id);
    const recovered = await recoverFromTranscript(transcriptPath, handle.id);
    if (recovered !== null) {
      // Warm the cache so subsequent resumes get a true cache hit.
      await opts.cache.setAgentResult(key, {
        agentId: recovered.agentId,
        text: recovered.text,
        usage: recovered.usage,
        durationMs: recovered.durationMs,
        toolCalls: recovered.toolCalls,
        transcriptPath: recovered.transcriptPath,
      });
      await opts.ledger.append({
        type: "agent_cache_hit",
        at: nowIso(),
        phaseName,
        agentId: handle.id,
      });
      // BUG-055 / BUG-100: transcript recovery is equivalent to a cache hit
      // — tokens were already spent in the prior run; do not charge again.
      budgetReserved -= 1;
      // BUG-053 pattern: extract schema BEFORE logging agent_end so that
      // an extractJson failure only writes agent_error, never agent_end.
      const tagged: SettledAgent = { ...recovered, cached: true };
      try {
        if (schema !== null) {
          const parsed = extractJson(recovered.text);
          validateAgainstSchema(parsed, schema);
          tagged.output = parsed;
        }
      } catch (e) {
        await opts.ledger.append({
          type: "agent_error",
          at: nowIso(),
          phaseName,
          agentId: handle.id,
          error: agentErrorFromException(e),
        });
        throw e;
      }
      await opts.ledger.append({
        type: "agent_end",
        at: nowIso(),
        phaseName,
        agentId: handle.id,
        cached: true,
        durationMs: nowMs() - t0,
        usage: recovered.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: nowIso(),
          durationMs: nowMs() - t0,
          cached: true,
          usage: recovered.usage,
        });
      } catch {
        /* swallow */
      }
      return tagged;
    }

    // Cache miss: spawn a real agent. Slice 12 — the pause gate must
    // be honored both BEFORE acquiring a slot (so a paused run holds
    // no shared resources) AND AFTER acquiring (because semaphore
    // grants triggered by a previous in-flight release would
    // otherwise unblock waiters that pre-dated the pause).
    //
    // Loop discipline: check gate → acquire → if paused, release back
    // and loop. Bounded by `cap * pauseCount` iterations (each pause
    // burst can only thrash `cap` slots once).
    let token: { release(): void };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.pauseGate !== undefined) {
        await opts.pauseGate.waitWhilePaused(phaseCtrl.signal);
      }
      // Improvement 2: use phaseSem if provided, else run-level semaphore.
      token = await (phaseSem ?? opts.semaphore).acquire(phaseCtrl.signal);
      if (opts.pauseGate === undefined || !opts.pauseGate.paused) break;
      // Race: pause() ran between the gate-check and the acquire-grant
      // (or this waiter was woken by a release while the gate was
      // already engaged). Drop the slot and re-wait so other runs
      // sharing the cap aren't starved.
      token.release();
    }
    try {
      // BUG-W04: log agent_start AFTER semaphore acquire so the ledger
      // accurately reflects when the agent actually started executing,
      // not when it was submitted to the queue.
      const startedAt = nowIso();
      await opts.ledger.append({
        type: "agent_start",
        at: startedAt,
        phaseName: phaseName,
        agentId: handle.id,
        promptHash: sha256(handle.prompt),
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.started", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          startedAt,
        });
      } catch {
        /* swallow */
      }

      // Schema injection: build the actual prompt with schema instruction.
      const promptWithSchema = schema
        ? handle.prompt + buildSchemaInstruction(schema)
        : handle.prompt;

      // ZONE_MEMORY: resolve + read MEMORY.md for this agent and
      // prepend `Persistent memory:\n<content>\n\n` to the prompt.
      // No-op when `opts.memory` is absent / false / unrecognized;
      // a missing MEMORY.md silently produces no injection so first
      // runs work without any setup.
      let memoryDir: string | null = null;
      let memoryContent: string | null = null;
      const rawMemoryOpt = (handle.opts as Record<string, unknown>).memory;
      // gap follow-up #5: object shape `{scope, readOnly}` lets shared
      // "playbook" memory get injected without granting the sub-agent
      // a write-back channel. parseMemoryOpts is a strict superset of
      // parseMemoryScope so legacy string callers still work.
      const memoryOpts = parseMemoryOpts(rawMemoryOpt);
      const memoryScope = memoryOpts === null ? null : memoryOpts.scope;
      const memoryReadOnly = memoryOpts === null ? false : memoryOpts.readOnly;
      if (memoryScope !== null) {
        const rawName = (handle.opts as Record<string, unknown>).name;
        const memoryName =
          typeof rawName === "string" && rawName.length > 0
            ? rawName
            : handle.id;
        // gap follow-up #5: lock (scope, name) tuples mounted with
        // readOnly:true so a later ctx.memory.append against the
        // same tuple throws ReadOnlyMemoryError. The flag persists
        // for the run — a single readOnly mount poisons writes for
        // the rest of the run, matching the "shared playbook" intent.
        if (memoryReadOnly) {
          readOnlyMemoryKeys.add(memoryReadOnlyKey(memoryScope, memoryName));
        }
        try {
          memoryDir = resolveMemoryDir({
            scope: memoryScope,
            name: memoryName,
            cwd: opts.cwd,
            runDirAbs: opts.runDirAbs,
          });
          const memoryRead = await readMemoryFileWithMeta(memoryDir);
          memoryContent = memoryRead === null ? null : memoryRead.content;
          // gap follow-up #2: emit a one-shot warning per (run, name)
          // pair when MEMORY.md exceeds the 25 KiB read cap. Keeps
          // the prompt-truncation contract silent on every read while
          // surfacing it once so authors notice the file outgrew
          // the budget.
          if (
            memoryRead !== null &&
            memoryRead.truncated &&
            !memoryOversizeWarned.has(memoryName)
          ) {
            memoryOversizeWarned.add(memoryName);
            void opts.ledger
              .append({
                type: "log",
                at: nowIso(),
                level: "warn",
                message: `agent-memory: MEMORY.md for "${memoryName}" (${memoryRead.totalBytes} bytes) exceeds the ${MEMORY_READ_CAP_BYTES}-byte read cap; only the leading slice is injected. Consider ctx.memory.compact("${memoryName}", "${memoryScope}").`,
              })
              .catch(() => undefined);
          }
          // Record the resolved dir into the manifest so resume
          // re-mounts the same path. Best-effort — manifest write
          // failures are not fatal to the agent run.
          recordAgentMemoryDir(opts.runDirAbs, memoryName, memoryDir).catch(
            () => undefined,
          );
        } catch (e) {
          void opts.ledger
            .append({
              type: "log",
              at: nowIso(),
              level: "warn",
              message: `agent-memory: failed to resolve dir for "${memoryName}" (scope=${memoryScope}): ${(e as Error).message}`,
            })
            .catch(() => undefined);
          memoryDir = null;
          memoryContent = null;
        }
      }
      const effectivePrompt = buildPromptWithMemory(
        promptWithSchema,
        memoryContent,
      );

      // ZONE_WORKTREE: when `opts.isolation === 'worktree'`, mount
      // the agent inside its own `git worktree add --detach` checkout
      // off HEAD. The dispatcher's cwd is rewritten to point at that
      // worktree so concurrent agents can't fight over the same
      // working files (gap-analysis 2026-05-31 §3 — same-file write
      // race seen in `hunt-bugs-loop`). On success we emit a diff at
      // `<runDir>/worktrees/<agentId>.diff`. On error we leave the
      // worktree in place for inspection.
      //
      // Failures here (bad opts shape, non-git cwd, or `git worktree
      // add` itself) are thrown unhandled so the outer agent-lifecycle
      // catch block ledgers `agent_error`, decrements the budget
      // reservation, and releases the semaphore token uniformly with
      // every other dispatch failure.
      let worktreeCwd: string | null = null;
      const rawIsolation = (handle.opts as Record<string, unknown>).isolation;
      const isolationMode = parseIsolation(rawIsolation);
      if (isolationMode === "worktree") {
        // Refuse worktree mode if the run cwd isn't inside a git
        // work tree — typed `NotAGitRepoError` lets the runtime
        // distinguish env mis-config from a generic dispatcher
        // failure.
        await assertGitRepo({ cwd: opts.cwd });
        worktreeCwd = await createWorktreeForAgent({
          runDirAbs: opts.runDirAbs,
          agentId: handle.id,
          cwd: opts.cwd,
        });
        // Best-effort manifest record so resume can re-attach.
        recordAgentWorktreePath(
          opts.runDirAbs,
          handle.id,
          worktreeCwd,
        ).catch(() => undefined);
      }
      const dispatchCwd = worktreeCwd ?? opts.cwd;

      // Per-agent abort/restart loop. Each iteration creates a fresh
      // AbortController composed with the phase-level signal so either
      // `stopAgent(id)` or a phase abort kills just the right scope.
      const MAX_AGENT_RESTARTS = 3;
      let dispatchResult!: AgentResult;
      let dispatchLoopDone = false;
      while (!dispatchLoopDone) {
        const agentCtrl = new AbortController();
        // AbortSignal.any is available since Node 20.3 (we run Node 25).
        const composedSignal = AbortSignal.any([
          agentCtrl.signal,
          phaseCtrl.signal,
        ]);
        agentAbortMap.set(handle.id, agentCtrl);
        try {
          dispatchResult = await dispatch({
            runDir: opts.runDirAbs,
            agentId: handle.id,
            prompt: effectivePrompt,
            promptHash: sha256(effectivePrompt),
            cwd: dispatchCwd,
            signal: composedSignal,
            mockAgents: opts.mockAgents,
            ...(opts.acceptEdits ? { acceptEdits: true } : {}),
            ...(memoryDir !== null ? { memoryDir } : {}),
            ...(memoryReadOnly ? { memoryReadOnly: true } : {}),
            ...(typeof handle.opts.model === "string"
              ? { model: handle.opts.model }
              : {}),
            ...(typeof handle.opts.thinking === "string"
              ? { thinking: handle.opts.thinking }
              : {}),
            // Improvement 3: per-agent timeout falls back to run-wide default.
            timeoutMs:
              typeof handle.opts.timeoutMs === 'number'
                ? handle.opts.timeoutMs
                : (opts.defaultAgentTimeoutMs ?? 600_000),
            // Slice-8a integration tests use the parent-death wrapper-free
            // path; `RunManager` owns this knob.
            skipParentDeathGuard: opts.mockAgents,
          });
          dispatchLoopDone = true;
        } catch (innerErr) {
          // Per-agent restart: only when the abort was triggered by
          // restartAgent() (flag set), not by a phase/run abort.
          const restartCount = agentRestartCounts.get(handle.id) ?? 0;
          const shouldRestart =
            agentRestartFlags.get(handle.id) === true &&
            restartCount < MAX_AGENT_RESTARTS &&
            (innerErr as { name?: string })?.name === "AbortError";
          if (shouldRestart) {
            agentRestartFlags.delete(handle.id);
            agentRestartCounts.set(handle.id, restartCount + 1);
            void opts.ledger.append({
              type: "log",
              at: nowIso(),
              level: "info",
              message: `[agent restart] agentId=${handle.id} attempt=${restartCount + 1}/${MAX_AGENT_RESTARTS}`,
            }).catch(() => undefined);
            // Loop continues with a fresh AgentController.
          } else {
            agentRestartCounts.delete(handle.id);
            throw innerErr;
          }
        } finally {
          agentAbortMap.delete(handle.id);
        }
      }
      const result = dispatchResult;
      // Cache the success.
      const cacheEntry = {
        agentId: result.agentId,
        text: result.text,
        usage: result.usage,
        durationMs: result.durationMs,
        toolCalls: result.toolCalls,
        transcriptPath: result.transcriptPath,
      };
      await opts.cache.setAgentResult(key, cacheEntry);
      // Also write to the global cache so future runs of the same workflow
      // version can reuse this result without re-dispatching.
      if (opts.globalCache !== undefined) {
        await opts.globalCache.setAgentResult(key, cacheEntry);
      }
      // BUG-055: release the reservation and record actual spend together.
      budgetReserved -= 1;
      budgetSpent += result.usage.totalTokens;
      // ZONE_WORKTREE: capture `git diff HEAD` from inside the
      // worktree on success. Best-effort — a diff failure (e.g.
      // git was uninstalled mid-run) is logged but never fails the
      // agent. The worktree itself is not removed; auto-prune is
      // tracked in docs/agent-worktree.md.
      if (worktreeCwd !== null) {
        const diffPath = resolveWorktreeDiffPath({
          runDirAbs: opts.runDirAbs,
          agentId: handle.id,
        });
        try {
          await emitWorktreeDiff({
            worktreePath: worktreeCwd,
            diffPath,
          });
        } catch (e) {
          void opts.ledger
            .append({
              type: "log",
              at: nowIso(),
              level: "warn",
              message: `worktree diff failed for agent ${handle.id}: ${(e as Error).message}`,
            })
            .catch(() => undefined);
        }
      }
      // BUG-054 fix: extract schema output BEFORE logging agent_end so that
      // an extractJson failure only writes agent_error (the existing catch
      // block below), never both agent_end AND agent_error.
      let schemaOutput: unknown = undefined;
      if (schema !== null) {
        schemaOutput = extractJson(result.text);
        validateAgainstSchema(schemaOutput, schema);
      }
      await opts.ledger.append({
        type: "agent_end",
        at: nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        cached: false,
        durationMs: nowMs() - t0,
        usage: result.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: nowIso(),
          durationMs: nowMs() - t0,
          cached: false,
          usage: result.usage,
        });
      } catch {
        /* swallow */
      }
      const tagged: SettledAgent = { ...result, cached: false };
      if (schemaOutput !== undefined) tagged.output = schemaOutput;
      return tagged;
    } catch (e) {
      // BUG-055: release the reservation on dispatch failure so the budget
      // headroom is correctly restored for subsequent agents.
      budgetReserved -= 1;
      // Persist the error before propagating.
      await opts.ledger.append({
        type: "agent_error",
        at: nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        error: agentErrorFromException(e),
      });
      throw e;
    } finally {
      token.release();
    }
  }

  // ─── ctx.cache.* ────────────────────────────────────────────────
  async function cacheGet(key: unknown): Promise<RunCtxBridgeResult<unknown>> {
    try {
      requireString(key, "ctx.cache.get: key");
      return { ok: true, value: opts.cache.getAuthorCache(key as string) };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }
  async function cacheSet(key: unknown, value: unknown): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.cache.set: key");
      // Eagerly check JSON-cloneability — better error site than disk.
      try {
        JSON.stringify(value);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.cache.set: value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const cloned: unknown =
        value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      await opts.cache.setAuthorCache(key as string, cloned);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }
  async function cacheHas(key: unknown): Promise<RunCtxBridgeResult<boolean>> {
    try {
      requireString(key, "ctx.cache.has: key");
      return { ok: true, value: opts.cache.hasAuthorCache(key as string) };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }
  async function cacheDelete(key: unknown): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.cache.delete: key");
      await opts.cache.deleteAuthorCache(key as string);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.log ────────────────────────────────────────────────────
  function logFn(message: unknown, levelArg: unknown): RunCtxBridgeResult<null> {
    try {
      const level: "info" | "warn" | "error" = (
        (typeof levelArg === "string" ? levelArg : (levelArg as any)?.level) ?? "info"
      ) as "info" | "warn" | "error";
      const msg =
        typeof message === "string"
          ? message
          : (() => {
              try {
                return JSON.stringify(message);
              } catch {
                return String(message);
              }
            })();
      // Single ledger entry per ctx.log call (the `log` shape).
      // The previous implementation also appended an `agent_log`
      // entry here, producing two ledger lines per ctx.log — that
      // duplicated the OTel exporter's output and made `tail -f`
      // confusing. The `log` entry is the canonical one; readers that
      // want agent attribution can correlate via the surrounding
      // `agent_start`/`agent_end` events.
      void ledgerLog(opts.ledger, level, msg, nowIso).catch(() => undefined);
      // Overlay event: lets the TUI agent-detail view show ctx.log lines.
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.log", {
          line: msg,
          runId: opts.runMeta.id,
          agentId: "",
          level,
        });
      } catch {
        /* swallow — overlay failures must not block the run */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.gate ────────────────────────────────────────────────────
  async function gate(
    messageArg: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<boolean>> {
    try {
      requireString(messageArg, "ctx.gate: message");
      const message = messageArg as string;
      const gateOpts =
        optsArg !== null && typeof optsArg === "object"
          ? (optsArg as Record<string, unknown>)
          : {};
      const defaultAnswer =
        typeof gateOpts.default === "boolean" ? gateOpts.default : true;

      // 1. Log the gate request to the ledger.
      await opts.ledger.append({
        type: "gate_requested",
        at: nowIso(),
        message,
      });

      // 2. Emit overlay event so the TUI can show the gate prompt.
      try {
        opts.emitOverlayEvent?.("pi-workflows.gate.requested", {
          runId: opts.runMeta.id,
          message,
          defaultAnswer,
        });
      } catch {
        /* overlay emission failures must not abort the gate */
      }

      // 3. Wait for a response (or fall back to the default if no mechanism
      //    is wired — e.g. running outside the TUI).
      let approved: boolean;
      if (opts.waitForGate !== undefined) {
        approved = await opts.waitForGate(message, opts.signal);
      } else {
        approved = defaultAnswer;
      }

      // 4. Log the gate resolution.
      await opts.ledger.append({
        type: "gate_resolved",
        at: nowIso(),
        approved,
      });

      try {
        opts.emitOverlayEvent?.("pi-workflows.gate.resolved", {
          runId: opts.runMeta.id,
          approved,
        });
      } catch {
        /* swallow */
      }

      return { ok: true, value: approved };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

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
  let interruptCounter = 0;
  async function interruptFn(
    optsArg: unknown,
  ): Promise<RunCtxBridgeResult<{ key: string; value: unknown }>> {
    try {
      const cfg = parseInterruptOpts(optsArg);
      const idx = interruptCounter++;
      const key = `int-${idx}`;

      // Helper: validate the resolved value against opts.schema if
      // present. Throws InterruptValueValidationError on mismatch —
      // the workflow's awaiter sees the typed error in its catch
      // block (or in the agent’s rejected promise). On success: no-op.
      const validateValue = (val: unknown): void => {
        if (cfg.schema === undefined) return;
        try {
          validateAgainstSchema(val, cfg.schema);
        } catch (e) {
          if (e instanceof SchemaValidationError) {
            throw new InterruptValueValidationError(
              key,
              e.path,
              e.expected,
              e.actual,
            );
          }
          throw e;
        }
      };

      // 1. Replay-perfect short-circuit. If a prior run resolved this
      //    interrupt and the result was replayed in via opts, return it
      //    immediately. We still emit a single `interrupt_resolved` entry
      //    with `source:"replay"` so the new ledger captures the answer
      //    even though no IPC round-trip happened (a downstream resume
      //    of THIS run finds it without re-walking the prior ledger).
      //    Schema validation re-runs here — the schema may have changed
      //    between runs, and cached "good" values from a stricter past
      //    schema must still pass the current one.
      if (
        opts.replayResolvedInterrupts !== undefined &&
        opts.replayResolvedInterrupts.has(key)
      ) {
        const replayed = opts.replayResolvedInterrupts.get(key);
        const normalized = replayed === undefined ? null : replayed;
        validateValue(normalized);
        await opts.ledger.append({
          type: "interrupt_resolved",
          at: nowIso(),
          key,
          value: normalized,
          source: "replay",
        });
        return { ok: true, value: { key, value: normalized } };
      }

      // 2. Write the request entry. Choices/default are optional;
      //    only include when present so JSON output stays minimal.
      const requestEntry: {
        type: "interrupt_requested";
        at: string;
        key: string;
        question: string;
        choices?: ReadonlyArray<string>;
        default?: unknown;
      } = {
        type: "interrupt_requested",
        at: nowIso(),
        key,
        question: cfg.question,
      };
      if (cfg.choices !== undefined) requestEntry.choices = cfg.choices;
      if (cfg.hasDefault) requestEntry.default = cfg.defaultValue;
      await opts.ledger.append(requestEntry);

      // 3. Overlay event (best-effort).
      try {
        opts.emitOverlayEvent?.("pi-workflows.interrupt.requested", {
          runId: opts.runMeta.id,
          key,
          question: cfg.question,
          ...(cfg.choices !== undefined ? { choices: cfg.choices } : {}),
          ...(cfg.hasDefault ? { default: cfg.defaultValue } : {}),
        });
      } catch {
        /* swallow — overlay failures must not abort the interrupt */
      }

      // 4. Block. waitForInterrupt is wired by RunManager and resolves
      //    when a `resume-interrupt` ctrl command arrives. When absent
      //    (unit test / running outside the TUI) fall back to default.
      let value: unknown;
      let source: "ipc" | "default";
      if (opts.waitForInterrupt !== undefined) {
        value = await opts.waitForInterrupt(key, opts.signal);
        source = "ipc";
      } else {
        value = cfg.hasDefault ? cfg.defaultValue : null;
        source = "default";
      }

      // 5. Normalize undefined → null so the ledger never stores
      //    `undefined` (not valid JSON; matches buildResultEntry).
      const normalized = value === undefined ? null : value;

      // 6. JSON-clone defense — catches realm-leaks and circular refs
      //    at the host boundary, mirroring memo_set / report.
      try {
        JSON.stringify(normalized);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.interrupt: resolved value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const cloned: unknown = JSON.parse(JSON.stringify(normalized));

      // 6b. Schema validation (gap follow-up #3). Runs AFTER the
      //     JSON-clone so the validated value is the one we'd actually
      //     store. On mismatch, the resolution still gets ledgered
      //     (so a future replay sees what was injected) but the
      //     workflow's await throws InterruptValueValidationError.
      let schemaError: InterruptValueValidationError | null = null;
      try {
        validateValue(cloned);
      } catch (e) {
        if (e instanceof InterruptValueValidationError) {
          schemaError = e;
        } else {
          throw e;
        }
      }

      // 7. Write the resolution entry.
      await opts.ledger.append({
        type: "interrupt_resolved",
        at: nowIso(),
        key,
        value: cloned,
        source,
      });

      try {
        opts.emitOverlayEvent?.("pi-workflows.interrupt.resolved", {
          runId: opts.runMeta.id,
          key,
          value: cloned as Record<string, unknown> | unknown,
          source,
        });
      } catch {
        /* swallow */
      }

      if (schemaError !== null) throw schemaError;
      return { ok: true, value: { key, value: cloned } };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.finishCallback ──────────────────────────────────────────
  function finishCallback(prompt: unknown): RunCtxBridgeResult<null> {
    try {
      if (typeof prompt !== "string") {
        throw new TypeError("ctx.finishCallback: prompt must be a string");
      }
      finishPrompt = prompt;
      // slice 10 will hook actual delivery; slice 8a only records.
      opts.onFinishCallback?.(prompt);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.progress (Improvement 5) ───────────────────────────────
  function progressFn(pct: unknown, message?: unknown): RunCtxBridgeResult<null> {
    try {
      if (typeof pct !== "number" || pct < 0 || pct > 100) {
        throw new TypeError(
          `ctx.progress: pct must be a number in [0, 100], got ${JSON.stringify(pct)}`,
        );
      }
      const msg = message === undefined ? undefined : String(message);
      // Overlay-only — no ledger write (ephemeral per spec).
      try {
        opts.emitOverlayEvent?.("pi-workflows.progress", {
          runId: opts.runMeta.id,
          pct,
          ...(msg !== undefined ? { message: msg } : {}),
        });
      } catch {
        /* emission failures must not abort the run */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.memo (gap/ctx-memo) ─────────────────────────────────────────
  // memo_check: check the persistent memo store for a hit.
  // memo_set:   persist a value after a sandbox-side fn() produces it.
  // Both operate on ~/ (global) or per-project JSONL stores.
  const DEFAULT_MEMO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async function memo_check(
    key: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<{ hit: boolean; value?: unknown }>> {
    try {
      requireString(key, "ctx.memo: key");
      const { scope, ttlMs } = parseMemoOpts(optsArg);
      const store = await getMemoStore(scope, scope === "project" ? opts.cwd : undefined);
      const keyHash = sha256(key as string);
      void ttlMs; // checked at set-time; check here is informational only
      if (!store.has(keyHash)) {
        return { ok: true, value: { hit: false } };
      }
      const entry = store.get(keyHash);
      if (entry === null) {
        return { ok: true, value: { hit: false } };
      }
      return { ok: true, value: { hit: true, value: entry.value } };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memo_set(
    key: unknown,
    value: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.memo: key");
      // Eagerly check JSON-cloneability — better error site than disk.
      try {
        JSON.stringify(value);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.memo: value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const { scope, ttlMs } = parseMemoOpts(optsArg);
      const store = await getMemoStore(scope, scope === "project" ? opts.cwd : undefined);
      const keyHash = sha256(key as string);
      const cloned: unknown = JSON.parse(JSON.stringify(value));
      await store.set(keyHash, cloned, ttlMs);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.memory.read / append / compact (gap follow-up #6) ──────
  // Stdlib helpers letting workflow authors read or update a
  // sub-agent's persistent memory directly, without going through
  // a sub-agent's `memory_update` JSONL event. Same scope/name
  // resolution as `ctx.agent({memory})` so authors don't reinvent
  // path math.

  /**
   * Default `summarize` hook for `ctx.memory.compact`. Spawns a
   * single short `pi --mode json -p` agent (no transcript persisted,
   * no semaphore slot) asking it to preserve recent entries verbatim
   * and condense the older ones. The returned string is the
   * compacted MEMORY.md body.
   *
   * Failures bubble up as `CompactionError` from `compactMemoryFile`
   * so authors see a typed error and the original file stays intact.
   */
  async function defaultCompactSummarize(
    name: string,
    original: string,
  ): Promise<string> {
    // Tiny synthetic agent id for the dispatcher — prefixed so it's
    // easy to spot in transcripts. `assertSafeAgentId` accepts this
    // shape (no `..`, no `/`, no leading `.`).
    const compactAgentId = `memory-compact-${name}-${Date.now().toString(
      36,
    )}`;
    const prompt = [
      `You are compacting a long-running agent's persistent memory file.`,
      `Agent name: ${name}`,
      ``,
      `Goal: produce a shorter version that preserves the MOST RECENT`,
      `~25% of entries verbatim and condenses older entries into terse`,
      `bullet summaries grouped by theme. Keep dates / identifiers.`,
      `Drop redundant restatements. Output ONLY the new MEMORY.md body`,
      `— no preamble, no fences, no commentary.`,
      ``,
      `--- begin original MEMORY.md ---`,
      original,
      `--- end original MEMORY.md ---`,
    ].join("\n");
    const result = await dispatch({
      runDir: opts.runDirAbs,
      agentId: compactAgentId,
      prompt,
      promptHash: sha256(prompt),
      cwd: opts.cwd,
      mockAgents: opts.mockAgents,
    });
    if (typeof result.text !== "string" || result.text.length === 0) {
      throw new Error(
        `ctx.memory.compact: agent returned empty text for "${name}"`,
      );
    }
    return result.text;
  }

  function resolveMemoryArgs(
    name: unknown,
    scope: unknown,
    fnName: string,
  ): { dir: string; scope: MemoryScope; name: string } {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`${fnName}: name must be a non-empty string`);
    }
    if (
      scope !== "user" &&
      scope !== "project" &&
      scope !== "local"
    ) {
      throw new TypeError(
        `${fnName}: scope must be 'user' | 'project' | 'local' (got ${JSON.stringify(scope)})`,
      );
    }
    const parsed = scope as MemoryScope;
    const dir = resolveMemoryDir({
      scope: parsed,
      name,
      cwd: opts.cwd,
      runDirAbs: opts.runDirAbs,
    });
    return { dir, scope: parsed, name };
  }

  async function memoryRead(
    name: unknown,
    scope: unknown,
  ): Promise<RunCtxBridgeResult<string | null>> {
    try {
      const { dir, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.read",
      );
      const r = await readMemoryFileWithMeta(dir);
      if (r === null) return { ok: true, value: null };
      // Re-use the same one-shot oversize-warn dedup as auto-injection.
      if (r.truncated && !memoryOversizeWarned.has(safeName)) {
        memoryOversizeWarned.add(safeName);
        void opts.ledger
          .append({
            type: "log",
            at: nowIso(),
            level: "warn",
            message: `agent-memory: MEMORY.md for "${safeName}" (${r.totalBytes} bytes) exceeds the ${MEMORY_READ_CAP_BYTES}-byte read cap.`,
          })
          .catch(() => undefined);
      }
      return { ok: true, value: r.content };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memoryAppend(
    name: unknown,
    scope: unknown,
    text: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      const { dir, scope: parsedScope, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.append",
      );
      // gap follow-up #5: refuse to write to a (scope, name) tuple
      // that any prior ctx.agent() call mounted with readOnly:true.
      if (readOnlyMemoryKeys.has(memoryReadOnlyKey(parsedScope, safeName))) {
        throw new ReadOnlyMemoryError(safeName, parsedScope);
      }
      if (typeof text !== "string") {
        throw new TypeError(
          `ctx.memory.append: text must be a string (got ${typeof text})`,
        );
      }
      await appendMemoryUpdate(dir, text);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memoryCompact(
    name: unknown,
    scope: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      beforeBytes: number;
      afterBytes: number;
      ratio: number;
    }>
  > {
    try {
      const { dir, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.compact",
      );
      const summarize = opts.compactSummarize ?? defaultCompactSummarize;
      const result = await compactMemoryFile({
        dir,
        summarize: (original) => summarize(safeName, original),
      });
      void opts.ledger
        .append({
          type: "log",
          at: nowIso(),
          level: "info",
          message: `agent-memory: compacted MEMORY.md for "${safeName}" (${result.beforeBytes} → ${result.afterBytes} bytes, ratio=${result.ratio.toFixed(3)})`,
        })
        .catch(() => undefined);
      memoryOversizeWarned.delete(safeName);
      return { ok: true, value: result };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.promote (ZONE_WORKTREE follow-up #2) ──────────────────

  async function promote(
    agentId: unknown,
    promoteOpts?: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      strategy: "apply" | "rebase";
      applied: boolean;
      files: readonly string[];
    }>
  > {
    try {
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new TypeError(
          `ctx.promote: agentId must be a non-empty string (got ${typeof agentId})`,
        );
      }
      // Tolerate undefined/null — default opts apply with strategy:'apply'.
      let parsed: { strategy?: "apply" | "rebase"; target?: string } = {};
      if (promoteOpts !== undefined && promoteOpts !== null) {
        if (typeof promoteOpts !== "object" || Array.isArray(promoteOpts)) {
          throw new TypeError(
            `ctx.promote: opts must be an object (got ${typeof promoteOpts})`,
          );
        }
        const o = promoteOpts as Record<string, unknown>;
        if (o.strategy !== undefined) {
          if (o.strategy !== "apply" && o.strategy !== "rebase") {
            throw new TypeError(
              `ctx.promote: opts.strategy must be 'apply' | 'rebase' (got ${JSON.stringify(o.strategy)})`,
            );
          }
          parsed.strategy = o.strategy;
        }
        if (o.target !== undefined) {
          if (typeof o.target !== "string" || o.target.length === 0) {
            throw new TypeError(
              `ctx.promote: opts.target must be a non-empty string (got ${typeof o.target})`,
            );
          }
          parsed.target = o.target;
        }
      }
      const result = await promoteAgentWorktree({
        runDirAbs: opts.runDirAbs,
        agentId,
        sourceCwd: opts.cwd,
        opts: parsed,
      });
      void opts.ledger
        .append({
          type: "log",
          at: nowIso(),
          level: "info",
          message: `agent-worktree: promoted "${agentId}" (${result.strategy}, applied=${result.applied}, files=${result.files.length})`,
        })
        .catch(() => undefined);
      return { ok: true, value: result };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.checkpoint (Improvement 6) ──────────────────────────────
  async function checkpointFn(
    label: unknown,
    data?: unknown,
  ): Promise<RunCtxBridgeResult<boolean>> {
    try {
      if (typeof label !== "string" || label.length === 0) {
        throw new TypeError(
          "ctx.checkpoint: label must be a non-empty string",
        );
      }
      if (await opts.cache.hasCheckpoint(label)) {
        // Already set — checkpoint_hit (resumed run).
        void opts.ledger.append({
          type: "checkpoint_hit",
          at: nowIso(),
          label,
        });
        return { ok: true, value: false };
      }
      // First write — persist and record.
      await opts.cache.setCheckpoint(label, data);
      void opts.ledger.append({
        type: "checkpoint_set",
        at: nowIso(),
        label,
      });
      return { ok: true, value: true };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // ─── ctx.report (Improvement 7) ──────────────────────────────────
  function reportFn(
    eventTypeOrAccessor: unknown,
    data?: unknown,
  ): RunCtxBridgeResult<null | string> {
    try {
      // gap/viz: accessor form `ctx.report({format:'mermaid'})` returns
      // the run's DAG as a Mermaid string. Detected by the first
      // argument being an object with a `format` field; everything else
      // falls through to the existing event-emit semantics.
      if (
        eventTypeOrAccessor !== null &&
        typeof eventTypeOrAccessor === "object" &&
        !Array.isArray(eventTypeOrAccessor) &&
        "format" in (eventTypeOrAccessor as Record<string, unknown>)
      ) {
        const fmt = (eventTypeOrAccessor as Record<string, unknown>)["format"];
        if (fmt !== "mermaid") {
          throw new TypeError(
            `ctx.report: unsupported format ${JSON.stringify(fmt)} (only 'mermaid' is implemented)`,
          );
        }
        const mmd = renderMermaidSync(opts.runDirAbs);
        return { ok: true, value: mmd };
      }

      const eventType = eventTypeOrAccessor;
      if (typeof eventType !== "string" || eventType.length === 0) {
        throw new TypeError(
          "ctx.report: eventType must be a non-empty string",
        );
      }
      // JSON-serialize data to catch circular refs.
      let parsedData: unknown;
      if (data !== undefined) {
        try {
          parsedData = JSON.parse(JSON.stringify(data));
        } catch (cycErr) {
          throw new TypeError(
            `ctx.report: data is not JSON-serializable (${(cycErr as Error).message})`,
          );
        }
      }
      // Append to ledger (fire-and-forget).
      void opts.ledger.append({
        type: "report",
        at: nowIso(),
        event: eventType,
        ...(parsedData !== undefined ? { data: parsedData } : {}),
      });
      // Emit to overlay.
      try {
        opts.emitOverlayEvent?.("pi-workflows.report", {
          runId: opts.runMeta.id,
          event: eventType,
          ...(parsedData !== undefined ? { data: parsedData as Record<string, unknown> } : {}),
        });
      } catch {
        /* swallow */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  function parseMemoOpts(optsArg: unknown): { scope: "global" | "project"; ttlMs: number } {
    const scope: "global" | "project" =
      optsArg !== null &&
      typeof optsArg === "object" &&
      (optsArg as Record<string, unknown>).scope === "project"
        ? "project"
        : "global";
    let ttlMs = DEFAULT_MEMO_TTL_MS;
    if (
      optsArg !== null &&
      typeof optsArg === "object" &&
      typeof (optsArg as Record<string, unknown>).ttl === "number"
    ) {
      const raw = (optsArg as Record<string, unknown>).ttl as number;
      if (raw > 0) ttlMs = raw;
    }
    return { scope, ttlMs };
  }

  /**
   * ZONE_HITL — normalize `ctx.interrupt(opts)` argument shape.
   *
   * Accepts:
   *   - a plain string (treated as `{ question }`)
   *   - `{ question: string, choices?: string[], default?: unknown,
   *      schema?: object }`
   *
   * Throws on any other shape so the caller's error envelope carries a
   * descriptive message. JSON-clones `choices` and `default` so realm
   * leaks / cycles fail at the host boundary.
   *
   * `schema` (if provided) is validated against the resume value
   * before the interrupt resolves — see `interruptFn` below for the
   * validation site. Schema is NOT JSON-cloned because schema objects
   * commonly contain shared references (e.g. nested object types) that
   * are JSON-cloneable but the clone is wasteful; we hold the original
   * reference in the runtime.
   */
  function parseInterruptOpts(optsArg: unknown): {
    question: string;
    choices?: ReadonlyArray<string>;
    hasDefault: boolean;
    defaultValue: unknown;
    schema?: Record<string, unknown>;
  } {
    if (typeof optsArg === "string") {
      return { question: optsArg, hasDefault: false, defaultValue: undefined };
    }
    if (optsArg === null || typeof optsArg !== "object" || Array.isArray(optsArg)) {
      throw new TypeError(
        "ctx.interrupt: opts must be a string question or { question, choices?, default?, schema? } object",
      );
    }
    const o = optsArg as Record<string, unknown>;
    if (typeof o.question !== "string" || o.question.length === 0) {
      throw new TypeError(
        "ctx.interrupt: opts.question must be a non-empty string",
      );
    }
    let choices: ReadonlyArray<string> | undefined;
    if (o.choices !== undefined) {
      if (!Array.isArray(o.choices)) {
        throw new TypeError("ctx.interrupt: opts.choices must be an array of strings");
      }
      const arr = o.choices as unknown[];
      const cleaned: string[] = [];
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (typeof c !== "string") {
          throw new TypeError(
            `ctx.interrupt: opts.choices[${i}] must be a string (got ${typeof c})`,
          );
        }
        cleaned.push(c);
      }
      choices = Object.freeze(cleaned.slice());
    }
    const hasDefault = Object.prototype.hasOwnProperty.call(o, "default");
    let defaultValue: unknown = undefined;
    if (hasDefault) {
      try {
        defaultValue = JSON.parse(JSON.stringify(o.default));
      } catch (cycErr) {
        throw new TypeError(
          `ctx.interrupt: opts.default is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
    }
    let schema: Record<string, unknown> | undefined;
    if (o.schema !== undefined && o.schema !== null) {
      if (typeof o.schema !== "object" || Array.isArray(o.schema)) {
        throw new TypeError(
          "ctx.interrupt: opts.schema must be a JSON Schema object",
        );
      }
      schema = o.schema as Record<string, unknown>;
    }
    const out: {
      question: string;
      choices?: ReadonlyArray<string>;
      hasDefault: boolean;
      defaultValue: unknown;
      schema?: Record<string, unknown>;
    } = { question: o.question, hasDefault, defaultValue };
    if (choices !== undefined) out.choices = choices;
    if (schema !== undefined) out.schema = schema;
    return out;
  }

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
    getBudgetSpent: () => budgetSpent,
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
    getAgentCount: () => agentCount,
    stopAgent,
    restartAgent,
  };
}

// ─── Internals ────────────────────────────────────────────────────

function defaultAgentIdFactory(): () => string {
  // Short, collision-resistant, sortable: 6 random hex bytes.
  return () => sha256(String(Math.random()) + ":" + String(Date.now())).slice(0, 12);
}

function isLikeArray(v: unknown): v is ArrayLike<unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { length?: unknown }).length === "number"
  );
}

function requireString(v: unknown, label: string): void {
  if (typeof v !== "string") {
    throw new TypeError(`${label}: expected string, got ${typeof v}`);
  }
}

/**

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
