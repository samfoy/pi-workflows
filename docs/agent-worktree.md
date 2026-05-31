# Per-agent git-worktree isolation (ZONE_WORKTREE)

Status: **shipped 2026-05-31** — create + cwd-rewrite + diff-on-success
+ manifest record + auto-prune (GC) + `ctx.promote(agentId)` +
resume cross-check. Submodule/LFS + named-branch flag still deferred
(see follow-ups).

## Surface

```js
ctx.agent("apply the migration", {
  isolation: "worktree", // 'worktree' | 'none' (default 'none')
});
```

When `isolation` is `'worktree'`, the runtime:

1. Asserts the run cwd is inside a git work tree
   (`git rev-parse --is-inside-work-tree`). On failure, throws
   `NotAGitRepoError` — workflow-author bug, surfaced via the same
   `agent_error` ledger entry used for any other dispatch failure.
2. `git worktree add --detach <runDir>/worktrees/<agentId>` off the
   current HEAD. Detached state means no stray branch is created;
   the worktree's reflog still points at the source repo so an
   operator can `cd` in and run `git diff`/`git log` directly.
3. Records `agentWorktrees: { [agentId]: <absPath> }` into
   `<runDir>/manifest.json` so a resumed parent re-attaches the
   same checkout.
4. Rewrites the dispatcher's `cwd` to that worktree path. The
   sub-agent (`pi --mode json -p`) sees the worktree as its
   working directory and any file edits land there.

Disabled / missing-opt behavior:

- `isolation: 'none'` / `isolation: false` / `isolation: undefined`
  → no worktree, no manifest record, dispatcher behaves identically
  to the pre-feature path (bit-identical).
- Unknown shape on `opts.isolation` (e.g. `42`, `{}`, `'sandbox'`)
  → `TypeError` at agent dispatch time; the workflow's
  `agent_error` ledger entry surfaces the message.

## Lifecycle

| outcome              | worktree dir          | `<agentId>.diff`                 |
|----------------------|-----------------------|----------------------------------|
| agent succeeds       | retained (no auto-rm) | written (`git diff HEAD --no-color`) |
| agent fails          | retained for forensics | not written                     |
| diff capture fails   | retained               | not written; `log` warn         |

The diff file is empty when the agent made no edits — that's a
deliberate signal so an operator can distinguish "diff not yet
captured" (file absent) from "agent ran but changed nothing" (file
present, empty).

Diffs are capped at `WORKTREE_DIFF_CAP_BYTES` (8 MiB). Anything
larger is truncated with a marker comment line so the operator can
tell the on-disk file isn't the full picture; the worktree itself
is left intact for direct inspection.

## Paths

| element                  | path                                              |
|--------------------------|---------------------------------------------------|
| worktree root            | `<runDir>/worktrees/<agentId>/`                   |
| diff snapshot (success)  | `<runDir>/worktrees/<agentId>.diff`              |
| manifest record          | `<runDir>/manifest.json#agentWorktrees`           |

