/**
 * pi-workflows — slice 14 save-script (`s` hotkey) flow.
 *
 * Flow per PRD §10.7 + §15.C:
 *
 *   1. Walk up from `cwd` (or `runOriginCwd`) at most 8 levels looking for
 *      `.git/` or `.pi/`. If neither found, abort with "no project root".
 *   2. If the source workflow already lives in `<projectRoot>/.pi/workflows/`,
 *      it is a no-op (already saved). Caller surfaces a one-line message.
 *   3. Read `<runDir>/script.js` (frozen copy from runtime).
 *   4. Target path: `<projectRoot>/.pi/workflows/<workflowName>.js`. If the
 *      target already exists, `confirm` chooses `overwrite` / `rename`
 *      (suffix `<name>-saved.js`, then `<name>-saved-<n>.js` if collision)
 *      / `cancel`.
 *   5. Copy with mode 0o644.
 *   6. If `.git` present, prompt `Add to git? (y/n)`. On `y`, run `git add`.
 *      Skip silently if no `.git`.
 *   7. If `.gitignore` ignores `.pi/` or the target file, warn the user.
 *
 * Pure orchestration with explicit DI seams: filesystem ops + `confirm`
 * + `runGitAdd` are injected so the unit test can drive every branch
 * without touching the real disk or process.
 *
 * Refs: PRD §10.7, §15.C, plan.md §4 Slice 14.
 */

