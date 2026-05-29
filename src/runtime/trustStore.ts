/**
 * pi-workflows — slice 9 trust storage.
 *
 * Persists user "Don't ask again" decisions in pi's settings.json file
 * under the key `pi-workflows.trustedWorkflows`. Per PRD §7.2 the
 * schema (locked in slice-2 revision) is:
 *
 *     "pi-workflows.trustedWorkflows": {
 *       "<absPath>": [{ "name": "<workflowName>", "sha256": "<64hex>" }, ...]
 *     }
 *
 * Multiple `(name, sha256)` rows under the same `absPath` allow the
 * same file to track approvals across renames or content edits where
 * the user re-approved (the latest hash wins; older rows stay around
 * for audit).
 *
 * Scope detection (PRD §7):
 *   - `<cwd>/.pi/workflows/<name>.workflow.js`        → project scope
 *   - `<homedir>/.pi/agent/workflows/<name>.workflow.js` → personal scope
 *   - everything else (test fixtures, custom locations) defaults to
 *     **project** scope so test runs are self-contained and don't
 *     leak into the user's real `~/.pi/agent/settings.json`.
 *
 * Read order: project then personal, merged. Project wins on conflict
 * (per PRD §7 last paragraph). Hash mismatch ALWAYS re-prompts (slice-2
 * revision adversarial-commit defense).
 *
 * Atomic writes: tmp+rename, just like cache.jsonl.tmp / manifest tmp.
 * If the settings file doesn't exist we create it with `{}` plus our
 * key. If it exists but is malformed JSON, slice-9 refuses to write
 * (we never poison a settings file) and surfaces a `TrustWriteError`.
 */

import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import type {
  TrustEntry,
  TrustScope,
  TrustStore,
} from "../types/internal.js";

const SETTING_KEY = "pi-workflows.trustedWorkflows";

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

export function personalSettingsPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "settings.json");
}

/**
 * Decide whether `absPath` is under the project's `.pi/workflows/`
 * directory or the user's `~/.pi/agent/workflows/` directory. Anything
 * else is treated as project scope so tests with tmpdir fixtures work
 * predictably.
 *
 * The detection is purely string-prefix on the normalized path; we
 * don't follow symlinks. Authors who symlink across scopes get
 * project scope (the common case is "I copied a workflow to a
 * project I'm experimenting with").
 */
export function detectScope(opts: {
  readonly absPath: string;
  readonly cwd: string;
  readonly home?: string;
}): TrustScope {
  const home = opts.home ?? homedir();
  const personalPrefix = join(home, ".pi", "agent", "workflows") + sep;
  if (opts.absPath.startsWith(personalPrefix)) return "personal";
  return "project";
}

/**
 * Load and merge trust entries from project + personal scopes for
 * lookup. Project wins on (absPath, sha256) conflict.
 */
export async function loadTrust(opts: {
  readonly cwd: string;
  readonly home?: string;
  /** Test seam: override settings paths. */
  readonly projectSettingsPathOverride?: string;
  readonly personalSettingsPathOverride?: string;
}): Promise<TrustStore> {
  const projectPath =
    opts.projectSettingsPathOverride ?? projectSettingsPath(opts.cwd);
  const personalPath =
    opts.personalSettingsPathOverride ??
    personalSettingsPath(opts.home ?? homedir());

  const personal = await readScope(personalPath);
  const project = await readScope(projectPath);
  const merged: TrustStore = {};
  for (const [absPath, rows] of Object.entries(personal)) {
    merged[absPath] = rows.slice();
  }
  for (const [absPath, rows] of Object.entries(project)) {
    const existing = merged[absPath] ?? [];
    // Project entries win — append rows that aren't already present
    // by sha256, with project rows taking precedence at lookup time.
    const seenShas = new Set(existing.map((r) => r.sha256));
    const combined = existing.slice();
    for (const r of rows) {
      if (!seenShas.has(r.sha256)) {
        combined.unshift(r); // project rows at the front
        seenShas.add(r.sha256);
      }
    }
    merged[absPath] = combined;
  }
  return merged;
}

/**
 * Sync helper — `(absPath, sha256)` lookup against an already-loaded
 * `TrustStore`. Pure; tests use this directly without going to disk.
 */
export function isTrustedIn(
  trust: TrustStore,
  absPath: string,
  sha256: string,
): boolean {
  const rows = trust[absPath];
  if (!rows) return false;
  for (const r of rows) {
    if (r.sha256 === sha256) return true;
  }
  return false;
}

