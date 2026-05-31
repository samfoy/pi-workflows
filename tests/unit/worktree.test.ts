/**
 * tests/unit/worktree.test.ts — ZONE_WORKTREE: per-agent git-worktree isolation.
 *
 * Coverage matrix:
 *   - parseIsolation: 'none' / undefined / null / false → null;
 *     'worktree' passes through; bad shapes throw TypeError.
 *   - resolveWorktreeDir / resolveWorktreeDiffPath: produce the
 *     documented paths; bad agent ids rejected.
 *   - assertGitRepo: passes inside a real git repo; throws
 *     NotAGitRepoError on a plain tmpdir; throws on an absent path.
 *   - createWorktreeForAgent: makes a real worktree at
 *     <runDir>/worktrees/<agentId>, returned path differs from the
 *     source repo, the worktree is detached HEAD, second create at
 *     the same agentId rejects.
 *   - emitWorktreeDiff: empty diff for clean worktree; populated diff
 *     after editing a tracked file; oversize diff truncated with the
 *     marker line.
 *   - end-to-end: dispatchAgent receives the worktree path as its
 *     cwd (verified via spawn-spy) when runOneAgent's wiring is
 *     simulated by passing the path manually — pins the contract
 *     that the dispatcher itself is unaware of worktrees.
 *   - recordAgentWorktreePath: fresh write, merge with prior manifest
 *     fields, idempotent re-record, concurrent serialization.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  assertGitRepo,
  createWorktreeForAgent,
  emitWorktreeDiff,
  NotAGitRepoError,
  parseIsolation,
  resolveWorktreeDiffPath,
  resolveWorktreeDir,
  WORKTREE_DIFF_CAP_BYTES,
  WORKTREE_DIFF_TRUNCATED_MARKER,
  WorktreeError,
  WORKTREES_DIR_NAME,
} from "../../src/runtime/worktree.ts";
import { recordAgentWorktreePath } from "../../src/runtime/manifestWriter.ts";
import { InvalidAgentIdError } from "../../src/util/paths.ts";
import { dispatchAgent } from "../../src/runtime/dispatcher.ts";
import { makeFakeSpawn } from "../helpers/fakeChild.ts";

const execFileP = promisify(execFile);

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Initialize a tiny git repo in tmpdir with one tracked file so we
 * have a HEAD to worktree off. Returns the repo's absolute path.
 *
 * `git init` defaults vary across host configs (some emit warnings
 * about default branch, some configure user.email/name globally,
 * some don't). We pin every knob locally so the tests don't depend
 * on the host's `~/.gitconfig`.
 */
