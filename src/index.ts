/**
 * pi-workflows — extension entry point (slice 1 skeleton).
 *
 * Wires up:
 *
 *   - Disable knobs (env first, then setting) per PRD §3.6.
 *   - Recursion ban (`PI_WORKFLOWS_RECURSIVE=1`) per PRD §13.7. The
 *     extension still loads in nested sessions; we just skip
 *     `registerCommand` for per-workflow `/<name>` commands and route
 *     `/workflows` to the documented error message.
 *   - One-shot workflow discovery on `session_start`. Hot-reload lands
 *     in slice 16.
 *   - Per-workflow stub slash commands (slice 10 replaces the handler).
 *   - The `/workflows` umbrella command (slice 13 replaces with TUI).
 *   - A startup warning if pi-conductor is also installed (PRD pin #2).
 *
 * Slice 1 deliberately does **no** runtime work — no sandbox, no cache,
 * no dispatcher, no ledger. Invoking a workflow returns a stub card.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { discoverWorkflows } from "./registry.js";
import {
  registerWorkflowCommands,
  registerWorkflowsCommand,
} from "./commands/workflowCmd.js";
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

  // PRD §13.7: in a recursive (sub-agent child) load, we still register
  // `/workflows` so its handler can return the documented error
  // message; we just don't expose `/<workflowName>`.
  const recursive = initialCfg.recursive;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = (ctx as ExtensionContextLike).cwd ?? process.cwd();
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
