/**
 * pi-workflows — slice 14 phase view (pure render).
 *
 * Renders the per-run phase view per PRD §10.3 wireframe. Same shape
 * as `runsList.ts`: pure `(snapshot) → string[]`. The overlay
 * composites box-drawing chrome around it.
 *
 * Lines:
 *
 *   1. Title:    `wf-XXXX  workflow-name  state  elapsed`
 *   2. Subtitle: `Input: ...   Started: ...   Path: ...`
 *   3. Phases section:
 *        ✓ phase-A   1 agent   12s   ...
 *        ▸ phase-B   4/7 agents running   1m 22s elapsed
 *            ● agent-id  running  18s    summary
 *            ✓ agent-id  done     45s    summary    (cached)
 *        · phase-C   pending
 *   4. Log tail (last 5 lines).
 *   5. Help bullets (delegated to `helpForState`).
 *
 * Pure — `nowMs` is supplied; tests assert exact lines.
 *
 * Refs: PRD §10.3, plan.md §4 Slice 14.
 */

import type { RunSummary, RunSummaryState } from "./activeRuns.js";
import { isTerminalState } from "./activeRuns.js";
import type { PhaseSnapshot, RunPhaseSnapshot } from "./phaseRegistry.js";
import { fmtDuration, fmtRelative } from "./runsList.js";

/**
 * Format a token count for display.
 * < 1000 → `N tok`, ≥ 1000 → `X.Xk tok`, ≥ 1000000 → `X.XM tok`
 */
export function fmtTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

export interface PhaseViewRender {
  readonly lines: string[];
  /** Rendered agent rows with their (phaseName, agentId) for cursor mapping. */
  readonly agentRows: ReadonlyArray<{
    readonly phaseName: string;
    readonly agentId: string;
    readonly lineIndex: number;
  }>;
  readonly title: string;
  readonly subtitle: string;
}

export interface PhaseViewOpts {
  /** Now (epoch ms) — used for elapsed calculation on running phases/agents. */
  readonly nowMs?: number;
  /** Cursor index over `agentRows` (0-based). Out-of-bounds = no highlight. */
  readonly cursor?: number;
  /** Pre-formatted help bullets (same shape as runsList). */
  readonly help?: ReadonlyArray<{ key: string; label: string; disabled: boolean }>;
  /** Banner inserted under subtitle (e.g. confirm prompts, save outcomes). */
  readonly banner?: string;
}

const MAX_LOG_RENDERED = 5;

function phaseGlyph(s: PhaseSnapshot["status"]): string {
  if (s === "done") return "✓";
  if (s === "running") return "▸";
  return "·";
}

function agentGlyph(s: "queued" | "running" | "done"): string {
  if (s === "done") return "✓";
  if (s === "running") return "●";
  return "○";
}

function elapsedFor(
  startedAt: string | undefined,
  endedAt: string | undefined,
  durationMs: number | undefined,
  nowMs: number,
): string {
  if (durationMs !== undefined) return fmtDuration(durationMs);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return "—";
  const end = endedAt ? Date.parse(endedAt) : NaN;
  if (Number.isFinite(end)) return fmtDuration(end - start);
  return fmtDuration(nowMs - start);
}

