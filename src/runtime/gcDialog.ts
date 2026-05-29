/**
 * pi-workflows — slice 15 GC dialog (pure render + logic).
 *
 * `g` hotkey from runs-list opens this confirm modal. Lists eligible
 * GC candidates with state breakdown. Apply/Cancel buttons.
 *
 * Per PRD §10.7 (hotkey table — `g`), §6.7 (GC policy).
 *
 * F4 carry-forward: skip runs whose manifest has `restartedFrom`
 * lineage of an ACTIVE run. Avoids deleting the source run while
 * a restart-sibling is still running.
 *
 * Refs: plan.md §4 Slice 15, PRD §6.7, §10.4 hotkey table.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GcCandidate, GcResult } from "./gc.js";
import { runGc } from "./gc.js";

export interface GcDialogState {
  readonly candidates: ReadonlyArray<GcCandidate>;
  readonly skippedCount: number;
  readonly totalScanned: number;
  readonly cutoffDays: number;
  /** When `confirming=true` the dialog shows Apply/Cancel buttons. */
  readonly confirming: boolean;
  /** Set after apply completes. */
  readonly done?: { readonly deleted: number; readonly errors: number };
}

export interface GcDialogRender {
  readonly lines: string[];
}

export interface GcDialogOpts {
  readonly runsRootOverride?: string;
  readonly cutoffDays?: number;
  readonly nowMs?: () => number;
  readonly resolveLedgerPath?: (runId: string) => string;
  /** Set of runIds that are currently active (running/paused). Used for F4. */
  readonly activeRunIds?: ReadonlySet<string>;
  readonly log?: (
    level: "info" | "warn" | "error",
    msg: string,
    details?: Readonly<Record<string, unknown>>,
  ) => void;
}

/**
 * Load GC candidates. Applies F4: any candidate whose `restartedFrom`
 * field points to a currently-active run is excluded from deletion.
 * (The source is still alive — it would be confusing/destructive to GC
 * the run that was restarted while the restart is still running.)
 */
export async function loadGcCandidates(
  opts: GcDialogOpts = {},
): Promise<GcResult> {
  // If runsRootOverride is set and no custom resolveLedgerPath, derive the
  // ledger path from the override root so tests don't need to override both.
  const resolveLedgerPath =
    opts.resolveLedgerPath ??
    (opts.runsRootOverride !== undefined
      ? (runId: string) => join(opts.runsRootOverride!, runId, "ledger.jsonl")
      : undefined);

  const result = await runGc({
    ...(opts.runsRootOverride !== undefined ? { runsRootOverride: opts.runsRootOverride } : {}),
    ...(opts.cutoffDays !== undefined ? { cutoffDays: opts.cutoffDays } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(resolveLedgerPath !== undefined ? { resolveLedgerPath } : {}),
    apply: false, // always dry-run here; applyGc does the real delete
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });

  if (!opts.activeRunIds || opts.activeRunIds.size === 0) {
    return result;
  }

  // F4: filter out candidates whose new restartedFrom sibling is active.
  // We read each candidate's manifest.json to check `restartedFrom`.
  // A candidate is excluded if its `restartedFrom` value is a runId in
  // activeRunIds — meaning the original run (the one that was restarted)
  // is still alive.
  const safeCandidates = result.candidates.filter((c) => {
    const manifestPath = join(c.runDir, "manifest.json");
    if (!existsSync(manifestPath)) return true; // no manifest → include
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const restartedFrom = parsed["restartedFrom"];
      if (typeof restartedFrom === "string" && opts.activeRunIds!.has(restartedFrom)) {
        // The run we restarted FROM is still active. Skip this candidate.
        opts.log?.("info", `gc: skipping ${c.runId} — restartedFrom=${restartedFrom} is active`);
        return false;
      }
    } catch {
      /* corrupt manifest — include the candidate (safe default) */
    }
    return true;
  });

  const filtered = safeCandidates.length !== result.candidates.length;
  if (!filtered) return result;

  return {
    ...result,
    candidates: safeCandidates,
    skipped: [
      ...result.skipped,
      ...(result.candidates
        .filter((c) => !safeCandidates.includes(c))
        .map((c) => ({
          runId: c.runId,
          reason: "non-terminal" as const,
          details: "restartedFrom active run (F4)",
        }))),
    ],
  };
}

/**
 * Run GC with apply=true. Returns deleted count.
 */
export async function applyGc(
  candidates: ReadonlyArray<GcCandidate>,
  opts: GcDialogOpts = {},
): Promise<{ deleted: string[]; errors: { runId: string; message: string }[] }> {
  // We already have the candidates — delete each one directly.
  const { rmSync } = await import("node:fs");
  const deleted: string[] = [];
  const errors: { runId: string; message: string }[] = [];
  for (const c of candidates) {
    try {
      rmSync(c.runDir, { recursive: true, force: true });
      deleted.push(c.runId);
      opts.log?.("info", `gc: deleted ${c.runId}`);
    } catch (err) {
      errors.push({
        runId: c.runId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { deleted, errors };
}

/**
 * Render the GC dialog to lines. Pure — no IO.
 */
export function renderGcDialog(state: GcDialogState): GcDialogRender {
  const lines: string[] = [];

  if (state.done !== undefined) {
    lines.push("GC complete");
    lines.push("");
    lines.push(`  Deleted: ${state.done.deleted} run${state.done.deleted === 1 ? "" : "s"}`);
    if (state.done.errors > 0) {
      lines.push(`  Errors:  ${state.done.errors}`);
    }
    lines.push("");
    lines.push("[any key]  close");
    return { lines };
  }

  if (state.candidates.length === 0) {
    lines.push("GC: no eligible runs");
    lines.push("");
    lines.push(
      `Scanned ${state.totalScanned} run${state.totalScanned === 1 ? "" : "s"}, ` +
      `${state.skippedCount} skipped (too young, active, or missing data).`,
    );
    lines.push("");
    lines.push("[Esc]  close");
    return { lines };
  }

  // State breakdown
  const byOutcome: Record<string, number> = {};
  for (const c of state.candidates) {
    const k = c.outcome ?? "unknown";
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }

  lines.push(`GC: ${state.candidates.length} eligible run${state.candidates.length === 1 ? "" : "s"}`);
  lines.push("");
  for (const [outcome, count] of Object.entries(byOutcome)) {
    lines.push(`  ${outcome}: ${count}`);
  }
  lines.push(`  (cutoff: older than ${state.cutoffDays} day${state.cutoffDays === 1 ? "" : "s"})`);
  if (state.skippedCount > 0) {
    lines.push(`  ${state.skippedCount} skipped (active, too young, or missing data)`);
  }

  lines.push("");

  if (state.confirming) {
    lines.push(`Delete ${state.candidates.length} run${state.candidates.length === 1 ? "" : "s"}? This cannot be undone.`);
    lines.push("");
    lines.push("[y / Enter]  apply    [n / Esc]  cancel");
  } else {
    lines.push("[Enter]  confirm    [Esc]  cancel");
  }

  return { lines };
}