async function initRepo(prefix: string): Promise<string> {
  const dir = tmp(prefix);
  await execFileP("git", ["init", "-q", "-b", "main", dir]);
  await execFileP("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", dir, "config", "user.name", "Test"]);
  await execFileP("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  await fs.writeFile(join(dir, "README.md"), "hello\n");
  await execFileP("git", ["-C", dir, "add", "."]);
  await execFileP("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

// ─── parseIsolation ─────────────────────────────────────────────────

test("parseIsolation: undefined / null / false / 'none' → null", () => {
  assert.equal(parseIsolation(undefined), null);
  assert.equal(parseIsolation(null), null);
  assert.equal(parseIsolation(false), null);
  assert.equal(parseIsolation("none"), null);
});

test("parseIsolation: 'worktree' passes through", () => {
  assert.equal(parseIsolation("worktree"), "worktree");
});

test("parseIsolation: unknown string throws TypeError", () => {
  assert.throws(() => parseIsolation("sandbox"), TypeError);
  assert.throws(() => parseIsolation(""), TypeError);
});

test("parseIsolation: non-string truthy throws TypeError", () => {
  assert.throws(() => parseIsolation(true as unknown), TypeError);
  assert.throws(() => parseIsolation({} as unknown), TypeError);
  assert.throws(() => parseIsolation(42 as unknown), TypeError);
});

// ─── resolveWorktreeDir / resolveWorktreeDiffPath ───────────────────

test("resolveWorktreeDir: <runDir>/worktrees/<agentId>", () => {
  const dir = resolveWorktreeDir({
    runDirAbs: "/run/wf-abc",
    agentId: "auditor",
  });
  assert.equal(dir, join("/run/wf-abc", WORKTREES_DIR_NAME, "auditor"));
});

test("resolveWorktreeDiffPath: <runDir>/worktrees/<agentId>.diff", () => {
  const path = resolveWorktreeDiffPath({
    runDirAbs: "/run/wf-abc",
    agentId: "auditor",
  });
  assert.equal(path, join("/run/wf-abc", WORKTREES_DIR_NAME, "auditor.diff"));
});

test("resolveWorktreeDir: rejects unsafe agentIds", () => {
  assert.throws(
    () =>
      resolveWorktreeDir({
        runDirAbs: "/run",
        agentId: "../etc",
      }),
    InvalidAgentIdError,
  );
  assert.throws(
    () =>
      resolveWorktreeDir({
        runDirAbs: "/run",
        agentId: ".hidden",
      }),
    InvalidAgentIdError,
  );
});

// ─── assertGitRepo ──────────────────────────────────────────────────

test("assertGitRepo: passes inside a real git repo", async () => {
  const repo = await initRepo("pi-wf-wt-repo-");
  await assert.doesNotReject(assertGitRepo({ cwd: repo }));
});

test("assertGitRepo: throws NotAGitRepoError on a plain tmpdir", async () => {
  const dir = tmp("pi-wf-wt-bare-");
  await assert.rejects(
    assertGitRepo({ cwd: dir }),
    (err: unknown) => err instanceof NotAGitRepoError && (err as NotAGitRepoError).cwd === dir,
  );
});

test("assertGitRepo: throws NotAGitRepoError on an absent path", async () => {
  await assert.rejects(
    assertGitRepo({ cwd: "/nonexistent/does/not/exist" }),
    NotAGitRepoError,
  );
});

test("assertGitRepo: test seam — _execFile that exits non-zero throws NotAGitRepoError", async () => {
  await assert.rejects(
    assertGitRepo({
      cwd: "/anywhere",
      _execFile: () => Promise.reject(new Error("fatal: not a git repository")),
    }),
    NotAGitRepoError,
  );
});

test("assertGitRepo: test seam — stdout 'false' is treated as not-a-repo", async () => {
  // git in some configs (inside a .git dir but not a worktree) prints
  // 'false'. We treat that the same as a non-repo cwd.
  await assert.rejects(
    assertGitRepo({
      cwd: "/anywhere",
      _execFile: () => Promise.resolve({ stdout: "false\n", stderr: "" }),
    }),
    NotAGitRepoError,
  );
});

// ─── createWorktreeForAgent ─────────────────────────────────────────

test("createWorktreeForAgent: creates a real worktree off HEAD; cwd differs from source repo", async () => {
  const repo = await initRepo("pi-wf-wt-create-");
  const runDir = tmp("pi-wf-wt-runs-");
  const path = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "agent-1",
    cwd: repo,
  });
  assert.equal(path, join(runDir, WORKTREES_DIR_NAME, "agent-1"));
  assert.notEqual(path, repo);
  assert.ok(existsSync(path), "worktree dir exists");
  // Tracked file from the source repo is materialized in the worktree.
  assert.ok(existsSync(join(path, "README.md")), "README.md materialized");
  // Worktree is in detached state — `git worktree list` shows
  // "(detached HEAD)" when --detach was used.
  const list = await execFileP("git", ["-C", repo, "worktree", "list"], {
    encoding: "utf8",
  });
  assert.ok(
    typeof list.stdout === "string" && list.stdout.includes(path),
    "worktree appears in `git worktree list`",
  );
  assert.ok(
    typeof list.stdout === "string" && /\(detached HEAD\)/.test(list.stdout),
    "worktree is detached HEAD (no stray branch)",
  );
});

test("createWorktreeForAgent: rejects unsafe agent ids", async () => {
  const runDir = tmp("pi-wf-wt-unsafe-");
  await assert.rejects(
    createWorktreeForAgent({
      runDirAbs: runDir,
      agentId: "../etc",
      cwd: "/anywhere",
    }),
    InvalidAgentIdError,
  );
});

test("createWorktreeForAgent: second create at same path throws WorktreeError", async () => {
  const repo = await initRepo("pi-wf-wt-dup-");
  const runDir = tmp("pi-wf-wt-dup-runs-");
  await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "agent-1",
    cwd: repo,
  });
  await assert.rejects(
    createWorktreeForAgent({
      runDirAbs: runDir,
      agentId: "agent-1",
      cwd: repo,
    }),
    (err: unknown) =>
      err instanceof WorktreeError &&
      (err as WorktreeError).agentId === "agent-1",
  );
});