import { promises as fs, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

export interface SaveScriptIO {
  /** Read the frozen `<runDir>/script.js`. Returns the source text. */
  readScript(runDirAbs: string): Promise<string>;
  /** Write the script to the target path with 0o644. Creates parent dirs. */
  writeTarget(targetAbs: string, contents: string): Promise<void>;
  /** Check if a path exists (file or dir). */
  pathExists(absPath: string): Promise<boolean>;
  /** Read `.gitignore` contents (returns "" if missing). */
  readGitIgnore(projectRoot: string): Promise<string>;
  /** Run `git add <relPath>` from project root. Resolves to true on success. */
  runGitAdd(projectRoot: string, relPath: string): Promise<boolean>;
}

export interface SaveScriptUI {
  /**
   * Pose a confirm question. Returns the chosen branch label. Caller
   * supplies an array of valid choices; the first array entry is the
   * default. The TUI overlay maps these to a dialog; tests use a
   * scripted-answer stub.
   */
  prompt(
    message: string,
    choices: ReadonlyArray<string>,
  ): Promise<string>;
}

export type SaveOutcome =
  | { readonly kind: "saved"; readonly targetAbs: string; readonly gitAdded: boolean; readonly gitignoreWarned: boolean }
  | { readonly kind: "saved-renamed"; readonly targetAbs: string; readonly gitAdded: boolean; readonly gitignoreWarned: boolean }
  | { readonly kind: "cancelled-by-user"; readonly reason: "no-overwrite" }
  | { readonly kind: "no-op-already-in-project"; readonly targetAbs: string }
  | {
      readonly kind: "error";
      readonly reason: "no-project-root" | "missing-script" | "io" | "missing-cwd";
      readonly message: string;
    };

export interface SaveScriptOptions {
  readonly runDirAbs: string;
  readonly workflowName: string;
  /** Absolute path the workflow script was loaded FROM (slice 1 registry). */
  readonly workflowSourceAbsPath: string;
  /** Where to start walking for project-root detection. */
  readonly cwd: string;
  /** Override the 8-level depth cap (PRD §15.C). Test seam. */
  readonly maxWalkDepth?: number;
  readonly io: SaveScriptIO;
  readonly ui: SaveScriptUI;
  /** Optional logger for status messages (overlay banner / pi.notify). */
  readonly notify?: (message: string, level?: "info" | "warning") => void;
}

const DEFAULT_MAX_WALK = 8;

/**
 * Walk up from `start` up to `maxDepth` levels looking for `.git/` or
 * `.pi/`. Returns the first directory containing either, or null.
 *
 * Sync — uses `statSync` so the orchestrator doesn't have to await
 * a noisy promise chain. `nMax` defaults to 8 per PRD §15.C.
 */
export function findProjectRoot(
  start: string,
  maxDepth: number = DEFAULT_MAX_WALK,
): { rootAbs: string; hasGit: boolean; hasPi: boolean } | null {
  if (typeof start !== "string" || start.length === 0) return null;
  let cur = resolve(start);
  for (let i = 0; i < maxDepth; i++) {
    const hasGit = directoryExists(join(cur, ".git"));
    const hasPi = directoryExists(join(cur, ".pi"));
    if (hasGit || hasPi) return { rootAbs: cur, hasGit, hasPi };
    const parent = dirname(cur);
    if (parent === cur) return null; // reached filesystem root
    cur = parent;
  }
  return null;
}

function directoryExists(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick a non-colliding rename target — first try `<name>-saved.js`,
 * then `<name>-saved-2.js`, `<name>-saved-3.js`, … up to 99.
 */
async function pickRenameTarget(
  io: SaveScriptIO,
  workflowsDir: string,
  workflowName: string,
): Promise<string> {
  const first = join(workflowsDir, `${workflowName}-saved.js`);
  if (!(await io.pathExists(first))) return first;
  for (let i = 2; i < 100; i++) {
    const candidate = join(workflowsDir, `${workflowName}-saved-${i}.js`);
    if (!(await io.pathExists(candidate))) return candidate;
  }
  // Pathological: 99 collisions. Fall back to a timestamp suffix.
  return join(workflowsDir, `${workflowName}-saved-${Date.now()}.js`);
}

/**
 * Cheap check: does the source path live inside `<projectRoot>/.pi/workflows/`?
 * Used to short-circuit save with the documented one-line message.
 */
function sourceAlreadyInProjectWorkflows(
  workflowSourceAbsPath: string,
  projectRoot: string,
): boolean {
  const target = resolve(projectRoot, ".pi", "workflows");
  // Add separator so e.g. `.pi/workflowsX/foo.js` doesn't false-match.
  return workflowSourceAbsPath.startsWith(target + sep);
}

/**
 * Cheap parse — true if any line in `gitignoreText` would ignore
 * `.pi/` or `.pi/workflows/...`. Comments + blank lines skipped.
 *
 * Not a full `.gitignore` parser (no negation, no glob pyrotechnics);
 * sufficient for the warning heuristic.
 */
export function gitignoreCoversPi(gitignoreText: string): boolean {
  if (gitignoreText.length === 0) return false;
  const lines = gitignoreText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Direct ignore patterns we care about.
    if (
      line === ".pi" ||
      line === ".pi/" ||
      line === "/.pi" ||
      line === "/.pi/" ||
      line === ".pi/**" ||
      line === ".pi/workflows" ||
      line === ".pi/workflows/" ||
      line === ".pi/workflows/*"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Default IO plumbing — production callers use this; tests override.
 */
export const defaultSaveScriptIO: SaveScriptIO = {
  async readScript(runDirAbs: string) {
    return await fs.readFile(join(runDirAbs, "script.js"), "utf8");
  },
  async writeTarget(targetAbs: string, contents: string) {
    await fs.mkdir(dirname(targetAbs), { recursive: true });
    await fs.writeFile(targetAbs, contents, { mode: 0o644 });
  },
  async pathExists(absPath: string) {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  },
  async readGitIgnore(projectRoot: string) {
    try {
      return await fs.readFile(join(projectRoot, ".gitignore"), "utf8");
    } catch {
      return "";
    }
  },
  async runGitAdd(projectRoot: string, relPath: string) {
    return await new Promise<boolean>((resolveP) => {
      const child = spawn("git", ["add", relPath], {
        cwd: projectRoot,
        stdio: "ignore",
        shell: false,
      });
      child.on("error", () => resolveP(false));
      child.on("exit", (code) => resolveP(code === 0));
    });
  },
};

/**
 * Run the save-script flow. Pure orchestration; all IO is injected.
 * Returns a SaveOutcome describing what happened so the overlay can
 * render the right banner.
 */
export async function runSaveScript(
  opts: SaveScriptOptions,
): Promise<SaveOutcome> {
  if (typeof opts.cwd !== "string" || opts.cwd.length === 0) {
    return { kind: "error", reason: "missing-cwd", message: "no cwd supplied" };
  }
  const found = findProjectRoot(opts.cwd, opts.maxWalkDepth ?? DEFAULT_MAX_WALK);
  if (found === null) {
    return {
      kind: "error",
      reason: "no-project-root",
      message:
        "no project root found within 8 directory levels (looked for .git/ or .pi/). " +
        "Save aborted.",
    };
  }

  const workflowsDir = join(found.rootAbs, ".pi", "workflows");
  const targetPath = join(workflowsDir, `${opts.workflowName}.js`);

  // Project-scoped already → no-op per PRD §10.7 acceptance (last bullet).
  if (sourceAlreadyInProjectWorkflows(opts.workflowSourceAbsPath, found.rootAbs)) {
    return { kind: "no-op-already-in-project", targetAbs: opts.workflowSourceAbsPath };
  }

  // Read frozen script.
  let scriptText: string;
  try {
    scriptText = await opts.io.readScript(opts.runDirAbs);
  } catch (err) {
    return {
      kind: "error",
      reason: "missing-script",
      message: `unable to read script.js from runDir: ${(err as Error).message ?? err}`,
    };
  }

  // Collision handling.
  let actualTarget = targetPath;
  let renamed = false;
  if (await opts.io.pathExists(targetPath)) {
    const choice = await opts.ui.prompt(
      `${targetPath} already exists. Choose:`,
      ["overwrite", "rename", "cancel"],
    );
    if (choice === "cancel") {
      return { kind: "cancelled-by-user", reason: "no-overwrite" };
    }
    if (choice === "rename") {
      actualTarget = await pickRenameTarget(opts.io, workflowsDir, opts.workflowName);
      renamed = true;
    }
    // "overwrite" → keep actualTarget
  }

  try {
    await opts.io.writeTarget(actualTarget, scriptText);
  } catch (err) {
    return {
      kind: "error",
      reason: "io",
      message: `failed to write ${actualTarget}: ${(err as Error).message ?? err}`,
    };
  }

  // .gitignore check — must run BEFORE the 'Add to git?' prompt so
  // the user is informed (or the prompt is skipped) rather than
  // silently failing after they answer 'y' (BUG-129).
  let gitignoreWarned = false;
  if (found.hasGit) {
    const gitignore = await opts.io.readGitIgnore(found.rootAbs);
    if (gitignoreCoversPi(gitignore)) {
      gitignoreWarned = true;
      opts.notify?.(
        ".gitignore ignores .pi/ — saved file will NOT be tracked by git.",
        "warning",
      );
    }
  }

  // git-add prompt — only if `.git` is present and .gitignore doesn't
  // already ignore .pi/ (no point prompting if git would ignore it).
  let gitAdded = false;
  if (found.hasGit && !gitignoreWarned) {
    const yes = await opts.ui.prompt(
      `Saved to ${actualTarget}. Add to git?`,
      ["y", "n"],
    );
    if (yes === "y") {
      const relPath = actualTarget.startsWith(found.rootAbs + sep)
        ? actualTarget.slice(found.rootAbs.length + 1)
        : actualTarget;
      gitAdded = await opts.io.runGitAdd(found.rootAbs, relPath);
      if (!gitAdded) {
        opts.notify?.(
          `git add failed for ${relPath}; saved file is on disk but not staged.`,
          "warning",
        );
      }
    }
  }

  return renamed
    ? { kind: "saved-renamed", targetAbs: actualTarget, gitAdded, gitignoreWarned }
    : { kind: "saved", targetAbs: actualTarget, gitAdded, gitignoreWarned };
}
