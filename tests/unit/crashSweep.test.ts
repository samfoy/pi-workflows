/**
 * tests/unit/crashSweep.test.ts — slice 11 §A.
 *
 * Covers the crash-sweep substrate's contract:
 *   - non-terminal run + dead parent  → flipped to `failed: parent-crash`
 *   - non-terminal run + alive parent → left alone
 *   - terminal run                    → skipped (incl. cancelled-pre-run)
 *   - missing manifest                → skipped (no error)
 *   - corrupt manifest (no parentPid) → error captured, sweep continues
 *   - bootId mismatch                 → treated as dead parent
 *   - sweep is idempotent: running twice produces ≤1 transition
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

import {
  sweepCrashedRuns,
  isParentAlive,
  currentBootId,
  parseDarwinBootTime,
  _resetBootIdCacheForTests,
} from "../../src/runtime/crashSweep.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";

interface SyntheticRunOpts {
  readonly runsRoot: string;
  readonly runId: string;
  readonly state: "running" | "paused" | "approved" | "done" | "failed" | "stopped" | "cancelled-pre-run";
  readonly parentPid: number;
  readonly parentBootId?: string;
  /** Skip writing manifest to test corrupt-manifest path. */
  readonly skipManifest?: boolean;
  /** Override manifest body (e.g. omit parentPid for error case). */
  readonly manifestBody?: Record<string, unknown>;
}

async function makeRun(opts: SyntheticRunOpts): Promise<string> {
  const runDir = join(opts.runsRoot, opts.runId);
  mkdirSync(runDir, { recursive: true });
  if (!opts.skipManifest) {
    const body = opts.manifestBody ?? {
      runId: opts.runId,
      workflowName: "synthetic",
      parentPid: opts.parentPid,
      parentBootId: opts.parentBootId ?? "",
    };
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(body, null, 2));
  }
  // Construct ledger to land in `state`. We always start from `pending`
  // and advance through the legal chain.
  const writer = new LedgerWriter({
    runId: opts.runId,
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  // Add an init entry to be realistic.
  await writer.append({
    type: "init",
    at: new Date().toISOString(),
    manifest: {
      runId: opts.runId,
      workflowName: "synthetic",
    },
  });
  const transitions: Array<[string, string]> = [];
  switch (opts.state) {
    case "approved":
      transitions.push(["pending", "approved"]);
      break;
    case "running":
      transitions.push(["pending", "approved"], ["approved", "running"]);
      break;
    case "paused":
      transitions.push(
        ["pending", "approved"],
        ["approved", "running"],
        ["running", "paused"],
      );
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
      at: new Date().toISOString(),
      from: from as never,
      to: to as never,
    });
  }
  return runDir;
}

function tmpRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-sweep-"));
}

const RESOLVERS = (runsRoot: string) => ({
  resolveLedgerPath: (id: string) => join(runsRoot, id, "ledger.jsonl"),
  resolveManifestPath: (id: string) => join(runsRoot, id, "manifest.json"),
});

// ─── liveness primitives ─────────────────────────────────────────────

test("parseDarwinBootTime: full sysctl struct → namespaced id", () => {
  const out = "{ sec = 1748714712, usec = 123456 } Mon May 31 12:34:56 2025\n";
  assert.equal(parseDarwinBootTime(out), "darwin-1748714712");
});

test("parseDarwinBootTime: extra whitespace tolerated", () => {
  assert.equal(
    parseDarwinBootTime("  { sec  =  9999, usec = 0 } whatever"),
    "darwin-9999",
  );
});

test("parseDarwinBootTime: bare-integer fallback", () => {
  // Some sysctl variants print just the seconds with `-n`.
  assert.equal(parseDarwinBootTime("1717154712\n"), "darwin-1717154712");
});

test("parseDarwinBootTime: garbage → empty string", () => {
  assert.equal(parseDarwinBootTime("this is not boottime output"), "");
  assert.equal(parseDarwinBootTime(""), "");
});

test("currentBootId: nonempty + stable across calls (linux + darwin)", () => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return; // platform without a known boot-id source — empty by design
  }
  _resetBootIdCacheForTests();
  const first = currentBootId();
  const second = currentBootId();
  assert.notEqual(first, "", "currentBootId must be nonempty on linux/darwin");
  assert.equal(first, second, "currentBootId must be stable across calls");
  if (process.platform === "darwin") {
    assert.match(
      first,
      /^darwin-\d+$/,
      `darwin boot id must be 'darwin-<sec>', got ${first}`,
    );
  }
});

test("isParentAlive: own pid + matching bootId → alive", () => {
  const alive = isParentAlive({
    parentPid: process.pid,
    parentBootId: currentBootId(),
  });
  assert.equal(alive, true);
});

test("isParentAlive: pid that does not exist → dead", () => {
  // PID 999999 is reserved-high; on Linux the default pid_max is
  // 32768 so this is reliably absent.
  const alive = isParentAlive({ parentPid: 999999, parentBootId: "" });
  assert.equal(alive, false);
});

test("isParentAlive: zero / negative pid → dead (defensive)", () => {
  assert.equal(isParentAlive({ parentPid: 0, parentBootId: "" }), false);
  assert.equal(isParentAlive({ parentPid: -1, parentBootId: "" }), false);
});

test("isParentAlive: own pid + mismatched bootId → dead (host rebooted)", () => {
  const myBoot = currentBootId();
  if (myBoot === "") {
    // Skip on macOS where bootId is empty — the bootId check is
    // skipped there by design.
    return;
  }
  const alive = isParentAlive({
    parentPid: process.pid,
    parentBootId: "deadbeef-deadbeef-deadbeef-deadbeef",
  });
  assert.equal(alive, false);
});

