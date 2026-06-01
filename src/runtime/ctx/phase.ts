/**
 * src/runtime/ctx/phase.ts — ctx.phase + runOneAgent.
 *
 * The two largest method bodies in the createRunCtxHost factory. They
 * share the per-run mutable counters (agentCount, budgetSpent,
 * budgetReserved) and the per-agent abort/restart Maps, so they live
 * together in one factory call.
 *
 * State threading model:
 *   The runCtx orchestrator owns a `PhaseState` object whose mutable
 *   fields the factory mutates through `state.x++` etc. References
 *   stay live across the boundary because the same Object is passed
 *   in. Constants from opts (like opts.perRunAgentCap) are read
 *   directly from `opts`. Sets / Maps in `state` are passed by
 *   reference and mutated on both ends.
 *
 * `runOneAgent` is intentionally exported alongside `phase` because:
 *   - Phase calls it for every handle it dispatches.
 *   - The interrupt path's pre-warm cache check also uses it.
 *   Splitting them across two files would force a circular-import
 *   shim or a redundant duplicate copy.
 *
 * The hand-shaped `buildSchemaInstruction` private helper used to
 * live in runCtx.ts; it sits here because schema.ts deliberately
 * exposes only the validation surface.
 */

import type {
  AgentHandleData,
  AgentResult,
  AgentResultLike,
  AgentUsage,
  DispatcherOptions,
  RunCtxBridgeResult,
  Semaphore,
  SettledAgent,
} from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { recoverFromTranscript } from "../dispatcher.js";
import { agentErrorFromException, log as ledgerLog } from "../ledger.js";
import { agentTranscriptPath } from "../../util/paths.js";
import { cacheKey, sha256 } from "../../util/hash.js";
import { makeSemaphore } from "../semaphore.js";
import {
  buildPromptWithMemory,
  MEMORY_READ_CAP_BYTES,
  parseMemoryOpts,
  memoryReadOnlyKey,
  readMemoryFileWithMeta,
  resolveMemoryDir,
  type MemoryScope,
} from "../agentMemory.js";
import {
  recordAgentMemoryDir,
  recordAgentWorktreePath,
} from "../manifestWriter.js";
import {
  assertGitRepo,
  createWorktreeForAgent,
  emitWorktreeDiff,
  parseIsolation,
  resolveWorktreeDiffPath,
} from "../worktree.js";
import { extractJson, validateAgainstSchema } from "../schema.js";
import { isLikeArray } from "./utils.js";

/**
 * Mutable run-scoped state shared across phase / runOneAgent and a
 * subset of other ctx.* methods (memory + interrupt). The runCtx
 * orchestrator owns this Object; this factory mutates fields via the
 * shared reference.
 */
export interface PhaseState {
  /** Bumped on every dispatch attempt. Capped at opts.perRunAgentCap. */
  agentCount: number;
  /** Sum of agent totalTokens reported on agent_end. */
  budgetSpent: number;
  /** In-flight 1-token-per-agent reservations (BUG-055). */
  budgetReserved: number;
  /** Constant-after-init: opts.tokenBudget mirrored here for convenience. */
  readonly tokenBudget: number | null;
  /** Per-agent AbortController for stopAgent() targeting. */
  readonly agentAbortMap: Map<string, AbortController>;
  /**
   * Agent IDs for which stopAgent() was called before runOneAgent() registered
   * the agent in agentAbortMap. Checked at registration time so the stop is
   * not silently dropped.
   */
  readonly pendingStops: Set<string>;
  /** Set by restartAgent(); checked in runOneAgent's catch to re-dispatch. */
  readonly agentRestartFlags: Map<string, boolean>;
  /** Per-agent restart counts, capped at 3 to prevent loops. */
  readonly agentRestartCounts: Map<string, number>;
  /** Run-scoped Set deduping the one-shot oversize-warn per memory name. */
  readonly memoryOversizeWarned: Set<string>;
  /** Run-scoped Set of (scope:name) tuples that any agent mounted readOnly. */
  readonly readOnlyMemoryKeys: Set<string>;
}

