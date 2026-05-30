/**
 * pi-workflows — path helpers.
 *
 * Slice 1 only needs:
 *   - `workflowsHome()`         — `~/.pi/agent/workflows/`
 *   - `runsHome()`              — `~/.pi/agent/workflows/runs/`
 *   - `projectWorkflowsDir(cwd)` — `<cwd>/.pi/workflows/`
 *   - `runDir(runId)`           — `~/.pi/agent/workflows/runs/<runId>/`
 *   - `findProjectRoot(cwd)`    — walks up looking for `.pi/` (used here
 *                                 only to anchor discovery; slice 14's
 *                                 `s` save-script uses a different walk)
 *
 * The slice-1 contract for `runDir` is shape-only — the directory
 * doesn't have to exist. Slice 7 (ledger) and slice 8a (RunManager)
 * own the actual mkdir.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PI_AGENT_HOME = ".pi";
const AGENT_DIR_SEGMENT = "agent";
const WORKFLOWS_SEGMENT = "workflows";
const RUNS_SEGMENT = "runs";

/** `~/.pi/agent/workflows/` — the personal/user-global workflow root. */
export function workflowsHome(): string {
  return join(homedir(), PI_AGENT_HOME, AGENT_DIR_SEGMENT, WORKFLOWS_SEGMENT);
}

/** `~/.pi/agent/workflows/runs/` — per-run state goes under this tree. */
export function runsHome(): string {
  return join(workflowsHome(), RUNS_SEGMENT);
}

/** `~/.pi/agent/workflows/runs/<runId>/`. Caller handles mkdir. */
export function runDir(runId: string): string {
  return join(runsHome(), runId);
}

/**
 * `<runDir>/cache.jsonl` — append-only cache file (PRD §6.3).
 * Slice 3 owner; consumed by slice 5 (dispatcher) and slice 8a
 * (`ctx.cache.*`).
 */
export function cachePath(runId: string): string {
  return join(runDir(runId), "cache.jsonl");
}

/**
 * Tmp file used during atomic compaction. The `CacheStore` writes a
 * fresh snapshot here, fsync's, then renames over `cache.jsonl` —
 * see `src/runtime/cache.ts::compact()`.
 */
export function cachePathTmp(runId: string): string {
  return join(runDir(runId), "cache.jsonl.tmp");
}

/**
 * `<runDir>/manifest.json` — frozen run config (PRD §6.2). Slice 6
 * writes the parent-liveness fields; slice 8a fills the rest.
 */
export function manifestPath(runId: string): string {
  return join(runDir(runId), "manifest.json");
}

/**
 * `<runDir>/fixtures.jsonl` — canned agent responses for `--mock-agents`.
 * Slice 6's mock branch reads this; the file is author-supplied (test
 * fixtures live under `tests/fixtures/dispatcher/`).
 */
export function fixturesPath(runId: string): string;
export function fixturesPath(runDirAbs: string, _byDir: true): string;
export function fixturesPath(arg: string, byDir?: true): string {
  return byDir === true ? join(arg, "fixtures.jsonl") : join(runDir(arg), "fixtures.jsonl");
}

/**
 * `<runDir>/ledger.jsonl` — append-only state event log (PRD §6.4).
 * Slice 7 owner; consumed by slice 11 (resume) and slice 13 (TUI overlay).
 * Mirrors `cachePath`'s overload-free shape — runId-only, callers that
 * already know the runDir can construct via `join(runDir, "ledger.jsonl")`.
 */
export function ledgerPath(runId: string): string;
export function ledgerPath(runDirAbs: string, _byDir: true): string;
export function ledgerPath(arg: string, byDir?: true): string {
  return byDir === true ? join(arg, "ledger.jsonl") : join(runDir(arg), "ledger.jsonl");
}

/**
 * `<runDir>/agents/` — per-agent transcripts directory (PRD §6.5).
 */
export function agentsDir(runId: string): string;
export function agentsDir(runDirAbs: string, _byDir: true): string;
export function agentsDir(arg: string, byDir?: true): string {
  return byDir === true ? join(arg, "agents") : join(runDir(arg), "agents");
}

/**
 * `<runDir>/agents/<agentId>.jsonl` — raw NDJSON transcript of a
 * single sub-agent's `pi --mode json` output. Slice 6 tees stdout here.
 */
export function agentTranscriptPath(runDirAbs: string, agentId: string): string {
  return join(agentsDir(runDirAbs, true), `${agentId}.jsonl`);
}

/**
 * `<runDir>/agents/<agentId>.stderr` — child's stderr plus any
 * malformed-bytes appended for forensics (PRD §5.5.2).
 */
export function agentStderrPath(runDirAbs: string, agentId: string): string {
  return join(agentsDir(runDirAbs, true), `${agentId}.stderr`);
}

// ─── Memo paths ──────────────────────────────────────────────────────────────

/**
 * `~/.pi/agent/memos/` — root for all cross-run memo stores.
 */
export function memosHome(): string {
  return join(homedir(), PI_AGENT_HOME, AGENT_DIR_SEGMENT, "memos");
}

/**
 * `<memoScopeDir>` for a scope:
 *   - global  → `~/.pi/agent/memos/global/`
 *   - project → `~/.pi/agent/memos/projects/<sha256(projectRoot)>/`
 *
 * `projectRoot` is required when scope is `'project'`; ignored otherwise.
 */
export function memoScopeDir(scope: 'global' | 'project', projectRoot?: string): string {
  if (scope === 'global') {
    return join(memosHome(), 'global');
  }
  if (!projectRoot) throw new Error('memoScopeDir: projectRoot required for project scope');
  const hash = createHash('sha256').update(projectRoot).digest('hex');
  return join(memosHome(), 'projects', hash);
}

/**
 * `<memoScopeDir>/memo.jsonl` — the append-only memo store file.
 */
export function memoPath(scope: 'global' | 'project', projectRoot?: string): string {
  return join(memoScopeDir(scope, projectRoot), 'memo.jsonl');
}

/**
 * Tmp file used during atomic compaction of the memo store.
 */
export function memoPathTmp(scope: 'global' | 'project', projectRoot?: string): string {
  return join(memoScopeDir(scope, projectRoot), 'memo.jsonl.tmp');
}

/**
 * `<projectRoot>/.pi/workflows/` — the project-scoped workflow root.
 *
 * Slice 1 takes the `cwd` from `session_start` as the project root
 * (matches pi-conductor's policy). Slice 14's `s` hotkey will introduce
 * a richer "find git root" walk; we don't need that here.
 */
export function projectWorkflowsDir(cwd: string): string {
  const root = findProjectRoot(cwd);
  return join(root, PI_AGENT_HOME, WORKFLOWS_SEGMENT);
}

/**
 * Walk up from `cwd` looking for a `.pi/` directory. Returns the
 * directory containing it. If no `.pi/` is found, returns `cwd`
 * unchanged — discovery then no-ops because the resulting path
 * doesn't exist either.
 *
 * Bounded to 64 steps as a defensive cap against pathological
 * symlink loops; on any sane filesystem the walk terminates at `/`
 * long before that.
 */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, PI_AGENT_HOME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}
