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
}

const DEFAULT_MAX = 50;

const COL_RUN_ID = 14;
const COL_WORKFLOW = 22;
const COL_STATE = 11;
const COL_REL = 11;
const COL_DURATION = 11;

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

/**
 * Format an elapsed duration `ms` as a 2-segment human label:
 * `4m 12s`, `1h  4m`, `12s`. Always exactly 7 chars or fewer; padded
 * to COL_DURATION at render time.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, " ")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Format a relative-time delta (since `startedAt`) into a compact
 * label. Used by the "Started" column. `nowMs` is taken from
 * `RenderOpts.nowMs` so tests are deterministic.
 */
export function fmtRelative(startedAt: string, nowMs: number): string {
  if (startedAt.length === 0) return "—";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const delta = nowMs - start;
  if (delta < 0) return "future";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
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
    "approval",
  ];
  const header = headerCols.join(" ");

  const rows: RenderedRow[] = trimmed.map((r, idx) => {
    const startedRel = fmtRelative(r.startedAt, nowMs);
    const dur = (() => {
      if (r.durationMs !== undefined) return fmtDuration(r.durationMs);
      const start = Date.parse(r.startedAt);
      if (Number.isFinite(start)) return fmtDuration(nowMs - start);
      return "—";
    })();
    const approvalCell =
      r.approvalReason !== undefined ? r.approvalReason : "—";
    const cursor =
      opts.cursor !== undefined && opts.cursor === idx ? "▸ " : "  ";
    const cells = [
      pad(shortId(r.runId), COL_RUN_ID),
      pad(r.workflowName, COL_WORKFLOW),
      pad(r.state, COL_STATE),
      pad(startedRel, COL_REL),
      pad(dur, COL_DURATION),
      approvalCell,
    ];
    return {
      runId: r.runId,
      state: r.state,
      line: cursor + cells.join(" "),
      colorHint: colorHint(r.state),
    };
  });

  const helpBullets = opts.help ?? [];
  const help =
    helpBullets.length === 0
      ? ""
      : helpBullets
          .map((b) =>
            b.disabled ? `(${b.key} ${b.label})` : `[${b.key}] ${b.label}`,
          )
          .join("  ");

  const lines: string[] = [
    title,
    subtitle,
    "",
    header,
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
