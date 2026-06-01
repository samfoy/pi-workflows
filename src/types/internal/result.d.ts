/**
 * src/types/internal/result.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the result slice is needed.
 */

import type { ApprovalDecision } from "./approval.js";

// ───────────────────────────────────────────────────────────────────────
// Slice 10 — Result delivery
// ───────────────────────────────────────────────────────────────────────

/**
 * The four user-visible terminal outcomes a run can settle into. Maps
 * one-to-one to the four outcome cards (PRD §3.8 + slice-10 plan):
 *
 *   - `done`               → ✅ resolved with a value
 *   - `failed`             → ❌ rejected (error before / during main())
 *   - `stopped`            → ⏹ user-initiated cancel of a running run
 *   - `cancelled-pre-run`  → ⊘ approval gate denied / disabled
 *
 * Resume + crash sweep land in slice 11; their terminal classification
 * (`failed: parent-crash`) collapses into `failed` for the card.
 */
export type RunOutcome = "done" | "failed" | "stopped" | "cancelled-pre-run";

/**
 * Persisted summary of a finished run. Written atomically (tmp+rename)
 * to `<runDir>/result.json` after `main()` settles. Slice 11's resume
 * skips runs whose `result.json` already exists — they're terminal.
 */
export interface RunResultFile {
  readonly runId: string;
  readonly workflowName: string;
  readonly outcome: RunOutcome;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /**
   * The user-visible result. For `outcome=done`:
   *   - String → stored verbatim.
   *   - Other JSON value → JSON.stringify result.
   *   - undefined → null.
   * For non-`done` outcomes: null.
   */
  readonly result: string | null;
  /** Set on `failed` / `cancelled-pre-run`. */
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string } | null;
  /** Slice 9 approval audit trail. */
  readonly approval: ApprovalDecision | null;
  /** Total agents `ctx.phase` dispatched (cache hits + misses). */
  readonly agentCount: number;
  /** Optional `ctx.finishCallback(prompt)` queued by main(). */
  readonly finishCallbackPrompt: string | null;
}

/**
 * Inputs the result-card builder needs. Pure function — no I/O, no
 * Date.now() (caller supplies durationMs + endedAt). Lets unit tests
 * assert exact output strings.
 */
export interface ResultCardInputs {
  readonly outcome: RunOutcome;
  readonly workflowName: string;
  readonly runId: string;
  readonly runDirAbs: string;
  readonly durationMs: number;
  readonly agentCount: number;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly approval: ApprovalDecision | null;
}

export interface ResultCardOutput {
  readonly customType: string;
  readonly content: string;
  readonly details: Readonly<{
    workflowName: string;
    runId: string;
    runDir: string;
    outcome: RunOutcome;
    durationMs: number;
    agentCount: number;
    approval: ApprovalDecision | null;
    error?: { name: string; message: string };
    truncated: boolean;
  }>;
}

/**
 * Slice 10 result-delivery custom-type identifier. Stable across
 * versions (the TUI overlay in slice 13 filters on this prefix).
 *
 * NOTE: value-form runtime constants live in `runtime/resultDelivery.ts`
 * (this file is `.d.ts` and cannot host runtime exports). Importers
 * should reference them from there; the names below are kept as
 * type-level documentation only.
 */
// export const RESULT_CUSTOM_TYPE = "pi-workflows.result"; // see resultDelivery.ts
// export const RUN_STARTED_ENTRY = "pi-workflows.run.started"; // see resultDelivery.ts
// export const RUN_ENDED_ENTRY = "pi-workflows.run.ended"; // see resultDelivery.ts

/**
 * IPC control command written by a supervisor to `<runDir>/ctrl.jsonl`.
 * The run's ctrl-file watcher dispatches these to `run.pause()`,
 * `run.resumePaused()`, or `run.stop()`.
 */
export interface CtrlCommand {
  readonly type: "pause" | "resume" | "stop" | "resume-interrupt";
  /** ISO-8601 timestamp set by the sender — informational only. */
  readonly at?: string;
  /** Optional free-text reason forwarded to the Run method. */
  readonly reason?: string;
  /**
   * ZONE_HITL — payload for `resume-interrupt`. The JSON-cloneable
   * value to deliver to a pending `ctx.interrupt(...)` call. Ignored
   * for `pause`/`resume`/`stop`.
   */
  readonly value?: unknown;
  /**
   * ZONE_HITL — optional key for `resume-interrupt`. When omitted the
   * oldest pending interrupt is resolved (FIFO). When set the matching
   * `key` is targeted; mismatches are silently dropped.
   */
  readonly key?: string;
}

