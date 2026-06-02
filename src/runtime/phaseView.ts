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
import { fmtDuration, fmtRelative, spinnerGlyph } from "./runsList.js";

/** Truncate to n-1 chars + '…' if longer, else right-pad to n. */
function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, Math.max(0, n - 1)) + "\u2026";
  return s + " ".repeat(n - s.length);
}

const COL_PHASE_NAME = 14;
const COL_AGENT_ID = 14;
const COL_SUMMARY = 35;

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
  /**
   * P2-S8 — bordered phase cards. Empty for the legacy flat renderer;
   * populated by `renderPhaseViewCards`. Slice 9 will switch the overlay
   * over to read from `cards`.
   */
  readonly cards: ReadonlyArray<PhaseViewCard>;
}

/**
 * P2-S8 — a single phase rendered as either a bordered card (running/done
 * phases) or a single collapsed line (not-started phases).
 *
 * Each card is independently renderable: `lines` is a self-contained block
 * that can be spliced into a larger render with no other context.
 */
export interface PhaseViewCard {
  readonly phaseName: string;
  readonly description?: string;
  readonly agentsDone: number;
  readonly agentsTotal: number;
  readonly state: "pending" | "running" | "done" | "failed";
  readonly tokensTotal?: number;
  readonly elapsedMs?: number;
  readonly isCursor: boolean;
  /** Card lines (boxed) OR a single collapsed line. */
  readonly lines: string[];
  /** e.g. "\u2713 4/4", "\u28f8 0/1", "\u25cb not started". */
  readonly statusBadge: string;
  /** True for not-started phases (single line, no box). */
  readonly isCollapsed: boolean;
}

export interface PhaseViewOpts {
  /** Now (epoch ms) — used for elapsed calculation on running phases/agents. */
  readonly nowMs?: number;
  readonly width?: number;
  /** Cursor index over `agentRows` (0-based). Out-of-bounds = no highlight. */
  readonly cursor?: number;
  /** Pre-formatted help bullets (same shape as runsList). */
  readonly help?: ReadonlyArray<{ key: string; label: string; disabled: boolean }>;
  /** Banner inserted under subtitle (e.g. confirm prompts, save outcomes). */
  readonly banner?: string;
  /**
   * P2-S3 — braille-spinner frame for animating running phase / agent
   * glyphs. When undefined, falls back to the static ▸ / ● glyphs
   * (preserves backward compat with existing snapshot tests).
   */
  readonly spinnerFrame?: number;
}

const MAX_LOG_RENDERED = 5;

function phaseGlyph(s: PhaseSnapshot["status"], spinnerFrame?: number): string {
  if (s === "done") return "✓";
  if (s === "running") return spinnerFrame !== undefined ? spinnerGlyph(spinnerFrame) : "▸";
  return "·";
}

function agentGlyph(s: "queued" | "running" | "done", spinnerFrame?: number): string {
  if (s === "done") return "✓";
  if (s === "running") return spinnerFrame !== undefined ? spinnerGlyph(spinnerFrame) : "●";
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
  return _renderPhaseViewFlat(summary, snapshot, opts);
}

/**
 * P2-S8 — legacy flat-text renderer kept under an unexported alias so
 * Slice 9 can flip `renderPhaseView` to delegate to
 * `renderPhaseViewCards` without losing this implementation. Existing
 * unit tests still exercise this path through `renderPhaseView`.
 */
