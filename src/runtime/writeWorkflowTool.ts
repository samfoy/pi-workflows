/**
 * pi-workflows — `write_workflow` LLM tool.
 *
 * When the user asks to "create a workflow", "fan-out", "run multiple agents
 * in parallel", or anything that benefits from coordinated multi-agent
 * execution, the LLM calls this tool to save and register the script.
 *
 * Flow:
 *   1. Validate the script has `export const meta = { name, ... }` as its
 *      first meaningful statement.
 *   2. Derive the save path: `<cwd>/.pi/workflows/<name>.js`.
 *   3. Write the file (collision guard: warn but overwrite on explicit call).
 *   4. Ensure parent dir exists; optionally update .gitignore.
 *   5. Emit a `pi-workflows.workflow-saved` appendEntry so the dashboard
 *      plugin can update the workflows panel immediately.
 *   6. Return a tool result card with "Run now?" guidance so the LLM offers
 *      to invoke `/name` immediately.
 *
 * Hot-reload (slice 16) fires automatically via chokidar when the file is
 * written — no explicit re-registration needed here.
 *
 * Refs: plan.md v2 slice (write_workflow tool), PRD §3.1, §3.2, §4.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContextLike, WorkflowFile } from "../types/internal.js";
import { workflowsHome } from "../util/paths.js";
import { RESERVED_NAMES, classifyFilename } from "../registry.js";

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Returns true only when `export const meta` is the FIRST meaningful token
 * sequence — after stripping leading whitespace and any number of leading
 * single-line (`//`) or block (`/* … *\/`) comments.
 *
 * This correctly rejects scripts that start with an `import` or `function`
 * declaration before the meta export, which the old multiline-flag regex
 * accepted because `^` matched any line start.
 */
export function hasMetaFirst(script: string): boolean {
  // Strip leading whitespace
  let s = script.replace(/^\s*/, '');
  // Strip zero-or-more leading comments (single-line or block)
  s = s.replace(/^(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/,'').trim();
  return s.startsWith('export const meta');
}

export type ValidateResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validate that:
 * 1. Script is non-empty.
 * 2. `export const meta = { ... }` is the FIRST meaningful statement.
 * 3. The `name` field is present, is a plain string literal, and is not reserved.
 *
 * We don't do deep AST validation (that's v3). The strip-then-check pattern
 * is good enough to catch the common mistakes and correctly rejects any
 * non-comment statement before meta (import, function, class, etc.).
 */
export function validateWorkflowScript(
  script: string,
  reservedNames: ReadonlySet<string> = RESERVED_NAMES,
): { ok: true; name: string } | { ok: false; error: string } {
  if (!script || script.trim().length === 0) {
    return { ok: false, error: "Script is empty." };
  }

  if (!hasMetaFirst(script)) {
    return {
      ok: false,
      error:
        'Script must start with `export const meta = { name, description, version };` ' +
        '(only leading comments allowed before it). ' +
        'This is the first statement pi-workflows reads to register the slash command.',
    };
  }

  // Extract the `name` value from `meta = { name: "...", ... }`.
  // Simple string-literal extraction — avoids pulling in acorn for v1.
  const nameMatch = script.match(/export\s+const\s+meta\s*=\s*\{[^}]*name\s*:\s*["']([^"']+)["']/);
  if (!nameMatch) {
    return {
      ok: false,
      error:
        'Could not extract `name` from `export const meta = { name: "...", ... }`. ' +
        'Ensure `name` is a plain string literal (not a variable or computed value).',
    };
  }

  const name = nameMatch[1]!;

  // Reuse the same classifier the registry uses.
  const classified = classifyFilename(`${name}.js`, reservedNames);
  if ("reason" in classified) {
    return { ok: false, error: `Invalid workflow name "${name}": ${classified.message}` };
  }

  return { ok: true, name };
}

// ─── .gitignore helper ───────────────────────────────────────────────────────

