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
  registerSingleWorkflowCommand,
  registerWorkflowsCommand,
} from "./commands/workflowCmd.js";
import { STUB_CUSTOM_TYPE } from "./commands/workflowCmd.internal.js";
import { makeConfirmDialog } from "./runtime/approval.js";
import { sweepCrashedRuns } from "./runtime/crashSweep.js";
import { bindRegistryToFeed } from "./runtime/overlay.js";
import { createHotReloadWatcher } from "./runtime/hotReload.js";
import { getActiveRuns } from "./runtime/activeRuns.js";
import { createOtelExporter, type OtelExporterHandle, type TailRunLedgerHandle } from "./runtime/otelExporter.js";
import {
  createOtelMetricsExporter,
  type OtelMetricsExporterHandle,
  type TailRunMetricsHandle,
} from "./runtime/otelMetricsExporter.js";
import { registerWriteWorkflowTool } from "./runtime/writeWorkflowTool.js";
import { registerRunWorkflowTool } from "./runtime/runWorkflowTool.js";
import { startWorkflowRun } from "./runManager.js";
import { wireRunDelivery } from "./runtime/resultDelivery.js";
import { activeIndexPath, projectWorkflowsDir, workflowsHome } from "./util/paths.js";
import {
  KEYWORD_NOTICE,
  WORKFLOW_DIRECTIVE,
  shouldArmKeywordTrigger,
} from "./runtime/keywordTrigger.js";
import type {
  ExtensionAPI,
  ExtensionContextLike,
  WorkflowFile,
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

  // IPC inspection surface: keep the active-runs index file current.
  // A supervisor process reads ~/.pi/agent/workflows/runs/.active to
  // discover which runs are currently in-flight without needing to
  // scan the full runs directory.
  const activeReg = getActiveRuns();
  const activeIdxFile = activeIndexPath();
  // Write immediately so the file exists even before any run starts.
  activeReg.writeActiveIndex(activeIdxFile);
  // Re-write on every registry notification (state changes, new runs, etc.).
  activeReg.subscribe(() => {
    activeReg.writeActiveIndex(activeIdxFile);
  });
  // Hot-reload watcher (slice 16) picks up the saved file automatically.
  // In recursive sessions we still register the tool but restrict the save
  // path to project scope only (same as command registration policy).
  let sessionCwd = process.cwd();
  // registry is set later (session_start); capture by reference via getter.
  let _registry: Map<string, WorkflowFile> | null = null;
  // Shared startRun closure used by both write_workflow's runNow path and
  // run_workflow. Both tools authorise via the LLM tool-call boundary, so
  // both pass `preApproved: true` here. If a stricter posture is needed,
  // gate this on a real approval block built from the tool's `ctx`.
  const startRunFromTool = async (
    workflow: WorkflowFile,
    input: string,
    _toolCtx: unknown,
  ): Promise<void> => {
    const run = await startWorkflowRun(workflow, input, {
      cwd: sessionCwd,
      preApproved: true,
      activeRuns: getActiveRuns(),
      enableGlobalCache: true,
    });
    // Without this wiring the run completes silently — no result
    // card, no `pi.sendUserMessage`, so the conversation never
    // resumes after the workflow finishes. The slash-command path
    // in `commands/workflowCmd.ts` does the same thing.
    void wireRunDelivery(pi, run);
  };

  registerWriteWorkflowTool({
    pi,
    getCwd: () => sessionCwd,
    getRegistry: () => _registry ?? new Map(),
    startRun: startRunFromTool,
  });

  // run_workflow: invoke an existing workflow by name. Mirrors the
  // `/<name>` slash-command path but driven by the LLM. Without it the
  // model can list workflows but can't trigger them.
  registerRunWorkflowTool({
    pi,
    getRegistry: () => _registry ?? new Map(),
    startRun: startRunFromTool,
  });

  // ── Slice 14 (B2): suppress STUB_CUSTOM_TYPE messages from LLM context ──
  // /workflows list, /workflows show, bypass banners, and other slash-
  // command output use `pi.sendMessage` with `customType: STUB_CUSTOM_TYPE`
  // and `deliverAs: "nextTurn"`. Without filtering, those messages land
  // in the message history and the model analyzes workflow output on the
  // next turn (e.g. typing "hello" after `/workflows list` makes the
  // model summarize the run table). The `context` event fires before
  // each LLM call with a mutable messages array; returning a filtered
  // copy keeps the messages visible in the TUI session log but invisible
  // to the model.
  pi.on("context", async (rawEvent) => {
    const event = rawEvent as {
      messages?: ReadonlyArray<{ role?: string; customType?: string }>;
    };
    const messages = event.messages;
    if (!Array.isArray(messages)) return {};
    const filtered = messages.filter(
      (m) => !(m.role === "custom" && m.customType === STUB_CUSTOM_TYPE),
    );
    if (filtered.length === messages.length) return {};
    return { messages: filtered };
  });

  // ── Keyword trigger ────────────────────────────────────────────────
  // When the user includes the word "workflow" in a prompt, inject a
  // strong system-prompt directive for that turn telling Claude to call
  // write_workflow instead of working through the task turn-by-turn.
  // Mirrors Claude Code's `workflow` keyword trigger behaviour.
  //
  // A module-level flag (`_workflowKeywordPending`) is set by the
  // `input` handler and consumed by `before_agent_start` in the same
  // request cycle. Because pi calls these two handlers sequentially for
  // a single user turn, no race is possible.
  //
  // `_keywordTriggerEnabled` persists across prompts and is toggled via
  // `/workflows keyword [on|off]`. Alt+W suppresses just the pending
  // trigger for the current prompt without changing the setting.
  //
  // Skipped when:
  //   - source is "extension" (prevents loops when pi sends injected msgs)
  //   - the text itself is a /command (already handled by command routing)
  //   - recursive mode (nested pi sessions should never auto-write workflows)
  let _workflowKeywordPending = false;
  let _keywordTriggerEnabled = true; // default: on

  if (!initialCfg.recursive) {
    pi.on("input", async (rawEvent, ctx) => {
      const event = rawEvent as { text: string; source: string };
      if (_keywordTriggerEnabled && shouldArmKeywordTrigger(event)) {
        _workflowKeywordPending = true;
        // Notify the user so they know workflow mode was triggered.
        // They can simply not include the word "workflow" to suppress it.
        try {
          ctx.ui.notify(KEYWORD_NOTICE, "info");
        } catch { /* older pi builds without ui.notify — safe to ignore */ }
      }
      return { action: "continue" };
    });

    pi.on("before_agent_start", async (rawEvent) => {
      if (!_workflowKeywordPending) return {};
      _workflowKeywordPending = false;
      const event = rawEvent as { systemPrompt?: string };
      // Append a strong directive to the system prompt for this turn only.
      return {
        systemPrompt: (event.systemPrompt ?? "") + WORKFLOW_DIRECTIVE,
      };
    });
  }

  // ── Alt+W — suppress workflow keyword trigger for next prompt ────────
  // Mirrors CC's Alt+W behaviour: if the user typed "workflow" in their
  // prompt but didn't intend to trigger the workflow writer, Alt+W
  // cancels the pending trigger and notifies them.
  if (!initialCfg.recursive) {
    const piWithShortcut = pi as typeof pi & { registerShortcut?(s: string, o: { description?: string; handler(ctx: ExtensionContextLike): void }): void };
    piWithShortcut.registerShortcut?.("alt+w", {
      description: "Suppress workflow keyword trigger for this prompt",
      handler(ctx) {
        if (_workflowKeywordPending) {
          _workflowKeywordPending = false;
          try {
            ctx.ui.notify(
              "[pi-workflows] workflow trigger suppressed — prompt will run normally",
              "info",
            );
          } catch { /* ignore */ }
        }
      },
    });
  }

  // ── Inline run progress in footer status line ──────────────────────
  // Shows "⚡ workflow-name · running" or "⚡ N workflows running" in
  // the TUI footer whenever there are active runs. Clears when idle.
  // Updated on every registry state change (no polling needed).
  //
  // statusCtx is captured from session_start and updated on each
  // session (the ctx object wraps live TUI state and is safe to
  // hold across event handlers).
  let _statusCtx: ExtensionContextLike | null = null;
  const STATUS_KEY = "pi-workflows";

  const _updateRunStatus = (): void => {
    if (_statusCtx === null) return;
    // Explicit assertion: TS won't narrow a let-captured variable inside a
    // closure, so we assert non-null after the early-exit.
    const sctx = _statusCtx as ExtensionContextLike;
    const setStatus = (sctx.ui as { setStatus?: (k: string, v: string | undefined) => void }).setStatus;
    if (!setStatus) return;
    const summaries = getActiveRuns().listSummaries();
    const active = summaries.filter(
      (s) => s.state === "running" || s.state === "paused",
    );
    try {
      if (active.length === 0) {
        setStatus(STATUS_KEY, undefined);
      } else if (active.length === 1) {
        const s = active[0]!;
        const stateIcon = s.state === "paused" ? "⏸" : "⚡";
        setStatus(STATUS_KEY, `${stateIcon} ${s.workflowName} · ${s.state}`);
      } else {
        setStatus(STATUS_KEY, `⚡ ${active.length} workflows running`);
      }
    } catch { /* swallow — TUI may not be mounted yet */ }
  };

  // Subscribe once at extension load. The same subscriber persists
  // across sessions (each session_start refreshes _statusCtx).
  getActiveRuns().subscribe(_updateRunStatus);

  // `/workflows` so its handler can return the documented error
  // message; we just don't expose `/<workflowName>`.
  const recursive = initialCfg.recursive;

  // Slice 16: hot-reload watcher handle — created in session_start,
  // closed in session_shutdown. Using `let` + outer scope so the
  // shutdown handler can reference it.
  let hotReloadHandle: { dispose(): Promise<void> } | null = null;

  // ZONE_OTEL: OTel trace exporter handle. Created lazily on first
  // session_start when the env var is set; disposed in
  // session_shutdown. Per-run tailers are stored in a map so we can
  // dispose them in shutdown order even if the run never emitted a
  // terminal transition (parent-crash path).
  let otelHandle: OtelExporterHandle | null = null;
  const otelTailers = new Map<string, TailRunLedgerHandle>();
  let otelUnsubscribe: (() => void) | null = null;

  // ZONE_OTEL: parallel metrics exporter handle. Brought up next to
  // the trace exporter so traces+metrics share a session lifetime
  // but are wired to independent endpoints + SDKs.
  let otelMetricsHandle: OtelMetricsExporterHandle | null = null;
  const otelMetricsTailers = new Map<string, TailRunMetricsHandle>();
  let otelMetricsUnsubscribe: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = (ctx as ExtensionContextLike).cwd ?? process.cwd();
    sessionCwd = cwd; // update for write_workflow tool
    _statusCtx = ctx as ExtensionContextLike; // for inline run-status footer

    // ZONE_OTEL: Bring up the OpenTelemetry exporter once per session
    // when an OTLP endpoint is configured. Strict no-op when unset.
    if (otelHandle === null && initialCfg.otelTracesEndpoint !== null) {
      try {
        otelHandle = await createOtelExporter({
          endpoint: initialCfg.otelTracesEndpoint,
          log: (level, msg) => {
            try {
              ctx.ui.notify(msg, level === "warn" ? "warning" : "info");
            } catch { /* ignore */ }
          },
        });
        if (otelHandle.enabled) {
          ctx.ui.notify(
            `[pi-workflows] OpenTelemetry exporter active → ${initialCfg.otelTracesEndpoint}`,
            "info",
          );
          // Subscribe to the active-runs registry so each new run gets
          // its own ledger tailer. The subscriber is idempotent: it
          // diffs against `otelTailers` so re-firing notifications
          // (state changes) don't spawn duplicate tailers.
          const reg = getActiveRuns();
          otelUnsubscribe = reg.subscribe(() => {
            for (const s of reg.listSummaries()) {
              if (otelTailers.has(s.runId)) continue;
              if (otelHandle === null) continue;
              const tail = otelHandle.tailRun(s.runId);
              if (tail !== null) {
                otelTailers.set(s.runId, tail);
                // Self-cleanup on done (terminal transition observed).
                tail.done
                  .then(() => { otelTailers.delete(s.runId); })
                  .catch(() => { otelTailers.delete(s.runId); });
              }
            }
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`[pi-workflows] OTel exporter init failed: ${msg}`, "warning");
      }
    }

    // ZONE_OTEL: Bring up the OpenTelemetry **metrics** exporter
    // (counters + Gen-AI histograms). Independent endpoint resolution
    // — operators can enable traces, metrics, both, or neither.
    if (otelMetricsHandle === null && initialCfg.otelMetricsEndpoint !== null) {
      try {
        otelMetricsHandle = await createOtelMetricsExporter({
          endpoint: initialCfg.otelMetricsEndpoint,
          log: (level, msg) => {
            try {
              ctx.ui.notify(msg, level === "warn" ? "warning" : "info");
            } catch { /* ignore */ }
          },
        });
        if (otelMetricsHandle.enabled) {
          ctx.ui.notify(
            `[pi-workflows] OpenTelemetry metrics exporter active → ${initialCfg.otelMetricsEndpoint}`,
            "info",
          );
          const reg = getActiveRuns();
          otelMetricsUnsubscribe = reg.subscribe(() => {
            for (const s of reg.listSummaries()) {
              if (otelMetricsTailers.has(s.runId)) continue;
              if (otelMetricsHandle === null) continue;
              const tail = otelMetricsHandle.tailRun(s.runId);
              if (tail !== null) {
                otelMetricsTailers.set(s.runId, tail);
                tail.done
                  .then(() => { otelMetricsTailers.delete(s.runId); })
                  .catch(() => { otelMetricsTailers.delete(s.runId); });
              }
            }
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`[pi-workflows] OTel metrics exporter init failed: ${msg}`, "warning");
      }
    }

    // Slice 11: crash-sweep BEFORE workflow discovery so any
    // sweep-flipped runs are visible to a same-tick `/workflows list`.
    // The sweep is best-effort — errors are surfaced via notify but
    // never block extension load.
    try {
      const sweep = await sweepCrashedRuns({
        autoResume: initialCfg.autoResumeCrashedWorkflows,
        activeRuns: getActiveRuns(),
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
      if (sweep.resumed.length > 0) {
        ctx.ui.notify(
          `[pi-workflows] crash-sweep: auto-resumed ${sweep.resumed.length} run(s)`,
          "info",
        );
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
    // Make the registry available to the write_workflow tool's runNow path.
    _registry = registry as Map<string, WorkflowFile>;

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
    registerWorkflowsCommand(pi, registry, {
      recursive,
      keywordTrigger: {
        get: () => _keywordTriggerEnabled,
        set: (v) => { _keywordTriggerEnabled = v; },
      },
    });

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
        // Slice 16 fix: when a new workflow file appears at runtime,
        // register it via the same handler `registerWorkflowCommands`
        // builds at discovery time — not the description-only stub
        // the watcher used to install. Closes the gap where freshly
        // added workflows could be discovered (`/workflows` listed
        // them) but their `/<name>` slash-command was a no-op.
        registerCommand: (file) => registerSingleWorkflowCommand(pi, file),
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
    // ZONE_OTEL: dispose per-run tailers + flush + shutdown the
    // provider so any buffered spans land before the host exits.
    if (otelUnsubscribe !== null) {
      otelUnsubscribe();
      otelUnsubscribe = null;
    }
    if (otelTailers.size > 0) {
      const handles = Array.from(otelTailers.values());
      otelTailers.clear();
      void Promise.allSettled(handles.map((h) => h.dispose()));
    }
    if (otelHandle !== null) {
      const h = otelHandle;
      otelHandle = null;
      void h.flush()
        .catch(() => {})
        .then(() => h.shutdown())
        .catch(() => {});
    }
    // ZONE_OTEL: same teardown for the metrics exporter.
    if (otelMetricsUnsubscribe !== null) {
      otelMetricsUnsubscribe();
      otelMetricsUnsubscribe = null;
    }
    if (otelMetricsTailers.size > 0) {
      const handles = Array.from(otelMetricsTailers.values());
      otelMetricsTailers.clear();
      void Promise.allSettled(handles.map((h) => h.dispose()));
    }
    if (otelMetricsHandle !== null) {
      const h = otelMetricsHandle;
      otelMetricsHandle = null;
      void h.flush()
        .catch(() => {})
        .then(() => h.shutdown())
        .catch(() => {});
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

// IPC inspection surface: export WorkflowClient so supervisor agents can
// import it directly without digging into runtime internals.
export { WorkflowClient } from "./client.js";
export type { WorkflowClientOptions, ActiveRunsIndex, RunStateSummary } from "./client.js";

// Public author-facing types. Authors writing workflow scripts get
// these via either `/// <reference types="@samfp/pi-workflows" />`
// (resolves to dist/index.d.ts → transitive load of these exports) or
// explicit `import type { WorkflowMain, AgentResult } from "@samfp/pi-workflows"`.
// `public.d.ts` is hand-authored and copied to dist/types/ at build time;
// this re-export is what threads it into the package's public surface.
export type {
  AgentOpts,
  AgentHandle,
  AgentUsage,
  AgentResult,
  RunMeta,
  MemoryScope,
  MemoryCompactResult,
  IsolationMode,
  AggregateMethod,
  AggregateResult,
  CritiqueOpts,
  CritiqueResult,
  InterruptOpts,
  InterruptResult,
  PromoteOpts,
  PromoteResult,
  VoteResult,
  ConsensusResult,
  ConsensusOpts,
  ParallelOpts,
  PhaseOpts,
  RetryOpts,
  SleepOpts,
  WorkflowContext,
  WorkflowMain,
} from "./types/public.js";

// ZONE_TIMETRAVEL: time-travel / fork-from-checkpoint API.
export {
  forkFromCheckpoint,
  ForkRunNotFoundError,
  ForkPhaseNotFoundError,
  FORK_OVERRIDES_KEY,
} from "./runtime/forkRun.js";
export type { ForkFromCheckpointOptions } from "./runtime/forkRun.js";
