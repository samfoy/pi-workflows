/**
 * src/types/internal/dispatcher.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the dispatcher slice is needed.
 */

// ───────────────────────────────────────────────────────────────────────
// Slice 6 — Sub-agent dispatcher + parent-death guard + mock branch
// ───────────────────────────────────────────────────────────────────────

/**
 * Per-agent token-usage snapshot extracted from the final `agent_end`
 * event of a `pi --mode json` stream. Real pi (verified at v0.74.0)
 * emits cumulative usage on the inner `turn_end` and per-`message_end`
 * events; the dispatcher latches the LAST `turn_end` reading.
 *
 * All fields default to `0` if the upstream event lacks the field.
 * The dispatcher does not synthesize cost — that's downstream's job.
 *
 * Extends `Readonly<Record<string, number>>` so callers that consume
 * the result via that broader shape (e.g. `AgentResultLike.usage`,
 * OTel attribute payloads) don't need an `as unknown as Record` cast
 * — the index signature is satisfied structurally because every
 * field is a number.
 */
export interface AgentUsage extends Readonly<Record<string, number>> {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

/**
 * Concrete shape returned by `dispatchAgent`. Supersedes the slice-1
 * stub (which only existed to give the registry a return type to
 * compile against). Slice 7 persists this to `cache.jsonl` via
 * `AgentResultLike` (see slice 3 — same field names so the cast is
 * allocation-free).
 */
export interface AgentResult {
  /** True when `agent_end` was observed and stream parsed cleanly. */
  readonly ok: boolean;
  /** Caller-supplied agent id (matches DispatcherOptions.agentId). */
  readonly agentId: string;
  /** Final assistant text content (joined `text` parts only). */
  readonly text: string;
  /** Cumulative token usage from the last `turn_end` event. */
  readonly usage: AgentUsage;
  /** Tool-call invocations observed on the stream (count). */
  readonly toolCalls: number;
  /** Wall time from spawn → `agent_end`, in milliseconds. */
  readonly durationMs: number;
  /**
   * Path the raw NDJSON was teed to (`<runDir>/agents/<id>.jsonl`).
   * For mock-mode runs, points at the same path even though the bytes
   * came from `fixtures.jsonl` — ensures byte-equivalence callers
   * (slice 13 transcript view) can read either source identically.
   */
  readonly transcriptPath: string;
  /** Child exit code if a real subprocess was spawned, else `null`. */
  readonly exitCode: number | null;
}

/**
 * `AgentResult` + the runtime-attached extras the dispatcher / runCtx
 * stack tags onto the value before returning it through `ctx.phase`:
 *
 *   - `cached` — `true` when the result came from the per-run cache
 *     (slice 7) or the global cache (slice 8a). The dispatcher itself
 *     never sets this; runCtx.runOneAgent attaches it on a hit.
 *   - `output` — the parsed object when `agent.opts.schema` was
 *     supplied AND `extractJson(text)` + `validateAgainstSchema(…)`
 *     succeeded. Surfaced on `AgentResult.output` to the workflow
 *     author. Undefined when no schema was set.
 *
 * Defining this once here lets consumers drop
 * `(r as unknown as { cached?: boolean }).cached` casts and read the
 * fields directly. Both fields are optional because they're attached
 * post-hoc, not part of the dispatcher's own return type.
 */
export interface SettledAgent extends AgentResult {
  readonly cached?: boolean;
  // Not `readonly` — the dispatcher attaches `output` after building the
  // base result (post-extractJson + validateAgainstSchema). Consumers
  // SHOULD treat it as read-only at the workflow-author boundary, but
  // the runtime needs to write it once during runOneAgent.
  output?: unknown;
}

/**
 * Slice-6 spawn options. The dispatcher injects `PI_DISABLE_WORKFLOWS=1`
 * + `PI_WORKFLOWS_RECURSIVE=1` (PRD §13.7) on top.
 */
export interface DispatcherOptions {
  readonly runDir: string;
  readonly agentId: string;
  readonly prompt: string;
  /** SHA-256 hex of `prompt` — used as the mock-fixture lookup key. */
  readonly promptHash: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: string;
  /** Subprocess wall-clock timeout. Default 600_000 ms (10 min). */
  readonly timeoutMs?: number;
  /**
   * Grace period between SIGTERM and SIGKILL when the dispatcher
   * escalates a kill (timeout-path or abort-path). Default 5_000 ms.
   * Test seam — production callers should not override.
   */
  readonly killGraceMs?: number;
  /** Caller-controlled abort. Cleanly SIGTERMs the child. */
  readonly signal?: AbortSignal;
  /**
   * If `true` (or `PI_WORKFLOWS_MOCK_AGENTS=1` is set in `envBase`),
   * skip spawn and read from `<runDir>/fixtures.jsonl`.
   */
  readonly mockAgents?: boolean;
  /** `process.env` snapshot used as the spawn-env base. */
  readonly envBase?: NodeJS.ProcessEnv;
  /** Test seam: replaces `child_process.spawn`. */
  readonly spawn?: SpawnLike;
  /** Test seam: replaces `Date.now()` for deterministic durationMs. */
  readonly nowMs?: () => number;
  /** Production never sets this; integration tests do. */
  readonly skipParentDeathGuard?: boolean;
  /**
   * When true, adds `PI_BYPASS_PERMISSIONS=1` to the child env so file
   * edits are auto-approved without prompting. Maps from
   * `WorkflowMeta.acceptEdits`.
   */
  readonly acceptEdits?: boolean;
  /**
   * ZONE_MEMORY: when set, the dispatcher observes
   * `{ type: 'memory_update', text: string }` events on the
   * agent's JSON stream and appends each `text` to
   * `<memoryDir>/MEMORY.md` after the stream settles.
   *
   * The directory is created lazily on first append. Failures are
   * captured into `memoryWriteErrors` on the result so callers can
   * surface them without aborting the agent run.
   */
  readonly memoryDir?: string;
  /**
   * ZONE_MEMORY follow-up #5: when `true`, the dispatcher COLLECTS
   * `{type:'memory_update'}` events but DOES NOT write them to disk
   * — each is logged via stderr instead. Used by `ctx.agent({memory:
   * {scope, readOnly: true}})` to share a "playbook" memory file
   * without granting the sub-agent a write-back channel. No-op when
   * `memoryDir` is unset (no memory was mounted at all).
   */
  readonly memoryReadOnly?: boolean;
}

/** Minimal ChildProcess shape the dispatcher needs. */
export interface SpawnedChildLike {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid?: number;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
}

/** Spawn signature compatible with `child_process.spawn`. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => SpawnedChildLike;

export interface SpawnOptionsLike {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: readonly [unknown, unknown, unknown];
  readonly detached?: boolean;
  readonly signal?: AbortSignal;
  readonly windowsHide?: boolean;
}

/**
 * Snapshot of parent-liveness fields for the manifest. `parentBootId`
 * is empty string when neither `/proc/sys/kernel/random/boot_id` nor a
 * macOS sysctl fallback is available.
 */
export interface ParentLivenessFields {
  readonly parentPid: number;
  readonly parentStartTime: string;
  readonly parentBootId: string;
}

/**
 * Single fixture record in `<runDir>/fixtures.jsonl`. Keyed by
 * `(agentId, promptHash)`.
 */
export interface MockFixture {
  readonly agentId: string;
  readonly promptHash: string;
  readonly result: {
    readonly text: string;
    readonly usage?: Partial<AgentUsage>;
    readonly toolCalls?: number;
    readonly durationMs?: number;
    readonly exitCode?: number | null;
  };
  /** Optional event sequence to write to the transcript file. */
  readonly events?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

