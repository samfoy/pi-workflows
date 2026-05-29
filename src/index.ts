/**
 * pi-workflows — extension entry point.
 *
 * Wires up:
 *
 *   - Disable knobs (env first, then setting) per PRD §3.6. Slice 10
 *     audit confirms env wins unconditionally; project setting then
 *     user setting; recursion guard never disables, only suppresses.
 *   - Recursion ban (`PI_WORKFLOWS_RECURSIVE=1`) per PRD §13.7. The
 *     extension still loads in nested sessions; we just skip
 *     `registerCommand` for per-workflow `/<name>` commands and route
 *     `/workflows` to the documented error message.
 *   - One-shot workflow discovery on `session_start`. Hot-reload
 *     lands in slice 16.
 *   - `session_shutdown` lifecycle hook: a slim cleanup pass that
 *     surfaces a final notify line. Slice 11 will replace this with
 *     the real "abort active runs" + crash-sweep entry point.
 *   - Per-workflow stub slash commands; `/workflows` umbrella;
 *     conductor-coexistence warning.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { discoverWorkflows } from "./registry.js";
import {
  installBundledWorkflows,
  resolveBundledWorkflows,
} from "./runtime/bundledWorkflows.js";
import {
  registerWorkflowCommands,
  registerWorkflowsCommand,
} from "./commands/workflowCmd.js";
import { sweepCrashedRuns } from "./runtime/crashSweep.js";
import { bindRegistryToFeed } from "./runtime/overlay.js";
import { createHotReloadWatcher } from "./runtime/hotReload.js";
import { getActiveRuns } from "./runtime/activeRuns.js";
import { projectWorkflowsDir, workflowsHome } from "./util/paths.js";
import type {
  ExtensionAPI,
  ExtensionContextLike,
} from "./types/internal.js";

/**
 * Default export — the extension factory function pi-coding-agent
 * passes its `ExtensionAPI` to.
 *
 * The factory is intentionally synchronous: every dependency (settings,
 * env vars, filesystem walk) is fast enough to complete before
 * `session_start`. If we ever need async init (e.g. fetching a remote
 * workflow registry), this must become `async function`.
 */
