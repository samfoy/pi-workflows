/**
 * src/types/internal/sandbox.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the sandbox slice is needed.
 */

import type { AgentResultLike } from "./cache.js";

// ───────────────────────────────────────────────────────────────────────
// Slice 2 — vm.Context sandbox + frozen globals + realm error contract
// ───────────────────────────────────────────────────────────────────────

/**
 * Reified, host-visible record of an error captured at the host↔Context
 * boundary. The Context-realm Error returned to the script is built from
 * this record (see `src/runtime/realmError.ts::reconstructError`); the
 * record itself is also persisted to the ledger by slice 7 for debugging.
 *
 * Field semantics follow PRD §8.3.4's reconstruction contract.
 */
export interface RealmErrorRecord {
  /** Constructor name of the original throw value. `"Error"` for non-Errors. */
  readonly name: string;
  /** Stringified message (always present, possibly empty). */
  readonly message: string;
  /** Original `.stack` if the throw was an Error; otherwise `null`. */
  readonly stack: string | null;
  /**
   * `true` for non-Error throws (`throw 42`, `throw "hi"`, etc.); the
   * reconstructed Context-realm Error carries this flag verbatim. Real
   * Errors MUST NOT have this set.
   */
  readonly wrappedNonError: boolean;
  /**
   * For non-Error throws, normalized type tag ("number", "string",
   * "boolean", "bigint", "undefined", "symbol", "function", "object",
   * "null"). Absent for real Errors.
   */
  readonly originalType?: string;
  /** AggregateError children, recursively reconstructed. Absent otherwise. */
  readonly errors?: readonly RealmErrorRecord[];
  /** `.cause` chain, recursively reconstructed. Absent if no cause. */
  readonly cause?: RealmErrorRecord;
}

/**
 * Sandbox violation — thrown by host-side wrappers when a sandbox
 * invariant cannot be safely repaired (e.g. realm-error reconstruction
 * itself blew up, or the bridge was tampered with). NOT thrown for
 * ordinary script errors (those propagate as Context-realm Errors
 * unchanged).
 *
 * Slice 7's ledger writes one `sandbox_violation` entry per instance.
 */
export interface SandboxViolationError extends Error {
  readonly name: "SandboxViolationError";
  /** Short tag for dispatch / metric labels. */
  readonly violation:
    | "bridge-tampered"
    | "realm-error-reconstruct-failed"
    | "timer-host-exception"
    | "timer-table-limit-exceeded"
    | "init-script-failed"
    | "shape-detect-failed"
    | "compile-failed"
    | "sync-timeout";
  /** Optional underlying cause from the host side (not surfaced to script). */
  readonly hostCause?: unknown;
}

/**
 * Console capture — what `console.log` and friends inside the sandbox
 * funnel into. Slice 7 replaces this with a ledger writer; slice 2
 * gives it a plain in-memory list so unit tests can assert.
 */
export interface SandboxLogEntry {
  /** ISO-8601 host time (slice-2 helper, slice 7 will use ledger time). */
  readonly t: string;
  readonly level: "log" | "info" | "warn" | "error" | "debug";
  /**
   * Pre-stringified arguments (each via `safeStringify`). We don't keep
   * raw values — they may carry Context-realm prototypes that surprise
   * downstream consumers.
   */
  readonly args: readonly string[];
}

/**
 * Construction options for a Sandbox. `signal` is required — sandboxes
 * are always tied to a run lifecycle. `log` is optional in slice 2 and
 * required by slice 8a (DI'd from the ledger writer); when omitted the
 * sandbox keeps an internal in-memory array reachable via
 * `Sandbox#takeLog()`.
 *
 * Slice 8a adds `ctx` (the workflow author API via `runCtxHost`).
 */
export interface SandboxOptions {
  readonly signal: AbortSignal;
  /** Sink for `console.*` from inside the sandbox. */
  readonly log?: (entry: SandboxLogEntry) => void;
  /**
   * Optional input value passed to the script's `(ctx, input) =>` body.
   * Strings/JSON-cloneable values only; the host-side caller is
   * responsible for `JSON.parse(JSON.stringify(...))` cloning before
   * passing — see `safeCloneIntoContext` in `sandbox.ts`.
   */
  readonly input?: unknown;
  /**
   * Override the wall-clock used inside the sandbox for `Date.now`.
   * Slice 9 (replay) sets this; slice 2 leaves it `undefined`.
   */
  readonly nowMs?: () => number;
  /**
   * Allow `eval` and `Function(...)` to compile new code. Default: true
   * (matches PRD §4.3 ⚠ row). Tests use `false` to make the absence
   * provable.
   */
  readonly allowCodegen?: boolean;
  /**
   * Optional debug name for the vm.Context (used in stack traces).
   * Defaults to `pi-workflows:sandbox`.
   */
  readonly debugName?: string;
  /**
   * Slice 8a — host-side runtime ctx bridge. When provided, the init
   * script captures these host methods into closure-locals and builds
   * a Context-realm `ctx` object whose member methods all wrap via
   * `wrapHostMethod` (PRD §8.3.4 host-realm-eval defense). The bridge
   * is then DELETED from `globalThis` so user code can't enumerate it.
   *
   * When omitted, sandbox falls back to the slice-2 stub `ctx` (every
   * method throws "not yet implemented"). Used by every slice-2 test
   * that doesn't care about the runtime.
   */
  readonly runCtxHost?: RunCtxHost;
  /**
   * Timeout (ms) for the synchronous portion of `runScript` — the initial
   * `script.runInContext` call before the first `await`. Catches tight
   * `while(true){}` loops that haven't yielded yet.
   *
   * Default: 5000 ms (5 s).
   *
   * Partial fix for the worker_threads gap (parity-gaps.md). After the
   * first `await`, the sync timeout no longer applies; async infinite
   * loops still wedge the process.
   */
  readonly runScriptTimeoutMs?: number;
}

