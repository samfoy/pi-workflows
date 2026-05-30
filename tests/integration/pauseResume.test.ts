/**
 * tests/integration/pauseResume.test.ts — slice 12 cooperative pause /
 * resume end-to-end.
 *
 * Drives `RunManager.startWorkflowRun` with a controllable dispatcher
 * mock so each agent's "completion" can be awaited deterministically.
 * Asserts:
 *
 *   - Pausing mid-phase blocks subsequent semaphore acquisitions; the
 *     in-flight agent that already passed the gate finishes naturally.
 *   - Resuming drains the rest. Final result matches a non-paused run.
 *   - Ledger contains `pause` then `resume` entries between
 *     `agent_start` records.
 *   - State machine traces through `running → paused → running`
 *     using the dedicated edge — NOT slice 11's `failed → running`
 *     advisory rollback (slice_12_concerns B1).
 *   - Pausing twice is idempotent (one ledger pause entry).
 *   - Resuming a non-paused run is a no-op.
 *   - Pause + abort race: abort wins; final state is `stopped`.
 *
 * Uses `cwd` + `seedFixturesJsonl` discipline from runEndToEnd.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentResult,
  DispatcherOptions,
  WorkflowFile,
  LedgerEntry,
} from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.js";

function makeTmpRun(): {
  runsRoot: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-pause-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "pause", absPath, scope: "personal" };
}

function copyFixture(srcRel: string, destAbs: string): void {
  const srcUrl = new URL(`../fixtures/workflows/${srcRel}`, import.meta.url);
  writeFileSync(destAbs, readFileSync(srcUrl.pathname, "utf8"));
}

function readEntries(runDirAbs: string): LedgerEntry[] {
  const raw = readFileSync(join(runDirAbs, "ledger.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

interface ControllableAgent {
  readonly agentId: string;
  readonly start: Promise<void>;
  finish(text: string): void;
  fail(err: Error): void;
}

/**
 * Build a dispatcher mock where each `agentId` resolves with a
 * caller-controlled promise. The test can:
 *   - await `started` to know the agent has passed the pause gate +
 *     semaphore acquire and is "running",
 *   - call `finish()` to resolve the agent.
 *
 * `cap` agents may be inflight at once (matches RunManager's
 * `maxConcurrent`).
 */
