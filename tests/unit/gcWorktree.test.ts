/**
 * tests/unit/gcWorktree.test.ts — ZONE_WORKTREE follow-up #1
 *
 * Auto-prune of `manifest.agentWorktrees` entries when GC deletes a run
 * directory. Three cases:
 *
 *   1. Clean worktree → `git worktree remove <path>` runs, info-log
 *      records the prune, runDir then rm-rf'd, deleted list contains the runId.
 *   2. Dirty worktree (uncommitted changes) → prune skipped with a
 *      warn-log; runDir still rm-rf'd. The dirty worktree is left on disk.
 *   3. forceRemoveDirtyWorktrees:true → dirty worktree pruned via
 *      `git worktree remove --force`.
 *
 * Tests use the `_execFile` seam on `runGc` so we never spawn real git.
 * The runDir/manifest/ledger machinery is set up via the same helper
 * shape `gc.test.ts` already uses.
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

import { runGc } from "../../src/runtime/gc.ts";
import type { ExecFileLike } from "../../src/runtime/worktree.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";

// ─── Test runDir builder ─────────────────────────────────────────────

interface MakeRunOpts {
  readonly runsRoot: string;
  readonly runId: string;
  readonly endedAt: string;
  /** Map of agentId → worktree path written into manifest.agentWorktrees. */
  readonly agentWorktrees: Record<string, string>;
  /** cwd recorded in the manifest. Used by gc as `git worktree remove`'s cwd. */
  readonly cwd: string;
}

async function makeDoneRun(opts: MakeRunOpts): Promise<string> {
  const runDir = join(opts.runsRoot, opts.runId);
  mkdirSync(runDir, { recursive: true });
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  await writer.append({
    type: "init",
    at: opts.endedAt,
    manifest: { runId: opts.runId, workflowName: "synthetic" },
  });
  for (const [from, to] of [
    ["pending", "approved"],
    ["approved", "running"],
    ["running", "done"],
  ] as const) {
    await writer.append({
      type: "transition",
      at: opts.endedAt,
      from,
      to,
    });
  }
  // Manifest with cwd + agentWorktrees.
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(
      {
        runId: opts.runId,
        workflowName: "synthetic",
        cwd: opts.cwd,
        agentWorktrees: opts.agentWorktrees,
      },
      null,
      2,
    ),
  );
  // result.json (so gc considers run terminal-eligible).
  writeFileSync(
    join(runDir, "result.json"),
    JSON.stringify(
      {
        runId: opts.runId,
        workflowName: "synthetic",
        outcome: "done",
        startedAt: opts.endedAt,
        endedAt: opts.endedAt,
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
  return runDir;
}

function tmpRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-"));
}

const RESOLVE = (runsRoot: string) => ({
  resolveLedgerPath: (id: string) => join(runsRoot, id, "ledger.jsonl"),
});

// ─── _execFile fakes ─────────────────────────────────────────────────

interface ExecCall {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

/**
 * Fake exec for the clean-worktree case. `git status --porcelain`
 * returns empty stdout (clean); `git worktree remove` resolves.
 */
function makeExecCleanThenRemove(record: ExecCall[]): ExecFileLike {
  return (_file, args, options) => {
    record.push({ args: [...args], cwd: options?.cwd });
    if (args[0] === "status" && args[1] === "--porcelain") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
  };
}

/**
 * Fake exec for the dirty-worktree case. `git status --porcelain`
 * returns " M file.txt\n" (dirty); the remove call must NOT happen
 * unless force is set.
 */
function makeExecDirty(record: ExecCall[]): ExecFileLike {
  return (_file, args, options) => {
    record.push({ args: [...args], cwd: options?.cwd });
    if (args[0] === "status" && args[1] === "--porcelain") {
      return Promise.resolve({ stdout: " M file.txt\n", stderr: "" });
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

test("gc apply + worktree clean: prunes worktree, deletes run, info-logs prune", async () => {
  const runsRoot = tmpRunsRoot();
  const sourceRepo = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-src-"));
  // Worktree path doesn't need to exist on disk for the dirty-check
  // path, but pruneAgentWorktree's existence-check requires it. Make it.
  const worktreeAbs = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-leaf-"));

  await makeDoneRun({
    runsRoot,
    runId: "wf-prune-clean",
    endedAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString(),
    agentWorktrees: { "agent-a": worktreeAbs },
    cwd: sourceRepo,
  });

  const calls: ExecCall[] = [];
  const logs: { level: string; msg: string }[] = [];

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 1,
    apply: true,
    log: (level, msg) => logs.push({ level, msg }),
    _execFile: makeExecCleanThenRemove(calls),
    ...RESOLVE(runsRoot),
  });

  assert.equal(result.deleted.length, 1, "exactly one runDir should be deleted");
  assert.equal(result.deleted[0], "wf-prune-clean");
  assert.equal(
    existsSync(join(runsRoot, "wf-prune-clean")),
    false,
    "runDir must be gone",
  );

  // Two git invocations: status check, then remove.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.args, ["status", "--porcelain"]);
  assert.equal(calls[0]?.cwd, worktreeAbs);
  assert.deepEqual(calls[1]?.args, ["worktree", "remove", worktreeAbs]);
  assert.equal(calls[1]?.cwd, sourceRepo);

  // Logs include a prune-info line.
  const pruneLog = logs.find((l) => l.msg.includes("pruned worktree agent-a"));
  assert.ok(pruneLog, "expected info log mentioning pruned worktree");
  assert.equal(pruneLog!.level, "info");
});

test("gc apply + worktree dirty: skips prune with warn-log, still deletes runDir", async () => {
  const runsRoot = tmpRunsRoot();
  const sourceRepo = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-src-"));
  const worktreeAbs = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-leaf-"));

  await makeDoneRun({
    runsRoot,
    runId: "wf-prune-dirty",
    endedAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString(),
    agentWorktrees: { "agent-b": worktreeAbs },
    cwd: sourceRepo,
  });

  const calls: ExecCall[] = [];
  const logs: { level: string; msg: string }[] = [];

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 1,
    apply: true,
    log: (level, msg) => logs.push({ level, msg }),
    _execFile: makeExecDirty(calls),
    ...RESOLVE(runsRoot),
  });

  assert.equal(result.deleted.length, 1, "runDir still gets deleted even when worktree is left in place");

  // Only one git call — status. No `worktree remove` because dirty.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["status", "--porcelain"]);

  // Worktree dir still exists on disk.
  assert.equal(existsSync(worktreeAbs), true, "dirty worktree must be left on disk");

  const skipLog = logs.find((l) =>
    l.msg.includes("skipped dirty worktree agent-b"),
  );
  assert.ok(skipLog, "expected warn log mentioning skipped dirty worktree");
  assert.equal(skipLog!.level, "warn");
});

test("gc apply + forceRemoveDirtyWorktrees: dirty worktree gets `--force` removal", async () => {
  const runsRoot = tmpRunsRoot();
  const sourceRepo = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-src-"));
  const worktreeAbs = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-leaf-"));

  await makeDoneRun({
    runsRoot,
    runId: "wf-prune-force",
    endedAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString(),
    agentWorktrees: { "agent-c": worktreeAbs },
    cwd: sourceRepo,
  });

  const calls: ExecCall[] = [];

  // With force:true, pruneAgentWorktree skips the status check and
  // goes straight to `git worktree remove --force`.
  const exec: ExecFileLike = (_file, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd });
    return Promise.resolve({ stdout: "", stderr: "" });
  };

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 1,
    apply: true,
    forceRemoveDirtyWorktrees: true,
    _execFile: exec,
    ...RESOLVE(runsRoot),
  });

  assert.equal(result.deleted.length, 1);
  // Exactly one git invocation, with --force.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [
    "worktree",
    "remove",
    "--force",
    worktreeAbs,
  ]);
  assert.equal(calls[0]?.cwd, sourceRepo);
});

