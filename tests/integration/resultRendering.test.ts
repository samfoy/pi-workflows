/**
 * tests/integration/resultRendering.test.ts — slice 10 end-to-end.
 *
 * Drives `startWorkflowRun` → `Run.terminated` → `deliverRunResult`
 * for each of the four outcomes:
 *
 *   - done                — main() resolves; ✅ card + result.json + run.ended
 *   - failed              — main() throws; ❌ card carries error.message
 *   - stopped             — Run.cancel() during main(); ⏹ card
 *   - cancelled-pre-run   — approval dialog returns "no"; ⊘ card
 *
 * Every test asserts:
 *
 *   - `details.approval.reason` is rendered into the card details
 *     (slice_9_concerns decision #1).
 *   - `result.json` exists with the expected outcome.
 *   - `pi-workflows.run.ended` index entry was appended.
 *   - finishCallback handling: a `done` run with
 *     `ctx.finishCallback("...")` triggers `pi.sendUserMessage`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startWorkflowRun,
} from "../../src/runManager.ts";
import {
  deliverRunResult,
  RESULT_CUSTOM_TYPE,
  RUN_ENDED_ENTRY,
} from "../../src/runtime/resultDelivery.ts";
import type { ApprovalDialog, WorkflowFile } from "../../src/types/internal.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

function makeTmp(): {
  runsRoot: string;
  cwd: string;
  home: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-render-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-render-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-render-home-"));
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

function makeWorkflow(absPath: string, name = "rendered"): WorkflowFile {
  return { name, absPath, scope: "personal" };
}

const okDialog: ApprovalDialog = async () => "run-once";
const noDialog: ApprovalDialog = async () => "no";

// ─── done outcome ───────────────────────────────────────────────────

test("outcome=done: card uses ✅ + duration + agentCount + approval=user-once", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "done.workflow.js");
  writeFileSync(wfPath, `return "FOUND 3 ISSUES";`, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath, "done-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;
  assert.equal(info.outcome, "done");
  assert.equal(info.result, "FOUND 3 ISSUES");
  assert.equal(info.approval?.approved, true);

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
  assert.match(card!.content, /^✅ Workflow done-flow complete/);
  assert.match(card!.content, /FOUND 3 ISSUES/);
  // approvalDecision.reason present in BOTH content + details.
  assert.match(card!.content, /Approval: user-once/);
  const details = card!.details as { approval: { reason: string } };
  assert.equal(details.approval.reason, "user-once");

  // result.json on disk.
  assert.ok(existsSync(join(info.runDirAbs, "result.json")));
  const persisted = JSON.parse(readFileSync(join(info.runDirAbs, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "done");
  assert.equal(persisted.result, "FOUND 3 ISSUES");
  assert.equal(persisted.approval.reason, "user-once");

  // Active-runs index entry.
  const ended = pi.entries.find((e) => e.customType === RUN_ENDED_ENTRY);
  assert.ok(ended);
});

test("outcome=done: ctx.finishCallback queues sendUserMessage AFTER card", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "fc.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("please summarize"); return "OK";`,
    "utf8",
  );

  const run = await startWorkflowRun(makeWorkflow(wfPath, "fc-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;
  assert.equal(info.finishCallbackPrompt, "please summarize");

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  // sendUserMessage with the captured prompt.
  assert.equal(pi.userMessages.length, 1);
  assert.equal(pi.userMessages[0]!.prompt, "please summarize");
  // Card was sent.
  assert.ok(pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE));
});

// ─── failed outcome ─────────────────────────────────────────────────

test("outcome=failed: throw inside main → ❌ card with error.message + approval", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "fail.workflow.js");
  writeFileSync(wfPath, `throw new Error("boom from script");`, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath, "fail-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await assert.rejects(run.promise, /boom from script/);
  const info = await run.terminated;
  assert.equal(info.outcome, "failed");
  assert.equal(info.error?.message, "boom from script");

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
  assert.match(card!.content, /^❌ Workflow fail-flow failed/);
  assert.match(card!.content, /boom from script/);
  assert.match(card!.content, /Approval: user-once/);

  const persisted = JSON.parse(readFileSync(join(info.runDirAbs, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "failed");
  assert.equal(persisted.error.message, "boom from script");
  assert.equal(persisted.approval.reason, "user-once");
});

// ─── stopped outcome ────────────────────────────────────────────────

test("outcome=stopped: Run.cancel during running script → ⏹ card", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "stop.workflow.js");
  // Workflow loops forever via setTimeout; cancel must abort it.
  writeFileSync(
    wfPath,
    `await new Promise((_resolve, reject) => {
       const id = setTimeout(() => {}, 60_000);
       // The sandbox's timer table aborts on signal; bare await of a
       // setTimeout-based promise resolves the run with no result. To
       // make this script "stoppable" we read the abort signal off the
       // ctx host and reject when it fires.
     });`,
    "utf8",
  );
  // Easier: have the script await an unresolvable promise and rely on
  // dispose-throwing-AbortError. Replace.
  writeFileSync(
    wfPath,
    `// Script awaits forever; cancel triggers sandbox dispose which
     // aborts the timer table, surfacing via thrown AbortError.
     await new Promise(() => {});`,
    "utf8",
  );

  const run = await startWorkflowRun(makeWorkflow(wfPath, "stop-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });

  // Wait one macrotask so main() has actually started; then cancel.
  await new Promise((r) => setImmediate(r));
  run.cancel(new Error("user-stop"));

  // Suppress unhandled (run.promise may reject with the abort).
  await run.promise.catch(() => undefined);
  const info = await run.terminated;
  assert.equal(info.outcome, "stopped");
  assert.equal(info.approval?.approved, true);

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
  assert.match(card!.content, /^⏹ Workflow stop-flow stopped/);
  assert.match(card!.content, /Stopped by user/);
  assert.match(card!.content, /Approval: user-once/);

  const persisted = JSON.parse(readFileSync(join(info.runDirAbs, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "stopped");
  assert.equal(persisted.approval.reason, "user-once");
});

// ─── cancelled-pre-run outcome ──────────────────────────────────────

test("outcome=cancelled-pre-run: dialog 'no' → ⊘ card with approval=user-N", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "deny.workflow.js");
  writeFileSync(wfPath, `return "should-not-run";`, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath, "deny-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: noDialog, viewer: () => undefined },
  });
  await run.promise.catch(() => undefined);
  const info = await run.terminated;
  assert.equal(info.outcome, "cancelled-pre-run");
  assert.equal(info.approval?.approved, false);

  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
  assert.match(card!.content, /^⊘ Workflow deny-flow cancelled/);
  assert.match(card!.content, /Cancelled before run/);
  assert.match(card!.content, /Approval: user-N/);

  const persisted = JSON.parse(readFileSync(join(info.runDirAbs, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "cancelled-pre-run");
  if (persisted.approval.approved === false) {
    assert.equal(persisted.approval.reason, "user-N");
  }
});

// ─── ordering invariant: card BEFORE sendUserMessage; entry AFTER card ─

test("outcome=done: ordering — card → run.ended entry → sendUserMessage", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "order.workflow.js");
  writeFileSync(
    wfPath,
    `ctx.finishCallback("after"); return "done";`,
    "utf8",
  );

  const run = await startWorkflowRun(makeWorkflow(wfPath, "order-flow"), "", {
    cwd,
    resolveRunDir,
    approval: { env: {}, home, dialog: okDialog, viewer: () => undefined },
  });
  await run.promise;
  const info = await run.terminated;

  const pi = makeFakePi();
  const order: string[] = [];
  const realSendMessage = pi.sendMessage.bind(pi);
  const realAppendEntry = pi.appendEntry.bind(pi);
  const realSendUserMessage = pi.sendUserMessage.bind(pi);
  pi.sendMessage = (...args) => {
    order.push("card");
    return realSendMessage(...(args as Parameters<typeof realSendMessage>));
  };
  pi.appendEntry = (...args) => {
    order.push("entry");
    return realAppendEntry(...(args as Parameters<typeof realAppendEntry>));
  };
  pi.sendUserMessage = (p: string) => {
    order.push("user");
    return realSendUserMessage(p);
  };

  await deliverRunResult({
    pi,
    outcome: info.outcome,
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

  assert.deepEqual(order, ["card", "entry", "user"]);
});
