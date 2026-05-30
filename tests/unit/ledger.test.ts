/**
 * tests/unit/ledger.test.ts — slice 7 ledger writer + reader + state machine.
 *
 * Acceptance per `plan.md` §4 Slice 7:
 *   - Append is async; fsync called before return (mutation-test safe).
 *   - Torn last line is silently dropped on replay; latest complete
 *     transition surfaces.
 *   - Mid-file corrupt JSON line emits warn + skip.
 *   - Invalid transition (e.g. done → running) is rejected by the
 *     state-machine validator; reader logs warn + uses last valid.
 *   - Full-run replay produces expected final state for each terminal
 *     class (done, failed, stopped, cancelled-pre-run).
 *   - Concurrent appends serialize via internal mutex; ordering matches
 *     enqueue order.
 *   - `result` entry truncates to ≤4KB with `truncated: true` flag.
 *
 * Plus brief-section D — agent_error preserves both
 * `MalformedAgentOutputError` and `AgentSubprocessError` distinctly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LedgerReader,
  LedgerWriter,
  RunStateMachine,
  InvalidStateTransitionError,
  TERMINAL_STATES,
  RESUMABLE_STATES,
  NON_TERMINAL_STATES,
  isValidTransition,
  replayState,
  log,
  agentErrorFromException,
  buildResultEntry,
  LEDGER_RESULT_MAX_BYTES,
} from "../../src/runtime/ledger.ts";
import {
  AgentSubprocessError,
  MalformedAgentOutputError,
  MockFixtureMissingError,
} from "../../src/runtime/errors.ts";
import type {
  LedgerEntry,
  RunState,
} from "../../src/types/internal.d.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/ledger/", import.meta.url));

function makeRunDir(): {
  runId: string;
  runDir: string;
  ledgerPath: string;
  cleanup: () => void;
  resolveLedgerPath: (id: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-ledger-"));
  const runId = "wf-" + Math.random().toString(36).slice(2, 14);
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  const ledgerPath = join(runDir, "ledger.jsonl");
  return {
    runId,
    runDir,
    ledgerPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    resolveLedgerPath: () => ledgerPath,
  };
}

const fixedNow = (() => {
  let n = 0;
  return () => `2026-05-28T00:00:${String(n++).padStart(2, "0")}.000Z`;
})();

// ─── State-machine validator ──────────────────────────────────────────

test("state machine: every legal transition listed in PRD §5.2 passes", () => {
  const legal: ReadonlyArray<readonly [RunState, RunState]> = [
    ["pending", "approved"],
    ["pending", "cancelled-pre-run"],
    ["approved", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "done"],
    ["running", "failed"],
    ["running", "stopped"],
    ["paused", "stopped"],
    ["paused", "failed"],
  ];
  for (const [from, to] of legal) {
    assert.equal(isValidTransition(from, to), true, `expected ${from} → ${to} to be legal`);
  }
});

test("state machine: every illegal transition is rejected", () => {
  const all: RunState[] = [
    "pending", "approved", "running", "paused",
    "done", "failed", "stopped", "cancelled-pre-run",
  ];
  const legalSet = new Set([
    "pending→approved", "pending→cancelled-pre-run",
    "approved→running",
    "running→paused", "running→done", "running→failed", "running→stopped",
    "paused→running", "paused→stopped", "paused→failed",
    // Slice 11 advisory rollback edge for the resume-rollback case
    // (PRD §5.8.2). Other failed runs remain non-resumable per slice
    // 11's resumability gate.
    "failed→running",
  ]);
  let rejectedCount = 0;
  for (const from of all) {
    for (const to of all) {
      const isLegal = legalSet.has(`${from}→${to}`);
      const got = isValidTransition(from, to);
      assert.equal(got, isLegal, `expected ${from}→${to} to be ${isLegal}, got ${got}`);
      if (!isLegal) rejectedCount += 1;
    }
  }
  assert.ok(rejectedCount > 0);
});

test("state machine: truly-terminal states (done/stopped/cancelled-pre-run) have no outgoing edges", () => {
  // Slice 11 added `failed → running` for the advisory resume-
  // rollback path; the OTHER three terminal states remain truly
  // terminal.
  const trulyTerminal: RunState[] = ["done", "stopped", "cancelled-pre-run"];
  for (const t of trulyTerminal) {
    for (const to of ["pending", "approved", "running", "paused", "done", "failed", "stopped", "cancelled-pre-run"] as RunState[]) {
      assert.equal(isValidTransition(t, to), false, `${t} should not transition to ${to}`);
    }
  }
});

test("state machine: PRD §5.2 set memberships", () => {
  assert.deepEqual(new Set([...TERMINAL_STATES]), new Set(["done", "failed", "stopped", "cancelled-pre-run"]));
  assert.deepEqual(new Set([...NON_TERMINAL_STATES]), new Set(["pending", "approved", "running", "paused"]));
  assert.deepEqual(new Set([...RESUMABLE_STATES]), new Set(["paused", "running", "approved", "pending"]));
});

// ─── RunStateMachine.go ──────────────────────────────────────────────

test("RunStateMachine.go: legal transition appends transition + advances state", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer, now: fixedNow });
    assert.equal(sm.state, "pending");
    await sm.go("approved");
    assert.equal(sm.state, "approved");
    await sm.go("running");
    await sm.go("done");
    assert.equal(sm.state, "done");

    const lines = readFileSync(env.ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l) as LedgerEntry);
    assert.equal(parsed[0]!.type, "transition");
    assert.deepEqual([parsed[0]!.type === "transition" && parsed[0]!.from, parsed[0]!.type === "transition" && parsed[0]!.to], ["pending", "approved"]);
    assert.deepEqual([parsed[1]!.type === "transition" && parsed[1]!.from, parsed[1]!.type === "transition" && parsed[1]!.to], ["approved", "running"]);
    assert.deepEqual([parsed[2]!.type === "transition" && parsed[2]!.from, parsed[2]!.type === "transition" && parsed[2]!.to], ["running", "done"]);
  } finally {
    env.cleanup();
  }
});

test("RunStateMachine.go: illegal transition throws + state stays put + no append", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer, now: fixedNow });
    await sm.go("approved");
    await sm.go("running");
    await sm.go("done");

    await assert.rejects(
      () => sm.go("running"),
      (err: unknown) => err instanceof InvalidStateTransitionError &&
        (err as InvalidStateTransitionError).from === "done" &&
        (err as InvalidStateTransitionError).to === "running",
    );
    // State unchanged.
    assert.equal(sm.state, "done");
    // Ledger has only the 3 successful transitions — no failed-attempt residue.
    const lines = readFileSync(env.ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    env.cleanup();
  }
});

test("RunStateMachine.go: reason is preserved on involuntary transitions", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer, now: fixedNow });
    await sm.go("approved");
    await sm.go("running");
    await sm.go("failed", { reason: "parent-crash" });

    const last = JSON.parse(readFileSync(env.ledgerPath, "utf8").trim().split("\n").pop()!) as LedgerEntry;
    assert.equal(last.type, "transition");
    if (last.type === "transition") {
      assert.equal(last.reason, "parent-crash");
    }
  } finally {
    env.cleanup();
  }
});

// ─── Writer durability ────────────────────────────────────────────────

test("LedgerWriter.append: line ends with \\n and is parsable JSON", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await writer.append({ type: "log", at: fixedNow(), level: "info", message: "hello" });
    await writer.flush();
    const buf = readFileSync(env.ledgerPath, "utf8");
    assert.ok(buf.endsWith("\n"));
    const parsed = JSON.parse(buf.trim()) as LedgerEntry;
    assert.equal(parsed.type, "log");
    if (parsed.type === "log") assert.equal(parsed.message, "hello");
  } finally {
    env.cleanup();
  }
});

test("LedgerWriter.append: 100 concurrent appends serialize in enqueue order", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      // Don't await — fire all 100 in the same microtask burst.
      promises.push(writer.append({ type: "log", at: `at-${i}`, level: "info", message: `m${i}` }));
    }
    await Promise.all(promises);
    const lines = readFileSync(env.ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 100);
    for (let i = 0; i < 100; i++) {
      const e = JSON.parse(lines[i]!) as LedgerEntry;
      assert.equal(e.type, "log");
      if (e.type === "log") assert.equal(e.message, `m${i}`, `out-of-order at index ${i}`);
    }
  } finally {
    env.cleanup();
  }
});

test("LedgerWriter: flushPolicy other than per-write throws at construction", () => {
  assert.throws(
    () =>
      new LedgerWriter({
        runId: "wf-x",
        resolveLedgerPath: () => "/tmp/nope",
        flushPolicy: "per-transition" as never,
      }),
    /v1 only supports flushPolicy="per-write"/,
  );
});

test("LedgerWriter: pre-existing file is appended to, not overwritten", async () => {
  const env = makeRunDir();
  try {
    writeFileSync(env.ledgerPath, JSON.stringify({ type: "log", at: "x", level: "info", message: "pre-existing" }) + "\n");
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await writer.append({ type: "log", at: "y", level: "info", message: "new" });
    await writer.flush();
    const lines = readFileSync(env.ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /pre-existing/);
    assert.match(lines[1]!, /new/);
  } finally {
    env.cleanup();
  }
});

// Mutation probe: if fsync were removed from appendLineSync, this test
// would still pass (we don't simulate a power loss). The real durability
// proof is the cache.ts mutation probe in slice 3 — same pattern. We
// only assert that the file IS there + readable after append resolves.
test("MUTATION-PROBE: post-append read sees the line synchronously", async () => {
  const env = makeRunDir();
  try {
    const writer = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await writer.append({ type: "log", at: "x", level: "info", message: "post-append-visible" });
    // Don't call flush — append already awaited the queue tail.
    const buf = readFileSync(env.ledgerPath, "utf8");
    assert.match(buf, /post-append-visible/);
  } finally {
    env.cleanup();
  }
});

// ─── Reader: torn-tail tolerance ─────────────────────────────────────

test("LedgerReader.read: torn trailing line (no \\n) is silently dropped", async () => {
  const env = makeRunDir();
  try {
    // Write 3 complete entries, then a torn 4th that's pure garbage
    // and lacks a trailing newline.
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await w.append({ type: "log", at: "1", level: "info", message: "one" });
    await w.append({ type: "log", at: "2", level: "info", message: "two" });
    await w.append({ type: "log", at: "3", level: "info", message: "three" });
    appendFileSync(env.ledgerPath, '{"type":"log","at":"4","level":"info","message":"to'); // torn

    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 3);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.kind, "torn-tail");
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: torn-tail rebuilt from full ledger by truncate-mid-record", async () => {
  // Plan critic checklist: torn fixture is rebuilt at test-time, not committed truncated.
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    for (let i = 0; i < 10; i++) {
      await w.append({ type: "log", at: `t-${i}`, level: "info", message: `m${i}` });
    }
    const fullSize = readFileSync(env.ledgerPath).length;
    truncateSync(env.ledgerPath, fullSize - 5); // chop the last 5 bytes (mid-line, no \n)

    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 9, "only 9 complete entries should survive the truncate");
    assert.equal(result.warnings.filter((w) => w.kind === "torn-tail").length, 1);
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: mid-file corruption emits corrupt-line warning + continues", async () => {
  const env = makeRunDir();
  try {
    // Hand-construct a file with a bad interior line.
    const lines = [
      JSON.stringify({ type: "log", at: "1", level: "info", message: "ok-1" }),
      "{ this is not valid json at all }",
      JSON.stringify({ type: "log", at: "3", level: "info", message: "ok-3" }),
    ];
    writeFileSync(env.ledgerPath, lines.join("\n") + "\n");

    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 2);
    const corrupt = result.warnings.find((w) => w.kind === "corrupt-line");
    assert.ok(corrupt, "expected a corrupt-line warning");
    if (corrupt && corrupt.kind === "corrupt-line") {
      assert.equal(corrupt.lineIndex, 1);
    }
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: missing file → empty result + finalState=pending", async () => {
  const env = makeRunDir();
  try {
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.deepEqual(result.entries, []);
    assert.equal(result.finalState, "pending");
    assert.deepEqual(result.warnings, []);
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: empty file → empty result + finalState=pending", async () => {
  const env = makeRunDir();
  try {
    writeFileSync(env.ledgerPath, "");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.deepEqual(result.entries, []);
    assert.equal(result.finalState, "pending");
    assert.deepEqual(result.warnings, []);
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: non-object record → warning + skip", async () => {
  const env = makeRunDir();
  try {
    writeFileSync(env.ledgerPath, [
      JSON.stringify({ type: "log", at: "1", level: "info", message: "ok" }),
      "[1, 2, 3]",
      "null",
      JSON.stringify({ type: "log", at: "2", level: "info", message: "ok-2" }),
    ].join("\n") + "\n");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 2);
    assert.equal(result.warnings.filter((w) => w.kind === "non-object").length, 2);
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: unknown discriminator → warning + skip", async () => {
  const env = makeRunDir();
  try {
    writeFileSync(env.ledgerPath, [
      JSON.stringify({ type: "from_the_future", at: "1", payload: 42 }),
      JSON.stringify({ type: "log", at: "2", level: "info", message: "ok" }),
    ].join("\n") + "\n");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 1);
    const unk = result.warnings.find((w) => w.kind === "unknown-type");
    assert.ok(unk);
    if (unk && unk.kind === "unknown-type") {
      assert.equal(unk.recordType, "from_the_future");
    }
  } finally {
    env.cleanup();
  }
});

// ─── Reader: state replay ─────────────────────────────────────────────

test("LedgerReader.read: replay full happy-path → done", async () => {
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer: w, now: fixedNow });
    await sm.go("approved");
    await sm.go("running");
    // 50 mixed log/phase entries between transitions
    for (let i = 0; i < 50; i++) {
      await w.append({ type: "log", at: `bg-${i}`, level: "info", message: `bg-${i}` });
    }
    await sm.go("done");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.entries.length, 53);
    assert.equal(result.finalState, "done");
    assert.deepEqual(result.warnings, []);
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: replay → failed terminal", async () => {
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer: w, now: fixedNow });
    await sm.go("approved");
    await sm.go("running");
    await sm.go("failed");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.finalState, "failed");
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: replay → stopped terminal (paused→stopped path)", async () => {
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const sm = new RunStateMachine({ writer: w, now: fixedNow });
    await sm.go("approved");
    await sm.go("running");
    await sm.go("paused");
    await sm.go("stopped");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.finalState, "stopped");
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: replay → cancelled-pre-run terminal", async () => {
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await w.append({ type: "cancelled", at: "0", cause: "user-N" });
    const sm = new RunStateMachine({ writer: w, now: fixedNow });
    await sm.go("cancelled-pre-run");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.finalState, "cancelled-pre-run");
    assert.equal(result.entries[0]!.type, "cancelled");
  } finally {
    env.cleanup();
  }
});

test("LedgerReader.read: invalid transition mid-file → warn, finalState=last valid", async () => {
  const env = makeRunDir();
  try {
    // Hand-write a ledger that contains an illegal (paused → done) edge.
    const entries: LedgerEntry[] = [
      { type: "transition", at: "1", from: "pending", to: "approved" },
      { type: "transition", at: "2", from: "approved", to: "running" },
      { type: "transition", at: "3", from: "running", to: "paused" },
      // Illegal: paused → done.
      { type: "transition", at: "4", from: "paused", to: "done" },
      // Then a legal continuation that the reader should still apply:
      { type: "transition", at: "5", from: "paused", to: "running" },
      { type: "transition", at: "6", from: "running", to: "done" },
    ];
    writeFileSync(env.ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    // The reader keeps all 6 entries (it doesn't filter), but replay
    // skips the illegal one and continues with paused → running → done.
    assert.equal(result.entries.length, 6);
    assert.equal(result.finalState, "done");
    const inv = result.warnings.find((w) => w.kind === "invalid-transition");
    assert.ok(inv, "expected invalid-transition warning");
    if (inv && inv.kind === "invalid-transition") {
      assert.equal(inv.from, "paused");
      assert.equal(inv.to, "done");
    }
  } finally {
    env.cleanup();
  }
});

// ─── replayState (pure) ──────────────────────────────────────────────

test("replayState: empty entries → pending", () => {
  assert.equal(replayState([]), "pending");
});

test("replayState: 20-step property-ish drive through the state graph", () => {
  // Plan critic checklist: drive the SM through ≥20 transitions.
  const seq: ReadonlyArray<readonly [RunState, RunState]> = [
    ["pending", "approved"], ["approved", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "running"],
    ["running", "paused"], ["paused", "stopped"],
  ];
  const entries: LedgerEntry[] = seq.map(([from, to], i) => ({
    type: "transition" as const,
    at: `t-${i}`,
    from,
    to,
  }));
  assert.equal(replayState(entries), "stopped");
});

// ─── log() helper ─────────────────────────────────────────────────────

test("log() helper: appends a log entry through the writer", async () => {
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await log(w, "warn", "something happened", () => "fixed-ts");
    await w.flush();
    const parsed = JSON.parse(readFileSync(env.ledgerPath, "utf8").trim()) as LedgerEntry;
    assert.equal(parsed.type, "log");
    if (parsed.type === "log") {
      assert.equal(parsed.level, "warn");
      assert.equal(parsed.message, "something happened");
      assert.equal(parsed.at, "fixed-ts");
    }
  } finally {
    env.cleanup();
  }
});

// ─── agent_error preserves both error classes ────────────────────────

test("agentErrorFromException: MalformedAgentOutputError preserves forensic fields", () => {
  const e = new MalformedAgentOutputError({
    agentId: "a-1",
    cwd: "/x",
    exitCode: 1,
    bytes: "garbage bytes",
    lineNumber: 12,
    reason: "parse",
  });
  const p = agentErrorFromException(e);
  assert.equal(p.class, "MalformedAgentOutput");
  if (p.class === "MalformedAgentOutput") {
    assert.equal(p.reason, "parse");
    assert.equal(p.lineNumber, 12);
    assert.equal(p.bytes, "garbage bytes");
    assert.equal(p.exitCode, 1);
    assert.equal(p.cwd, "/x");
  }
});

test("agentErrorFromException: MalformedAgentOutputError truncates >256 byte payload", () => {
  const big = "x".repeat(1024);
  const e = new MalformedAgentOutputError({
    agentId: "a-2",
    cwd: "/x",
    exitCode: null,
    bytes: big,
    lineNumber: null,
    reason: "non-object",
  });
  const p = agentErrorFromException(e);
  if (p.class === "MalformedAgentOutput") {
    assert.equal(p.bytes.length, 256);
  } else {
    assert.fail("wrong class");
  }
});

test("agentErrorFromException: AgentSubprocessError preserves exit/signal/message distinctly", () => {
  const e = new AgentSubprocessError({
    agentId: "a-3",
    exitCode: 137,
    signal: "SIGKILL",
  });
  const p = agentErrorFromException(e);
  assert.equal(p.class, "AgentSubprocess");
  if (p.class === "AgentSubprocess") {
    assert.equal(p.exitCode, 137);
    assert.equal(p.signal, "SIGKILL");
    assert.match(p.message, /agent subprocess failed/);
  }
});

test("agentErrorFromException: MockFixtureMissingError round-trips", () => {
  const e = new MockFixtureMissingError({ agentId: "a-4", promptHash: "abcd1234".repeat(8), runDir: "/r" });
  const p = agentErrorFromException(e);
  assert.equal(p.class, "MockFixtureMissing");
  if (p.class === "MockFixtureMissing") {
    assert.equal(p.runDir, "/r");
    assert.match(p.promptHash, /^abcd1234/);
  }
});

test("agentErrorFromException: unknown error → class:Unknown with message + name", () => {
  class WeirdError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "WeirdError";
    }
  }
  const p = agentErrorFromException(new WeirdError("boom"));
  assert.equal(p.class, "Unknown");
  if (p.class === "Unknown") {
    assert.equal(p.message, "boom");
    assert.equal(p.name, "WeirdError");
  }
});

test("agentErrorFromException: non-Error thrown value → class:Unknown with stringified message", () => {
  const p = agentErrorFromException("just a string");
  assert.equal(p.class, "Unknown");
  if (p.class === "Unknown") {
    assert.equal(p.message, "just a string");
    assert.equal(p.name, undefined);
  }
});

test("ledger persists agent_error for both Malformed AND Subprocess flavors distinctly", async () => {
  // The brief's section D: ledger MUST handle BOTH error classes.
  const env = makeRunDir();
  try {
    const w = new LedgerWriter({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    await w.append({
      type: "agent_error",
      at: "1",
      phaseName: "p",
      agentId: "a-1",
      error: agentErrorFromException(new MalformedAgentOutputError({
        agentId: "a-1", cwd: "/x", exitCode: 1, bytes: "b", lineNumber: 1, reason: "parse",
      })),
    });
    await w.append({
      type: "agent_error",
      at: "2",
      phaseName: "p",
      agentId: "a-2",
      error: agentErrorFromException(new AgentSubprocessError({
        agentId: "a-2", exitCode: 137, signal: "SIGKILL",
      })),
    });
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const out = await r.read();
    assert.equal(out.entries.length, 2);
    const e1 = out.entries[0]!;
    const e2 = out.entries[1]!;
    if (e1.type !== "agent_error" || e2.type !== "agent_error") assert.fail("wrong type");
    else {
      assert.equal(e1.error.class, "MalformedAgentOutput");
      assert.equal(e2.error.class, "AgentSubprocess");
      // Distinct fields preserved:
      if (e1.error.class === "MalformedAgentOutput") assert.equal(e1.error.reason, "parse");
      if (e2.error.class === "AgentSubprocess") assert.equal(e2.error.signal, "SIGKILL");
    }
  } finally {
    env.cleanup();
  }
});

// ─── Result entry truncation ──────────────────────────────────────────

test("buildResultEntry: small string → truncated:false", () => {
  const r = buildResultEntry("hello", () => "ts");
  assert.equal(r.truncated, false);
  assert.equal(r.result, "hello");
});

test("buildResultEntry: object stringifies and truncates if >4KB", () => {
  const big = { data: "y".repeat(LEDGER_RESULT_MAX_BYTES + 100) };
  const r = buildResultEntry(big, () => "ts");
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.result, "utf8") <= LEDGER_RESULT_MAX_BYTES);
});

test("buildResultEntry: exactly-4KB string → not truncated", () => {
  const s = "a".repeat(LEDGER_RESULT_MAX_BYTES);
  const r = buildResultEntry(s, () => "ts");
  assert.equal(r.truncated, false);
  assert.equal(Buffer.byteLength(r.result, "utf8"), LEDGER_RESULT_MAX_BYTES);
});

test("buildResultEntry: undefined value → stored as JSON null, not the string \"undefined\"", () => {
  const r = buildResultEntry(undefined, () => "ts");
  assert.equal(r.result, "null");
  assert.equal(r.truncated, false);
});

test("buildResultEntry: null value → stored as JSON null", () => {
  const r = buildResultEntry(null, () => "ts");
  assert.equal(r.result, "null");
  assert.equal(r.truncated, false);
});

// ─── Hand-crafted fixtures ────────────────────────────────────────────

test("fixture: full-run.jsonl replays to done", async () => {
  // Copy the committed fixture into a tmp dir so the reader uses tmpdir.
  const env = makeRunDir();
  try {
    const fixture = readFileSync(join(FIXTURES_DIR, "full-run.jsonl"), "utf8");
    writeFileSync(env.ledgerPath, fixture);
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    assert.equal(result.finalState, "done");
    assert.ok(result.entries.length > 0);
    // The fixture's first entry is `init`.
    assert.equal(result.entries[0]!.type, "init");
  } finally {
    env.cleanup();
  }
});

test("fixture: invalid-transition.jsonl warns + final state = last valid", async () => {
  const env = makeRunDir();
  try {
    const fixture = readFileSync(join(FIXTURES_DIR, "invalid-transition.jsonl"), "utf8");
    writeFileSync(env.ledgerPath, fixture);
    const r = new LedgerReader({ runId: env.runId, resolveLedgerPath: env.resolveLedgerPath });
    const result = await r.read();
    const inv = result.warnings.find((w) => w.kind === "invalid-transition");
    assert.ok(inv, "expected invalid-transition warning");
    // The fixture is laid out so that the final valid state is `running`.
    assert.equal(result.finalState, "running");
  } finally {
    env.cleanup();
  }
});
