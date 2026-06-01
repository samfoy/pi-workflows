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
  /**
   * Mount persistent memory for this agent (ZONE_MEMORY). The runtime
   * resolves a `MEMORY.md` file under the chosen scope, prepends up
   * to 25 KiB of its contents to the prompt as `Persistent memory:\n…`,
   * and lets the sub-agent emit `memory_update` JSON events that
   * append to the same file.
   *
   *   - `'user'`    → `~/.pi/agent/workflows/agent-memory/<name>/MEMORY.md`
   *   - `'project'` → `<cwd>/.pi/workflows/agent-memory/<name>/MEMORY.md`
   *   - `'local'`   → `<runDir>/agent-memory/<name>/MEMORY.md`
   *   - `false` / omitted → no injection, no manifest record.
   *   - `{ scope, readOnly: true }` → inject but refuse appends from
   *     the sub-agent or any later `ctx.memory.append(...)` against
   *     the same `(scope, name)` tuple in this run.
   *
   * `name` defaults to the agent id. See `docs/agent-memory.md`.
   */
  readonly memory?:
    | MemoryScope
    | false
    | { readonly scope: MemoryScope; readonly readOnly?: boolean };
  /**
   * Per-agent isolation mode (ZONE_WORKTREE).
   *
   *   - `'worktree'` mounts the agent inside its own
   *     `git worktree add --detach` checkout off HEAD; the
   *     dispatcher's cwd is rewritten so concurrent agents can't
   *     fight over the same working files. On success a diff is
   *     emitted to `<runDir>/worktrees/<agentId>.diff`.
   *   - `'none'` (default) reuses the run's cwd directly.
   *
   * Requires the run cwd to be inside a git work tree —
   * `NotAGitRepoError` is thrown otherwise. See
   * `docs/agent-worktree.md`.
   */
  readonly isolation?: IsolationMode;
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

// ─── Persistent agent memory (ZONE_MEMORY) ───────────────────────────

/** Memory-scope tag accepted by `ctx.agent({memory})` and `ctx.memory.*`. */
export type MemoryScope = 'user' | 'project' | 'local';

/** Stats returned by `ctx.memory.compact`. */
export interface MemoryCompactResult {
  /** Bytes on disk before compaction. */
  readonly beforeBytes: number;
  /** Bytes on disk after compaction (`afterBytes / beforeBytes` is the ratio). */
  readonly afterBytes: number;
  /** `afterBytes / beforeBytes` (1.0 means no shrinkage). */
  readonly ratio: number;
}

// ─── Isolation tag (ZONE_WORKTREE) ───────────────────────────────────

/** Per-agent isolation mode. `'worktree'` mounts the agent inside a `git worktree add --detach` checkout off HEAD. */
export type IsolationMode = 'worktree' | 'none';

// ─── Aggregation primitive (gap/dsl-primitives) ──────────────────────

/** Methods supported by `ctx.aggregate`. */
export type AggregateMethod =
  | 'borda'
  | 'schulze'
  | 'ranked_pairs'
  | 'kemeny_young'
  | 'instant_runoff'
  | 'coombs'
  | 'score'
  | 'approval';

/** Result returned by `ctx.aggregate`. */
export interface AggregateResult<C = string> {
  /** Top-ranked candidate (== `ranking[0]`). */
  readonly winner: C;
  /** All candidates ranked best-to-worst. */
  readonly ranking: ReadonlyArray<C>;
  /**
   * Numeric score per candidate. Populated by methods that compute
   * scalar scores (`'borda'`, `'score'`, `'approval'`); omitted by
   * pure-ordering methods (`'schulze'`, `'ranked_pairs'`,
   * `'kemeny_young'`, `'instant_runoff'`, `'coombs'`).
   */
  readonly scores?: Readonly<Record<string, number>>;
}

// ─── Critique loop (gap/dsl-primitives) ──────────────────────────────

/** Options accepted by `ctx.critique`. */
export interface CritiqueOpts<O = unknown, C = unknown> {
  /** Called each round with the previous critique (null on round 0). */
  readonly producer: (lastCritique: C | null, round: number) => O | Promise<O>;
  /** Receives the producer's output and returns a critique. */
  readonly critic: (output: O, round: number) => C | Promise<C>;
  /**
   * Returns true when the latest output is acceptable. Default:
   * always returns false (loop runs until `maxRounds` is hit).
   */
  readonly accept?: (critique: C, output: O) => boolean;
  /** Maximum producer→critic rounds. Default 3. Must be >= 1. */
  readonly maxRounds?: number;
}

