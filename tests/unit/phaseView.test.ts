/**
 * tests/unit/phaseView.test.ts — slice 14 phase view render contract.
 *
 * Pure-render coverage. Asserts:
 *   - Header line carries runId/workflowName/state/elapsed.
 *   - Phase glyphs map: ✓ done, ▸ running, · pending.
 *   - Active phase shows agent rows; done phase collapsed; pending phase line-only.
 *   - Cursor highlight applies to agentRows[cursor].
 *   - Log tail renders last N entries, HH:MM:SS prefix.
 *   - Help bullets thread through.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderPhaseView } from "../../src/runtime/phaseView.js";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";
import type { RunSummary } from "../../src/runtime/activeRuns.js";

const FIXED_NOW = Date.parse("2026-05-29T12:05:00Z");

const baseSummary: RunSummary = {
  runId: "wf-9f3a2c8e",
  workflowName: "codebase-audit",
  state: "running",
  startedAt: "2026-05-29T12:01:48Z",
  runDir: "/tmp/runs/wf-9f3a2c8e",
};

function seededRegistry(): PhaseRegistry {
  const reg = new PhaseRegistry();
  // Phase recon — done, 1 agent.
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "recon", agentCount: 1, startedAt: "2026-05-29T12:01:48Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: baseSummary.runId, phaseName: "recon", agentId: "recon-0", startedAt: "2026-05-29T12:01:48Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: { runId: baseSummary.runId, phaseName: "recon", agentId: "recon-0", endedAt: "2026-05-29T12:02:00Z", durationMs: 12_000 },
  });
  reg.applyEntry({
    customType: "pi-workflows.phase.ended",
    data: { runId: baseSummary.runId, phaseName: "recon", endedAt: "2026-05-29T12:02:00Z", durationMs: 12_000 },
  });
  // Phase analyze — running, 3 agents (1 done cached, 1 running, 1 queued — well, only "running" ones get rendered as agent rows so we'll inject one queued by NOT firing started).
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "analyze", agentCount: 3, startedAt: "2026-05-29T12:02:00Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: baseSummary.runId, phaseName: "analyze", agentId: "analyze-0", startedAt: "2026-05-29T12:04:00Z", summary: "auth-utils" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: baseSummary.runId, phaseName: "analyze", agentId: "analyze-1", startedAt: "2026-05-29T12:02:00Z", summary: "config" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: { runId: baseSummary.runId, phaseName: "analyze", agentId: "analyze-1", endedAt: "2026-05-29T12:02:30Z", durationMs: 30_000, cached: true },
  });
  // Log entries
  reg.applyEntry({
    customType: "pi-workflows.run.log",
    data: { runId: baseSummary.runId, at: "2026-05-29T12:02:00Z", message: "phase analyze starting" },
  });
  reg.applyEntry({
    customType: "pi-workflows.run.log",
    data: { runId: baseSummary.runId, at: "2026-05-29T12:02:30Z", message: "agent analyze-1 cache hit" },
  });
  return reg;
}

test("phase view: header + subtitle + phase glyphs + agent rows", () => {
  const reg = seededRegistry();
  const snap = reg.getRunSnapshot(baseSummary.runId);
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });

  // Header
  assert.match(out.title, /^wf-9f3a2c8e\s+codebase-audit\s+running/);
  assert.match(out.subtitle, /Started: /);
  assert.match(out.subtitle, /Path: /);

  const lines = out.lines.join("\n");
  // Phase glyph mapping
  assert.match(lines, /✓ recon/);
  assert.match(lines, /▸ analyze/);
  // Done phase rendered as collapsed summary (no agent rows)
  assert.equal(out.lines.filter((l) => l.includes("recon-0")).length, 0);
  // Active phase rendered with agent rows
  assert.match(lines, /● analyze-0/);
  assert.match(lines, /✓ analyze-1/);
  // Cached agent gets the (cached) marker
  assert.match(lines, /\(cached\)/);
});

test("phase view: cursor highlights the selected agent row", () => {
  const reg = seededRegistry();
  const snap = reg.getRunSnapshot(baseSummary.runId);
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW, cursor: 0 });
  // First agent row gets `▸` prefix
  const cursorLine = out.lines.find((l) => l.includes("▸ ●") || l.includes("▸ ✓"));
  assert.ok(cursorLine !== undefined, `expected a ▸-prefixed agent row in:\n${out.lines.join("\n")}`);
});

test("phase view: log tail renders last entries with HH:MM:SS prefix", () => {
  const reg = seededRegistry();
  const snap = reg.getRunSnapshot(baseSummary.runId);
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const logLines = out.lines.filter((l) => l.match(/^\s+\d\d:\d\d:\d\d\s+/));
  assert.ok(logLines.length >= 2, `expected ≥2 log lines, got ${logLines.length}`);
  assert.ok(logLines.some((l) => l.includes("phase analyze starting")));
});

test("phase view: empty snapshot renders '(no phases yet)'", () => {
  const out = renderPhaseView(baseSummary, undefined, { nowMs: FIXED_NOW });
  assert.match(out.lines.join("\n"), /\(no phases yet\)/);
});

test("phase view: help bullets thread through", () => {
  const out = renderPhaseView(baseSummary, undefined, {
    nowMs: FIXED_NOW,
    help: [
      { key: "Esc", label: "back", disabled: false },
      { key: "s", label: "save script", disabled: true },
    ],
  });
  const helpLine = out.lines.at(-1) ?? "";
  assert.match(helpLine, /\[Esc\] back/);
  assert.match(helpLine, /\(s save script\)/);
});

test("phase view: banner inserted under subtitle", () => {
  const out = renderPhaseView(baseSummary, undefined, {
    nowMs: FIXED_NOW,
    banner: "saving script…",
  });
  // banner line must appear before "Phases" header
  const bannerIdx = out.lines.findIndex((l) => l === "saving script…");
  const phasesIdx = out.lines.findIndex((l) => l === "Phases");
  assert.ok(bannerIdx > 0 && bannerIdx < phasesIdx);
});

test("PhaseRegistry: agent counts roll up correctly", () => {
  const reg = seededRegistry();
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  // recon (1 done) + analyze (1 running + 1 done) = 3 total, 1 running, 2 done
  assert.equal(snap.totalAgents, 3);
  assert.equal(snap.runningAgents, 1);
  assert.equal(snap.completedAgents, 2);
});

test("PhaseRegistry: forgetRun + reset cleanup", () => {
  const reg = seededRegistry();
  assert.ok(reg.hasRun(baseSummary.runId));
  reg.forgetRun(baseSummary.runId);
  assert.equal(reg.hasRun(baseSummary.runId), false);
  reg.reset();
  assert.equal(reg.getRunSnapshot(baseSummary.runId), undefined);
});

test("PhaseRegistry: subscriber fires on mutation, microtask-coalesced", async () => {
  const reg = new PhaseRegistry();
  let calls = 0;
  reg.subscribe(() => calls++);
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: "wf-1", phaseName: "p", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: "wf-1", phaseName: "p", agentId: "a-0" },
  });
  // Two synchronous mutations should coalesce to one microtask fire.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1, `expected coalesced fire, got ${calls}`);
});

// ──────────────────────────────────────────────────────────────
// Token rendering tests
// ──────────────────────────────────────────────────────────────

import { fmtTokens } from "../../src/runtime/phaseView.js";

test("fmtTokens: < 1000 → N tok", () => {
  assert.equal(fmtTokens(0), "0 tok");
  assert.equal(fmtTokens(999), "999 tok");
  assert.equal(fmtTokens(1), "1 tok");
});

test("fmtTokens: >= 1000 → X.Xk tok", () => {
  assert.equal(fmtTokens(1000), "1.0k tok");
  assert.equal(fmtTokens(1500), "1.5k tok");
  assert.equal(fmtTokens(42_300), "42.3k tok");
  assert.equal(fmtTokens(999_999), "1000.0k tok");
});

test("fmtTokens: >= 1_000_000 → X.XM tok", () => {
  assert.equal(fmtTokens(1_000_000), "1.0M tok");
  assert.equal(fmtTokens(2_500_000), "2.5M tok");
});

test("phase view: done phase shows token count when available", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "tok-phase", agentCount: 1, startedAt: "2026-05-29T12:01:00Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: baseSummary.runId,
      phaseName: "tok-phase",
      agentId: "t0",
      cached: false,
      durationMs: 5000,
      usage: { input: 10000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 10500 },
    },
  });
  reg.applyEntry({
    customType: "pi-workflows.phase.ended",
    data: { runId: baseSummary.runId, phaseName: "tok-phase", durationMs: 5000 },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const lines = out.lines.join("\n");
  assert.match(lines, /10\.5k tok/, "done phase should show token count");
});

test("phase view: done phase shows cached segment when cachedTokens > 0", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "cached-phase", agentCount: 1, startedAt: "2026-05-29T12:01:00Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: baseSummary.runId,
      phaseName: "cached-phase",
      agentId: "c0",
      cached: true,
      durationMs: 3000,
      usage: { input: 8000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 8200 },
    },
  });
  reg.applyEntry({
    customType: "pi-workflows.phase.ended",
    data: { runId: baseSummary.runId, phaseName: "cached-phase", durationMs: 3000 },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const lines = out.lines.join("\n");
  assert.match(lines, /8\.2k tok.*cached/, "done phase with cached agents should show cached segment");
});

test("phase view: run-level Total line appears when tokens present", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "p1", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: baseSummary.runId,
      phaseName: "p1",
      agentId: "x0",
      usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5100 },
    },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const lines = out.lines.join("\n");
  assert.match(lines, /Total:.*5\.1k tok/, "run header should show total token count");
});

test("phase view: no Total line when no token data", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "p2", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: { runId: baseSummary.runId, phaseName: "p2", agentId: "y0" },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const lines = out.lines.join("\n");
  assert.ok(!lines.includes("Total:"), "should not render Total line with no token data");
});

// ──────────────────────────────────────────────────────────────
// VQ-3 / Slice 2: column overflow truncation
// ──────────────────────────────────────────────────────────────

test("phase view: long phase name truncates to 14 chars with ellipsis", () => {
  const reg = new PhaseRegistry();
  // "reconcile-outputs" is 17 chars — pad(str, 14) → slice(0,13) + "…" = "reconcile-out…" (14 chars)
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "reconcile-outputs", agentCount: 1, startedAt: "2026-05-29T12:01:00Z" },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const phaseLine = out.lines.find((l) => l.includes("reconcile-out"));
  assert.ok(phaseLine !== undefined, "expected a truncated phase-name line");
  // Must NOT contain the raw 17-char name followed by a space (i.e. untruncated)
  assert.ok(!phaseLine.includes("reconcile-outputs "), "raw 17-char name must not appear in line");
  // Must contain the truncated name + ellipsis
  assert.ok(phaseLine.includes("reconcile-out\u2026"), `expected 'reconcile-out\u2026' in: ${phaseLine}`);
  // The truncated cell must be exactly 14 chars wide
  const match = phaseLine.match(/^[·▸✓] (.{14}) /);
  assert.ok(match !== null, `phase name column must be exactly 14 chars wide in: ${phaseLine}`);
});

test("phase view: long agent id truncates to 14 chars in agent row", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "p-trunc", agentCount: 1, startedAt: "2026-05-29T12:01:00Z" },
  });
  // "very-long-agent-identifier" is 26 chars — pad(str, 14) → "very-long-age\u2026" (14 chars)
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: baseSummary.runId, phaseName: "p-trunc", agentId: "very-long-agent-identifier", startedAt: "2026-05-29T12:01:01Z" },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const agentLine = out.lines.find((l) => l.includes("very-long-age"));
  assert.ok(agentLine !== undefined, "expected an agent row with truncated id");
  assert.ok(!agentLine.includes("very-long-agent-identifier "), "raw 26-char agent id must not appear");
  assert.ok(
    agentLine.includes("very-long-age\u2026"),
    `expected 'very-long-age\u2026' in: ${agentLine}`,
  );
});

test("phase view: long agent summary truncates at COL_SUMMARY", () => {
  const longSummary = "a".repeat(50);
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: baseSummary.runId, phaseName: "p-sum", agentCount: 1, startedAt: "2026-05-29T12:01:00Z" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: baseSummary.runId, phaseName: "p-sum", agentId: "agent-sum", startedAt: "2026-05-29T12:01:01Z", summary: longSummary },
  });
  const snap = reg.getRunSnapshot(baseSummary.runId)!;
  const out = renderPhaseView(baseSummary, snap, { nowMs: FIXED_NOW });
  const agentLine = out.lines.find((l) => l.includes("agent-sum"));
  assert.ok(agentLine !== undefined, "expected an agent row");
  // The 50-char summary must not appear verbatim
  assert.ok(!agentLine.includes(longSummary), "unbounded summary must not appear in line");
  // Must end with ellipsis in the summary region
  assert.ok(agentLine.includes("\u2026"), "summary must be truncated with ellipsis");
});
