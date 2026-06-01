/**
 * pi-workflows — slice 16 hot-reload watcher.
 *
 * Watches both workflow directories (`<cwd>/.pi/workflows/*.js` and
 * `~/.pi/agent/workflows/*.js`) with chokidar. On add/change/unlink,
 * debounces 100ms then re-runs discovery and diffs the slash-command
 * set against the current registry snapshot.
 *
 * Key behaviors (per plan.md §4 Slice 16 + PRD §3.1/§3.2):
 *
 * - `add`: register the new slash command (unless reserved/bad name).
 * - `change`: re-register the command so new invocations pick up the
 *   new script. Clear cached trust for the old sha256. If a run is
 *   currently active for this workflow, defer (log + skip re-register).
 * - `unlink`: unregister the slash command.
 * - `.ts` files: skipped with a warning.
 * - Reserved names: skipped with a warning.
 * - Disable knobs + recursion guard: checked at `createHotReloadWatcher()`
 *   call time (session-locked per PRD §3.6). If disabled, returns a
 *   no-op disposer.
 * - Watcher is closed via the returned disposer on `session_shutdown`.
 *
 * chokidar options:
 * - `awaitWriteFinish: true` — avoids mid-write events on slow filesystems.
 * - `ignoreInitial: true` — initial scan is done by one-shot discovery.
 * - `depth: 0` — non-recursive per PRD §3.2.
 * - `persistent: false` — don't hold the Node event loop open.
 *
 * Tests inject a fake FSWatcher via `opts.watcherFactory` so no real
 * filesystem is required.
 *
 * Refs: plan.md §4 Slice 16, PRD §3.1, §3.2, §3.6.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { WorkflowFile, ExtensionAPI } from "../types/internal.js";
import { classifyFilename, RESERVED_NAMES } from "../registry.js";
import type { ActiveRunsRegistry } from "./activeRuns.js";

// ─── FSWatcher minimal interface (satisfied by chokidar + test stubs) ──

export interface FSWatcherLike {
  on(
    event: "add" | "change" | "unlink" | "error",
    listener: (pathOrErr: string | Error) => void,
  ): this;
  close(): Promise<void> | void;
}

export type WatcherFactory = (
  paths: string[],
  opts: Record<string, unknown>,
) => FSWatcherLike;

// ─── Public API ─────────────────────────────────────────────────────────

export interface HotReloadOpts {
  /** Project workflow dir (e.g. `<cwd>/.pi/workflows`). */
  readonly projectDir: string;
  /** Personal workflow dir (e.g. `~/.pi/agent/workflows`). */
  readonly personalDir: string;

  /** Snapshot of the registry at session_start. Mutated in-place by reload.
   * Must be a mutable Map (not ReadonlyMap) so hot-reload can add/delete entries.
   */
  readonly registry: Map<string, WorkflowFile>;

  /** The pi ExtensionAPI (for registerCommand/unregisterCommand). */
  readonly pi: ExtensionAPI;

  /** Live active-runs registry — used for lock-during-active-run check. */
  readonly activeRuns: ActiveRunsRegistry;

  /**
   * Whether pi-workflows is running in a nested/recursive sub-agent.
   * When true, re-registration is suppressed (same as initial load).
   */
  readonly recursive: boolean;

  /** Debounce window in ms. Default: 100. */
  readonly debounceMs?: number;

  /**
   * Inject a custom FSWatcher factory (for tests). When absent the
   * module dynamically imports chokidar at runtime.
   */
  readonly watcherFactory?: WatcherFactory;

  /** Log sink for info/warn notices. Default: silent. */
  readonly log?: (
    level: "info" | "warn" | "error",
    msg: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;

  /**
   * Real per-workflow command registration callback. When provided,
   * `handleAdd` and `handleChange` invoke this with the constructed
   * `WorkflowFile` instead of registering a description-only stub
   * handler against `pi`.
   *
   * Production callers MUST supply this — without it, freshly added
   * workflows would only get a no-op stub registered (the original
   * BUG that this opt closes). Tests that don't care about the
   * handler shape can omit it; we fall back to the legacy stub.
   */
  readonly registerCommand?: (file: WorkflowFile) => void;
}

/** Returns a disposer that closes the watcher. */
export interface HotReloadHandle {
  /** Stop the watcher and cancel any pending debounce. */
  dispose(): Promise<void>;
}