/** Result of a `ctx.critique` run. */
export interface CritiqueResult<O = unknown, C = unknown> {
  /** Whether `accept(...)` returned true before `maxRounds`. */
  readonly accepted: boolean;
  /** Most recent producer output (or `null` if no rounds ran). */
  readonly output: O | null;
  /** Most recent critique (or `null`). */
  readonly critique: C | null;
  /** Number of rounds executed. */
  readonly rounds: number;
  /** All produced (output, critique) pairs in chronological order. */
  readonly history: ReadonlyArray<{ readonly output: O; readonly critique: C }>;
}

// ─── HITL interrupt (ZONE_HITL) ──────────────────────────────────────

/** Options for `ctx.interrupt`. */
export interface InterruptOpts {
  /** Prompt shown to the supervisor. Required. */
  readonly question: string;
  /** Multiple-choice options. When omitted, the supervisor's value is free-form. */
  readonly choices?: ReadonlyArray<string>;
  /** Default value when no supervisor mechanism is wired (e.g. running outside the TUI). */
  readonly default?: unknown;
  /**
   * Optional JSON Schema. The supervisor's resume payload is
   * validated against this — mismatches throw
   * `InterruptValueValidationError` from the awaiter.
   */
  readonly schema?: Record<string, unknown>;
}

/** Resolved interrupt envelope returned by `ctx.interrupt`. */
export interface InterruptResult<T = unknown> {
  /**
   * Deterministic per-call key (`int-0`, `int-1`, ...). Pass back to
   * `WorkflowClient.resume(runId, value, { key })` for explicit
   * disambiguation when multiple interrupts run concurrently.
   */
  readonly key: string;
  /** Supervisor-injected value (or `default` / `null` when offline). */
  readonly value: T;
}

// ─── Worktree promote (ZONE_WORKTREE follow-up #2) ───────────────────

/** Options for `ctx.promote`. */
export interface PromoteOpts {
  /**
   * `'apply'` (default): runs `git apply` against the parent CWD
   * using the diff captured at `<runDir>/worktrees/<agentId>.diff`.
   * Empty diff is a no-op success.
   *
   * `'rebase'`: runs `git rebase --onto <target>` inside the worktree.
   * Conflicts surface as `PromoteError`; the worktree is left in a
   * rebase-in-progress state for the operator to resolve.
   */
  readonly strategy?: 'apply' | 'rebase';
  /**
   * Rebase target ref. Only meaningful for `strategy: 'rebase'`.
   * Default: `'HEAD'`.
   */
  readonly target?: string;
}

/** Result of a `ctx.promote` call. */
export interface PromoteResult {
  readonly strategy: 'apply' | 'rebase';
  readonly applied: boolean;
  /** Files touched (parsed from the diff or `git diff --name-only`). */
  readonly files: ReadonlyArray<string>;
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
   * Render the run's DAG as a Mermaid `flowchart TD` string. Synchronous;
   * derived from `<runDir>/manifest.json` + `<runDir>/ledger.jsonl`.
   */
  report(opts: { readonly format: 'mermaid' }): string;
  /**
   * Append a structured report event to the ledger and emit to the
   * overlay. Useful for workflow authors to emit domain-level
   * observability events without polluting `ctx.log`.
   */
  report(eventType: string, data?: Record<string, unknown>): void;

  // ─── gap-fix stdlib additions ────────────────────────────────────
  /**
   * Pure JSON extractor. Parses the LAST `` ```json … ``` `` fence in
   * `text`, falling back to bracket-depth scanning when no fence is
   * present. Throws `Error` on no-JSON-found / parse failure.
   * Mirrors the host `extractJson` (BUG-051 + BUG-052 fixed).
   */
  extractJSON(text: string): unknown;

  /**
   * Pure ranked-aggregation primitive. `ballots` shape depends on
   * `method`:
   *
   *   - `'borda'` / `'schulze'` / `'ranked_pairs'` / `'kemeny_young'` /
   *     `'instant_runoff'` / `'coombs'` — array of candidate-ranking
   *     arrays, e.g. `[["a", "b"], ["b", "a"]]`.
   *   - `'score'` — array of `{ candidate: score }` records.
   *   - `'approval'` — array of approved-candidate arrays.
   *
   * Returns `{ winner, ranking, scores? }`. Synchronous; no host bridge.
   */
  aggregate<C = string>(
    method: AggregateMethod,
    ballots: ReadonlyArray<unknown>,
    opts?: Record<string, unknown>,
  ): AggregateResult<C>;

