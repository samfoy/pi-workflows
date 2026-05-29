/**
 * tests/unit/resumeRecheckAppend.test.ts — slice 14 / slice_14_concerns W2.
 *
 * Recheck `sm.state === "paused"` AFTER `ledger.append({type:"resume"})`.
 * Witness: monkey-patch LedgerWriter.append to fire a synchronous
 * "stop" call DURING the resume entry's append. After append returns,
 * sm.state should be `stopped` (not `paused`). The recheck must abort
 * the resume and emit a discrepancy log line; sm must NOT transition
 * paused → running.
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
  runDirAbs: string;
  workflow: WorkflowFile;
  resolveRunDir: (id: string) => string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-w2-"));
  const wfDir = join(root, "workflows");
  await mkdir(wfDir, { recursive: true });
  const wfPath = join(wfDir, "demo.workflow.js");
  await writeFile(
    wfPath,
    [
      "await new Promise((resolve) => {",
      "  ctx.signal.addEventListener('abort', () => resolve(null));",
      "});",
      "return 'done';",
    ].join("\n"),
    "utf-8",
  );
  const runDirAbs = join(root, "wf-w201");
  return {
    runDirAbs,
    workflow: {
      name: "demo",
      absPath: wfPath,
      scope: "personal",
    } as WorkflowFile,
    resolveRunDir: () => runDirAbs,
  };
}

test("W2: resumePaused observes state-flip during ledger.append + aborts cleanly", async (t) => {
  const { workflow, runDirAbs, resolveRunDir } = await makeRunDir();

  const run = await startWorkflowRun(workflow, "w2-recheck", {
    preApproved: true,
    resolveRunDir,
    newRunIdFactory: () => "wf-w201",
    nowIso: () => "2026-05-29T12:00:00Z",
  });
  run.promise.catch(() => undefined);

  // Pause first (synchronously transitions to paused).
  const paused = await run.pause("p1");
  assert.equal(paused, true);

  // Now monkey-patch LedgerWriter.append: when the `resume` entry comes
  // through, fire run.cancel() during the append so ctrl.signal.aborted
  // flips synchronously while resumePaused is mid-flush. The recheck
  // observes aborted=true and rolls back.
  const proto = LedgerWriter.prototype as unknown as {
    append: LedgerWriter["append"];
  };
  const orig = proto.append;
  let firedStop = false;
  proto.append = function patched(this: LedgerWriter, entry: Parameters<LedgerWriter["append"]>[0]) {
    if (entry.type === "resume" && !firedStop) {
      firedStop = true;
      // Fire cancel() synchronously: ctrl.signal.aborted flips before
      // ledger.append's promise resolves. Add a small delay so the
      // resume's await definitely outlasts the abort.
      run.cancel(new Error("w2-race-cancel"));
    }
    return orig.call(this, entry);
  };
  t.after(() => {
    proto.append = orig;
  });

  // Trigger the resume — it will append, then stop fires, then recheck
  // should observe sm.state !== "paused" and abort.
  const resumed = await run.resumePaused("r1-aborted");
  // resumePaused must return false because the recheck aborts.
  assert.equal(resumed, false, "resumePaused must abort when state flips during append");

  // Drain & assert ledger does NOT carry a paused→running transition.
  await run.terminated;

  const ledgerText = await readFile(join(runDirAbs, "ledger.jsonl"), "utf-8");
  const lines = ledgerText
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; from?: string; to?: string; level?: string; message?: string });

  // The discrepancy log line must be present.
  const discrepancy = lines.find(
    (l) =>
      l.type === "log" &&
      l.level === "warn" &&
      typeof l.message === "string" &&
      l.message.startsWith("resumePaused aborted"),
  );
  assert.ok(
    discrepancy !== undefined,
    `expected discrepancy log; got\n${ledgerText}`,
  );

  // No spurious paused→running transition.
  const pausedToRunning = lines.find(
    (l) => l.type === "transition" && l.from === "paused" && l.to === "running",
  );
  assert.equal(
    pausedToRunning,
    undefined,
    `must not have a paused→running transition; got\n${ledgerText}`,
  );
});