export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  // Read config once at extension load. Hot-reload (slice 16) re-runs
  // discovery but doesn't re-read disable knobs — disabling mid-session
  // requires `/reload` per PRD §3.6.
  const initialCfg = loadConfig();

  if (initialCfg.disabled) {
    // PRD §3.6: log once and exit. We can't `ctx.ui.notify` yet (no
    // ctx until session_start), so we use a single `console.error`
    // line. pi captures stderr in its session log.
    console.error(
      `[pi-workflows] disabled by ${initialCfg.disabledBy} — skipping registration`,
    );
    return;
  }

  // Slice 13/F3+S8: bind the active-runs registry to pi.appendEntry
  // so cross-process awareness lands without ledger.jsonl file
  // watching. Wraps `pi.appendEntry` so emissions also drive the
  // registry. Best-effort; older pi builds without `appendEntry` are
  // tolerated (the wrap returns a no-op disposer).
  bindRegistryToFeed(pi);

  // PRD §13.7: in a recursive (sub-agent child) load, we still register
  // `/workflows` so its handler can return the documented error
  // message; we just don't expose `/<workflowName>`.
  const recursive = initialCfg.recursive;

  // Slice 16: hot-reload watcher handle — created in session_start,
  // closed in session_shutdown. Using `let` + outer scope so the
  // shutdown handler can reference it.
  let hotReloadHandle: { dispose(): Promise<void> } | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = (ctx as ExtensionContextLike).cwd ?? process.cwd();

    // Slice 11: crash-sweep BEFORE workflow discovery so any
    // sweep-flipped runs are visible to a same-tick `/workflows list`.
    // The sweep is best-effort — errors are surfaced via notify but
    // never block extension load.
    try {
      const sweep = await sweepCrashedRuns({
        log: (level, message, details) => {
          // Best-effort surface of warn/error lines.
          if (level === "warn" || level === "error") {
            ctx.ui.notify(
              `[pi-workflows] ${message}`,
              level === "warn" ? "warning" : "error",
            );
          }
          void details;
        },
      });
      if (sweep.transitioned.length > 0) {
        ctx.ui.notify(
          `[pi-workflows] crash-sweep: ${sweep.transitioned.length} orphan run(s) transitioned to failed: parent-crash`,
          "warning",
        );
        // Also append an active-runs index entry per transitioned run
        // so the slice-13 overlay can surface them as "recent".
        if (typeof pi.appendEntry === "function") {
          for (const t of sweep.transitioned) {
            try {
              pi.appendEntry("pi-workflows.run.transitioned", {
                runId: t.runId,
                fromState: t.fromState,
                toState: "failed",
                reason: "parent-crash",
              });
            } catch {
              /* swallow */
            }
          }
        }
      }
      for (const e of sweep.errors) {
        ctx.ui.notify(
          `[pi-workflows] crash-sweep error in ${e.runId}: ${e.message}`,
          "warning",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[pi-workflows] crash-sweep failed: ${msg}`, "error");
    }

    // Slice 17: self-install bundled workflows into ~/.pi/agent/workflows/
    // before discovery so `/codebase-audit` is available on first run.
    // SPIKE-FINDINGS.md Q2: pi-core does not read pi.workflows manifest field;
    // we own the copy step. Never overwrites user-modified files.
    try {
      const bundled = resolveBundledWorkflows(import.meta.url);
      if (bundled.length > 0) {
        installBundledWorkflows(bundled, workflowsHome(), {
          log: (msg) => {
            // Surface installs/upgrades as info; skip alreadyCurrent noise.
            if (msg.includes("installed") || msg.includes("upgraded") || msg.includes("user-modified")) {
              ctx.ui.notify(msg, "info");
            }
          },
        });
      }
    } catch (err) {
      // Non-fatal — user still gets the extension, just without the bundled workflow.
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[pi-workflows] bundled workflow install failed: ${msg}`, "warning");
    }

    const { registry, errors } = discoverWorkflows({ cwd });

    // Notify user of any skipped files. PRD §3.2 — hidden files were
    // already filtered silently inside the registry.
    for (const err of errors) {
      ctx.ui.notify(
        `[pi-workflows] skipped ${err.absPath}: ${err.message}`,
        err.reason === "io-error" ? "error" : "warning",
      );
    }

    // Conductor coexistence warning (PRD pin #2). Best-effort — we
    // detect by looking for an installed conductor extension file.
    if (!recursive && isConductorInstalled(cwd)) {
      ctx.ui.notify(
        "[pi-workflows] pi-conductor is also loaded. " +
          "Both manage sub-agents; consider scoping each to its own use case.",
        "info",
      );
    }

    // Register the umbrella command first so it's always visible (even
    // in recursive nested sessions, where it returns the disabled
    // message).
    registerWorkflowsCommand(pi, registry, { recursive });

    // Per-workflow `/<name>` stubs — skipped in recursive children.
    const count = registerWorkflowCommands(pi, registry, { recursive });

    // Slice 16: start hot-reload watcher. Session-locked (disable
    // checked at extension load). The mutable registry map is passed
    // by reference so hot-reload events mutate the same map that
    // registerWorkflowCommands registered from.
    try {
      const mutableRegistry = registry as Map<string, import("./types/internal.js").WorkflowFile>;
      hotReloadHandle = await createHotReloadWatcher({
        projectDir: projectWorkflowsDir(cwd),
        personalDir: workflowsHome(),
        registry: mutableRegistry,
        pi,
        activeRuns: getActiveRuns(),
        recursive,
        log: (level, msg) => {
          if (level === "warn" || level === "error") {
            ctx.ui.notify(`[pi-workflows] ${msg}`, level === "error" ? "error" : "warning");
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[pi-workflows] hot-reload failed to start: ${msg}`, "warning");
    }

    // Emit a single info line on first successful registration so users
    // running `pi -e ./dist/index.js` get visible feedback.
    if (recursive) {
      ctx.ui.notify(
        "[pi-workflows] nested pi session — workflow commands not exposed",
        "info",
      );
    } else if (count > 0) {
      ctx.ui.notify(
        `[pi-workflows] registered ${count} workflow command(s) — try /workflows`,
        "info",
      );
    } else {
      ctx.ui.notify(
        "[pi-workflows] no workflows discovered — try /workflows for help",
        "info",
      );
    }
  });

  // Slice 10: install a `session_shutdown` lifecycle hook stub. Slice
  // 11 will replace this with the real crash-sweep + abort-active-runs
  // pass; for slice 10 we only emit a notify line so users see the
  // hook firing in their session log.
  pi.on("session_shutdown", (_event, ctx) => {
    // Slice 16: close the hot-reload watcher.
    if (hotReloadHandle !== null) {
      hotReloadHandle.dispose().catch(() => { /* ignore shutdown errors */ });
      hotReloadHandle = null;
    }
    try {
      ctx.ui.notify("[pi-workflows] session shutdown", "info");
    } catch {
      /* ignore */
    }
  });
}

/**
 * Cheap heuristic for "is pi-conductor also loaded". We don't have a
 * runtime API for "list extensions" — `pi.getCommands()` is post-load
 * but conductor registers its commands too late for us to see them
 * during our own `session_start` callback in deterministic order.
 *
 * Instead we check the documented extension drop-in locations for any
 * file whose name contains `conductor`. False positives are harmless
 * (a single info-level notify on extension load).
 */
function isConductorInstalled(cwd: string): boolean {
  const candidates = [
    join(homedir(), ".pi", "agent", "extensions"),
    join(cwd, ".pi", "extensions"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      if (entries.some((e: string) => e.toLowerCase().includes("conductor"))) {
        return true;
      }
    } catch {
      // ignore — best-effort
    }
  }
  return false;
}
