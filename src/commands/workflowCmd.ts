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
import { deliverRunResult, RUN_STARTED_ENTRY } from "../runtime/resultDelivery.js";
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
          run.promise.catch(() => undefined); // suppress unhandled
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
              /* never let delivery crash the session */
            }
          });
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
  opts: { recursive?: boolean } = {},
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
        // Default: list discovered workflows.
        const body = formatRegistryListing(registry);
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: body,
            display: true,
            details: {
              workflowCount: registry.size,
              slice: 11,
              note: "TUI overlay lands in slice 13; sub-commands: list, show, resume, gc, kill",
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
          default:
            pi.sendMessage(
              {
                customType: STUB_CUSTOM_TYPE,
                content:
                  `unknown sub-command "${sub}".\n\n` +
                  "Available: (no args | list | show <id> | resume <id> [--latest] | gc [--apply] | kill <id>)",
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
        details: { subcommand: "kill", slice: 11 },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    return;
  }
  // Slice 11 stub: emit a kill request via appendEntry. Slice 13's
  // active-runs registry will subscribe to this and abort the matching
  // in-process Run handle.
  if (typeof pi.appendEntry === "function") {
    try {
      pi.appendEntry("pi-workflows.run.kill-requested", { runId });
    } catch {
      /* swallow */
    }
  }
  pi.sendMessage(
    {
      customType: STUB_CUSTOM_TYPE,
      content:
        `kill request emitted for runId=${runId}.\n` +
        "Note: in-process kill wiring lands with the slice-13 active-runs registry. " +
        "For now, the request is recorded via pi.appendEntry.",
      display: true,
      details: { subcommand: "kill", runId, slice: 11 },
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
}

