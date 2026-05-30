/**
 * tests/integration/ctxVoteRoundTrip.test.ts
 *
 * End-to-end test for `ctx.vote()` running through a real (mock-agents)
 * workflow run. Exercises the full path:
 *
 *   workflow source → Sandbox → ctx.vote → ctx.phase("vote") →
 *   dispatcher mock → ledger entries → result
 *
 * Uses the new ledger assertion helpers from tests/helpers/ledgerAssertions.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkflowRun } from "../../src/runManager.js";
import { sha256 } from "../../src/util/hash.js";
import { LedgerReader } from "../../src/runtime/ledger.js";
import type { WorkflowFile } from "../../src/types/internal.js";
import {
  assertPhaseCompleted,
  assertAgentCalledWith,
  assertPhasesOrdered,
  readLedgerEntries,
} from "../helpers/ledgerAssertions.js";

// ─── Inline workflow source ──────────────────────────────────────────────────

/**
 * A small self-contained workflow that uses ctx.vote() with 3 voters.
 * The voters all receive the same prompt; the judge tallies first-letter
 * votes (A / B / C) and returns the plurality winner.
 */
const VOTE_WORKFLOW_SOURCE = `
export const meta = { name: "vote-test", description: "ctx.vote round-trip test", version: "1.0.0" };
export default async function main(ctx) {
  const question = "Which option is best? Vote A, B, or C. Reply with exactly one letter.";
  const voters = [0, 1, 2].map((i) =>
    ctx.agent(question, { id: \`voter-\${i}\` })
  );
  const { winner } = await ctx.vote(voters, (responses) => {
    const tally = {};
    for (const r of responses) {
      const c = r.trim().toUpperCase().slice(0, 1);
      tally[c] = (tally[c] || 0) + 1;
    }
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] ?? "A";
  });
  return winner;
}
`.trimStart();

// ─── Prompt used by the workflow ─────────────────────────────────────────────

const VOTER_PROMPT = "Which option is best? Vote A, B, or C. Reply with exactly one letter.";

// ─── Fixture builder ─────────────────────────────────────────────────────────

/**
 * Build fixtures.jsonl for the three voter agents.
 * Voters 0 and 1 vote "B", voter 2 votes "A" — majority winner is "B".
 */
