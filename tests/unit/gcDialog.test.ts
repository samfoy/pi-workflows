/**
 * tests/unit/gcDialog.test.ts
 *
 * Unit tests for slice-15 GC dialog: render, loadGcCandidates (F4),
 * and applyGc logic.
 *
 * F4: runs with `restartedFrom` pointing at an active run are excluded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderGcDialog, loadGcCandidates, applyGc, type GcDialogState } from "../../src/runtime/gcDialog.js";

// ─── renderGcDialog ────────────────────────────────────────────────

test("render: no-candidates shows empty message", () => {
  const state: GcDialogState = {
    candidates: [],
    skippedCount: 3,
    totalScanned: 3,
    cutoffDays: 30,
    confirming: false,
  };
  const { lines } = renderGcDialog(state);
  const text = lines.join("\n");
  assert.ok(text.includes("no eligible runs"), `expected no-eligible message: ${text}`);
  assert.ok(text.includes("[Esc]"), "expected close key");
});

test("render: candidates shows count and state breakdown", () => {
  const state: GcDialogState = {
    candidates: [
      { runId: "wf-a", runDir: "/runs/wf-a", outcome: "done", endedAt: "2026-01-01T00:00:00.000Z", ageDays: 35, reason: "older-than-cutoff" },
      { runId: "wf-b", runDir: "/runs/wf-b", outcome: "failed", endedAt: "2026-01-02T00:00:00.000Z", ageDays: 34, reason: "older-than-cutoff" },
    ],
    skippedCount: 1,
    totalScanned: 3,
    cutoffDays: 30,
    confirming: false,
  };
  const { lines } = renderGcDialog(state);
  const text = lines.join("\n");
  assert.ok(text.includes("2 eligible"), `expected candidate count: ${text}`);
  assert.ok(text.includes("done: 1"), `expected done breakdown: ${text}`);
  assert.ok(text.includes("failed: 1"), `expected failed breakdown: ${text}`);
  assert.ok(text.includes("[Enter]"), "expected Enter key");
});

test("render: confirming=true shows apply/cancel", () => {
  const state: GcDialogState = {
    candidates: [
      { runId: "wf-a", runDir: "/runs/wf-a", outcome: "done", endedAt: "2026-01-01T00:00:00.000Z", ageDays: 35, reason: "older-than-cutoff" },
    ],
    skippedCount: 0,
    totalScanned: 1,
    cutoffDays: 30,
    confirming: true,
  };
  const { lines } = renderGcDialog(state);
  const text = lines.join("\n");
  assert.ok(text.includes("cannot be undone"), "expected warning");
  assert.ok(text.includes("[y / Enter]") || text.includes("apply"), "expected apply option");
  assert.ok(text.includes("cancel"), "expected cancel option");
});

test("render: done state shows deleted count", () => {
  const state: GcDialogState = {
    candidates: [],
    skippedCount: 0,
    totalScanned: 2,
    cutoffDays: 30,
    confirming: false,
    done: { deleted: 2, errors: 0 },
  };
  const { lines } = renderGcDialog(state);
  const text = lines.join("\n");
  assert.ok(text.includes("Deleted: 2"), `expected deleted count: ${text}`);
});

test("render: done state shows error count when nonzero", () => {
  const state: GcDialogState = {
    candidates: [],
    skippedCount: 0,
    totalScanned: 2,
    cutoffDays: 30,
    confirming: false,
    done: { deleted: 1, errors: 1 },
  };
  const { lines } = renderGcDialog(state);
  const text = lines.join("\n");
  assert.ok(text.includes("Errors:  1"), `expected error count: ${text}`);
});

// ─── loadGcCandidates F4: skip runs with active restartedFrom ───────

function makeRunDir(
  root: string,
  runId: string,
  opts: {
    terminalState?: string;
    endedAt?: string;
    ageDays?: number;
    restartedFrom?: string;
  } = {},
): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });

  const ageDays = opts.ageDays ?? 35;
  const state = opts.terminalState ?? "done";
  const endedAt = opts.endedAt ?? new Date(Date.now() - ageDays * 86_400_000).toISOString();

  // Write result.json
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ outcome: state, endedAt }),
  );

  // Write manifest.json
  const manifest: Record<string, unknown> = {
    runId,
    workflowName: "test-wf",
    workflowAbsPath: "/tmp/test.js",
    workflowSourceSha256: "abc123",
    input: "",
    startedAt: new Date(Date.now() - (ageDays + 1) * 86_400_000).toISOString(),
    cwd: "/tmp",
    piVersion: "0.0.0",
    piWorkflowsVersion: "0.1.0",
    options: { mockAgents: false, maxConcurrent: 16 },
    trustedAtStart: true,
    parentPid: 1,
    parentStartTime: "0",
    parentBootId: "",
  };
  if (opts.restartedFrom !== undefined) {
    manifest.restartedFrom = opts.restartedFrom;
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));

  // Write a minimal ledger with terminal state.
  // Must include the full legal transition chain so replayState()  
  // reaches the terminal state (pending→approved→running→<state>).
  const ledgerLines = [
    JSON.stringify({ type: "transition", at: manifest.startedAt, from: "pending", to: "approved" }),
    JSON.stringify({ type: "transition", at: manifest.startedAt, from: "approved", to: "running" }),
    JSON.stringify({ type: "transition", at: endedAt, from: "running", to: state }),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "ledger.jsonl"), ledgerLines);

  return dir;
}

test("F4: candidate with restartedFrom pointing to active run is excluded", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-f4-"));
  const ACTIVE_RUN = "wf-activerun0001";
  const CANDIDATE = "wf-restarted001";

  makeRunDir(root, CANDIDATE, {
    ageDays: 35,
    restartedFrom: ACTIVE_RUN,
  });

  const result = await loadGcCandidates({
    runsRootOverride: root,
    cutoffDays: 30,
    activeRunIds: new Set([ACTIVE_RUN]),
  });

  assert.equal(
    result.candidates.find((c) => c.runId === CANDIDATE),
    undefined,
    "candidate with active restartedFrom should be excluded",
  );
});

test("F4: candidate with restartedFrom pointing to NON-active run is included", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-f4-nonactive-"));
  const INACTIVE_RUN = "wf-inactiverun001";
  const CANDIDATE = "wf-restarted002";

  makeRunDir(root, CANDIDATE, {
    ageDays: 35,
    restartedFrom: INACTIVE_RUN,
  });

  const result = await loadGcCandidates({
    runsRootOverride: root,
    cutoffDays: 30,
    activeRunIds: new Set(["wf-otherrun0001"]), // INACTIVE_RUN is NOT active
  });

  assert.ok(
    result.candidates.some((c) => c.runId === CANDIDATE),
    "candidate with non-active restartedFrom should be included",
  );
});

test("F4: candidate without restartedFrom is always included", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-f4-norestart-"));
  const CANDIDATE = "wf-norestart001";

  makeRunDir(root, CANDIDATE, { ageDays: 35 });

  const result = await loadGcCandidates({
    runsRootOverride: root,
    cutoffDays: 30,
    activeRunIds: new Set(["wf-someactive001"]),
  });

  assert.ok(
    result.candidates.some((c) => c.runId === CANDIDATE),
    "candidate without restartedFrom should be included",
  );
});

test("F4: disabled GC (cutoffDays=0) returns no candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-disabled-"));
  makeRunDir(root, "wf-old0000001", { ageDays: 100 });

  const result = await loadGcCandidates({
    runsRootOverride: root,
    cutoffDays: 0,
  });

  assert.equal(result.candidates.length, 0, "cutoffDays=0 disables GC");
});

// ─── applyGc ────────────────────────────────────────────────────────

test("applyGc deletes candidate run dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-apply-"));
  makeRunDir(root, "wf-todelete001", { ageDays: 35 });
  const dir = join(root, "wf-todelete001");
  assert.ok(existsSync(dir), "run dir should exist before apply");

  const result = await loadGcCandidates({ runsRootOverride: root, cutoffDays: 30 });
  assert.ok(result.candidates.length > 0, "should have candidates");

  const { deleted, errors } = await applyGc(result.candidates);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  assert.ok(deleted.includes("wf-todelete001"), "expected deleted list to include run");
  assert.ok(!existsSync(dir), "run dir should be gone after apply");
});
