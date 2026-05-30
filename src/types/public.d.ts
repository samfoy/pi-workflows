/**
 * pi-workflows — public author-facing types.
 *
 * Per `plan.md` §5.1, this is the IDE-facing type surface authors
 * import via:
 *
 * ```js
 * /// <reference types="@samfp/pi-workflows" />
 * ```
 *
 * Slice 8a populated `WorkflowMain` / `WorkflowContext` for the core
 * `ctx.agent` / `ctx.phase` / `ctx.cache.*` / `ctx.log` /
 * `ctx.finishCallback` surface. Slice 8b extends with the stdlib
 * helpers — `ctx.vote` / `ctx.consensus` / `ctx.parallel` / `ctx.retry`
 * / `ctx.sleep` — per PRD §4.2.6.
 *
 * Frozen-after-8a contract: once 8a lands the public types, no
 * subsequent slice may rename, retype, or remove a public type without
 * a major-version bump. Slice 8b is additive (new helper types) and
 * compatible with the contract.
 */

// ─── Core author types (slice 8a) ────────────────────────────────────

/**
 * Per-agent options. `id` is required for cache-key stability —
 * if omitted, the runtime auto-generates one but cache hits become
 * less reproducible across edits.
 */
export interface AgentOpts {
  /** Stable identifier within the workflow run. */
  readonly id?: string;
  /** Override the default model (e.g. `"sonnet"`, `"opus"`). */
  readonly model?: string;
  /** `"on" | "off" | "auto"` — extended thinking control. */
  readonly thinking?: string;
  /** Per-agent timeout in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Author-supplied extra cache-key seed. Round timestamps to a
   * coarse bucket here if you must include time in prompts.
   */
  readonly cacheKeyExtra?: unknown;
  /**
   * JSON Schema for structured output. When provided, an instruction
   * is appended to the prompt asking the agent to respond with a
   * JSON code block matching this schema. The parsed object is
   * available as `result.output`.
   */
  readonly schema?: Record<string, unknown>;
  /**
   * When `false`, the workflow source SHA-256 is excluded from this
   * agent's cache key. Use for stable recon agents that should survive
   * a workflow file edit on `resume --latest`. Default: `true`.
   */
  readonly bindToWorkflowVersion?: boolean;
  /** Permits any author-defined fields. */
  readonly [extra: string]: unknown;
}

/** Opaque handle returned by `ctx.agent`. Treat as a token. */
export interface AgentHandle {
  readonly kind: "agent";
  readonly id: string;
  readonly prompt: string;
  readonly opts: Readonly<Record<string, unknown>>;
}

/** Token usage breakdown for an agent run. */
export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens: number;
}

/** Resolved agent result returned from `ctx.phase`. */
export interface AgentResult {
  readonly agentId: string;
  readonly text: string;
  readonly usage: Readonly<AgentUsage>;
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly transcriptPath: string;
  readonly cached: boolean;
  /**
   * Parsed structured output. Set when `opts.schema` was provided to
   * `ctx.agent()` and the agent's response contained a valid JSON
   * block. Undefined otherwise.
   */
  readonly output?: unknown;
}

/** Run metadata exposed via `ctx.run`. */
export interface RunMeta {
  readonly id: string;
  readonly workflowName: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly resumed: boolean;
}

// ─── Stdlib helpers (slice 8b) ──────────────────────────────────────

/**
 * `ctx.vote` return shape. The judge picks the winner; `responses`
 * preserves the agent order from the input handle list.
 */
export interface VoteResult {
  readonly winner: string;
  readonly responses: ReadonlyArray<string>;
}

/**
 * `ctx.consensus` return shape. `agreed` reflects whether at least
 * `threshold` fraction of pairwise comparisons crossed the same
 * Jaccard threshold. `majorityText` is the response with the highest
 * mean similarity to all others (PRD §15.A — v1 is naive bucketing,
 * v2 may add LLM judging).
 */
export interface ConsensusResult {
  readonly agreed: boolean;
  readonly majorityText: string;
  readonly responses: ReadonlyArray<string>;
}

export interface ConsensusOpts {
  /** Pair-wise + fraction threshold. Must be in `[0, 1]`. Default 0.6. */
  readonly threshold?: number;
}

export interface ParallelOpts {
  /** Override the auto-generated phase name (default `"parallel"`). */
  readonly phaseName?: string;
}

export interface PhaseOpts {
  /**
   * How to handle agent failures.
   * `'throw'` (default): any failure rejects with AggregateError.
   * `'null'`: failed agents return null in results; workflow continues.
   */
  readonly failMode?: 'throw' | 'null';
  /**
   * Phase-level wall-clock timeout in milliseconds. When the deadline
   * fires, the phase AbortController is aborted and any pending agents
   * are cancelled. Agents already done contribute their results;
   * cancelled agents resolve as errors (subject to `failMode`).
   */
  readonly timeoutMs?: number;
  /**
   * Per-phase concurrency cap. Creates a child semaphore that limits
   * how many agents in THIS phase may run simultaneously. Must be a
   * positive integer. When absent, the run-level semaphore governs.
   */
  readonly maxConcurrent?: number;
}

export interface RetryOpts {
  /** Maximum attempts. Default 3. Must be ≥ 1. */
  readonly attempts?: number;
  /** Base backoff in ms. Default 100. Doubles each iteration. */
  readonly backoffMs?: number;
  /** Optional signal to short-circuit (aborts during backoff too). */
  readonly signal?: AbortSignal;
}

