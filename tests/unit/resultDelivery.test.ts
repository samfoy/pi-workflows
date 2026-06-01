/**
 * tests/unit/resultDelivery.test.ts — slice 10 result-card builder
 * + writeResultFile + deliverRunResult.
 *
 * Pure unit tests against `buildResultCard` + `writeResultFile` +
 * `deliverRunResult`. Each of the four outcomes (done/failed/stopped/
 * cancelled-pre-run) has its own card test asserting:
 *
 *   - The icon and header line shape.
 *   - That `details.approval.reason` is rendered into both the card
 *     body and the structured `details` (PRD §3.8 + slice_9_concerns
 *     decision #1).
 *   - The customType is the slice-10 stable identifier.
 *
 * Cross-cutting assertions:
 *
 *   - String result rendered verbatim, ≤400 chars.
 *   - Non-string result JSON-stringified for preview.
 *   - Long result truncated with the ellipsis marker; `truncated:true`
 *     mirrored into details.
 *   - `error.message` truncated to ≤400 chars in failed cards.
 *   - `formatDuration` matches PRD §3.8 sample shape (`4m 12s`).
 *   - `writeResultFile` round-trips JSON via tmp+rename.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RESULT_CUSTOM_TYPE,
  RUN_ENDED_ENTRY,
  buildResultCard,
  deliverRunResult,
  formatDuration,
  stringifyResultPreview,
  writeResultFile,
} from "../../src/runtime/resultDelivery.ts";
import type {
  ApprovalDecision,
  RunResultFile,
} from "../../src/types/internal.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────

const APPROVED_USER_ONCE: ApprovalDecision = {
  approved: true,
  reason: "user-once",
  persisted: false,
};

const APPROVED_TRUSTED: ApprovalDecision = {
  approved: true,
  reason: "trusted",
  persisted: false,
};

const APPROVED_BYPASS: ApprovalDecision = {
  approved: true,
  reason: "bypass-permissions",
  banner: "[bypass-permissions: parent inherited]",
  persisted: false,
};

const DENIED_USER_N: ApprovalDecision = {
  approved: false,
  reason: "user-N",
  cancelCause: "user-N",
};

// ─── formatDuration ────────────────────────────────────────────────────

test("formatDuration: <1s for sub-second", () => {
  assert.equal(formatDuration(0), "<1s");
  assert.equal(formatDuration(999), "<1s");
});

test("formatDuration: bare seconds for 1s..59s", () => {
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(45_000), "45s");
});

test("formatDuration: m + s for >=60s (matches PRD §3.8 sample)", () => {
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(252_000), "4m 12s"); // PRD §3.8 sample
});

test("formatDuration: defensive against negatives + NaN", () => {
  assert.equal(formatDuration(-100), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
});

// ─── stringifyResultPreview ────────────────────────────────────────────

test("stringifyResultPreview: undefined → empty preview", () => {
  const p = stringifyResultPreview(undefined);
  assert.equal(p.preview, "");
  assert.equal(p.isTruncated, false);
});

test("stringifyResultPreview: string passes verbatim", () => {
  const p = stringifyResultPreview("hello world");
  assert.equal(p.preview, "hello world");
  assert.equal(p.isTruncated, false);
});

test("stringifyResultPreview: object → JSON pretty-printed", () => {
  const p = stringifyResultPreview({ k: 1 });
  assert.match(p.preview, /"k": 1/);
  assert.equal(p.isTruncated, false);
});

test("stringifyResultPreview: long string truncated to 400 chars + ellipsis", () => {
  const big = "x".repeat(800);
  const p = stringifyResultPreview(big);
  assert.equal(p.isTruncated, true);
  assert.ok(p.preview.length <= 420); // 400 + ellipsis tail
  assert.match(p.preview, /…\(truncated\)$/);
});

// ─── buildResultCard — done ────────────────────────────────────────────

test("buildResultCard done: emits ✅ + duration + agent count + result preview", () => {
  const card = buildResultCard({
    outcome: "done",
    workflowName: "audit",
    runId: "wf-001",
    runDirAbs: "/tmp/runs/wf-001",
    durationMs: 252_000,
    agentCount: 23,
    result: "FOUND 3 ISSUES",
    error: null,
    approval: APPROVED_USER_ONCE,
  });
  assert.equal(card.customType, RESULT_CUSTOM_TYPE);
  assert.match(card.content, /^✅ Workflow audit complete \(4m 12s, 23 agents\)/);
  assert.match(card.content, /Result preview:/);
  assert.match(card.content, /FOUND 3 ISSUES/);
  assert.match(card.content, /Full result: \/tmp\/runs\/wf-001\/result\.json/);
  assert.match(card.content, /Re-open: \/workflows show wf-001/);
  // approvalDecision.reason rendered in BOTH body and details.
  assert.match(card.content, /Approval: user-once/);
  assert.equal(card.details.approval?.approved, true);
  if (card.details.approval?.approved === true) {
    assert.equal(card.details.approval.reason, "user-once");
  }
});

test("buildResultCard done: singular agent count (1 agent, no plural)", () => {
  const card = buildResultCard({
    outcome: "done",
    workflowName: "x",
    runId: "wf-2",
    runDirAbs: "/tmp/r",
    durationMs: 5000,
    agentCount: 1,
    result: "ok",
    error: null,
    approval: APPROVED_TRUSTED,
  });
  assert.match(card.content, /1 agent\)/); // not "agents"
  assert.match(card.content, /Approval: trusted/);
});

test("buildResultCard done: object result rendered as JSON in body", () => {
  const card = buildResultCard({
    outcome: "done",
    workflowName: "x",
    runId: "wf-3",
    runDirAbs: "/tmp/r",
    durationMs: 1000,
    agentCount: 0,
    result: { issues: 3, severity: "high" },
    error: null,
    approval: APPROVED_USER_ONCE,
  });
  assert.match(card.content, /"issues": 3/);
  assert.match(card.content, /"severity": "high"/);
});

test("buildResultCard done: long result truncated; details.truncated=true", () => {
  const big = "x".repeat(800);
  const card = buildResultCard({
    outcome: "done",
    workflowName: "x",
    runId: "wf-4",
    runDirAbs: "/tmp/r",
    durationMs: 1000,
    agentCount: 0,
    result: big,
    error: null,
    approval: APPROVED_USER_ONCE,
  });
  assert.equal(card.details.truncated, true);
  assert.match(card.content, /…\(truncated\)/);
});

test("buildResultCard done: empty undefined result renders '(empty)'", () => {
  const card = buildResultCard({
    outcome: "done",
    workflowName: "x",
    runId: "wf-5",
    runDirAbs: "/tmp/r",
    durationMs: 1000,
    agentCount: 0,
    result: undefined,
    error: null,
    approval: APPROVED_USER_ONCE,
  });
  assert.match(card.content, /Result: \(empty\)/);
});

// ─── buildResultCard — failed ──────────────────────────────────────────

test("buildResultCard failed: emits ❌ + error.name + message + run dir + re-run", () => {
  const card = buildResultCard({
    outcome: "failed",
    workflowName: "audit",
    runId: "wf-6",
    runDirAbs: "/tmp/r6",
    durationMs: 1234,
    agentCount: 5,
    result: undefined,
    error: { name: "TypeError", message: "x is not defined" },
    approval: APPROVED_USER_ONCE,
  });
  assert.match(card.content, /^❌ Workflow audit failed/);
  assert.match(card.content, /TypeError: x is not defined/);
  assert.match(card.content, /Run dir: \/tmp\/r6/);
  assert.match(card.content, /Re-run: \/audit/);
  // approvalDecision.reason rendered.
  assert.match(card.content, /Approval: user-once/);
  assert.equal(card.details.error?.name, "TypeError");
});

test("buildResultCard failed: long error.message truncated to 400 chars + ellipsis", () => {
  const big = "boom ".repeat(200); // 1000 chars
  const card = buildResultCard({
    outcome: "failed",
    workflowName: "x",
    runId: "wf-7",
    runDirAbs: "/tmp",
    durationMs: 1,
    agentCount: 0,
    result: undefined,
    error: { name: "Error", message: big },
    approval: APPROVED_USER_ONCE,
  });
  assert.equal(card.details.truncated, true);
  assert.match(card.content, /…\(truncated\)/);
});

test("buildResultCard failed: missing error field → defaults", () => {
  const card = buildResultCard({
    outcome: "failed",
    workflowName: "x",
    runId: "wf-8",
    runDirAbs: "/tmp",
    durationMs: 1,
    agentCount: 0,
    result: undefined,
    error: null,
    approval: APPROVED_USER_ONCE,
  });
  assert.match(card.content, /Error: \(no error captured\)/);
});

// ─── buildResultCard — stopped ─────────────────────────────────────────

test("buildResultCard stopped: emits ⏹ + partial-results blurb + approval", () => {
  const card = buildResultCard({
    outcome: "stopped",
    workflowName: "scan",
    runId: "wf-9",
    runDirAbs: "/tmp/r9",
    durationMs: 30_000,
    agentCount: 7,
    result: undefined,
    error: null,
    approval: APPROVED_BYPASS,
  });
  assert.match(card.content, /^⏹ Workflow scan stopped/);
  assert.match(card.content, /Stopped by user\. Partial results in:/);
  assert.match(card.content, /\/tmp\/r9/);
  assert.match(card.content, /Re-run: \/scan/);
  assert.match(card.content, /Approval: bypass-permissions/);
});

// ─── buildResultCard — cancelled-pre-run ───────────────────────────────

test("buildResultCard cancelled-pre-run: emits ⊘ + denial reason from approval", () => {
  const card = buildResultCard({
    outcome: "cancelled-pre-run",
    workflowName: "danger",
    runId: "wf-10",
    runDirAbs: "/tmp/r10",
    durationMs: 0,
    agentCount: 0,
    result: undefined,
    error: null,
    approval: DENIED_USER_N,
  });
  assert.match(card.content, /^⊘ Workflow danger cancelled/);
  assert.match(card.content, /Cancelled before run: user denied at approval prompt/);
  assert.match(card.content, /Approval: user-N/);
  assert.equal(card.details.approval?.approved, false);
});

test("buildResultCard cancelled-pre-run: explicit error.message overrides default reason text", () => {
  const card = buildResultCard({
    outcome: "cancelled-pre-run",
    workflowName: "x",
    runId: "wf-11",
    runDirAbs: "/tmp/r11",
    durationMs: 0,
    agentCount: 0,
    result: undefined,
    error: { name: "RunCancelledError", message: "workflow not yet trusted" },
    approval: DENIED_USER_N,
  });
  assert.match(card.content, /Cancelled before run: workflow not yet trusted/);
});

// ─── writeResultFile ───────────────────────────────────────────────────

test("writeResultFile: tmp+rename, parses back as the persisted shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-result-"));
  const payload: RunResultFile = {
    runId: "wf-x",
    workflowName: "audit",
    outcome: "done",
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:04:12.000Z",
    durationMs: 252_000,
    result: "ok",
    error: null,
    approval: APPROVED_USER_ONCE,
    agentCount: 5,
    finishCallbackPrompt: null,
  };
  await writeResultFile(dir, payload);
  const target = join(dir, "result.json");
  assert.ok(existsSync(target));
  const back = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(back.runId, "wf-x");
  assert.equal(back.outcome, "done");
  assert.equal(back.durationMs, 252_000);
  // Tmp file is removed (rename).
  assert.equal(
    existsSync(join(dir, "result.json.tmp")),
    false,
    "tmp file must be renamed away",
  );
});

test("writeResultFile: overwrites prior content (idempotent)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-result-"));
  const base: RunResultFile = {
    runId: "wf-x",
    workflowName: "audit",
    outcome: "done",
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    result: "first",
    error: null,
    approval: null,
    agentCount: 0,
    finishCallbackPrompt: null,
  };
  await writeResultFile(dir, base);
  await writeResultFile(dir, { ...base, result: "second", durationMs: 2000 });
  const back = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(back.result, "second");
  assert.equal(back.durationMs, 2000);
});

// ─── deliverRunResult — orchestration ──────────────────────────────────

test("deliverRunResult: writes result.json, sends card, appends run.ended entry", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "audit",
    runId: "wf-d1",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:05.000Z",
    durationMs: 5000,
    agentCount: 3,
    result: "OK",
    error: null,
    approval: APPROVED_USER_ONCE,
    finishCallbackPrompt: null,
  });
  // result.json on disk.
  assert.ok(existsSync(join(dir, "result.json")));
  const persisted = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "done");
  assert.equal(persisted.result, "OK");
  // Card sent.
  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card, "result card must have been sent");
  assert.match(card!.content, /^✅ Workflow audit complete/);
  // appendEntry call.
  const ended = pi.entries.find((e) => e.customType === RUN_ENDED_ENTRY);
  assert.ok(ended, "run.ended index entry must be appended");
  assert.equal((ended!.data as { runId: string }).runId, "wf-d1");
});

test("deliverRunResult: finishCallbackPrompt → pi.sendUserMessage AFTER card", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-fc-"));
  // Make sendUserMessage observably ordered — we capture insertion
  // order across messages + userMessages by intercepting.
  const order: string[] = [];
  const realSendMessage = pi.sendMessage.bind(pi);
  const realSendUserMessage = pi.sendUserMessage.bind(pi);
  pi.sendMessage = (...args) => {
    order.push("card");
    return realSendMessage(...(args as Parameters<typeof realSendMessage>));
  };
  pi.sendUserMessage = (prompt: string) => {
    order.push("user");
    return realSendUserMessage(prompt);
  };

  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-fc",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_TRUSTED,
    finishCallbackPrompt: "summarize the audit",
  });
  assert.equal(pi.userMessages.length, 1);
  assert.equal(pi.userMessages[0]!.prompt, "summarize the audit");
  // Card emitted before sendUserMessage (PRD §3.9).
  assert.deepEqual(order, ["card", "user"]);
});

test("deliverRunResult: no finishCallback → default trigger message sent", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-nofc-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-nofc",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_USER_ONCE,
    finishCallbackPrompt: null,
  });
  // No finishCallback → always inject a default trigger so the agent resumes.
  assert.equal(pi.userMessages.length, 1);
  assert.match(pi.userMessages[0]!.prompt, /finished with outcome/);
});

// Regression: when the conductor is mid-stream (the common case — a
// workflow run is invoked as a tool call), `pi.sendUserMessage(prompt)`
// without `deliverAs` THROWS. The previous code swallowed that error
// silently, dropping the completion notification entirely. Result:
// conductor never knew the workflow finished. Fix: always pass
// `deliverAs: "followUp"` so the message queues until the agent goes
// idle, then triggers a turn.
test("deliverRunResult: sendUserMessage receives deliverAs:'followUp'", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-deliverAs-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-deliverAs",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_USER_ONCE,
    finishCallbackPrompt: null,
  });
  assert.equal(pi.userMessages.length, 1);
  assert.deepEqual(pi.userMessages[0]!.options, { deliverAs: "followUp" });
});

// Regression: if a (very old) pi build rejects the second `options`
// arg, fall back to the no-options form so the notification still
// fires. We simulate this by making the first call throw and the
// second succeed.
test("deliverRunResult: falls back to no-options sendUserMessage when first call throws", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-fallback-"));
  const calls: Array<{ prompt: string; options: unknown }> = [];
  pi.sendUserMessage = ((prompt: string, options?: unknown) => {
    calls.push({ prompt, options });
    if (calls.length === 1) {
      throw new Error("old pi build: options arg not accepted");
    }
    // 2nd call: succeed silently.
  }) as typeof pi.sendUserMessage;
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-fallback",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_USER_ONCE,
    finishCallbackPrompt: null,
  });
  assert.equal(calls.length, 2, "first call throws, second is the fallback");
  assert.deepEqual(calls[0]!.options, { deliverAs: "followUp" });
  assert.equal(calls[1]!.options, undefined);
});

test("deliverRunResult: persisted result is JSON-stringified for non-string values", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-obj-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-obj",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: { issues: 3 },
    error: null,
    approval: APPROVED_TRUSTED,
    finishCallbackPrompt: null,
  });
  const persisted = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  // The persisted `result` is a JSON-string of the original value.
  assert.equal(typeof persisted.result, "string");
  assert.deepEqual(JSON.parse(persisted.result), { issues: 3 });
});

test("deliverRunResult: failed outcome persists null result + error block", async () => {
  const pi = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-deliver-fail-"));
  await deliverRunResult({
    pi,
    outcome: "failed",
    workflowName: "x",
    runId: "wf-fail",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:02.000Z",
    durationMs: 2000,
    agentCount: 0,
    result: undefined,
    error: { name: "TypeError", message: "x is not defined" },
    approval: APPROVED_USER_ONCE,
    finishCallbackPrompt: null,
  });
  const persisted = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(persisted.outcome, "failed");
  assert.equal(persisted.result, null);
  assert.equal(persisted.error.name, "TypeError");
});

test("deliverRunResult: result.json write failure does NOT prevent card delivery", async () => {
  const pi = makeFakePi();
  await deliverRunResult({
    pi,
    outcome: "done",
    writeFile: async () => {
      throw new Error("disk full");
    },
    workflowName: "x",
    runId: "wf-wf",
    runDirAbs: "/non/existent/dir",
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_TRUSTED,
    finishCallbackPrompt: null,
  });
  // Card still sent despite the writer throwing.
  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
});

test("deliverRunResult: appendEntry-less pi build is OK (no throw)", async () => {
  const pi = makeFakePi();
  // Simulate pi-coding-agent without appendEntry.
  (pi as { appendEntry?: unknown }).appendEntry = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-noae-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-noae",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_TRUSTED,
    finishCallbackPrompt: null,
  });
  // No crash. Card still delivered.
  const card = pi.messages.find((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.ok(card);
  assert.equal(pi.entries.length, 0);
});

test("deliverRunResult: sendUserMessage-less pi build → fallback card with triggerTurn", async () => {
  const pi = makeFakePi();
  // Simulate pi build without sendUserMessage.
  (pi as { sendUserMessage?: unknown }).sendUserMessage = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pi-wf-noUserMsg-"));
  await deliverRunResult({
    pi,
    outcome: "done",
    workflowName: "x",
    runId: "wf-nouser",
    runDirAbs: dir,
    startedAt: "2026-05-29T00:00:00.000Z",
    endedAt: "2026-05-29T00:00:01.000Z",
    durationMs: 1000,
    agentCount: 0,
    result: "ok",
    error: null,
    approval: APPROVED_TRUSTED,
    finishCallbackPrompt: "follow up please",
  });
  // The first card is the result; the second is the fallback trigger card.
  const cards = pi.messages.filter((m) => m.customType === RESULT_CUSTOM_TYPE);
  assert.equal(cards.length, 2);
  // Fallback card carries the finishCallback prompt directly (no wrapper text).
  assert.match(cards[1]!.content, /follow up please/);
});