// ─── sweep behavior ──────────────────────────────────────────────────

test("sweep: non-terminal `running` + dead parent → flips to `failed: parent-crash`", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-deadparent01";
  const runDir = await makeRun({
    runsRoot,
    runId,
    state: "running",
    parentPid: 999999,
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.transitioned.length, 1);
  assert.equal(result.transitioned[0]?.runId, runId);
  assert.equal(result.transitioned[0]?.fromState, "running");

  // Verify the ledger now ends with the parent-crash transition.
  const lines = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n");
  const last = JSON.parse(lines[lines.length - 1]!) as {
    type: string;
    from: string;
    to: string;
    reason?: string;
  };
  assert.equal(last.type, "transition");
  assert.equal(last.from, "running");
  assert.equal(last.to, "failed");
  assert.equal(last.reason, "parent-crash");
});

test("sweep: alive parent → leaves run untouched", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-alivexxxxxx";
  await makeRun({
    runsRoot,
    runId,
    state: "running",
    parentPid: process.pid,
    parentBootId: currentBootId(),
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.transitioned.length, 0);
  assert.deepEqual(result.skippedAlive, [runId]);
});

test("sweep: terminal `done` is skipped (no transition)", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-terminalxxx";
  await makeRun({
    runsRoot,
    runId,
    state: "done",
    parentPid: 999999,
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.transitioned.length, 0);
  assert.deepEqual(result.skippedTerminal, [runId]);
});

test("[C4] sweep: terminal `cancelled-pre-run` is skipped (never resumable)", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-cancelledxx";
  await makeRun({
    runsRoot,
    runId,
    state: "cancelled-pre-run",
    parentPid: 999999,
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.transitioned.length, 0);
  assert.deepEqual(result.skippedTerminal, [runId]);
});

test("sweep: paused + dead parent → flipped to failed", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-pausedxxxx";
  await makeRun({
    runsRoot,
    runId,
    state: "paused",
    parentPid: 999999,
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.transitioned.length, 1);
  assert.equal(result.transitioned[0]?.fromState, "paused");
});

test("sweep: missing manifest is silently skipped (partial run-dir)", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-nomanifest1";
  // Skip writing the manifest entirely.
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.transitioned.length, 0);
  assert.equal(result.errors.length, 0);
});

test("sweep: manifest without parentPid surfaces as error (not crash)", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-bareminmftt";
  await makeRun({
    runsRoot,
    runId,
    state: "running",
    parentPid: 0, // unused — body is overridden below
    manifestBody: { runId, workflowName: "synthetic" },
  });
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /parentPid/);
});

test("sweep: idempotent — running twice produces no extra transition", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-idempotentx";
  const runDir = await makeRun({
    runsRoot,
    runId,
    state: "running",
    parentPid: 999999,
  });
  await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  const lines1 = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n").length;

  // Second sweep — should see terminal state and skip.
  const result2 = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  const lines2 = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n").length;
  assert.equal(lines1, lines2, "second sweep must not append more lines");
  assert.equal(result2.transitioned.length, 0);
  assert.deepEqual(result2.skippedTerminal, [runId]);
});

test("sweep: missing runs-root is a silent zero result (no errors)", async () => {
  const result = await sweepCrashedRuns({
    runsRootOverride: join(tmpdir(), "nonexistent-pi-wf-sweep-" + Date.now()),
  });
  assert.equal(result.scanned, 0);
  assert.equal(result.transitioned.length, 0);
  assert.equal(result.errors.length, 0);
});

test("sweep: non-`wf-` directories are ignored", async () => {
  const runsRoot = tmpRunsRoot();
  // Drop a stray directory not following `wf-` prefix.
  mkdirSync(join(runsRoot, "garbage"), { recursive: true });
  writeFileSync(
    join(runsRoot, "garbage", "manifest.json"),
    JSON.stringify({ parentPid: 999999 }),
  );
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.scanned, 0);
});

test("sweep: liveness override (test seam) — alive=false flips run", async () => {
  const runsRoot = tmpRunsRoot();
  const runId = "wf-overridexx1";
  await makeRun({
    runsRoot,
    runId,
    state: "running",
    parentPid: process.pid, // really alive
    parentBootId: currentBootId(),
  });
  // But override liveness to claim dead.
  const result = await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    isAlive: () => false,
    ...RESOLVERS(runsRoot),
  });
  assert.equal(result.transitioned.length, 1);
});

test("sweep: log sink receives one warn line per transitioned run", async () => {
  const runsRoot = tmpRunsRoot();
  await makeRun({
    runsRoot,
    runId: "wf-logsinkxxxx",
    state: "running",
    parentPid: 999999,
  });
  const lines: { level: string; message: string }[] = [];
  await sweepCrashedRuns({
    runsRootOverride: runsRoot,
    ...RESOLVERS(runsRoot),
    log: (level, message) => lines.push({ level, message }),
  });
  const warns = lines.filter((l) => l.level === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0]?.message ?? "", /parent-crash/);
});

// Verify the existsSync guard runs (smoke).
test("existsSync sanity: created run-dirs are visible", () => {
  const runsRoot = tmpRunsRoot();
  mkdirSync(join(runsRoot, "wf-justexists1"), { recursive: true });
  assert.equal(existsSync(join(runsRoot, "wf-justexists1")), true);
});