// ─── slice 8a — runtime ctx host bridge ────────────────────────────

/**
 * Tagged union the host bridge returns from every async ctx.* method.
 * The Context-realm wrapper inspects this and either yields the value
 * or throws a Context-realm Error reconstructed from the carried
 * `RealmErrorRecord`.
 *
 * Why tag instead of throwing host-realm Errors directly: a host
 * `Promise.reject(hostErr)` would deliver `hostErr` (host-realm) to the
 * Context-realm `await`, which then rethrows it. The script would see
 * `e.constructor === <host>.Error` — a realm leak. Tagging keeps every
 * realm-crossing value plain JSON; reconstruction stays inside the
 * Context.
 */
export type RunCtxBridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RealmErrorRecord };

/**
 * Author-handle data carried across the realm boundary by `ctx.agent`.
 * The Context wrapper rebuilds this as a frozen Context-realm object
 * matching the public `AgentHandle` shape (PRD §4.2.1).
 */
export interface AgentHandleData {
  readonly kind: "agent";
  readonly id: string;
  readonly prompt: string;
  readonly opts: Readonly<Record<string, unknown>>;
}

/**
 * Run metadata exposed via `ctx.run` (PRD §4.2.7). Plain JSON; cloned
 * into Context realm at bind time (no host functions inside).
 */
export interface RunMetaData {
  readonly id: string;
  readonly workflowName: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly resumed: boolean;
}

/**
 * Host-side bridge consumed by the sandbox. Every method is host-realm
 * — the init script wraps each one inside the Context. None of these
 * methods leaks Context-realm objects back into the host's mutable
 * state; they accept Context-realm values by reference (Reflect.apply
 * passes them through) and read fields off them as plain data.
 *
 * Sync vs async:
 *   - `agent` is sync: it just constructs a handle (no I/O).
 *   - `phase`, `cacheGet`, `cacheSet`, `cacheHas`, `cacheDelete` are async.
 *   - `log` is sync (fire-and-forget — host queues to ledger writer).
 */