export interface PhaseDeps {
  state: PhaseState;
  /** Resolved dispatcher (opts.dispatch ?? dispatchAgent). */
  dispatch: (opts: DispatcherOptions) => Promise<AgentResult>;
  /** ISO-now factory. */
  nowIso(): string;
  /** Millisecond-now factory. */
  nowMs(): number;
}

/**
 * Build the schema instruction appended to a prompt when `opts.schema`
 * is present. Stays here — only used inside runOneAgent during prompt
 * construction; widening schema.ts's public surface for it would be
 * over-exposure.
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

export function createPhaseMethods(
  opts: RunCtxHostOptions,
  deps: PhaseDeps,
): {
  phase: (
    nameArg: unknown,
    agentsArg: unknown,
    optsArg?: unknown,
  ) => Promise<RunCtxBridgeResult<readonly (AgentResultLike | null)[]>>;
  runOneAgent: (
    handle: AgentHandleData,
    phaseName: string,
    phaseCtrl: AbortController,
    phaseSem?: Semaphore | null,
  ) => Promise<SettledAgent>;
} {
  const state = deps.state;

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
          at: deps.nowIso(),
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
      const phaseStartedAt = deps.nowIso();
      const phaseT0 = deps.nowMs();
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
      const phaseDurationMs = deps.nowMs() - phaseT0;

      if (errors.length > 0) {
        // Abort siblings (best-effort; most are already settled).
        if (!phaseCtrl.signal.aborted) phaseCtrl.abort();
        const phaseEndedAt = deps.nowIso();
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
      const phaseEndedAt = deps.nowIso();
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
    if (state.agentCount >= opts.perRunAgentCap) {
      throw new Error(
        `ctx.phase: per-run agent cap ${opts.perRunAgentCap} exceeded`,
      );
    }
    // Token budget enforcement — checked before deps.dispatch so we don't
    // start an agent we've already budgeted out of.
    // BUG-055: include state.budgetReserved in the check so concurrent agents in a
    // parallel phase cannot all pass simultaneously before any has updated
    // state.budgetSpent (race: all N checks fire synchronously during .map()).
    if (state.tokenBudget !== null && state.budgetSpent + state.budgetReserved >= state.tokenBudget) {
      throw new Error(
        `ctx.phase: token budget exhausted (spent ${state.budgetSpent}, reserved ${state.budgetReserved}, budget ${state.tokenBudget})`,
      );
    }
    // Reserve a slot before the first async yield so sibling parallel callers
    // see a higher committed+reserved value and are blocked at the check above.
    state.budgetReserved += 1;
    state.agentCount++;

    // BUG-FIX: register early so stopAgent() calls during the pre-dispatch
    // awaits (cache check, semaphore acquire, ledger append, worktree setup)
    // are not silently dropped.  The dispatch loop replaces this entry with
    // its own per-iteration controller but keeps preDispatchCtrl.signal in
    // AbortSignal.any so any pre-loop abort is still honoured.
    const preDispatchCtrl = new AbortController();
    state.agentAbortMap.set(handle.id, preDispatchCtrl);
    // BUG-829-FIX: honour a stopAgent() call that arrived before runOneAgent()
    // was invoked (i.e. before the agent was registered in agentAbortMap).
    if (state.pendingStops.has(handle.id)) {
      preDispatchCtrl.abort();
      state.pendingStops.delete(handle.id);
    }

    const t0 = deps.nowMs();

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
        at: deps.nowIso(),
        level: "info",
        message: `[global cache hit] agent=${handle.id} key=${key.slice(0, 16)}…`,
      }).catch(() => undefined);
    }
    const cached = globalCachedResult ?? opts.cache.getAgentResult(key);
    if (cached !== undefined) {
      await opts.ledger.append({
        type: "agent_cache_hit",
        at: deps.nowIso(),
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
      // state.budgetSpent + state.budgetReserved always equals committed + in-flight.
      // BUG-100: cache hits consume no real tokens — skip state.budgetSpent
      // accumulation so cache replays cannot exhaust the token budget.
      state.budgetReserved -= 1;
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
          at: deps.nowIso(),
          phaseName: phaseName,
          agentId: handle.id,
          error: agentErrorFromException(e),
        });
        throw e;
      }
      await opts.ledger.append({
        type: "agent_end",
        at: deps.nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        cached: true,
        durationMs: deps.nowMs() - t0,
        usage: result.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: deps.nowIso(),
          durationMs: deps.nowMs() - t0,
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
        at: deps.nowIso(),
        phaseName,
        agentId: handle.id,
      });
      // BUG-055 / BUG-100: transcript recovery is equivalent to a cache hit
      // — tokens were already spent in the prior run; do not charge again.
      state.budgetReserved -= 1;
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
          at: deps.nowIso(),
          phaseName,
          agentId: handle.id,
          error: agentErrorFromException(e),
        });
        throw e;
      }
      await opts.ledger.append({
        type: "agent_end",
        at: deps.nowIso(),
        phaseName,
        agentId: handle.id,
        cached: true,
        durationMs: deps.nowMs() - t0,
        usage: recovered.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: deps.nowIso(),
          durationMs: deps.nowMs() - t0,
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
      const startedAt = deps.nowIso();
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
          state.readOnlyMemoryKeys.add(memoryReadOnlyKey(memoryScope, memoryName));
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
            !state.memoryOversizeWarned.has(memoryName)
          ) {
            state.memoryOversizeWarned.add(memoryName);
            void opts.ledger
              .append({
                type: "log",
                at: deps.nowIso(),
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
              at: deps.nowIso(),
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
      // every other deps.dispatch failure.
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
          preDispatchCtrl.signal,
          phaseCtrl.signal,
        ]);
        state.agentAbortMap.set(handle.id, agentCtrl);
        try {
          dispatchResult = await deps.dispatch({
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
          const restartCount = state.agentRestartCounts.get(handle.id) ?? 0;
          const shouldRestart =
            state.agentRestartFlags.get(handle.id) === true &&
            restartCount < MAX_AGENT_RESTARTS &&
            (innerErr as { name?: string })?.name === "AbortError";
          if (shouldRestart) {
            state.agentRestartFlags.delete(handle.id);
            state.agentRestartCounts.set(handle.id, restartCount + 1);
            void opts.ledger.append({
              type: "log",
              at: deps.nowIso(),
              level: "info",
              message: `[agent restart] agentId=${handle.id} attempt=${restartCount + 1}/${MAX_AGENT_RESTARTS}`,
            }).catch(() => undefined);
            // Loop continues with a fresh AgentController.
          } else {
            state.agentRestartCounts.delete(handle.id);
            throw innerErr;
          }
        } finally {
          state.agentAbortMap.delete(handle.id);
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
      state.budgetReserved -= 1;
      state.budgetSpent += result.usage.totalTokens;
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
              at: deps.nowIso(),
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
        at: deps.nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        cached: false,
        durationMs: deps.nowMs() - t0,
        usage: result.usage,
      });
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.ended", {
          runId: opts.runMeta.id,
          phaseName,
          agentId: handle.id,
          endedAt: deps.nowIso(),
          durationMs: deps.nowMs() - t0,
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
      // BUG-055: release the reservation on deps.dispatch failure so the budget
      // headroom is correctly restored for subsequent agents.
      state.budgetReserved -= 1;
      // BUG: agentCount was never decremented on failure, permanently consuming
      // a slot of the per-run cap. Decrement here so failed agents don't block
      // future agents from running within the same cap.
      state.agentCount--;
      // Persist the error before propagating.
      await opts.ledger.append({
        type: "agent_error",
        at: deps.nowIso(),
        phaseName: phaseName,
        agentId: handle.id,
        error: agentErrorFromException(e),
      });
      throw e;
    } finally {
      token.release();
    }
  }


  return { phase, runOneAgent };
}
