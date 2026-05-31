/**
 * tests/unit/worktreeResumeCheck.test.ts — ZONE_WORKTREE follow-up #4
 *
 * `crossCheckAgentWorktrees(opts)` resume invariant: each
 * `manifest.agentWorktrees[id]` must (a) still exist on disk and
 * (b) appear in `git worktree list --porcelain` for the parent's
 * sourceCwd. Mismatches surface to resumeRun, which logs a warn
 * ledger entry per agent.
 *
 * Cases:
 *   - Empty recorded → empty mismatch list.
 *   - All recorded entries match → empty mismatch list.
 *   - Recorded dir absent from disk → `missing-on-disk`.
 *   - Recorded dir on disk but not in `git worktree list` → `not-registered`.
 *   - git binary fails → every recorded entry surfaces as `not-registered`.
 *
 * Tests use the `_execFile` and `_existsOnDisk` seams so we never
 * spawn real git or hit a fake fs path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  crossCheckAgentWorktrees,
  type ExecFileLike,
} from "../../src/runtime/worktree.ts";

// ─── Tests ───────────────────────────────────────────────────────────

test("crossCheckAgentWorktrees: empty recorded → empty mismatch list", async () => {
  const r = await crossCheckAgentWorktrees({
    recorded: {},
    sourceCwd: "/source",
    _execFile: () =>
      Promise.resolve({ stdout: "worktree /source\nbare\n", stderr: "" }),
    _existsOnDisk: async () => true,
  });
  assert.deepEqual(r, []);
});

test("crossCheckAgentWorktrees: all recorded match registered → empty", async () => {
  const recorded = {
    "agent-a": "/source/.worktrees/a",
    "agent-b": "/source/.worktrees/b",
  };
  const exec: ExecFileLike = () =>
    Promise.resolve({
      stdout:
        "worktree /source\nHEAD abc\n\nworktree /source/.worktrees/a\nHEAD def\n\nworktree /source/.worktrees/b\nHEAD ghi\n",
      stderr: "",
    });
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async () => true,
  });
  assert.deepEqual(r, []);
});

test("crossCheckAgentWorktrees: recorded dir absent from disk → missing-on-disk", async () => {
  const recorded = { "agent-deleted": "/run/wf-1/worktrees/agent-deleted" };
  const exec: ExecFileLike = () =>
    Promise.resolve({ stdout: "worktree /source\n", stderr: "" });
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async (p) => p !== "/run/wf-1/worktrees/agent-deleted",
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.agentId, "agent-deleted");
  assert.equal(r[0]!.recordedDir, "/run/wf-1/worktrees/agent-deleted");
  assert.equal(r[0]!.reason, "missing-on-disk");
});

test("crossCheckAgentWorktrees: dir exists but git worktree list does not include it → not-registered", async () => {
  const recorded = { "agent-stale": "/somewhere/orphan" };
  // git worktree list does NOT include /somewhere/orphan.
  const exec: ExecFileLike = () =>
    Promise.resolve({
      stdout: "worktree /source\nHEAD abc\n",
      stderr: "",
    });
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async () => true,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.agentId, "agent-stale");
  assert.equal(r[0]!.reason, "not-registered");
});

test("crossCheckAgentWorktrees: git binary fails → all recorded surface as not-registered", async () => {
  const recorded = {
    "agent-x": "/anywhere/x",
    "agent-y": "/anywhere/y",
  };
  const exec: ExecFileLike = () =>
    Promise.reject(new Error("git not found"));
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async () => true,
  });
  assert.equal(r.length, 2);
  assert.equal(r[0]!.reason, "not-registered");
  assert.equal(r[1]!.reason, "not-registered");
});

test("crossCheckAgentWorktrees: skips empty / non-string recorded values", async () => {
  // Manifest hand-edit could leave a string entry empty; tolerate it.
  const recorded = {
    "agent-a": "/source/.worktrees/a",
    "agent-empty": "",
  };
  const exec: ExecFileLike = () =>
    Promise.resolve({
      stdout: "worktree /source\nworktree /source/.worktrees/a\n",
      stderr: "",
    });
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async () => true,
  });
  // empty entry is silently skipped.
  assert.deepEqual(r, []);
});

test("crossCheckAgentWorktrees: missing-on-disk takes precedence over not-registered", async () => {
  // dir is missing AND not in `git worktree list` — report missing-on-disk
  // first (it's the more actionable signal).
  const recorded = { "agent-z": "/gone/and/forgotten" };
  const exec: ExecFileLike = () =>
    Promise.resolve({ stdout: "worktree /source\n", stderr: "" });
  const r = await crossCheckAgentWorktrees({
    recorded,
    sourceCwd: "/source",
    _execFile: exec,
    _existsOnDisk: async () => false,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.reason, "missing-on-disk");
});
