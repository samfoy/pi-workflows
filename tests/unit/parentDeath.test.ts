/**
 * Slice 6 — parent-death wrapper unit tests.
 *
 * The wrapper is a generated sh script. We test:
 *   1. The script is materialized into the run-dir with mode 0700.
 *   2. The script is removable.
 *   3. Smoke-execute the script: when the original parent IS alive,
 *      the wrapped command runs to completion.
 *
 * The killed-parent integration test is deferred to
 * `tests/integration/orphan-cleanup.test.ts` and gated on
 * `RUN_ORPHAN_TEST=1` per plan §4 Slice 6 acceptance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  removeParentDeathWrapper,
  writeParentDeathWrapper,
} from "../../src/runtime/parentDeath.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-pdeath-"));
}

test("writeParentDeathWrapper: materializes a 0700 sh script", async () => {
  const dir = tmpRunDir();
  const path = await writeParentDeathWrapper({
    runDirAbs: dir,
    agentId: "agent-a",
    originalParentPid: process.pid,
  });
  assert.ok(existsSync(path));
  assert.equal(path, join(dir, ".pdeath-agent-a.sh"));
  const stat = statSync(path);
  // Owner read/write/execute bits present.
  assert.equal(stat.mode & 0o700, 0o700);
  const content = readFileSync(path, "utf8");
  assert.ok(content.startsWith("#!/bin/sh"));
  assert.ok(content.includes(`PI_PARENT_PID=${process.pid}`));
  assert.ok(content.includes('exec "$@"'));
});

test("removeParentDeathWrapper: deletes the script, idempotent", async () => {
  const dir = tmpRunDir();
  const path = await writeParentDeathWrapper({
    runDirAbs: dir,
    agentId: "x",
    originalParentPid: 1,
  });
  assert.ok(existsSync(path));
  await removeParentDeathWrapper(path);
  assert.ok(!existsSync(path));
  // Second remove is a silent no-op.
  await removeParentDeathWrapper(path);
});

test("writeParentDeathWrapper: smoke-exec — wrapped echo prints when parent alive", { timeout: 10000 }, async () => {
  const dir = tmpRunDir();
  const path = await writeParentDeathWrapper({
    runDirAbs: dir,
    agentId: "smoke",
    originalParentPid: process.pid,
    pollIntervalSeconds: 1,
  });
  // Run the wrapper with a fast echo; the watcher's `kill -0` against
  // our own pid will succeed for the (sub-second) lifetime of the echo.
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", [path, "/bin/sh", "-c", "echo wrapped-output"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit=${code}`))));
    child.on("error", reject);
  });
  assert.equal(Buffer.concat(out).toString("utf8").trim(), "wrapped-output");
});
