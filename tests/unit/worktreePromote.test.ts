/**
 * tests/unit/worktreePromote.test.ts — ZONE_WORKTREE follow-up #2
 *
 * `ctx.promote(agentId, opts)` host implementation: read the diff
 * snapshot from `<runDir>/worktrees/<agentId>.diff` and apply it
 * against the parent CWD (`apply` strategy), or run
 * `git rebase --onto <target>` inside the worktree (`rebase` strategy).
 *
 * Tests target three layers:
 *
 *   1. `parseDiffFiles` — pure parser; covers `+++ b/<path>`,
 *      `+++ /dev/null`, multi-file diffs.
 *   2. `extractGitApplyConflictFiles` — pulls files from a git stderr
 *      blob; covers all three of the patterns gc/rebase emit.
 *   3. `promoteAgentWorktree` — end-to-end with a real fixture diff
 *      applied against a real tmp git repo (apply strategy), plus
 *      a fake-exec test asserting the rebase command shape.
 *
 * Real-git tests use a tmp repo so we don't depend on the project
 * repo's state. Skipped automatically if `git` isn't on PATH (none of
 * our supported dev/CI machines lack it, but be polite).
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
import { execFileSync } from "node:child_process";

import {
  PromoteError,
  parseDiffFiles,
  extractGitApplyConflictFiles,
  promoteAgentWorktree,
  resolveWorktreeDiffPath,
  type ExecFileLike,
} from "../../src/runtime/worktree.ts";

// ─── parseDiffFiles ──────────────────────────────────────────────────

test("parseDiffFiles: empty diff → empty list", () => {
  assert.deepEqual(parseDiffFiles(""), []);
  assert.deepEqual(parseDiffFiles("\n\n  \n"), []);
});

test("parseDiffFiles: single-file diff with `+++ b/<path>`", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index abc..def 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(parseDiffFiles(diff), ["src/foo.ts"]);
});

test("parseDiffFiles: multi-file diff captures every `+++ b/...`", () => {
  const diff = [
    "+++ b/src/a.ts",
    "+++ b/src/b.ts",
    "+++ b/path with spaces/c.txt",
  ].join("\n");
  assert.deepEqual(parseDiffFiles(diff), [
    "src/a.ts",
    "src/b.ts",
    "path with spaces/c.txt",
  ]);
});

test("parseDiffFiles: skips `+++ /dev/null` (deletion)", () => {
  const diff = [
    "+++ /dev/null",
    "+++ b/src/added.ts",
  ].join("\n");
  assert.deepEqual(parseDiffFiles(diff), ["src/added.ts"]);
});

// ─── extractGitApplyConflictFiles ───────────────────────────────────

test("extractGitApplyConflictFiles: `error: patch failed: <path>:<lineno>`", () => {
  const stderr = "error: patch failed: src/foo.ts:42\nerror: src/foo.ts: patch does not apply";
  // Both forms point at the same file; dedup'd.
  assert.deepEqual(extractGitApplyConflictFiles(stderr), ["src/foo.ts"]);
});

test("extractGitApplyConflictFiles: rebase CONFLICT line", () => {
  const stderr = [
    "Auto-merging foo.ts",
    "CONFLICT (content): Merge conflict in foo.ts",
    "Auto-merging bar/baz.ts",
    "CONFLICT (content): Merge conflict in bar/baz.ts",
  ].join("\n");
  assert.deepEqual(extractGitApplyConflictFiles(stderr), [
    "foo.ts",
    "bar/baz.ts",
  ]);
});

test("extractGitApplyConflictFiles: empty stderr → empty list", () => {
  assert.deepEqual(extractGitApplyConflictFiles(""), []);
});

// ─── promoteAgentWorktree (apply strategy) ──────────────────────────

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeRunDir(): string {
  const runDir = tmp("pi-wf-promote-");
  mkdirSync(join(runDir, "worktrees"), { recursive: true });
  return runDir;
}

test("promoteAgentWorktree apply: ENOENT diff → PromoteError with helpful message", async () => {
  const runDir = makeRunDir();
  await assert.rejects(
    promoteAgentWorktree({
      runDirAbs: runDir,
      agentId: "agent-x",
      sourceCwd: tmp("pi-wf-promote-src-"),
      opts: { strategy: "apply" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PromoteError);
      assert.match((err as Error).message, /diff snapshot not found/);
      return true;
    },
  );
});

test("promoteAgentWorktree apply: empty diff → applied:false, files:[]", async () => {
  const runDir = makeRunDir();
  // Write an empty diff at the canonical path.
  writeFileSync(
    resolveWorktreeDiffPath({ runDirAbs: runDir, agentId: "agent-empty" }),
    "",
  );
  // Fake exec — should NOT be invoked because empty diff short-circuits.
  let invoked = 0;
  const exec: ExecFileLike = () => {
    invoked++;
    return Promise.resolve({ stdout: "", stderr: "" });
  };
  const r = await promoteAgentWorktree({
    runDirAbs: runDir,
    agentId: "agent-empty",
    sourceCwd: tmp("pi-wf-promote-src-"),
    opts: { strategy: "apply" },
    _execFile: exec,
  });
  assert.deepEqual(r, { strategy: "apply", applied: false, files: [] });
  assert.equal(invoked, 0, "no git calls for empty diff");
});

// Real-git apply: bootstrap a real source repo + a real worktree, edit
// the worktree, snapshot the diff, then apply via promoteAgentWorktree.
// Verifies the diff lands in the source.
test("promoteAgentWorktree apply: real diff applies tracked-file edits to parent repo", async () => {
  const runDir = makeRunDir();
  // 1. Create a fresh source repo with one tracked file.
  const sourceRepo = tmp("pi-wf-promote-src-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: sourceRepo });
  writeFileSync(join(sourceRepo, "f.txt"), "hello\n");
  execFileSync("git", ["add", "f.txt"], { cwd: sourceRepo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepo });

  // 2. Create a worktree at the canonical pi-workflows path and edit
  //    the tracked file.
  const wtPath = join(runDir, "worktrees", "agent-real");
  execFileSync(
    "git",
    ["worktree", "add", "--detach", wtPath],
    { cwd: sourceRepo },
  );
  writeFileSync(join(wtPath, "f.txt"), "hello\nworld\n");

  // 3. Capture diff via the same shape `emitWorktreeDiff` produces.
  const diff = execFileSync("git", ["diff", "--no-color", "HEAD"], {
    cwd: wtPath,
    encoding: "utf8",
  });
  writeFileSync(
    resolveWorktreeDiffPath({ runDirAbs: runDir, agentId: "agent-real" }),
    diff,
  );

  // 4. Promote with apply.
  const r = await promoteAgentWorktree({
    runDirAbs: runDir,
    agentId: "agent-real",
    sourceCwd: sourceRepo,
    opts: { strategy: "apply" },
  });
  assert.equal(r.strategy, "apply");
  assert.equal(r.applied, true);
  assert.deepEqual([...r.files], ["f.txt"]);

  // 5. Verify the parent has the change.
  const after = readFileSync(join(sourceRepo, "f.txt"), "utf8");
  assert.equal(after, "hello\nworld\n");
});

test("promoteAgentWorktree apply: bad strategy throws PromoteError", async () => {
  const runDir = makeRunDir();
  await assert.rejects(
    promoteAgentWorktree({
      runDirAbs: runDir,
      agentId: "agent-x",
      sourceCwd: "/fake",
      // @ts-expect-error invalid strategy on purpose
      opts: { strategy: "merge" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PromoteError);
      assert.match((err as Error).message, /strategy must be 'apply' \| 'rebase'/);
      return true;
    },
  );
});

// ─── promoteAgentWorktree (rebase strategy) ─────────────────────────

test("promoteAgentWorktree rebase: invokes `git rebase --onto <target>` in the worktree", async () => {
  const runDir = makeRunDir();
  const wtPath = join(runDir, "worktrees", "agent-r");
  // Make the dir so the existence-check passes.
  mkdirSync(wtPath, { recursive: true });

  type Capture = {
    args: readonly string[];
    cwd: string | undefined;
    invocations: number;
  };
  const cap: Capture = { args: [], cwd: undefined, invocations: 0 };
  const exec: ExecFileLike = (_file, args, options) => {
    cap.invocations++;
    if (args[0] === "rebase") {
      cap.args = [...args];
      cap.cwd = options?.cwd;
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (args[0] === "diff" && args[1] === "--name-only") {
      return Promise.resolve({ stdout: "src/x.ts\nsrc/y.ts\n", stderr: "" });
    }
    return Promise.reject(new Error(`unexpected: ${args.join(" ")}`));
  };

  const r = await promoteAgentWorktree({
    runDirAbs: runDir,
    agentId: "agent-r",
    sourceCwd: "/parent",
    opts: { strategy: "rebase", target: "main" },
    _execFile: exec,
  });
  assert.deepEqual(cap.args, ["rebase", "--onto", "main"]);
  assert.equal(cap.cwd, wtPath);
  assert.equal(r.strategy, "rebase");
  assert.equal(r.applied, true);
  assert.deepEqual([...r.files], ["src/x.ts", "src/y.ts"]);
});

test("promoteAgentWorktree rebase: target defaults to HEAD", async () => {
  const runDir = makeRunDir();
  const wtPath = join(runDir, "worktrees", "agent-default");
  mkdirSync(wtPath, { recursive: true });

  let captured: readonly string[] = [];
  const exec: ExecFileLike = (_file, args) => {
    if (args[0] === "rebase") captured = [...args];
    return Promise.resolve({ stdout: "", stderr: "" });
  };
  await promoteAgentWorktree({
    runDirAbs: runDir,
    agentId: "agent-default",
    sourceCwd: "/parent",
    opts: { strategy: "rebase" },
    _execFile: exec,
  });
  assert.deepEqual(captured, ["rebase", "--onto", "HEAD"]);
});

test("promoteAgentWorktree rebase: missing worktree dir → PromoteError", async () => {
  const runDir = makeRunDir();
  // Note: NO mkdirSync — the dir doesn't exist.
  await assert.rejects(
    promoteAgentWorktree({
      runDirAbs: runDir,
      agentId: "agent-missing",
      sourceCwd: "/parent",
      opts: { strategy: "rebase" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PromoteError);
      assert.match((err as Error).message, /worktree dir absent/);
      return true;
    },
  );
});

test("promoteAgentWorktree rebase: surfaces git error as PromoteError with conflict files", async () => {
  const runDir = makeRunDir();
  const wtPath = join(runDir, "worktrees", "agent-conflict");
  mkdirSync(wtPath, { recursive: true });
  const exec: ExecFileLike = (_file, args) => {
    if (args[0] === "rebase") {
      const err = new Error(
        "Command failed: git rebase --onto HEAD",
      ) as Error & { stderr: string };
      err.stderr =
        "Auto-merging conflict.ts\nCONFLICT (content): Merge conflict in conflict.ts";
      return Promise.reject(err);
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  };
  await assert.rejects(
    promoteAgentWorktree({
      runDirAbs: runDir,
      agentId: "agent-conflict",
      sourceCwd: "/parent",
      opts: { strategy: "rebase" },
      _execFile: exec,
    }),
    (err: unknown) => {
      assert.ok(err instanceof PromoteError);
      assert.deepEqual([...(err as PromoteError).conflictFiles], ["conflict.ts"]);
      return true;
    },
  );
});
