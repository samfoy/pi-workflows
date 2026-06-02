/**
 * pi-workflows — slice 13 runs-list view (pure render).
 *
 * Pure function `(state) → string[]`. Slice 13's overlay component
 * forwards its render(width) call here, then composites a border. The
 * pure-function shape is critical for unit testing: PRD §12.5 flags
 * "no snapshot harness for ctx.ui.custom"; we sidestep that by
 * separating render from mount.
 *
 * Layout is fixed-width column-aligned per PRD §10.3 — but does NOT
 * include the box-drawing chrome (the overlay component owns chrome).
 *
 * Columns:
 *
 *   <runIdShort>  <workflowName>  <state>  <started-rel>  <duration>  <approval>
 *
 * State coloring is conveyed via a sentinel character in the
 * `colorHint` field of each row; the host TUI maps to ANSI/colors.
 *
 * Refs: PRD §10.2, §10.3 (wireframes), plan.md §4 Slice 13.
 */

import type { RunSummary, RunSummaryState } from "./activeRuns.js";
import { isTerminalState } from "./activeRuns.js";
import { fmtDuration, fmtRelative } from "../util/time.js";

/**
 * Per-row metadata the renderer also surfaces (used by the test
 * harness to validate state→color mapping without needing to parse
 * ANSI escapes).
 */
export interface RenderedRow {
  readonly runId: string;
  readonly state: RunSummaryState;
  readonly line: string;
  readonly colorHint:
    | "running"
    | "paused"
    | "done"
    | "failed"
    | "stopped"
    | "cancelled"
    | "neutral";
}

export interface RenderedRunsList {
  /** Title row (overlay header — caller renders). */
  readonly title: string;
  /** Subtitle line (counters: `N active, M total`). */
  readonly subtitle: string;
  /** Header line (column labels). */
  readonly header: string;
  /** Run rows in order. The first non-terminal row is the default
   * selection unless the caller pins it. */
  readonly rows: RenderedRow[];
  /** Help bullets formatted as a single line. */
  readonly help: string;
  /** All lines composed in order — what the overlay component renders. */
  readonly lines: string[];
}

export interface RenderOpts {
  readonly title?: string;
  readonly nowMs?: number;
  readonly width?: number;
  /**
   * Index of the highlighted row (0-based among rendered rows). If
   * out-of-bounds the renderer treats it as "no highlight"; the
   * overlay clamps before passing.
   */
  readonly cursor?: number;
  /** Pre-formatted help bullets (from `helpForState`). */
  readonly help?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly disabled: boolean;
  }>;
  /**
   * Maximum runs shown. Beyond this the render trims the OLDEST
   * recent runs (active runs are never trimmed). Default 50.
   */
  readonly maxRows?: number;
  /**
   * Slice 14 — set of runIds for which this process holds a live `Run`
   * handle. Runs in `runs` whose runId is NOT in this set get a
   * "[remote]" badge in the approval cell so users can tell which runs
   * they can pause/stop directly. When undefined, no badge is
   * rendered (slice 13 behavior).
   */
  readonly localRunIds?: ReadonlySet<string>;
  /**
   * Token totals keyed by runId (from PhaseRegistry). When present,
   * renders a `tokens` column alongside duration.
   */
  readonly tokenTotals?: ReadonlyMap<string, number>;
}

const DEFAULT_MAX = 50;

const COL_RUN_ID = 14;
const COL_WORKFLOW = 22;
const COL_STATE = 11;
const COL_REL = 11;
const COL_DURATION = 11;
const COL_TOKENS = 9;

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, Math.max(0, n - 1)) + "…";
  return s + " ".repeat(n - s.length);
}

function shortId(runId: string): string {
  // wf-XXXXXXXXXXXX → wf-XXXXXXXX
  if (runId.startsWith("wf-")) return runId.length <= 12 ? runId : runId.slice(0, 12);
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

function colorHint(state: RunSummaryState): RenderedRow["colorHint"] {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "cancelled-pre-run":
      return "cancelled";
    default:
      return "neutral";
  }
}

// Re-exported from shared utility for back-compat with existing consumers.
export { fmtDuration, fmtRelative } from "../util/time.js";

/**
 * Format a token count as a compact column value.
 * `—` when no data, `X.Xk` when ≥ 1000, else `N`.
 */
