/**
 * pi-workflows — slash-command registration.
 *
 * Slice 1 registered stubs; slice 9 added the approval gate; slice 10
 * wires:
 *
 *   - End-to-end result delivery via `deliverRunResult` (cards +
 *     `result.json` + `pi.appendEntry("pi-workflows.run.ended")` +
 *     `pi.sendUserMessage(finishCallbackPrompt)`).
 *   - Active-runs index `pi.appendEntry("pi-workflows.run.started")`
 *     emitted as soon as `startWorkflowRun` returns a Run handle.
 *   - PRD §3.6 / §13.7 recursion guard: when the extension was
 *     loaded with `PI_WORKFLOWS_RECURSIVE=1`, no per-workflow
 *     `/<name>` is registered and `/workflows` returns the documented
 *     error message.
 *
 * Slice 11 adds sub-commands to the umbrella `/workflows` command:
 *
 *   - `/workflows`           — list discovered workflows (slice 1)
 *   - `/workflows list`      — list active + recent runs
 *   - `/workflows show <id>` — print manifest + last 50 ledger entries
 *   - `/workflows resume <id> [--latest]` — resume a paused/crashed run
 *   - `/workflows kill <id>` — abort an active run (slice 11 stub: not
 *                              fully wired — needs slice-13 active
 *                              run registry; emits a stub for now)
 *   - `/workflows gc [--apply]` — dry-run GC walk (or apply with `--apply`)
 *
 * Slice 2 carry-forward: helpers/constants live in
 * `workflowCmd.internal.ts`. Slice 13 will replace `/workflows` with
 * the TUI overlay.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContextLike,
  WorkflowFile,
  WorkflowRegistry,
} from "../types/internal.js";
import {
  STUB_CUSTOM_TYPE,
  formatRegistryListing,
  stubDescription,
  stubMessage,
} from "./workflowCmd.internal.js";
import { startWorkflowRun, RunCancelledError } from "../runManager.js";
import { deliverRunResult, RUN_STARTED_ENTRY, wireRunDelivery } from "../runtime/resultDelivery.js";
import { makeConfirmDialog } from "../runtime/approval.js";
import type { ApprovalDialog } from "../types/internal.js";
import {
  resumeRun,
  ResumeNotAllowedError,
  ResumeLockedError,
  RunNotFoundError,
} from "../runtime/resumeRun.js";
import { runGc } from "../runtime/gc.js";
import { LedgerReader } from "../runtime/ledger.js";
import { getActiveRuns } from "../runtime/activeRuns.js";
import { mountOverlay, runKill } from "../runtime/overlay.js";
import { restartTerminalRun } from "../runtime/restart.js";
import {
  defaultSaveScriptIO,
  runSaveScript,
  type SaveScriptUI,
} from "../runtime/saveScript.js";
import {
  copyToClipboard,
  openTranscriptInEditor,
} from "../runtime/transcriptOpen.js";
import { writeMermaidToTmp } from "../runtime/visualize.js";
import { runDir as runDirFor, runsHome } from "../util/paths.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Slice 9 helper: build the `approval` block for `startWorkflowRun`.
 * Real pi exposes `ctx.ui.confirm` per docs/rpc.md; the test harness
 * substitutes its own dialog adapter.
 */
function buildApprovalBlock(
  ctx: ExtensionCommandContextLike,
): {
  dialog: ApprovalDialog;
  viewer: (absPath: string) => Promise<void> | void;
} {
  const ctxConfirm = (ctx as ExtensionCommandContextLike & {
    ui: { confirm?: (msg: string) => Promise<boolean> };
  }).ui.confirm;
  if (typeof ctxConfirm !== "function") {
    // No real ctx.ui.confirm — return a default-deny dialog. Better to
    // surface a clear denial than to silently auto-approve.
    return {
      dialog: async () => "no" as const,
      viewer: () => undefined,
    };
  }
  const dialog = makeConfirmDialog({
    confirm: (msg) => ctxConfirm.call(ctx.ui, msg),
  });
  return {
    dialog,
    viewer: () => undefined, // Slice 13 wires editor open; slice 9 no-op.
  };
}

