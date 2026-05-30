/**
 * pi-workflows — slice 11 per-runDir resume lockfile.
 *
 * Goal: prevent two pi processes from concurrently resuming the same
 * run. The lock is advisory — a misbehaving operator can always rm it
 * — but the happy path is well-defined:
 *
 *   1. Caller acquires `<runDir>/.resume.lock` via `acquireResumeLock`.
 *      The file's body is `{ pid, bootId, startTime, acquiredAt }` so
 *      stale-lock detection works the same way as the crash sweep
 *      (PRD §5.8.2).
 *   2. On stale lock (PID dead OR bootId mismatch), the previous lock
 *      is removed and the caller re-tries the create. We do this on
 *      a SINGLE retry — if two new processes arrive simultaneously
 *      after a crash, one wins.
 *   3. On non-stale lock, the caller errors with `ResumeLockedError`.
 *   4. On clean release (`releaseResumeLock`), the file is deleted.
 *      Called from a `finally` block.
 *
 * Atomicity: we use `fs.open(path, 'wx')` (O_EXCL | O_CREAT). Two
 * concurrent createrequests on POSIX serialize at the kernel; only
 * one wins. NFS-correctness is not in v1 scope — the runDir lives
 * under `~/.pi/agent/workflows/runs/` which is local-fs in our
 * supported configs.
 *
 * Multi-process: the lockfile body's PID/bootId tuple is enough to
 * detect "process that took the lock has died". An unlucky-but-alive
 * holder will see a clean lock-loss; that's acceptable since concurrent
 * resume of the same run is operator error in the first place.
 */

import { existsSync, openSync, readFileSync, closeSync, unlinkSync, writeSync, fsyncSync } from "node:fs";
import { join } from "node:path";

import { isParentAlive, readBootId, currentBootId } from "./crashSweep.js";

export interface ResumeLockBody {
  readonly pid: number;
  readonly bootId: string;
  readonly acquiredAt: string;
  readonly runId: string;
}

export class ResumeLockedError extends Error {
  readonly runId: string;
  readonly holderPid: number;
  readonly holderBootId: string;
  readonly acquiredAt: string;
  constructor(opts: {
    runId: string;
    holderPid: number;
    holderBootId: string;
    acquiredAt: string;
  }) {
    super(
      `run ${opts.runId} is already being resumed by pid=${opts.holderPid} ` +
        `(acquiredAt=${opts.acquiredAt}). If that pi process is gone, ` +
        `delete the .resume.lock file in the runDir to clear it.`,
    );
    this.name = "ResumeLockedError";
    this.runId = opts.runId;
    this.holderPid = opts.holderPid;
    this.holderBootId = opts.holderBootId;
    this.acquiredAt = opts.acquiredAt;
  }
}

export function resumeLockPath(runDirAbs: string): string {
  return join(runDirAbs, ".resume.lock");
}

/**
 * Try to acquire the per-runDir resume lock. On success, returns a
 * release function. On contention with a live holder, throws
 * `ResumeLockedError`. Stale locks (PID dead or bootId mismatch) are
 * silently broken and re-acquired.
 */
