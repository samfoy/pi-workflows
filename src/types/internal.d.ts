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