test("createWorktreeForAgent: test seam — fake _execFile records the git args", async () => {
  const runDir = tmp("pi-wf-wt-spy-");
  let capturedArgs: readonly string[] = [];
  let capturedCwd: string | undefined;
  const path = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "agent-1",
    cwd: "/fake/repo",
    _execFile: (_file, args, options) => {
      capturedArgs = args;
      capturedCwd = options?.cwd;
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  });
  // Order/shape pin: `git worktree add --detach <path>` from the source repo cwd.
  assert.deepEqual(capturedArgs, [
    "worktree",
    "add",
    "--detach",
    path,
  ]);
  assert.equal(capturedCwd, "/fake/repo");
  assert.equal(path, join(runDir, WORKTREES_DIR_NAME, "agent-1"));
});

// ─── emitWorktreeDiff ────────────────────────────────────────────────

test("emitWorktreeDiff: clean worktree → empty diff file", async () => {
  const repo = await initRepo("pi-wf-wt-diff-clean-");
  const runDir = tmp("pi-wf-wt-diff-clean-runs-");
  const wt = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "a",
    cwd: repo,
  });
  const diffPath = resolveWorktreeDiffPath({ runDirAbs: runDir, agentId: "a" });
  await emitWorktreeDiff({ worktreePath: wt, diffPath });
  assert.ok(existsSync(diffPath), "diff file should exist even when empty");
  assert.equal(readFileSync(diffPath, "utf8"), "");
});

test("emitWorktreeDiff: edits to tracked files are captured in the diff", async () => {
  const repo = await initRepo("pi-wf-wt-diff-edit-");
  const runDir = tmp("pi-wf-wt-diff-edit-runs-");
  const wt = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "a",
    cwd: repo,
  });
  // Edit the tracked README inside the worktree only.
  writeFileSync(join(wt, "README.md"), "hello\nworld\n");
  const diffPath = resolveWorktreeDiffPath({ runDirAbs: runDir, agentId: "a" });
  await emitWorktreeDiff({ worktreePath: wt, diffPath });
  const out = readFileSync(diffPath, "utf8");
  assert.ok(out.includes("README.md"), "diff should mention the edited file");
  assert.ok(out.includes("+world"), "diff should contain the added line");
  // The source repo is untouched.
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "hello\n");
});

test("emitWorktreeDiff: oversized diff truncated with marker", async () => {
  const runDir = tmp("pi-wf-wt-diff-big-runs-");
  const diffPath = join(runDir, "agent-1.diff");
  await fs.mkdir(runDir, { recursive: true });
  // Fake _execFile returns a stdout larger than the cap.
  const oversized = "x".repeat(WORKTREE_DIFF_CAP_BYTES + 100);
  await emitWorktreeDiff({
    worktreePath: "/fake/wt",
    diffPath,
    _execFile: () => Promise.resolve({ stdout: oversized, stderr: "" }),
  });
  const written = readFileSync(diffPath, "utf8");
  // Body: cap bytes + marker.
  assert.ok(
    written.endsWith(WORKTREE_DIFF_TRUNCATED_MARKER),
    "truncated diff ends with marker",
  );
  // Buffer-byte check (chars and bytes coincide for ASCII 'x').
  assert.equal(
    Buffer.byteLength(written, "utf8"),
    WORKTREE_DIFF_CAP_BYTES + Buffer.byteLength(WORKTREE_DIFF_TRUNCATED_MARKER, "utf8"),
  );
});

test("emitWorktreeDiff: git failure surfaces as WorktreeError with cause", async () => {
  const diffPath = join(tmp("pi-wf-wt-diff-fail-"), "x.diff");
  await assert.rejects(
    emitWorktreeDiff({
      worktreePath: "/fake/wt",
      diffPath,
      _execFile: () => Promise.reject(new Error("git boom")),
    }),
    (err: unknown) =>
      err instanceof WorktreeError &&
      /git boom/.test((err as WorktreeError).message),
  );
});

// ─── recordAgentWorktreePath manifest merge ─────────────────────────

test("recordAgentWorktreePath: writes agentWorktrees into a fresh manifest", async () => {
  const dir = tmp("pi-wf-wt-manifest-");
  await recordAgentWorktreePath(dir, "agent-1", "/abs/wt");
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(json.agentWorktrees, { "agent-1": "/abs/wt" });
});

