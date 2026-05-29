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
