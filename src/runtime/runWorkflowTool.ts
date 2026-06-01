/**
 * pi-workflows — `run_workflow` LLM tool.
 *
 * Companion to `write_workflow`. Where `write_workflow` saves and registers
 * a new workflow script, `run_workflow` invokes one that already exists in
 * the registry — same code path the `/<name>` slash-command takes, just
 * driven by the model instead of a keystroke.
 *
 * The model needs this when:
 *   - The user asks to run a named workflow (e.g. "run audit-and-improve").
 *   - A multi-step plan reaches a phase that should hand off to a workflow.
 *   - A previous tool call recommended a workflow and the user agreed.
 *
 * Without this tool the model can list workflows (via /workflows or by
 * shelling out to ls .pi/workflows/) but it cannot trigger one — only the
 * user can, by typing `/<name>`. That gap is what this fixes.
 *
 * Flow:
 *   1. Validate the requested workflow exists in the registry.
 *   2. Strip an optional leading "/" from the name (the model is likely to
 *      paste it as the user would have typed it).
 *   3. Call `startRun(workflow, input, ctx)` — the same callback wired by
 *      `index.ts` for `write_workflow`'s runNow path. It calls
 *      `startWorkflowRun(...)` with `preApproved: true` and wires the
 *      result-delivery pipeline so the run lands as a chat card when it
 *      finishes.
 *   4. Return a tool result card with the run-started status and a pointer
 *      to `/workflows` for monitoring. On lookup miss we return the list
 *      of available workflows so the model can correct the name on retry.
 *
 * NOTE: this tool does NOT do its own approval prompt. The user is implicitly
 * authorising the run by phrasing the request that caused the model to call
 * the tool, and the run itself goes through `startWorkflowRun` with the same
 * `preApproved: true` posture `write_workflow`'s runNow path uses (see
 * `index.ts`). If you want a hard gate, replace `preApproved` in the wired
 * `startRun` callback with a real `approval` block built from `ctx`.
 */

import { Type } from "typebox";

import type { ExtensionAPI, WorkflowFile } from "../types/internal.js";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RunWorkflowToolOpts {
  readonly pi: ExtensionAPI;
  /** Live workflow registry (by reference). Required — no registry, no run. */
  getRegistry: () => Map<string, WorkflowFile>;
  /**
   * Start a workflow run. Same callback `write_workflow`'s runNow path uses,
   * so behaviour is identical: `startWorkflowRun(workflow, input, { cwd,
   * preApproved: true, activeRuns, enableGlobalCache: true })` followed by
   * `wireRunDelivery(pi, run)` to push the chat card on completion.
   */
  startRun: (
    workflow: WorkflowFile,
    input: string,
    ctx: unknown,
  ) => Promise<void>;
}

/** Strip a leading "/" so `/audit-and-improve` and `audit-and-improve` both work. */
export function normaliseWorkflowName(raw: string): string {
  return raw.trim().replace(/^\/+/, "");
}

