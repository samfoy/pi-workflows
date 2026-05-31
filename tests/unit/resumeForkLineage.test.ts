/**
 * tests/unit/resumeForkLineage.test.ts — ZONE_TIMETRAVEL polish.
 *
 * Resuming a run created via `forkFromCheckpoint` must:
 *   1. Append a `fork_lineage` ledger entry directly after the
 *      `resume` entry, carrying `{parentRunId, forkAtPhase}`.
 *   2. Prefix any error captured during the resumed run's execution
 *      with `fork of <parentRunId> at phase <forkAtPhase> failed: ...`
 *      so observability tools render the lineage alongside the
 *      diagnostic.
 *   3. Register the run with the active-runs registry carrying
 *      `parentRunId` + `forkAtPhase` so the runs-list overlay can
 *      surface the lineage badge.
 *
 * Resume on a non-fork run must NOT emit a fork_lineage entry and
 * must NOT prefix errors (regression guard for non-fork callers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeRun } from "../../src/runtime/resumeRun.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";
import { ActiveRunsRegistry } from "../../src/runtime/activeRuns.ts";
import { sha256 } from "../../src/util/hash.ts";

interface BuildOpts {
  readonly runId: string;
  readonly scriptSource: string;
  readonly parentRunId?: string;
  readonly forkAtPhase?: string;
}

interface Env {
  readonly runsRoot: string;
  readonly resolveRunDir: (id: string) => string;
  readonly resolveLedgerPath: (id: string) => string;
}

function makeEnv(): Env {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-resume-fork-"));
  return {
    runsRoot,
    resolveRunDir: (id) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
    resolveLedgerPath: (id) => join(runsRoot, id, "ledger.jsonl"),
  };
}

/**
 * Synthesize a paused-state run dir with optional fork lineage in
 * the manifest. Mirrors the helper in resumeRun.test.ts but adds
 * the parentRunId + forkAtPhase fields.
 */
async function buildPausedRun(env: Env, opts: BuildOpts): Promise<string> {
  const runDir = env.resolveRunDir(opts.runId);
  const liveWorkflow = join(env.runsRoot, `${opts.runId}-live.workflow.js`);
  writeFileSync(liveWorkflow, opts.scriptSource);
  writeFileSync(join(runDir, "script.js"), opts.scriptSource);
  const manifest: Record<string, unknown> = {
    runId: opts.runId,
    workflowName: "fork-resume-test",
    workflowAbsPath: liveWorkflow,
    workflowSourceSha256: sha256(opts.scriptSource),
    input: "",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    cwd: env.runsRoot,
    piVersion: "test",
    piWorkflowsVersion: "test",
    options: { mockAgents: false, maxConcurrent: 4, perRunAgentCap: 100 },
    trustedAtStart: true,
  };
  if (opts.parentRunId !== undefined) {
    manifest.parentRunId = opts.parentRunId;
  }
  if (opts.forkAtPhase !== undefined) {
    manifest.forkAtPhase = opts.forkAtPhase;
  }
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  // Ledger: pending → approved → running → paused.
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: env.resolveLedgerPath,
  });
  await writer.append({ type: "init", at: manifest.startedAt as string, manifest });
  for (const [from, to] of [
    ["pending", "approved"],
    ["approved", "running"],
    ["running", "paused"],
  ] as const) {
    await writer.append({
      type: "transition",
      at: new Date().toISOString(),
      from: from as never,
      to: to as never,
    });
  }
  return runDir;
}