`<agentId>` is sanitized via `assertSafeAgentId` — same disallow
list as the per-agent transcript path (no `/`, `\`, `..`, NUL,
leading `.`).

## Cache key

Worktree mode is **not** part of the agent cache key. A
`{ isolation: 'worktree' }` agent and an `{ isolation: 'none' }`
agent with the same prompt/opts otherwise hit the same cache entry.
The rationale: the worktree itself is an execution-environment
detail, not an input to the agent's reasoning. Authors who want
worktree mode to invalidate cache should toggle
`bindToWorkflowVersion: false` or vary an opts field that does
enter the key.

## Tests

`tests/unit/worktree.test.ts` (26 tests) covers:

- `parseIsolation`: `'none'` / `false` / `undefined` / `null`
  disable; `'worktree'` passes through; bad shapes throw
  `TypeError`.
- `resolveWorktreeDir` / `resolveWorktreeDiffPath`: documented
  paths; unsafe agent ids rejected via `InvalidAgentIdError`.
- `assertGitRepo`: real git repo passes; plain tmpdir throws
  `NotAGitRepoError`; absent path throws; `_execFile` test seam
  honored; stdout `'false'` (`.git`-dir-but-not-worktree edge
  case) treated as not-a-repo.
- `createWorktreeForAgent`: real worktree created at the documented
  path; `git worktree list` shows the new entry as detached HEAD
  (no stray branch); duplicate creates throw `WorktreeError`;
  unsafe agent id rejected; test seam captures `git worktree add
  --detach <path>` invocation.
- `emitWorktreeDiff`: clean worktree → empty diff; edited tracked
  file → diff includes the file path and added lines; oversize diff
  truncated with marker; git failure surfaces as `WorktreeError`
  with original error as `.cause`.
- `recordAgentWorktreePath`: fresh manifest write; merge with prior
  manifest fields (including `agentMemoryDirs`); idempotent
  re-record; concurrent writers serialize via the same per-runDir
  queue used by the memory and parent-liveness fields.
- Dispatcher integration: when the runtime passes the worktree
  path as `cwd`, the spawned child sees that path verbatim and
  not the source repo — pins the contract that the dispatcher
  itself is unaware of worktrees.
- Error path: `emitWorktreeDiff` failure leaves the worktree dir
  and the agent's edits intact for inspection.

## Follow-ups

Shipped in the 2026-05-31 closure pass:

1. ✅ **Auto-prune on run completion** — `runGc({ apply: true })`
   now invokes `git worktree remove <path>` for each entry in
   `manifest.agentWorktrees` BEFORE rm-rf'ing the runDir. Dirty
   worktrees (`git status --porcelain` non-empty) are skipped with
   a warn-log; `forceRemoveDirtyWorktrees: true` overrides.
   `pruneWorktrees: false` disables the prune step entirely.
   Implementation: `pruneAgentWorktree()` in `src/runtime/worktree.ts`,
   wired through `src/runtime/gc.ts`. Tests in
   `tests/unit/gcWorktree.test.ts` (5 cases).
2. ✅ **`ctx.promote(agentId, opts)`** — promotes an agent's
   worktree edits back into the parent repo.
   - `opts.strategy = 'apply'` (default): reads
     `<runDir>/worktrees/<agentId>.diff` and runs `git apply`
     against the parent CWD. Empty diff is a no-op success.
     Conflicts surface as `PromoteError` with the offending file
     list extracted from git stderr.
   - `opts.strategy = 'rebase'` with optional `opts.target`
     (default `'HEAD'`) runs `git rebase --onto <target>` inside
     the worktree. Lets the operator handle conflicts directly
     in the worktree (git leaves it in a rebase-in-progress
     state). On non-zero exit the rebase failure is wrapped as
     `PromoteError`.
   - Returns `{ strategy, applied, files }` where `files` is
     parsed from the diff (apply) or `git diff --name-only`
     (rebase).
   Implementation: `promoteAgentWorktree()` in
   `src/runtime/worktree.ts`, host bridge in
   `src/runtime/runCtx.ts::promote`. Tests in
   `tests/unit/worktreePromote.test.ts` (15 cases including a
   real-git fixture diff applied to a tmp repo).
3. **Worktree-aware caching.** _(still deferred)_ Cache hits skip
   dispatch entirely today, including the worktree create. That's
   correct for semantic cache hits but means an operator who
   expected the worktree to exist (e.g. for forensics) gets
   surprised. Either document the interaction explicitly in
   `runtime-api.md` or add a `forceWorktree` opt that mints a
   worktree even on cache hit.
4. ✅ **Resume cross-check.** `resumeRun` now invokes
   `crossCheckAgentWorktrees(...)` after appending the resume
   ledger entry. For each `manifest.agentWorktrees[id]`, it
   verifies the path still exists on disk AND that
   `git worktree list --porcelain` includes it. Divergences
   surface as `log: warn` ledger entries (`agent-worktree:
   "<id>" mismatch (missing-on-disk|not-registered): recorded
   <path>`). Resume continues regardless — the warning is
   advisory; the dispatcher will create fresh worktrees when
   post-resume agents run. Implementation in
   `src/runtime/worktree.ts::crossCheckAgentWorktrees`,
   wired into `src/runtime/resumeRun.ts`. Tests in
   `tests/unit/worktreeResumeCheck.test.ts` (7 cases).

Still deferred:

5. **Submodules + LFS.** `git worktree add` does the right thing
   for plain repos but submodules and LFS-tracked content require
   additional plumbing. Today an agent inside a worktree of an
   LFS repo will see pointer files unless `git lfs install
   --worktree` was run for the new worktree. Fix is mechanical —
   probe `git lfs env` on creation and run the install if LFS is
   active in the source repo.
6. **Per-agent branch flag.** Some workflows want the worktree to
   live on a named branch (`agent-<id>` or similar) so the
   reflog/PR story is tighter. A `{ isolation: { mode: 'worktree',
   branch: '<name>' } }` shape would let the author opt in. Today
   we always use `--detach` because that matches the
   "create-and-discard" common case and avoids polluting `git
   branch` listings.

## Files touched in this slice

- `src/runtime/worktree.ts` — new module (parse, validate, create,
  diff, error types). 2026-05-31 closure adds: `pruneAgentWorktree`,
  `promoteAgentWorktree`, `crossCheckAgentWorktrees`, `parseDiffFiles`,
  `extractGitApplyConflictFiles`, `PromoteError`.
- `src/runtime/gc.ts` — worktree prune wired into
  `runGc({apply:true})` before runDir delete.
- `src/runtime/resumeRun.ts` — cross-check + warn-log on resume.
- `src/runtime/runCtx.ts` — `ctx.promote` host implementation +
  pre-dispatch worktree resolution.
- `src/runtime/sandbox.ts` — `ctx.promote` bridge wiring.
- `src/runtime/manifestWriter.ts` — `recordAgentWorktreePath`
  helper, reuses the existing per-runDir write queue.
- `src/types/internal.d.ts` — `agentWorktrees` field on
  `RunManifest`; `RunCtxHost.promote?` method.
- `tests/unit/worktree.test.ts` — 26 base tests.
- `tests/unit/gcWorktree.test.ts` — 5 prune tests.
- `tests/unit/worktreePromote.test.ts` — 15 promote tests.
- `tests/unit/worktreeResumeCheck.test.ts` — 7 cross-check tests.
