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
  /**
   * VQ-1 — ANSI-colorized version of `line`. For uncolored states
   * (`neutral`, `pending`) this is identical to `line`. For all other
   * states the entire row line is wrapped in an ANSI prefix +
   * `\x1b[0m` reset, so stripping ANSI yields exactly `line` again.
   * Tests rely on this strip-ANSI invariant.
   */
  readonly coloredLine: string;
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
  /** VQ-1 — colored version of `header`. Optional; absent means the
   * caller should fall back to `header`. The overlay's TTY render
   * path prefers this when set. */
  readonly coloredLine?: string;
  /** Run rows in order. The first non-terminal row is the default
   * selection unless the caller pins it. */
  readonly rows: RenderedRow[];
  /** Help bullets formatted as a single line. */
  readonly help: string;
  /** All lines composed in order — what the overlay component renders. */
  readonly lines: string[];
  /**
   * P2-S4 — number of completed runs hidden behind the
   * `… N more` sentinel when `groupBy === 'state'` and
   * `expandCompleted` is false. `0` (or absent) means no sentinel
   * was emitted. The overlay reads this to know whether the cursor
   * may land on the sentinel position (`cursor === rows.length`).
   */
  readonly hiddenCompletedCount?: number;
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
  /**
   * P2-S3 — current braille-spinner frame index. The overlay drives
   * a `setInterval(120ms)` that increments this counter; renderers
   * use it to animate running-row glyphs. When undefined, running
   * rows display the static `⠋` (frame 0) glyph. Modulo-10 wrap is
   * applied internally so callers can pass any non-negative integer.
   */
  readonly spinnerFrame?: number;
  /**
   * P2-S7 — filter text. When set and non-empty, rows are filtered to
   * those whose `workflowName` or `runId` starts with the text
   * (case-insensitive). Empty string is treated as undefined (no
   * filter). When set, the subtitle gains a `  /  <text>█` suffix
   * with a block-cursor indicator.
   */
  readonly filterText?: string;
  /**
   * P2-S4 — grouping mode for the runs list. `'state'` partitions
   * runs into three sections (`⚠  Needs input`, `▶  Working`,
   * `✓  Completed`) with section headers interleaved into
   * `lines[]`. `'time'` (or undefined) preserves the legacy flat
   * sort: active runs first (by startedAt asc), then terminal runs
   * newest-first. The overlay defaults to `'state'`; existing tests
   * and IPC fallback callers omit it.
   */
  readonly groupBy?: "state" | "time";
  /**
   * P2-S4 — when grouping by state, expand the Completed section to
   * show all terminal runs. When `false` (default), the section is
   * truncated to 3 rows with a `… N more` sentinel below. The overlay
   * toggles this via Enter on the sentinel row.
   */
  readonly expandCompleted?: boolean;
  /**
   * P2-S6 — runId whose log tail should be peeked inline. When set
   * AND that run is in the rendered output, the peek lines are
   * injected into `lines[]` immediately after that row. The peek
   * lines do NOT appear in `rows[]`, so cursor navigation is
   * unaffected. If the runId is not in the visible list, this is a
   * silent no-op.
   */
  readonly peekRunId?: string;
  /**
   * P2-S6 — the log-tail strings to inject under `peekRunId`. Each
   * non-last entry renders as `  │ <text>`, the last entry as
   * `  └ <text>`. An empty array (or `undefined` when peekRunId is
   * set) renders a single `  └ (no log entries yet)` placeholder.
   */
  readonly peekLines?: ReadonlyArray<string>;
}

/**
 * P2-S3 — braille spinner frames. Index modulo 10.
 * Exported so phaseView can share the same animation cycle.
 */
export const SPINNER_FRAMES: ReadonlyArray<string> = [
  "\u280B", // ⠋
  "\u2819", // ⠙
  "\u2839", // ⠹
  "\u2838", // ⠸
  "\u283C", // ⠼
  "\u2834", // ⠴
  "\u2826", // ⠦
  "\u2827", // ⠧
  "\u2807", // ⠇
  "\u280F", // ⠏
];

