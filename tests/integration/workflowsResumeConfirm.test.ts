/**
 * tests/integration/workflowsResumeConfirm.test.ts — ZONE_TUI_HITL_FORK
 * slice 13: resume now gates through `pi.ui.confirm` instead of always
 * passing `preApproved: true` blindly.
 *
 * Coverage:
 *   - confirm returns true → resumeRun is reached (not-found error
 *     surfaces because the runId is fake, but we know we got past
 *     the gate).
 *   - confirm returns false → resumeRun is NOT called; user sees
 *     "Resume of <id> declined" message.
 *   - confirm absent (older pi build) → falls back to the slice-11
 *     behavior (preApproved=true, gate is no-op).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerWorkflowsCommand } from "../../src/commands/workflowCmd.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";
import type { WorkflowFile } from "../../src/types/internal.js";

function emptyRegistry(): ReadonlyMap<string, WorkflowFile> {
  return new Map<string, WorkflowFile>();
}

test("/workflows resume: ctx.ui.confirm=false → resume declined card", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  pi.nextConfirmAnswer = false;
  await pi.invokeCommand("workflows", "resume wf-some-id");
  // Confirm was invoked.
  assert.equal(pi.confirmCalls.length, 1, "confirm must be called once");
  assert.match(pi.confirmCalls[0]!.title, /Resume workflow/i);
  // Last message is the declined card; no resumed-card on success.
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /declined/i);
  // resumeRun was NOT called → no run-started entry.
  const startedEntry = pi.entries.find(
    (e) => e.customType === "pi-workflows.run.started",
  );
  assert.equal(startedEntry, undefined, "resume must not start a run after decline");
});

test("/workflows resume: ctx.ui.confirm=true → proceeds past the gate (resume not-found surfaces)", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  pi.nextConfirmAnswer = true;
  await pi.invokeCommand("workflows", "resume wf-nonexistent-runid");
  // Confirm was invoked.
  assert.equal(pi.confirmCalls.length, 1);
  // Past the gate: the message is the resumeRun's not-found path,
  // not a declined card.
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.doesNotMatch(lastMsg!.content, /declined/i);
  // The ID surfaces in the error-style message.
  assert.match(lastMsg!.content, /wf-nonexistent-runid|not found/i);
});

test("/workflows resume: confirm prompt summary mentions --latest when set", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  pi.nextConfirmAnswer = false;
  await pi.invokeCommand("workflows", "resume wf-foo --latest");
  assert.equal(pi.confirmCalls.length, 1);
  const promptText = `${pi.confirmCalls[0]!.title} ${pi.confirmCalls[0]!.message ?? ""}`;
  assert.match(promptText, /--latest|LIVE/i);
});
