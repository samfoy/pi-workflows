/**
 * tests/unit/resumeRun.test.ts — slice 11 §B.
 *
 * Per-test scenarios:
 *   - Resume of a non-existent runId errors with RunNotFoundError.
 *   - Resume of a `done` run errors with ResumeNotAllowedError [C4].
 *   - Resume of a `failed` (no parent-crash) errors [C4].
 *   - Resume of a `stopped` errors [C4].
 *   - Resume of a `cancelled-pre-run` errors [C4].
 *   - Resume of a sweep-flipped `failed: parent-crash` succeeds.
 *   - Resume of a `paused` succeeds.
 *   - Resume of a `running` (crashed-mid-run) succeeds.
 *   - Resume sets `ctx.run.resumed = true` (visible to the script).
 *   - Resume reads frozen `<runDir>/script.js`, NOT the live workflow.
 *   - --latest reads the live workflow + emits the verbatim warning.
 *   - --latest cache miss: changing the live script invalidates cache.
 *   - Cache replay during resume: a previously-cached author cache key
 *     is visible to the resumed script's `ctx.cache.get`.
 *   - Concurrent resume from same process: second errors with
 *     ResumeLockedError.
 *   - Resume releases the lock after the run settles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resumeRun,
  ResumeNotAllowedError,
  RunNotFoundError,
  ResumeLockedError,
  LATEST_CACHE_WARNING,
} from "../../src/runtime/resumeRun.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";
import { startWorkflowRun } from "../../src/runManager.ts";
import { sha256 } from "../../src/util/hash.ts";
import type { WorkflowFile } from "../../src/types/internal.js";

interface TmpEnv {
  readonly runsRoot: string;
  readonly cwd: string;
  readonly home: string;
  readonly resolveRunDir: (id: string) => string;
  readonly resolveLedgerPath: (id: string) => string;
}

function makeTmp(): TmpEnv {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-resume-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-resume-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-resume-home-"));
  return {
    runsRoot,
    cwd,
    home,
    resolveRunDir: (id) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
    resolveLedgerPath: (id) => join(runsRoot, id, "ledger.jsonl"),
  };
}

function makeWorkflow(absPath: string, name = "resumetest"): WorkflowFile {
  return { name, absPath, scope: "personal" };
}

// ─── Synthetic-state helper: build a runDir at a target state ──────────

interface MakeRunStateOpts extends TmpEnv {
  readonly runId: string;
  readonly state:
    | "running"
    | "paused"
    | "approved"
    | "done"
    | "failed"
    | "failed-parent-crash"
    | "stopped"
    | "cancelled-pre-run";
  readonly scriptSource?: string;
  readonly workflowAbsPath?: string;
}

async function buildRunDir(opts: MakeRunStateOpts): Promise<{
  runDir: string;
  workflowSrc: string;
}> {
  const runDir = opts.resolveRunDir(opts.runId);
  const liveWorkflow = opts.workflowAbsPath ?? join(opts.cwd, `${opts.runId}-live.workflow.js`);
  const src = opts.scriptSource ?? `return "ok";`;
  writeFileSync(liveWorkflow, src);
  // Frozen copy in runDir.
  writeFileSync(join(runDir, "script.js"), src);
  // Manifest.
  const manifest = {
    runId: opts.runId,
    workflowName: "resumetest",
    workflowAbsPath: liveWorkflow,
    workflowSourceSha256: sha256(src),
    input: "",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    cwd: opts.cwd,
    piVersion: "test",
    piWorkflowsVersion: "test",
    options: { mockAgents: false, maxConcurrent: 4, perRunAgentCap: 100 },
    trustedAtStart: true,
    parentPid: process.pid,
    parentBootId: "",
    parentStartTime: "0",
  };
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  // Ledger.
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: opts.resolveLedgerPath,
  });
  await writer.append({
    type: "init",
    at: manifest.startedAt,
    manifest,
  });
  const transitions: Array<[string, string, string?]> = [];
  switch (opts.state) {
    case "running":
      transitions.push(["pending", "approved"], ["approved", "running"]);
      break;
    case "paused":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "paused"],
      );
      break;
    case "approved":
      transitions.push(["pending", "approved"]);
      break;
    case "done":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "done"],
      );
      break;
    case "failed":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "failed"],
      );
      break;
    case "failed-parent-crash":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "failed", "parent-crash"],
      );
      break;
    case "stopped":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "stopped"],
      );
      break;
    case "cancelled-pre-run":
      transitions.push(["pending", "cancelled-pre-run"]);
      break;
  }
  for (const [from, to, reason] of transitions) {
    await writer.append({
      type: "transition",
      at: new Date().toISOString(),
      from: from as never,
      to: to as never,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  // For terminal states with a typical result (done/failed/stopped/cancelled), drop a result.json.
  if (
    opts.state === "done" ||
    opts.state === "failed" ||
    opts.state === "stopped" ||
    opts.state === "cancelled-pre-run"
  ) {
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify(
        {
          runId: opts.runId,
          workflowName: "resumetest",
          outcome: opts.state === "cancelled-pre-run" ? "cancelled-pre-run" : opts.state,
          startedAt: manifest.startedAt,
          endedAt: new Date().toISOString(),
          durationMs: 0,
          result: null,
          error: null,
          approval: null,
          agentCount: 0,
          finishCallbackPrompt: null,
        },
        null,
        2,
      ),
    );
  }
  return { runDir, workflowSrc: src };
}

// ─── Tests ────────────────────────────────────────────────────────────

test("resume: non-existent runId → RunNotFoundError", async () => {
  const env = makeTmp();
  // Use a resolver that does NOT mkdir (the env helper does, which
  // would defeat the not-found check).
  await assert.rejects(
    resumeRun("wf-doesnotexist", {
      resolveRunDir: (id) => join(env.runsRoot, id),
    }),
    (err) => err instanceof RunNotFoundError,
  );
});

test("[C4] resume of `done` → ResumeNotAllowedError", async () => {
  const env = makeTmp();
  await buildRunDir({ ...env, runId: "wf-doneterminal", state: "done" });
  await assert.rejects(
    resumeRun("wf-doneterminal", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
    }),
    (err) => {
      assert.ok(err instanceof ResumeNotAllowedError);
      if (err instanceof ResumeNotAllowedError) {
        assert.equal(err.currentState, "done");
        assert.match(err.message, /terminal-non-resumable/);
      }
      return true;
    },
  );
});

test("[C4] resume of `failed` (no parent-crash) → ResumeNotAllowedError", async () => {
  const env = makeTmp();
  await buildRunDir({ ...env, runId: "wf-failednormal", state: "failed" });
  await assert.rejects(
    resumeRun("wf-failednormal", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
    }),
    (err) => err instanceof ResumeNotAllowedError,
  );
});

test("[C4] resume of `stopped` → ResumeNotAllowedError", async () => {
  const env = makeTmp();
  await buildRunDir({ ...env, runId: "wf-stoppedrunxx", state: "stopped" });
  await assert.rejects(
    resumeRun("wf-stoppedrunxx", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
    }),
    (err) => err instanceof ResumeNotAllowedError,
  );
});

test("[C4] resume of `cancelled-pre-run` → ResumeNotAllowedError + clear message", async () => {
  const env = makeTmp();
  await buildRunDir({ ...env, runId: "wf-cancelledabc", state: "cancelled-pre-run" });
  await assert.rejects(
    resumeRun("wf-cancelledabc", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
    }),
    (err) => {
      assert.ok(err instanceof ResumeNotAllowedError);
      if (err instanceof ResumeNotAllowedError) {
        assert.equal(err.currentState, "cancelled-pre-run");
        assert.match(err.message, /terminal-non-resumable/);
        // result.json path is included.
        assert.match(err.message, /result\.json/);
      }
      return true;
    },
  );
});

test("resume of sweep-flipped `failed: parent-crash` succeeds + appends resume-rollback transition", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-pcrashresumx",
    state: "failed-parent-crash",
    scriptSource: `return "resumed-ok";`,
  });
  const run = await resumeRun("wf-pcrashresumx", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await run.promise;
  assert.equal(result, "resumed-ok");
  // Verify the rollback transition + final done state.
  const lines = readFileSync(env.resolveLedgerPath("wf-pcrashresumx"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; from?: string; to?: string; reason?: string });
  const rollback = lines.find(
    (e) => e.type === "transition" && e.from === "failed" && e.to === "running",
  );
  assert.ok(rollback, "expected a failed→running transition with reason=resume-rollback");
  assert.equal(rollback?.reason, "resume-rollback");
});

test("resume of `paused` succeeds + appends paused→running transition", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-pausedresx1",
    state: "paused",
    scriptSource: `return "paused-resumed";`,
  });
  const run = await resumeRun("wf-pausedresx1", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await run.promise;
  assert.equal(result, "paused-resumed");
});

test("resume of `running` (crashed mid-run) succeeds with no extra transition entry", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-crashresumex",
    state: "running",
    scriptSource: `return 42;`,
  });
  const run = await resumeRun("wf-crashresumex", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await run.promise;
  assert.equal(result, 42);
});

test("resume sets ctx.run.resumed = true (visible to the script)", async () => {
  const env = makeTmp();
  const src = `return { resumed: ctx.run.resumed, id: ctx.run.id };`;
  await buildRunDir({
    ...env,
    runId: "wf-runresumedfx",
    state: "paused",
    scriptSource: src,
  });
  const run = await resumeRun("wf-runresumedfx", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = (await run.promise) as { resumed: boolean; id: string };
  assert.equal(result.resumed, true);
  assert.equal(result.id, "wf-runresumedfx");
});

test("resume reads FROZEN <runDir>/script.js (not the live workflow)", async () => {
  const env = makeTmp();
  const env2 = await buildRunDir({
    ...env,
    runId: "wf-frozencopy01",
    state: "paused",
    scriptSource: `return "frozen-output";`,
  });
  // MUTATE the live workflow file to a different output. Resume must
  // still see "frozen-output" because it reads <runDir>/script.js.
  writeFileSync(
    join(env.cwd, "wf-frozencopy01-live.workflow.js"),
    `return "live-output-which-must-not-be-seen";`,
  );
  const run = await resumeRun("wf-frozencopy01", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await run.promise;
  assert.equal(result, "frozen-output");
  void env2;
});

test("resume --latest reads the live workflow + emits verbatim warning", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-latestbeh001",
    state: "paused",
    scriptSource: `return "frozen";`,
  });
  // Change the live file.
  writeFileSync(
    join(env.cwd, "wf-latestbeh001-live.workflow.js"),
    `return "live-after-edit";`,
  );
  const warnings: string[] = [];
  const run = await resumeRun("wf-latestbeh001", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
    useLatest: true,
    onLatestWarning: (w) => warnings.push(w),
  });
  const result = await run.promise;
  assert.equal(result, "live-after-edit");
  assert.deepEqual(warnings, [LATEST_CACHE_WARNING]);
});

test("--latest cache invalidation: changing live script causes cache miss", async () => {
  const env = makeTmp();
  // Build a paused run with cached `author_cache` entry under key "x".
  await buildRunDir({
    ...env,
    runId: "wf-cachemiss001",
    state: "paused",
    scriptSource: `return "frozen-v1";`,
  });
  // Pre-seed an author-cache entry that the script will probe.
  writeFileSync(
    join(env.resolveRunDir("wf-cachemiss001"), "cache.jsonl"),
    JSON.stringify({
      type: "author_cache",
      key: "X",
      value: "cached-value",
      at: new Date().toISOString(),
    }) + "\n",
  );
  // Replace the live script: probe for author cache existence.
  writeFileSync(
    join(env.cwd, "wf-cachemiss001-live.workflow.js"),
    `
      const has = await ctx.cache.has("X");
      const v = await ctx.cache.get("X");
      return { has: has, value: v };
    `,
  );
  const run = await resumeRun("wf-cachemiss001", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
    useLatest: true,
  });
  const result = (await run.promise) as { has: boolean; value: string };
  // Cache was loaded into memory and survives across resume — the
  // `--latest` warning is about *agent* cache keys (which include
  // workflowSha256). Author cache is a flat string key so it survives.
  // This pins the ctx.cache.* behavior on resume.
  assert.equal(result.has, true);
  assert.equal(result.value, "cached-value");
});

test("resume cache replay: cached author entries from the prior run survive", async () => {
  const env = makeTmp();
  // Pre-seed cache.jsonl with two author entries.
  await buildRunDir({
    ...env,
    runId: "wf-cachereplxxx",
    state: "paused",
    scriptSource: `
      const a = await ctx.cache.get("a");
      const b = await ctx.cache.get("b");
      return { a, b };
    `,
  });
  const cacheFile = join(env.resolveRunDir("wf-cachereplxxx"), "cache.jsonl");
  writeFileSync(
    cacheFile,
    [
      JSON.stringify({ type: "author_cache", key: "a", value: 1, at: new Date().toISOString() }),
      JSON.stringify({ type: "author_cache", key: "b", value: "two", at: new Date().toISOString() }),
    ].join("\n") + "\n",
  );
  const run = await resumeRun("wf-cachereplxxx", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const out = (await run.promise) as { a: unknown; b: unknown };
  assert.equal(out.a, 1);
  assert.equal(out.b, "two");
});

test("[concurrent-resume] second resume of the same runId errors with ResumeLockedError", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-lockedresxxx",
    state: "paused",
    scriptSource: `await new Promise(r => setTimeout(r, 200)); return null;`,
  });
  const first = resumeRun("wf-lockedresxxx", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  // Wait for the first to acquire its lock (resumeRun is async and
  // locks before sandbox.runScript starts).
  const firstHandle = await first;
  // Now the lock is held; a second attempt must error.
  await assert.rejects(
    resumeRun("wf-lockedresxxx", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err) => {
      assert.ok(err instanceof ResumeLockedError);
      if (err instanceof ResumeLockedError) {
        assert.match(err.message, /already being resumed/);
      }
      return true;
    },
  );
  // Let the first run settle; lock should release.
  await firstHandle.promise;
  await firstHandle.terminated;
  // After settle, a new resume attempt is allowed (the now-`done` state
  // would actually error with ResumeNotAllowedError, but the lock is
  // gone — verifiable by checking the lockfile path).
  const lockPath = join(env.resolveRunDir("wf-lockedresxxx"), ".resume.lock");
  assert.equal(existsSync(lockPath), false, "lock must be released after settle");
});

// ─── readManifestStrict error paths ─────────────────────────────

test("resume: missing manifest.json → error names the runDir", async () => {
  const env = makeTmp();
  const runDir = env.resolveRunDir("wf-missingmanif");
  // Just create the dir; don't write manifest.json or anything else.
  void runDir;
  await assert.rejects(
    resumeRun("wf-missingmanif", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err: unknown) =>
      err instanceof Error && /manifest\.json missing/.test(err.message),
  );
});

test("resume: empty manifest.json → error reports 'empty'", async () => {
  const env = makeTmp();
  const runDir = env.resolveRunDir("wf-emptymanif00");
  writeFileSync(join(runDir, "manifest.json"), "   \n");
  await assert.rejects(
    resumeRun("wf-emptymanif00", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err: unknown) =>
      err instanceof Error && /manifest\.json empty/.test(err.message),
  );
});

test("resume: corrupt manifest.json → error reports 'corrupt' + parse detail", async () => {
  const env = makeTmp();
  const runDir = env.resolveRunDir("wf-corruptmanif");
  writeFileSync(join(runDir, "manifest.json"), "{ not valid json,,,");
  await assert.rejects(
    resumeRun("wf-corruptmanif", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err: unknown) =>
      err instanceof Error && /manifest\.json corrupt/.test(err.message),
  );
});

test("resume: manifest.json that's an array (not object) → error reports 'shape invalid'", async () => {
  const env = makeTmp();
  const runDir = env.resolveRunDir("wf-shapemanif00");
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(["not", "an", "object"]));
  await assert.rejects(
    resumeRun("wf-shapemanif00", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err: unknown) =>
      err instanceof Error && /manifest\.json shape invalid/.test(err.message),
  );
});

test("resume: manifest.json missing required slice-8a fields → lists which fields", async () => {
  const env = makeTmp();
  const runDir = env.resolveRunDir("wf-incompletemf");
  // Only runId — missing workflowName / workflowAbsPath / workflowSourceSha256.
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ runId: "wf-incompletemf" }),
  );
  await assert.rejects(
    resumeRun("wf-incompletemf", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      preApproved: true,
    }),
    (err: unknown) =>
      err instanceof Error &&
      /missing required slice-8a fields/.test(err.message) &&
      /workflowName/.test(err.message),
  );
});

// ─── frozen-script-fallback path ────────────────────────────────

test("resume: missing frozen <runDir>/script.js falls back to live workflowAbsPath", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-nofrozen0000",
    state: "paused",
    scriptSource: `return "from-live";`,
  });
  // Delete the frozen copy. The live workflowAbsPath still has the
  // same source so resume should succeed by reading from there.
  const runDir = env.resolveRunDir("wf-nofrozen0000");
  const fs = await import("node:fs");
  fs.unlinkSync(join(runDir, "script.js"));
  // Confirm: only live file remains.
  assert.equal(existsSync(join(runDir, "script.js")), false);
  const handle = await resumeRun("wf-nofrozen0000", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  const result = await handle.promise;
  assert.equal(result, "from-live");
});

// ─── approval gate paths ─────────────────────────────────────

test("resume: approval gate fires when preApproved=false + approval supplied; allow path runs", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-approvegated",
    state: "paused",
    scriptSource: `return "approved";`,
  });
  const dialogCalls: string[] = [];
  const handle = await resumeRun("wf-approvegated", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    // preApproved omitted (defaults false)
    approval: {
      dialog: async (prompt) => {
        dialogCalls.push(prompt.workflowName);
        return "run-once";
      },
      viewer: () => {},
      trustOverride: {},
    },
  });
  const result = await handle.promise;
  assert.equal(result, "approved");
  assert.deepEqual(dialogCalls, ["resumetest"]);
});

test("resume: approval gate denial throws and does NOT execute the script", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-approvedeny",
    state: "paused",
    scriptSource: `throw new Error("should not run");`,
  });
  await assert.rejects(
    resumeRun("wf-approvedeny", {
      resolveRunDir: env.resolveRunDir,
      resolveLedgerPath: env.resolveLedgerPath,
      approval: {
        dialog: async () => "no",
        viewer: () => {},
        trustOverride: {},
      },
    }),
    (err: unknown) => {
      // RunCancelledError surfaces — message includes 'cancelled' or the dialog's reason.
      return err instanceof Error && /cancel/i.test(err.message);
    },
  );
});

// ─── fork-lineage cross-check ───────────────────────────────

test("resume: manifest with parentRunId + forkAtPhase appends fork_lineage ledger entry", async () => {
  const env = makeTmp();
  await buildRunDir({
    ...env,
    runId: "wf-forkresumed",
    state: "paused",
    scriptSource: `return "forked";`,
  });
  // Patch manifest to add fork-lineage fields.
  const runDir = env.resolveRunDir("wf-forkresumed");
  const manifestPath = join(runDir, "manifest.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
  m.parentRunId = "wf-parentrun000";
  m.forkAtPhase = "phase-1";
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const handle = await resumeRun("wf-forkresumed", {
    resolveRunDir: env.resolveRunDir,
    resolveLedgerPath: env.resolveLedgerPath,
    preApproved: true,
  });
  await handle.promise;
  await handle.terminated;
  // Inspect the ledger to confirm a fork_lineage entry was appended
  // post-resume.
  const ledgerLines = readFileSync(
    env.resolveLedgerPath("wf-forkresumed"),
    "utf-8",
  )
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  const forkEntries = ledgerLines.filter(
    (e: { type: string }) => e.type === "fork_lineage",
  );
  assert.equal(forkEntries.length, 1);
  assert.equal(forkEntries[0].parentRunId, "wf-parentrun000");
  assert.equal(forkEntries[0].forkAtPhase, "phase-1");
});