function buildFixtures(): string {
  const promptHash = sha256(VOTER_PROMPT);
  const votes = ["B", "B", "A"];
  const lines = votes.map((vote, i) =>
    JSON.stringify({
      agentId: `voter-${i}`,
      promptHash,
      result: {
        text: vote,
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
      },
    }),
  );
  return lines.join("\n") + "\n";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { runsRoot: string; resolveRunDir: (id: string) => string } {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-vote-"));
  return {
    runsRoot,
    resolveRunDir(id: string) {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "vote-test", absPath, scope: "personal" };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("ctx.vote round-trip: majority winner returned", { timeout: 30_000 }, async () => {
  const { runsRoot, resolveRunDir } = makeTmpDir();

  // Write the inline workflow to a temp file (startWorkflowRun needs absPath).
  const workflowPath = join(runsRoot, "vote-test.js");
  writeFileSync(workflowPath, VOTE_WORKFLOW_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(workflowPath), "", {
    mockAgents: true,
    preApproved: true,
    resolveRunDir,
    seedFixturesJsonl: buildFixtures(),
    perRunAgentCap: 10,
  });

  const result = await run.promise as string;

  // Voters 0+1 vote "B", voter 2 votes "A" → winner is "B".
  assert.equal(result, "B", `expected winner "B", got "${result}"`);
});

test("ctx.vote round-trip: run status is done", { timeout: 30_000 }, async () => {
  const { runsRoot, resolveRunDir } = makeTmpDir();
  const workflowPath = join(runsRoot, "vote-test.js");
  writeFileSync(workflowPath, VOTE_WORKFLOW_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(workflowPath), "", {
    mockAgents: true,
    preApproved: true,
    resolveRunDir,
    seedFixturesJsonl: buildFixtures(),
    perRunAgentCap: 10,
  });
  await run.promise;

  const { outcome } = await run.terminated;
  assert.equal(outcome, "done", `expected outcome "done", got "${outcome}"`);
});

test("ctx.vote round-trip: ledger has phase_start + phase_end for 'vote'", { timeout: 30_000 }, async () => {
  const { runsRoot, resolveRunDir } = makeTmpDir();
  const workflowPath = join(runsRoot, "vote-test.js");
  writeFileSync(workflowPath, VOTE_WORKFLOW_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(workflowPath), "", {
    mockAgents: true,
    preApproved: true,
    resolveRunDir,
    seedFixturesJsonl: buildFixtures(),
    perRunAgentCap: 10,
  });
  await run.promise;
  await run.terminated;

  const reader = new LedgerReader({
    runId: run.runId,
    resolveLedgerPath: () => join(run.runDirAbs, "ledger.jsonl"),
  });
  const { entries } = await reader.read();

  // Phase-level assertions via helpers
  assertPhaseCompleted(entries, "vote");
  assertPhasesOrdered(entries, ["vote"]);
});

test("ctx.vote round-trip: all 3 voter agent_start entries present with correct prompt", { timeout: 30_000 }, async () => {
  const { runsRoot, resolveRunDir } = makeTmpDir();
  const workflowPath = join(runsRoot, "vote-test.js");
  writeFileSync(workflowPath, VOTE_WORKFLOW_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(workflowPath), "", {
    mockAgents: true,
    preApproved: true,
    resolveRunDir,
    seedFixturesJsonl: buildFixtures(),
    perRunAgentCap: 10,
  });
  await run.promise;
  await run.terminated;

  // Use readLedgerEntries helper
  const entries = await readLedgerEntries(join(run.runDirAbs, "ledger.jsonl"));

  // All three voters must appear in the ledger with the correct prompt hash
  for (let i = 0; i < 3; i++) {
    assertAgentCalledWith(entries, `voter-${i}`, VOTER_PROMPT);
  }

  // Count agent_start entries in "vote" phase
  const voteAgentStarts = entries.filter(
    (e) =>
      e.type === "agent_start" &&
      (e as Extract<typeof e, { type: "agent_start" }>).phaseName === "vote",
  );
  assert.equal(
    voteAgentStarts.length,
    3,
    `expected 3 agent_start entries in "vote" phase, got ${voteAgentStarts.length}`,
  );
});

test("ctx.vote round-trip: assertAgentCalledWith throws on RegExp", () => {
  const fakeEntries = [
    {
      type: "agent_start" as const,
      at: "2026-01-01T00:00:00.000Z",
      phaseName: "vote",
      agentId: "voter-0",
      promptHash: "abc123",
    },
  ];
  assert.throws(
    () => assertAgentCalledWith(fakeEntries, "voter-0", /pattern/),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.ok((err as TypeError).message.includes("RegExp"));
      return true;
    },
  );
});

test("ctx.vote round-trip: assertPhaseCompleted throws on missing phase", () => {
  const entries = [
    { type: "phase_start" as const, at: "2026-01-01T00:00:00.000Z", phaseName: "recon", agentCount: 1 },
    { type: "phase_end" as const, at: "2026-01-01T00:00:01.000Z", phaseName: "recon", durationMs: 100, agentResults: { ok: 1, error: 0, cacheHit: 0 } },
  ];
  assert.throws(
    () => assertPhaseCompleted(entries, "vote"),
    /no phase_start entry found for phase "vote"/,
  );
});

test("ctx.vote round-trip: assertPhasesOrdered detects wrong order", () => {
  const entries = [
    { type: "phase_start" as const, at: "2026-01-01T00:00:00.000Z", phaseName: "analyze", agentCount: 1 },
    { type: "phase_start" as const, at: "2026-01-01T00:00:01.000Z", phaseName: "recon", agentCount: 1 },
  ];
  assert.throws(
    () => assertPhasesOrdered(entries, ["recon", "analyze"]),
    /assertPhasesOrdered/,
  );
});