/**
 * Register a `/<name>` slash-command for a single workflow file.
 *
 * Extracted from `registerWorkflowCommands` so the slice-16 hot-reload
 * watcher (`src/runtime/hotReload.ts`) can register commands for files
 * added at runtime using the SAME real handler — no stubs, no
 * `[runtime-init failed]` placeholder. Calling this twice with the
 * same name is the documented re-registration path: pi's
 * `registerCommand` overwrites the existing entry, which is exactly
 * what hot-reload's `change` event needs.
 *
 * Behavior is identical to the body of the original
 * `registerWorkflowCommands` for-loop iteration; do not diverge them.
 */
export function registerSingleWorkflowCommand(
  pi: ExtensionAPI,
  file: WorkflowFile,
): void {
  pi.registerCommand(file.name, {
    description: stubDescription(file),
    handler: async (args, ctx) => {
        // Slice 9: real approval gate. preApproved is gone from the
        // production path. Bypass-permissions / pi-p / SDK / mock-agents
        // are detected inside `runApprovalGate`; everything else gets
        // the 4-button dialog via ctx.ui.confirm.
        const approval = buildApprovalBlock(ctx);
        const emitBanner = (banner: string): void => {
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content: banner,
              display: true,
              details: {
                workflowName: file.name,
                kind: "bypass-banner",
                slice: "9",
              },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
        };
        try {
          const run = await startWorkflowRun(file, args, {
            approval,
            emitBanner,
            // Enable cross-run agent result reuse keyed by script sha256.
            // Natural cache invalidation: any change to the workflow source
            // produces a different sha256 → different global cache dir.
            enableGlobalCache: true,
            // Slice 13/F3: register the live Run handle into the
            // per-process active-runs registry so the overlay's hotkey
            // wiring (`p`/`x`/`r`) and `/workflows kill` find it.
            activeRuns: getActiveRuns(),
            // Slice 14: forward phase/agent overlay events to pi.appendEntry
            // so the TUI overlay's bindRegistryToFeed picks them up.
            emitOverlayEvent: (customType, data) => {
              if (typeof pi.appendEntry !== "function") return;
              try {
                pi.appendEntry(customType, data);
              } catch {
                /* swallow — emission failures must not abort the run */
              }
            },
          });
          // Slice 10: active-runs index entry on start (PRD §6.6).
          if (typeof pi.appendEntry === "function") {
            try {
              pi.appendEntry(RUN_STARTED_ENTRY, {
                runId: run.runId,
                workflowName: file.name,
                runDir: run.runDirAbs,
                approval: run.approvalDecision,
                args,
              });
            } catch {
              /* swallow */
            }
          }
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content:
                `▶ Workflow "${file.name}" started (runId=${run.runId})\n` +
                `  Run dir: ${run.runDirAbs}`,
              display: true,
              details: {
                workflowName: file.name,
                runId: run.runId,
                runDir: run.runDirAbs,
                approval: run.approvalDecision,
                kind: "run-started",
              },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
          // Slice 10: deliver the result asynchronously via
          // `Run.terminated` so the slash-command handler returns
          // immediately (fire-and-forget). The terminal info promise
          // never rejects, so we don't have to chain a .catch.
          void wireRunDelivery(pi, run);
        } catch (err) {
          if (err instanceof RunCancelledError) {
            // Slice 10: route the cancelled-pre-run path through
            // `deliverRunResult` so the card matches the same template
            // (and `result.json` exists). RunCancelledError doesn't
            // carry timing info; fabricate a minimal block.
            try {
              const nowIso = new Date().toISOString();
              await deliverRunResult({
                pi,
                outcome: "cancelled-pre-run",
                workflowName: file.name,
                runId: err.runId,
                runDirAbs: err.runDirAbs,
                startedAt: nowIso,
                endedAt: nowIso,
                durationMs: 0,
                agentCount: 0,
                result: undefined,
                error: { name: err.name, message: err.message },
                approval: err.approvalDecision,
                finishCallbackPrompt: null,
              });
            } catch {
              /* swallow */
            }
            return;
          }
          // Stub fallback so a runtime-init failure doesn't crash the
          // session. Surfaces the underlying message.
          const msg = err instanceof Error ? err.message : String(err);
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content:
                stubMessage(file) +
                `\n\n[runtime-init failed: ${msg}]`,
              display: true,
              details: {
                workflowName: file.name,
                absPath: file.absPath,
                scope: file.scope,
                error: msg,
                slice: "9",
              },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
        }
      },
    });
}

