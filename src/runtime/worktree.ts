/**
 * pi-workflows — per-agent git-worktree isolation (ZONE_WORKTREE).
 *
 * Lets an agent run inside its own checkout of the parent repo so
 * concurrent file edits don't fight over the same paths
 * (gap-analysis 2026-05-31 §3 — "No git-worktree isolation per
 * agent"). Surface mirrors ZONE_MEMORY:
 *
 *   ctx.agent(prompt, { isolation: 'worktree' })
 *
 * On dispatch the runtime:
 *
 *   1. Asserts the run cwd is inside a git work tree. If not, throws
 *      `NotAGitRepoError` — workflow author bug, fail loud.
 *   2. `git worktree add --detach <runDir>/worktrees/<agentId>` off
 *      the current HEAD. The worktree starts in detached state so
 *      no stray branch is created.
 *   3. Rewrites the dispatcher's `cwd` to that worktree path.
 *   4. Records `agentWorktrees: { [agentId]: <path> }` into the run
 *      manifest so a resumed parent re-attaches the same checkout.
 *
 * Lifecycle:
 *
 *   - On agent **success** the runtime emits a diff at
 *     `<runDir>/worktrees/<agentId>.diff` (output of `git diff HEAD`
 *     run inside the worktree). The worktree itself is **not**
 *     auto-removed today — see `docs/agent-worktree.md` for the
 *     prune/rebase follow-up.
 *   - On agent **error** the worktree and any uncommitted edits are
 *     left in place for the operator to inspect.
 *
 * Path safety: the `<agentId>` segment of the worktree path is
 * already validated upstream via `assertSafeAgentId`; this module
 * re-validates defensively so a unit-test harness that bypasses
 * `runCtx` still can't escape the per-run `worktrees/` dir.
 *
 * Test seam: every git invocation routes through the optional
 * `_execFile` shape so the unit tests can swap in a fake without
 * needing a real git binary on $PATH (the happy-path tests do use
 * real git in a tmp repo — git is assumed available on dev/CI
 * machines, same as `crashSweep.ts`'s sysctl call on macOS).
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { assertSafeAgentId } from "../util/paths.js";

const execFileP = promisify(execFile);

/** The two values `opts.isolation` may carry. */
export type IsolationMode = "worktree" | "none";

/** Sub-directory of `<runDir>` that holds every worktree + diff. */
export const WORKTREES_DIR_NAME = "worktrees";

/** Suffix used for the per-agent diff snapshot on success. */
export const WORKTREE_DIFF_SUFFIX = ".diff";

/**
 * Maximum bytes captured into `<agentId>.diff`. Real workflows should
 * never produce a diff this big against HEAD, but a misbehaving
 * agent that rewrites everything could — we cap to keep the runDir
 * from blowing up the operator's home partition. The diff file is
 * truncated and a marker line is appended when the cap is hit.
 */
export const WORKTREE_DIFF_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Marker appended to a truncated diff so an operator reading the file
 * knows it isn't the full picture. Identical shape to a comment-style
 * line so re-running `git apply` would still warn loudly rather than
 * silently dropping the tail.
 */
export const WORKTREE_DIFF_TRUNCATED_MARKER =
  "\n# pi-workflows: diff truncated (exceeded WORKTREE_DIFF_CAP_BYTES)\n";