test("gc apply with pruneWorktrees:false: skips the prune step entirely", async () => {
  const runsRoot = tmpRunsRoot();
  const sourceRepo = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-src-"));
  const worktreeAbs = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-leaf-"));

  await makeDoneRun({
    runsRoot,
    runId: "wf-prune-off",
    endedAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString(),
    agentWorktrees: { "agent-d": worktreeAbs },
    cwd: sourceRepo,
  });

  const calls: ExecCall[] = [];
  const exec: ExecFileLike = (_file, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd });
    return Promise.resolve({ stdout: "", stderr: "" });
  };

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 1,
    apply: true,
    pruneWorktrees: false,
    _execFile: exec,
    ...RESOLVE(runsRoot),
  });

  assert.equal(result.deleted.length, 1);
  assert.equal(calls.length, 0, "no git invocations when pruneWorktrees:false");
  // Worktree dir still exists.
  assert.equal(existsSync(worktreeAbs), true);
});

test("gc dry-run: pruneWorktrees default ON but apply:false → no git calls", async () => {
  const runsRoot = tmpRunsRoot();
  const sourceRepo = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-src-"));
  const worktreeAbs = mkdtempSync(join(tmpdir(), "pi-wf-gc-wt-leaf-"));

  await makeDoneRun({
    runsRoot,
    runId: "wf-dryrun",
    endedAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString(),
    agentWorktrees: { "agent-e": worktreeAbs },
    cwd: sourceRepo,
  });

  const calls: ExecCall[] = [];
  const exec: ExecFileLike = (_f, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd });
    return Promise.resolve({ stdout: "", stderr: "" });
  };

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 1,
    apply: false,
    _execFile: exec,
    ...RESOLVE(runsRoot),
  });

  assert.equal(result.candidates.length, 1, "candidate should be reported");
  assert.equal(result.deleted.length, 0, "dry-run never deletes");
  assert.equal(calls.length, 0, "dry-run never calls git either");
});
