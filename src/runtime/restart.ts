/**
 * pi-workflows — slice 14 restart helper.
 *
 * `r` hotkey on a terminal-state run mints a fresh runId, copies the
 * frozen `<oldRunDir>/script.js` into a new runDir, and dispatches the
 * workflow from scratch. Per PRD §10.4.1 the contract is:
 *
 *   - NEW `runId`. Old run dir is preserved untouched.
 *   - Cache is NOT replayed (a fresh runDir means a fresh cache.jsonl).
 *   - The new run's manifest carries `restartedFrom: <oldRunId>` for
 *     audit trail (slice 14 addition to RunManifest).
 *   - Approval is re-checked. The source sha256 hasn't changed so a
 *     prior `trusted` decision still holds; the gate short-circuits.
 *   - The user is responsible for cleanup of the old runDir; gc
 *     dialog (slice 15) is the canonical sweep.
 *
 * `paused` runs go through {@link Run.resumePaused} (NOT this helper);
 * `running` and `pending`/`approved` are no-ops at the hotkey layer.
 *
 * This module is the **glue** — it doesn't own the dispatch loop. It
 * delegates to a caller-supplied `start` callback (which is
 * `startWorkflowRun` in production; tests inject a stub).
 *
 * Refs: PRD §10.4.1, plan.md §4 Slice 14.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Run } from "../runManager.js";
import type {
  RunManagerStartOptions,
} from "../runManager.js";
import type {
  RunSummary,
  RunSummaryState,
} from "./activeRuns.js";
import { isTerminalState } from "./activeRuns.js";
import type { WorkflowFile } from "../types/internal.js";

export type RestartReason =
  | { readonly kind: "not-terminal"; readonly state: RunSummaryState }
  | { readonly kind: "missing-script"; readonly runDirAbs: string }
  | { readonly kind: "missing-summary" };

export type RestartOutcome =
  | { readonly kind: "started"; readonly run: Run; readonly newRunId: string; readonly restartedFrom: string }
  | { readonly kind: "blocked"; readonly reason: RestartReason };

export interface RestartOptions {
  /** Source run summary (with runId + runDir + workflowName). */
  readonly source: RunSummary;
  /**
   * The original input string. Slice 14 carries it forward verbatim;
   * resolved by the overlay from the source run's manifest.json prior
   * to invoking the helper.
   */
  readonly input: string;
  /**
   * The workflow file the user invoked. The restart helper does NOT
   * walk the registry — it consumes the WorkflowFile the caller resolved
   * (typically from `manifest.workflowAbsPath` for replay-stable
   * sourcing).
   */
  readonly workflow: WorkflowFile;
  /**
   * Callback that constructs and starts the run. Must accept
   * `restartedFrom`. Production callers pass `startWorkflowRun`.
   */
  readonly start: (
    workflow: WorkflowFile,
    args: string,
    opts: RunManagerStartOptions,
  ) => Promise<Run>;
  /** Pass-through start options (cwd, dispatch seam, mockAgents, ...). */
  readonly startOptions: RunManagerStartOptions;
  /** Hook invoked AFTER the new run starts so the overlay can refresh. */
  readonly onStarted?: (run: Run) => void;
}

/**
 * Restart a terminal-state run. Returns a {@link RestartOutcome} so the
 * overlay can render an appropriate banner.
 *
 * **Side effects**: reads the frozen script bytes from the old runDir;
 * does NOT mutate the old runDir; calls `start()` which produces a
 * fresh runDir. Errors during `start()` propagate.
 */
export async function restartTerminalRun(
  opts: RestartOptions,
): Promise<RestartOutcome> {
  if (!isTerminalState(opts.source.state)) {
    return { kind: "blocked", reason: { kind: "not-terminal", state: opts.source.state } };
  }
  if (opts.source.runDir === undefined) {
    return { kind: "blocked", reason: { kind: "missing-summary" } };
  }
  const scriptPath = join(opts.source.runDir, "script.js");
  try {
    await fs.access(scriptPath);
  } catch {
    return {
      kind: "blocked",
      reason: { kind: "missing-script", runDirAbs: opts.source.runDir },
    };
  }

  // Thread `restartedFrom` through start options. The runManager merges
  // this into manifest.json via `writeManifestPartial`.
  const mergedOptions: RunManagerStartOptions = {
    ...opts.startOptions,
    restartedFrom: opts.source.runId,
  };

  const run = await opts.start(opts.workflow, opts.input, mergedOptions);
  opts.onStarted?.(run);
  return {
    kind: "started",
    run,
    newRunId: run.runId,
    restartedFrom: opts.source.runId,
  };
}