function readLedger(env: Env, runId: string): Array<Record<string, unknown>> {
  return readFileSync(env.resolveLedgerPath(runId), "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── Tests ──────────────────────────────────────────────────────────

test("resume of fork: ledger gets a `fork_lineage` entry directly after `resume`", async () => {
  const env = makeEnv();
  await buildPausedRun(env, {
    runId: "wf-forkresume001",
    scriptSource: `return "fork-ok";`,
    parentRunId: "wf-parentxxxxxx",
    forkAtPhase: "p2",
  });

  const run = await resumeRun("wf-forkresume001", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await run.promise;
  assert.equal(result, "fork-ok");

  const entries = readLedger(env, "wf-forkresume001");
  // Find the resume entry and the fork_lineage entry; assert the
  // fork_lineage immediately follows resume.
  const resumeIdx = entries.findIndex((e) => e.type === "resume");
  assert.ok(resumeIdx >= 0, "ledger must contain a `resume` entry");
  const lineage = entries[resumeIdx + 1];
  assert.ok(lineage, "fork_lineage must follow `resume`");
  assert.equal(lineage?.type, "fork_lineage");
  assert.equal(lineage?.parentRunId, "wf-parentxxxxxx");
  assert.equal(lineage?.forkAtPhase, "p2");
});

test("resume of non-fork run: NO fork_lineage entry is written", async () => {
  const env = makeEnv();
  await buildPausedRun(env, {
    runId: "wf-nonforkres02",
    scriptSource: `return "plain-ok";`,
    // no parentRunId / forkAtPhase
  });

  const run = await resumeRun("wf-nonforkres02", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  await run.promise;

  const entries = readLedger(env, "wf-nonforkres02");
  const lineage = entries.find((e) => e.type === "fork_lineage");
  assert.equal(
    lineage,
    undefined,
    "non-fork resumes must not emit a fork_lineage entry",
  );
});

test("resume of fork: error mid-run is prefixed with `fork of <parent> at phase <forkAtPhase> failed: ...`", async () => {
  const env = makeEnv();
  await buildPausedRun(env, {
    runId: "wf-forkfail0001",
    // Throw a recognizable error to assert prefix wrapping.
    scriptSource: `throw new Error("inner-bug");`,
    parentRunId: "wf-parentxxxxxx",
    forkAtPhase: "p2",
  });

  const run = await resumeRun("wf-forkfail0001", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  // Run rejects with the inner error verbatim — the prefix is
  // applied to the LEDGER + the terminal info's `error` field, not
  // the throw itself.
  await assert.rejects(run.promise, /inner-bug/);
  const term = await run.terminated;
  assert.equal(term.outcome, "failed");
  assert.ok(term.error, "terminal info must carry an error");
  assert.match(
    term.error?.message ?? "",
    /^fork of wf-parentxxxxxx at phase p2 failed: .*inner-bug/,
    "terminal error.message must carry the lineage prefix",
  );

  const entries = readLedger(env, "wf-forkfail0001");
  const errorEntry = entries.find((e) => e.type === "error") as
    | { error?: { message?: string } }
    | undefined;
  assert.ok(errorEntry?.error, "ledger must contain an `error` entry");
  assert.match(
    errorEntry?.error?.message ?? "",
    /^fork of wf-parentxxxxxx at phase p2 failed: .*inner-bug/,
    "ledger error.message must carry the lineage prefix",
  );
});

test("resume of non-fork run: error is NOT prefixed (regression guard)", async () => {
  const env = makeEnv();
  await buildPausedRun(env, {
    runId: "wf-plainfail002",
    scriptSource: `throw new Error("plain-bug");`,
  });

  const run = await resumeRun("wf-plainfail002", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  await assert.rejects(run.promise, /plain-bug/);
  const term = await run.terminated;
  assert.equal(term.outcome, "failed");
  assert.ok(term.error);
  assert.doesNotMatch(
    term.error?.message ?? "",
    /fork of/,
    "non-fork runs must not have a fork-lineage prefix on errors",
  );
});

test("resume of fork: active-runs registration carries parentRunId + forkAtPhase", async () => {
  const env = makeEnv();
  await buildPausedRun(env, {
    runId: "wf-forkactvru01",
    scriptSource: `return "active-ok";`,
    parentRunId: "wf-parentyyyyyy",
    forkAtPhase: "p3",
  });

  const reg = new ActiveRunsRegistry();
  const run = await resumeRun("wf-forkactvru01", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
    activeRuns: reg,
  });
  await run.promise;

  const summary = reg.getSummary("wf-forkactvru01");
  assert.ok(summary, "registry must hold a summary for the resumed run");
  assert.equal(summary?.parentRunId, "wf-parentyyyyyy");
  assert.equal(summary?.forkAtPhase, "p3");
});