function fmtTokensShort(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Sort runs: active first (running, paused), then terminal in
 * reverse chronological. PRD §10.3 wireframe puts Active above Recent.
 */
function sortRuns(runs: RunSummary[]): RunSummary[] {
  const active: RunSummary[] = [];
  const terminal: RunSummary[] = [];
  for (const r of runs) {
    if (isTerminalState(r.state)) terminal.push(r);
    else active.push(r);
  }
  // Active: ascending startedAt — preserves arrival order for FIFO feel.
  active.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  // Terminal: descending endedAt (or startedAt fallback) — newest first.
  terminal.sort((a, b) => {
    const ka = a.endedAt ?? a.startedAt;
    const kb = b.endedAt ?? b.startedAt;
    return ka < kb ? 1 : -1;
  });
  return [...active, ...terminal];
}

export function renderRunsList(
  runs: ReadonlyArray<RunSummary>,
  opts: RenderOpts = {},
): RenderedRunsList {
  const nowMs = opts.nowMs ?? Date.now();
  const max = opts.maxRows ?? DEFAULT_MAX;
  const sorted = sortRuns([...runs]);
  const trimmed = sorted.slice(0, max);

  const activeCount = trimmed.filter((r) => !isTerminalState(r.state)).length;
  const totalCount = trimmed.length;

  const title = opts.title ?? "pi-workflows";
  const subtitle =
    `${activeCount} active · ${totalCount} total` +
    (sorted.length > max ? ` · +${sorted.length - max} hidden` : "");

  const headerCols = [
    pad("run id", COL_RUN_ID),
    pad("workflow", COL_WORKFLOW),
    pad("state", COL_STATE),
    pad("started", COL_REL),
    pad("duration", COL_DURATION),
    pad("tokens", COL_TOKENS),
    "approval",
  ];
  const rawHeader = headerCols.join(" ");
  const tableWidth = opts.width ?? rawHeader.length;
  // VQ-7: bold header row.
  const header = `\x1b[1m${rawHeader}\x1b[0m`;
  const separator = "─".repeat(tableWidth);

  const rows: RenderedRow[] = trimmed.map((r, idx) => {
    const startedRel = fmtRelative(r.startedAt, nowMs);
    const dur = (() => {
      if (r.durationMs !== undefined) return fmtDuration(r.durationMs);
      const start = Date.parse(r.startedAt);
      if (Number.isFinite(start)) return fmtDuration(nowMs - start);
      return "—";
    })();
    const isRemote =
      opts.localRunIds !== undefined && !opts.localRunIds.has(r.runId);
    const approvalCell =
      r.approvalReason !== undefined ? r.approvalReason : "—";
    const remoteBadge = isRemote ? " ［remote］" : "";
    const cursor =
      opts.cursor !== undefined && opts.cursor === idx ? "▸ " : "  ";
    const rawTokens = opts.tokenTotals?.get(r.runId);
    const tokCell = rawTokens !== undefined ? fmtTokensShort(rawTokens) : "—";
    // ZONE_TIMETRAVEL polish — surface fork lineage as a badge next
    // to the workflow name. Short parentRunId only (12 chars max) so
    // the column doesn't blow past COL_WORKFLOW.
    const workflowCell =
      r.parentRunId !== undefined
        ? `${r.workflowName} (fork of ${shortId(r.parentRunId)})`
        : r.workflowName;
    const cells = [
      pad(shortId(r.runId), COL_RUN_ID),
      pad(workflowCell, COL_WORKFLOW),
      pad(r.state, COL_STATE),
      pad(startedRel, COL_REL),
      pad(dur, COL_DURATION),
      pad(tokCell, COL_TOKENS),
      approvalCell + remoteBadge,
    ];
    return {
      runId: r.runId,
      state: r.state,
      line: cursor + cells.join(" "),
      colorHint: colorHint(r.state),
    };
  });

  const helpBullets = opts.help ?? [];
  const rawHelp =
    helpBullets.length === 0
      ? ""
      : helpBullets
          .map((b) =>
            b.disabled ? `(${b.key} ${b.label})` : `[${b.key}] ${b.label}`,
          )
          .join("  ");
  // B3: clamp help bar to terminal width − 2 (leave a 1-char gutter on each side).
  const maxHelpLen = opts.width !== undefined ? opts.width - 2 : Infinity;
  let help = rawHelp;
  if (Number.isFinite(maxHelpLen) && help.length > maxHelpLen) {
    // Prefer cutting at a clean item boundary (two-space separator before [ or ().
    const cutTarget = help.slice(0, maxHelpLen as number);
    const lastBoundary = Math.max(
      cutTarget.lastIndexOf("  ["),
      cutTarget.lastIndexOf("  ("),
    );
    if (lastBoundary > 0) {
      help = help.slice(0, lastBoundary);
    } else {
      help = help.slice(0, (maxHelpLen as number) - 1) + "…";
    }
  }

  const lines: string[] = [
    title,
    subtitle,
    "",
    header,
    separator,
  ];
  if (rows.length === 0) {
    lines.push("(no runs)");
  } else {
    for (const r of rows) lines.push(r.line);
  }
  if (help.length > 0) {
    lines.push("");
    lines.push(help);
  }

  return { title, subtitle, header, rows, help, lines };
}
