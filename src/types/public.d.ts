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
  phase(name: string, agents: ReadonlyArray<AgentHandle>): Promise<ReadonlyArray<AgentResult>>;

  cache: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };

  log(message: string, opts?: { level?: "info" | "warn" | "error" }): void;
  finishCallback(prompt: string): void;

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
}

/** Default-exported workflow function. */
export type WorkflowMain = (
  ctx: WorkflowContext,
  input: string,
) => unknown | Promise<unknown>;
