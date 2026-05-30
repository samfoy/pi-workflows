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
import { runsHome } from "../util/paths.js";

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
 * Load GC candidates. Applies F4: any candidate that is the SOURCE of
 * an active restart is excluded from deletion. Concretely, for each
 * active run we read its `manifest.restartedFrom`; if it names a GC
 * candidate, that candidate is protected. This prevents deleting
 * provenance data while a restart is still running.
 *
 * (The old inverted check read the CANDIDATE's own `restartedFrom` —
 * that protected restart-children, the wrong direction. BUG-075.)
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

  // F4: build a reverse-lookup set from ACTIVE runs' manifests.
  // For each active run, read its manifest.json and collect its
  // `restartedFrom` value into `protectedSources`.  A candidate whose
  // runId appears in `protectedSources` is the SOURCE of an active
  // restart and must not be deleted — removing it would destroy
  // provenance while the restart is still running.
  const runsRoot = opts.runsRootOverride ?? runsHome();
  const protectedSources = new Set<string>();
  for (const activeRunId of opts.activeRunIds) {
    const manifestPath = join(runsRoot, activeRunId, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const restartedFrom = parsed["restartedFrom"];
      if (typeof restartedFrom === "string" && restartedFrom.length > 0) {
        protectedSources.add(restartedFrom);
        opts.log?.("info", `gc: active run ${activeRunId} protects source ${restartedFrom}`);
      }
    } catch {
      /* corrupt manifest — skip this active run (safe: may over-delete, but
         not worse than before the fix) */
    }
  }

  const safeCandidates = result.candidates.filter((c) => {
    if (protectedSources.has(c.runId)) {
      opts.log?.("info", `gc: skipping ${c.runId} — it is the restartedFrom source of an active run`);
      return false;
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
 *
 * BUG-036: Re-validate candidates against a fresh active-run set at
 * deletion time. Any candidate whose runId is in `opts.activeRunIds`
 * is skipped (and logged as a warning) because the run may have been
 * restarted or resumed between dialog-open and user confirmation.
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
    // BUG-036: skip if this runId is now active (run resumed/retried
    // between dialog-open and confirmation).
    if (opts.activeRunIds?.has(c.runId)) {
      opts.log?.("warn", `gc: skipping ${c.runId} — now active (resumed or retried since dialog opened)`);
      continue;
    }
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
