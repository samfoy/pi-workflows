/**
 * pi-workflows — internal type definitions (slice 1+).
 *
 * Per `plan.md` §5.1 these are runtime-internal types. They are extended
 * additively by each slice that adds runtime; no slice ever moves a type
 * out of this file. Author-facing types live in `public.d.ts` and are
 * frozen from slice 8a onward.
 *
 * Field-ownership comments tag every later-slice field with the slice
 * number that populates it, so cross-slice contracts stay legible.
 */

// ───────────────────────────────────────────────────────────────────────
// Slice 1 — extension load, registry, slash-command stub
// ───────────────────────────────────────────────────────────────────────

/**
 * One discovered workflow file. Built by `registry.ts` from a single
 * file under `<projectRoot>/.pi/workflows/` or `~/.pi/agent/workflows/`.
 *
 * Slice 1 fields only — `sourceSha256` lands in slice 9 when trust I/O
 * needs it, `sourceText` in slice 6 when the dispatcher needs to freeze
 * a script copy at run-start.
 */
export interface WorkflowFile {
  /** Unqualified name (e.g. "codebase-audit"). Becomes `/<name>`. */
  readonly name: string;
  /** Resolved absolute path on disk. */
  readonly absPath: string;
  /** "project" wins over "personal" on collisions, per PRD §3.1. */
  readonly scope: "project" | "personal";
}

/** Result map keyed by workflow name. Project precedence already applied. */
export type WorkflowRegistry = ReadonlyMap<string, WorkflowFile>;

/**
 * Settings + env reader output. Slice 1 ships only the extension-load
 * disable knobs; later slices extend (e.g. `maxConcurrent`,
 * `gcAfterDays`, `trustedWorkflows`).
 */
export interface Config {
  /** True if the extension should not register anything at all. */
  readonly disabled: boolean;
  /** True if `PI_WORKFLOWS_RECURSIVE=1` was set (sub-agent child). */
  readonly recursive: boolean;
  /** Source of the disable decision (debug-friendly). */
  readonly disabledBy: "env" | "setting" | null;
}

/**
 * Result of a workflow file's discovery+filter pass that did not produce
 * a `WorkflowFile`. Used by registry to surface skipped files via
 * `pi.notify` and (slice 7+) ledger's `workflow_load_error` entry.
 *
 * Slice 1 only consumes this for `pi.ui.notify` warnings; the ledger
 * entry shape is forward-declared but not yet emitted.
 */
export interface WorkflowLoadError {
  readonly absPath: string;
  readonly reason:
    | "reserved-name"
    | "non-js-extension"
    | "bad-filename"
    | "name-collision-shadowed"
    | "io-error";
  readonly message: string;
}

/**
 * Re-export of the bits of `pi-coding-agent`'s `ExtensionAPI` we depend
 * on, narrowed for documentation. The real type comes from the upstream
 * package; this alias lets internal modules avoid a deep import path
 * and lets `tests/helpers/makeFakePi.ts` model the same shape.
 *
 * Intentionally a structural type, not an `import type` re-export — the
 * test harness can implement the surface without pulling in upstream
 * runtime symbols.
 */
export interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (
        args: string,
        ctx: ExtensionCommandContextLike,
      ) => Promise<void> | void;
    },
  ): void;
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  sendMessage<T = unknown>(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: T;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  appendEntry?<T = unknown>(customType: string, data?: T): void;
}

/** Subset of `ExtensionContext` needed by slice-1 code. */
export interface ExtensionContextLike {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** Subset of `ExtensionCommandContext` needed by the slice-1 stub handler. */
export interface ExtensionCommandContextLike extends ExtensionContextLike {}

// ───────────────────────────────────────────────────────────────────────
// RunManifest — published by slice 1 as a stub. Slice 6 fills the
// parent-process fields; slice 8a fills the rest. PRD §6.2 is the
// authoritative schema; field ownership matches `plan.md` §1.3.
// ───────────────────────────────────────────────────────────────────────

/**
 * Frozen, immutable per-run manifest. Written once at run-start and
 * never updated. Reconstructed at resume time by reading
 * `<runDir>/manifest.json` plus the ledger's `init` entry.
 *
 * **Population schedule** (declared here so cross-slice readers can rely
 * on the shape from slice 1; values default to `null`/`undefined` until
 * the owning slice fills them):
 *
 *   - slice 6 (dispatcher): `parentPid`, `parentStartTime`, `parentBootId`
 *   - slice 8a (RunManager): every other field
 *
 * Slice 1's only responsibility is to declare every field with a usable
 * type so later slices can `Partial<RunManifest>` without TypeScript
 * errors.
 */
export interface RunManifest {
  // ─── slice 8a ────────────────────────────────────────────────
  /** `wf-<12 hex>` — random, immutable. */
  readonly runId: string;
  /** Workflow name as it appears at the slash command (no leading `/`). */
  readonly workflowName: string;
  /** Absolute path of the workflow file at run-start. */
  readonly workflowAbsPath: string;
  /** SHA-256 of the workflow file's bytes at run-start. */
  readonly workflowSourceSha256: string;
  /** Argument string the user passed after `/<name> `. */
  readonly input: string;
  /** ISO-8601 UTC timestamp of run-start. */
  readonly startedAt: string;
  /** Working directory at run-start (may differ from session cwd). */
  readonly cwd: string;
  /** pi-coding-agent's reported version at run-start. */
  readonly piVersion: string;
  /** This package's version at run-start. */
  readonly piWorkflowsVersion: string;
  /** Frozen snapshot of run-time options. */
  readonly options: RunOptions;
  /** Whether the workflow was already trusted at run-start. */
  readonly trustedAtStart: boolean;

