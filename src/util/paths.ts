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
