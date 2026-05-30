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
  CacheRecord,
  RunCtxBridgeResult,
  RunCtxHost,
  RunMetaData,
  Semaphore,
} from "../types/internal.js";
import { CacheStore } from "./cache.js";
import { LedgerWriter, log as ledgerLog } from "./ledger.js";
import { agentErrorFromException } from "./ledger.js";
import { dispatchAgent } from "./dispatcher.js";
import type { PauseGate } from "./pauseGate.js";
import { captureError } from "./realmError.js";
import { cacheKey } from "../util/hash.js";
import { sha256 } from "../util/hash.js";

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
  /** cwd to pass to the dispatcher (PRD §6.2 manifest.cwd). */
  readonly cwd: string;
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
      | "pi-workflows.meta.phases",
    data: Readonly<Record<string, unknown>>,
  ) => void;
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
} {
  const dispatch = opts.dispatch ?? dispatchAgent;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const nowMs = opts.nowMs ?? Date.now;
  const newAgentId = opts.newAgentId ?? defaultAgentIdFactory();

  let agentCount = 0;
  let budgetSpent = 0;
  let finishPrompt: string | null = null;
  const tokenBudget: number | null = opts.tokenBudget ?? null;

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
  ): Promise<RunCtxBridgeResult<readonly AgentResultLike[]>> {
    // Parse failMode from optional third arg.
    const failMode: 'throw' | 'null' =
      optsArg !== null && typeof optsArg === 'object' &&
      (optsArg as Record<string, unknown>).failMode === 'null'
        ? 'null'
        : 'throw';
    try {
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
      const settled: PromiseSettledResult<AgentResult>[] = await Promise.allSettled(
        handles.map((h) => runOneAgent(h, nameArg, phaseCtrl)),
      );

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
          const out: Array<AgentResultLike | null> = settled.map((s) =>
            s.status === 'fulfilled'
              ? ({
                  agentId: s.value.agentId,
                  text: s.value.text,
                  usage: s.value.usage as unknown as Readonly<Record<string, number>>,
                  durationMs: s.value.durationMs,
                  toolCalls: s.value.toolCalls,
                  transcriptPath: s.value.transcriptPath,
                  cached: (s.value as unknown as { cached?: boolean }).cached === true,
                } as AgentResultLike)
              : null,
          );
          return { ok: true, value: out as readonly AgentResultLike[] };
        }

        // Default: throw AggregateError. Preserves MalformedAgentOutputError /
        // AgentSubprocessError class identity for slice-7 ledger distinction.
        const agg = new AggregateError(
          errors,
          `phase "${nameArg}" failed (${errors.length}/${handles.length} agents rejected)`,
        );
        return { ok: false, error: captureError(agg) };
      }

      const results = settled.map((s) =>
        s.status === "fulfilled" ? s.value : (null as unknown as AgentResult),
      );
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
          const entry: AgentResultLike = {
            agentId: r.agentId,
            text: r.text,
            usage: r.usage as unknown as Readonly<Record<string, number>>,
            durationMs: r.durationMs,
            toolCalls: r.toolCalls,
            transcriptPath: r.transcriptPath,
            // F6 — slice 8a derives `cached` (dispatcher doesn't).
            cached: (r as unknown as { cached?: boolean }).cached === true,
          };
          // Preserve schema output if present.
          const out = (r as unknown as { output?: unknown }).output;
          if (out !== undefined) (entry as Record<string, unknown>).output = out;
          return entry;
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
  ): Promise<AgentResult> {
    // Per-run agent cap (PRD §1.2 pin 6).
    if (agentCount >= opts.perRunAgentCap) {
      throw new Error(
        `ctx.phase: per-run agent cap ${opts.perRunAgentCap} exceeded`,
      );
    }
    // Token budget enforcement — checked before dispatch so we don't
    // start an agent we've already budgeted out of.
    if (tokenBudget !== null && budgetSpent >= tokenBudget) {
      throw new Error(
        `ctx.phase: token budget exhausted (spent ${budgetSpent}, budget ${tokenBudget})`,
      );
    }
    agentCount++;

    const startedAt = nowIso();
    const t0 = nowMs();
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

    const key = cacheKey({
      workflowSourceSha256: opts.workflowSourceSha256,
      phaseName,
      agentId: handle.id,
      prompt: handle.prompt,
      opts: handle.opts,
    });

    // Extract schema from opts (used for prompt injection + output parsing).
    const schema =
      handle.opts.schema !== null &&
      typeof handle.opts.schema === 'object' &&
      !Array.isArray(handle.opts.schema)
        ? (handle.opts.schema as Record<string, unknown>)
        : null;

    // Cache hit short-circuits the dispatcher.
    const cached = opts.cache.getAgentResult(key);
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
      const tagged = { ...result, cached: true } as AgentResult & {
        cached: boolean;
      };
      budgetSpent += result.usage.totalTokens;
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
        });
      } catch {
        /* swallow */
      }
      // Schema: re-parse from cached text if schema is present.
      if (schema !== null) {
        (tagged as AgentResult & { output?: unknown }).output = extractJson(result.text);
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
      token = await opts.semaphore.acquire(phaseCtrl.signal);
      if (opts.pauseGate === undefined || !opts.pauseGate.paused) break;
      // Race: pause() ran between the gate-check and the acquire-grant
      // (or this waiter was woken by a release while the gate was
      // already engaged). Drop the slot and re-wait so other runs
      // sharing the cap aren't starved.
      token.release();
    }
    try {
      // Schema injection: build the actual prompt with schema instruction.
      const effectivePrompt = schema
        ? handle.prompt + buildSchemaInstruction(schema)
        : handle.prompt;

      const result = await dispatch({
        runDir: opts.runDirAbs,
        agentId: handle.id,
        prompt: effectivePrompt,
        promptHash: sha256(effectivePrompt),
        cwd: opts.cwd,
        signal: phaseCtrl.signal,
        mockAgents: opts.mockAgents,
        ...(typeof handle.opts.model === "string"
          ? { model: handle.opts.model }
          : {}),
        ...(typeof handle.opts.thinking === "string"
          ? { thinking: handle.opts.thinking }
          : {}),
        ...(typeof handle.opts.timeoutMs === "number"
          ? { timeoutMs: handle.opts.timeoutMs }
          : {}),
        // Slice-8a integration tests use the parent-death wrapper-free
        // path; `RunManager` owns this knob.
        skipParentDeathGuard: opts.mockAgents,
      });
      // Cache the success.
      await opts.cache.setAgentResult(key, {
        agentId: result.agentId,
        text: result.text,
        usage: result.usage as unknown as Readonly<Record<string, number>>,
        durationMs: result.durationMs,
        toolCalls: result.toolCalls,
        transcriptPath: result.transcriptPath,
      });
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
        });
      } catch {
        /* swallow */
      }
      budgetSpent += result.usage.totalTokens;
      // Schema: extract parsed JSON output if schema was provided.
      const schemaOutput: unknown =
        schema !== null ? extractJson(result.text) : undefined;
      const tagged = { ...result, cached: false } as AgentResult & { cached: boolean; output?: unknown };
      if (schemaOutput !== undefined) tagged.output = schemaOutput;
      return tagged;
    } catch (e) {
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
      const level: "info" | "warn" | "error" =
        levelArg === "warn" || levelArg === "error" ? levelArg : "info";
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
      // Fire-and-forget (PRD §4.2.4 returns void). Errors are swallowed
      // via `.catch` since we're sync.
      void ledgerLog(opts.ledger, level, msg, nowIso).catch(() => undefined);
      return { ok: true, value: null };
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
  };
  return {
    host,
    getFinishCallbackPrompt: () => finishPrompt,
    getAgentCount: () => agentCount,
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
 * Extract the last JSON value (object or array) from agent text output.
 * Tries a ```json fence first, then falls back to the last `{` or `[`.
 */
export function extractJson(text: string): unknown {
  // Try ```json ... ``` fence.
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // Fall back to last { or [ in the text.
  const lastBrace = text.lastIndexOf("{");
  const lastBracket = text.lastIndexOf("[");
  const start = Math.max(lastBrace, lastBracket);
  if (start === -1) {
    throw new Error("ctx.agent schema: no JSON found in agent output");
  }
  return JSON.parse(text.slice(start));
}

/**
 * Build the schema instruction appended to a prompt when `opts.schema`
 * is present.
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

// Type-only re-exports kept off the runtime surface; these silence
// TS6133 warnings for imports the host file needs only for typing.
void (null as unknown as CacheRecord);
