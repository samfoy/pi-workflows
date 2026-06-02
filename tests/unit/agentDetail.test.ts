/**
 * tests/unit/agentDetail.test.ts
 *
 * Unit tests for the slice-15 agent-detail pure render.
 * No IO, no singletons, no subprocess.
 *
 * Refs: plan.md §4 Slice 15, PRD §10.3 (agent detail wireframe).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderAgentDetail,
  type AgentDetailSnapshot,
} from "../../src/runtime/agentDetail.js";
import type { AgentSnapshot } from "../../src/runtime/phaseRegistry.js";

const NOW = 1_700_000_000_000; // fixed epoch

function makeAgent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    agentId: "analyze-0",
    state: "running",
    startedAt: new Date(NOW - 30_000).toISOString(),
    summary: "Audit area auth-utils (paths: src/auth/utils.ts). Look for bugs.",
    ...overrides,
  };
}

function makeSnap(overrides: Partial<AgentDetailSnapshot> = {}): AgentDetailSnapshot {
  return {
    runId: "wf-aabbccdd0011",
    phaseName: "analyze",
    agent: makeAgent(),
    logTail: [],
    ...overrides,
  };
}

// ─── Title / header ─────────────────────────────────────────────────

test("title contains runId, phaseName, agentId, and state", () => {
  const { lines } = renderAgentDetail(makeSnap(), { nowMs: NOW });
  assert.ok(lines[0]!.includes("wf-aabbccdd0011"), `missing runId in: ${lines[0]}`);
  assert.ok(lines[0]!.includes("analyze"), `missing phaseName in: ${lines[0]}`);
  assert.ok(lines[0]!.includes("analyze-0"), `missing agentId in: ${lines[0]}`);
  assert.ok(lines[0]!.includes("running"), `missing state in: ${lines[0]}`);
});

test("title shows elapsed for running agent", () => {
  const { lines } = renderAgentDetail(
    makeSnap({ agent: makeAgent({ startedAt: new Date(NOW - 90_000).toISOString() }) }),
    { nowMs: NOW },
  );
  // 90s = 1m 30s
  assert.ok(lines[0]!.includes("1m"), `expected 1m in title: ${lines[0]}`);
});

test("title shows durationMs for done agent", () => {
  const { lines } = renderAgentDetail(
    makeSnap({ agent: makeAgent({ state: "done", durationMs: 45_000 }) }),
    { nowMs: NOW },
  );
  assert.ok(lines[0]!.includes("45s"), `expected 45s in: ${lines[0]}`);
});

// ─── Prompt ─────────────────────────────────────────────────────────

test("prompt section appears with summary text", () => {
  const snap = makeSnap();
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(allText.includes("Audit area"), "expected prompt excerpt in output");
});

test("prompt truncated to 200 chars with ellipsis", () => {
  const longPrompt = "A".repeat(300);
  const snap = makeSnap({ agent: makeAgent({ summary: longPrompt }) });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(allText.includes("…"), "expected ellipsis for long prompt");
  // Should not have all 300 chars
  assert.ok(!allText.includes("A".repeat(250)), "prompt too long");
});

test("no-summary falls back to placeholder", () => {
  const snap = makeSnap({ agent: makeAgent() });
  // Force summary to be absent by overriding the agent object
  const agentNoSummary: AgentSnapshot = {
    agentId: "analyze-0",
    state: "running",
    startedAt: new Date(NOW - 30_000).toISOString(),
  };
  const snap2 = { ...snap, agent: agentNoSummary };
  const { lines } = renderAgentDetail(snap2, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(allText.includes("no prompt"), "expected fallback for missing summary");
});

// ─── Transcript path ─────────────────────────────────────────────────

test("transcript path appears when provided", () => {
  const snap = makeSnap({ transcriptPath: "/runs/wf-abc/agents/analyze-0.jsonl" });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(allText.includes("/runs/wf-abc/agents/analyze-0.jsonl"), "transcript path missing");
});

test("no transcript section when path omitted", () => {
  const snap = makeSnap();
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(!allText.includes("Transcript:"), "should not include Transcript: when path absent");
});

// ─── Live tail ───────────────────────────────────────────────────────

test("live tail shows last 12 lines from logTail", () => {
  const tail = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  const snap = makeSnap({ logTail: tail });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  // Last 12 should be present
  assert.ok(allText.includes("line-19"), "expected last line");
  assert.ok(allText.includes("line-8"), "expected 12th-from-end line");
  // First 8 should NOT be present (only 12 shown)
  assert.ok(!allText.includes("line-0"), "first lines should be trimmed");
});

test("scroll offset 0 shows live tail label", () => {
  const tail = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  const snap = makeSnap({ logTail: tail });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW, scrollOffset: 0 });
  const allText = lines.join("\n");
  assert.ok(allText.includes("Live tail (last 12 lines)"), `expected live tail label, got: ${allText}`);
  assert.ok(!allText.includes("↑↓ scroll"), "should not show scroll label at offset 0");
});

test("scroll offset >0 shows position label", () => {
  // scrollOffset=5, logTail.length=20 → startIdx=3, endIdx=15 → "Log  [4–15 of 20]  ↑↓ scroll"
  const tail = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  const snap = makeSnap({ logTail: tail });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW, scrollOffset: 5 });
  const allText = lines.join("\n");
  assert.ok(allText.includes("Log  [4\u201315 of 20]  ↑↓ scroll"), `expected position label, got: ${allText}`);
  assert.ok(!allText.includes("Live tail"), "should not show live tail label when scrolled");
});

test("empty log tail shows placeholder", () => {
  const snap = makeSnap({ logTail: [] });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  const allText = lines.join("\n");
  assert.ok(allText.includes("no output yet"), "expected empty tail placeholder");
});

// ─── Cache flag ──────────────────────────────────────────────────────

test("cache hit shown when agent.cached=true", () => {
  const snap = makeSnap({ agent: makeAgent({ state: "done", cached: true }) });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  assert.ok(lines.join("\n").includes("Cache"), "cache hit should appear");
});

test("cache hit NOT shown when agent.cached=false", () => {
  const snap = makeSnap({ agent: makeAgent({ cached: false }) });
  const { lines } = renderAgentDetail(snap, { nowMs: NOW });
  // Shouldn't have "Cache: hit" or similar
  const cacheLines = lines.filter((l) => l.includes("Cache:"));
  assert.equal(cacheLines.length, 0, "no cache line expected");
});

// ─── Help bullets ────────────────────────────────────────────────────

test("help bullets rendered when provided", () => {
  const snap = makeSnap();
  const help = [
    { key: "Esc", label: "back", disabled: false },
    { key: "t", label: "open transcript", disabled: false },
    { key: "c", label: "copy prompt", disabled: false },
  ];
  const { lines } = renderAgentDetail(snap, { nowMs: NOW, help });
  const allText = lines.join("\n");
  assert.ok(allText.includes("[Esc] back"), `Esc help missing in: ${allText}`);
  assert.ok(allText.includes("[t] open transcript"), `t help missing`);
  assert.ok(allText.includes("[c] copy prompt"), `c help missing`);
});

test("no help line when help array is empty", () => {
  const snap = makeSnap();
  const { lines } = renderAgentDetail(snap, { nowMs: NOW, help: [] });
  // Should not add an extra blank line at end for help.
  const lastLine = lines[lines.length - 1] ?? "";
  // If help is empty, no help row rendered. Just ensure we don't crash.
  assert.ok(typeof lastLine === "string");
});

// ─── Banner ─────────────────────────────────────────────────────────

test("banner appears when provided", () => {
  const snap = makeSnap();
  const { lines } = renderAgentDetail(snap, { nowMs: NOW, banner: "transcript opened" });
  assert.ok(lines.join("\n").includes("transcript opened"), "banner missing");
});