/** P2-S3 — return the braille glyph for `frame`, wrapping mod-10. */
export function spinnerGlyph(frame: number): string {
  const n = SPINNER_FRAMES.length;
  const idx = ((frame % n) + n) % n;
  return SPINNER_FRAMES[idx]!;
}

const DEFAULT_MAX = 50;

const COL_RUN_ID = 14;
const COL_WORKFLOW = 22;
const COL_STATE = 11;
const COL_REL = 11;
const COL_DURATION = 11;
const COL_TOKENS = 9;

/**
 * P2-S5 — width-responsive column budget. Returns which optional
 * columns the renderer should emit for the given terminal width.
 *
 * Tiers (per `docs/tui-phase2-plan.md` §Slice 5):
 *   - `width < 80`:  essentials only (runId + workflow + state + started)
 *   - `80 ≤ w < 120`: + duration + tokens
 *   - `w ≥ 120`:     + duration + tokens + approval
 *
 * `width === undefined` keeps the legacy wide behavior (all columns)
 * for backward-compat with callers that don't thread width — see plan
 * acceptance criteria.
 */
export interface ColumnBudget {
  readonly duration: boolean;
  readonly tokens: boolean;
  readonly approval: boolean;
}

export function computeColumnBudget(width: number | undefined): ColumnBudget {
  if (width === undefined) {
    return { duration: true, tokens: true, approval: true };
  }
  if (width < 80) return { duration: false, tokens: false, approval: false };
  if (width < 120) return { duration: true, tokens: true, approval: false };
  return { duration: true, tokens: true, approval: true };
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, Math.max(0, n - 1)) + "…";
  return s + " ".repeat(n - s.length);
}

