/**
 * tests/unit/runsList.test.ts — slice 13 pure-function render tests.
 *
 * The runs-list view is a pure function `(summaries, opts) → lines`,
 * so we can snapshot exact strings without spinning up a TUI. This
 * test pins:
 *
 *   - Column ordering and header line
 *   - Sort: active (running, paused) first, then terminal in
 *     reverse-chronological
 *   - Row colorHint per state (used by overlay theming)
 *   - Cursor marker `▸ ` only on the highlighted row
 *   - Help bullet formatting: `[k] label` enabled, `(k label)` disabled
 *   - Empty state: `(no runs)` placeholder
 *   - fmtDuration / fmtRelative deterministic outputs
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  fmtDuration,
  fmtRelative,
  renderRunsList,
} from "../../src/runtime/runsList.js";
import type { RunSummary } from "../../src/runtime/activeRuns.js";

const NOW = Date.parse("2026-05-29T12:00:00Z");

function summary(p: Partial<RunSummary> & Pick<RunSummary, "runId">): RunSummary {
  return {
    runId: p.runId,
    workflowName: p.workflowName ?? "demo",
    state: p.state ?? "running",
    startedAt: p.startedAt ?? "2026-05-29T11:59:00Z", // 1m ago
    ...(p.endedAt !== undefined ? { endedAt: p.endedAt } : {}),
    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
    ...(p.approvalReason !== undefined
      ? { approvalReason: p.approvalReason }
      : {}),
    ...(p.runDir !== undefined ? { runDir: p.runDir } : {}),
    ...(p.hasPendingInterrupt !== undefined
      ? { hasPendingInterrupt: p.hasPendingInterrupt }
      : {}),
  };
}

test("fmtDuration: 0/1s/59s/1m/1h ranges", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(999), "0s");
  assert.equal(fmtDuration(1500), "1s");
  assert.equal(fmtDuration(59_000), "59s");
  assert.equal(fmtDuration(60_000), "1m 00s");
  assert.equal(fmtDuration(125_000), "2m 05s");
  assert.equal(fmtDuration(3_600_000), "1h  0m");
  assert.equal(fmtDuration(3_660_000), "1h  1m");
  assert.equal(fmtDuration(-1), "—");
  assert.equal(fmtDuration(NaN), "—");
});

test("fmtRelative: deterministic", () => {
  assert.equal(fmtRelative("2026-05-29T12:00:00Z", NOW), "0s ago");
  assert.equal(fmtRelative("2026-05-29T11:59:30Z", NOW), "30s ago");
  // 60 minutes → the 1-hour boundary; clamp into the hours branch.
  assert.equal(fmtRelative("2026-05-29T11:00:00Z", NOW), "1h ago");
  assert.equal(fmtRelative("2026-05-29T11:30:00Z", NOW), "30m ago");
  assert.equal(fmtRelative("2026-05-28T12:00:00Z", NOW), "1d ago");
  assert.equal(fmtRelative("", NOW), "—");
});

test("empty runs list shows `(no runs)` placeholder", () => {
  const out = renderRunsList([], { nowMs: NOW });
  assert.equal(out.rows.length, 0);
  assert.ok(out.lines.includes("(no runs)"));
});

test("sort: active (running, paused) first then terminal newest-first", () => {
  const out = renderRunsList(
    [
      summary({
        runId: "wf-old-done",
        state: "done",
        startedAt: "2026-05-29T11:00:00Z",
        endedAt: "2026-05-29T11:01:00Z",
        durationMs: 60_000,
      }),
      summary({
        runId: "wf-paused",
        state: "paused",
        startedAt: "2026-05-29T11:50:00Z",
      }),
      summary({
        runId: "wf-running",
        state: "running",
        startedAt: "2026-05-29T11:55:00Z",
      }),
      summary({
        runId: "wf-newer-done",
        state: "done",
        startedAt: "2026-05-29T11:30:00Z",
        endedAt: "2026-05-29T11:31:00Z",
        durationMs: 60_000,
      }),
    ],
    { nowMs: NOW },
  );
  // Active first (sorted by startedAt asc): paused (11:50) before
  // running (11:55).
  assert.equal(out.rows[0]?.runId, "wf-paused");
  assert.equal(out.rows[1]?.runId, "wf-running");
  // Terminal: newer first (newer-done at 11:31 ended after old-done).
  assert.equal(out.rows[2]?.runId, "wf-newer-done");
  assert.equal(out.rows[3]?.runId, "wf-old-done");
});

test("row colorHint mapping covers every state", () => {
  const out = renderRunsList(
    [
      summary({ runId: "wf-r", state: "running" }),
      summary({ runId: "wf-p", state: "paused" }),
      summary({
        runId: "wf-d",
        state: "done",
        endedAt: "2026-05-29T12:00:00Z",
      }),
      summary({
        runId: "wf-f",
        state: "failed",
        endedAt: "2026-05-29T12:00:01Z",
      }),
      summary({
        runId: "wf-s",
        state: "stopped",
        endedAt: "2026-05-29T12:00:02Z",
      }),
      summary({
        runId: "wf-c",
        state: "cancelled-pre-run",
        endedAt: "2026-05-29T12:00:03Z",
      }),
    ],
    { nowMs: NOW },
  );
  const colorByRunId = new Map(out.rows.map((r) => [r.runId, r.colorHint]));
  assert.equal(colorByRunId.get("wf-r"), "running");
  assert.equal(colorByRunId.get("wf-p"), "paused");
  assert.equal(colorByRunId.get("wf-d"), "done");
  assert.equal(colorByRunId.get("wf-f"), "failed");
  assert.equal(colorByRunId.get("wf-s"), "stopped");
  assert.equal(colorByRunId.get("wf-c"), "cancelled");
});

test("cursor marker `▸ ` only on highlighted row", () => {
  const out = renderRunsList(
    [
      summary({ runId: "wf-a", state: "running" }),
      summary({ runId: "wf-b", state: "running" }),
    ],
    { nowMs: NOW, cursor: 1 },
  );
  assert.equal(out.rows[0]?.line.startsWith("▸ "), false);
  assert.equal(out.rows[1]?.line.startsWith("▸ "), true);
});

test("help bullets formatted: enabled `[k] label`, disabled `(k label)`", () => {
  const out = renderRunsList(
    [summary({ runId: "wf-a", state: "running" })],
    {
      nowMs: NOW,
      help: [
        { key: "↑↓", label: "navigate", disabled: false },
        { key: "p", label: "pause", disabled: false },
        { key: "r", label: "restart", disabled: true },
      ],
    },
  );
  assert.match(out.help, /\[↑↓\] navigate/);
  assert.match(out.help, /\[p\] pause/);
  assert.match(out.help, /\(r restart\)/);
});

test("subtitle reports active vs total counts", () => {
  const out = renderRunsList(
    [
      summary({ runId: "wf-1", state: "running" }),
      summary({ runId: "wf-2", state: "running" }),
      summary({
        runId: "wf-3",
        state: "done",
        endedAt: "2026-05-29T12:00:00Z",
      }),
    ],
    { nowMs: NOW },
  );
  assert.match(out.subtitle, /2 active/);
  assert.match(out.subtitle, /3 total/);
});

test("maxRows trims oldest terminal runs but keeps active runs", () => {
  const summaries: RunSummary[] = [];
  // 1 active + 100 terminal
  summaries.push(summary({ runId: "wf-active", state: "running" }));
  for (let i = 0; i < 100; i++) {
    summaries.push(
      summary({
        runId: `wf-old${String(i).padStart(3, "0")}`,
        state: "done",
        startedAt: `2026-05-29T10:${String(i).padStart(2, "0")}:00Z`,
        endedAt: `2026-05-29T10:${String(i).padStart(2, "0")}:30Z`,
      }),
    );
  }
  const out = renderRunsList(summaries, { nowMs: NOW, maxRows: 10 });
  assert.equal(out.rows.length, 10);
  // Active row must still be present.
  assert.ok(
    out.rows.some((r) => r.runId === "wf-active"),
    "active run must survive trimming",
  );
  assert.match(out.subtitle, /\+91 hidden/);
});

// ─── Slice 15 F1: remote-run badge (U3 — tautology fix) ──────────
// Prior runId "wf-remote001" contained substring "remote", so
// `.includes("remote")` passed regardless of the badge. Rewritten to
// use a runId WITHOUT "remote" in it and assert the full-width glyph
// ［remote］ specifically. Mutation `isRemote=false` now fails.

const REMOTE_BADGE = "［remote］";

test("U3: runs with no local handle render the remote badge glyph", () => {
  const summaries: RunSummary[] = [
    summary({ runId: "wf-loc0000001", state: "running" }),
    summary({ runId: "wf-ext0000001", state: "running" }), // no 'remote' substring
  ];
  const out = renderRunsList(summaries, {
    nowMs: NOW,
    localRunIds: new Set(["wf-loc0000001"]),
  });
  const local = out.rows.find((r) => r.runId === "wf-loc0000001")!;
  const remote = out.rows.find((r) => r.runId === "wf-ext0000001")!;
  assert.ok(
    !local.line.includes(REMOTE_BADGE),
    `local run must NOT carry remote badge glyph; got: ${local.line}`,
  );
  assert.ok(
    remote.line.includes(REMOTE_BADGE),
    `remote run must carry the ［remote］ glyph; got: ${remote.line}`,
  );
});

test("U3 mutation: isRemote=false (both in localRunIds) → neither has badge", () => {
  const summaries: RunSummary[] = [
    summary({ runId: "wf-loc0000001", state: "running" }),
    summary({ runId: "wf-ext0000001", state: "running" }),
  ];
  // Mutation: both are 'local' — neither should get a badge.
  const out = renderRunsList(summaries, {
    nowMs: NOW,
    localRunIds: new Set(["wf-loc0000001", "wf-ext0000001"]),
  });
  for (const row of out.rows) {
    assert.ok(
      !row.line.includes(REMOTE_BADGE),
      `no badge expected when isRemote=false; got: ${row.line}`,
    );
  }
});

test("U3: when localRunIds is undefined, NO badge is rendered (slice 13 behavior)", () => {
  const summaries: RunSummary[] = [
    summary({ runId: "wf-x0001", state: "running" }),
  ];
  const out = renderRunsList(summaries, { nowMs: NOW });
  assert.ok(!out.rows[0]!.line.includes("remote"));
});

// ZONE_TIMETRAVEL polish — fork-of-<short> badge in workflow column.

test("fork badge: workflow cell shows '(fork of <short>)' when parentRunId is set", () => {
  const summaries: RunSummary[] = [
    {
      runId: "wf-childfork000",
      workflowName: "demo",
      state: "running",
      startedAt: "2026-05-29T11:59:00Z",
      parentRunId: "wf-parent000000",
      forkAtPhase: "p2",
    },
  ];
  const out = renderRunsList(summaries, { nowMs: NOW });
  assert.equal(out.rows.length, 1);
  // The workflow column is 22 chars wide so a long fork badge gets
  // truncated with an ellipsis. Assert on the prefix that survives.
  assert.match(
    out.rows[0]!.line,
    /demo \(fork of wf-pare/,
    `fork badge missing; got: ${out.rows[0]!.line}`,
  );
});

test("fork badge: non-fork run has no '(fork of ...)' suffix", () => {
  const summaries: RunSummary[] = [
    summary({ runId: "wf-plain000001", state: "running" }),
  ];
  const out = renderRunsList(summaries, { nowMs: NOW });
  assert.ok(
    !out.rows[0]!.line.includes("fork of"),
    `non-fork run must not carry a fork badge; got: ${out.rows[0]!.line}`,
  );
});

// ─── Slice 6: VQ-7 bold header + separator, B3 help clamp ────────

test("VQ-7: header string is wrapped in bold ANSI escapes", () => {
  const out = renderRunsList([], { nowMs: NOW });
  assert.ok(
    out.header.startsWith("\x1b[1m"),
    `header must start with bold escape; got: ${JSON.stringify(out.header)}`,
  );
  assert.ok(
    out.header.endsWith("\x1b[0m"),
    `header must end with reset escape; got: ${JSON.stringify(out.header)}`,
  );
});

test("VQ-7: separator line appears immediately after header in lines[]", () => {
  const out = renderRunsList([], { nowMs: NOW });
  const headerIdx = out.lines.indexOf(out.header);
  assert.ok(headerIdx >= 0, "header must appear in lines[]");
  const sep = out.lines[headerIdx + 1];
  assert.ok(
    sep !== undefined && /^\u2500+$/.test(sep),
    `separator line must follow header; got: ${JSON.stringify(sep)}`,
  );
});

test("VQ-7: separator width equals opts.width when provided", () => {
  const out = renderRunsList([], { nowMs: NOW, width: 80 });
  const headerIdx = out.lines.indexOf(out.header);
  const sep = out.lines[headerIdx + 1]!;
  assert.equal(sep.length, 80, `separator must be 80 chars; got ${sep.length}`);
});

test("VQ-7: separator width falls back to header visual width when no opts.width", () => {
  const out = renderRunsList([], { nowMs: NOW });
  // Strip ANSI escapes to get visual width.
  const visualHeader = out.header.replace(/\x1b\[[0-9;]*m/g, "");
  const headerIdx = out.lines.indexOf(out.header);
  const sep = out.lines[headerIdx + 1]!;
  assert.equal(
    sep.length,
    visualHeader.length,
    `separator must match visual header length (${visualHeader.length}); got ${sep.length}`,
  );
});

test("B3: help string is NOT truncated when it fits within opts.width", () => {
  const out = renderRunsList(
    [summary({ runId: "wf-a", state: "running" })],
    {
      nowMs: NOW,
      width: 200,
      help: [{ key: "\u21d5", label: "navigate", disabled: false }],
    },
  );
  assert.match(out.help, /\[\u21d5\] navigate/);
  assert.ok(out.help.length <= 198, `help must fit within width-2; len=${out.help.length}`);
});

test("B3: help string is clamped to opts.width - 2 at a clean boundary", () => {
  // Build enough help items to overflow width=80.
  const manyHelp = Array.from({ length: 10 }, (_, i) => ({
    key: String(i),
    label: "label-item",
    disabled: false,
  }));
  const out = renderRunsList(
    [summary({ runId: "wf-a", state: "running" })],
    { nowMs: NOW, width: 80, help: manyHelp },
  );
  assert.ok(
    out.help.length <= 78,
    `help must be \u226478 chars at width=80; got ${out.help.length}: ${out.help}`,
  );
  // Must not end with a dangling '[' or '(' — clean boundary.
  assert.ok(
    !out.help.endsWith("[") && !out.help.endsWith("("),
    `help must not end with dangling bracket; got: ${out.help}`,
  );
});

test("B3: help is unchanged when opts.width is not provided", () => {
  const manyHelp = Array.from({ length: 10 }, (_, i) => ({
    key: String(i),
    label: "label-item",
    disabled: false,
  }));
  const out = renderRunsList(
    [summary({ runId: "wf-a", state: "running" })],
    { nowMs: NOW, help: manyHelp },
  );
  // No width given — full help string should be present.
  assert.match(out.help, /\[9\] label-item/);
});

// ─── Slice 10: VQ-1 coloredLine assertions ──────────────────────
//
// Slice 9 added a `coloredLine` field on RenderedRow plus a per-state
// ANSI prefix table (`ansiPrefixFor`). These tests pin the contract
// the overlay's TTY render path relies on:
//
//   - strip-ANSI(coloredLine) === line for every state
//   - per-state ANSI codes are exactly the ones documented in the
//     ansiPrefixFor switch (catches accidental palette drift)
//   - neutral states inject NO ANSI (plain coloredLine)
//   - lines[] still uses plain `row.line` (so non-TTY consumers and
//     existing snapshot-style tests don't see escapes injected on rows)
//   - colorHint mapping is unchanged after the slice 9 refactor

const ANSI_RE_GLOBAL = /\x1b\[[0-9;]*m/g;
const ANSI_RE_TEST = /\x1b\[[0-9;]*m/;

const ALL_STATES: RunSummary["state"][] = [
  "pending",
  "approved",
  "running",
  "paused",
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
];

const TERMINAL_FOR_TEST: ReadonlySet<RunSummary["state"]> = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

describe("coloredLine (VQ-1)", () => {
  test("strip-ANSI invariant: coloredLine.replace(ANSI,'') === line for every state", () => {
    const summaries: RunSummary[] = ALL_STATES.map((state, i) =>
      summary({
        runId: `wf-${state.slice(0, 4).padEnd(4, "x")}${String(i).padStart(8, "0")}`,
        state,
        // Give terminal states an endedAt so the sort comparator has
        // both keys; non-terminal rows fall through to the active path.
        ...(TERMINAL_FOR_TEST.has(state)
          ? {
              endedAt: `2026-05-29T11:5${i}:00Z`,
              durationMs: 30_000,
            }
          : {}),
      }),
    );
    const out = renderRunsList(summaries, { nowMs: NOW });
    assert.equal(
      out.rows.length,
      ALL_STATES.length,
      "every input state must produce a rendered row",
    );
    for (const row of out.rows) {
      const stripped = row.coloredLine.replace(ANSI_RE_GLOBAL, "");
      assert.equal(
        stripped,
        row.line,
        `[state=${row.state}] strip-ANSI(coloredLine) must equal line; ` +
          `coloredLine=${JSON.stringify(row.coloredLine)}, ` +
          `line=${JSON.stringify(row.line)}`,
      );
    }
  });

  test("running state: coloredLine carries bold cyan prefix \\x1b[1;36m", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-r0000000001", state: "running" })],
      { nowMs: NOW },
    );
    const row = out.rows[0]!;
    assert.equal(row.colorHint, "running");
    assert.ok(
      row.coloredLine.startsWith("\x1b[1;36m"),
      `running coloredLine must START with bold cyan; got: ${JSON.stringify(row.coloredLine)}`,
    );
    assert.ok(
      row.coloredLine.endsWith("\x1b[0m"),
      `running coloredLine must end with reset; got: ${JSON.stringify(row.coloredLine)}`,
    );
  });

  test("failed state: coloredLine carries bold red prefix \\x1b[1;31m", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-f0000000001",
          state: "failed",
          endedAt: "2026-05-29T12:00:00Z",
          durationMs: 1000,
        }),
      ],
      { nowMs: NOW },
    );
    const row = out.rows[0]!;
    assert.equal(row.colorHint, "failed");
    assert.ok(
      row.coloredLine.startsWith("\x1b[1;31m"),
      `failed coloredLine must START with bold red; got: ${JSON.stringify(row.coloredLine)}`,
    );
    assert.ok(row.coloredLine.endsWith("\x1b[0m"));
  });

  test("done state: coloredLine carries bold green prefix \\x1b[1;32m", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-d0000000001",
          state: "done",
          endedAt: "2026-05-29T12:00:00Z",
          durationMs: 1000,
        }),
      ],
      { nowMs: NOW },
    );
    const row = out.rows[0]!;
    assert.equal(row.colorHint, "done");
    assert.ok(
      row.coloredLine.startsWith("\x1b[1;32m"),
      `done coloredLine must START with bold green; got: ${JSON.stringify(row.coloredLine)}`,
    );
    assert.ok(row.coloredLine.endsWith("\x1b[0m"));
  });

  test("paused state: coloredLine carries bold yellow prefix \\x1b[1;33m", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-p0000000001", state: "paused" })],
      { nowMs: NOW },
    );
    const row = out.rows[0]!;
    assert.equal(row.colorHint, "paused");
    assert.ok(
      row.coloredLine.startsWith("\x1b[1;33m"),
      `paused coloredLine must START with bold yellow; got: ${JSON.stringify(row.coloredLine)}`,
    );
    assert.ok(row.coloredLine.endsWith("\x1b[0m"));
  });

  test("stopped + cancelled-pre-run states: coloredLine carries dim prefix \\x1b[2m", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-s0000000001",
          state: "stopped",
          endedAt: "2026-05-29T12:00:00Z",
          durationMs: 1000,
        }),
        summary({
          runId: "wf-c0000000001",
          state: "cancelled-pre-run",
          endedAt: "2026-05-29T12:00:01Z",
          durationMs: 1000,
        }),
      ],
      { nowMs: NOW },
    );
    const stopped = out.rows.find((r) => r.runId === "wf-s0000000001")!;
    const cancelled = out.rows.find((r) => r.runId === "wf-c0000000001")!;
    assert.equal(stopped.colorHint, "stopped");
    assert.equal(cancelled.colorHint, "cancelled");
    assert.ok(
      stopped.coloredLine.startsWith("\x1b[2m"),
      `stopped coloredLine must START with dim; got: ${JSON.stringify(stopped.coloredLine)}`,
    );
    assert.ok(
      cancelled.coloredLine.startsWith("\x1b[2m"),
      `cancelled coloredLine must START with dim; got: ${JSON.stringify(cancelled.coloredLine)}`,
    );
    assert.ok(stopped.coloredLine.endsWith("\x1b[0m"));
    assert.ok(cancelled.coloredLine.endsWith("\x1b[0m"));
    // Belt-and-braces: dim states must NOT accidentally pick up a
    // bold-color escape (catches a swap-table mutation).
    assert.ok(
      !stopped.coloredLine.includes("\x1b[1;"),
      `stopped must not include any bold-color escape; got: ${JSON.stringify(stopped.coloredLine)}`,
    );
    assert.ok(
      !cancelled.coloredLine.includes("\x1b[1;"),
      `cancelled must not include any bold-color escape; got: ${JSON.stringify(cancelled.coloredLine)}`,
    );
  });

  test("neutral states (pending, approved): coloredLine === line, no ANSI injected", () => {
    const out = renderRunsList(
      [
        summary({ runId: "wf-pend00000001", state: "pending" }),
        summary({ runId: "wf-appr00000001", state: "approved" }),
      ],
      { nowMs: NOW },
    );
    assert.equal(out.rows.length, 2);
    for (const row of out.rows) {
      assert.equal(
        row.colorHint,
        "neutral",
        `[state=${row.state}] expected colorHint=neutral`,
      );
      assert.equal(
        row.coloredLine,
        row.line,
        `[state=${row.state}] neutral coloredLine must equal line; got: ${JSON.stringify(row.coloredLine)}`,
      );
      assert.ok(
        !ANSI_RE_TEST.test(row.coloredLine),
        `[state=${row.state}] neutral coloredLine must contain no ANSI; got: ${JSON.stringify(row.coloredLine)}`,
      );
    }
  });

  test("colorHint mapping unchanged across all states (regression after slice 9)", () => {
    const summaries: RunSummary[] = ALL_STATES.map((state, i) =>
      summary({
        runId: `wf-${state.slice(0, 4).padEnd(4, "x")}${String(i).padStart(8, "0")}`,
        state,
        ...(TERMINAL_FOR_TEST.has(state)
          ? {
              endedAt: `2026-05-29T11:5${i}:00Z`,
              durationMs: 30_000,
            }
          : {}),
      }),
    );
    const out = renderRunsList(summaries, { nowMs: NOW });
    const byState = new Map(out.rows.map((r) => [r.state, r.colorHint]));
    assert.equal(byState.get("pending"), "neutral");
    assert.equal(byState.get("approved"), "neutral");
    assert.equal(byState.get("running"), "running");
    assert.equal(byState.get("paused"), "paused");
    assert.equal(byState.get("done"), "done");
    assert.equal(byState.get("failed"), "failed");
    assert.equal(byState.get("stopped"), "stopped");
    assert.equal(byState.get("cancelled-pre-run"), "cancelled");
  });

  test("lines[] uses plain row.line — no per-state ANSI escapes leak onto row entries", () => {
    const summaries: RunSummary[] = [
      summary({ runId: "wf-running00001", state: "running" }),
      summary({ runId: "wf-paused000001", state: "paused" }),
      summary({
        runId: "wf-failed000001",
        state: "failed",
        endedAt: "2026-05-29T12:00:00Z",
        durationMs: 1000,
      }),
      summary({
        runId: "wf-done00000001",
        state: "done",
        endedAt: "2026-05-29T12:00:01Z",
        durationMs: 1000,
      }),
      summary({
        runId: "wf-stopped00001",
        state: "stopped",
        endedAt: "2026-05-29T12:00:02Z",
        durationMs: 1000,
      }),
    ];
    const out = renderRunsList(summaries, { nowMs: NOW });
    // Each row's plain line is in lines[]; the colored variant is NOT.
    for (const row of out.rows) {
      assert.ok(
        out.lines.includes(row.line),
        `lines[] must contain plain row.line for ${row.runId}`,
      );
      // coloredLine differs from line only when an ANSI prefix was
      // applied — guard the negative assertion behind that check so
      // the neutral case (coloredLine === line) doesn't false-fail.
      if (row.coloredLine !== row.line) {
        assert.ok(
          !out.lines.includes(row.coloredLine),
          `lines[] must NOT contain row.coloredLine for ${row.runId} (state=${row.state})`,
        );
      }
    }
    // Per-state color escapes (the ones from ansiPrefixFor) must not
    // appear in any row entry of lines[]. We restrict the search to
    // row entries — the header is intentionally bold per VQ-7 and
    // uses \x1b[1m which is distinct from these per-state codes.
    const rowLineSet = new Set(out.rows.map((r) => r.line));
    const rowEntries = out.lines.filter((l) => rowLineSet.has(l));
    assert.equal(
      rowEntries.length,
      out.rows.length,
      "every row.line must appear exactly once in lines[]",
    );
    for (const code of [
      "\x1b[1;36m",
      "\x1b[1;31m",
      "\x1b[1;32m",
      "\x1b[1;33m",
      "\x1b[2m",
    ]) {
      for (const entry of rowEntries) {
        assert.ok(
          !entry.includes(code),
          `row entry in lines[] must not include per-state color ${JSON.stringify(code)}; got: ${JSON.stringify(entry)}`,
        );
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────
//  P2-S4 — state grouping + hasPendingInterrupt + Completed sentinel
// ───────────────────────────────────────────────────────────────────

describe("P2-S4: state grouping (groupBy: 'state')", () => {
  test("groupBy: 'state' — running run appears under '▶  Working' header", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-run000000001", state: "running" })],
      { nowMs: NOW, groupBy: "state" },
    );
    const idx = out.lines.findIndex((l) => l.startsWith("\u25b6  Working"));
    assert.ok(idx >= 0, `expected a '▶  Working' header in lines[]; got ${JSON.stringify(out.lines)}`);
    assert.equal(
      out.lines[idx],
      "\u25b6  Working  (1)",
      "section header must include the bucket count",
    );
    // The run row must come AFTER the section header.
    assert.ok(
      out.lines[idx + 1]!.includes("wf-run000000"),
      "running row should appear immediately under the Working header",
    );
  });

  test("groupBy: 'state' — hasPendingInterrupt run lands under '⚠  Needs input', not '▶  Working'", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-int000000001",
          state: "running",
          hasPendingInterrupt: true,
        }),
      ],
      { nowMs: NOW, groupBy: "state" },
    );
    const needs = out.lines.find((l) => l.startsWith("\u26a0  Needs input"));
    const working = out.lines.find((l) => l.startsWith("\u25b6  Working"));
    assert.equal(
      needs,
      "\u26a0  Needs input  (1)",
      "running run with hasPendingInterrupt must surface under Needs input",
    );
    assert.equal(
      working,
      undefined,
      "empty Working group must be omitted entirely (no header)",
    );
  });

  test("groupBy: 'state' — empty bucket has no header", () => {
    // Only a completed run; no Needs-input, no Working.
    const out = renderRunsList(
      [
        summary({
          runId: "wf-done00000001",
          state: "done",
          endedAt: "2026-05-29T11:00:00Z",
          durationMs: 1000,
        }),
      ],
      { nowMs: NOW, groupBy: "state" },
    );
    assert.ok(
      !out.lines.some((l) => l.startsWith("\u26a0  Needs input")),
      "empty Needs input section must be omitted",
    );
    assert.ok(
      !out.lines.some((l) => l.startsWith("\u25b6  Working")),
      "empty Working section must be omitted",
    );
    assert.ok(
      out.lines.some((l) => l.startsWith("\u2713  Completed")),
      "non-empty Completed section must show its header",
    );
  });

  test("groupBy: 'state' — paused run buckets under Working (no pending interrupt)", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-paused000001", state: "paused" })],
      { nowMs: NOW, groupBy: "state" },
    );
    assert.ok(
      out.lines.some((l) => l === "\u25b6  Working  (1)"),
      "paused run without pending interrupt belongs under Working",
    );
  });

  test("groupBy: 'state' — Completed truncates to 3 with sentinel; expandCompleted shows all", () => {
    const completed = Array.from({ length: 6 }, (_, i) =>
      summary({
        runId: `wf-d${String(i).padStart(11, "0")}`,
        state: "done",
        startedAt: `2026-05-29T11:0${i}:00Z`,
        endedAt: `2026-05-29T11:0${i}:30Z`,
        durationMs: 30_000,
      }),
    );
    const collapsed = renderRunsList(completed, { nowMs: NOW, groupBy: "state" });
    assert.equal(
      collapsed.rows.length,
      3,
      "collapsed Completed shows exactly 3 rows",
    );
    assert.equal(collapsed.hiddenCompletedCount, 3);
    assert.ok(
      collapsed.lines.some((l) => l.includes("\u2026 3 more")),
      "sentinel '… 3 more' must appear when 6 completed runs collapse to 3",
    );
    // Header still reflects the full count, not the visible slice.
    assert.ok(
      collapsed.lines.some((l) => l === "\u2713  Completed  (6)"),
      "Completed header count is the FULL terminal-run count",
    );

    const expanded = renderRunsList(completed, {
      nowMs: NOW,
      groupBy: "state",
      expandCompleted: true,
    });
    assert.equal(expanded.rows.length, 6, "expanded Completed shows all 6");
    assert.ok(
      expanded.hiddenCompletedCount === undefined ||
        expanded.hiddenCompletedCount === 0,
      "no sentinel when expanded",
    );
    assert.ok(
      !expanded.lines.some((l) => l.includes(" more")),
      "no sentinel line when expandCompleted: true",
    );
  });

  test("groupBy: 'state' — sentinel suppressed at exactly 3 completed runs (no truncation)", () => {
    const three = Array.from({ length: 3 }, (_, i) =>
      summary({
        runId: `wf-d${String(i).padStart(11, "0")}`,
        state: "done",
        endedAt: `2026-05-29T11:0${i}:00Z`,
        durationMs: 1000,
      }),
    );
    const out = renderRunsList(three, { nowMs: NOW, groupBy: "state" });
    assert.equal(out.rows.length, 3);
    assert.ok(
      out.hiddenCompletedCount === undefined ||
        out.hiddenCompletedCount === 0,
    );
    assert.ok(
      !out.lines.some((l) => l.includes(" more")),
      "no sentinel when completed.length === 3",
    );
  });

  test("groupBy: 'state' — cursor on sentinel renders ▸ marker", () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      summary({
        runId: `wf-d${String(i).padStart(11, "0")}`,
        state: "done",
        endedAt: `2026-05-29T11:0${i}:00Z`,
        durationMs: 1000,
      }),
    );
    // cursor === rows.length (3) is the sentinel position.
    const out = renderRunsList(four, {
      nowMs: NOW,
      groupBy: "state",
      cursor: 3,
    });
    const sentinel = out.lines.find((l) => l.includes("more"));
    assert.ok(sentinel !== undefined);
    assert.ok(
      sentinel!.startsWith("\u25b8 "),
      `sentinel should be cursored when cursor === rows.length; got ${JSON.stringify(sentinel)}`,
    );
  });

  test("groupBy: 'state' — three sections in display order: Needs input → Working → Completed", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-int000000001",
          state: "running",
          hasPendingInterrupt: true,
        }),
        summary({ runId: "wf-run000000001", state: "running" }),
        summary({
          runId: "wf-done00000001",
          state: "done",
          endedAt: "2026-05-29T11:00:00Z",
          durationMs: 1000,
        }),
      ],
      { nowMs: NOW, groupBy: "state" },
    );
    const headerIndices = out.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) =>
        l.startsWith("\u26a0  ") ||
          l.startsWith("\u25b6  ") ||
          l.startsWith("\u2713  "),
      );
    assert.equal(headerIndices.length, 3);
    assert.ok(headerIndices[0]!.l.startsWith("\u26a0  Needs input"));
    assert.ok(headerIndices[1]!.l.startsWith("\u25b6  Working"));
    assert.ok(headerIndices[2]!.l.startsWith("\u2713  Completed"));
  });
});

describe("P2-S4: groupBy: 'time' (legacy) backward compat", () => {
  test("groupBy: 'time' — flat list, no section headers", () => {
    const out = renderRunsList(
      [
        summary({
          runId: "wf-int000000001",
          state: "running",
          hasPendingInterrupt: true,
        }),
        summary({ runId: "wf-run000000001", state: "running" }),
      ],
      { nowMs: NOW, groupBy: "time" },
    );
    assert.ok(
      !out.lines.some(
        (l) =>
          l.startsWith("\u26a0  ") ||
          l.startsWith("\u25b6  ") ||
          l.startsWith("\u2713  "),
      ),
      "groupBy: 'time' must not emit any section headers",
    );
    assert.equal(out.rows.length, 2);
  });

  test("undefined groupBy preserves legacy flat behavior (no headers, no sentinel)", () => {
    const completed = Array.from({ length: 6 }, (_, i) =>
      summary({
        runId: `wf-d${String(i).padStart(11, "0")}`,
        state: "done",
        endedAt: `2026-05-29T11:0${i}:00Z`,
        durationMs: 1000,
      }),
    );
    // No groupBy passed at all.
    const out = renderRunsList(completed, { nowMs: NOW });
    assert.equal(
      out.rows.length,
      6,
      "legacy flat sort shows every run (no truncation)",
    );
    assert.ok(
      out.hiddenCompletedCount === undefined ||
        out.hiddenCompletedCount === 0,
    );
    assert.ok(
      !out.lines.some((l) => l.includes(" more")),
      "no sentinel in legacy mode",
    );
    assert.ok(
      !out.lines.some(
        (l) =>
          l.startsWith("\u26a0  ") ||
          l.startsWith("\u25b6  ") ||
          l.startsWith("\u2713  "),
      ),
      "no section headers in legacy mode",
    );
  });
});

//
//  P2-S6 — peek panel (Space shows inline log tail).
//

describe("P2-S6: peek panel", () => {
  test("peekRunId+peekLines injects `│` rows then `└` row after the matched run", () => {
    const out = renderRunsList(
      [
        summary({ runId: "wf-peek00000001", workflowName: "alpha", state: "running" }),
        summary({ runId: "wf-peek00000002", workflowName: "beta", state: "running" }),
      ],
      {
        nowMs: NOW,
        groupBy: "state",
        peekRunId: "wf-peek00000001",
        peekLines: ["first line", "second line", "third line"],
      },
    );
    // Row count is unchanged — peek lines do NOT appear in rows[].
    assert.equal(out.rows.length, 2);
    // The peek lines appear right after the matched row in lines[].
    const matchIdx = out.lines.findIndex(
      (l) => l.includes("alpha") && l.includes("running"),
    );
    assert.ok(matchIdx >= 0, "matched row should be present in lines[]");
    assert.equal(out.lines[matchIdx + 1], "  \u2502 first line");
    assert.equal(out.lines[matchIdx + 2], "  \u2502 second line");
    assert.equal(out.lines[matchIdx + 3], "  \u2514 third line");
  });

  test("peekRunId+empty peekLines emits a single `└ (no log entries yet)` placeholder", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-empty0000001", workflowName: "alpha", state: "running" })],
      { nowMs: NOW, groupBy: "state", peekRunId: "wf-empty0000001", peekLines: [] },
    );
    const placeholder = out.lines.find((l) => l.includes("(no log entries yet)"));
    assert.ok(placeholder !== undefined, "placeholder line must be emitted");
    assert.ok(placeholder!.startsWith("  \u2514 "), "placeholder uses └ glyph");
  });

  test("peekRunId pointing at a run not in the visible list silently no-ops", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-visible0001", workflowName: "alpha", state: "running" })],
      { nowMs: NOW, groupBy: "state", peekRunId: "wf-missing0001", peekLines: ["x", "y"] },
    );
    // No peek lines anywhere.
    assert.ok(
      !out.lines.some((l) => l.startsWith("  \u2502 ") || l.startsWith("  \u2514 ")),
      "no peek glyphs when peekRunId is absent from the visible list",
    );
  });

  test("undefined peekRunId — no peek lines, no behavior change", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-plain0000001", workflowName: "alpha", state: "running" })],
      { nowMs: NOW, groupBy: "state" },
    );
    assert.ok(
      !out.lines.some((l) => l.startsWith("  \u2502 ") || l.startsWith("  \u2514 ")),
      "no peek output when peekRunId is undefined",
    );
  });

  test("peek lines do not affect cursor row index (`rows[]` order unchanged)", () => {
    const runsArr = [
      summary({ runId: "wf-peek00000001", workflowName: "alpha", state: "running" }),
      summary({ runId: "wf-peek00000002", workflowName: "beta", state: "running" }),
    ];
    const baseline = renderRunsList(runsArr, { nowMs: NOW, groupBy: "state" });
    const peeked = renderRunsList(runsArr, {
      nowMs: NOW,
      groupBy: "state",
      peekRunId: "wf-peek00000001",
      peekLines: ["a", "b"],
    });
    assert.deepEqual(
      peeked.rows.map((r) => r.runId),
      baseline.rows.map((r) => r.runId),
    );
  });

  test("peek works in groupBy: 'time' mode too", () => {
    const out = renderRunsList(
      [summary({ runId: "wf-flat00000001", workflowName: "alpha", state: "running" })],
      {
        nowMs: NOW,
        groupBy: "time",
        peekRunId: "wf-flat00000001",
        peekLines: ["only"],
      },
    );
    assert.ok(
      out.lines.some((l) => l === "  \u2514 only"),
      "peek tail emits └ row in flat (time-grouped) mode",
    );
  });
});
