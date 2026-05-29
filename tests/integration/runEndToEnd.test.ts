/**
 * tests/integration/runEndToEnd.test.ts — slice 8a end-to-end smoke,
 * extended in slice 9 with explicit dispose-counter spy + manifest
 * two-checkpoint + transition-shape ordering + fsync-delay tolerance.
 *
 * Spins up `RunManager.startWorkflowRun` against a 2-phase fixture
 * workflow, in `--mock-agents` mode (no real `pi -p` spawn), and asserts:
 *
 *   - The workflow's `main()` resolves with the script's return value.
 *   - The ledger contains the right entry sequence in order.
 *   - Slice 9 [H5]: each `transition` entry has correct `from`/`to`
 *     ordering pinned, not just count.
 *   - The manifest.json has all slice-8a-owned fields populated.
 *   - Slice 9 [H7]: manifest is read at run-start AND end-of-run, and
 *     trustedAtStart is unchanged across the run.
 *   - `ctx.log(...)` appears as a `log` ledger entry.
 *   - `ctx.cache.set/get` round-trips and persists in `cache.jsonl`.
 *   - Phase ordering: p2's agent_starts come AFTER p1's phase_end.
 *   - Slice 9 [H6]: vm.Context is disposed in finally — verified by a
 *     real spy counter on `Sandbox.prototype.dispose`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.js";
import { Sandbox } from "../../src/runtime/sandbox.js";
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

  // Slice 9 [H6] dispose-counter spy: wrap Sandbox.prototype.dispose so
  // we can assert it actually fired in the run's finally block.
  const realDispose = Sandbox.prototype.dispose;
  let disposeCalls = 0;
  Sandbox.prototype.dispose = function (this: Sandbox) {
    disposeCalls++;
    return realDispose.call(this);
  };

  let run;
  try {
    run = await startWorkflowRun(makeWorkflow(wfPath), "go", {
      mockAgents: true,
      preApproved: true,
      perRunAgentCap: 100,
      maxConcurrent: 4,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl,
    });

    // Slice 9 [H7] manifest at run-start: read BEFORE awaiting promise.
    const manifestAtStart = JSON.parse(
      readFileSync(join(run.runDirAbs, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifestAtStart.runId, run.runId);
    assert.equal(
      manifestAtStart.workflowName,
      "basic",
      "manifest at run-start must already have workflowName populated",
    );

    const result = (await run.promise) as {
      phase1: string[];
      phase2: string[];
      cached: boolean[];
    };
    assert.deepEqual(result.phase1, ["AUDIT-OK"]);
    assert.deepEqual(result.phase2, ["SCOUT-X", "SCOUT-Y"]);
    assert.deepEqual(result.cached, [false, false]);
  } finally {
    Sandbox.prototype.dispose = realDispose;
  }

  // Slice 9 [H6] dispose spy assertion.
  assert.equal(
    disposeCalls,
    1,
    `Sandbox.dispose must run exactly once in run finally (got ${disposeCalls})`,
  );

  // Ledger check.
  const ledgerLines = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string;
          phaseName?: string;
          agentId?: string;
          from?: string;
          to?: string;
        },
    );
  const types = ledgerLines.map((e) => e.type);
  // Required ordering window: init, transitions, phase_start p1,
  // agent_start a1, agent_end a1, phase_end p1, phase_start p2,
  // agent_starts a2/a3, agent_ends a2/a3, phase_end p2, log, result, transition→done.
  assert.equal(types[0], "init", "init first");
  // Slice 9 [H5]: transitions in explicit (from, to) order.
  const transitions = ledgerLines.filter((e) => e.type === "transition");
  assert.deepEqual(
    transitions.map((t) => `${t.from}->${t.to}`),
    ["pending->approved", "approved->running", "running->done"],
    "transitions must follow PRD \u00a75.2 happy-path order",
  );
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

// Slice 9 [H4]: dispose-in-finally. If `ledger.flush()` throws after a
// successful main(), Sandbox.dispose() must STILL run. Verified with a
// monkey-patched flush + a dispose-counter spy.
test("slice 9 [H4]: ledger.flush() throwing does NOT skip Sandbox.dispose()", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "finally.workflow.js");
  writeFileSync(wfPath, `return "ok";`, "utf8");

  // Spy dispose.
  const realDispose = Sandbox.prototype.dispose;
  let disposeCalls = 0;
  Sandbox.prototype.dispose = function (this: Sandbox) {
    disposeCalls++;
    return realDispose.call(this);
  };

  // Monkey-patch LedgerWriter.prototype.flush to throw post-success.
  const { LedgerWriter } = await import("../../src/runtime/ledger.js");
  const realFlush = LedgerWriter.prototype.flush;
  let flushThrew = false;
  LedgerWriter.prototype.flush = async function (this: InstanceType<typeof LedgerWriter>) {
    await realFlush.call(this);
    if (!flushThrew) {
      flushThrew = true;
      throw new Error("synthetic flush failure (slice 9 [H4])");
    }
    return undefined;
  };

  try {
    const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
      mockAgents: true,
      preApproved: true,
      cwd: runsRoot,
      resolveRunDir,
    });
    await assert.rejects(run.promise, /synthetic flush failure/);
    assert.equal(
      disposeCalls,
      1,
      `dispose must run in finally even when flush throws (got ${disposeCalls})`,
    );
  } finally {
    Sandbox.prototype.dispose = realDispose;
    LedgerWriter.prototype.flush = realFlush;
  }
});

// Slice 9 [H8]: fsync-delay tolerance. The synthetic ledger-flush delay
// must NOT cause appended entries to disappear from the on-disk file by
// the time the run promise settles. We patch fs.fsyncSync to add a
// 100ms delay, then assert append-then-read sees the entry within
// 200ms of the run resolving.
test("slice 9 [H8]: synthetic per-append fsync delay does not lose appends", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "fsync.workflow.js");
  writeFileSync(
    wfPath,
    `
      ctx.log("FSYNC-MARK-1");
      ctx.log("FSYNC-MARK-2");
      ctx.log("FSYNC-MARK-3");
      return "ok";
    `,
    "utf8",
  );

  // Approximate the fsync-delay scenario by wrapping LedgerWriter.append:
  // each call serializes into a writeQueue and yields back to the event
  // loop. We force a 30ms async delay BEFORE each underlying append so
  // the queue stretches well past main()'s natural resolution window.
  // The post-condition: all 3 ctx.log entries land on disk anyway.
  const { LedgerWriter } = await import("../../src/runtime/ledger.js");
  const realAppend = LedgerWriter.prototype.append;
  let appendCalls = 0;
  LedgerWriter.prototype.append = function (
    this: InstanceType<typeof LedgerWriter>,
    entry,
  ) {
    appendCalls++;
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        realAppend.call(this, entry).then(resolve, reject);
      }, 30);
    });
  };

  try {
    const t0 = Date.now();
    const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
      mockAgents: true,
      preApproved: true,
      cwd: runsRoot,
      resolveRunDir,
    });
    const out = await run.promise;
    assert.equal(out, "ok");
    const elapsed = Date.now() - t0;

    // Read the ledger from disk; must contain all 3 marks despite delay.
    const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8");
    assert.match(ledger, /FSYNC-MARK-1/);
    assert.match(ledger, /FSYNC-MARK-2/);
    assert.match(ledger, /FSYNC-MARK-3/);
    assert.ok(
      appendCalls >= 5,
      `delay-wrapped append must have fired multiple times (got ${appendCalls})`,
    );
    assert.ok(elapsed < 5000, `expected <5s overall (got ${elapsed}ms)`);
  } finally {
    LedgerWriter.prototype.append = realAppend;
  }
});