/**
 * Register `/<name>` for every workflow in the registry. Returns the
 * count of commands registered for logging purposes.
 *
 * `recursive=true` short-circuits — used by the dispatcher's
 * sub-agent children (PRD §13.7). Caller should still register
 * `/workflows` separately so the "disabled in nested pi sessions"
 * error message is reachable.
 */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  registry: WorkflowRegistry,
  opts: { recursive?: boolean } = {},
): number {
  if (opts.recursive) return 0;

  let count = 0;
  for (const file of registry.values()) {
    registerSingleWorkflowCommand(pi, file);
    count++;
  }
  return count;
}

/**
 * Register the `/workflows` umbrella command.
 *
 * Slice 11 dispatches sub-commands:
 *   - (no args)              → list discovered workflows
 *   - `list`                  → list active + recent runs
 *   - `show <id>`             → manifest + last 50 ledger entries
 *   - `resume <id> [--latest]`→ resume a paused/crashed run
 *   - `kill <id>`             → stub: emits a card + appendEntry
 *                                request to the active-runs registry
 *                                (slice 13 wires the in-process kill).
 *   - `gc [--apply]`          → dry-run GC walk
 */
export function registerWorkflowsCommand(
  pi: ExtensionAPI,
  registry: WorkflowRegistry,
  opts: {
    recursive?: boolean;
    /**
     * Optional getter/setter for the keyword trigger toggle.
     * When provided, `/workflows keyword` sub-command is enabled.
     */
    keywordTrigger?: {
      get(): boolean;
      set(value: boolean): void;
    };
  } = {},
): void {
  pi.registerCommand("workflows", {
    description:
      "List discovered workflows or manage runs (list/show/resume/gc/kill)",
    handler: async (args, ctx) => {
      if (opts.recursive) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: "workflows are disabled in nested pi sessions",
            display: true,
            details: { recursive: true, slice: 11 },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }

      const trimmed = args.trim();
      if (trimmed.length === 0) {
        // Slice 13: `/workflows` no-arg opens the TUI overlay (PRD
        // §10.1). When stdout isn't a TTY (`pi -p` / SDK) the overlay
        // falls back to printing the runs list to chat per PRD
        // §10.9. Either way, we ALSO surface a workflow-discovery
        // listing so scripts that grep for it keep working.
        const callbacks = buildOverlayCallbacks(pi, registry, ctx);
        const result = await mountOverlay({
          pi,
          ctx,
          onStopAgent: (runId, agentId) => {
            const run = getActiveRuns().getRun(runId);
            run?.stopAgent(agentId);
          },
          onRestartAgent: (runId, agentId) => {
            const run = getActiveRuns().getRun(runId);
            run?.restartAgent(agentId);
          },
          onRestartRequested: callbacks.onRestartRequested,
          onSaveScriptRequested: callbacks.onSaveScriptRequested,
          onVisualizeRequested: callbacks.onVisualizeRequested,
          onOpenTranscript: callbacks.onOpenTranscript,
          onCopyPrompt: callbacks.onCopyPrompt,
        });
        if (result.mode === "already-open") {
          ctx.ui.notify("workflows overlay already open", "info");
          return;
        }
        if (result.mode === "tui") {
          ctx.ui.notify(
            registry.size === 0
              ? "no workflows discovered"
              : `${registry.size} workflow(s) discovered`,
            "info",
          );
          return;
        }
        // Non-TTY / no-custom-api fallback: also send the workflow
        // listing for parity with slice-1 behavior.
        const body = formatRegistryListing(registry);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: body,
            display: true,
            details: {
              workflowCount: registry.size,
              slice: 13,
              overlayMode: result.mode,
            },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        ctx.ui.notify(
          registry.size === 0
            ? "no workflows discovered"
            : `${registry.size} workflow(s) discovered`,
          "info",
        );
        return;
      }

      // Sub-command dispatch. Tokenize on whitespace.
      const tokens = trimmed.split(/\s+/);
      const sub = tokens[0]!.toLowerCase();
      const rest = tokens.slice(1);
      try {
        switch (sub) {
          case "list":
            return await handleList(pi);
          case "show":
            return await handleShow(pi, rest);
          case "resume":
            return await handleResume(pi, rest);
          case "gc":
            return await handleGc(pi, rest);
          case "kill":
            return handleKill(pi, rest);
          case "keyword": {
            const kt = opts.keywordTrigger;
            if (!kt) {
              pi.sendMessage(
                { customType: STUB_CUSTOM_TYPE, content: "keyword trigger not configured", display: true, details: {} },
                { triggerTurn: false, deliverAs: "nextTurn" },
              );
              return;
            }
            // 'keyword on|off' or 'keyword' to toggle
            const arg = (rest[0] ?? "").toLowerCase();
            if (arg === "on") kt.set(true);
            else if (arg === "off") kt.set(false);
            else kt.set(!kt.get()); // toggle
            const newState = kt.get();
            pi.sendMessage(
              {
                customType: STUB_CUSTOM_TYPE,
                content: `workflow keyword trigger: **${newState ? "on" : "off"}**\n\n` +
                  (newState
                    ? "Claude will write a workflow script when your prompt includes the word \"workflow\"."
                    : "Keyword detection is disabled. Use write_workflow directly or type /deep-research, /codebase-audit, etc."),
                display: true,
                details: { keywordTriggerEnabled: newState },
              },
              { triggerTurn: false, deliverAs: "nextTurn" },
            );
            return;
          }
          default:
            pi.sendMessage(
              {
                customType: STUB_CUSTOM_TYPE,
                content:
                  `unknown sub-command "${sub}".\n\n` +
                  "Available: (no args | list | show <id> | resume <id> [--latest] | gc [--apply] | kill <id> | keyword [on|off])",
                display: true,
                details: { subcommand: sub, slice: 11 },
              },
              { triggerTurn: false, deliverAs: "nextTurn" },
            );
            return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `[/workflows ${sub}] error: ${msg}`,
            display: true,
            details: { subcommand: sub, error: msg, slice: 11 },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    },
  });
}

// ─── sub-command handlers ─────────────────────────────────────────

function listRunDirs(): Array<{
  runId: string;
  runDir: string;
  state: string | null;
  workflowName: string | null;
  startedAt: string | null;
}> {
  const root = runsHome();
  if (!existsSync(root)) return [];
  const out: Array<{
    runId: string;
    runDir: string;
    state: string | null;
    workflowName: string | null;
    startedAt: string | null;
  }> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.startsWith("wf-")) continue;
    const runDir = join(root, e);
    let isDir = false;
    try {
      isDir = statSync(runDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let workflowName: string | null = null;
    let startedAt: string | null = null;
    let state: string | null = null;
    try {
      const m = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
        workflowName?: string;
        startedAt?: string;
      };
      workflowName = m.workflowName ?? null;
      startedAt = m.startedAt ?? null;
    } catch {
      /* ignore */
    }
    try {
      // Quick state probe: read last `transition` line from ledger.
      const raw = readFileSync(join(runDir, "ledger.jsonl"), "utf8");
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        if (line.length === 0) continue;
        try {
          const o = JSON.parse(line) as { type?: string; to?: string };
          if (o.type === "transition" && typeof o.to === "string") {
            state = o.to;
            break;
          }
        } catch {
          /* ignore corrupt line */
        }
      }
    } catch {
      /* ignore */
    }
    out.push({ runId: e, runDir, state, workflowName, startedAt });
  }
  // Sort by startedAt desc; falls back to runId.
  out.sort((a, b) => {
    if (a.startedAt && b.startedAt) return b.startedAt.localeCompare(a.startedAt);
    return b.runId.localeCompare(a.runId);
  });
  return out;
}

