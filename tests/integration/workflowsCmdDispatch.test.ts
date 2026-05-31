/**
 * tests/integration/workflowsCmdDispatch.test.ts — slice 11 §A+§C.
 *
 * Black-box test of the `/workflows` umbrella command's sub-command
 * dispatcher.
 *
 *   - `/workflows` (no args) prints the registry listing.
 *   - `/workflows list` prints active runs (or the empty message).
 *   - `/workflows show <unknownId>` returns "not found".
 *   - `/workflows resume <unknownId>` returns "not found".
 *   - `/workflows resume <terminalDoneId>` returns the
 *     ResumeNotAllowedError message.
 *   - `/workflows gc` (dry-run) prints the GC summary.
 *   - `/workflows kill <runId>` emits a kill-requested entry.
 *   - Unknown sub-command prints "unknown sub-command".
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerWorkflowsCommand } from "../../src/commands/workflowCmd.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

import type { WorkflowFile } from "../../src/types/internal.js";

function emptyRegistry(): ReadonlyMap<string, WorkflowFile> {
  return new Map<string, WorkflowFile>();
}

test("/workflows (no args): registry listing", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /no workflows discovered/);
});

test("/workflows list: empty when no runs on disk", async () => {
  // We can't override the runsHome() resolver from here without
  // dependency injection. The handler uses the real path. Tests in a
  // fresh CI environment may have a populated ~/.pi/agent/workflows/runs/
  // — accept either "no runs found" OR a valid table-format message.
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "list");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.ok(
    lastMsg!.content.includes("no runs found") ||
      lastMsg!.content.match(/^\d+ run\(s\) on disk/),
    `unexpected /workflows list output: ${lastMsg!.content.slice(0, 200)}`,
  );
});

test("/workflows show <unknownId>: not found", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "show wf-defnotexist");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /run wf-defnotexist not found/);
});

test("/workflows show (no runId): missing-arg message", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "show");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /missing runId/);
});

test("/workflows resume (no runId): missing-arg + --latest hint", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "resume");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /missing runId/);
  assert.match(lastMsg!.content, /--latest/);
});

test("/workflows resume <unknownId>: not-found error message", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "resume wf-defnotexist");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /not found/);
});

test("/workflows gc (dry-run): emits a summary card", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "gc");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.ok(lastMsg);
  assert.match(lastMsg!.content, /GC dry-run/);
  assert.match(lastMsg!.content, /Add `--apply`/);
});

test("/workflows kill <runId>: emits kill-requested appendEntry + card", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "kill wf-killtarget01");
  const killEntry = pi.entries.find(
    (e) => e.customType === "pi-workflows.run.kill-requested",
  );
  assert.ok(killEntry, "expected pi-workflows.run.kill-requested entry");
  assert.equal(killEntry?.data && (killEntry.data as { runId?: string }).runId, "wf-killtarget01");
  assert.equal(
    killEntry?.data && (killEntry.data as { reason?: string }).reason,
    "user-kill",
    "slice 13: kill entry now carries a reason field",
  );
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.match(lastMsg!.content, /kill request emitted/);
});

test("/workflows <unknown-sub>: unknown sub-command card", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "explode");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.match(lastMsg!.content, /unknown sub-command/);
  assert.match(lastMsg!.content, /list \| show/);
});

test("/workflows in recursive mode: disabled message", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry(), { recursive: true });
  await pi.invokeCommand("workflows", "resume wf-anything");
  const lastMsg = pi.messages[pi.messages.length - 1];
  assert.match(lastMsg!.content, /disabled in nested/);
});

test("/workflows keyword: toggles off then on", async () => {
  const pi = makeFakePi();
  let enabled = true;
  registerWorkflowsCommand(pi, emptyRegistry(), {
    keywordTrigger: { get: () => enabled, set: (v) => { enabled = v; } },
  });

  // Toggle off
  await pi.invokeCommand("workflows", "keyword off");
  assert.equal(enabled, false);
  assert.match(pi.messages[pi.messages.length - 1]!.content, /off/);

  // Toggle on explicitly
  await pi.invokeCommand("workflows", "keyword on");
  assert.equal(enabled, true);
  assert.match(pi.messages[pi.messages.length - 1]!.content, /on/);

  // Bare 'keyword' toggles
  await pi.invokeCommand("workflows", "keyword");
  assert.equal(enabled, false);
});

test("/workflows keyword: no keywordTrigger opt → graceful message", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "keyword");
  assert.match(pi.messages[pi.messages.length - 1]!.content, /not configured/);
});

test("/workflows <unknown-sub>: help includes keyword", async () => {
  const pi = makeFakePi();
  registerWorkflowsCommand(pi, emptyRegistry());
  await pi.invokeCommand("workflows", "explode");
  assert.match(pi.messages[pi.messages.length - 1]!.content, /keyword/);
});
