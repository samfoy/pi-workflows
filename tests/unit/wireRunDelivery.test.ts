/**
 * tests/unit/wireRunDelivery.test.ts — pin the delivery wiring helper.
 *
 * Regression for the bug where the `write_workflow` tool path started a
 * run via `startWorkflowRun(...)` but never chained
 * `run.terminated → deliverRunResult`. The result: the workflow
 * finished, `result.json` was never written, no result card landed,
 * and `pi.sendUserMessage` was never called — so the host pi
 * conversation never resumed.
 *
 * `wireRunDelivery` is the small helper both the slash-command path
 * (`commands/workflowCmd.ts`) and the `write_workflow` tool path
 * (`src/index.ts`) now share. These tests pin its contract:
 *
 *   1. After the run settles, the result card is sent and
 *      `pi.sendUserMessage` is called (default trigger message when
 *      no `ctx.finishCallback` was queued).
 *   2. When the workflow called `ctx.finishCallback("...")`, the
 *      injected user message uses that prompt.
 *   3. A workflow that throws still goes through delivery (failed
 *      outcome) — the wiring does not depend on the run resolving
 *      successfully.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkflowRun } from "../../src/runManager.ts";
import {
  RESULT_CUSTOM_TYPE,
  wireRunDelivery,
} from "../../src/runtime/resultDelivery.ts";
import type { ApprovalDialog, WorkflowFile } from "../../src/types/internal.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

function makeTmp() {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-wire-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-wire-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-wire-home-"));
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

function wf(absPath: string, name = "wired"): WorkflowFile {
  return { name, absPath, scope: "personal" };
}

const okDialog: ApprovalDialog = async () => "run-once";

test("wireRunDelivery: default — card + sendUserMessage fire after run settles", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "default.workflow.js");
  writeFileSync(wfPath, `return "ok";`, "utf8");

  const pi = makeFakePi();
  const run = await startWorkflowRun(wf(wfPath, "default"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  // Drive the delivery to completion via the helper's returned promise
  // (tests need to synchronize; production code is fire-and-forget).
  await wireRunDelivery(pi as any, run);

  // Result card was sent.
  assert.ok(
    pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE),
    "expected a pi-workflows.result card",
  );
  // Conversation-resumption message fired with the default trigger.
  assert.equal(pi.userMessages.length, 1);
  assert.match(pi.userMessages[0]!.prompt, /finished with outcome/);
  // result.json was persisted (the on-disk crumb that was missing in
  // the original bug).
  assert.ok(existsSync(join(run.runDirAbs, "result.json")));
});

test("wireRunDelivery: finishCallback prompt becomes the user message", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "fc.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("resume here please"); return "ok";`,
    "utf8",
  );

  const pi = makeFakePi();
  const run = await startWorkflowRun(wf(wfPath, "fc"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await wireRunDelivery(pi as any, run);

  assert.equal(pi.userMessages.length, 1);
  assert.equal(pi.userMessages[0]!.prompt, "resume here please");
});

test("wireRunDelivery: failing workflow still triggers delivery (no unhandled rejection)", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "boom.workflow.js");
  writeFileSync(wfPath, `throw new Error("kaboom");`, "utf8");

  const pi = makeFakePi();
  const run = await startWorkflowRun(wf(wfPath, "boom"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });

  // run.promise rejects on workflow throw — wireRunDelivery is supposed
  // to suppress that. If the suppression breaks, this test surfaces it
  // as an unhandled rejection.
  const deliveryDone = wireRunDelivery(pi as any, run);
  const info = await run.terminated;
  assert.equal(info.outcome, "failed");
  await deliveryDone;

  // Card still went out, sendUserMessage still fires so the agent
  // resumes and can react to the failure.
  assert.ok(pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE));
  assert.equal(pi.userMessages.length, 1);
});
