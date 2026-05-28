/**
 * pi-workflows — workflow file discovery + registry.
 *
 * Discovery rules (PRD §3.1, §3.2):
 *
 *   - Two roots: `<projectRoot>/.pi/workflows/` and `~/.pi/agent/workflows/`.
 *   - Project precedence: a project file shadows a personal file with
 *     the same name; we emit a `name-collision-shadowed` warning.
 *   - Non-recursive: top-level `*.js` only.
 *   - Reserved names (and any name pi already uses for a built-in) are
 *     skipped with a warning.
 *   - Hidden files (leading `.`) are skipped silently.
 *   - Bad filenames (`/`, `\`, whitespace, `..`, leading `.`, etc.) are
 *     skipped with a warning.
 *   - Non-`.js` extensions are skipped with a warning.
 *
 * Slice 1 returns both the registry and the list of skipped files so
 * `index.ts` can `pi.notify` once per skip. Slice 7 (ledger) replaces
 * the in-memory list with a `workflow_load_error` ledger entry; the
 * shape is identical.
 *
 * Hot-reload (PRD §3.1) lands in slice 16 — slice 1 is one-shot.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

import type { WorkflowFile, WorkflowLoadError, WorkflowRegistry } from "./types/internal.js";
import { projectWorkflowsDir, workflowsHome } from "./util/paths.js";

/**
 * Names that **must not** become slash commands. Mirrors PRD §3.2 and
 * the explicit pi-built-in list. Slice 1 keeps the list inline; if pi
 * later exposes its own command roster, `index.ts` can intersect with
 * `pi.getCommands()` for a more durable check.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // pi-workflows' own
  "workflows",
  // pi built-ins (sample — extend as needed)
  "reload",
  "help",
  "exit",
  "quit",
  "clear",
  "tree",
  "fork",
  "switch",
  "share",
  "compact",
  "skills",
  "settings",
  "agents",
  "doctor",
  "status",
  "model",
  "memory",
  // pi-conductor — coexistence: don't shadow if conductor is installed
  "conductor",
  // common collisions worth defending up-front
  "log",
  "history",
]);

/**
 * Discovery output. The two arrays are disjoint:
 *   - `registry` is the success set.
 *   - `errors` is the skip set, ordered by discovery order so error
 *     messages stay deterministic across runs.
 */
export interface DiscoveryResult {
  readonly registry: WorkflowRegistry;
  readonly errors: readonly WorkflowLoadError[];
}

export interface DiscoverOpts {
  /** Used as the project-discovery anchor; usually `ctx.cwd`. */
  readonly cwd: string;
  /** Override personal-root path (used by tests). */
  readonly personalDir?: string;
  /** Override project-root path (used by tests). */
  readonly projectDir?: string;
  /** Override the reserved-name set (used by tests). */
  readonly reserved?: ReadonlySet<string>;
}

export function discoverWorkflows(opts: DiscoverOpts): DiscoveryResult {
  const projectDir = opts.projectDir ?? projectWorkflowsDir(opts.cwd);
  const personalDir = opts.personalDir ?? workflowsHome();
  const reserved = opts.reserved ?? RESERVED_NAMES;

  const errors: WorkflowLoadError[] = [];

  // Discover personal first, then project. Project entries overwrite
  // personal entries — we record a `name-collision-shadowed` error for
  // the personal entry that lost.
  const personal = scanDir(personalDir, "personal", reserved, errors);
  const project = scanDir(projectDir, "project", reserved, errors);

  const registry = new Map<string, WorkflowFile>(personal);
  for (const [name, projectFile] of project) {
    const shadowed = registry.get(name);
    if (shadowed && shadowed.scope === "personal") {
      errors.push({
        absPath: shadowed.absPath,
        reason: "name-collision-shadowed",
        message: `personal workflow "${name}" shadowed by project workflow at ${projectFile.absPath}`,
      });
    }
    registry.set(name, projectFile);
  }

  return { registry, errors };
}

/**
 * Filename validity per PRD §3.2. Pure function so it can be tested
 * standalone. Returns `null` on a valid name, otherwise the load-error
 * reason.
 *
 * Accepts the bare filename (e.g. `"foo.js"`), not the absolute path.
 */
export function classifyFilename(
  filename: string,
  reserved: ReadonlySet<string>,
): { name: string } | { reason: WorkflowLoadError["reason"]; message: string } {
  // Hidden file → caller must drop silently. We surface as bad-filename
  // with a sentinel reason; `scanDir` filters it out before adding to
  // `errors`.
  if (filename.startsWith(".")) {
    return { reason: "bad-filename", message: `hidden file: ${filename}` };
  }
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    /\s/.test(filename)
  ) {
    return {
      reason: "bad-filename",
      message: `filename has illegal characters: ${filename}`,
    };
  }
  const ext = extname(filename);
  if (ext !== ".js") {
    return {
      reason: "non-js-extension",
      message: `non-js extension (${ext || "<none>"}): ${filename}`,
    };
  }
  const name = basename(filename, ".js");
  if (name === "" || /[^a-zA-Z0-9_-]/.test(name)) {
    return {
      reason: "bad-filename",
      message: `unsupported character in name: ${filename}`,
    };
  }
  if (reserved.has(name)) {
    return {
      reason: "reserved-name",
      message: `reserved name: ${name} (filename ${filename})`,
    };
  }
  return { name };
}

function scanDir(
  dir: string,
  scope: WorkflowFile["scope"],
  reserved: ReadonlySet<string>,
  errors: WorkflowLoadError[],
): Map<string, WorkflowFile> {
  const out = new Map<string, WorkflowFile>();
  if (!existsSync(dir)) return out;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    errors.push({
      absPath: dir,
      reason: "io-error",
      message: `failed to read directory ${dir}: ${(e as Error).message}`,
    });
    return out;
  }

  // Stable order — important for deterministic test output.
  entries.sort();

  for (const filename of entries) {
    const absPath = join(dir, filename);
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue; // race or symlink to nothing — skip silently
    }
    if (!st.isFile()) continue;

    const result = classifyFilename(filename, reserved);
    if ("reason" in result) {
      // Hidden files are skipped silently per PRD §3.2.
      if (filename.startsWith(".")) continue;
      errors.push({ absPath, reason: result.reason, message: result.message });
      continue;
    }

    out.set(result.name, {
      name: result.name,
      absPath,
      scope,
    });
  }

  return out;
}