/** Generic worktree-isolation failure — workflow-author or env bug. */
export class WorktreeError extends Error {
  readonly agentId: string | null;
  readonly cwd: string | null;
  constructor(opts: {
    message: string;
    agentId?: string | null;
    cwd?: string | null;
    cause?: unknown;
  }) {
    super(
      opts.message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "WorktreeError";
    this.agentId = opts.agentId ?? null;
    this.cwd = opts.cwd ?? null;
  }
}

/**
 * Subclass thrown by `assertGitRepo` when the given cwd is not inside
 * a git work tree. Carries the original cwd so the runtime can ledger
 * it for diagnosis without re-walking the filesystem.
 */
export class NotAGitRepoError extends WorktreeError {
  constructor(opts: { cwd: string; cause?: unknown }) {
    super({
      message: `cwd is not inside a git work tree: ${opts.cwd}`,
      cwd: opts.cwd,
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = "NotAGitRepoError";
  }
}

/**
 * Parse `opts.isolation` into a typed mode. Returns `null` for
 * `'none'`, `false`, `undefined`, `null` — the runtime treats any of
 * these as "skip the worktree path entirely" so feature-disabled is
 * bit-identical to the previous code path. The only non-null result
 * today is `'worktree'`; the function signature reflects that so
 * callers don't need to handle a hypothetical `'none'`.
 *
 * Throws `TypeError` for shapes that look like an attempted enable
 * but with the wrong type (e.g. `{}`, `42`, `'sandbox'`) so authors
 * get an immediate, clear error instead of silently-disabled
 * isolation.
 */
export function parseIsolation(raw: unknown): "worktree" | null {
  if (raw === undefined || raw === null || raw === false || raw === "none") {
    return null;
  }
  if (raw === "worktree") return "worktree";
  throw new TypeError(
    `ctx.agent: opts.isolation must be 'worktree' | 'none' | false (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Test seam — same shape as `util.promisify(execFile)`'s return for
 * the calls we make. Tests inject a fake to avoid real git.
 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; encoding?: "utf8" | "buffer"; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface AssertGitRepoOpts {
  readonly cwd: string;
  readonly _execFile?: ExecFileLike;
}

/**
 * Verify `cwd` is inside a git work tree. Runs
 * `git rev-parse --is-inside-work-tree` and inspects stdout. Throws
 * `NotAGitRepoError` on non-zero exit (the typical "not a git
 * repository" stderr) or any other git error.
 */
export async function assertGitRepo(opts: AssertGitRepoOpts): Promise<void> {
  const exec = opts._execFile ?? execFileP;
  try {
    const r = await exec(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: opts.cwd, encoding: "utf8" },
    );
    const out = (typeof r.stdout === "string"
      ? r.stdout
      : r.stdout.toString("utf8")
    ).trim();
    if (out !== "true") {
      throw new NotAGitRepoError({ cwd: opts.cwd });
    }
  } catch (err) {
    if (err instanceof NotAGitRepoError) throw err;
    // git exits non-zero outside a repo; node's exec rejects with the
    // ChildProcessError; surface as the typed shape the runtime can
    // route to the ledger without sniffing exit codes.
    throw new NotAGitRepoError({ cwd: opts.cwd, cause: err });
  }
}

export interface ResolveWorktreeOpts {
  readonly runDirAbs: string;
  readonly agentId: string;
}

/** Absolute path of the worktree directory for one (run, agent) pair. */
export function resolveWorktreeDir(opts: ResolveWorktreeOpts): string {
  assertSafeAgentId(opts.agentId);
  return join(opts.runDirAbs, WORKTREES_DIR_NAME, opts.agentId);
}

/** Absolute path of the per-agent diff snapshot emitted on success. */
export function resolveWorktreeDiffPath(opts: ResolveWorktreeOpts): string {
  assertSafeAgentId(opts.agentId);
  return join(
    opts.runDirAbs,
    WORKTREES_DIR_NAME,
    `${opts.agentId}${WORKTREE_DIFF_SUFFIX}`,
  );
}

export interface CreateWorktreeOpts {
  readonly runDirAbs: string;
  readonly agentId: string;
  /**
   * The run's working directory. Must be inside a git work tree —
   * caller is expected to have called `assertGitRepo` first, but we
   * pass it through so the `git worktree add` invocation runs from
   * the right place regardless of the parent process's cwd.
   */
  readonly cwd: string;
  readonly _execFile?: ExecFileLike;
}

/**
 * Create a new git worktree at `<runDir>/worktrees/<agentId>` off
 * the current HEAD in detached state. Returns the absolute path.
 *
 * Behavior:
 *   - Validates `agentId` (no separators, no `..`, no leading `.`).
 *   - mkdirp's the parent `worktrees/` directory so the first agent
 *     in a run doesn't ENOENT on the rename.
 *   - Calls `git worktree add --detach <path>` from `cwd` so the
 *     worktree's reflog points at the source repo.
 *   - On any git failure, throws `WorktreeError` with the original
 *     stderr captured as `.cause`.
 *
 * Idempotency: re-creating the same `(runDir, agentId)` worktree
 * fails — `git worktree add` refuses an existing path. Resume re-
 * uses the previously-created worktree by reading the manifest and
 * skipping the create step (caller's responsibility).
 */
export async function createWorktreeForAgent(
  opts: CreateWorktreeOpts,
): Promise<string> {
  const exec = opts._execFile ?? execFileP;
  const worktreePath = resolveWorktreeDir({
    runDirAbs: opts.runDirAbs,
    agentId: opts.agentId,
  });
  // Ensure the parent dir exists. The worktree path itself MUST NOT
  // exist before `git worktree add` — git refuses an existing path.
  await fs.mkdir(join(opts.runDirAbs, WORKTREES_DIR_NAME), { recursive: true });
  try {
    await exec(
      "git",
      ["worktree", "add", "--detach", worktreePath],
      { cwd: opts.cwd, encoding: "utf8" },
    );
  } catch (err) {
    throw new WorktreeError({
      message: `git worktree add failed for agent ${opts.agentId}: ${(err as Error).message}`,
      agentId: opts.agentId,
      cwd: opts.cwd,
      cause: err,
    });
  }
  return worktreePath;
}

export interface EmitDiffOpts {
  readonly worktreePath: string;
  readonly diffPath: string;
  readonly _execFile?: ExecFileLike;
}

/**
 * Capture the agent's uncommitted changes as `git diff HEAD` and
 * write them to `<diffPath>`. Empty diff (the agent made no edits)
 * still writes an empty file so an operator can distinguish "diff
 * not yet captured" (file absent) from "agent ran but changed
 * nothing" (file present, empty).
 *
 * Truncation: anything over `WORKTREE_DIFF_CAP_BYTES` is cut at the
 * cap and the marker `WORKTREE_DIFF_TRUNCATED_MARKER` is appended.
 * The on-disk worktree is left intact for a human to inspect.
 *
 * Failures bubble up as `WorktreeError` so the runtime can ledger
 * them; the worktree itself is left untouched (the operator can
 * still cd in and inspect).
 */
export async function emitWorktreeDiff(opts: EmitDiffOpts): Promise<void> {
  const exec = opts._execFile ?? execFileP;
  let stdout: string;
  try {
    const r = await exec(
      "git",
      // --no-color so the diff file is consumable by `git apply`
      // and not littered with ANSI escapes when GIT_PAGER colorizes.
      ["diff", "--no-color", "HEAD"],
      {
        cwd: opts.worktreePath,
        encoding: "utf8",
        // node's default 1 MiB maxBuffer would reject a large diff
        // before we get a chance to truncate ourselves; lift the cap
        // so we can emit a controlled truncation marker.
        maxBuffer: WORKTREE_DIFF_CAP_BYTES * 2,
      },
    );
    stdout = typeof r.stdout === "string"
      ? r.stdout
      : r.stdout.toString("utf8");
  } catch (err) {
    throw new WorktreeError({
      message: `git diff HEAD failed in worktree ${opts.worktreePath}: ${(err as Error).message}`,
      cwd: opts.worktreePath,
      cause: err,
    });
  }
  let body = stdout;
  if (Buffer.byteLength(body, "utf8") > WORKTREE_DIFF_CAP_BYTES) {
    // Slice on bytes, not chars, so multi-byte sequences don't get
    // cut mid-codepoint. Buffer.subarray is byte-accurate.
    body =
      Buffer.from(body, "utf8").subarray(0, WORKTREE_DIFF_CAP_BYTES).toString("utf8") +
      WORKTREE_DIFF_TRUNCATED_MARKER;
  }
  await fs.writeFile(opts.diffPath, body, "utf8");
}

// ─── Follow-up #1: auto-prune (gc integration) ─────────────────

export interface PruneWorktreeOpts {
  /** Worktree path to prune (absolute). */
  readonly worktreePath: string;
  /**
   * The source repo's working directory. `git worktree remove` is run
   * from here so the worktree's metadata in the source's `.git/worktrees/`
   * is properly cleaned up.
   */
  readonly sourceCwd: string;
  /**
   * When true, removes a worktree even if it has uncommitted changes
   * (`git worktree remove --force`). Defaults to false — the safer
   * shape, since the diff snapshot already captured the changes.
   */
  readonly force?: boolean;
  readonly _execFile?: ExecFileLike;
}

export interface PruneWorktreeResult {
  /** True if `git worktree remove` was actually invoked. */
  readonly removed: boolean;
  /** True if the worktree was skipped because it had uncommitted edits. */
  readonly skippedDirty: boolean;
  /** The reason text suitable for logging. */
  readonly reason: string;
}

/**
 * Prune a worktree previously created by `createWorktreeForAgent`.
 * Behavior:
 *
 *   - If the worktree path doesn't exist: noop, returns `removed:false`.
 *   - Else, runs `git status --porcelain` inside the worktree. If the
 *     output is non-empty (uncommitted changes) AND `force` is not set:
 *     skip + `removed:false, skippedDirty:true`. The caller is expected
 *     to log the warning.
 *   - Else, runs `git worktree remove <path>` from `sourceCwd`. With
 *     `force:true`, passes `--force`.
 *
 * Failures (e.g. git binary missing, source repo gone) bubble up as
 * `WorktreeError` so the caller (gc) can surface them. Pruning is best-
 * effort; the caller decides whether to keep walking other worktrees.
 */
export async function pruneAgentWorktree(
  opts: PruneWorktreeOpts,
): Promise<PruneWorktreeResult> {
  const exec = opts._execFile ?? execFileP;
  // 1. Existence check — bail cheap if the path is already gone.
  try {
    const st = await fs.stat(opts.worktreePath);
    if (!st.isDirectory()) {
      return {
        removed: false,
        skippedDirty: false,
        reason: `worktree path is not a directory: ${opts.worktreePath}`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        removed: false,
        skippedDirty: false,
        reason: `worktree already absent: ${opts.worktreePath}`,
      };
    }
    throw new WorktreeError({
      message: `pruneAgentWorktree: stat ${opts.worktreePath} failed: ${(err as Error).message}`,
      cwd: opts.worktreePath,
      cause: err,
    });
  }

  // 2. Dirty-check — unless caller passed force.
  if (!opts.force) {
    let porcelain = "";
    try {
      const r = await exec(
        "git",
        ["status", "--porcelain"],
        { cwd: opts.worktreePath, encoding: "utf8" },
      );
      porcelain = (typeof r.stdout === "string"
        ? r.stdout
        : r.stdout.toString("utf8")
      ).trim();
    } catch (err) {
      throw new WorktreeError({
        message: `pruneAgentWorktree: git status failed in ${opts.worktreePath}: ${(err as Error).message}`,
        cwd: opts.worktreePath,
        cause: err,
      });
    }
    if (porcelain.length > 0) {
      return {
        removed: false,
        skippedDirty: true,
        reason: `worktree has uncommitted changes (${porcelain.split("\n").length} entries); pass force:true to override`,
      };
    }
  }

  // 3. Actual removal.
  const args = opts.force
    ? ["worktree", "remove", "--force", opts.worktreePath]
    : ["worktree", "remove", opts.worktreePath];
  try {
    await exec("git", args, { cwd: opts.sourceCwd, encoding: "utf8" });
  } catch (err) {
    throw new WorktreeError({
      message: `git worktree remove failed for ${opts.worktreePath}: ${(err as Error).message}`,
      cwd: opts.sourceCwd,
      cause: err,
    });
  }
  return {
    removed: true,
    skippedDirty: false,
    reason: opts.force ? "removed (force)" : "removed",
  };
}

// ─── Follow-up #2: ctx.promote helper ────────────────────────────

/** Strategies supported by `ctx.promote`. */
export type PromoteStrategy = "apply" | "rebase";

export interface PromoteOpts {
  /** Default 'apply'. */
  readonly strategy?: PromoteStrategy;
  /**
   * Only used by 'rebase' — the parent ref to rebase onto. Default 'HEAD'.
   * For 'apply', the diff is applied at the parent's current HEAD; this
   * field is ignored.
   */
  readonly target?: string;
}

export interface PromoteResult {
  readonly strategy: PromoteStrategy;
  /** True if the promotion changed parent files. */
  readonly applied: boolean;
  /** Files that were touched (parsed from the diff or the rebase output). */
  readonly files: readonly string[];
}

/** Generic promote failure; thrown for malformed input + git failures. */
export class PromoteError extends WorktreeError {
  /** Files git complained about (conflicts on apply, conflicts on rebase). */
  readonly conflictFiles: readonly string[];
  constructor(opts: {
    message: string;
    agentId?: string | null;
    cwd?: string | null;
    conflictFiles?: readonly string[];
    cause?: unknown;
  }) {
    super({
      message: opts.message,
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = "PromoteError";
    this.conflictFiles = opts.conflictFiles ?? [];
  }
}

/**
 * Parse `+++ b/<path>` lines out of a unified diff to surface the
 * touched-file list back to the caller. Tolerates an empty / whitespace-
 * only diff (returns []). Strips the `b/` prefix git uses by default.
 */
export function parseDiffFiles(diff: string): string[] {
  const out: string[] = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("+++ ")) continue;
    let p = line.slice(4).trim();
    // git emits `+++ /dev/null` for deletes.
    if (p === "/dev/null") continue;
    // Strip `b/` prefix (default git diff prefix).
    if (p.startsWith("b/")) p = p.slice(2);
    if (p.length > 0) out.push(p);
  }
  return out;
}

export interface PromoteAgentOpts {
  readonly runDirAbs: string;
  readonly agentId: string;
  /** Parent CWD where the diff is applied (or rebase --onto runs against). */
  readonly sourceCwd: string;
  readonly opts: PromoteOpts;
  readonly _execFile?: ExecFileLike;
  /** Test seam: read the diff file. Defaults to fs.readFile utf8. */
  readonly _readFile?: (path: string) => Promise<string>;
}

/**
 * Promote an agent's worktree changes back into the parent repo.
 *
 * 'apply' (default): reads `<runDir>/worktrees/<agentId>.diff` (the
 * snapshot `emitWorktreeDiff` wrote on agent success) and runs
 * `git apply <diff>` against `sourceCwd`. On conflict, throws
 * `PromoteError` with the conflict files extracted from git's stderr.
 *
 * 'rebase': runs `git rebase --onto <target>` inside the worktree.
 * Lets the operator handle conflicts directly (git leaves the worktree
 * in a rebase-in-progress state). On non-zero exit, the error is
 * wrapped as `PromoteError` so the caller can surface it cleanly.
 *
 * Returns `{ strategy, applied, files }`. `files` is the union of
 * touched paths, parsed from the diff for 'apply' and from
 * `git diff --name-only HEAD~1` after 'rebase'.
 */
export async function promoteAgentWorktree(
  optsIn: PromoteAgentOpts,
): Promise<PromoteResult> {
  const exec = optsIn._execFile ?? execFileP;
  const readFile = optsIn._readFile ?? ((p: string) => fs.readFile(p, "utf8"));
  const strategy: PromoteStrategy = optsIn.opts.strategy ?? "apply";
  if (strategy !== "apply" && strategy !== "rebase") {
    throw new PromoteError({
      message: `ctx.promote: opts.strategy must be 'apply' | 'rebase' (got ${JSON.stringify(strategy)})`,
      agentId: optsIn.agentId,
      cwd: optsIn.sourceCwd,
    });
  }
  assertSafeAgentId(optsIn.agentId);

  if (strategy === "apply") {
    const diffPath = resolveWorktreeDiffPath({
      runDirAbs: optsIn.runDirAbs,
      agentId: optsIn.agentId,
    });
    let diff: string;
    try {
      diff = await readFile(diffPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new PromoteError({
        message:
          code === "ENOENT"
            ? `ctx.promote: diff snapshot not found at ${diffPath} (was the agent successful, with isolation:'worktree'?)`
            : `ctx.promote: failed to read diff at ${diffPath}: ${(err as Error).message}`,
        agentId: optsIn.agentId,
        cwd: optsIn.sourceCwd,
        cause: err,
      });
    }
    if (diff.trim().length === 0) {
      // Empty diff — agent edited nothing. No-op success.
      return { strategy: "apply", applied: false, files: [] };
    }
    const files = parseDiffFiles(diff);
    try {
      // Pipe the diff to `git apply` via stdin so we don't have to
      // worry about argv length limits or path escaping.
      await runGitApply({
        cwd: optsIn.sourceCwd,
        diff,
        exec,
      });
    } catch (err) {
      const conflicts = extractGitApplyConflictFiles(
        err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err),
      );
      throw new PromoteError({
        message: `git apply failed: ${(err as Error).message}`,
        agentId: optsIn.agentId,
        cwd: optsIn.sourceCwd,
        conflictFiles: conflicts,
        cause: err,
      });
    }
    return { strategy: "apply", applied: files.length > 0, files };
  }

  // strategy === 'rebase'
  const target = optsIn.opts.target ?? "HEAD";
  const worktreePath = resolveWorktreeDir({
    runDirAbs: optsIn.runDirAbs,
    agentId: optsIn.agentId,
  });
  try {
    await fs.stat(worktreePath);
  } catch (err) {
    throw new PromoteError({
      message: `ctx.promote: worktree dir absent at ${worktreePath} — cannot rebase`,
      agentId: optsIn.agentId,
      cwd: worktreePath,
      cause: err,
    });
  }
  try {
    await exec("git", ["rebase", "--onto", target], {
      cwd: worktreePath,
      encoding: "utf8",
    });
  } catch (err) {
    const stderr =
      (err as Error & { stderr?: string })?.stderr ??
      (err as Error).message ??
      String(err);
    throw new PromoteError({
      message: `git rebase --onto ${target} failed: ${(err as Error).message}`,
      agentId: optsIn.agentId,
      cwd: worktreePath,
      conflictFiles: extractGitApplyConflictFiles(stderr),
      cause: err,
    });
  }
  // Surface touched files so the caller has the same shape as 'apply'.
  let files: string[] = [];
  try {
    const r = await exec(
      "git",
      ["diff", "--name-only", `${target}..HEAD`],
      { cwd: worktreePath, encoding: "utf8" },
    );
    const out = (typeof r.stdout === "string"
      ? r.stdout
      : r.stdout.toString("utf8")
    ).trim();
    files = out.length === 0 ? [] : out.split("\n");
  } catch {
    // Non-fatal — returning an empty file list is fine for the
    // success path; the rebase already landed.
  }
  return { strategy: "rebase", applied: files.length > 0, files };
}

/**
 * Internal: feed a unified diff to `git apply` over stdin so the
 * caller doesn't have to write to a tmp file. Mirrors the test seam
 * shape but uses real `child_process.spawn` so we can pipe stdin —
 * `execFile` doesn't expose stdin to the parent.
 */
async function runGitApply(opts: {
  cwd: string;
  diff: string;
  exec: ExecFileLike;
}): Promise<void> {
  // Test seam: when an injected exec is provided, dispatch through it
  // so unit tests can intercept (the diff goes via env-var smuggling
  // because ExecFileLike has no stdin field). Production path uses a
  // real spawn-with-stdin below.
  if (opts.exec !== execFileP) {
    await opts.exec("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: opts.cwd,
      encoding: "utf8",
    });
    return;
  }
  // Production: spawn `git apply -` and write the diff to stdin.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const err = new Error(
          `git apply exited ${code}: ${stderr.trim()}`,
        ) as Error & { stderr: string; code: number | null };
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
    child.stdin?.end(opts.diff, "utf8");
  });
}

/**
 * Extract `path` segments from a git-apply / git-rebase stderr blob.
 * Both commands emit lines like `error: patch failed: src/foo.ts:42`
 * and `error: src/foo.ts: patch does not apply`. We collect any path-
 * looking token after `:` and dedupe.
 */
export function extractGitApplyConflictFiles(stderr: string): string[] {
  const found = new Set<string>();
  const lines = stderr.split("\n");
  for (const line of lines) {
    // "error: patch failed: <path>:<lineno>"
    const m1 = /error: patch failed:\s+(.+?):(\d+)/.exec(line);
    if (m1 && m1[1]) {
      found.add(m1[1]);
      continue;
    }
    // "error: <path>: patch does not apply"
    const m2 = /error:\s+(.+?):\s+patch does not apply/.exec(line);
    if (m2 && m2[1]) {
      found.add(m2[1]);
      continue;
    }
    // "CONFLICT (content): Merge conflict in <path>"
    const m3 = /CONFLICT \([^)]+\):\s+Merge conflict in\s+(.+)$/.exec(line);
    if (m3 && m3[1]) {
      found.add(m3[1].trim());
      continue;
    }
  }
  return [...found];
}

// ─── Follow-up #4: resume cross-check ──────────────────────────

export interface WorktreeMismatch {
  readonly agentId: string;
  readonly recordedDir: string;
  /**
   * Why the mismatch fired:
   *   - `missing-on-disk`: stat(recordedDir) failed.
   *   - `not-registered`: the dir is on disk but `git worktree list`
   *     in `sourceCwd` does NOT include it.
   */
  readonly reason: "missing-on-disk" | "not-registered";
}

export interface CrossCheckWorktreesOpts {
  /** Map from manifest.agentWorktrees: { <agentId>: <absPath> }. */
  readonly recorded: Readonly<Record<string, string>>;
  /** Source repo to query `git worktree list --porcelain` against. */
  readonly sourceCwd: string;
  readonly _execFile?: ExecFileLike;
  /** Test seam: stat replacement returning bool (exists). */
  readonly _existsOnDisk?: (path: string) => Promise<boolean>;
}

/**
 * Verify each `manifest.agentWorktrees[id]` still exists on disk AND
 * appears in `git worktree list --porcelain` output for `sourceCwd`.
 *
 * Returns the list of mismatches (empty if all good). Resume callers
 * surface each as a `log: warn` ledger entry; this function never
 * throws (a missing git binary is treated as "all entries can't be
 * registered" and surfaces every recorded entry as `not-registered`).
 */
export async function crossCheckAgentWorktrees(
  opts: CrossCheckWorktreesOpts,
): Promise<WorktreeMismatch[]> {
  const exec = opts._execFile ?? execFileP;
  const exists =
    opts._existsOnDisk ??
    (async (p: string) => {
      try {
        await fs.stat(p);
        return true;
      } catch {
        return false;
      }
    });

  // Snapshot registered worktrees once.
  let registered = new Set<string>();
  try {
    const r = await exec(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: opts.sourceCwd, encoding: "utf8" },
    );
    const out = typeof r.stdout === "string"
      ? r.stdout
      : r.stdout.toString("utf8");
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        registered.add(line.slice("worktree ".length).trim());
      }
    }
  } catch {
    // git failure — leave `registered` empty; every recorded entry
    // will surface as `not-registered`. Caller sees a flood of
    // warnings, which is the right signal that the source repo is
    // misconfigured.
    registered = new Set<string>();
  }

  const out: WorktreeMismatch[] = [];
  for (const [agentId, recordedDir] of Object.entries(opts.recorded)) {
    if (typeof recordedDir !== "string" || recordedDir.length === 0) continue;
    if (!(await exists(recordedDir))) {
      out.push({ agentId, recordedDir, reason: "missing-on-disk" });
      continue;
    }
    if (!registered.has(recordedDir)) {
      out.push({ agentId, recordedDir, reason: "not-registered" });
    }
  }
  return out;
}
