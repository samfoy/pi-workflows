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
 * Slice 2 carry-forward: helpers/constants live in
 * `workflowCmd.internal.ts`. Slice 13 will replace `/workflows` with
 * the TUI overlay; slice 11 adds resume/list/show/kill sub-commands.
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
 * Register the `/workflows` umbrella command. Slice 1 only handles the
 * empty-args case (list mode); any sub-command argument is treated as
 * "not implemented yet". Slice 11/13/15 take this over.
 */
export function registerWorkflowsCommand(
  pi: ExtensionAPI,
  registry: WorkflowRegistry,
  opts: { recursive?: boolean } = {},
): void {
  pi.registerCommand("workflows", {
    description: "List, resume, or inspect workflow runs (stub in slice 1)",
    handler: async (args, ctx) => {
      if (opts.recursive) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content: "workflows are disabled in nested pi sessions",
            display: true,
            details: { recursive: true, slice: 1 },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }

      const trimmed = args.trim();
      if (trimmed.length > 0) {
        pi.sendMessage(
          {
            customType: STUB_CUSTOM_TYPE,
            content:
              `subcommand "${trimmed}" not implemented in slice 1 — ` +
              "slices 11/13 land resume/list/gc/show/kill and the overlay",
            display: true,
            details: { subcommand: trimmed, slice: 1 },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        return;
      }

      const body = formatRegistryListing(registry);
      pi.sendMessage(
        {
          customType: STUB_CUSTOM_TYPE,
          content: body,
          display: true,
          details: {
            workflowCount: registry.size,
            slice: 1,
            note: "TUI overlay lands in slice 13",
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );

      // Surface the count via notify too — useful when running with
      // `--mode json` where `sendMessage` cards aren't user-visible.
      ctx.ui.notify(
        registry.size === 0
          ? "no workflows discovered"
          : `${registry.size} workflow(s) discovered`,
        "info",
      );
    },
  });
}