/**
 * Start the hot-reload watcher. Returns a `HotReloadHandle` whose
 * `dispose()` must be called on `session_shutdown` to avoid resource leaks.
 *
 * Returns a no-op handle if `opts.recursive` is true (we still watch
 * in recursive sessions so the host can pick up changes, but we don't
 * re-register commands). Actually: per PRD §3.6 the disable check is
 * done by the caller before invoking this; recursive is passed here so
 * the re-register step is skipped without suppressing the watcher
 * entirely (the watcher still invalidates trust for any process that
 * later runs the file).
 */
export async function createHotReloadWatcher(
  opts: HotReloadOpts,
): Promise<HotReloadHandle> {
  const { projectDir, personalDir, registry, pi, activeRuns, recursive } = opts;
  const debounceMs = opts.debounceMs ?? 100;
  const log = opts.log ?? (() => {});
  const registerCommand = opts.registerCommand;

  // Ensure both dirs exist so chokidar doesn't throw on missing paths.
  for (const dir of [projectDir, personalDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort — may fail in read-only CI; watcher will still
      // receive no events for a missing path
    }
  }

  let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  // We track our own snapshot of (absPath → sha256) per-file so we
  // can invalidate trust on change without re-reading the full trust
  // store. The sha256 from `WorkflowFile` is computed at discovery
  // Seed sha256Cache from the initial registry (sha256 not in WorkflowFile;
  // this cache is populated when we detect file changes at runtime).
  const sha256Cache = new Map<string, string>(); // absPath → last known sha256 (populated on change)

  // ─── FSWatcher factory ───────────────────────────────────────────

  let watcher: FSWatcherLike;

  if (opts.watcherFactory) {
    watcher = opts.watcherFactory([projectDir, personalDir], {
      ignoreInitial: true,
      depth: 0,
      persistent: false,
      awaitWriteFinish: true,
    });
  } else {
    const chokidar = (await import("chokidar")).default;
    watcher = chokidar.watch([projectDir, personalDir], {
      ignoreInitial: true,
      depth: 0,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
  }

  // ─── Event handlers ─────────────────────────────────────────────

  function schedule(absPath: string, event: "add" | "change" | "unlink"): void {
    if (closed) return;
    const existing = debounceTimers.get(absPath);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(absPath);
      if (closed) return;
      try {
        handleEvent(absPath, event);
      } catch (err) {
        log("error", `hot-reload: unhandled error in ${event} handler`, {
          absPath,
          error: String(err),
        });
      }
    }, debounceMs);
    debounceTimers.set(absPath, timer);
  }

  function handleEvent(absPath: string, event: "add" | "change" | "unlink"): void {
    const filename = basename(absPath);

    if (event === "unlink") {
      handleUnlink(absPath, filename);
      return;
    }

    // Classify the filename the same way one-shot discovery does.
    const classified = classifyFilename(filename, RESERVED_NAMES);
    if ("reason" in classified) {
      // Hidden files silently ignored; others get a warning.
      if (!filename.startsWith(".")) {
        log("warn", `hot-reload: skipping ${filename}: ${classified.message}`, {
          absPath,
          reason: classified.reason,
        });
      }
      return;
    }

    const { name } = classified;

    if (event === "add") {
      handleAdd(absPath, name);
    } else {
      handleChange(absPath, name);
    }
  }

  function handleAdd(absPath: string, name: string): void {
    if (registry.has(name)) {
      // A file with the same name already exists in the registry
      // (possibly the other scope). Re-classify and update.
      handleChange(absPath, name);
      return;
    }

    if (!recursive) {
      const wf: WorkflowFile = {
        name,
        absPath,
        scope: detectScope(absPath, personalDir),
      };
      if (registerCommand) {
        // Real registration via injected callback (production path):
        // wires the same handler `registerWorkflowCommands` builds for
        // discovery-time files. Closes the BUG where newly added
        // workflows had a no-op stub instead of a working handler.
        registerCommand(wf);
      } else {
        // Legacy fallback for tests that don't provide a callback.
        // Logs a stub trace if invoked so it's diagnosable.
        pi.registerCommand(name, {
          description: `Workflow: ${name}`,
          handler: async (_args, ctx) => {
            void ctx;
            log("info", `hot-reload: invoked stub handler for ${name}`);
          },
        });
      }
    }

    registry.set(name, {
      name,
      absPath,
      scope: detectScope(absPath, personalDir),
    });

    log("info", `hot-reload: registered new command /${name}`, { absPath });
  }

  function handleChange(absPath: string, name: string): void {
    // Lock check: if a run for this workflow is active, defer.
    let runInProgress = false;
    for (const summary of activeRuns.listSummaries()) {
      if (
        summary.workflowName === name &&
        !isTerminalSummaryState(summary.state)
      ) {
        runInProgress = true;
        break;
      }
    }

    if (runInProgress) {
      log(
        "info",
        `hot-reload: deferred for \`${name}\` — run in progress, will retry on completion`,
        { absPath },
      );
      // Subscribe to the registry and re-invoke handleChange once the
      // active run for this workflow reaches a terminal state.
      const unsub = activeRuns.subscribe(() => {
        const stillRunning = activeRuns
          .listSummaries()
          .some(
            (s) => s.workflowName === name && !isTerminalSummaryState(s.state),
          );
        if (!stillRunning) {
          unsub();
          handleChange(absPath, name);
        }
      });
      return;
    }

    // Invalidate trust: compute the new sha256 and compare against
    // the cached value (if any). On first change the cache is empty,
    // so any new sha256 is treated as a change — trust is always
    // invalidated when a file is modified.
    const oldSha256 = sha256Cache.get(absPath);
    const newSha256 = computeFileSha256(absPath);
    if (newSha256 !== undefined) {
      if (newSha256 !== oldSha256) {
        sha256Cache.set(absPath, newSha256);
        log("info", `hot-reload: trust invalidated for ${name} (sha256 changed)`, {
          absPath,
          oldSha256,
        });
      }
    } else {
      // File unreadable after change — clear stale cache entry.
      sha256Cache.delete(absPath);
    }

    // Update registry entry (clears sha256 — will be re-derived on
    // next invocation's hash check).
    registry.set(name, {
      name,
      absPath,
      scope: detectScope(absPath, personalDir),
    });

    if (!recursive) {
      const wf: WorkflowFile = {
        name,
        absPath,
        scope: detectScope(absPath, personalDir),
      };
      if (registerCommand) {
        // Real re-registration via injected callback (production
        // path). pi.registerCommand semantics: re-register overwrites
        // the existing entry, so subsequent `/${name}` invocations
        // pick up the new file content (read at invocation time).
        registerCommand(wf);
      } else {
        pi.registerCommand(name, {
          description: `Workflow: ${name}`,
          handler: async (_args, ctx) => {
            void ctx;
            log("info", `hot-reload: invoked stub handler for ${name}`);
          },
        });
      }
    }

    log("info", `hot-reload: re-registered /${name}`, { absPath });
  }

  function handleUnlink(absPath: string, filename: string): void {
    // Find which name in the registry maps to this absPath.
    let unregisteredName: string | undefined;
    for (const [name, wf] of registry) {
      if (wf.absPath === absPath) {
        unregisteredName = name;
        break;
      }
    }

    if (unregisteredName === undefined) {
      // Not in our registry — may be a file we skipped at scan time.
      return;
    }

    registry.delete(unregisteredName);
    sha256Cache.delete(absPath);

    if (!recursive && (pi as ExtensionAPI & { unregisterCommand?: (n: string) => void }).unregisterCommand) {
      (pi as ExtensionAPI & { unregisterCommand?: (n: string) => void }).unregisterCommand!(unregisteredName);
    }

    log("info", `hot-reload: unregistered /${unregisteredName} (file deleted)`, {
      absPath,
      filename,
    });
  }

  // ─── Wire chokidar events ────────────────────────────────────────

  watcher.on("add", (p) => schedule(p as string, "add"));
  watcher.on("change", (p) => schedule(p as string, "change"));
  watcher.on("unlink", (p) => schedule(p as string, "unlink"));
  watcher.on("error", (err) => {
    log("error", `hot-reload: watcher error: ${String(err)}`, {});
  });

  // ─── Disposer ───────────────────────────────────────────────────

  return {
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      // Cancel all pending debounce timers.
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      await watcher.close();
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Read a file and return its SHA-256 hex digest, or `undefined` if
 * the file cannot be read (e.g. deleted between the event and the
 * debounce firing).
 */
function computeFileSha256(absPath: string): string | undefined {
  try {
    const data = readFileSync(absPath);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
}

function detectScope(
  absPath: string,
  personalDir: string,
): "project" | "personal" {
  return absPath.startsWith(personalDir) ? "personal" : "project";
}

const TERMINAL_SUMMARY_STATES = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

function isTerminalSummaryState(state: string): boolean {
  return TERMINAL_SUMMARY_STATES.has(state);
}
