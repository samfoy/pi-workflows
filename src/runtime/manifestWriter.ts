/**
 * pi-workflows - partial-manifest writer (slice 6).
 *
 * Slice 6 owns the parent-liveness fields of `<runDir>/manifest.json`:
 *
 *   - `parentPid`         - `process.pid`
 *   - `parentStartTime`   - `process.hrtime.bigint()` snapshot at run
 *                           start, decimal-stringified for JSON
 *                           round-trip. Combined with `parentBootId`
 *                           this is unique-per-pi-process across PID
 *                           recycling.
 *   - `parentBootId`      - Linux: `/proc/sys/kernel/random/boot_id`,
 *                           strip trailing newline; macOS:
 *                           `darwin-<sec>` from `sysctl kern.boottime`
 *                           (closes the macOS PID-recycle gap - a
 *                           manifest written by a previous boot is
 *                           detectable as stale even though PIDs may
 *                           have recycled into the same numeric
 *                           range). Empty string on unsupported
 *                           platforms / containers / sysctl failures;
 *                           the sweep falls back to pid-only liveness
 *                           in that case.
 *
 * Per oracle's plan revision (Fix 2 Option A): slice 6 writes a
 * **partial** manifest. Slice 8a will read whatever's there and merge
 * in the rest (`workflowName`, `runId`, `startedAt`, etc).
 *
 * Atomicity: writes go via temp-file + rename so a crashed parent
 * mid-write never leaves a half-JSON manifest. Concurrent writers in
 * the same run-dir are not supported (one parent per run); the
 * partial-write merge tolerates a pre-existing manifest by deep-
 * merging the existing fields under our owned set.
 */

import { closeSync, fsyncSync, openSync, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  ParentLivenessFields,
  RunManifest,
} from "../types/internal.js";
import { manifestPath } from "../util/paths.js";
import { currentBootId } from "./crashSweep.js";

/**
 * Capture parent-liveness fields once at run-start. Pure (well, reads
 * `/proc` and `process` but never mutates anything). Safe to call from
 * multiple slices; each gets its own snapshot.
 */
export function captureParentLiveness(
  argv: { pid?: number; hrtimeBigint?: () => bigint } = {},
): ParentLivenessFields {
  const parentPid = argv.pid ?? process.pid;
  const ht = argv.hrtimeBigint ? argv.hrtimeBigint() : process.hrtime.bigint();
  // hrtime.bigint() is monotonic; we serialize as decimal so the
  // manifest survives JSON round-trip without precision loss.
  const parentStartTime = ht.toString();
  // Boot id resolution lives in `crashSweep.currentBootId()` so the
  // sweep reader and the manifest writer agree on the same identity.
  // Linux: UUID from /proc; darwin: `darwin-<sec>` from sysctl;
  // anything else: empty sentinel.
  const parentBootId = currentBootId();
  return { parentPid, parentStartTime, parentBootId };
}

/**
 * BUG-038: Per-runDir write queue to serialize concurrent
 * writeParentLivenessFields calls. Without this, two callers racing on
 * the same runDir both read the same original manifest, both merge their
 * own fields, and one write silently overwrites the other.
 *
 * Keyed by absolute runDir path. Each entry is the tail of the chain;
 * errors are swallowed from the chain tail so a failed write doesn't
 * block all future writes for the same run.
 */
const livenessWriteQueue = new Map<string, Promise<void>>();

/**
 * Write/merge the parent-liveness fields into `<runDir>/manifest.json`.
 *
 * Behavior:
 *   - If no manifest exists yet, writes a partial JSON containing only
 *     the three fields. Slice 8a will merge in the rest later.
 *   - If a manifest already exists, deep-merges our fields over the
 *     top (slice 8a's order-of-operations writes its fields first,
 *     then we overwrite the parent-liveness keys).
 *   - Atomic via temp-file + rename. The temp file lives in the
 *     `<runDir>` itself so the rename is on the same filesystem.
 *   - Serialized per-runDir (BUG-038): concurrent callers for the same
 *     runDir are queued so no write is lost.
 */
export function writeParentLivenessFields(
  runDirAbs: string,
  fields: ParentLivenessFields,
): Promise<void> {
  const pending = livenessWriteQueue.get(runDirAbs) ?? Promise.resolve();
  const next = pending.then(() => _doWriteParentLiveness(runDirAbs, fields));
  // Don't let a single failure permanently block the queue for this run.
  const queued = next.catch(() => {});
  livenessWriteQueue.set(runDirAbs, queued);
  // Prune the entry once this promise is the last in the chain — avoids
  // unbounded map growth on long-lived autoloop hosts (BUG: mem-leak).
  queued.finally(() => {
    if (livenessWriteQueue.get(runDirAbs) === queued) {
      livenessWriteQueue.delete(runDirAbs);
    }
  });
  return next;
}

