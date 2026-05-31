/**
 * tests/unit/gcRecursiveFork.test.ts — ZONE_TIMETRAVEL polish.
 *
 * Recursive-fork GC validation. The GC walk reads each run's
 * `manifest.parentRunId` to build a child→parent index BEFORE
 * iterating candidates, and then refuses to delete any candidate
 * that still has a surviving fork on disk unless `force: true` is
 * passed.
 *
 * Acceptance per zone task spec:
 *   - A → B fork: GC of A is REFUSED while B is still on disk.
 *     The result.skipped entry has reason "has-fork-children".
 *   - Force-delete A: B's manifest gains `parentDeletedAt: <iso>`,
 *     and B's ledger gains a `log: warn` tombstone line.
 *   - A → B → C fork chain: GC of B is REFUSED while C exists.
 *     B is shielded the same way A is in the simple case.
 *   - Orphan tolerance: a child whose `parentRunId` doesn't appear
 *     on disk is logged as an orphan and otherwise treated normally
 *     (its own GC eligibility isn't affected).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGc } from "../../src/runtime/gc.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";

interface MakeRunOpts {
  readonly runsRoot: string;
  readonly runId: string;
  readonly endedAtIso: string;
  readonly parentRunId?: string;
  readonly forkAtPhase?: string;
}

/**
 * Synthesize a minimum-viable `done`-state run dir on disk:
 * manifest.json, ledger.jsonl with init+transitions, and result.json
 * so GC's mid-resume safety check passes. Optional fork lineage.
 */
async function makeRun(opts: MakeRunOpts): Promise<string> {
  const runDir = join(opts.runsRoot, opts.runId);
  mkdirSync(runDir, { recursive: true });
  // Manifest.
  const manifest: Record<string, unknown> = {
    runId: opts.runId,
    workflowName: "synthetic",
    workflowAbsPath: join(opts.runsRoot, "synthetic.workflow.js"),
    workflowSourceSha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    cwd: opts.runsRoot,
    startedAt: opts.endedAtIso,
    options: { mockAgents: false, maxConcurrent: 1, perRunAgentCap: 1 },
    trustedAtStart: true,
  };
  if (opts.parentRunId !== undefined) manifest.parentRunId = opts.parentRunId;
  if (opts.forkAtPhase !== undefined) manifest.forkAtPhase = opts.forkAtPhase;
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  // Ledger: init + pending→approved→running→done.
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  await writer.append({
    type: "init",
    at: opts.endedAtIso,
    manifest,
  });
  for (const [from, to] of [
    ["pending", "approved"],
    ["approved", "running"],
    ["running", "done"],
  ] as const) {
    await writer.append({
      type: "transition",
      at: opts.endedAtIso,
      from: from as never,
      to: to as never,
    });
  }
  // result.json — required for GC eligibility (mid-resume safety).
  const result = {
    runId: opts.runId,
    workflowName: "synthetic",
    outcome: "done" as const,
    startedAt: opts.endedAtIso,
    endedAt: opts.endedAtIso,
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
  return runDir;
}

function tmpRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-gc-recursive-fork-"));
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RESOLVERS = (runsRoot: string) => ({
  resolveLedgerPath: (id: string) => join(runsRoot, id, "ledger.jsonl"),
});

// ─── A → B fork: GC of A refused ────────────────────────────────────

test("gc apply: A→B fork — GC of A is refused while B is on disk (default force=false)", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const aDir = await makeRun({
    runsRoot,
    runId: "wf-aaaaaaaaaaaa",
    endedAtIso: oldIso,
  });
  const bDir = await makeRun({
    runsRoot,
    runId: "wf-bbbbbbbbbbbb",
    endedAtIso: oldIso,
    parentRunId: "wf-aaaaaaaaaaaa",
    forkAtPhase: "p2",
  });

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });

  // A is refused; B is deletable (no surviving forks of its own).
  assert.equal(result.applied, true);
  assert.deepEqual(result.deleted, ["wf-bbbbbbbbbbbb"]);
  assert.equal(existsSync(aDir), true);
  assert.equal(existsSync(bDir), false);
  const skippedA = result.skipped.find(
    (s) => s.runId === "wf-aaaaaaaaaaaa",
  );
  assert.ok(skippedA, "A must appear in skipped");
  assert.equal(skippedA?.reason, "has-fork-children");
  assert.match(
    skippedA?.details ?? "",
    /forks: \[wf-bbbbbbbbbbbb\]/,
    "skipped.details must list the surviving fork",
  );
  assert.match(
    skippedA?.details ?? "",
    /force:true/,
    "skipped.details must hint at the force override",
  );
});