/** Format a registry listing for the lookup-miss error path. */
export function formatRegistryHint(
  registry: Map<string, WorkflowFile>,
): string {
  if (registry.size === 0) {
    return "No workflows registered. Drop a `.js` file in `.pi/workflows/` or `~/.pi/agent/workflows/`, or use `write_workflow` to create one.";
  }
  const sorted = [...registry.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const lines = sorted.map((f) => `  /${f.name} (${f.scope})`);
  return `Available workflows:\n${lines.join("\n")}`;
}

/** Register the `run_workflow` tool on the given pi instance. */
export function registerRunWorkflowTool(opts: RunWorkflowToolOpts): void {
  if (typeof opts.pi.registerTool !== "function") {
    // Older pi build without registerTool — degrade gracefully, matching
    // `registerWriteWorkflowTool`.
    return;
  }

  opts.pi.registerTool({
    name: "run_workflow",
    label: "Run workflow",
    description:
      "Trigger an existing pi-workflows script by name. " +
      "Use this when the user asks you to run a named workflow (e.g. " +
      "'run audit-and-improve', 'kick off /codebase-audit src/auth') " +
      "instead of authoring a new one with write_workflow. " +
      "The run lands in `/workflows` and the result is delivered as a chat " +
      "card when it completes.",

    promptGuidelines: [
      "Call run_workflow when the user asks to run, kick off, invoke, or trigger an existing workflow by name.",
      "Strip the leading slash if present — pass `audit-and-improve`, not `/audit-and-improve` (the tool tolerates either).",
      "If you don't know whether a workflow exists, list `.pi/workflows/` and `~/.pi/agent/workflows/` first, or call run_workflow with the name you have and let the lookup-miss listing tell you what's available.",
      "Pass the slash-command argument as `input` (e.g. for `/codebase-audit src/auth`, name=\"codebase-audit\", input=\"src/auth\").",
      "After run_workflow returns successfully, tell the user the run started and direct them to `/workflows` (or the `w` overlay) to monitor progress. Do NOT poll — the result card lands in chat automatically when the run finishes.",
      "Prefer run_workflow over write_workflow when the workflow already exists. Don't re-author an existing workflow just because you'd write it slightly differently.",
    ],

    parameters: Type.Object({
      name: Type.String({
        description:
          "Workflow name (the slug used as the slash command). " +
          "Leading '/' is allowed but optional. Examples: 'audit-and-improve', '/codebase-audit'.",
      }),
      input: Type.Optional(
        Type.String({
          description:
            "Optional argument string passed to the workflow as `ctx.input`. " +
            "Same shape as the text after the slash command (e.g. for " +
            "`/codebase-audit src/auth`, input is 'src/auth'). " +
            "Defaults to empty string when omitted.",
        }),
      ),
    }),

    async execute(_id, params, ctx) {
      const { name: rawName, input } = params as {
        name: string;
        input?: string;
      };
      const name = normaliseWorkflowName(rawName);
      const argInput = typeof input === "string" ? input : "";

      // 1. Lookup
      const registry = opts.getRegistry();
      const workflow = registry.get(name);
      if (!workflow) {
        const hint = formatRegistryHint(registry);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `❌ Workflow \`${name}\` not found.\n\n${hint}`,
            },
          ],
          details: {
            error: "workflow-not-found",
            requested: name,
            available: [...registry.keys()].sort(),
          },
        };
      }

      // 2. Start the run
      try {
        await opts.startRun(workflow, argInput, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⚠ Failed to start \`/${workflow.name}\`: ${msg}\n\n` +
                `The workflow exists but the runtime refused to start it. ` +
                `Common causes: pending approval dialog, recursive nested session, ` +
                `or a hot-reload mid-write. Re-try in a moment, or invoke ` +
                `\`/${workflow.name}\` directly from the prompt.`,
            },
          ],
          details: {
            error: "start-failed",
            name: workflow.name,
            absPath: workflow.absPath,
            scope: workflow.scope,
            message: msg,
          },
        };
      }

      // 3. Success card. Note: the run is fire-and-forget. The result card
      // (success or error) is delivered later by `wireRunDelivery` inside
      // the `startRun` callback.
      const argLine = argInput ? ` with input \`${argInput}\`` : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `▶ Workflow \`/${workflow.name}\` started${argLine}.\n\n` +
              `**Source:** \`${workflow.absPath}\`\n` +
              `**Scope:** ${workflow.scope}\n\n` +
              `Open \`/workflows\` to monitor progress, or press \`w\` ` +
              `to inspect the live overlay. The result will be delivered ` +
              `as a chat card when the run finishes.`,
          },
        ],
        details: {
          name: workflow.name,
          absPath: workflow.absPath,
          scope: workflow.scope,
          input: argInput,
          runStarted: true,
        },
      };
    },
  });
}
