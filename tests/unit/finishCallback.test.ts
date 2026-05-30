/**
 * tests/unit/finishCallback.test.ts — slice 10 finishCallback wiring.
 *
 * Slice 8a captured the prompt; slice 10 fires it. This test pins:
 *
 *   1. `Run.terminated` exposes the captured `finishCallbackPrompt`.
 *   2. `deliverRunResult` calls `pi.sendUserMessage(prompt)` AFTER the
 *      result card is sent (PRD §3.9 wants the card to land first so
 *      the user sees the workflow's outcome before the LLM continues).
 *   3. `ctx.log` may run inside the workflow up until main() resolves;
 *      after that the sandbox is disposed and `ctx.log` is no longer
 *      callable. The finishCallback prompt is captured once, at call
 *      time, and not invoked again.
 *
 * The integration-level happy path is in `tests/integration/
 * resultRendering.test.ts`; this file focuses on the contract knobs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkflowRun } from "../../src/runManager.ts";
import {
  deliverRunResult,
  RESULT_CUSTOM_TYPE,
} from "../../src/runtime/resultDelivery.ts";
import type { ApprovalDialog, WorkflowFile } from "../../src/types/internal.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

function makeTmp() {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-fc-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-fc-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-fc-home-"));
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

function wf(absPath: string, name = "fc"): WorkflowFile {
  return { name, absPath, scope: "personal" };
}

const okDialog: ApprovalDialog = async () => "run-once";

test("finishCallback: Run.terminated.finishCallbackPrompt mirrors ctx.finishCallback() arg", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "x.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("hello LLM"); return "ok";`,
    "utf8",
  );
  const run = await startWorkflowRun(wf(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;
  assert.equal(info.finishCallbackPrompt, "hello LLM");
});

test("finishCallback: empty/missing prompt → default trigger message sent", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "no-fc.workflow.js");
  writeFileSync(wfPath, `return "ok";`, "utf8");
  const run = await startWorkflowRun(wf(wfPath, "no-fc"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;
  assert.equal(info.finishCallbackPrompt, null);

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: info.workflowName,
    runId: info.runId,
    runDirAbs: info.runDirAbs,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    durationMs: info.durationMs,
    agentCount: info.agentCount,
    result: info.result,
    error: info.error,
    approval: info.approval,
    finishCallbackPrompt: info.finishCallbackPrompt,
  });
  // Card sent AND a default trigger message so the agent always resumes.
  assert.ok(pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE));
  assert.equal(pi.userMessages.length, 1);
  assert.match(pi.userMessages[0]!.prompt, /finished with outcome/);
});

test("finishCallback: ctx.finishCallback called twice — last value wins", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "twice.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("first"); ctx.finishCallback("second"); return "ok";`,
    "utf8",
  );
  const run = await startWorkflowRun(wf(wfPath, "twice"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;
  assert.equal(info.finishCallbackPrompt, "second");
});

test("finishCallback: persisted in result.json", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "persist.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("the prompt"); return "ok";`,
    "utf8",
  );
  const run = await startWorkflowRun(wf(wfPath, "persist"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: info.workflowName,
    runId: info.runId,
    runDirAbs: info.runDirAbs,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    durationMs: info.durationMs,
    agentCount: info.agentCount,
    result: info.result,
    error: info.error,
    approval: info.approval,
    finishCallbackPrompt: info.finishCallbackPrompt,
  });
  const persisted = JSON.parse(
    readFileSync(join(info.runDirAbs, "result.json"), "utf8"),
  );
  assert.equal(persisted.finishCallbackPrompt, "the prompt");
});

test("finishCallback: ordering — card delivered before pi.sendUserMessage", async () => {
  // Pure-orchestration assertion (faster than spinning a real run).
  const pi = makeFakePi();
  const order: string[] = [];
  const realSend = pi.sendMessage.bind(pi);
  const realUser = pi.sendUserMessage.bind(pi);
  pi.sendMessage = (...args) => {
    order.push("send");
    return realSend(...(args as Parameters<typeof realSend>));
  };
  pi.sendUserMessage = (p: string) => {
    order.push("user");
    return realUser(p);
  };
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-fc-only-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-x",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: null,
    finishCallbackPrompt: "go",
  });
  assert.deepEqual(order, ["send", "user"]);
});
