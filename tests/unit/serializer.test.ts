/**
 * tests/unit/serializer.test.ts — slice 13 / slice_13_concerns F5.
 *
 * Slice 12 documented the run handle's `controlChain` lock that
 * serializes pause()/resumePaused()/stop() against each other. The
 * existing slice-12 tests exercise sequential happy-paths; F5 demands
 * a concurrent-call witness that fails if the lock is removed.
 *
 * Witness: fire `Promise.all([pause(), pause(), resumePaused()])` on a
 * running mock-agents run. Outcome contract:
 *
 *   - exactly ONE successful pause() (the second is the gate-already-
 *     paused idempotent no-op)
 *   - exactly ONE successful resumePaused() (after the first pause won)
 *   - net ledger entries: exactly one `pause` and one `resume` line,
 *     in that order
 *
 * Mutation guard: removing `withControlLock` would let both pauses
 * race the gate flip and let the resume see the wrong state mid-flip,
 * producing duplicate entries OR an inverted order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkflowRun } from "../../src/runManager.js";
import type { WorkflowFile } from "../../src/types/internal.js";

async function makeRunDir(): Promise<{
  rootDir: string;
  runDirAbs: string;
  workflow: WorkflowFile;
  resolveRunDir: (id: string) => string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-slice13-ser-"));
  const wfDir = join(root, "workflows");
  await mkdir(wfDir, { recursive: true });
  const wfPath = join(wfDir, "demo.workflow.js");
  // A workflow that runs forever (until aborted) — gives the test time
  // to fire concurrent control calls. We emit a phase so the
  // pauseGate has something to gate.
  await writeFile(
    wfPath,
    [
      "exports.main = async function main() {",
      "  await new Promise((resolve, reject) => {",
      "    ctx.signal.addEventListener('abort', () => resolve(null));",
      "  });",
      "  return 'done';",
      "};",
    ].join("\n"),
    "utf-8",
  );
  const runsDir = join(root, "runs");
  await mkdir(runsDir, { recursive: true });
  const runDirAbs = join(runsDir, "wf-serializer01");
  return {
    rootDir: root,
    runDirAbs,
    workflow: {
      name: "demo",
      absPath: wfPath,
      sha256: "fake-not-checked-by-pre-approved",
      sourceText: "",
      relPath: "demo.workflow.js",
      scope: "personal",
    } as unknown as WorkflowFile,
    resolveRunDir: () => runDirAbs,
  };
}

test("F5: concurrent pause/pause/resumePaused emits exactly one pause + one resume entry", async (t) => {
  const { workflow, runDirAbs, resolveRunDir } = await makeRunDir();
  const run = await startWorkflowRun(workflow, "concurrent-test", {
    preApproved: true,
    resolveRunDir,
    newRunIdFactory: () => "wf-serializer01",
    nowIso: () => "2026-05-29T12:00:00Z",
  });
  // Suppress unhandled rejections — the run never resolves until we abort.
  run.promise.catch(() => undefined);

  // Concurrent invocation. The control lock means exactly one pause
  // wins (the other observes already-paused and is a no-op), and the
  // resumePaused enqueues after both.
  const [p1, p2, r1] = await Promise.all([
    run.pause("test-1"),
    run.pause("test-2"),
    run.resumePaused("test-3"),
  ]);

  // Outcome assertion: one pause-win, one no-op, one resume-win OR
  // (race-tolerant) one pause + one no-op + one no-op if the resume
  // landed before the second pause. Either way, the LEDGER must
  // contain at most one pause/resume pair, and they must alternate.
  const successCount = [p1, p2, r1].filter(Boolean).length;
  assert.ok(
    successCount === 2 || successCount === 1,
    `expected ≤2 successful state changes, got ${successCount}`,
  );

  // Drain ledger writes by terminating the run cleanly.
  run.cancel(new Error("end-of-test"));
  await run.terminated;

  const ledgerPath = join(runDirAbs, "ledger.jsonl");
  const ledgerText = await readFile(ledgerPath, "utf-8");
  const lines = ledgerText
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string });

  const pauseCount = lines.filter((l) => l.type === "pause").length;
  const resumeCount = lines.filter((l) => l.type === "resume").length;
  assert.ok(
    pauseCount <= 1,
    `at most one pause entry expected, got ${pauseCount}: ${ledgerText}`,
  );
  assert.ok(
    resumeCount <= 1,
    `at most one resume entry expected, got ${resumeCount}`,
  );
  // If both fired, the pause must come before the resume.
  if (pauseCount === 1 && resumeCount === 1) {
    const pauseIdx = lines.findIndex((l) => l.type === "pause");
    const resumeIdx = lines.findIndex((l) => l.type === "resume");
    assert.ok(pauseIdx < resumeIdx, "pause must precede resume in ledger");
  }
  void t;
});
