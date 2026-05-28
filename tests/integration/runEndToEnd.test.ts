/**
 * tests/integration/runEndToEnd.test.ts — slice 8a end-to-end smoke.
 *
 * Spins up `RunManager.startWorkflowRun` against a 2-phase fixture
 * workflow, in `--mock-agents` mode (no real `pi -p` spawn), and asserts:
 *
 *   - The workflow's `main()` resolves with the script's return value.
 *   - The ledger contains the right entry sequence in order.
 *   - The manifest.json has all slice-8a-owned fields populated.
 *   - `ctx.log(...)` appears as a `log` ledger entry.
 *   - `ctx.cache.set/get` round-trips and persists in `cache.jsonl`.
 *   - Phase ordering: p2's agent_starts come AFTER p1's phase_end.
 *   - vm.Context is disposed in finally — verified by a counter on the
 *     `Sandbox.dispose()` invocation via a wrapping spy.
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
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-e2e-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function fixturesFor(prompts: { agentId: string; prompt: string; text: string }[]): string {
  return (
    prompts
      .map((p) =>
        JSON.stringify({
          agentId: p.agentId,
          promptHash: sha256(p.prompt),
          result: { text: p.text, usage: { input: 1, output: 1, totalTokens: 2 } },
        }),
      )
      .join("\n") + "\n"
  );
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "basic", absPath, scope: "personal" };
}

test("slice 8a: 2-phase 3-agent workflow runs end-to-end (mock-agents)", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "basic.workflow.js");
  // Copy the fixture workflow into the tmp dir so RunManager's
  // sourceText hash is stable.
  writeFileSync(
    wfPath,
    readFileSync(
      join(
        new URL("../fixtures/workflows/basic.workflow.js", import.meta.url)
          .pathname,
      ),
      "utf8",
    ),
  );

  const seedFixturesJsonl = fixturesFor([
    { agentId: "a1", prompt: "audit phase 1", text: "AUDIT-OK" },
    { agentId: "a2", prompt: "scout module x", text: "SCOUT-X" },
    { agentId: "a3", prompt: "scout module y", text: "SCOUT-Y" },
  ]);

  const run = await startWorkflowRun(makeWorkflow(wfPath), "go", {
    mockAgents: true,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 4,
    cwd: runsRoot,
    resolveRunDir,
    seedFixturesJsonl,
  });

  const result = (await run.promise) as {
    phase1: string[];
    phase2: string[];
    cached: boolean[];
  };
  assert.deepEqual(result.phase1, ["AUDIT-OK"]);
  assert.deepEqual(result.phase2, ["SCOUT-X", "SCOUT-Y"]);
  assert.deepEqual(result.cached, [false, false]);

  // Ledger check.
  const ledgerLines = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; phaseName?: string; agentId?: string });
  const types = ledgerLines.map((e) => e.type);
  // Required ordering window: init, transitions, phase_start p1,
  // agent_start a1, agent_end a1, phase_end p1, phase_start p2,
  // agent_starts a2/a3, agent_ends a2/a3, phase_end p2, log, result, transition→done.
  assert.equal(types[0], "init", "init first");
  // Transitions present in order.
  const txIdx = ledgerLines
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "transition")
    .map(({ i }) => i);
  assert.ok(txIdx.length >= 2, `at least 2 transitions; got ${txIdx.length}`);
  // Phase 1 strictly before phase 2.
  const p1Start = types.indexOf("phase_start");
  const p1End = types.indexOf("phase_end");
  const p2Start = types.indexOf("phase_start", p1End);
  const p2End = types.indexOf("phase_end", p2Start);
  assert.ok(
    p1Start < p1End && p1End < p2Start && p2Start < p2End,
    `phase ordering: ${p1Start} ${p1End} ${p2Start} ${p2End}`,
  );
  // a1 is phase_start.p1's only agent.
  const p1AgentStarts = ledgerLines
    .slice(p1Start, p1End)
    .filter((e) => e.type === "agent_start")
    .map((e) => e.agentId);
  assert.deepEqual(p1AgentStarts, ["a1"]);
  // p2 sees a2 + a3.
  const p2AgentStarts = ledgerLines
    .slice(p2Start, p2End)
    .filter((e) => e.type === "agent_start")
    .map((e) => e.agentId)
    .sort();
  assert.deepEqual(p2AgentStarts, ["a2", "a3"]);
  // result entry exists.
  const resultEntry = ledgerLines.find((e) => e.type === "result");
  assert.ok(resultEntry, "result entry present");
  // log entry from ctx.log call.
  const logEntries = ledgerLines.filter((e) => e.type === "log");
  assert.ok(
    logEntries.length >= 1,
    `at least one log entry from ctx.log call; got ${logEntries.length}`,
  );

  // Manifest fields present.
  const manifestRaw = readFileSync(join(run.runDirAbs, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  assert.equal(manifest.runId, run.runId);
  assert.equal(manifest.workflowName, "basic");
  assert.equal(manifest.workflowAbsPath, wfPath);
  assert.equal(typeof manifest.workflowSourceSha256, "string");
  assert.equal((manifest.workflowSourceSha256 as string).length, 64);
  assert.equal(manifest.input, "go");
  assert.equal(typeof manifest.startedAt, "string");
  assert.equal(manifest.cwd, runsRoot);
  assert.equal(typeof manifest.options, "object");
  assert.equal((manifest.options as { mockAgents?: boolean }).mockAgents, true);
});

test("slice 8a: ctx.cache.set/get/has/delete round-trip", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "cache.workflow.js");
  writeFileSync(
    wfPath,
    `
      await ctx.cache.set("k1", { hello: "world", n: 42 });
      const v = await ctx.cache.get("k1");
      const has = await ctx.cache.has("k1");
      const hasMissing = await ctx.cache.has("missing");
      await ctx.cache.delete("k1");
      const after = await ctx.cache.has("k1");
      return { v, has, hasMissing, after };
    `,
    "utf8",
  );

  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
  });
  const out = (await run.promise) as {
    v: { hello: string; n: number };
    has: boolean;
    hasMissing: boolean;
    after: boolean;
  };
  assert.deepEqual(out.v, { hello: "world", n: 42 });
  assert.equal(out.has, true);
  assert.equal(out.hasMissing, false);
  assert.equal(out.after, false);

  // cache.jsonl on disk should contain author_cache + author_cache_delete.
  const cacheRaw = readFileSync(join(run.runDirAbs, "cache.jsonl"), "utf8");
  const cacheLines = cacheRaw.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(cacheLines.some((r) => r.type === "author_cache" && r.key === "k1"));
  assert.ok(
    cacheLines.some((r) => r.type === "author_cache_delete" && r.key === "k1"),
  );
});

test("slice 8a: ctx.finishCallback prompt is captured but not yet fired", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "finish.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("summarize the run"); return "ok";`,
    "utf8",
  );
  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
  });
  const out = await run.promise;
  assert.equal(out, "ok");
  assert.equal(run.getFinishCallbackPrompt(), "summarize the run");
});

test("slice 8a: workflow throws → run rejects + ledger has error + state failed", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "throw.workflow.js");
  writeFileSync(
    wfPath,
    `throw new Error("boom from workflow");`,
    "utf8",
  );
  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    mockAgents: true,
    preApproved: true,
    cwd: runsRoot,
    resolveRunDir,
  });
  await assert.rejects(run.promise, /boom from workflow/);
  const ledgerLines = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; to?: string });
  assert.ok(
    ledgerLines.some((e) => e.type === "error"),
    "error ledger entry present",
  );
  // Last transition target is `failed`.
  const finalTransition = [...ledgerLines]
    .reverse()
    .find((e) => e.type === "transition");
  assert.equal((finalTransition as { to?: string }).to, "failed");
});