function shortId(runId: string): string {
  // wf-XXXXXXXXXXXX → wf-XXXXXXXX
  if (runId.startsWith("wf-")) return runId.length <= 12 ? runId : runId.slice(0, 12);
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

/**
 * VQ-1 — ANSI escape prefix for a given color hint. Empty string
 * means "no color" (neutral / pending). All non-empty prefixes are
 * paired with `\x1b[0m` at the end of the line to reset.
 */
function ansiPrefixFor(hint: RenderedRow["colorHint"]): string {
  switch (hint) {
    case "running":
      return "\x1b[1;36m"; // bold cyan
    case "failed":
      return "\x1b[1;31m"; // bold red
    case "done":
      return "\x1b[1;32m"; // bold green
    case "paused":
      return "\x1b[1;33m"; // bold yellow
    case "stopped":
    case "cancelled":
      return "\x1b[2m"; // dim
    default:
      return "";
  }
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

/**
 * P2-S4 — partition runs into the three state-grouped buckets used
 * by `groupBy: 'state'`. Each bucket is internally sorted to match
 * the section's display contract:
 *
 *   - **needsInput** (⚠): non-terminal runs with `hasPendingInterrupt`
 *     set, sorted by `startedAt` ascending (FIFO — oldest pending
 *     first).
 *   - **working** (▶): non-terminal runs without a pending
 *     interrupt (running + paused), sorted by `startedAt` ascending.
 *   - **completed** (✓): terminal runs, sorted by `endedAt`
 *     descending (newest first).
 *
 * Exported for use by `sortAndClamp` in `overlayState.ts` so the
 * cursor's row index agrees with the rendered order.
 */
export function partitionByState(
  runs: ReadonlyArray<RunSummary>,
): {
  needsInput: RunSummary[];
  working: RunSummary[];
  completed: RunSummary[];
} {
  const needsInput: RunSummary[] = [];
  const working: RunSummary[] = [];
  const completed: RunSummary[] = [];
  for (const r of runs) {
    if (isTerminalState(r.state)) {
      completed.push(r);
    } else if (r.hasPendingInterrupt === true) {
      needsInput.push(r);
    } else {
      working.push(r);
    }
  }
  needsInput.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  working.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  completed.sort((a, b) => {
    const ka = a.endedAt ?? a.startedAt;
    const kb = b.endedAt ?? b.startedAt;
    return ka < kb ? 1 : -1;
  });
  return { needsInput, working, completed };
}

/** P2-S4 — cap on the visible Completed rows when collapsed. */
const COMPLETED_COLLAPSED_LIMIT = 3;

/**
 * P2-S4 — section header glyphs and labels. Pure for testability.
 * The label width is fixed so headers align across re-renders.
 */
function sectionHeader(
  glyph: string,
  label: string,
  count: number,
): string {
  return `${glyph}  ${label}  (${count})`;
}

export function renderRunsList(
  runs: ReadonlyArray<RunSummary>,
  opts: RenderOpts = {},
): RenderedRunsList {
  const nowMs = opts.nowMs ?? Date.now();
  const max = opts.maxRows ?? DEFAULT_MAX;
  // P2-S7 — apply filterText before sort/group. Match by
  // case-insensitive prefix on workflowName OR runId.
  const filterRaw = opts.filterText ?? "";
  const filterActive = filterRaw.length > 0;
  const filterLower = filterRaw.toLowerCase();
  const filtered = filterActive
    ? runs.filter(
        (r) =>
          r.workflowName.toLowerCase().startsWith(filterLower) ||
          r.runId.toLowerCase().startsWith(filterLower),
      )
    : runs;

  // P2-S4 — grouping decision. `'state'` groups + caps Completed;
  // `'time'` (or undefined) preserves the legacy flat sort.
  const groupBy = opts.groupBy ?? "time";
  const expandCompleted = opts.expandCompleted ?? false;

  let ordered: RunSummary[];
  let needsInput: RunSummary[] = [];
  let working: RunSummary[] = [];
  let completedAll: RunSummary[] = [];
  let completedVisible: RunSummary[] = [];
  let hiddenCompletedCount = 0;
  if (groupBy === "state") {
    const parts = partitionByState(filtered);
    needsInput = parts.needsInput;
    working = parts.working;
    completedAll = parts.completed;
    if (!expandCompleted && completedAll.length > COMPLETED_COLLAPSED_LIMIT) {
      completedVisible = completedAll.slice(0, COMPLETED_COLLAPSED_LIMIT);
      hiddenCompletedCount = completedAll.length - COMPLETED_COLLAPSED_LIMIT;
    } else {
      completedVisible = completedAll;
    }
    ordered = [...needsInput, ...working, ...completedVisible];
  } else {
    ordered = sortRuns([...filtered]);
  }
  // maxRows still applies after grouping: trim from the end so the
  // cap honors the order callers see (oldest terminal disappear first).
  const trimmed = ordered.slice(0, max);
  // If trimming dropped completedVisible rows, recompute the visible
  // bucket counts so section headers reflect what's actually shown.
  if (groupBy === "state" && trimmed.length < ordered.length) {
    let consumed = 0;
    needsInput = needsInput.slice(0, Math.max(0, trimmed.length - consumed));
    consumed += needsInput.length;
    working = working.slice(0, Math.max(0, trimmed.length - consumed));
    consumed += working.length;
    completedVisible = completedVisible.slice(
      0,
      Math.max(0, trimmed.length - consumed),
    );
  }

  const activeCount = trimmed.filter((r) => !isTerminalState(r.state)).length;
  const totalCount = trimmed.length;

  const title = opts.title ?? "pi-workflows";
  const subtitle =
    `${activeCount} active · ${totalCount} total` +
    (ordered.length > max ? ` · +${ordered.length - max} hidden` : "") +
    // P2-S7 — filter indicator with block-cursor suffix.
    (opts.filterText !== undefined && opts.filterText.length > 0
      ? `  /  ${opts.filterText}█`
      : "");

  // P2-S5 — width-responsive column budget.
  const budget = computeColumnBudget(opts.width);

  const headerCols: string[] = [
    pad("run id", COL_RUN_ID),
    pad("workflow", COL_WORKFLOW),
    pad("state", COL_STATE),
    pad("started", COL_REL),
  ];
  if (budget.duration) headerCols.push(pad("duration", COL_DURATION));
  if (budget.tokens) headerCols.push(pad("tokens", COL_TOKENS));
  if (budget.approval) headerCols.push("approval");
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
    // P2-S3 — running rows show an animated braille spinner inline
    // with the state label. Terminal/non-running states are
    // unaffected by spinnerFrame.
    const stateCell =
      r.state === "running"
        ? `${spinnerGlyph(opts.spinnerFrame ?? 0)} ${r.state}`
        : r.state;
    const cells: string[] = [
      pad(shortId(r.runId), COL_RUN_ID),
      pad(workflowCell, COL_WORKFLOW),
      pad(stateCell, COL_STATE),
      pad(startedRel, COL_REL),
    ];
    if (budget.duration) cells.push(pad(dur, COL_DURATION));
    if (budget.tokens) cells.push(pad(tokCell, COL_TOKENS));
    if (budget.approval) cells.push(approvalCell + remoteBadge);
    const hint = colorHint(r.state);
    const plain = cursor + cells.join(" ");
    const prefix = ansiPrefixFor(hint);
    const colored = prefix === "" ? plain : `${prefix}${plain}\x1b[0m`;
    return {
      runId: r.runId,
      state: r.state,
      line: plain,
      coloredLine: colored,
      colorHint: hint,
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

  // P2-S6 — build the peek-tail injection once. Returns null when
  // peek is inactive or its target run is not in the visible list.
  const peekTail: string[] | null = (() => {
    if (opts.peekRunId === undefined) return null;
    if (!rows.some((r) => r.runId === opts.peekRunId)) return null;
    const lns = opts.peekLines ?? [];
    if (lns.length === 0) return ["  \u2514 (no log entries yet)"];
    const out: string[] = [];
    for (let li = 0; li < lns.length - 1; li++) {
      out.push(`  \u2502 ${lns[li]}`);
    }
    out.push(`  \u2514 ${lns[lns.length - 1]}`);
    return out;
  })();
  const matchPeek = (row: RenderedRow): boolean =>
    peekTail !== null && row.runId === opts.peekRunId;

  if (rows.length === 0 && hiddenCompletedCount === 0) {
    lines.push("(no runs)");
  } else if (groupBy === "state") {
    // P2-S4 — emit per-section headers + rows. `rows[]` order is
    // [needsInput..., working..., completedVisible...]; we walk
    // through them in groups, peeling off rows[] entries as we go.
    let i = 0;
    if (needsInput.length > 0) {
      lines.push(sectionHeader("\u26a0", "Needs input", needsInput.length));
      for (let k = 0; k < needsInput.length; k++) {
        const row = rows[i++]!;
        lines.push(row.line);
        if (matchPeek(row)) for (const p of peekTail!) lines.push(p);
      }
    }
    if (working.length > 0) {
      lines.push(sectionHeader("\u25b6", "Working", working.length));
      for (let k = 0; k < working.length; k++) {
        const row = rows[i++]!;
        lines.push(row.line);
        if (matchPeek(row)) for (const p of peekTail!) lines.push(p);
      }
    }
    if (completedVisible.length > 0 || hiddenCompletedCount > 0) {
      // The header count reflects the FULL completed bucket (visible
      // + hidden) so users see total terminal runs at a glance.
      lines.push(
        sectionHeader(
          "\u2713",
          "Completed",
          completedVisible.length + hiddenCompletedCount,
        ),
      );
      for (let k = 0; k < completedVisible.length; k++) {
        const row = rows[i++]!;
        lines.push(row.line);
        if (matchPeek(row)) for (const p of peekTail!) lines.push(p);
      }
      if (hiddenCompletedCount > 0) {
        // Cursor lands on the sentinel when `cursor === rows.length`.
        const sentinelCursor =
          opts.cursor !== undefined && opts.cursor === rows.length
            ? "▸ "
            : "  ";
        lines.push(`${sentinelCursor}… ${hiddenCompletedCount} more`);
      }
    }
  } else {
    for (const r of rows) {
      lines.push(r.line);
      if (matchPeek(r)) for (const p of peekTail!) lines.push(p);
    }
  }
  if (help.length > 0) {
    lines.push("");
    lines.push(help);
  }

  return {
    title,
    subtitle,
    header,
    // VQ-1 — `header` is already wrapped in bold ANSI (see VQ-7); expose
    // a `coloredLine` alias for symmetry with RenderedRow so the
    // overlay's TTY path has a single consistent field name.
    coloredLine: header,
    rows,
    help,
    lines,
    ...(hiddenCompletedCount > 0 ? { hiddenCompletedCount } : {}),
  };
}