/** Convenience: load + lookup in one call. */
export async function isTrusted(opts: {
  readonly cwd: string;
  readonly absPath: string;
  readonly sha256: string;
  readonly home?: string;
  readonly projectSettingsPathOverride?: string;
  readonly personalSettingsPathOverride?: string;
}): Promise<boolean> {
  const trust = await loadTrust(opts);
  return isTrustedIn(trust, opts.absPath, opts.sha256);
}

export class TrustWriteError extends Error {
  readonly path: string;
  readonly kind: "malformed" | "io";
  constructor(path: string, kind: "malformed" | "io", cause?: unknown) {
    super(
      `pi-workflows.trustedWorkflows write failed (${kind}) at ${path}` +
        (cause instanceof Error ? `: ${cause.message}` : ""),
    );
    this.name = "TrustWriteError";
    this.path = path;
    this.kind = kind;
  }
}

/**
 * Append a `(absPath, name, sha256)` row to the trust store. Atomic via
 * tmp+rename. Refuses to write if the existing file is malformed JSON
 * (we never overwrite user settings we can't parse).
 */
export async function addTrust(opts: {
  readonly cwd: string;
  readonly absPath: string;
  readonly name: string;
  readonly sha256: string;
  readonly scope?: TrustScope;
  readonly home?: string;
  readonly projectSettingsPathOverride?: string;
  readonly personalSettingsPathOverride?: string;
}): Promise<{ readonly path: string; readonly scope: TrustScope }> {
  const scope =
    opts.scope ??
    detectScope({
      absPath: opts.absPath,
      cwd: opts.cwd,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
  const path =
    scope === "project"
      ? opts.projectSettingsPathOverride ?? projectSettingsPath(opts.cwd)
      : opts.personalSettingsPathOverride ??
        personalSettingsPath(opts.home ?? homedir());

  // Read existing settings file (any keys, not just ours).
  let parsed: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (e) {
      throw new TrustWriteError(path, "io", e);
    }
    if (raw.trim().length > 0) {
      try {
        const j = JSON.parse(raw) as unknown;
        if (j && typeof j === "object" && !Array.isArray(j)) {
          parsed = j as Record<string, unknown>;
        } else {
          throw new TrustWriteError(path, "malformed");
        }
      } catch (e) {
        if (e instanceof TrustWriteError) throw e;
        throw new TrustWriteError(path, "malformed", e);
      }
    }
  }

  const existing = (parsed[SETTING_KEY] ?? {}) as Record<
    string,
    unknown
  >;
  const safeExisting: Record<string, ReadonlyArray<TrustEntry>> = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (Array.isArray(v)) {
        const filtered: TrustEntry[] = [];
        for (const row of v) {
          if (
            row &&
            typeof row === "object" &&
            typeof (row as { name?: unknown }).name === "string" &&
            typeof (row as { sha256?: unknown }).sha256 === "string"
          ) {
            filtered.push({
              name: (row as TrustEntry).name,
              sha256: (row as TrustEntry).sha256,
            });
          }
        }
        safeExisting[k] = filtered;
      }
    }
  }

  const rows = (safeExisting[opts.absPath] ?? []).slice();
  // Replace any existing row with the same name+sha; otherwise append.
  const dupIdx = rows.findIndex(
    (r) => r.name === opts.name && r.sha256 === opts.sha256,
  );
  if (dupIdx === -1) {
    rows.push({ name: opts.name, sha256: opts.sha256 });
  }
  safeExisting[opts.absPath] = rows;
  parsed[SETTING_KEY] = safeExisting;

  // Atomic write.
  await fs.mkdir(dirOf(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    await fs.rename(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) await fs.unlink(tmp);
    } catch {
      /* best-effort */
    }
    throw new TrustWriteError(path, "io", e);
  }
  return { path, scope };
}

// ─── helpers ──────────────────────────────────────────────────────

async function readScope(path: string): Promise<TrustStore> {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return {};
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed → never crash session over it (PRD §3.6 spirit)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const v = (parsed as Record<string, unknown>)[SETTING_KEY];
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: TrustStore = {};
  for (const [absPath, rows] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const filtered: TrustEntry[] = [];
    for (const row of rows) {
      if (
        row &&
        typeof row === "object" &&
        typeof (row as { name?: unknown }).name === "string" &&
        typeof (row as { sha256?: unknown }).sha256 === "string"
      ) {
        filtered.push({
          name: (row as TrustEntry).name,
          sha256: (row as TrustEntry).sha256,
        });
      }
    }
    if (filtered.length > 0) out[absPath] = filtered;
  }
  return out;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf(sep);
  return i === -1 ? "." : p.slice(0, i);
}