function ensureGitignoreEntry(cwd: string, relativePath: string): void {
  // Silently skip if not in a git repo.
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const existing = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, "utf-8")
      : "";
    // Only add a comment block once.
    if (existing.includes("pi-workflows")) return;
    const addition =
      "\n# pi-workflows — project workflow scripts (commit if you want to share them)\n" +
      `# ${relativePath}\n`;
    writeFileSync(gitignorePath, existing + addition, "utf-8");
  } catch {
    // Best-effort — not worth surfacing to the user.
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface WriteWorkflowToolOpts {
  readonly pi: ExtensionAPI;
  /** Resolved working directory (from session ctx.cwd). */
  getCwd: () => string;
  /** Override save directory (for tests). */
  saveDirOverride?: string;
  /**
   * Live workflow registry (by reference). When provided, the `runNow`
   * flow can look up the freshly-saved WorkflowFile without waiting for
   * the next hot-reload tick.
   */
  getRegistry?: () => Map<string, WorkflowFile>;
  /**
   * Start a workflow run. When provided, `runNow: true` triggers execution
   * immediately after saving (going through the normal approval flow).
   * Receives the tool execute-ctx so the approval dialog can bind to
   * `ctx.ui.confirm`.
   */
  startRun?: (
    workflow: WorkflowFile,
    input: string,
    ctx: unknown,
  ) => Promise<void>;
}

/** Register the `write_workflow` tool on the given pi instance. */
export function registerWriteWorkflowTool(opts: WriteWorkflowToolOpts): void {
  if (typeof opts.pi.registerTool !== "function") {
    // Older pi build without registerTool — degrade gracefully.
    return;
  }

  opts.pi.registerTool({
    name: "write_workflow",
    label: "Write workflow",
    description:
      "Create a new pi-workflows script and register it as a slash command. " +
      "Use this when the user wants to: run multiple agents in parallel, fan-out analysis " +
      "across many files, build a multi-step pipeline, or do anything that benefits from " +
      "concurrent agent coordination. " +
      "After saving, offer to run the workflow immediately with `/name`.",

    promptGuidelines: [
      "Call write_workflow when the user asks for a workflow, multi-agent task, fan-out, " +
        "parallel research, codebase audit, or anything benefiting from concurrent agents.",
      "Always include `export const meta = { name, description, version }` as the FIRST " +
        "statement — pi-workflows reads it to register the slash command.",
      "Workflows run in a sandboxed vm.Context — no direct fs/child_process/network. " +
        "Use ctx.agent(prompt) to tell a pi sub-agent (which HAS full tool access) to do file/shell work.",
      "`ctx.agent(prompt, opts?)` is SYNCHRONOUS — it builds a handle, does NOT spawn anything. " +
        "Use `ctx.phase(name, handles[])` to actually run handles in parallel. " +
        "AgentResult has `.text` (string), `.output?` (parsed object — only set when opts.schema was provided), `.usage`, `.durationMs`, `.cached`.",
      "Default agent timeout is 600s — always pass `{ timeoutMs: 20 * 60 * 1000 }` (or more) for agents that read files or make edits. " +
        "For large phases (>10 agents), also pass `{ failMode: 'null' }` to ctx.phase() so timeouts don't discard all results.",
      "`ctx.parallel(items, fn)` maps items to handles and runs them in one phase — shorthand for ctx.phase + map.",
      "`ctx.pipeline(items, ...stages)` runs sequential stages per item, concurrently across items.",
      "ALL variables must be declared inside `export default async function (ctx)` — " +
        "module-level `const`/`let` outside the function throw ReferenceError at runtime.",
      "Never inline file contents in prompts — tell agents to read files with their own tools. " +
        "Large inline content causes context crashes.",
      "Phase fails with AggregateError if any agent fails. " +
        "Pass `{ failMode: 'null' }` as third arg to ctx.phase() for resilient flows that survive partial failures.",
      "Return a string, object, or array from the function — it becomes the workflow result " +
        "shown in the dashboard and in the chat card.",
      "After calling write_workflow, tell the user the workflow was saved and is registered as a slash command. Direct them to /workflows to launch and monitor it.",
    ],

    promptSnippet: `
// ctx.agent() builds a handle (sync, no spawn). ctx.phase() runs handles in parallel.
// AgentResult: { text, output?, usage, durationMs, cached } — use .text for prose, .output for schema results
export const meta = {
  name: "my-workflow",
  description: "What this workflow does",
  version: "1.0.0",
  // whenToUse: "Use when you need to fan-out work across many files or topics",
  // phases: [{ title: "Recon" }, { title: "Analyze" }, { title: "Report" }],
};

export default async function (ctx) {
  // ALL variables must be declared inside this function.
  // Agents must read files themselves — never inline file content in prompts.

  // Parallel agents → results[i].text
  const [a, b] = await ctx.phase("analyze", [
    ctx.agent("Analyze area A", { id: "a" }),
    ctx.agent("Analyze area B", { id: "b" }),
  ]);

  // opts.schema: agent returns parsed JS object in result.output
  const [typed] = await ctx.phase("extract", [
    ctx.agent("List issues in src/", {
      id: "extractor",
      schema: { type: "object", properties: { issues: { type: "array", items: { type: "string" } } }, required: ["issues"] },
    }),
  ]);
  const issues = (typed.output as { issues: string[] }).issues;

  // ctx.parallel(items, fn) — map items to handles in one phase
  const perFile = await ctx.parallel(
    ["src/auth.ts", "src/db.ts"],
    (file) => ctx.agent(\`Audit \${file} — read it with your tools\`, { id: file }),
  );

  // ctx.pipeline(items, ...stages) — sequential stages, concurrent across items
  const results = await ctx.pipeline(
    ["src/a.ts", "src/b.ts"],
    (file) => ctx.agent(\`Read \${file}\`, { id: \`read-\${file}\` }),
    (readResult, file) => ctx.agent(\`Fix \${file} given: \${readResult.text}\`, { id: \`fix-\${file}\` }),
  );

  // failMode: 'null' — continue when some agents fail
  const resilient = await ctx.phase("risky", [
    ctx.agent("Might fail", { id: "risky" }),
  ], { failMode: "null" });
  const succeeded = resilient.filter(r => r !== null);

  // budget — check spend before expensive phases
  ctx.log(\`tokens spent: \${ctx.budget.spent()}\`);

  return { issues, perFile: perFile.map(r => r.text), succeeded: succeeded.length };
}
`.trim(),

    parameters: {
      type: "object",
      required: ["name", "script"],
      properties: {
        name: {
          type: "string",
          description:
            "Workflow name (used as the slash command: /name). " +
            "Must be lowercase letters, digits, and hyphens only.",
        },
        script: {
          type: "string",
          description:
            "The complete workflow script. Must start with " +
            "`export const meta = { name, description, version };`.",
        },
      },
    },

    async execute(_id, params, ctx) {
      const { name: paramName, script } = params as { name: string; script: string };

      // 1. Validate
      const validation = validateWorkflowScript(script);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ Workflow validation failed:\n\n${validation.error}` }],
          details: { error: validation.error },
        };
      }

      const { name } = validation;

      // Name in meta must match the `name` param (best-effort — only warn).
      if (name !== paramName && paramName) {
        // Use meta's name as authoritative.
      }

      // 2. Resolve save path
      const cwd = opts.getCwd();
      // Bug-fix: do NOT walk parent dirs. projectWorkflowsDir() finds the
      // user's ~/.pi/ and saves outside the watched directories. Instead:
      // - if <cwd>/.pi/workflows/ already exists → project scope (user set it up)
      // - otherwise → personal scope workflowsHome() which is always watched
      const projectScopeDir = join(cwd, ".pi", "workflows");
      const saveDir = opts.saveDirOverride ?? (
        existsSync(projectScopeDir) ? projectScopeDir : workflowsHome()
      );
      mkdirSync(saveDir, { recursive: true });

      const savePath = join(saveDir, `${name}.js`);
      const isOverwrite = existsSync(savePath);

      // 3. Write file
      writeFileSync(savePath, script, "utf-8");

      // 4. .gitignore note (non-blocking)
      ensureGitignoreEntry(cwd, `.pi/workflows/${name}.js`);

      // 5. Emit appendEntry so dashboard can track
      if (typeof opts.pi.appendEntry === "function") {
        opts.pi.appendEntry("pi-workflows.workflow-saved", {
          name,
          path: savePath,
          isOverwrite,
          savedAt: new Date().toISOString(),
        });
      }

      // 6. Offer to run (or run immediately if runNow === true)
      let runStarted = false;
      let runError: string | undefined;
      const workflowFile: WorkflowFile =
        opts.getRegistry?.().get(name) ??
        { name, absPath: savePath, scope: existsSync(projectScopeDir) ? "project" : "personal" };

      // Always run when startRun is wired — don't let the LLM opt out
      // via a runNow parameter. The approval TUI modal is the consent gate.
      const shouldRun = !!opts.startRun;
      if (shouldRun && opts.startRun) {
        try {
          await opts.startRun(workflowFile, "", ctx);
          runStarted = true;
        } catch (err) {
          runError = err instanceof Error ? err.message : String(err);
        }
      }

      // 7. Return result card
      const verb = isOverwrite ? "updated" : "saved";
      // Bug-fix: never say "run it with /name" — the LLM will try bash.
      const runLine = runStarted
        ? `\n\n▶ Run started — open \`/workflows\` to monitor progress.`
        : runError
        ? `\n\n⚠ Saved but run failed to start: ${runError}`
        : `\n\nIt's now registered. Open \`/workflows\` to launch and monitor it.`;
      const resultText =
        `✅ Workflow \`/${name}\` ${verb}.\n\n` +
        `**Path:** \`${savePath}\`` +
        runLine;

      return {
        content: [{ type: "text" as const, text: resultText }],
        details: {
          name,
          path: savePath,
          isOverwrite,
          savedAt: new Date().toISOString(),
          runCommand: `/${name}`,
          runStarted,
          ...(runError ? { runError } : {}),
        },
      };
    },
  });
}