export function renderPhaseView(
  summary: RunSummary,
  snapshot: RunPhaseSnapshot | undefined,
  opts: PhaseViewOpts = {},
): PhaseViewRender {
  const nowMs = opts.nowMs ?? Date.now();
  const elapsed = elapsedFor(
    summary.startedAt,
    summary.endedAt,
    summary.durationMs,
    nowMs,
  );
  const stateLabel = `${summary.state}`;
  const startedRel =
    summary.startedAt !== undefined
      ? fmtRelative(summary.startedAt, nowMs)
      : "—";
  const title = `${summary.runId}  ${summary.workflowName}  ${stateLabel}  ${elapsed}`;
  const subtitleParts: string[] = [];
  if (summary.startedAt) subtitleParts.push(`Started: ${startedRel}`);
  if (summary.runDir) subtitleParts.push(`Path: ${summary.runDir}`);
  if (summary.approvalReason)
    subtitleParts.push(`Approval: ${summary.approvalReason}`);
  const subtitle = subtitleParts.join("   ");

  const lines: string[] = [title, subtitle];
  if (opts.banner !== undefined && opts.banner.length > 0) {
    lines.push("");
    lines.push(opts.banner);
  }
  // Run-level token totals in an info line (only when data is present).
  if (snapshot !== undefined && snapshot.totalTokens > 0) {
    const tokLine =
      snapshot.cachedTokens > 0
        ? `Total: ${fmtTokens(snapshot.totalTokens)} · ${fmtTokens(snapshot.cachedTokens)} cached`
        : `Total: ${fmtTokens(snapshot.totalTokens)}`;
    lines.push(tokLine);
  }
  lines.push("");
  lines.push("Phases");

  const agentRows: { phaseName: string; agentId: string; lineIndex: number }[] = [];

  if (snapshot === undefined || snapshot.phases.length === 0) {
    lines.push("  (no phases yet)");
  } else {
    for (const phase of snapshot.phases) {
      const glyph = phaseGlyph(phase.status);
      const completed = phase.agents.filter((a) => a.state === "done").length;
      const running = phase.agents.filter((a) => a.state === "running").length;
      const queued = phase.agents.filter((a) => a.state === "queued").length;
      const phaseElapsed = elapsedFor(
        phase.startedAt,
        phase.endedAt,
        phase.durationMs,
        nowMs,
      );
      let summaryStr: string;
      if (phase.status === "pending") {
        summaryStr = "pending";
      } else if (phase.status === "done") {
        const agentSegment = `${phase.agentCount} agent${phase.agentCount === 1 ? "" : "s"}`;
        const tokStr = phase.totalTokens > 0 ? `  \u00b7  ${fmtTokens(phase.totalTokens)}` : "";
        const cachedStr = phase.cachedTokens > 0 ? ` (${fmtTokens(phase.cachedTokens)} cached)` : "";
        summaryStr = `${agentSegment}${tokStr}${cachedStr}   ${phaseElapsed}`;
      } else {
        // running
        summaryStr = `${completed}/${phase.agentCount} agents done`;
        if (running > 0) summaryStr += `, ${running} running`;
        if (queued > 0) summaryStr += `, ${queued} queued`;
        if (phase.totalTokens > 0) summaryStr += `  \u00b7  ${fmtTokens(phase.totalTokens)}`;
        summaryStr += `   ${phaseElapsed} elapsed`;
      }
      lines.push(`${glyph} ${phase.phaseName.padEnd(14)} ${summaryStr}`);

      // Show agent rows only for the active phase to mirror the wireframe
      // and avoid enormous renders on many-phase runs. (Done phases get
      // a one-line summary; pending phases show only their name.)
      if (phase.status === "running") {
        for (const agent of phase.agents) {
          const ag = agentGlyph(agent.state);
          const dur = elapsedFor(
            agent.startedAt,
            agent.endedAt,
            agent.durationMs,
            nowMs,
          );
          const cached = agent.cached === true ? "  (cached)" : "";
          const summaryCell = agent.summary ?? "";
          const row = `    ${ag} ${agent.agentId.padEnd(14)} ${agent.state.padEnd(7)} ${dur.padEnd(7)} ${summaryCell}${cached}`;
          agentRows.push({
            phaseName: phase.phaseName,
            agentId: agent.agentId,
            lineIndex: lines.length,
          });
          lines.push(row);
        }
      }
    }
  }

  // Cursor highlight: prepend ▸ to the cursor-pointed agent row.
  if (
    opts.cursor !== undefined &&
    opts.cursor >= 0 &&
    opts.cursor < agentRows.length
  ) {
    const target = agentRows[opts.cursor]!;
    const orig = lines[target.lineIndex] ?? "";
    lines[target.lineIndex] = orig.replace(/^    /, "  ▸ ");
  }

  // Log tail.
  if (snapshot !== undefined && snapshot.logTail.length > 0) {
    lines.push("");
    lines.push(`Log (last ${Math.min(MAX_LOG_RENDERED, snapshot.logTail.length)})`);
    const tail = snapshot.logTail.slice(-MAX_LOG_RENDERED);
    for (const log of tail) {
      const ts = log.at.length >= 19 ? log.at.slice(11, 19) : log.at;
      lines.push(`  ${ts}  ${log.message}`);
    }
  }

  // Help.
  const helpBullets = opts.help ?? [];
  if (helpBullets.length > 0) {
    lines.push("");
    const help = helpBullets
      .map((b) => (b.disabled ? `(${b.key} ${b.label})` : `[${b.key}] ${b.label}`))
      .join("  ");
    lines.push(help);
  }

  return { lines, agentRows, title, subtitle };
}

/** Map a state to a one-word label for the phase-view help text. */
export function phaseViewStateLabel(state: RunSummaryState): string {
  if (isTerminalState(state)) return state;
  return state;
}
