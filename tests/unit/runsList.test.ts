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

import test from "node:test";
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