  // ─── slice 6 (parent-death guard) ─────────────────────────────
  /** PID of the pi process that started the run. */
  readonly parentPid: number;
  /**
   * `process.hrtime.bigint`-derived monotonic start marker (decimal
   * stringified to survive JSON round-trip). Used together with
   * `parentBootId` to detect PID reuse across reboots.
   */
  readonly parentStartTime: string;
  /** Per-boot identifier; empty string if unavailable on the host. */
  readonly parentBootId: string;
}

/**
 * Options snapshot captured into the manifest at run-start. Slice 1
 * defines the minimum surface the manifest needs to spell out; later
 * slices (6, 8a, 9, 10) extend with concrete defaults.
 */
export interface RunOptions {
  /** `--mock-agents` runtime mode (slice 6). */
  readonly mockAgents: boolean;
  /** PRD §1.2 pin #6: default 16, overridable via setting. */
  readonly maxConcurrent: number;
  /** PRD §1.2 pin #6: default 1000, hard-fail if exceeded. */
  readonly perRunAgentCap: number;
}

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
    | "init-script-failed"
    | "shape-detect-failed"
    | "compile-failed";
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
 * Slice 8a will add `ctx` (the workflow author API) and `runtimeMeta`.
 * Both extend additively; this slice's tests pass `signal` + (optionally)
 * `log` only.
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

// ─────────────────────────────────────────────────────────────────────
// Slice 3 — Cache (cache.jsonl) types
//
// PRD §6.3 defines three on-disk record shapes; the consumer split
// is two namespaces: agent-result (sha256 keys, written by slice 5
// dispatcher) and author-cache (string keys, written by slice 8a's
// `ctx.cache.set/delete`).
//
// Field-ownership:
//   - `at` is an ISO-8601 host timestamp at write-time. The on-disk
//     timestamp is *not* part of any cache key (PRD §4.5 inputs
//     don't include `at`); cache keys remain deterministic.
// ─────────────────────────────────────────────────────────────────────

/**
 * Slice-3 forward declaration of the slice-5 `AgentResult` shape. We
 * don't import slice 5's full type — that would invert the dependency.
 * Slice 5 narrows this with a structurally-compatible richer type;
 * slice 8a's `ctx.cache` is allowed to store *any* JSON-cloneable
 * value under the `author_cache` namespace, so values are typed
 * `unknown` on the way out of the cache.
 *
 * The fields here are the minimum slice 3's tests need to round-trip;
 * extra fields on the on-disk record survive replay untouched.
 */
export interface AgentResultLike {
  readonly agentId: string;
  readonly text: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly transcriptPath?: string;
  // Permit forward-compat fields without breaking slice-3 readers.
  readonly [extra: string]: unknown;
}

export interface AgentResultRecord {
  readonly type: "agent_result";
  /** sha256 hex from `cacheKey(...)`. */
  readonly key: string;
  readonly value: AgentResultLike;
  readonly at: string;
}

export interface AuthorCacheRecord {
  readonly type: "author_cache";
  /** Author-supplied string key. Not hashed. */
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

export interface AuthorCacheDeleteRecord {
  readonly type: "author_cache_delete";
  readonly key: string;
  readonly at: string;
}

/** Discriminated union of every record type written to `cache.jsonl`. */
export type CacheRecord =
  | AgentResultRecord
  | AuthorCacheRecord
  | AuthorCacheDeleteRecord;

/**
 * Sink the `CacheStore` calls when it skips a corrupt JSONL line during
 * replay (plan §4 Slice 3 acceptance: `corrupt JSONL line emits
 * ctx.log.warn and skips`). Slice 8a wires this to `ctx.log.warn`;
 * tests pass an in-memory collector.
 *
 * `level` is fixed to `"warn"` in slice 3 — corruption is the only
 * thing the cache reports. The wider sink shape is kept for forward
 * compatibility with slice 7's ledger-backed log.
 */
export type CacheLogSink = (
  level: "warn",
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

// ───────────────────────────────────────────────────────────────────────
// Slice 4 — FIFO async semaphore
// ───────────────────────────────────────────────────────────────────────

/**
 * Token returned by `Semaphore.acquire()`. The caller must invoke
 * `release()` exactly once (extra calls are silent no-ops). The slot
 * is held until release; the original `acquire`'s AbortSignal is no
 * longer observed once a token is granted.
 */
export interface AcquireToken {
  release(): void;
}

/**
 * Async FIFO semaphore. Slice 4 publishes the concrete impl; slices 6
 * (dispatcher) and 8a (`ctx.phase`) are the consumers. Slice 7 reads
 * `inFlight` / `queueDepth` for ledger accounting; slice 13 reads them
 * for the overlay.
 *
 * `setCap(n)` is supported. Shrinking does NOT preempt holders —
 * inFlight may legitimately exceed `cap` until natural release. v2:
 * dynamic per-phase caps would land here.
 */
export interface Semaphore {
  /** Currently-held slot count. Never negative. */
  readonly inFlight: number;
  /** Currently-queued (un-resumed) waiter count. */
  readonly queueDepth: number;
  /** Current capacity. */
  readonly cap: number;

  /**
   * Acquire a slot. If `signal.aborted` on entry, rejects with the
   * signal's `reason`. If signal aborts while queued, the waiter is
   * removed from the queue and the promise rejects. If the signal
   * aborts AFTER a token is granted, the rejection is *not* delivered
   * — the caller still owns the slot and is responsible for release.
   */
  acquire(signal?: AbortSignal): Promise<AcquireToken>;

  /**
   * Reset the cap. Raising drains queued waiters in FIFO order.
   * Lowering does not preempt active holders; new acquires queue
   * until inFlight drops under the new cap. Throws `RangeError` for
   * non-integers or negatives.
   */
  setCap(next: number): void;
}

