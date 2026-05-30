/**
 * pi-workflows — slice 10 result delivery.
 *
 * After a workflow run settles (state transitions to `done` / `failed`
 * / `stopped` / `cancelled-pre-run`), this module:
 *
 *   1. Atomically writes `<runDir>/result.json` with the persisted
 *      `RunResultFile` summary.
 *   2. Renders a result card via `pi.sendMessage` using the
 *      `pi-workflows.result` customType so slice-13's overlay can
 *      filter on it.
 *   3. Emits the `pi-workflows.run.ended` active-runs index entry via
 *      `pi.appendEntry`.
 *   4. If the workflow recorded a `ctx.finishCallback(prompt)`, fires
 *      `pi.sendUserMessage(prompt)` so the LLM continues the
 *      conversation (PRD §3.9). Falls back to a plain `sendMessage`
 *      annotation if the host pi build doesn't expose
 *      `sendUserMessage`.
 *
 * Card content varies by outcome (PRD §3.8):
 *
 *   ✅ done              — duration, agent count, result preview
 *   ❌ failed            — error class + message + run dir + re-run
 *   ⏹  stopped           — partial results in run dir
 *   ⊘ cancelled-pre-run  — denial reason + run dir
 *
 * Every card carries `details.approval.reason` so the slice-13 overlay
 * (and `--mode json` consumers) can audit how the run was approved.
 *
 * Pure card-builder logic lives in `buildResultCard`; the orchestration
 * (write file, fire pi calls) lives in `deliverRunResult`. Splitting
 * keeps the unit tests free of a `FakePi` / fs setup.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type {
  ApprovalDecision,
  ExtensionAPI,
  ResultCardInputs,
  ResultCardOutput,
  RunOutcome,
  RunResultFile,
} from "../types/internal.js";

/**
 * Slice 10 result-delivery custom-type identifier. Stable across
 * versions (the TUI overlay in slice 13 filters on this prefix).
 */
export const RESULT_CUSTOM_TYPE = "pi-workflows.result";

/**
 * Slice 10 active-runs index event names (PRD §6.6). Emitted via
 * `pi.appendEntry(name, payload)`. The TUI overlay in slice 13
 * subscribes to these for the runs list.
 */
export const RUN_STARTED_ENTRY = "pi-workflows.run.started";
export const RUN_ENDED_ENTRY = "pi-workflows.run.ended";

/** Max bytes of the user-visible result rendered into the card. PRD §3.8. */
export const RESULT_PREVIEW_MAX_CHARS = 400;
/** Max chars of the error.message rendered into the card body. */
export const ERROR_PREVIEW_MAX_CHARS = 400;

// ─── Pure card builder ─────────────────────────────────────────────────

/**
 * Build the `sendMessage` payload for a finished run. Pure function —
 * unit tests assert exact `content` strings.
 */