export interface RunCtxHost {
  readonly runMeta: RunMetaData;
  /** Slash-command argument string (PRD §4.2.7 `ctx.input`). */
  readonly input: string;
  /**
   * Token budget cap for this run, or `null` for uncapped.
   * Passed as a plain value (not a bridge function) so the sandbox
   * init script can embed it in the frozen `budget` object without
   * a round-trip.
   */
  readonly tokenBudget: number | null;
  /**
   * Build an AgentHandle. Pure — same args twice yields two distinct
   * handles (ids may differ if author omitted `id`). Per PRD §4.2.1
   * "ctx.agent is pure — calling it twice with identical args twice
   * schedules two distinct agents. Idempotency is the cache's job."
   */
  agent(prompt: unknown, opts: unknown): RunCtxBridgeResult<AgentHandleData>;
  /**
   * Run a phase. Reads each handle's fields (id, prompt, opts) as
   * plain data, dispatches in parallel under the run's semaphore.
   * Resolves with an array of cloned `AgentResult` matching the input
   * order. Rejection: tagged AggregateError record per PRD §4.2.2.
   */
  phase(
    name: unknown,
    agents: unknown,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<readonly (AgentResultLike | null)[]>>;
  cacheGet(key: unknown): Promise<RunCtxBridgeResult<unknown>>;
  cacheSet(key: unknown, value: unknown): Promise<RunCtxBridgeResult<null>>;
  cacheHas(key: unknown): Promise<RunCtxBridgeResult<boolean>>;
  cacheDelete(key: unknown): Promise<RunCtxBridgeResult<null>>;
  log(message: unknown, level: unknown): RunCtxBridgeResult<null>;
  /**
   * Slice 8a placeholder — slice 10 wires this into the actual
   * `pi.sendUserMessage(prompt)` queue. Slice 8a only needs the
   * call to be observable (so the integration test can assert
   * "recorded but not yet fired").
   */
  finishCallback(prompt: unknown): RunCtxBridgeResult<null>;
  /** Returns accumulated token spend across all agent results so far. Sync. */
  getBudgetSpent(): number;
  /**
   * Improvement 5: emit an ephemeral progress event to the overlay.
   * pct must be 0–100. No ledger write.
   */
  progress(pct: unknown, message?: unknown): RunCtxBridgeResult<null>;
  /**
   * Improvement 6: idempotent checkpoint. Returns true if freshly
   * written, false if already set (resumed run hit). Async because
   * it writes to the cache store.
   */
  checkpoint(label: unknown, data?: unknown): Promise<RunCtxBridgeResult<boolean>>;
  /**
   * Improvement 7: append a structured report event to the ledger
   * and emit to the overlay. Sync (ledger write is fire-and-forget).
   */
  report(eventType: unknown, data?: unknown): RunCtxBridgeResult<null | string>;
  /**
   * Human-in-the-loop suspend/confirm primitive (ctx.gate). Suspends
   * execution until the user responds (approved or denied), or the run
   * is aborted. Returns `{ ok: true, value: boolean }` on resolution;
   * `{ ok: false, error }` on abort or error.
   */
  gate(message: unknown, opts?: unknown): Promise<RunCtxBridgeResult<boolean>>;
  /**
   * ZONE_HITL — mid-phase human-in-the-loop suspend/route primitive.
   * Writes an `interrupt_requested` ledger entry with a deterministic
   * sequence-derived `key` and blocks until a matching `resume-interrupt`
   * control command arrives via `ctrl.jsonl` (or until the run is
   * aborted). On resume from disk, prior `interrupt_resolved` entries
   * are replayed first so this call returns immediately with the
   * stored value (replay-perfect HITL).
   *
   * `opts` shape: `{ question: string, choices?: string[], default?: unknown }`.
   * Returns `{ ok: true, value }` where `value` is the JSON-cloneable
   * answer; `{ ok: false, error }` on abort or invalid args.
   */
  interrupt(opts: unknown): Promise<RunCtxBridgeResult<{ key: string; value: unknown }>>;
  /**
   * gap/ctx-memo — check if a cross-run memo entry exists and is fresh.
   * Returns `{ hit: true, value }` on a cache hit, or `{ hit: false }` on miss.
   */
  memo_check(
    key: string,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<{ hit: boolean; value?: unknown }>>;
  /**
   * gap/ctx-memo — persist a value in the cross-run memo store.
   * Called by the sandbox side after `fn()` resolves on a cache miss.
   */
  memo_set(
    key: string,
    value: unknown,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<null>>;
  /**
   * ZONE_MEMORY follow-up #6 — stdlib bridge.
   * Reads MEMORY.md for `(scope, name)` capped at 25 KiB. Returns
   * `null` for missing/empty. See `agentMemory.ts::readMemoryFile`.
   *
   * Optional in this interface so test-side partial mocks of
   * `RunCtxHost` don't have to stub it. The real `createRunCtxHost`
   * always provides this method; the sandbox bridge wires it through
   * unconditionally.
   */
  memory_read?(
    name: unknown,
    scope: unknown,
  ): Promise<RunCtxBridgeResult<string | null>>;
  /**
   * ZONE_MEMORY follow-up #6 — stdlib bridge.
   * Appends `text` to MEMORY.md for `(scope, name)`. Creates the
   * scope dir lazily. See `agentMemory.ts::appendMemoryUpdate`.
   * Optional — see `memory_read`.
   */
  memory_append?(
    name: unknown,
    scope: unknown,
    text: unknown,
  ): Promise<RunCtxBridgeResult<null>>;
  /**
   * ZONE_MEMORY follow-up #1 — compaction primitive.
   * Spawns a one-shot summarizer agent and atomically rewrites
   * MEMORY.md. Returns size deltas; throws `CompactionError`
   * (delivered as `{ok:false}`) on any failure, leaving the
   * original file intact. Optional — see `memory_read`.
   */
  memory_compact?(
    name: unknown,
    scope: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      beforeBytes: number;
      afterBytes: number;
      ratio: number;
    }>
  >;
  /**
   * ZONE_WORKTREE follow-up #2 — promote agent worktree edits to
   * the parent repo. Strategy `'apply'` reads the diff snapshot
   * (`<runDir>/worktrees/<agentId>.diff`) and runs `git apply`
   * against the parent CWD. Strategy `'rebase'` runs
   * `git rebase --onto <target>` inside the worktree. Returns
   * `{ strategy, applied, files }`. Throws `PromoteError`
   * (delivered as `{ok:false}`) on any failure including missing
   * diff, conflicts, or non-existent worktree.
   */
  promote?(
    agentId: unknown,
    opts?: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      strategy: "apply" | "rebase";
      applied: boolean;
      files: readonly string[];
    }>
  >;
}

/**
 * Result returned by `Sandbox#runScript`. `returnValue` is the resolved
 * value of the user script's top-level `return` (after structured
 * cloning back to the host realm), or `undefined` if the script didn't
 * return anything.
 *
 * `log` is only populated when `SandboxOptions.log` was omitted (DI not
 * provided).
 */
export interface SandboxResult {
  readonly returnValue: unknown;
  readonly log: readonly SandboxLogEntry[];
  readonly durationMs: number;
}