test("gc apply: force=true on A→B — A deletes, B's manifest gets parentDeletedAt + ledger tombstone", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const aDir = await makeRun({
    runsRoot,
    runId: "wf-aaaaaaaaaaaa",
    endedAtIso: oldIso,
  });
  const bDir = await makeRun({
    runsRoot,
    runId: "wf-bbbbbbbbbbbb",
    endedAtIso: oldIso,
    parentRunId: "wf-aaaaaaaaaaaa",
    forkAtPhase: "p2",
  });

  // Read B's pre-GC ledger so we can prove the tombstone is APPENDED.
  const bLedgerBefore = readFileSync(
    join(bDir, "ledger.jsonl"),
    "utf-8",
  );

  const warnings: string[] = [];
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    force: true,
    log: (level, msg) => {
      if (level === "warn") warnings.push(msg);
    },
    ...RESOLVERS(runsRoot),
  });

  assert.deepEqual(
    [...result.deleted].sort(),
    ["wf-aaaaaaaaaaaa", "wf-bbbbbbbbbbbb"],
    "force=true deletes both A and B (B is independently eligible)",
  );
  assert.equal(existsSync(aDir), false, "A's run dir must be removed");
  // B's run dir is also removed because B is itself terminal+old.
  // To prove the tombstone landed, we must read it from the
  // pre-`rmSync` patched manifest. The simpler proof: capture B's
  // updated manifest BEFORE rmSync by spying on the warning log
  // and asserting the warning pattern.
  void bLedgerBefore; // sanity: unused but kept for readability
  const tombstoneWarn = warnings.find((w) => w.includes("force-delete"));
  assert.ok(
    tombstoneWarn !== undefined,
    "GC must emit a warning identifying the force-deleted parent",
  );
  assert.match(
    tombstoneWarn ?? "",
    /wf-bbbbbbbbbbbb.*parentDeletedAt=.*wf-aaaaaaaaaaaa/s,
    "warning must mention child runId, parentDeletedAt timestamp, and parent runId",
  );
});

test("gc apply: force=true tombstone is observable on a fork that survives the same pass", async () => {
  // Variant of the prior test: B is YOUNG so it survives the GC
  // pass. We can then read B's manifest + ledger directly and assert
  // the tombstone landed.
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const youngIso = new Date(Date.now() - 1 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-aaaaaaaaaaaa",
    endedAtIso: oldIso,
  });
  const bDir = await makeRun({
    runsRoot,
    runId: "wf-bbbbbbbbbbbb",
    endedAtIso: youngIso, // young → not a candidate, survives GC
    parentRunId: "wf-aaaaaaaaaaaa",
    forkAtPhase: "p2",
  });

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    force: true,
    ...RESOLVERS(runsRoot),
  });

  assert.deepEqual(result.deleted, ["wf-aaaaaaaaaaaa"]);
  assert.equal(
    existsSync(bDir),
    true,
    "B is young → not a candidate, must survive",
  );

  // Manifest patched.
  const bManifest = JSON.parse(
    readFileSync(join(bDir, "manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
  assert.equal(typeof bManifest.parentDeletedAt, "string");
  assert.equal(bManifest.parentRunId, "wf-aaaaaaaaaaaa");

  // Ledger tombstone appended as a `log: warn`.
  const bLedger = readFileSync(join(bDir, "ledger.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const tombstone = bLedger.find(
    (e) =>
      e.type === "log" &&
      e.level === "warn" &&
      typeof e.message === "string" &&
      (e.message as string).includes("wf-aaaaaaaaaaaa") &&
      (e.message as string).includes("force GC"),
  );
  assert.ok(
    tombstone !== undefined,
    `B's ledger must contain a 'log: warn' tombstone naming the parent; got: ${bLedger.map((e) => e.type).join(",")}`,
  );
});

test("gc apply: A→B→C fork chain — GC of B is refused while C exists", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const youngIso = new Date(Date.now() - 1 * DAY_MS).toISOString();
  await makeRun({
    runsRoot,
    runId: "wf-aaaaaaaaaaaa",
    endedAtIso: youngIso, // young — not a GC candidate
  });
  const bDir = await makeRun({
    runsRoot,
    runId: "wf-bbbbbbbbbbbb",
    endedAtIso: oldIso, // old → eligible BUT C blocks it
    parentRunId: "wf-aaaaaaaaaaaa",
    forkAtPhase: "p1",
  });
  await makeRun({
    runsRoot,
    runId: "wf-ccccccccccccc",
    endedAtIso: youngIso, // young — not a candidate, surviving fork of B
    parentRunId: "wf-bbbbbbbbbbbb",
    forkAtPhase: "p2",
  });

  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    ...RESOLVERS(runsRoot),
  });

  assert.equal(
    result.deleted.length,
    0,
    "no deletions: A is young, B is blocked by C, C is young",
  );
  assert.equal(
    existsSync(bDir),
    true,
    "B must NOT be deleted while C is on disk",
  );
  const skippedB = result.skipped.find(
    (s) => s.runId === "wf-bbbbbbbbbbbb",
  );
  assert.ok(skippedB);
  assert.equal(skippedB?.reason, "has-fork-children");
  assert.match(
    skippedB?.details ?? "",
    /forks: \[wf-ccccccccccccc\]/,
    "skipped.details must list C as the surviving fork",
  );
});

test("gc apply: orphan fork — child references a parent that doesn't exist on disk → logged + child still GC'd normally", async () => {
  const runsRoot = tmpRunsRoot();
  const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const orphanDir = await makeRun({
    runsRoot,
    runId: "wf-orphan000xxx",
    endedAtIso: oldIso,
    parentRunId: "wf-deadparent00", // never on disk
    forkAtPhase: "p1",
  });

  const warnings: string[] = [];
  const result = await runGc({
    runsRootOverride: runsRoot,
    cutoffDays: 30,
    apply: true,
    log: (level, msg) => {
      if (level === "warn") warnings.push(msg);
    },
    ...RESOLVERS(runsRoot),
  });

  // The orphan itself has no surviving forks → it gets GC'd.
  assert.deepEqual(result.deleted, ["wf-orphan000xxx"]);
  assert.equal(existsSync(orphanDir), false);
  // But a warning was logged about the missing parent.
  const orphanWarn = warnings.find(
    (w) => w.includes("orphan fork") && w.includes("wf-deadparent00"),
  );
  assert.ok(
    orphanWarn !== undefined,
    `expected an orphan-fork warning naming the missing parent; got warnings: ${warnings.join(" | ")}`,
  );
});