export function buildResultCard(input: ResultCardInputs): ResultCardOutput {
  const icon = iconFor(input.outcome);
  const headerLabel = headerLabelFor(input.outcome);
  const durationStr = formatDuration(input.durationMs);
  const lines: string[] = [];

  // Header line — always present.
  lines.push(
    `${icon} Workflow ${input.workflowName} ${headerLabel}` +
      (input.outcome === "done"
        ? ` (${durationStr}, ${input.agentCount} agent${input.agentCount === 1 ? "" : "s"})`
        : ""),
  );

  // Per-outcome body.
  let truncated = false;
  if (input.outcome === "done") {
    const { preview, isTruncated } = stringifyResultPreview(input.result);
    truncated = isTruncated;
    if (preview.length > 0) {
      lines.push(`│ Result preview:`);
      // Indent each line so it lines up under "│"
      for (const ln of preview.split("\n")) {
        lines.push(`│   ${ln}`);
      }
    } else {
      lines.push(`│ Result: (empty)`);
    }
    lines.push(`│ Full result: ${join(input.runDirAbs, "result.json")}`);
    lines.push(`│ Re-open: /workflows show ${input.runId}`);
  } else if (input.outcome === "failed") {
    const err = input.error ?? { name: "Error", message: "(no error captured)" };
    const msg = truncateChars(err.message ?? "", ERROR_PREVIEW_MAX_CHARS);
    lines.push(`│ ${err.name}: ${msg.text}`);
    truncated = msg.truncated;
    lines.push(`│ Run dir: ${input.runDirAbs}`);
    lines.push(`│ Re-run: /${input.workflowName}`);
  } else if (input.outcome === "stopped") {
    lines.push(`│ Stopped by user. Partial results in:`);
    lines.push(`│   ${input.runDirAbs}`);
    lines.push(`│ Re-run: /${input.workflowName}`);
  } else if (input.outcome === "cancelled-pre-run") {
    const reason = input.error?.message ?? cancelReasonText(input.approval);
    lines.push(`│ Cancelled before run: ${reason}`);
    lines.push(`│ Run dir: ${input.runDirAbs}`);
  }

  // Approval audit footer — every outcome.
  const approvalReason = input.approval ? input.approval.reason : "preApproved";
  lines.push(`│ Approval: ${approvalReason}`);

  const content = lines.join("\n");

  const details: ResultCardOutput["details"] = {
    workflowName: input.workflowName,
    runId: input.runId,
    runDir: input.runDirAbs,
    outcome: input.outcome,
    durationMs: input.durationMs,
    agentCount: input.agentCount,
    approval: input.approval,
    truncated,
    ...(input.error ? { error: { name: input.error.name, message: input.error.message } } : {}),
  };

  return {
    customType: RESULT_CUSTOM_TYPE,
    content,
    details,
  };
}

function iconFor(outcome: RunOutcome): string {
  switch (outcome) {
    case "done":
      return "✅";
    case "failed":
      return "❌";
    case "stopped":
      return "⏹";
    case "cancelled-pre-run":
      return "⊘";
  }
}

function headerLabelFor(outcome: RunOutcome): string {
  switch (outcome) {
    case "done":
      return "complete";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "cancelled-pre-run":
      return "cancelled";
  }
}

/**
 * Format ms as a coarse human-readable duration. Matches PRD §3.8's
 * sample output (`4m 12s`). Sub-second runs round to "<1s".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

/**
 * Stringify a `main()` resolution for the card preview. Strings render
 * verbatim; everything else is JSON-stringified. Truncated to
 * `RESULT_PREVIEW_MAX_CHARS` chars (NOT bytes — UI cares about
 * column width, not on-disk size).
 */
export function stringifyResultPreview(value: unknown): { preview: string; isTruncated: boolean } {
  if (value === undefined) return { preview: "", isTruncated: false };
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  const t = truncateChars(s, RESULT_PREVIEW_MAX_CHARS);
  return { preview: t.text, isTruncated: t.truncated };
}

function truncateChars(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + " …(truncated)", truncated: true };
}

function cancelReasonText(decision: ApprovalDecision | null): string {
  if (decision === null) return "approval denied";
  if (decision.approved) return "approval denied";
  // approved=false branch
  if (decision.reason === "user-N") return "user denied at approval prompt";
  if (decision.reason === "pi-p-untrusted") return decision.error ?? "untrusted in pi -p strict mode";
  return decision.reason;
}

// ─── Persisted result.json ─────────────────────────────────────────────

/**
 * Atomically write `<runDir>/result.json`. Uses tmp+rename so a partial
 * write never poisons resume. Idempotent — caller may invoke twice
 * (the second write replaces the first).
 */
