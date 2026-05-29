/**
 * tests/integration/abortSignalLifecycle.test.ts — slice 11 [C3].
 *
 * Carry-forward concern from slice 9: the Context-realm signal
 * polyfill ships `removeEventListener`, but no end-to-end test pins
 * the lifecycle invariant that *removing* a listener BEFORE abort
 * means the callback does NOT fire.
 *
 * Witness (the failure case slice-9 tests don't cover):
 *
 *   1. install listener for 'abort'
 *   2. removeEventListener('abort', cb)  — same fn ref
 *   3. host cancel() the run
 *   4. log proves the listener body did NOT execute
 *
 * The script also installs a *second* listener (without removing it)
 * so we can prove "abort fired, just not for the removed one." Without
 * the unremoved listener, a no-op test would pass even if abort never
 * fired at all.
 *
 * Plan §4 Slice 11 acceptance — also indirectly required by slice 14
 * pause/resume (which uses ctx.signal as the user-stop primitive).
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
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-abort-life-"));
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
  return { name: "abort-lifecycle", absPath, scope: "personal" };
}

function readLedger(
  runDir: string,
): { type: string; message?: string }[] {
  return readFileSync(join(runDir, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; message?: string });
}

test("[C3] removeEventListener prevents installed callback from firing on abort", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "lifecycle.workflow.js");

  // Two listeners:
  //   - removed:    installed THEN removeEventListener'd; must NOT fire
  //   - persistent: installed and never removed; MUST fire (proves
  //                 abort DID happen at the polyfill level)
  writeFileSync(
    wfPath,
    `
      const removedCb = () => {
        ctx.log("REMOVED-LISTENER-FIRED-WRONG");
      };
      const persistentCb = () => {
        ctx.log("PERSISTENT-LISTENER-FIRED");
      };

      ctx.signal.addEventListener('abort', removedCb);
      ctx.signal.addEventListener('abort', persistentCb);

      // Remove the first one BEFORE the abort.
      ctx.signal.removeEventListener('abort', removedCb);

      ctx.log("listeners-installed-and-one-removed");

      try {
        await ctx.sleep(10000);
      } catch (e) {
        // sleep rejects on abort — let the listener fire first via
        // a microtask delay.
        await new Promise((r) => setTimeout(r, 10));
        ctx.log("sleep-rejected: name=" + e.name);
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
  setTimeout(() => run.cancel(new Error("c3-cancel-test")), 50);
  await assert.rejects(run.promise);

  const logs = readLedger(run.runDirAbs)
    .filter((e) => e.type === "log")
    .map((e) => e.message ?? "");

  // Setup confirmation:
  assert.ok(
    logs.some((m) => m.includes("listeners-installed-and-one-removed")),
    "expected setup log; got " + JSON.stringify(logs),
  );

  // Persistent listener fired (proves abort actually propagated):
  assert.ok(
    logs.some((m) => m.includes("PERSISTENT-LISTENER-FIRED")),
    "expected persistent listener to fire; got " + JSON.stringify(logs),
  );

  // CORE assertion — removed listener must NOT fire:
  assert.ok(
    !logs.some((m) => m.includes("REMOVED-LISTENER-FIRED-WRONG")),
    "[C3] removed listener fired anyway — removeEventListener leaked; got " +
      JSON.stringify(logs),
  );
});

test("[C3] removeEventListener with NO matching listener is a silent no-op", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "noop-remove.workflow.js");
  writeFileSync(
    wfPath,
    `
      // Removing a listener that was never installed must not throw.
      ctx.signal.removeEventListener('abort', () => {});
      ctx.log("noop-remove-ok");
      return 42;
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
  const result = await run.promise;
  assert.equal(result, 42);
});

test("[C3] removeEventListener under wrong event name is also a no-op (signal stays usable)", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "wrong-name.workflow.js");
  writeFileSync(
    wfPath,
    `
      const cb = () => { ctx.log("CB-FIRED"); };
      ctx.signal.addEventListener('abort', cb);
      // Wrong event name — must NOT remove the abort listener.
      ctx.signal.removeEventListener('completed', cb);
      try { await ctx.sleep(10000); } catch (_) {}
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
  setTimeout(() => run.cancel(new Error("test")), 30);
  await assert.rejects(run.promise);

  const logs = readLedger(run.runDirAbs)
    .filter((e) => e.type === "log")
    .map((e) => e.message ?? "");
  assert.ok(
    logs.some((m) => m.includes("CB-FIRED")),
    "[C3] removeEventListener under wrong name should not have removed the abort listener",
  );
});