function _renderPhaseViewFlat(
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
      const glyph = phaseGlyph(phase.status, opts.spinnerFrame);
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
      lines.push(`${glyph} ${pad(phase.phaseName, COL_PHASE_NAME)} ${summaryStr}`);

      // Show agent rows only for the active phase to mirror the wireframe
      // and avoid enormous renders on many-phase runs. (Done phases get
      // a one-line summary; pending phases show only their name.)
      if (phase.status === "running") {
        for (const agent of phase.agents) {
          const ag = agentGlyph(agent.state, opts.spinnerFrame);
          const dur = elapsedFor(
            agent.startedAt,
            agent.endedAt,
            agent.durationMs,
            nowMs,
          );
          const cached = agent.cached === true ? "  (cached)" : "";
          const summaryCell = pad(agent.summary ?? "", COL_SUMMARY);
          const row = `    ${ag} ${pad(agent.agentId, COL_AGENT_ID)} ${agent.state.padEnd(7)} ${dur.padEnd(7)} ${summaryCell}${cached}`;
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

  return { lines, agentRows, title, subtitle, cards: [] };
}

// ──────────────────────────────────────────────────────────────
// P2-S8 — card pipeline renderer
// ──────────────────────────────────────────────────────────────

function centerPad(s: string, width: number): string {
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(width - s.length - left);
}

function badgeFor(
  status: PhaseSnapshot["status"],
  done: number,
  total: number,
  spinnerFrame: number | undefined,
): string {
  if (status === "pending") return "\u25cb not started";
  if (status === "done") return `\u2713 ${done}/${total}`;
  const glyph = spinnerGlyph(spinnerFrame ?? 0);
  return `${glyph} ${done}/${total}`;
}

function buildCard(
  phase: PhaseSnapshot,
  isCursor: boolean,
  cardWidth: number,
  nowMs: number,
  spinnerFrame: number | undefined,
): PhaseViewCard {
  const done = phase.agents.filter((a) => a.state === "done").length;
  const total = phase.agentCount;
  const badge = badgeFor(phase.status, done, total, spinnerFrame);
  const collapsed = phase.status === "pending";
  const elapsedMs =
    phase.durationMs !== undefined
      ? phase.durationMs
      : phase.startedAt !== undefined
        ? nowMs - Date.parse(phase.startedAt)
        : undefined;

  if (collapsed) {
    // Collapsed single line — `▸ ` or `  ` margin, then phase name padded
    // to 14 chars, then status badge.
    const margin = isCursor ? "\u25b8 " : "  ";
    const line = `${margin}${pad(phase.phaseName, 14)} ${badge}`;
    const card: PhaseViewCard = {
      phaseName: phase.phaseName,
      ...(phase.description !== undefined ? { description: phase.description } : {}),
      agentsDone: done,
      agentsTotal: total,
      state: phase.status,
      ...(phase.totalTokens > 0 ? { tokensTotal: phase.totalTokens } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      isCursor,
      lines: [line],
      statusBadge: badge,
      isCollapsed: true,
    };
    return card;
  }

  const innerWidth = Math.max(10, cardWidth - 4); // "│ " + content + " │"
  const cursorPrefix = isCursor ? "\u25b8 " : "  ";
  const plainPrefix = "  ";

  // Top border embeds the phase name: `┌─ phaseName ───┐`. Status badge
  // sits outside the box (right margin) and is exposed via statusBadge.
  const nameLabel = ` ${phase.phaseName} `;
  const dashesTotal = Math.max(2, cardWidth - 2 - nameLabel.length);
  const leftDashes = 1;
  const rightDashes = Math.max(1, dashesTotal - leftDashes);
  const topBorder =
    "\u250c" + "\u2500".repeat(leftDashes) + nameLabel + "\u2500".repeat(rightDashes) + "\u2510";
  const bottomBorder = "\u2514" + "\u2500".repeat(cardWidth - 2) + "\u2518";

  const lines: string[] = [];
  lines.push(`${cursorPrefix}${topBorder}`);
  if (phase.description !== undefined && phase.description.length > 0) {
    const desc = phase.description;
    const truncated = desc.length > innerWidth ? desc.slice(0, innerWidth - 1) + "\u2026" : desc;
    lines.push(`${plainPrefix}\u2502 ${truncated.padEnd(innerWidth)} \u2502`);
  }
  // Stats line: "N/N · Xk tok · Xs"
  const statsParts: string[] = [`${done}/${total}`];
  if (phase.totalTokens > 0) statsParts.push(fmtTokens(phase.totalTokens));
  if (elapsedMs !== undefined && Number.isFinite(elapsedMs))
    statsParts.push(fmtDuration(elapsedMs));
  const stats = statsParts.join(" \u00b7 ");
  const statsTruncated = stats.length > innerWidth ? stats.slice(0, innerWidth - 1) + "\u2026" : stats;
  lines.push(`${plainPrefix}\u2502 ${statsTruncated.padEnd(innerWidth)} \u2502`);
  lines.push(`${plainPrefix}${bottomBorder}`);

  const card: PhaseViewCard = {
    phaseName: phase.phaseName,
    ...(phase.description !== undefined ? { description: phase.description } : {}),
    agentsDone: done,
    agentsTotal: total,
    state: phase.status,
    ...(phase.totalTokens > 0 ? { tokensTotal: phase.totalTokens } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    isCursor,
    lines,
    statusBadge: badge,
    isCollapsed: false,
  };
  return card;
}

/**
 * P2-S8 — bordered card-per-phase pipeline renderer.
 *
 * Returns one `PhaseViewCard` per phase. Boxed cards for running/done
 * phases, single-line collapsed entries for not-started phases. DAG
 * `\u2193` arrows are inserted between adjacent boxed cards in the
 * composite `lines[]`; arrows are skipped between a boxed card and a
 * collapsed line.
 *
 * Width: `Math.min((opts.width ?? 80) - 6, 68)` — leaves 2-char margin
 * for the `\u25b8 ` cursor prefix and room for the right-aligned badge.
 */
export function renderPhaseViewCards(
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
  const startedRel =
    summary.startedAt !== undefined ? fmtRelative(summary.startedAt, nowMs) : "\u2014";
  const title = `${summary.runId}  ${summary.workflowName}  ${summary.state}  ${elapsed}`;
  const subtitleParts: string[] = [];
  if (summary.startedAt) subtitleParts.push(`Started: ${startedRel}`);
  if (summary.runDir) subtitleParts.push(`Path: ${summary.runDir}`);
  if (summary.approvalReason) subtitleParts.push(`Approval: ${summary.approvalReason}`);
  const subtitle = subtitleParts.join("   ");

  const cardWidth = Math.min((opts.width ?? 80) - 6, 68);
  const cursorIdx = opts.cursor;

  const lines: string[] = [title, subtitle];
  if (opts.banner !== undefined && opts.banner.length > 0) {
    lines.push("");
    lines.push(opts.banner);
  }
  lines.push("");
  lines.push("Phases");

  const cards: PhaseViewCard[] = [];
  const agentRows: { phaseName: string; agentId: string; lineIndex: number }[] = [];

  if (snapshot === undefined || snapshot.phases.length === 0) {
    lines.push("  (no phases yet)");
  } else {
    snapshot.phases.forEach((phase, i) => {
      const isCursor = cursorIdx !== undefined && cursorIdx === i;
      const card = buildCard(phase, isCursor, cardWidth, nowMs, opts.spinnerFrame);
      cards.push(card);
    });

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      lines.push(...card.lines);
      const next = cards[i + 1];
      if (next !== undefined && !card.isCollapsed && !next.isCollapsed) {
        // DAG arrow between two boxed cards. Center under the box (which
        // starts at column 2 due to the cursor/margin prefix).
        lines.push(centerPad("\u2193", cardWidth + 2));
      }
    }
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

  return { lines, agentRows, title, subtitle, cards };
}

/** Map a state to a one-word label for the phase-view help text. */
export function phaseViewStateLabel(state: RunSummaryState): string {
  if (isTerminalState(state)) return state;
  return state;
}
