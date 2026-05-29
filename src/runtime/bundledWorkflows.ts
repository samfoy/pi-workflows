/**
 * pi-workflows — bundled workflow self-install (slice 17).
 *
 * On `session_start`, copies bundled example workflows into
 * `~/.pi/agent/workflows/` if they are not already present or if the
 * installed version matches a prior managed version (auto-upgrade).
 *
 * Rules (per SPIKE-FINDINGS.md Q2 + plan.md §4 Slice 17):
 *
 *   1. pi-core does NOT read a `pi.workflows` manifest field —
 *      `RESOURCE_TYPES` is hardcoded to extensions/skills/prompts/themes.
 *      We own the copy step.
 *
 *   2. NEVER overwrite a user-modified file.  We track managed versions
 *      in `~/.pi/agent/workflows/.pi-workflows-managed.json`.  A file is
 *      safe to overwrite only if its current sha256 matches the sha256
 *      of the previously-installed bundled version recorded in that ledger.
 *
 *   3. Only write to `~/.pi/agent/workflows/` (personal scope). Never
 *      write to a project's `.pi/workflows/`.
 *
 *   4. Idempotent. Running twice with the same bundle is a no-op.
 *
 * The managed-versions ledger lives at:
 *   ~/.pi/agent/workflows/.pi-workflows-managed.json
 *
 * Shape: `{ "codebase-audit.js": "<sha256-of-last-installed-content>" }`
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledWorkflow {
  /** Destination filename under `~/.pi/agent/workflows/`. */
  readonly destName: string;
  /** Absolute path to the bundled source file inside this package. */
  readonly srcPath: string;
}

export interface InstallBundledResult {
  readonly installed: string[];
  readonly upgraded: string[];
  readonly skippedUserModified: string[];
  readonly alreadyCurrent: string[];
  readonly errors: { name: string; message: string }[];
}

/** Path to the managed-versions ledger. */
export const MANAGED_LEDGER_NAME = ".pi-workflows-managed.json";

/** sha256 of a file's bytes, hex-encoded. */
function fileSha256(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/** sha256 of a string, hex-encoded. */
function stringSha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function readManagedLedger(
  workflowsDir: string,
): Record<string, string> {
  const p = join(workflowsDir, MANAGED_LEDGER_NAME);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch { /* corrupt → treat as empty */ }
  return {};
}

function writeManagedLedger(
  workflowsDir: string,
  ledger: Record<string, string>,
): void {
  writeFileSync(
    join(workflowsDir, MANAGED_LEDGER_NAME),
    JSON.stringify(ledger, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Install/upgrade bundled workflows into `workflowsDir`.
 *
 * @param workflows  List of { destName, srcPath } pairs.
 * @param workflowsDir  Target directory (default `~/.pi/agent/workflows/`).
 */
export function installBundledWorkflows(
  workflows: ReadonlyArray<BundledWorkflow>,
  workflowsDir: string,
  opts: { log?: (msg: string) => void } = {},
): InstallBundledResult {
  const result: InstallBundledResult = {
    installed: [],
    upgraded: [],
    skippedUserModified: [],
    alreadyCurrent: [],
    errors: [],
  };

  if (workflows.length === 0) return result;

  try {
    mkdirSync(workflowsDir, { recursive: true });
  } catch (err) {
    result.errors.push({ name: "<mkdir>", message: String(err) });
    return result;
  }

  const ledger = readManagedLedger(workflowsDir);
  let ledgerDirty = false;

  for (const wf of workflows) {
    try {
      const srcContent = readFileSync(wf.srcPath, "utf8");
      const srcSha = stringSha256(srcContent);
      const destPath = join(workflowsDir, wf.destName);

      if (!existsSync(destPath)) {
        // First install.
        writeFileSync(destPath, srcContent, "utf8");
        ledger[wf.destName] = srcSha;
        ledgerDirty = true;
        result.installed.push(wf.destName);
        opts.log?.(
          `[pi-workflows] installed bundled workflow: ${wf.destName}`,
        );
      } else {
        const existingSha = fileSha256(destPath);
        if (existingSha === srcSha) {
          // Already current — no-op.
          result.alreadyCurrent.push(wf.destName);
        } else {
          const prevManagedSha = ledger[wf.destName];
          if (prevManagedSha !== undefined && existingSha === prevManagedSha) {
            // Managed + not user-modified → upgrade.
            writeFileSync(destPath, srcContent, "utf8");
            ledger[wf.destName] = srcSha;
            ledgerDirty = true;
            result.upgraded.push(wf.destName);
            opts.log?.(
              `[pi-workflows] upgraded bundled workflow: ${wf.destName}`,
            );
          } else {
            // User-modified or unknown provenance — never overwrite.
            result.skippedUserModified.push(wf.destName);
            opts.log?.(
              `[pi-workflows] ${wf.destName}: user-modified, skipping upgrade`,
            );
          }
        }
      }
    } catch (err) {
      result.errors.push({
        name: wf.destName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (ledgerDirty) {
    try {
      writeManagedLedger(workflowsDir, ledger);
    } catch (err) {
      result.errors.push({
        name: MANAGED_LEDGER_NAME,
        message: `ledger write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}

/**
 * Resolve the list of bundled workflows this package ships.
 * Callers typically pass `import.meta.url` as `packageEntryUrl`.
 */
export function resolveBundledWorkflows(
  packageEntryUrl: string,
): BundledWorkflow[] {
  // The package root is two levels up from src/runtime/bundledWorkflows.ts
  // or one level up from dist/index.js — we walk up until we find
  // examples/codebase-audit/codebase-audit.js.
  const entryDir = dirname(fileURLToPath(packageEntryUrl));
  // Try dist/ → package root, then src/ → package root (tests).
  const candidates = [
    join(entryDir, ".."),        // from dist/index.js
    join(entryDir, "../.."),     // from dist/runtime/...
    join(entryDir, "../../.."),  // from src/runtime/...
  ];

  for (const root of candidates) {
    const probe = join(root, "examples", "codebase-audit", "codebase-audit.js");
    if (existsSync(probe)) {
      return [
        { destName: "codebase-audit.js", srcPath: probe },
      ];
    }
  }
  // No bundled workflows found — not fatal; return empty.
  return [];
}
