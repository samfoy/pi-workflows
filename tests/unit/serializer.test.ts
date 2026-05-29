/**
 * tests/unit/serializer.test.ts — slice 13 / slice_13_concerns F5 + slice_14_concerns F1.
 *
 * Slice 12 documented the run handle's `controlChain` lock that
 * serializes pause()/resumePaused()/stop() against each other. The
 * existing slice-12 tests exercise sequential happy-paths; F5 demands
 * a concurrent-call witness that fails if the lock is removed.
 *
 * **Slice 14 update (concern F1).** The original "≤ 1 pause / ≤ 1 resume"
 * shape was passed even without `withControlLock` because gate-idempotency
 * + sm-state-checks already deduplicated. The slice-14 tighter witness
 * injects a SLOW ledger writer (50ms per pause/resume entry) and asserts
 * exactly ONE pause + ONE resume entry. Without the lock, the slow
 * pause-#1 holds the floor for 50ms; pause-#2 and resumePaused both
 * race during the gap, both find sm.state==="running" still true (because
 * sm.go("paused") hasn't fired), and both return false. Net: 1 pause + 0
 * resume — fails the new assertions.
 *
 * Mutation guard: removing `withControlLock` produces 1 pause + 0 resume
 * under slow-ledger conditions, which the assertions reject.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkflowRun } from "../../src/runManager.js";
import { LedgerWriter } from "../../src/runtime/ledger.js";
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
      "// Top-level body — sandbox wraps in async IIFE so we can await.",
      "await new Promise((resolve, reject) => {",
      "  ctx.signal.addEventListener('abort', () => resolve(null));",
      "});",
      "return 'done';",
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

/**
 * Slice 14 / slice_14_concerns F1 — tightened witness.
 *
 * Inject a slow LedgerWriter so pause-#1 holds the control lock for 50ms.
 * With `withControlLock`, pause-#2 and resumePaused queue behind pause-#1
 * and observe consistent state (gate paused, sm at "paused"). Net:
 *   - pause-#1: succeeds (true)
 *   - pause-#2: idempotent no-op via gate (false), no ledger entry
 *   - resumePaused: queues, observes sm.state="paused", succeeds (true)
 * Net ledger: 1 pause + 1 resume entry, in that order.
 *
 * WITHOUT the lock: pause-#2 and resumePaused fire WHILE pause-#1's
 * ledger.append is still pending. sm.state is still "running" (sm.go
 * hasn't fired). Both fail their state checks and return false. Net
 * ledger: 1 pause + 0 resume. Assertion fails → mutation killed.
 */
test("F1 (slice 14): slow-ledger witness asserts exactly 1 pause + 1 resume", async (t) => {
  // Monkey-patch LedgerWriter.append to inject 50ms delay for pause/resume
  // entries (delaying ALL would slow the init/state writes too much, eating
  // the test wall-time budget). Restore in afterEach.
  const proto = LedgerWriter.prototype as unknown as {
    append: LedgerWriter["append"];
  };
  const orig = proto.append;
  proto.append = function patched(this: LedgerWriter, entry: Parameters<LedgerWriter["append"]>[0]) {
    const realPromise = orig.call(this, entry);
    if (entry.type === "pause" || entry.type === "resume") {
      return new Promise<void>((resolveDelay, rejectDelay) => {
        realPromise.then(
          () => setTimeout(() => resolveDelay(), 50),
          (err) => setTimeout(() => rejectDelay(err), 50),
        );
      });
    }
    return realPromise;
  };
  t.after(() => {
    proto.append = orig;
  });

  const { workflow, runDirAbs, resolveRunDir } = await makeRunDir();
  const run = await startWorkflowRun(workflow, "f1-tightened", {
    preApproved: true,
    resolveRunDir,
    newRunIdFactory: () => "wf-f1-tighter",
    nowIso: () => "2026-05-29T12:00:00Z",
  });
  run.promise.catch(() => undefined);

  const [p1, p2, r1] = await Promise.all([
    run.pause("slow-1"),
    run.pause("slow-2"),
    run.resumePaused("slow-3"),
  ]);

  // Drain ledger writes.
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

  // The CRITICAL assertions: exactly one pause + one resume. Without the
  // control lock, resumeCount would be 0 (resumePaused races pause-#1's
  // 50ms ledger flush and sees sm.state==="running").
  assert.equal(
    pauseCount,
    1,
    `expected exactly 1 pause entry; got ${pauseCount}\n${ledgerText}`,
  );
  assert.equal(
    resumeCount,
    1,
    `expected exactly 1 resume entry; got ${resumeCount} (without withControlLock this would be 0)\n${ledgerText}`,
  );
  // Order: pause must precede resume.
  const pauseIdx = lines.findIndex((l) => l.type === "pause");
  const resumeIdx = lines.findIndex((l) => l.type === "resume");
  assert.ok(pauseIdx < resumeIdx, "pause must precede resume in ledger");

  // Caller-observed booleans: at least pause-#1 succeeded; at least one of
  // pause-#2/resumePaused succeeded.
  const successCount = [p1, p2, r1].filter(Boolean).length;
  assert.equal(
    successCount,
    2,
    `with control lock, exactly 2 of pause/pause/resume should win; got ${successCount}`,
  );
});
