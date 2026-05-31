/**
 * tests/integration/abortSignalE2E.test.ts — slice 9 [F1] AbortSignal
 * end-to-end. The sandbox's worker-thread runner rejects the run
 * promise when the host signal aborts (PRD §5.5 user-stop) by calling
 * `worker.terminate()`. What we verify here is that the WIRING
 * actually exists: ctx.signal is a Context-realm AbortSignal-shaped
 * object, and aborting the host fires the Context-side abort.
 * Visibility is captured via ctx.log entries the test reads from the
 * ledger after the run rejects.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.ts";

function makeTmp(): {
  runsRoot: string;
  cwd: string;
  home: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-abort-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-home-"));
  return {
    runsRoot,
    cwd,
    home,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "abortable", absPath, scope: "personal" };
}

function readLedger(runDir: string): { type: string; level?: string; message?: string }[] {
  return readFileSync(join(runDir, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; level?: string; message?: string });
}

test("ctx.signal exposed: aborted is false at start, becomes true on parent cancel", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "abortable.workflow.js");
  writeFileSync(
    wfPath,
    `
      ctx.log("start: aborted=" + String(ctx.signal && ctx.signal.aborted));
      ctx.signal.addEventListener('abort', () => {
        ctx.log("listener-fired: aborted=" + String(ctx.signal.aborted));
      });
      try {
        await ctx.sleep(10000);
      } catch (e) {
        ctx.log("sleep-rejected: name=" + e.name + " message=" + e.message);
      }
      return null;
    `,
    "utf8",
  );

  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: { PI_BYPASS_PERMISSIONS: "1" },
      home,
      dialog: async () => "no",
      viewer: () => undefined,
    },
  });
  setTimeout(() => run.cancel(new Error("parent shutdown")), 50);

  // Run rejects via the worker-thread abort path — that's expected.
  await assert.rejects(run.promise, /aborted|parent shutdown/);

  // Read ledger to verify the wiring fired.
  const ledger = readLedger(run.runDirAbs);
  const logs = ledger
    .filter((e) => e.type === "log")
    .map((e) => e.message ?? "");

  assert.ok(
    logs.some((m) => m.includes("start: aborted=false")),
    `expected 'start: aborted=false' log, got ${JSON.stringify(logs)}`,
  );
  assert.ok(
    logs.some((m) => m.includes("listener-fired: aborted=true")),
    `expected 'listener-fired: aborted=true' log, got ${JSON.stringify(logs)}`,
  );
  // ctx.sleep rejection landed inside the script's try/catch.
  assert.ok(
    logs.some((m) => m.includes("sleep-rejected: name=AbortError")),
    `expected 'sleep-rejected: name=AbortError' log, got ${JSON.stringify(logs)}`,
  );
});

test("ctx.signal AbortError reason text propagates from host", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "reason.workflow.js");
  writeFileSync(
    wfPath,
    `
      try { await ctx.sleep(10000); }
      catch (e) {
        ctx.log("reason-msg=" + (e && e.message));
      }
      return null;
    `,
    "utf8",
  );
  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: { PI_BYPASS_PERMISSIONS: "1" },
      home,
      dialog: async () => "no",
      viewer: () => undefined,
    },
  });
  setTimeout(() => run.cancel(new Error("custom-shutdown-reason-xyz")), 30);
  await assert.rejects(run.promise);

  const logs = readLedger(run.runDirAbs)
    .filter((e) => e.type === "log")
    .map((e) => e.message ?? "");
  assert.ok(
    logs.some((m) => m.includes("custom-shutdown-reason-xyz")),
    `expected reason text to propagate; got ${JSON.stringify(logs)}`,
  );
});

test("ctx.signal accessible without abort (run completes normally)", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "normal.workflow.js");
  writeFileSync(
    wfPath,
    `return {
      hasSignal: typeof ctx.signal === 'object' && ctx.signal !== null,
      aborted: ctx.signal.aborted,
      addElType: typeof ctx.signal.addEventListener,
      removeElType: typeof ctx.signal.removeEventListener,
    };`,
    "utf8",
  );
  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: { PI_BYPASS_PERMISSIONS: "1" },
      home,
      dialog: async () => "no",
      viewer: () => undefined,
    },
  });
  const out = (await run.promise) as {
    hasSignal: boolean;
    aborted: boolean;
    addElType: string;
    removeElType: string;
  };
  assert.equal(out.hasSignal, true);
  assert.equal(out.aborted, false);
  assert.equal(out.addElType, "function");
  assert.equal(out.removeElType, "function");
});
