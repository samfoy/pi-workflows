/**
 * pi-workflows — slash-command registration (slice 1 stubs).
 *
 * Slice 1 registers two kinds of slash commands:
 *
 *   1. `/<workflowName>` for every discovered workflow file. Handler is
 *      a stub — emits a `pi.sendMessage` card explaining that the
 *      runtime is not yet wired. Slice 10 replaces the stub handler
 *      with the real fire-and-forget run trigger.
 *
 *   2. `/workflows` — the umbrella command. Slice 1 ships only the
 *      "list discovered workflows" path, which prints names + sources
 *      to the conversation. Slice 13 replaces this with the TUI
 *      overlay; slice 11 adds `resume`/`gc`/`list`/`show`/`kill`
 *      sub-commands. The slice-1 stub explicitly tells the user the
 *      overlay isn't available yet.
 *
 * The recursion-ban check (PRD §13.7) lives in `index.ts` — when
 * `PI_WORKFLOWS_RECURSIVE=1` is set we skip calling
 * `registerWorkflowCommands` for the per-workflow `/<name>` commands.
 * `/workflows` itself is still registered in nested sessions, and it
 * always errors with the documented message.
 *
 * Slice 2 carry-forward: helpers/constants previously exported via
 * `__testInternals` were moved to `workflowCmd.internal.ts`. See that
 * file's header for the convention.
 */

import type {
  ExtensionAPI,
  WorkflowFile,
  WorkflowRegistry,
} from "../types/internal.js";
import {
  STUB_CUSTOM_TYPE,
  formatRegistryListing,
  stubDescription,
  stubMessage,
} from "./workflowCmd.internal.js";
import { startWorkflowRun } from "../runManager.js";

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
      handler: async (args) => {
        // Slice 8a: actually start the run via RunManager. Approval
        // dialog is slice 9 — here we bypass with `preApproved: true`
        // and emit a notify so users see what's happening.
        try {
          const run = await startWorkflowRun(file, args, {
            preApproved: true,
          });
          pi.sendMessage(
            {
              customType: STUB_CUSTOM_TYPE,
              content:
                `started workflow "${file.name}" (runId=${run.runId})\n\n` +
                "Approval flow is slice-9 pending; this run was bypassed. " +
                "TUI overlay is slice-13 pending; tail " +
                `${run.runDirAbs}/ledger.jsonl manually for now.`,
              display: true,
              details: {
                workflowName: file.name,
                runId: run.runId,
                runDir: run.runDirAbs,
                approvalBypassed: true,
                slice: "8a",
              },
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          );
          // Fire-and-forget the run; result delivery is slice 10.
          run.promise.catch((err: unknown) => {
            // Surface failures via notify so users aren't left wondering.
            // Best-effort — don't throw out of an unhandled rejection.
            try {
              const msg =
                err instanceof Error ? err.message : String(err);
              pi.sendMessage(
                {
                  customType: STUB_CUSTOM_TYPE,
                  content: `workflow "${file.name}" (${run.runId}) failed: ${msg}`,
                  display: true,
                  details: { workflowName: file.name, runId: run.runId },
                },
                { triggerTurn: false, deliverAs: "nextTurn" },
              );
            } catch {
              // ignore
            }
          });
        } catch (err) {
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
                slice: "8a",
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
