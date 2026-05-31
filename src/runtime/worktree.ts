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
