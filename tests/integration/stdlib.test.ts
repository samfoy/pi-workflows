/**
 * tests/integration/stdlib.test.ts — slice 8b end-to-end.
 *
 * Exercises ctx.vote / ctx.consensus / ctx.parallel / ctx.retry /
 * ctx.sleep against the mock-agents path so no real `pi -p` subprocess
 * is spawned. Each test seeds `fixtures.jsonl` with deterministic
 * (agentId, promptHash) → text mappings, runs the workflow fixture,
 * and asserts the helper's return shape + cross-realm reconstruction.
 *
 * Per plan.md §4 Slice 8b acceptance:
 *   - vote: judge-selected winner returned.
 *   - consensus: agreed=true at default threshold when responses
 *     overlap; majorityText is one of the responses.
 *   - parallel: fn returning array flattens into one phase.
 *   - retry: re-invokes on rejection up to attempts; AbortSignal
 *     propagation tested in the unit suite (sandbox-direct).
 *
 * Per plan.md §4 Slice 8b critic checklist:
 *   - vote's judge can be sync or async (sync covered in fixture,
 *     async covered in unit suite).
 *   - consensus 1-agent case → agreed=true (covered in unit suite).
 *   - retry honors AbortSignal — sandbox-direct unit test.
 *   - sleep listener cleanup on natural resolution — unit test.
 *   - parallel fn returning an array flattens into a single phase —
 *     verified here by checking ledger has exactly one
 *     phase_start/phase_end pair around all three agents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.js";
import { sha256 } from "../../src/util/hash.js";

function makeTmpRun(): { runsRoot: string; resolveRunDir: (id: string) => string } {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-stdlib-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function fixturesFor(
  prompts: { agentId: string; prompt: string; text: string }[],
): string {
  return (
    prompts
      .map((p) =>
        JSON.stringify({
          agentId: p.agentId,
          promptHash: sha256(p.prompt),
          result: {
            text: p.text,
            usage: { input: 1, output: 1, totalTokens: 2 },
          },
        }),
      )
      .join("\n") + "\n"
  );
}

const wf = (name: string, absPath: string): WorkflowFile => ({
  name,
  absPath,
  scope: "personal",
});

function copyFixture(srcRel: string, dstAbs: string): void {
  const src = new URL("../fixtures/workflows/" + srcRel, import.meta.url)
    .pathname;
  writeFileSync(dstAbs, readFileSync(src, "utf8"));
}

test("ctx.vote: judge picks winner from agent responses", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "vote.workflow.js");
  copyFixture("vote.workflow.js", wfPath);

  const seed = fixturesFor([
    { agentId: "a", prompt: "draft A", text: "short" },
    { agentId: "b", prompt: "draft B", text: "this is the longest of them all" },
    { agentId: "c", prompt: "draft C", text: "medium length" },
  ]);

  const run = await startWorkflowRun(wf("vote", wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
    seedFixturesJsonl: seed,
  });
  const result = (await run.promise) as {
    winner: string;
    responses: string[];
  };
  assert.equal(result.winner, "this is the longest of them all");
  assert.deepEqual(result.responses, [
    "short",
    "this is the longest of them all",
    "medium length",
  ]);

  // Ledger must show exactly one phase_start/phase_end pair, named "vote".
  const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; phaseName?: string });
  const phaseStarts = ledger.filter((e) => e.type === "phase_start");
  const phaseEnds = ledger.filter((e) => e.type === "phase_end");
  assert.equal(phaseStarts.length, 1, "vote opens exactly one phase");
  assert.equal(phaseEnds.length, 1);
  assert.equal(phaseStarts[0]!.phaseName, "vote");
});

test("ctx.consensus: agreed=true when all 3 responses are identical", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "consensus.workflow.js");
  copyFixture("consensus.workflow.js", wfPath);

  // Identical text → all pairwise Jaccard = 1.0 ≥ 0.6 default → agreed.
  const seed = fixturesFor([
    { agentId: "a", prompt: "describe", text: "alpha beta gamma" },
    { agentId: "b", prompt: "describe", text: "alpha beta gamma" },
    { agentId: "c", prompt: "describe", text: "alpha beta gamma" },
  ]);

  const run = await startWorkflowRun(wf("consensus", wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
    seedFixturesJsonl: seed,
  });
  const result = (await run.promise) as {
    agreed: boolean;
    majorityText: string;
    responses: string[];
  };
  assert.equal(result.agreed, true);
  assert.equal(result.majorityText, "alpha beta gamma");
  assert.equal(result.responses.length, 3);
});

test("ctx.parallel: fn returning array flattens into ONE phase", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "parallel.workflow.js");
  copyFixture("parallel.workflow.js", wfPath);

  const seed = fixturesFor([
    { agentId: "solo-s", prompt: "solo S", text: "S-text" },
    { agentId: "mx", prompt: "scout module x", text: "X-text" },
    { agentId: "my", prompt: "scout module y", text: "Y-text" },
  ]);

  const run = await startWorkflowRun(wf("parallel", wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
    seedFixturesJsonl: seed,
  });
  const result = (await run.promise) as {
    count: number;
    texts: string[];
    ids: string[];
  };
  assert.equal(result.count, 3);
  assert.deepEqual([...result.texts].sort(), ["S-text", "X-text", "Y-text"]);
  assert.deepEqual([...result.ids].sort(), ["mx", "my", "solo-s"]);

  // Single phase named "fanout" (opts.phaseName override).
  const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; phaseName?: string });
  const phaseStarts = ledger.filter((e) => e.type === "phase_start");
  assert.equal(phaseStarts.length, 1, "parallel fans out into one phase");
  assert.equal(phaseStarts[0]!.phaseName, "fanout");
  // Three agent_starts inside the single phase.
  const agentStarts = ledger.filter((e) => e.type === "agent_start");
  assert.equal(agentStarts.length, 3);
});

test("ctx.retry: rejects N-1 times then succeeds on attempt N", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "retry.workflow.js");
  copyFixture("retry.workflow.js", wfPath);

  // No agents involved — retry's fn is pure JS in the workflow.
  const run = await startWorkflowRun(wf("retry", wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
  });
  const result = (await run.promise) as {
    value: string;
    attempts: number;
    sleptAtLeastOneMs: boolean;
  };
  assert.equal(result.value, "ok-after-3");
  assert.equal(result.attempts, 3);
  assert.equal(result.sleptAtLeastOneMs, true);
});