export async function writeResultFile(
  runDirAbs: string,
  payload: RunResultFile,
): Promise<void> {
  const target = join(runDirAbs, "result.json");
  const tmp = join(runDirAbs, `result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
  const body = JSON.stringify(payload, null, 2) + "\n";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
}

// ─── Orchestration ─────────────────────────────────────────────────────

export interface DeliverOptions {
  readonly pi: ExtensionAPI;
  readonly outcome: RunOutcome;
  readonly workflowName: string;
  readonly runId: string;
  readonly runDirAbs: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly agentCount: number;
  readonly result: unknown;
  readonly error: { name: string; message: string; stack?: string } | null;
  readonly approval: ApprovalDecision | null;
  readonly finishCallbackPrompt: string | null;
  /** Test seam — capture the on-disk write path. */
  readonly writeFile?: (runDirAbs: string, p: RunResultFile) => Promise<void>;
}

/**
 * End-of-run delivery: write `result.json`, send the card, append the
 * runs-index ended entry, fire `finishCallback` if queued.
 *
 * Returns the `RunResultFile` payload it persisted (useful for tests
 * to assert without re-reading from disk).
 */
export async function deliverRunResult(opts: DeliverOptions): Promise<RunResultFile> {
  const persistedResult: string | null = (() => {
    if (opts.outcome !== "done") return null;
    if (opts.result === undefined) return null;
    if (typeof opts.result === "string") return opts.result;
    try {
      const s = JSON.stringify(opts.result);
      return s === undefined ? null : s;
    } catch {
      return String(opts.result);
    }
  })();

  const payload: RunResultFile = {
    runId: opts.runId,
    workflowName: opts.workflowName,
    outcome: opts.outcome,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    durationMs: opts.durationMs,
    result: persistedResult,
    error: opts.error,
    approval: opts.approval,
    agentCount: opts.agentCount,
    finishCallbackPrompt: opts.finishCallbackPrompt,
  };

  // 1. Write result.json — atomic.
  const writer = opts.writeFile ?? writeResultFile;
  try {
    await writer(opts.runDirAbs, payload);
  } catch {
    // result.json write failure is non-fatal — the ledger already has
    // every fact. We still want to deliver the card.
  }

  // 2. Send the card.
  const card = buildResultCard({
    outcome: opts.outcome,
    workflowName: opts.workflowName,
    runId: opts.runId,
    runDirAbs: opts.runDirAbs,
    durationMs: opts.durationMs,
    agentCount: opts.agentCount,
    result: opts.result,
    error: opts.error,
    approval: opts.approval,
  });
  try {
    opts.pi.sendMessage(card, { triggerTurn: false, deliverAs: "nextTurn" });
  } catch {
    /* swallow — best-effort surface */
  }

  // 3. appendEntry pi-workflows.run.ended (PRD §6.6).
  if (typeof opts.pi.appendEntry === "function") {
    try {
      opts.pi.appendEntry(RUN_ENDED_ENTRY, {
        runId: opts.runId,
        workflowName: opts.workflowName,
        outcome: opts.outcome,
        runDir: opts.runDirAbs,
        endedAt: opts.endedAt,
        durationMs: opts.durationMs,
      });
    } catch {
      /* swallow */
    }
  }

  // 4. finishCallback → pi.sendUserMessage. Per plan acceptance: AFTER
  // ledger flush AND after the card is sent. The ledger flush
  // happened upstream in runManager (`await ledger.flush()` runs
  // before this delivery is invoked).
  if (
    opts.finishCallbackPrompt !== null &&
    opts.finishCallbackPrompt.length > 0
  ) {
    if (typeof opts.pi.sendUserMessage === "function") {
      try {
        opts.pi.sendUserMessage(opts.finishCallbackPrompt);
      } catch {
        /* swallow */
      }
    } else {
      // Fallback for older pi builds — surface as an annotation card.
      try {
        opts.pi.sendMessage(
          {
            customType: RESULT_CUSTOM_TYPE,
            content:
              `[finishCallback queued — pi build does not support sendUserMessage]\n` +
              opts.finishCallbackPrompt,
            display: true,
            details: {
              kind: "finishCallback-fallback",
              runId: opts.runId,
              prompt: opts.finishCallbackPrompt,
            },
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      } catch {
        /* swallow */
      }
    }
  }

  return payload;
}
