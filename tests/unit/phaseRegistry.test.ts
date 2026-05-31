/**
 * tests/unit/phaseRegistry.test.ts — token aggregation in PhaseRegistry.
 *
 * Verifies that agent.ended events with usage data correctly update
 * PhaseSnapshot.totalTokens / cachedTokens, and that RunPhaseSnapshot
 * sums across phases.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";

const RUN_ID = "wf-token-test";

function usage(totalTokens: number, cacheRead = 0) {
  return {
    input: Math.max(0, totalTokens - cacheRead),
    output: 0,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
  };
}

test("PhaseRegistry: agent.ended with usage increments phase totalTokens", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "analyze", agentCount: 2 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.started",
    data: { runId: RUN_ID, phaseName: "analyze", agentId: "a0" },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "analyze",
      agentId: "a0",
      cached: false,
      usage: usage(5000),
    },
  });

  const snap = reg.getRunSnapshot(RUN_ID)!;
  const phase = snap.phases.find((p) => p.phaseName === "analyze")!;
  assert.equal(phase.totalTokens, 5000);
  assert.equal(phase.cachedTokens, 0);
});

test("PhaseRegistry: cached agent.ended adds to cachedTokens", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "recon", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "recon",
      agentId: "a0",
      cached: true,
      usage: usage(3200),
    },
  });

  const snap = reg.getRunSnapshot(RUN_ID)!;
  const phase = snap.phases.find((p) => p.phaseName === "recon")!;
  assert.equal(phase.totalTokens, 3200);
  assert.equal(phase.cachedTokens, 3200);
});

test("PhaseRegistry: multiple agents accumulate correctly", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "build", agentCount: 3 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "build",
      agentId: "b0",
      cached: false,
      usage: usage(10_000),
    },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "build",
      agentId: "b1",
      cached: true,
      usage: usage(4_000),
    },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "build",
      agentId: "b2",
      cached: false,
      // no usage — should contribute 0
    },
  });

  const snap = reg.getRunSnapshot(RUN_ID)!;
  const phase = snap.phases.find((p) => p.phaseName === "build")!;
  assert.equal(phase.totalTokens, 14_000);
  assert.equal(phase.cachedTokens, 4_000);
});

test("PhaseRegistry: RunPhaseSnapshot sums tokens across phases", () => {
  const reg = new PhaseRegistry();
  // Phase 1
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "phase-a", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "phase-a",
      agentId: "a0",
      cached: false,
      usage: usage(8_000),
    },
  });
  // Phase 2
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "phase-b", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: {
      runId: RUN_ID,
      phaseName: "phase-b",
      agentId: "b0",
      cached: true,
      usage: usage(2_500),
    },
  });

  const snap = reg.getRunSnapshot(RUN_ID)!;
  assert.equal(snap.totalTokens, 10_500, "run totalTokens should sum across phases");
  assert.equal(snap.cachedTokens, 2_500, "run cachedTokens should sum cached-only");
});

test("PhaseRegistry: re-applying agent.ended is idempotent for token totals", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "idem", agentCount: 1 },
  });
  const endedEntry = {
    customType: "pi-workflows.agent.ended" as const,
    data: {
      runId: RUN_ID,
      phaseName: "idem",
      agentId: "x0",
      cached: false,
      usage: usage(6_000),
    },
  };
  reg.applyEntry(endedEntry);
  // Apply again (simulates duplicate overlay event)
  reg.applyEntry(endedEntry);

  const snap = reg.getRunSnapshot(RUN_ID)!;
  const phase = snap.phases.find((p) => p.phaseName === "idem")!;
  assert.equal(phase.totalTokens, 6_000, "idempotent re-apply must not double-count");
});

test("PhaseRegistry: agent.ended without usage leaves totals at 0", () => {
  const reg = new PhaseRegistry();
  reg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId: RUN_ID, phaseName: "nousage", agentCount: 1 },
  });
  reg.applyEntry({
    customType: "pi-workflows.agent.ended",
    data: { runId: RUN_ID, phaseName: "nousage", agentId: "n0" },
  });

  const snap = reg.getRunSnapshot(RUN_ID)!;
  const phase = snap.phases.find((p) => p.phaseName === "nousage")!;
  assert.equal(phase.totalTokens, 0);
  assert.equal(phase.cachedTokens, 0);
  assert.equal(snap.totalTokens, 0);
});