/** Inner write logic extracted for the serialization wrapper above. */
async function _doWriteParentLiveness(
  runDirAbs: string,
  fields: ParentLivenessFields,
): Promise<void> {
  await fs.mkdir(runDirAbs, { recursive: true });
  const target = manifestPath_byDir(runDirAbs);
  let existing: Partial<RunManifest> = {};
  try {
    const buf = await fs.readFile(target, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Partial<RunManifest>;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt manifest - overwrite. Slice 8a's read path will treat
      // a missing-fields manifest as a fresh run, which is the right
      // semantics for "we couldn't trust what was there."
    }
  }
  const merged: Partial<RunManifest> = {
    ...existing,
    parentPid: fields.parentPid,
    parentStartTime: fields.parentStartTime,
    parentBootId: fields.parentBootId,
  };
  const tmpName = join(
    runDirAbs,
    // Slice 8a fix: include random bytes in the tmp filename so two
    // concurrent dispatches in the same millisecond can't collide on
    // the rename path. Without this, parallel agents in `ctx.phase`
    // race: both writeFile the same tmp path, A renames first, B's
    // rename ENOENTs because A's rename moved (and removed) the tmp.
    `manifest.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const json = JSON.stringify(merged, null, 2) + "\n";
  await fs.writeFile(tmpName, json, "utf8");
  const fd = openSync(tmpName, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  await fs.rename(tmpName, target);
}

/** `<runDir>/manifest.json` from an absolute run-dir path. */
function manifestPath_byDir(runDirAbs: string): string {
  return join(runDirAbs, "manifest.json");
}

// ─── ZONE_MEMORY: per-(runDir, name) agent-memory dir record ────────
//
// Reuses the same per-runDir queue + atomic merge pattern as
// `writeParentLivenessFields` so that concurrent first-dispatches in
// `ctx.phase` cannot interleave and clobber each other's recorded
// dirs. The on-disk shape is `agentMemoryDirs: { <name>: <dir> }`.

/**
 * Record the resolved agent-memory directory for `name` into
 * `<runDir>/manifest.json`. Idempotent - re-recording the same
 * (name, dir) pair is a no-op merge. Different dirs for the same
 * name overwrite (last-write-wins) which can only happen if a
 * caller mixes scopes for the same persona within a single run;
 * that's a workflow-author bug we surface via overwrite, not error.
 */
export function recordAgentMemoryDir(
  runDirAbs: string,
  name: string,
  dir: string,
): Promise<void> {
  const pending = livenessWriteQueue.get(runDirAbs) ?? Promise.resolve();
  const next = pending.then(() =>
    _doRecordAgentMemoryDir(runDirAbs, name, dir),
  );
  const queued = next.catch(() => {});
  livenessWriteQueue.set(runDirAbs, queued);
  queued.finally(() => {
    if (livenessWriteQueue.get(runDirAbs) === queued) {
      livenessWriteQueue.delete(runDirAbs);
    }
  });
  return next;
}

async function _doRecordAgentMemoryDir(
  runDirAbs: string,
  name: string,
  dir: string,
): Promise<void> {
  await fs.mkdir(runDirAbs, { recursive: true });
  const target = manifestPath_byDir(runDirAbs);
  let existing: Partial<RunManifest> & {
    agentMemoryDirs?: Record<string, string>;
  } = {};
  try {
    const buf = await fs.readFile(target, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Partial<RunManifest> & {
          agentMemoryDirs?: Record<string, string>;
        };
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt manifest - overwrite with our fields only.
    }
  }
  const priorDirs =
    existing.agentMemoryDirs && typeof existing.agentMemoryDirs === "object"
      ? existing.agentMemoryDirs
      : {};
  if (priorDirs[name] === dir) return; // already recorded - short-circuit
  const merged = {
    ...existing,
    agentMemoryDirs: { ...priorDirs, [name]: dir },
  };
  const tmpName = join(
    runDirAbs,
    `manifest.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const json = JSON.stringify(merged, null, 2) + "\n";
  await fs.writeFile(tmpName, json, "utf8");
  const fd = openSync(tmpName, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  await fs.rename(tmpName, target);
}

// ─── ZONE_WORKTREE: per-(runDir, agentId) worktree path record ──────
//
// Mirrors `recordAgentMemoryDir` exactly - same per-runDir queue,
// same atomic merge, different field name. On-disk shape is
// `agentWorktrees: { <agentId>: <absPath> }`.

/**
 * Record the resolved git-worktree directory for `agentId` into
 * `<runDir>/manifest.json`. Idempotent - re-recording the same
 * (agentId, dir) pair short-circuits without rewriting the file.
 */
export function recordAgentWorktreePath(
  runDirAbs: string,
  agentId: string,
  dir: string,
): Promise<void> {
  const pending = livenessWriteQueue.get(runDirAbs) ?? Promise.resolve();
  const next = pending.then(() =>
    _doRecordAgentWorktreePath(runDirAbs, agentId, dir),
  );
  const queued = next.catch(() => {});
  livenessWriteQueue.set(runDirAbs, queued);
  queued.finally(() => {
    if (livenessWriteQueue.get(runDirAbs) === queued) {
      livenessWriteQueue.delete(runDirAbs);
    }
  });
  return next;
}

async function _doRecordAgentWorktreePath(
  runDirAbs: string,
  agentId: string,
  dir: string,
): Promise<void> {
  await fs.mkdir(runDirAbs, { recursive: true });
  const target = manifestPath_byDir(runDirAbs);
  let existing: Partial<RunManifest> & {
    agentWorktrees?: Record<string, string>;
  } = {};
  try {
    const buf = await fs.readFile(target, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Partial<RunManifest> & {
          agentWorktrees?: Record<string, string>;
        };
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt manifest - overwrite with our fields only.
    }
  }
  const priorTrees =
    existing.agentWorktrees && typeof existing.agentWorktrees === "object"
      ? existing.agentWorktrees
      : {};
  if (priorTrees[agentId] === dir) return; // already recorded - short-circuit
  const merged = {
    ...existing,
    agentWorktrees: { ...priorTrees, [agentId]: dir },
  };
  const tmpName = join(
    runDirAbs,
    `manifest.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const json = JSON.stringify(merged, null, 2) + "\n";
  await fs.writeFile(tmpName, json, "utf8");
  const fd = openSync(tmpName, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  await fs.rename(tmpName, target);
}

// ─── P2-S2: phaseMeta persistence ────────────────────────────
//
// Reuses the same per-runDir queue + atomic merge pattern so a
// run-start phaseMeta write can never tear or interleave with the
// dispatcher's parent-liveness write or runManager's slice-8a
// partial-manifest write.

/**
 * Merge `phaseMeta` (extracted from `meta.phases[]` at run-start)
 * into `<runDir>/manifest.json`. Idempotent in shape — callers may
 * re-invoke with the same array and the file will be rewritten with
 * an identical payload. Empty arrays are written as-is so disk
 * hydration can distinguish "workflow declared no phases" (`[]`)
 * from "pre-P2 run" (`undefined`).
 */
export function writePhaseMeta(
  runDirAbs: string,
  phaseMeta: ReadonlyArray<{ title: string; description?: string }>,
): Promise<void> {
  const pending = livenessWriteQueue.get(runDirAbs) ?? Promise.resolve();
  const next = pending.then(() => _doWritePhaseMeta(runDirAbs, phaseMeta));
  const queued = next.catch(() => {});
  livenessWriteQueue.set(runDirAbs, queued);
  queued.finally(() => {
    if (livenessWriteQueue.get(runDirAbs) === queued) {
      livenessWriteQueue.delete(runDirAbs);
    }
  });
  return next;
}

async function _doWritePhaseMeta(
  runDirAbs: string,
  phaseMeta: ReadonlyArray<{ title: string; description?: string }>,
): Promise<void> {
  await fs.mkdir(runDirAbs, { recursive: true });
  const target = manifestPath_byDir(runDirAbs);
  let existing: Partial<RunManifest> = {};
  try {
    const buf = await fs.readFile(target, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Partial<RunManifest>;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt manifest — overwrite with our fields only.
    }
  }
  // Strip undefined description fields so the on-disk JSON stays clean.
  const sanitized = phaseMeta.map((p) =>
    p.description !== undefined
      ? { title: p.title, description: p.description }
      : { title: p.title },
  );
  const merged: Partial<RunManifest> = {
    ...existing,
    phaseMeta: sanitized,
  };
  const tmpName = join(
    runDirAbs,
    `manifest.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const json = JSON.stringify(merged, null, 2) + "\n";
  await fs.writeFile(tmpName, json, "utf8");
  const fd = openSync(tmpName, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  await fs.rename(tmpName, target);
}

// Re-export the by-runId path helper for symmetry with other slices'
// import patterns.
export { manifestPath };