export interface SleepOpts {
  /** Optional signal — falls back to `ctx.signal` if unset. */
  readonly signal?: AbortSignal;
}

// ─── WorkflowContext (the `ctx` author surface) ─────────────────────

/**
 * The first argument to a workflow's default-exported async function.
 * All methods are pure Context-realm wrappers around host-side
 * primitives; their `.constructor === Function` (Context Function)
 * holds (PRD §8.3.4 — see `tests/security/host-realm-eval.workflow.js`).
 */
export interface WorkflowContext {
  /** Run metadata (frozen). */
  readonly run: RunMeta;
  /** Slash-command argument string (post-trim). */
  readonly input: string;
  /** Aborts on stop / kill / pi shutdown. Wired by slice 9. */
  readonly signal: AbortSignal | undefined;

  /** Build an agent handle (does NOT spawn — `ctx.phase` does). */
  agent(prompt: string, opts?: AgentOpts): AgentHandle;
  /** Run a phase of agents in parallel under the run semaphore. */
  phase(name: string, agents: ReadonlyArray<AgentHandle>, opts?: PhaseOpts): Promise<ReadonlyArray<AgentResult | null>>;

  cache: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };

  log(message: string, opts?: { level?: "info" | "warn" | "error" }): void;
  finishCallback(prompt: string): void;

  /** Token budget tracker. Updated after each agent completes. */
  readonly budget: {
    /** Configured token budget, or null if uncapped. */
    readonly total: number | null;
    /** Tokens spent so far (sum of agent totalTokens). */
    spent(): number;
    /** Remaining tokens (Infinity if total is null). */
    remaining(): number;
  };

  /**
   * Emit an ephemeral progress update to the overlay. `pct` must be
   * in `[0, 100]`. `message` is an optional human-readable label.
   * No ledger write — overlay-only / ephemeral.
   */
  progress(pct: number, message?: string): void;

  /**
   * Idempotent checkpoint. Returns `true` if freshly written (first
   * call for this label), `false` if the checkpoint was already set
   * (resumed run hit an existing record). Use to skip expensive
   * re-computation on resume.
   */
  checkpoint(label: string, data?: Record<string, unknown>): Promise<boolean>;

  /**
   * Append a structured report event to the ledger and emit to the
   * overlay. Useful for workflow authors to emit domain-level
   * observability events without polluting `ctx.log`.
   */
  report(eventType: string, data?: Record<string, unknown>): void;

  // ─── stdlib helpers ──────────────────────────────────────────────
  /**
   * Run all `agents` in a single phase, then call `judge(responses)`
   * to pick a winner. `judge` may be sync or async. PRD §4.2.6.
   */
  vote(
    agents: ReadonlyArray<AgentHandle>,
    judge: (responses: ReadonlyArray<string>) => string | Promise<string>,
  ): Promise<VoteResult>;

  /**
   * Run all `agents` and return whether they agree by Jaccard token
   * overlap. v1 is string-similarity-based and crude on technical
   * text — see PRD §15.A. Authors needing semantic consensus should
   * call `ctx.agent` with a judge prompt.
   */
  consensus(
    agents: ReadonlyArray<AgentHandle>,
    opts?: ConsensusOpts,
  ): Promise<ConsensusResult>;

  /**
   * Map `items` → AgentHandle (or array of handles), then run them
   * all in a single phase. `fn` is invoked sequentially per item;
   * concurrency is bounded by the run-level semaphore (cap default
   * 16).
   */
  parallel<T>(
    items: ReadonlyArray<T>,
    fn: (item: T, ctx: WorkflowContext) => AgentHandle | AgentHandle[],
    opts?: ParallelOpts,
  ): Promise<ReadonlyArray<AgentResult>>;

  /**
   * Run items through sequential stages, concurrently across items.
   * If a stage returns an AgentHandle, it is automatically executed
   * via a single-agent phase. Each stage receives
   * `(previousValue, originalItem, index)`.
   */
  pipeline(
    items: ReadonlyArray<unknown>,
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<ReadonlyArray<unknown>>;

  /**
   * Retry `fn` on rejection with exponential backoff. AbortError
   * (or any error during an aborted signal window) is NOT swallowed
   * — it short-circuits the retry chain. Backoff between attempts
   * is `backoffMs * 2^i`.
   */
  retry<T>(fn: () => Promise<T> | T, opts?: RetryOpts): Promise<T>;

  /**
   * Promise resolving after `ms`. Honors `opts.signal` (priority)
   * then `ctx.signal`. Listener is removed on natural resolution
   * to avoid leaks.
   */
  sleep(ms: number, opts?: SleepOpts): Promise<void>;

  /**
   * Human-in-the-loop suspend/confirm gate. Suspends workflow execution
   * until the user approves or denies the operation in the TUI.
   *
   * Returns `true` if approved, `false` if denied.
   * Throws `AbortError` if the run is killed while waiting.
   *
   * When no gate mechanism is wired (e.g. running outside the TUI),
   * resolves immediately using `opts.default` (default `true`).
   */
  gate(message: string, opts?: { default?: boolean }): Promise<boolean>;
}

/** Default-exported workflow function. */
export type WorkflowMain = (
  ctx: WorkflowContext,
  input: string,
) => unknown | Promise<unknown>;
