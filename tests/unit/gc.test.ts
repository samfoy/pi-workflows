/**
 * tests/unit/gc.test.ts — slice 11 §C.
 *
 * `/workflows gc` semantics:
 *   - Default mode: dry-run (no deletion).
 *   - `apply: true` actually removes candidate run-dirs.
 *   - Skip rules:
 *       - non-terminal run               → skipped
 *       - terminal but missing result.json → skipped (mid-resume safety)
 *       - terminal + has result.json + younger than cutoff → skipped
 *       - active resume lock (live holder) → skipped
 *   - cutoffDays=0 → disabled (no candidates regardless of state)
 *   - cutoffDays > 5475 → clamped to 5475
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGc } from "../../src/runtime/gc.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";
import {
  acquireResumeLock,
  releaseResumeLock,
} from "../../src/runtime/runLock.ts";

interface MakeRunOpts {
  readonly runsRoot: string;
  readonly runId: string;
  readonly state: "running" | "done" | "failed" | "stopped" | "cancelled-pre-run";
  readonly endedAt?: string;
  readonly writeResult?: boolean;
}

async function makeRun(opts: MakeRunOpts): Promise<string> {
  const runDir = join(opts.runsRoot, opts.runId);
  mkdirSync(runDir, { recursive: true });
  // ledger
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  await writer.append({
    type: "init",
    at: opts.endedAt ?? new Date().toISOString(),
    manifest: { runId: opts.runId, workflowName: "synthetic" },
  });
  const transitions: Array<[string, string]> = [];
  switch (opts.state) {
    case "running":
      transitions.push(["pending", "approved"], ["approved", "running"]);
      break;
    case "done":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "done"],
      );
      break;
    case "failed":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "failed"],
      );
      break;
    case "stopped":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "stopped"],
      );
      break;
    case "cancelled-pre-run":
      transitions.push(["pending", "cancelled-pre-run"]);
      break;
  }
  for (const [from, to] of transitions) {
    await writer.append({
      type: "transition",
      at: opts.endedAt ?? new Date().toISOString(),
      from: from as never,
      to: to as never,
    });
  }
  // result.json optional (mid-resume safety).
  if (opts.writeResult !== false && opts.state !== "running") {
    const result = {
      runId: opts.runId,
      workflowName: "synthetic",
      outcome: opts.state,
      startedAt: opts.endedAt ?? new Date().toISOString(),
      endedAt: opts.endedAt ?? new Date().toISOString(),
      durationMs: 0,
      result: null,
      error: null,
      approval: null,
      agentCount: 0,
      finishCallbackPrompt: null,
    };
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify(result, null, 2),
    );
  }
  return runDir;
}

function tmpRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-gc-"));
}

const RESOLVERS = (runsRoot: string) => ({
  resolveLedgerPath: (id: string) => join(runsRoot, id, "ledger.jsonl"),
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── basic listings ─────────────────────────────────────────────────

test("gc dry-run: terminal + 60-day-old run → candidate (apply=false, no delete)", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const runDir = await makeRun({
    runsRoot,
    runId: "wf-old0000xxxx",
    state: "done",
    endedAt: oldIso,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: false,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.applied, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.runId, "wf-old0000xxxx");
  assert.equal(result.deleted.length, 0);
  // run dir still exists
  assert.equal(existsSync(runDir), true);
});

test("gc apply: terminal + 60-day-old → deletes the run dir", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const runDir = await makeRun({
    runsRoot,
    runId: "wf-applyxxxxxx",
    state: "done",
    endedAt: oldIso,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.deleted, ["wf-applyxxxxxx"]);
  assert.equal(existsSync(runDir), false);
});

test("gc skip: terminal but no result.json → mid-resume safety (skipped)", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const runDir = await makeRun({
    runsRoot,
    runId: "wf-noresult0xx",
    state: "done",
    endedAt: oldIso,
    writeResult: false,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "missing-result-json");
  assert.equal(existsSync(runDir), true);
});

test("gc skip: non-terminal run (running) → skipped regardless of age", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 365 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-runningxxx1",
    state: "running",
    endedAt: oldIso,
    writeResult: false,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "non-terminal");
});

test("gc skip: terminal but younger than cutoff → skipped", async () => {
  const runsRoot = tmpRunsRoot();
  const youngIso = new Date(Date.now() - 5 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-youngxxxxx2",
    state: "done",
    endedAt: youngIso,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.skipped[0]?.reason, "younger-than-cutoff");
});

test("gc skip: active resume lock → skipped even if old + terminal", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const runDir = await makeRun({
    runsRoot,
    runId: "wf-lockedxxxxx",
    state: "done",
    endedAt: oldIso,
  });
  const handle = acquireResumeLock({
    runDirAbs: runDir,
    runId: "wf-lockedxxxxx",
  });
  try {
    const result = await runGc({
      runsRootOverride: runsRoot,
      cutoffDays: 30,
      apply: true,
      ...RESOLVERS(runsRoot),
    });
    assert.equal(result.deleted.length, 0);
    assert.equal(result.skipped[0]?.reason, "active-resume-lock");
    assert.equal(existsSync(runDir), true);
  } finally {
    handle.release();
  }
});

test("gc cutoffDays=0 → disabled (no candidates regardless of state)", async () => {
  const runsRoot = tmpRunsRoot();
  const ancientIso = new Date(Date.now() - 9999 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-zerocutoffx",
    state: "done",
    endedAt: ancientIso,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 0,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.deleted.length, 0);
});

test("gc cutoffDays clamping: > 5475 clamps to 5475", async () => {
  const runsRoot = tmpRunsRoot();
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 99999,
    apply: false,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.cutoffDays, 5475);
});

test("gc handles cancelled-pre-run with result.json: candidate", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-cancelled1x",
    state: "cancelled-pre-run",
    endedAt: oldIso,
  });
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: false,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.outcome, "cancelled-pre-run");
});

test("gc on missing runs-root: empty result, no errors", async () => {
  const result = await runGc({
    runsRootOverride: join(tmpdir(), "nonexistent-pi-wf-gc-" + Date.now()),
    cutoffDays: 30,
  });
  assert.equal(result.scanned, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.length, 0);
});

test("gc dry-run vs apply: apply=false leaves dirs intact, apply=true removes them", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const runDir = await makeRun({
    runsRoot,
    runId: "wf-dryapplyx12",
    state: "done",
    endedAt: oldIso,
  });

  const dry = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: false,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(dry.applied, false);
  assert.equal(dry.candidates.length, 1);
  assert.equal(existsSync(runDir), true);

  const apply = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(apply.applied, true);
  assert.equal(apply.deleted.length, 1);
  assert.equal(existsSync(runDir), false);
});
