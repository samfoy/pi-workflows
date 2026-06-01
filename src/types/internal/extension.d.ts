/**
 * src/types/internal/extension.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the extension slice is needed.
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

/** One declared phase in the workflow meta. */
export interface WorkflowMetaPhase {
  readonly title: string;
  readonly detail?: string;
  readonly model?: string;
}

/**
 * Parsed metadata from `export const meta = { ... }` at the top of a
 * workflow script. The runtime reads these at trust-check time and
 * surfaces them in the runs list and TUI overlay.
 */
export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  /** Optional hint for the model about when to invoke this workflow. */
  readonly whenToUse?: string;
  /** Expected phases — shown upfront in TUI before they start. */
  readonly phases?: ReadonlyArray<WorkflowMetaPhase>;
  /**
   * When true, subagents spawned by this workflow run with file-edit
   * permissions automatically approved (CC's `acceptEdits` parity).
   * Sets `PI_BYPASS_PERMISSIONS=1` in the child process env.
   * Default: false.
   */
  readonly acceptEdits?: boolean;
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
  /**
   * When true, crash-sweep automatically resumes orphaned runs instead
   * of leaving them in `failed: parent-crash`. Default: false.
   * Controlled by the `pi-workflows.autoResumeCrashedWorkflows` setting.
   */
  readonly autoResumeCrashedWorkflows: boolean;
  /**
   * OTLP/HTTP endpoint for the OpenTelemetry trace exporter
   * (ZONE_OTEL). Resolved from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
   * (preferred) or the catch-all `OTEL_EXPORTER_OTLP_ENDPOINT`. When
   * `null`, the exporter is a strict no-op — no SDK is loaded.
   */
  readonly otelTracesEndpoint: string | null;
  /**
   * OTLP/HTTP endpoint for the OpenTelemetry metrics exporter
   * (ZONE_OTEL). Resolved from `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
   * (preferred) or the catch-all `OTEL_EXPORTER_OTLP_ENDPOINT`. When
   * `null`, the metrics exporter is a strict no-op.
   */
  readonly otelMetricsEndpoint: string | null;
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
  on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  /** Catch-all for events not individually typed (input, before_agent_start, etc.). */
  on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
  sendMessage<T = unknown>(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: T;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  /**
   * Slice 10: queue a follow-up user message into the LLM's next
   * turn. Used by `ctx.finishCallback(prompt)` to bridge "workflow
   * finished" → "LLM continues the conversation" per PRD §3.9.
   * Optional in the type because pi versions <0.74.0 may not expose
   * it; result delivery falls back to a plain `sendMessage` card if
   * undefined.
   *
   * The optional `deliverAs` option (pi v0.75+) controls how the
   * message is queued when the conductor is mid-stream:
   *   - `"steer"` — deliver after the current assistant turn finishes
   *     its tool calls, before the next LLM call.
   *   - `"followUp"` — deliver only when the agent has no more tool
   *     calls. **Required when calling from a workflow-completion
   *     hook** so the call doesn't throw when the conductor is busy.
   * When omitted and the agent is streaming, pi throws — which is why
   * `resultDelivery.ts` always passes `"followUp"`.
   */
  sendUserMessage?(
    prompt: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  appendEntry?<T = unknown>(customType: string, data?: T): void;
  /** Register an LLM-invokable tool (pi v0.74+). */
  registerTool?(tool: {
    name: string;
    label?: string;
    description: string;
    promptGuidelines?: string[];
    promptSnippet?: string;
    parameters: Record<string, unknown>;
    execute(id: string, params: unknown, ctx: ExtensionContextLike): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  /** Register a keyboard shortcut (e.g. "alt+w"). */
  registerShortcut?(shortcut: string, options: {
    description?: string;
    handler(ctx: ExtensionContextLike): void | Promise<void>;
  }): void;
}

/** Subset of `ExtensionContext` needed by slice-1 code. */
export interface ExtensionContextLike {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    /**
     * Slice 13 — `ctx.ui.custom` mounts a TUI overlay component. Optional
     * because older pi builds don't expose it; the slice-13 overlay
     * gracefully falls back to a sendMessage card when undefined (PRD
     * §10.9 non-TTY behavior). The signature mirrors the upstream
     * `@earendil-works/pi-coding-agent` ExtensionUIContext.custom
     * narrowed to the bits this package consumes.
     */
    custom?<T = void>(
      factory: (
        tui: TuiInstanceLike,
        theme: TuiThemeLike,
        kb: TuiKeybindingsLike,
        done: (result: T) => void,
      ) => TuiComponentLike | Promise<TuiComponentLike>,
      options?: { overlay?: boolean },
    ): Promise<T>;
    /** Slice 13 — pi-coding-agent's `ctx.ui.confirm` (used by approval). */
    confirm?(message: string): Promise<boolean>;
    /**
     * ZONE_TUI_HITL_FORK — pi-coding-agent's `ctx.ui.input`. Used by
     * the resume-confirm gate, the interrupt-answer prompt, and the
     * fork-from-checkpoint dialog. Optional because non-TTY pi modes
     * may not expose it; callers degrade gracefully when undefined.
     * Real signature on `pi-coding-agent` is `(title: string,
     * placeholder?: string)` — we widen to `unknown` rest args so
     * callers can pass either shape pi exposes at runtime.
     */
    input?(
      titleOrMessage: string,
      placeholder?: string,
    ): Promise<string | undefined>;
    /**
     * ZONE_TUI_HITL_FORK — pi-coding-agent's `ctx.ui.select`. Used by
     * the interrupt-answer dispatch (when `choices` is set) and the
     * fork-dialog phase picker.
     */
    select?(
      title: string,
      options: ReadonlyArray<string>,
    ): Promise<string | undefined>;
    /**
     * Set a named status indicator in the TUI footer.
     * Pass `undefined` as the second arg to clear.
     * Safe to call from outside event handlers (fire-and-forget).
     */
    setStatus?(key: string, text: string | undefined): void;
  };
}

/** Subset of `ExtensionAPI` needed to register shortcuts. */
export interface ExtensionShortcutAPI {
  /** Register a keyboard shortcut (e.g. "alt+w"). */
  registerShortcut?(shortcut: string, options: {
    description?: string;
    handler(ctx: ExtensionContextLike): void | Promise<void>;
  }): void;
}

/** Subset of `ExtensionCommandContext` needed by the slice-1 stub handler. */
export interface ExtensionCommandContextLike extends ExtensionContextLike {}

// ───────────────────────────────────────────────────────────────────────
//  Slice 13 — pi-tui surface narrowed to the bits the overlay consumes.
// ───────────────────────────────────────────────────────────────────────

/** Mirror of `pi-tui`'s `Component`. Render returns lines; handleInput
 * receives raw key data; invalidate clears caches. */
export interface TuiComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  /** Optional cleanup hook called by pi-tui on overlay tear-down. */
  dispose?(): void;
}

/** Narrow surface — only the methods slice 13 calls. */
export interface TuiInstanceLike {
  /** Request a redraw on the next animation frame. Optional because
   * test fakes don't always need to schedule. */
  requestRender?(): void;
}

/** Theme handle — opaque to slice 13; ANSI/colors are theme-agnostic. */
export type TuiThemeLike = Readonly<Record<string, unknown>>;

/** Keybindings manager handle — opaque to slice 13 (we don't register
 * global keybindings; the overlay component owns its own input loop). */
export type TuiKeybindingsLike = Readonly<Record<string, unknown>>;

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

  // ─── slice 14 (restart lineage) ───────────────────────────────
  /**
   * If this run was started via the `r` (restart) hotkey on a
   * terminal-state run, this is the prior runId. Set by
   * `restartFromRunDir`; not set on fresh-start runs.
   */
  readonly restartedFrom?: string;

  // ─── ZONE_MEMORY ──────────────────────────────────────
  /**
   * Resolved agent-memory directory per persona name, populated
   * lazily on first dispatch that uses `opts.memory`. Survives
   * resume so a re-mounted agent reads the same MEMORY.md it was
   * reading before the parent crashed. Empty / absent when no
   * agent in the run opted into memory.
   */
  readonly agentMemoryDirs?: Readonly<Record<string, string>>;

  // ─── ZONE_WORKTREE ─────────────────────────────
  /**
   * Resolved per-agent git-worktree path, populated lazily on first
   * dispatch that uses `opts.isolation === 'worktree'`. Keys are
   * agent ids (validated via `assertSafeAgentId`); values are
   * absolute paths under `<runDir>/worktrees/<agentId>/`. Survives
   * resume so a re-mounted agent re-attaches the same checkout
   * after a parent crash. Empty / absent when no agent opted in.
   */
  readonly agentWorktrees?: Readonly<Record<string, string>>;

  // ─── ZONE_TIMETRAVEL ───────────────────────────
  /**
   * If this run was created by `forkFromCheckpoint(parentRunId, ...)`,
   * this is the parent's runId. Lets audit + GC walk the lineage
   * across forks. Set by `forkFromCheckpoint`; absent on fresh-start
   * runs and on `restartedFrom` runs (those use `restartedFrom`).
   */
  readonly parentRunId?: string;
  /**
   * If this run was created by `forkFromCheckpoint`, this is the
   * `phaseName` the fork branched at — the new run replays the
   * parent's ledger / cache up to (but not including) this phase's
   * `phase_start`. Set together with `parentRunId`.
   */
  readonly forkAtPhase?: string;
  /**
   * ZONE_TIMETRAVEL polish — set on a child fork when its parent
   * (referenced by `parentRunId`) was deleted via `runGc({ force: true })`.
   * The ISO timestamp tombstone tells observability tools the lineage
   * chain is broken: the parent's ledger / cache are gone, and
   * `forkFromCheckpoint(parentRunId, ...)` against this fork would no
   * longer find a usable parent on disk.
   */
  readonly parentDeletedAt?: string;
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
  /** Token budget cap for this run, or `null` for uncapped. */
  readonly tokenBudget: number | null;
  /**
   * Run-wide default agent timeout in ms. Used when an individual
   * `ctx.agent()` call does not supply `opts.timeoutMs`. Falls back
   * to the dispatcher's hard-coded 600_000 ms when absent.
   */
  readonly defaultAgentTimeoutMs?: number;
}