function makeControllableDispatcher(cap: number): {
  dispatch: (opts: DispatcherOptions) => Promise<AgentResult>;
  starts: ControllableAgent[];
} {
  const starts: ControllableAgent[] = [];
  const startResolversByAgent = new Map<string, () => void>();
  const finishResolvers = new Map<
    string,
    {
      resolve: (r: AgentResult) => void;
      reject: (e: Error) => void;
    }
  >();
  // Track in-flight count for an oracle assertion in the test.
  let inFlight = 0;
  let maxObserved = 0;
  void cap;
  const dispatch = (opts: DispatcherOptions): Promise<AgentResult> => {
    inFlight++;
    if (inFlight > maxObserved) maxObserved = inFlight;
    const startResolver = startResolversByAgent.get(opts.agentId);
    if (startResolver) startResolver();
    return new Promise<AgentResult>((resolve, reject) => {
      finishResolvers.set(opts.agentId, {
        resolve: (r) => {
          inFlight--;
          resolve(r);
        },
        reject: (e) => {
          inFlight--;
          reject(e);
        },
      });
      if (opts.signal) {
        const onAbort = (): void => {
          opts.signal!.removeEventListener("abort", onAbort);
          inFlight--;
          reject(new Error("aborted"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };

  // Pre-create handles for agentIds a0..a99 so tests don't race on
  // start-resolver registration.
  for (let i = 0; i < 100; i++) {
    const agentId = `a${i}`;
    const start = new Promise<void>((res) => {
      startResolversByAgent.set(agentId, res);
    });
    starts.push({
      agentId,
      start,
      finish: (text: string) => {
        const fr = finishResolvers.get(agentId);
        if (!fr) throw new Error(`finish: ${agentId} not started`);
        fr.resolve({
          ok: true,
          agentId,
          text,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
          },
          toolCalls: 0,
          durationMs: 1,
          transcriptPath: "",
          exitCode: 0,
        });
      },
      fail: (err: Error) => {
        const fr = finishResolvers.get(agentId);
        if (!fr) throw new Error(`fail: ${agentId} not started`);
        fr.reject(err);
      },
    });
  }

  return { dispatch, starts };
}

// ─── A. pause-mid-phase blocks new spawns; in-flight finish ────────────

test("slice 12: pause mid-phase blocks new spawns; resume drains the rest", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", wfPath);

  const cap = 2;
  const { dispatch, starts } = makeControllableDispatcher(cap);

  const run = await startWorkflowRun(makeWorkflow(wfPath), "5", {
    mockAgents: false, // we own dispatch via the seam
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: cap,
    cwd: runsRoot,
    resolveRunDir,
    dispatch,
  });

  // Wait until the first `cap` agents are inflight (a0, a1).
  await starts[0]!.start;
  await starts[1]!.start;

  // Sanity: a2 has NOT started — semaphore is full.
  // Race a tiny delay vs starts[2].start; the delay should win.
  let started2 = false;
  starts[2]!.start.then(() => {
    started2 = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started2, false, "a2 must wait for semaphore slot");

  // Pause now. The two in-flight agents (a0, a1) should still finish
  // when we call finish(); but releasing their slots should NOT
  // start a2 because the gate is engaged.
  const pausedChanged = await run.pause("test-pause");
  assert.equal(pausedChanged, true, "first pause should change state");

  // Idempotent: second pause is a no-op.
  const secondPause = await run.pause("ignored");
  assert.equal(secondPause, false, "second pause must be a no-op");

  // Finish the two in-flight agents. Their semaphore slots release,
  // but a2/a3/a4 must remain blocked on the pause gate.
  starts[0]!.finish("R0");
  starts[1]!.finish("R1");

  // Yield — flush microtasks, give pause-gate races chance to settle.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(started2, false, "a2 must NOT start while paused");

  // Resume. a2/a3 should now start under the cap.
  const resumedChanged = await run.resumePaused("test-resume");
  assert.equal(resumedChanged, true);

  // Idempotent: second resume is a no-op.
  const secondResume = await run.resumePaused();
  assert.equal(secondResume, false);

  await starts[2]!.start;
  await starts[3]!.start;
  starts[2]!.finish("R2");
  starts[3]!.finish("R3");
  await starts[4]!.start;
  starts[4]!.finish("R4");

  const result = (await run.promise) as { texts: string[] };
  assert.deepEqual(result.texts, ["R0", "R1", "R2", "R3", "R4"]);

  // Ledger inspection.
  const entries = readEntries(run.runDirAbs);
  const pauseEntries = entries.filter((e) => e.type === "pause");
  const resumeEntries = entries.filter((e) => e.type === "resume");
  assert.equal(pauseEntries.length, 1, "exactly one pause ledger entry");
  assert.equal(resumeEntries.length, 1, "exactly one resume ledger entry");
  assert.equal((pauseEntries[0] as { reason?: string }).reason, "test-pause");
  assert.equal(
    (resumeEntries[0] as { reason?: string }).reason,
    "test-resume",
  );

  // pause/resume must appear between an agent_start and an agent_end
  // (i.e. mid-phase, with at least one in-flight). After BUG-W04 fix,
  // agent_start is logged AFTER semaphore acquire so the two in-flight
  // agents (a0, a1) log agent_start before the test calls pause.
  const idxPause = entries.findIndex((e) => e.type === "pause");
  const idxResume = entries.findIndex((e) => e.type === "resume");
  const firstStartIdx = entries.findIndex((e) => e.type === "agent_start");
  const firstEndIdx = entries.findIndex((e) => e.type === "agent_end");
  assert.ok(
    firstStartIdx !== -1 && firstEndIdx !== -1,
    "prereq: agent_start + agent_end entries exist",
  );
  assert.ok(
    idxPause > firstStartIdx,
    "pause must come after the first agent_start",
  );
  assert.ok(
    idxResume > idxPause,
    "resume must follow pause",
  );
  // The post-pause agents (a2..a4) must have their agent_end records
  // AFTER the resume.
  const lastEndIdx = entries
    .map((e, i) => (e.type === "agent_end" ? i : -1))
    .reduce((acc, i) => (i > acc ? i : acc), -1);
  assert.ok(
    lastEndIdx > idxResume,
    "at least one agent_end must come after resume",
  );

  // State-machine transitions: running → paused → running → done.
  // **slice_12_concerns B1**: NOT failed → running.
  const transitions = entries
    .filter((e) => e.type === "transition")
    .map((e) => `${(e as { from: string }).from}->${(e as { to: string }).to}`);
  assert.ok(
    transitions.includes("running->paused"),
    "must include running->paused",
  );
  assert.ok(
    transitions.includes("paused->running"),
    "must include paused->running (dedicated edge)",
  );
  assert.ok(
    !transitions.includes("failed->running"),
    "must NOT use slice 11's failed->running rollback edge",
  );
  assert.ok(transitions.includes("running->done"), "terminal: done");
});

// ─── B. resume of a never-paused run is a no-op ─────────────────────

test("slice 12: resume on a non-paused run is a no-op", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", wfPath);

  const { dispatch, starts } = makeControllableDispatcher(4);
  const run = await startWorkflowRun(makeWorkflow(wfPath), "2", {
    mockAgents: false,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 4,
    cwd: runsRoot,
    resolveRunDir,
    dispatch,
  });

  await starts[0]!.start;
  // Resume while running → no-op.
  const r = await run.resumePaused();
  assert.equal(r, false);

  starts[0]!.finish("R0");
  await starts[1]!.start;
  starts[1]!.finish("R1");

  await run.promise;
  const entries = readEntries(run.runDirAbs);
  assert.equal(
    entries.filter((e) => e.type === "resume").length,
    0,
    "no synthetic resume ledger entry on no-op",
  );
});

// ─── C. pause + abort race: abort wins, state is `stopped` ─────────

test("slice 12: stop() while paused → abort wins, terminal=stopped", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", wfPath);

  const { dispatch, starts } = makeControllableDispatcher(2);
  const run = await startWorkflowRun(makeWorkflow(wfPath), "5", {
    mockAgents: false,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 2,
    cwd: runsRoot,
    resolveRunDir,
    dispatch,
  });

  await starts[0]!.start;
  await starts[1]!.start;

  await run.pause("for-stop");
  // a2 is now blocked on the pause gate.
  // Stop while paused; abort must propagate to running agents AND to
  // the pause-gate waiter (so the dispatcher mock can reject a2).
  run.stop("user-bail");

  // Abort propagates to the in-flight dispatcher promises through
  // phaseCtrl.signal. The mock listens for abort and rejects.
  // (The two finished agents would otherwise hang.)

  // The Run promise rejects (script throws AggregateError).
  await assert.rejects(run.promise);

  const terminal = await run.terminated;
  assert.equal(
    terminal.outcome,
    "stopped",
    "abort wins the race against pause",
  );

  // State machine should NOT show paused as terminal — at least one
  // transition must be `running→stopped` OR `paused→stopped`.
  const entries = readEntries(run.runDirAbs);
  const transitions = entries
    .filter((e) => e.type === "transition")
    .map((e) => `${(e as { from: string }).from}->${(e as { to: string }).to}`);
  assert.ok(
    transitions.some(
      (t) => t === "running->stopped" || t === "paused->stopped",
    ),
    `expected stopped-terminal transition, got: ${transitions.join(", ")}`,
  );
  // B1: still must NOT touch the failed→running rollback.
  assert.ok(!transitions.includes("failed->running"));
});

// ─── D. pause after run is already terminal: no-op ──────────────────

test("slice 12: pause on already-completed run is a no-op", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", wfPath);

  const { dispatch, starts } = makeControllableDispatcher(2);
  const run = await startWorkflowRun(makeWorkflow(wfPath), "1", {
    mockAgents: false,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 2,
    cwd: runsRoot,
    resolveRunDir,
    dispatch,
  });

  await starts[0]!.start;
  starts[0]!.finish("R0");
  await run.promise;

  const r = await run.pause("too-late");
  assert.equal(r, false, "pause after terminal must be a no-op");
});

// ─── E. final result matches non-paused run ─────────────────────────

test("slice 12: paused run final result equals non-paused baseline", async () => {
  // Baseline run.
  const baseRoot = makeTmpRun();
  const baseWf = join(baseRoot.runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", baseWf);
  const baseDisp = makeControllableDispatcher(4);
  const baseRun = await startWorkflowRun(makeWorkflow(baseWf), "3", {
    mockAgents: false,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 4,
    cwd: baseRoot.runsRoot,
    resolveRunDir: baseRoot.resolveRunDir,
    dispatch: baseDisp.dispatch,
  });
  for (let i = 0; i < 3; i++) {
    await baseDisp.starts[i]!.start;
    baseDisp.starts[i]!.finish(`R${i}`);
  }
  const baseResult = (await baseRun.promise) as { texts: string[] };

  // Paused run.
  const pausedRoot = makeTmpRun();
  const pausedWf = join(pausedRoot.runsRoot, "pause.workflow.js");
  copyFixture("pause.workflow.js", pausedWf);
  const pausedDisp = makeControllableDispatcher(2);
  const pausedRun = await startWorkflowRun(makeWorkflow(pausedWf), "3", {
    mockAgents: false,
    preApproved: true,
    perRunAgentCap: 100,
    maxConcurrent: 2,
    cwd: pausedRoot.runsRoot,
    resolveRunDir: pausedRoot.resolveRunDir,
    dispatch: pausedDisp.dispatch,
  });
  await pausedDisp.starts[0]!.start;
  await pausedDisp.starts[1]!.start;
  await pausedRun.pause();
  pausedDisp.starts[0]!.finish("R0");
  pausedDisp.starts[1]!.finish("R1");
  await new Promise((r) => setTimeout(r, 30));
  await pausedRun.resumePaused();
  await pausedDisp.starts[2]!.start;
  pausedDisp.starts[2]!.finish("R2");
  const pausedResult = (await pausedRun.promise) as { texts: string[] };

  assert.deepEqual(pausedResult.texts, baseResult.texts);
});