export function acquireResumeLock(opts: {
  readonly runDirAbs: string;
  readonly runId: string;
  /** Test seam: override own pid. Defaults to `process.pid`. */
  readonly pid?: number;
  /** Test seam: override own bootId. Defaults to host bootId. */
  readonly bootId?: string;
  /** Test seam: deterministic timestamp. Defaults to ISO now. */
  readonly nowIso?: () => string;
  /** Test seam: override liveness check. */
  readonly isAlive?: (pid: number, bootId: string) => boolean;
}): { readonly release: () => void; readonly body: ResumeLockBody } {
  const lockPath = resumeLockPath(opts.runDirAbs);
  const myPid = opts.pid ?? process.pid;
  const myBootId = opts.bootId ?? currentBootId();
  const nowIso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const liveness =
    opts.isAlive ??
    ((pid: number, bootId: string) =>
      isParentAlive({ parentPid: pid, parentBootId: bootId }));

  // First attempt: O_EXCL create.
  const tryCreate = (): { readonly fd: number } | null => {
    try {
      const fd = openSync(lockPath, "wx");
      return { fd };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") return null;
      throw err;
    }
  };

  let opened = tryCreate();
  if (opened === null) {
    // Lock exists — inspect the holder.
    let body: Partial<ResumeLockBody> = {};
    // emptyBody means the file exists but has no content yet: this is the
    // TOCTOU window between openSync(O_EXCL) and writeSync in the winner.
    // Treat it as a live (held) lock — do NOT delete it.
    let emptyBody = false;
    try {
      const raw = readFileSync(lockPath, "utf-8");
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Partial<ResumeLockBody>;
        }
      } else {
        emptyBody = true;
      }
    } catch {
      // Unreadable lock — treat as stale.
      body = {};
    }
    const holderPid = typeof body.pid === "number" ? body.pid : 0;
    const holderBootId = typeof body.bootId === "string" ? body.bootId : "";
    const isStale =
      !emptyBody && (holderPid === 0 || !liveness(holderPid, holderBootId));
    if (!isStale) {
      throw new ResumeLockedError({
        runId: opts.runId,
        holderPid,
        holderBootId,
        acquiredAt: typeof body.acquiredAt === "string" ? body.acquiredAt : "<unknown>",
      });
    }
    // Stale — break it and retry once. If a third process slips in
    // between unlink and open, treat that as legitimate contention.
    try {
      unlinkSync(lockPath);
    } catch {
      // Could already be gone if a sibling broke it; keep going.
    }
    opened = tryCreate();
    if (opened === null) {
      // Lost the race to another sibling. Re-inspect — if THAT one
      // is also stale we won't recurse; surface a contention error.
      let body2: Partial<ResumeLockBody> = {};
      try {
        const raw = readFileSync(lockPath, "utf-8");
        if (raw.trim().length > 0) {
          body2 = JSON.parse(raw) as Partial<ResumeLockBody>;
        }
      } catch {
        // ignore
      }
      throw new ResumeLockedError({
        runId: opts.runId,
        holderPid: typeof body2.pid === "number" ? body2.pid : 0,
        holderBootId: typeof body2.bootId === "string" ? body2.bootId : "",
        acquiredAt: typeof body2.acquiredAt === "string" ? body2.acquiredAt : "<unknown>",
      });
    }
  }

  const fd = opened.fd;
  const lockBody: ResumeLockBody = {
    pid: myPid,
    bootId: myBootId,
    acquiredAt: nowIso,
    runId: opts.runId,
  };
  try {
    writeSync(fd, JSON.stringify(lockBody, null, 2) + "\n");
    // BUG-116: fsync before closeSync so the lock body is durable on disk
    // before the fd is released. Without this, a reader in another process
    // could see an empty file body in the window between closeSync completing
    // (making the fd available for reuse) and the OS flushing the dirty pages.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    release: () => releaseResumeLock(opts.runDirAbs),
    body: lockBody,
  };
}

/** Release the lock by unlinking the file. Idempotent. */
export function releaseResumeLock(runDirAbs: string): void {
  const path = resumeLockPath(runDirAbs);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort.
  }
}

/** Read the current lock body, if any. Used by `/workflows show`. */
export function readResumeLock(runDirAbs: string): ResumeLockBody | null {
  const path = resumeLockPath(runDirAbs);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as ResumeLockBody).pid === "number" &&
      typeof (parsed as ResumeLockBody).bootId === "string" &&
      typeof (parsed as ResumeLockBody).acquiredAt === "string" &&
      typeof (parsed as ResumeLockBody).runId === "string"
    ) {
      return parsed as ResumeLockBody;
    }
  } catch {
    // ignore
  }
  return null;
}

// Re-exports kept for symmetry with crashSweep — slice 11 callers
// often want both.
export { isParentAlive, readBootId };
