/**
 * src/testing.ts — high-level `runWorkflow()` testing API.
 *
 * Wraps `startWorkflowRun` + `LedgerReader` into a single async
 * call that workflow authors and test suites can use without
 * wiring up all the RunManager plumbing by hand.
 *
 * Import from the published package:
 *
 *   import { runWorkflow } from "@samfp/pi-workflows/testing";
 *
 * Or from source in tests:
 *
 *   import { runWorkflow } from "../../src/testing.js";
 *
 * Design goals:
 *   - Reduce ~30 lines of `startWorkflowRun` boilerplate to ~5 lines.
 *   - Always use `preApproved: true` (no interactive gate in tests).
 *   - Default to a tmp runDir that is cleaned up after the run unless
 *     `runsRootOverride` is supplied (enables cache-hit tests).
 *   - Extract phase/agent ledger data into a structured result so
 *     tests can assert on run shape without parsing raw JSONL.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { startWorkflowRun } from "./runManager.js";
import { LedgerReader } from "./runtime/ledger.js";
import { ledgerPath } from "./util/paths.js";
import type { WorkflowFile } from "./types/internal.js";

// ─── Public API ────────────────────────────────────────────────────────────

export interface RunWorkflowOptions {
  /** Absolute or relative path to the workflow .js file */
  workflowPath: string;
  /** Input string passed as the workflow's `input` argument */
  input?: string;
  /** When true, routes all ctx.phase dispatches to fixture replay */
  mockAgents?: boolean;
  /** Fixtures JSONL content (one fixture per line, agentId+promptHash+result) */
  seedFixturesJsonl?: string;
  /**
   * Override the runs root directory. When supplied the run directory
   * lives at `<runsRootOverride>/<runId>/` and is NOT cleaned up after
   * the run — use this for cache-hit tests that need the runDir to
   * persist across two calls.
   *
   * When omitted, a fresh OS tmpdir is used and cleaned up automatically.
   */
  runsRootOverride?: string;
  /** Override cwd passed to the workflow (default: process.cwd()) */
  cwd?: string;
  /** Max concurrent agents (default: 16) */
  maxConcurrent?: number;
  /** Token budget cap, or null for uncapped (default: null) */
  tokenBudget?: number | null;
}

export interface RunWorkflowResult {
  /** Run ID (e.g. "wf-abc123") */
  runId: string;
  /** Absolute path to the run directory */
  runDirAbs: string;
  /** Terminal status */
  status: "done" | "failed" | "stopped" | "cancelled-pre-run";
  /** The workflow's main() return value for status=done */
  output: unknown;
  /** Error info for status=failed/stopped */
  error: { name: string; message: string; stack?: string } | null;
  /** Phase names in order they were started, with agent counts */
  phases: Array<{ name: string; agentCount: number }>;
  /** Per-agent results read from the ledger */
  agentResults: Array<{ agentId: string; cached: boolean; durationMs: number }>;
  /** Total run duration in ms */
  durationMs: number;
}

/**
 * Run a workflow script end-to-end and return structured results.
 *
 * Always uses `preApproved: true` — no interactive approval gate.
 * For production use (with real approval), use `startWorkflowRun` directly.
 *
 * @example
 * ```ts
 * const result = await runWorkflow({
 *   workflowPath: "./examples/hello/hello.js",
 *   input: "Alice",
 *   mockAgents: true,
 *   seedFixturesJsonl: buildFixtures("Alice"),
 * });
 * assert.equal(result.status, "done");
 * assert.deepEqual(result.phases.map(p => p.name), ["greet"]);
 * ```
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const absWorkflowPath = resolvePath(opts.workflowPath);
  const workflowName = absWorkflowPath.replace(/\.js$/, "").split("/").pop() ?? "workflow";

  const workflow: WorkflowFile = {
    name: workflowName,
    absPath: absWorkflowPath,
    scope: "personal",
  };

  // Create a temp runDir if the caller hasn't provided one.
  const ownedTmpRoot = opts.runsRootOverride === undefined
    ? mkdtempSync(join(tmpdir(), "pi-wf-test-"))
    : undefined;
  const runsRoot = opts.runsRootOverride ?? ownedTmpRoot!;

  const resolveRunDir = (runId: string) => {
    const d = join(runsRoot, runId);
    // mkdirSync is handled by startWorkflowRun; no need to pre-create.
    return d;
  };

  try {
    const startMs = Date.now();
    const run = await startWorkflowRun(workflow, opts.input ?? "", {
      preApproved: true,
      mockAgents: opts.mockAgents === true,
      ...(opts.seedFixturesJsonl !== undefined ? { seedFixturesJsonl: opts.seedFixturesJsonl } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      resolveRunDir,
    });

    const terminalInfo = await run.terminated;
    const durationMs = Date.now() - startMs;

    // Read the ledger to extract phase and agent data.
    const ledgerReader = new LedgerReader({
      runId: run.runId,
      resolveLedgerPath: (id) => ledgerPath(join(runsRoot, id), true),
    });
    const { entries } = await ledgerReader.read();

    // Extract phases in start order.
    const phases: RunWorkflowResult["phases"] = [];
    for (const entry of entries) {
      if (entry.type === "phase_start") {
        phases.push({ name: entry.phaseName, agentCount: entry.agentCount });
      }
    }

    // Extract per-agent end results.
    const agentResults: RunWorkflowResult["agentResults"] = [];
    for (const entry of entries) {
      if (entry.type === "agent_end") {
        agentResults.push({
          agentId: entry.agentId,
          cached: entry.cached,
          durationMs: entry.durationMs,
        });
      } else if (entry.type === "agent_cache_hit") {
        // Cache hits before any agent_end — mark as cached with 0ms.
        // (agent_end with cached:true is also emitted for full cache hits,
        //  so this handles both code paths defensively.)
        const alreadyRecorded = agentResults.some(r => r.agentId === entry.agentId);
        if (!alreadyRecorded) {
          agentResults.push({ agentId: entry.agentId, cached: true, durationMs: 0 });
        }
      }
    }

    // Map RunOutcome → RunWorkflowResult.status.
    const outcome = terminalInfo.outcome;
    const status: RunWorkflowResult["status"] =
      outcome === "done" ? "done"
      : outcome === "failed" ? "failed"
      : outcome === "stopped" ? "stopped"
      : "cancelled-pre-run";

    return {
      runId: run.runId,
      runDirAbs: run.runDirAbs,
      status,
      output: terminalInfo.result ?? null,
      error: terminalInfo.error ?? null,
      phases,
      agentResults,
      durationMs,
    };
  } finally {
    // Clean up only if we created the tmpdir (not when caller owns it).
    if (ownedTmpRoot !== undefined) {
      try {
        rmSync(ownedTmpRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — never throw from finally.
      }
    }
  }
}

// ─── Convenience re-export ───────────────────────────────────────────────────

/**
 * sha256 of a prompt string — the same function the dispatcher uses to
 * compute `promptHash`. Re-exported here so fixture builders can import
 * both `runWorkflow` and `sha256` from the same module.
 *
 * @example
 * ```ts
 * import { runWorkflow, sha256 } from "@samfp/pi-workflows/testing";
 * const fixtures = JSON.stringify({ agentId: "main", promptHash: sha256(prompt), result: { text: "ok" } });
 * ```
 */
export { sha256 } from "./util/hash.js";
