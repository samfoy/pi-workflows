/**
 * pi-workflows — partial-manifest writer (slice 6).
 *
 * Slice 6 owns the parent-liveness fields of `<runDir>/manifest.json`:
 *
 *   - `parentPid`         — `process.pid`
 *   - `parentStartTime`   — `process.hrtime.bigint()` snapshot at run
 *                           start, decimal-stringified for JSON
 *                           round-trip. Combined with `parentBootId`
 *                           this is unique-per-pi-process across PID
 *                           recycling.
 *   - `parentBootId`      — Linux: `/proc/sys/kernel/random/boot_id`,
 *                           strip trailing newline; macOS: empty
 *                           string (sysctl `kern.boottime` would be
 *                           the natural source but we don't shell out
 *                           in v0.1; documented in parity-gaps).
 *                           Together with `parentStartTime` this is
 *                           sufficient for the slice-5.8.2 sweep.
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

import { promises as fs, existsSync, readFileSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  ParentLivenessFields,
  RunManifest,
} from "../types/internal.js";
import { manifestPath } from "../util/paths.js";

/**
 * Capture parent-liveness fields once at run-start. Pure (well, reads
 * `/proc` and `process` but never mutates anything). Safe to call from
 * multiple slices; each gets its own snapshot.
 */
export function captureParentLiveness(
  argv: { pid?: number; hrtimeBigint?: () => bigint } = {},
): ParentLivenessFields {
  const parentPid = argv.pid ?? process.pid;
  const ht = (argv.hrtimeBigint ?? process.hrtime.bigint).call(process.hrtime);
  // hrtime.bigint() is monotonic; we serialize as decimal so the
  // manifest survives JSON round-trip without precision loss.
  const parentStartTime = ht.toString();
  let parentBootId = "";
  // Linux: cat /proc/sys/kernel/random/boot_id, strip trailing
  // whitespace. Defensive — in containers / chroot this may not exist.
  try {
    if (process.platform === "linux" && existsSync("/proc/sys/kernel/random/boot_id")) {
      parentBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
  } catch {
    // ignore — empty string is the documented "unavailable" sentinel.
  }
  return { parentPid, parentStartTime, parentBootId };
}

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
 */
export async function writeParentLivenessFields(
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
      // Corrupt manifest — overwrite. Slice 8a's read path will treat
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
  await fs.rename(tmpName, target);
}

/** `<runDir>/manifest.json` from an absolute run-dir path. */
function manifestPath_byDir(runDirAbs: string): string {
  return join(runDirAbs, "manifest.json");
}

// Re-export the by-runId path helper for symmetry with other slices'
// import patterns.
export { manifestPath };