function handleList(pi: ExtensionAPI): void {
  const runs = listRunDirs();
  if (runs.length === 0) {
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content: "no runs found in ~/.pi/agent/workflows/runs/",
        display: true,
        details: { kind: "runs-list", count: 0, slice: 11 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  // Show up to 20 most-recent.
  const top = runs.slice(0, 20);
  const lines: string[] = [
    `${runs.length} run(s) on disk (showing ${top.length} most-recent):`,
    "",
    `${"runId".padEnd(18)} ${"name".padEnd(20)} ${"state".padEnd(20)} startedAt`,
  ];
  for (const r of top) {
    lines.push(
      `${r.runId.padEnd(18)} ${(r.workflowName ?? "<?>").slice(0, 20).padEnd(20)} ${(r.state ?? "<?>").padEnd(20)} ${r.startedAt ?? "<?>"}`,
    );
  }
  pi.sendMessage(
    {
      customType: STUB_CUSTOM_TYPE,
      content: lines.join("\n"),
      display: true,
      details: { kind: "runs-list", count: runs.length, slice: 11 },
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
}

async function handleShow(
  pi: ExtensionAPI,
  args: ReadonlyArray<string>,
): Promise<void> {
  const runId = args[0];
  if (!runId) {
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content: "/workflows show <runId> — missing runId argument",
        display: true,
        details: { subcommand: "show", slice: 11 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  const runDir = runDirFor(runId);
  if (!existsSync(runDir)) {
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content: `run ${runId} not found at ${runDir}`,
        display: true,
        details: { subcommand: "show", runId, slice: 11 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  // Read manifest.
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  } catch {
    /* ignore */
  }
  // Read last 50 ledger entries.
  const reader = new LedgerReader({ runId });
  const { entries, finalState, warnings } = await reader.read();
  const tail = entries.slice(-50);
  const lines: string[] = [
    `Run: ${runId}`,
    `Run dir: ${runDir}`,
    `State: ${finalState}`,
    `Manifest: ${JSON.stringify(manifest, null, 2)}`,
    "",
    `Last ${tail.length} of ${entries.length} ledger entries:`,
    ...tail.map((e) => JSON.stringify(e)),
  ];
  if (warnings.length > 0) {
    lines.push("", `${warnings.length} warning(s):`);
    for (const w of warnings) lines.push(`  ${JSON.stringify(w)}`);
  }
  pi.sendMessage(
    {
      customType: STUB_CUSTOM_TYPE,
      content: lines.join("\n"),
      display: true,
      details: {
        subcommand: "show",
        runId,
        finalState,
        entryCount: entries.length,
        warnings: warnings.length,
        slice: 11,
      },
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
}

async function handleResume(
  pi: ExtensionAPI,
  args: ReadonlyArray<string>,
): Promise<void> {
  const runId = args.find((a) => !a.startsWith("--"));
  const useLatest = args.includes("--latest");
  if (!runId) {
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content:
          "/workflows resume <runId> [--latest] — missing runId\n\n" +
          "Use --latest to re-load the LIVE workflow file (cache will mostly miss).",
        display: true,
        details: { subcommand: "resume", slice: 11 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  try {
    const run = await resumeRun(runId, {
      useLatest,
      preApproved: true, // slice 11: TODO wire approval through pi.ui.confirm in slice 13
      activeRuns: getActiveRuns(),
      onLatestWarning: (w) =>
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: w,
            display: true,
            details: { subcommand: "resume", runId, kind: "latest-warning", slice: 11 },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        ),
    });
    if (typeof pi.appendEntry === "function") {
      try {
        pi.appendEntry(RUN_STARTED_ENTRY, {
          runId: run.runId,
          runDir: run.runDirAbs,
          resumed: true,
        });
      } catch {
        /* swallow */
      }
    }
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content:
          `▶ Workflow resumed (runId=${run.runId})\n` +
          `  Run dir: ${run.runDirAbs}` +
          (useLatest ? "\n  Mode: --latest (live workflow file)" : "\n  Mode: frozen script.js"),
        display: true,
        details: {
          subcommand: "resume",
          runId: run.runId,
          runDir: run.runDirAbs,
          useLatest,
          slice: 11,
        },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    run.promise.catch(() => undefined);
    void run.terminated.then(async (info) => {
      try {
        await deliverRunResult({
          pi,
          outcome: info.outcome,
          workflowName: info.workflowName,
          runId: info.runId,
          runDirAbs: info.runDirAbs,
          startedAt: info.startedAt,
          endedAt: info.endedAt,
          durationMs: info.durationMs,
          agentCount: info.agentCount,
          result: info.result,
          error: info.error,
          approval: info.approval,
          finishCallbackPrompt: info.finishCallbackPrompt,
        });
      } catch {
        /* swallow */
      }
    });
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      pi.sendMessage(
        {
          customType: STUB_CUSTOM_TYPE,
          content: `/workflows resume: run ${runId} not found`,
          display: true,
          details: { subcommand: "resume", runId, error: "not-found", slice: 11 },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      return;
    }
    if (err instanceof ResumeNotAllowedError) {
      pi.sendMessage(
        {
          customType: STUB_CUSTOM_TYPE,
          content: err.message,
          display: true,
          details: {
            subcommand: "resume",
            runId,
            currentState: err.currentState,
            resultFilePath: err.resultFilePath,
            error: "non-resumable",
            slice: 11,
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      return;
    }
    if (err instanceof ResumeLockedError) {
      pi.sendMessage(
        {
          customType: STUB_CUSTOM_TYPE,
          content: err.message,
          display: true,
          details: {
            subcommand: "resume",
            runId,
            holderPid: err.holderPid,
            error: "locked",
            slice: 11,
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      return;
    }
    if (err instanceof RunCancelledError) {
      pi.sendMessage(
        {
          customType: STUB_CUSTOM_TYPE,
          content: `resume cancelled: ${err.message}`,
          display: true,
          details: {
            subcommand: "resume",
            runId,
            error: "cancelled",
            slice: 11,
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      return;
    }
    throw err;
  }
}

async function handleGc(
  pi: ExtensionAPI,
  args: ReadonlyArray<string>,
): Promise<void> {
  const apply = args.includes("--apply");
  const cutoff = (() => {
    const idx = args.findIndex((a) => a.startsWith("--days="));
    if (idx === -1) return 30;
    const v = Number(args[idx]!.slice("--days=".length));
    return Number.isFinite(v) && v >= 0 ? v : 30;
  })();
  const result = await runGc({ apply, cutoffDays: cutoff });
  const lines: string[] = [
    `GC ${apply ? "apply" : "dry-run"} — cutoff=${result.cutoffDays}d`,
    `  scanned=${result.scanned}`,
    `  candidates=${result.candidates.length}` +
      (result.applied ? `  deleted=${result.deleted.length}` : ""),
    `  skipped=${result.skipped.length}  errors=${result.errors.length}`,
    "",
  ];
  if (result.candidates.length > 0) {
    lines.push(`Candidates${apply ? " deleted" : " (would delete)"}:`);
    for (const c of result.candidates.slice(0, 50)) {
      lines.push(
        `  ${c.runId}  outcome=${c.outcome}  age=${c.ageDays.toFixed(1)}d`,
      );
    }
    if (result.candidates.length > 50) {
      lines.push(`  … +${result.candidates.length - 50} more`);
    }
  }
  if (!apply) {
    lines.push("", "Add `--apply` to actually delete the candidate run dirs.");
  }
  pi.sendMessage(
    {
      customType: STUB_CUSTOM_TYPE,
      content: lines.join("\n"),
      display: true,
      details: {
        subcommand: "gc",
        applied: result.applied,
        cutoffDays: result.cutoffDays,
        candidates: result.candidates.length,
        deleted: result.deleted.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
        slice: 11,
      },
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
}

function handleKill(
  pi: ExtensionAPI,
  args: ReadonlyArray<string>,
): void {
  const runId = args[0];
  if (!runId) {
    pi.sendMessage(
      {
        customType: STUB_CUSTOM_TYPE,
        content: "/workflows kill <runId> — missing runId argument",
        display: true,
        details: { subcommand: "kill", slice: 13 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  // Slice 13/F2: route through the active-runs registry. `runKill`
  // emits the appendEntry (cross-process awareness) AND calls
  // `Run.stop("user-kill")` on the live in-process handle if we hold
  // one. Idempotent at every layer.
  const registry = getActiveRuns();
  const result = runKill(pi, registry, runId, "user-kill");
  pi.sendMessage(
    {
      customType: STUB_CUSTOM_TYPE,
      content: result.found
        ? `kill signal sent to runId=${runId} (in-process Run handle aborted).`
        : `kill request emitted for runId=${runId}.\n` +
          `Note: no in-process Run handle is registered (run was started in a different pi window or has already terminated). The request is recorded via pi.appendEntry.`,
      display: true,
      details: {
        subcommand: "kill",
        runId,
        found: result.found,
        emittedEntry: result.emittedEntry,
        slice: 13,
      },
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
}

// ─── overlay hotkey callbacks (r/s/t/c) ─────────────────────────────

interface OverlayCallbacks {
  onRestartRequested: (runId: string) => Promise<void>;
  onSaveScriptRequested: (runId: string) => Promise<void>;
  onVisualizeRequested: (runId: string) => Promise<string | undefined>;
  onOpenTranscript: (transcriptPath: string) => string;
  onCopyPrompt: (text: string) => string;
}

/**
 * Build the overlay hotkey callbacks (`r`/`s`/`t`/`c`/`v`). Each
 * callback wraps a real implementation module:
 *
 *   - `r` (restart)         → {@link restartTerminalRun} from `runtime/restart.ts`
 *   - `s` (save script)     → {@link runSaveScript}        from `runtime/saveScript.ts`
 *   - `t` (open transcript) → {@link openTranscriptInEditor} from `runtime/transcriptOpen.ts`
 *   - `c` (copy prompt)     → {@link copyToClipboard}       from `runtime/transcriptOpen.ts`
 *   - `v` (viz)             → {@link writeMermaidToTmp}      from `runtime/visualize.ts`
 *
 * Failures are surfaced via `pi.sendMessage` (cards) and via banner
 * strings returned to the overlay.
 */
function buildOverlayCallbacks(
  pi: ExtensionAPI,
  registry: WorkflowRegistry,
  ctx: ExtensionCommandContextLike,
): OverlayCallbacks {
  return {
    onRestartRequested: async (runId: string) => {
      const summary = getActiveRuns().getSummary(runId);
      if (summary === undefined || summary.runDir === undefined) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `restart failed: no run summary for ${runId}`,
            display: true,
            details: { kind: "restart-error", runId, reason: "missing-summary" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }
      // Recover the original input + workflow path from manifest.json.
      const manifestAbs = join(summary.runDir, "manifest.json");
      let manifest: { input?: string; workflowAbsPath?: string; workflowName?: string } = {};
      try {
        manifest = JSON.parse(readFileSync(manifestAbs, "utf8"));
      } catch (err) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `restart failed: cannot read manifest at ${manifestAbs} — ${(err as Error).message}`,
            display: true,
            details: { kind: "restart-error", runId, reason: "missing-manifest" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }
      // Look up the WorkflowFile in the live registry by name. If it's
      // gone (file deleted or unloaded) we can't restart; surface a
      // clear error rather than guess.
      const workflowName = manifest.workflowName ?? summary.workflowName;
      const workflow = registry.get(workflowName);
      if (workflow === undefined) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content:
              `restart failed: workflow "${workflowName}" is no longer registered. ` +
              `Re-add the script and try again.`,
            display: true,
            details: { kind: "restart-error", runId, workflowName, reason: "workflow-unregistered" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }
      const approval = buildApprovalBlock(ctx);
      try {
        const outcome = await restartTerminalRun({
          source: summary,
          input: manifest.input ?? "",
          workflow,
          start: startWorkflowRun,
          startOptions: {
            approval,
            enableGlobalCache: true,
            activeRuns: getActiveRuns(),
            emitOverlayEvent: (customType, data) => {
              if (typeof pi.appendEntry !== "function") return;
              try {
                pi.appendEntry(customType, data);
              } catch {
                /* swallow */
              }
            },
          },
        });
        if (outcome.kind === "started") {
          // Wire the new run through the same delivery + appendEntry
          // hooks the per-workflow command uses.
          if (typeof pi.appendEntry === "function") {
            try {
              pi.appendEntry(RUN_STARTED_ENTRY, {
                runId: outcome.run.runId,
                workflowName: workflow.name,
                runDir: outcome.run.runDirAbs,
                approval: outcome.run.approvalDecision,
                restartedFrom: outcome.restartedFrom,
              });
            } catch {
              /* swallow */
            }
          }
          void wireRunDelivery(pi, outcome.run);
        } else {
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content: `restart blocked: ${outcome.reason.kind}`,
              display: true,
              details: { kind: "restart-blocked", runId, reason: outcome.reason },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `restart failed: ${msg}`,
            display: true,
            details: { kind: "restart-error", runId, error: msg },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    },

    onSaveScriptRequested: async (runId: string) => {
      const summary = getActiveRuns().getSummary(runId);
      if (summary === undefined || summary.runDir === undefined) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `save-script failed: no run summary for ${runId}`,
            display: true,
            details: { kind: "save-error", runId, reason: "missing-summary" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }
      const manifestAbs = join(summary.runDir, "manifest.json");
      let manifest: { workflowAbsPath?: string; workflowName?: string; cwd?: string } = {};
      try {
        manifest = JSON.parse(readFileSync(manifestAbs, "utf8"));
      } catch (err) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `save-script failed: cannot read manifest — ${(err as Error).message}`,
            display: true,
            details: { kind: "save-error", runId, reason: "missing-manifest" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }
      const workflowSourceAbsPath =
        manifest.workflowAbsPath ?? registry.get(summary.workflowName)?.absPath ?? "";
      // Non-blocking UI: collisions resolve by rename, git-add is
      // skipped. The overlay can't drive the multi-choice TUI prompt
      // synchronously — a manual `git add` after the save is fine.
      const ui: SaveScriptUI = {
        async prompt(_msg, choices) {
          if (choices.includes("rename")) return "rename";
          if (choices.includes("n")) return "n";
          // Fallback: pick the first choice (the documented default).
          return choices[0] ?? "";
        },
      };
      try {
        const outcome = await runSaveScript({
          runDirAbs: summary.runDir,
          workflowName: summary.workflowName,
          workflowSourceAbsPath,
          cwd: ctx.cwd,
          io: defaultSaveScriptIO,
          ui,
          notify: (msg, level) => ctx.ui.notify(msg, level ?? "info"),
        });
        const card = (content: string, details: Record<string, unknown>) => {
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content,
              display: true,
              details: { kind: "save-script", runId, ...details },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
        };
        switch (outcome.kind) {
          case "saved":
            card(`✓ saved to ${outcome.targetAbs}`, { outcome: outcome.kind, target: outcome.targetAbs });
            break;
          case "saved-renamed":
            card(`✓ saved (renamed) to ${outcome.targetAbs}`, { outcome: outcome.kind, target: outcome.targetAbs });
            break;
          case "no-op-already-in-project":
            card(`script already lives at ${outcome.targetAbs}`, { outcome: outcome.kind });
            break;
          case "cancelled-by-user":
            card(`save-script cancelled (${outcome.reason})`, { outcome: outcome.kind });
            break;
          case "error":
            card(`save-script error: ${outcome.message}`, { outcome: outcome.kind, reason: outcome.reason });
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `save-script failed: ${msg}`,
            display: true,
            details: { kind: "save-error", runId, error: msg },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    },

    onVisualizeRequested: async (runId: string): Promise<string | undefined> => {
      const summary = getActiveRuns().getSummary(runId);
      if (summary === undefined || summary.runDir === undefined) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `viz failed: no run summary for ${runId}`,
            display: true,
            details: { kind: "viz-error", runId, reason: "missing-summary" },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return undefined;
      }
      try {
        const target = await writeMermaidToTmp(summary.runDir);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `✓ DAG written to ${target}`,
            display: true,
            details: { kind: "viz", runId, target },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return target;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: `viz failed: ${msg}`,
            display: true,
            details: { kind: "viz-error", runId, error: msg },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return undefined;
      }
    },

    onOpenTranscript: (transcriptPath: string): string => {
      const r = openTranscriptInEditor({ transcriptPath });
      switch (r.kind) {
        case "opened-editor":
          return `opened ${r.editor} on ${transcriptPath}`;
        case "no-editor":
          return r.reason === "EDITOR-unset"
            ? `transcript: ${transcriptPath} (set $EDITOR to open)`
            : `transcript not found: ${transcriptPath}`;
        case "error":
          return `transcript open error: ${r.message}`;
      }
    },

    onCopyPrompt: (text: string): string => {
      const r = copyToClipboard({ text });
      if (r.kind === "copied") {
        return `copied to clipboard via ${r.tool} (${text.length} chars)`;
      }
      return `clipboard unavailable — ${r.reason.split(".")[0]}`;
    },
  };
}