  /**
   * Producer-critic loop. Each round: `producer` is called with the
   * most recent critique (`null` on round 0); the producer's output
   * is fed to `critic`; the critic's output is checked by
   * `accept(critique, output)`. Returns when accepted, or after
   * `maxRounds` with `accepted: false`.
   *
   * Authors typically wrap `ctx.agent + ctx.phase` calls inside
   * `producer` / `critic`; the helper itself is realm-pure and never
   * spawns agents directly.
   */
  critique<O = unknown, C = unknown>(
    opts: CritiqueOpts<O, C>,
  ): Promise<CritiqueResult<O, C>>;

  /**
   * Stdlib helpers for reading and updating an agent's persistent
   * memory file directly. Same scope/name resolution as
   * `ctx.agent({ memory })` — see `docs/agent-memory.md`.
   */
  readonly memory: {
    /**
     * Read the agent's `MEMORY.md` (returns `null` when missing).
     * Truncated to the 25 KiB read cap; oversize files emit a single
     * `log: warn` ledger entry per (run, name).
     */
    read(name: string, scope: MemoryScope): Promise<string | null>;
    /**
     * Append `text` to the agent's `MEMORY.md`. Throws
     * `ReadOnlyMemoryError` if the (scope, name) tuple was previously
     * mounted with `readOnly: true` by a `ctx.agent({memory})` call.
     */
    append(name: string, scope: MemoryScope, text: string): Promise<void>;
    /**
     * Compact older entries via a one-shot summarizer. Recent ~25%
     * of entries are preserved verbatim; older entries are condensed
     * into terse bullet summaries. Returns before/after byte counts
     * plus the size ratio.
     */
    compact(name: string, scope: MemoryScope): Promise<MemoryCompactResult>;
  };

  /**
   * Mid-phase HITL pause-and-route (ZONE_HITL). Suspends the run
   * until a supervisor injects an answer via
   * `WorkflowClient.resume(runId, value)`. Replay-perfect across pi
   * restart — a resumed run replays prior `interrupt_resolved`
   * ledger entries to restore answers without re-prompting.
   *
   * Returns `{ key, value }`. `key` is the deterministic per-call id
   * (`int-0`, `int-1`, ...). The string-shorthand form
   * `ctx.interrupt("...")` is equivalent to
   * `ctx.interrupt({ question: "..." })`.
   */
  interrupt<T = unknown>(
    opts: string | InterruptOpts,
  ): Promise<InterruptResult<T>>;

  /**
   * Promote an agent's worktree edits back into the parent repo
   * (ZONE_WORKTREE follow-up #2). The agent must have run with
   * `{ isolation: 'worktree' }`. Throws `PromoteError` on conflict.
   *
   * Returns `{ strategy, applied, files }` where `files` is parsed
   * from the diff (apply) or `git diff --name-only` (rebase).
   */
  promote(agentId: string, opts?: PromoteOpts): Promise<PromoteResult>;

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

  /**
   * Cross-run memoization. Runs `fn()` on the first call for `key`
   * and caches the result in `~/.pi/agent/memos/<scope>/memo.jsonl`.
   * Subsequent calls within the TTL window return the cached value
   * without re-running `fn`. Safe to use for expensive agent
   * operations that do not need to be repeated across workflow runs.
   *
   * @param key   - Human-readable string key (sha256'd internally).
   * @param fn    - Async producer; called only on cache miss.
   * @param opts  - TTL and scope overrides.
   */
  memo<T = unknown>(
    key: string,
    fn: () => Promise<T>,
    opts?: {
      /** TTL in milliseconds. Default: 24 hours. */
      ttl?: number;
      /**
       * `'global'` (default) — shared across all projects.
       * `'project'` — scoped to `ctx.run.cwd`.
       */
      scope?: 'global' | 'project';
    },
  ): Promise<T>;
}

/** Default-exported workflow function. */
export type WorkflowMain = (
  ctx: WorkflowContext,
  input: string,
) => unknown | Promise<unknown>;