test("recordAgentWorktreePath: merges into existing manifest without clobbering other fields", async () => {
  const dir = tmp("pi-wf-wt-manifest-merge-");
  await fs.writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      runId: "wf-abc",
      workflowName: "audit",
      agentMemoryDirs: { reviewer: "/r/dir" },
      agentWorktrees: { reviewer: "/r/wt" },
    }),
  );
  await recordAgentWorktreePath(dir, "auditor", "/a/wt");
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(json.runId, "wf-abc");
  assert.equal(json.workflowName, "audit");
  // Memory dirs preserved.
  assert.deepEqual(json.agentMemoryDirs, { reviewer: "/r/dir" });
  // Worktrees merged.
  assert.deepEqual(json.agentWorktrees, {
    reviewer: "/r/wt",
    auditor: "/a/wt",
  });
});

test("recordAgentWorktreePath: idempotent re-record of same (agentId, dir) is a no-op", async () => {
  const dir = tmp("pi-wf-wt-manifest-idem-");
  await recordAgentWorktreePath(dir, "agent-1", "/wt");
  const before = readFileSync(join(dir, "manifest.json"), "utf8");
  await recordAgentWorktreePath(dir, "agent-1", "/wt");
  const after = readFileSync(join(dir, "manifest.json"), "utf8");
  assert.equal(before, after);
});

test("recordAgentWorktreePath: serializes concurrent writers into the same manifest", async () => {
  const dir = tmp("pi-wf-wt-manifest-conc-");
  await Promise.all([
    recordAgentWorktreePath(dir, "a", "/wt/a"),
    recordAgentWorktreePath(dir, "b", "/wt/b"),
    recordAgentWorktreePath(dir, "c", "/wt/c"),
  ]);
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(json.agentWorktrees, {
    a: "/wt/a",
    b: "/wt/b",
    c: "/wt/c",
  });
});

// ─── dispatcher integration: cwd actually swapped ────────────────────
//
// The dispatcher itself is unaware of worktrees — `runCtx.runOneAgent`
// computes the worktree path and passes it as `cwd` in DispatcherOptions.
// Pin that contract: when the caller supplies the worktree path, the
// spawned child sees that path as its cwd, distinct from the source
// repo.

function makeAgentEnd(text: string): Record<string, unknown> {
  return {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "x" }] },
      { role: "assistant", content: [{ type: "text", text }] },
    ],
  };
}

test("dispatchAgent: cwd argument is honored verbatim — agent sees the worktree path, not the source repo", async () => {
  const repo = await initRepo("pi-wf-wt-disp-repo-");
  const runDir = tmp("pi-wf-wt-disp-runs-");
  // Simulate runCtx's pre-dispatch worktree wiring.
  const wt = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "agent-1",
    cwd: repo,
  });
  assert.notEqual(wt, repo);

  const stdout = JSON.stringify(makeAgentEnd("ok")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stdout], exitCode: 0 }]);

  const result = await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "do work",
    promptHash: "h",
    cwd: wt,
    spawn: fake.spawn,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  // The spawn options carry the worktree as cwd, NOT the source repo.
  assert.equal(fake.calls[0]!.options.cwd, wt);
  assert.notEqual(fake.calls[0]!.options.cwd, repo);
});

// ─── error path: worktree retained for inspection ───────────────────

test("emitWorktreeDiff failure path: worktree dir is left untouched for inspection", async () => {
  const repo = await initRepo("pi-wf-wt-retain-");
  const runDir = tmp("pi-wf-wt-retain-runs-");
  const wt = await createWorktreeForAgent({
    runDirAbs: runDir,
    agentId: "agent-1",
    cwd: repo,
  });
  // Edit a file so a "real run" would have produced a diff.
  writeFileSync(join(wt, "README.md"), "hello\nworld\n");
  const diffPath = resolveWorktreeDiffPath({
    runDirAbs: runDir,
    agentId: "agent-1",
  });
  // Force diff capture to fail. Per contract: WorktreeError thrown,
  // worktree itself is NOT removed.
  await assert.rejects(
    emitWorktreeDiff({
      worktreePath: wt,
      diffPath,
      _execFile: () => Promise.reject(new Error("git diff exploded")),
    }),
    WorktreeError,
  );
  assert.ok(existsSync(wt), "worktree retained on diff failure");
  assert.equal(
    readFileSync(join(wt, "README.md"), "utf8"),
    "hello\nworld\n",
    "agent's edits inside the worktree are preserved",
  );
});
