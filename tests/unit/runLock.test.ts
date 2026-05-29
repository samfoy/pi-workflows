/**
 * tests/unit/runLock.test.ts — slice 11 §D.
 *
 * Per-runDir resume lockfile contract:
 *   - Acquire creates `<runDir>/.resume.lock` with our PID/bootId.
 *   - Re-acquire while live holder → throws ResumeLockedError.
 *   - Stale lock (PID dead) is silently broken + re-acquired.
 *   - Release unlinks the file (idempotent).
 *   - readResumeLock returns the body or null.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireResumeLock,
  releaseResumeLock,
  readResumeLock,
  resumeLockPath,
  ResumeLockedError,
} from "../../src/runtime/runLock.ts";

function tmpRunDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-runlock-"));
  const runDir = join(root, "wf-locktest0001");
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

test("acquireResumeLock: creates the lockfile with our pid + bootId", () => {
  const runDir = tmpRunDir();
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-locktest0001",
  });
  try {
    assert.equal(existsSync(resumeLockPath(runDir)), true);
    const body = readResumeLock(runDir);
    assert.ok(body);
    assert.equal(body!.pid, process.pid);
    assert.equal(body!.runId, "wf-locktest0001");
    assert.equal(handle.body.pid, process.pid);
  } finally {
    handle.release();
  }
});

test("releaseResumeLock: removes the lockfile + is idempotent", () => {
  const runDir = tmpRunDir();
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-locktest0001",
  });
  handle.release();
  assert.equal(existsSync(resumeLockPath(runDir)), false);
  // idempotent — second release no-ops.
  handle.release();
  releaseResumeLock(runDir);
  assert.equal(existsSync(resumeLockPath(runDir)), false);
});

test("acquireResumeLock: re-acquire while live holder → ResumeLockedError", () => {
  const runDir = tmpRunDir();
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-locktest0001",
  });
  try {
    assert.throws(
      () =>
        acquireResumeLock({
          runDirAbs: runDir,
          runId: "wf-locktest0001",
        }),
      (err) => {
        assert.ok(err instanceof ResumeLockedError);
        if (err instanceof ResumeLockedError) {
          assert.equal(err.holderPid, process.pid);
          assert.equal(err.runId, "wf-locktest0001");
        }
        return true;
      },
    );
  } finally {
    handle.release();
  }
});

test("[concurrent-resume rejection] two acquires under the same runDir: second errors loudly", () => {
  // Simulates two pi processes trying to resume the same run.
  const runDir = tmpRunDir();
  const first = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-twoprocess1",
  });
  let observedError: ResumeLockedError | null = null;
  try {
    acquireResumeLock({ runDirAbs: runDir, runId: "wf-twoprocess1" });
  } catch (err) {
    if (err instanceof ResumeLockedError) observedError = err;
  }
  first.release();
  assert.ok(observedError, "expected second acquire to throw ResumeLockedError");
  assert.match(
    observedError!.message,
    /already being resumed/,
    "expected loud message about the run already being resumed",
  );
});

test("acquireResumeLock: stale lock (PID dead) is silently broken + acquired", () => {
  const runDir = tmpRunDir();
  // Drop a stale lock pointing at PID 999999 (dead).
  writeFileSync(
    resumeLockPath(runDir),
    JSON.stringify({
      pid: 999999,
      bootId: "",
      acquiredAt: new Date(0).toISOString(),
      runId: "wf-locktest0001",
    }),
  );
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-locktest0001",
  });
  try {
    const body = readResumeLock(runDir);
    assert.ok(body);
    assert.equal(body!.pid, process.pid);
    // The new lock should be writable.
    assert.notEqual(body!.acquiredAt, new Date(0).toISOString());
  } finally {
    handle.release();
  }
});

test("acquireResumeLock: liveness override (test seam)", () => {
  const runDir = tmpRunDir();
  // Drop a lock claiming a process is alive — but override the
  // liveness check to claim dead.
  writeFileSync(
    resumeLockPath(runDir),
    JSON.stringify({
      pid: process.pid, // really alive
      bootId: "",
      acquiredAt: new Date().toISOString(),
      runId: "wf-locktest0001",
    }),
  );
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-locktest0001",
    isAlive: () => false, // claim dead
  });
  // Should successfully acquire.
  handle.release();
});

test("readResumeLock: returns null for missing/corrupt files", () => {
  const runDir = tmpRunDir();
  assert.equal(readResumeLock(runDir), null);
  // corrupt body
  writeFileSync(resumeLockPath(runDir), "not json");
  assert.equal(readResumeLock(runDir), null);
  // missing pid field
  writeFileSync(resumeLockPath(runDir), JSON.stringify({ runId: "x" }));
  assert.equal(readResumeLock(runDir), null);
});

test("acquireResumeLock body persisted: file content is parseable JSON", () => {
  const runDir = tmpRunDir();
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-jsonbody01x",
    nowIso: () => "2026-05-29T00:00:00.000Z",
  });
  try {
    const raw = readFileSync(resumeLockPath(runDir), "utf8");
    const parsed = JSON.parse(raw) as {
      pid: number;
      runId: string;
      acquiredAt: string;
    };
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.runId, "wf-jsonbody01x");
    assert.equal(parsed.acquiredAt, "2026-05-29T00:00:00.000Z");
  } finally {
    handle.release();
  }
});
