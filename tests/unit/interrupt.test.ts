/**
 * tests/unit/interrupt.test.ts — ZONE_HITL ctx.interrupt() pause/route primitive.
 *
 * Covers:
 *   1. ctx.interrupt() resolves with the value injected via waitForInterrupt.
 *   2. Sequential interrupts get deterministic keys (int-0, int-1, ...).
 *   3. ctx.interrupt() with no waitForInterrupt → resolves with opts.default.
 *   4. ctx.interrupt() with no waitForInterrupt + no default → resolves with null.
 *   5. ctx.interrupt() rejects with AbortError when the run aborts mid-wait.
 *   6. Ledger emits interrupt_requested + interrupt_resolved entries (with key).
 *   7. emitOverlayEvent fires interrupt.requested + interrupt.resolved.
 *   8. Replay-perfect: replayResolvedInterrupts short-circuits the call.
 *   9. Validation: opts must be string or { question } object; choices must be string[].
 *  10. WorkflowClient.resume(runId, value) writes a resume-interrupt ctrl line
 *      that is picked up by startCtrlWatcher and resolves the pending interrupt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createRunCtxHost } from "../../src/runtime/runCtx.js";
import { CacheStore } from "../../src/runtime/cache.js";
import { LedgerWriter } from "../../src/runtime/ledger.js";
import { makeSemaphore } from "../../src/runtime/semaphore.js";
import { WorkflowClient } from "../../src/client.js";
import { startCtrlWatcher } from "../../src/runManager.js";
import type { Run } from "../../src/runManager.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface InterruptCtx {
  host: ReturnType<typeof createRunCtxHost>["host"];
  ctrl: AbortController;
  ledgerPath: string;
  runDir: string;
  emittedEvents: Array<{ customType: string; data: Record<string, unknown> }>;
  cleanup: () => void;
}

async function makeInterruptCtx(opts?: {
  waitForInterrupt?: (key: string, signal: AbortSignal) => Promise<unknown>;
  replayResolvedInterrupts?: ReadonlyMap<string, unknown>;
}): Promise<InterruptCtx> {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-int-"));
  const runId = "wf-inttest";
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ctrl = new AbortController();
  const emittedEvents: Array<{ customType: string; data: Record<string, unknown> }> = [];

  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: () => ledgerPath,
  });
  const cache = await CacheStore.open({
    runId,
    resolveCachePath: () => join(runDir, "cache.jsonl"),
    log: () => {},
  });
  const semaphore = makeSemaphore({ cap: 16 });

  const { host } = createRunCtxHost({
    runMeta: {
      id: runId,
      workflowName: "interrupt-test",
      startedAt: new Date().toISOString(),
      cwd: runDir,
      resumed: false,
    },
    input: "",
    runDirAbs: runDir,
    workflowSourceSha256: "deadbeef",
    cache,
    ledger,
    semaphore,
    signal: ctrl.signal,
    perRunAgentCap: 100,
    mockAgents: false,
    cwd: runDir,
    emitOverlayEvent: (customType, data) => {
      emittedEvents.push({ customType, data: data as Record<string, unknown> });
    },
    ...(opts?.waitForInterrupt !== undefined
      ? { waitForInterrupt: opts.waitForInterrupt }
      : {}),
    ...(opts?.replayResolvedInterrupts !== undefined
      ? { replayResolvedInterrupts: opts.replayResolvedInterrupts }
      : {}),
  });

  return {
    host,
    ctrl,
    ledgerPath,
    runDir,
    emittedEvents,
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

function readLedgerEntries(path: string): Array<Record<string, unknown>> {
  try {
    const text = readFileSync(path, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function flushMicrotasks(n = 8): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

// ─── Tests: basic resolution ────────────────────────────────────────────────

test("ctx.interrupt: waitForInterrupt resolves → returns the injected value", async () => {
  let resolveInt!: (value: unknown) => void;
  const ctx = await makeInterruptCtx({
    waitForInterrupt: (_key, _sig) =>
      new Promise<unknown>((res) => { resolveInt = res; }),
  });

  try {
    const p = ctx.host.interrupt({ question: "What next?" });
    await flushMicrotasks();
    resolveInt({ action: "deploy", version: "1.2.3" });

    const result = await p;
    assert.ok(result.ok, "envelope ok");
    assert.deepEqual(result.value, { action: "deploy", version: "1.2.3" });
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: sequential calls get deterministic int-N keys", async () => {
  const seenKeys: string[] = [];
  const ctx = await makeInterruptCtx({
    waitForInterrupt: async (key, _sig) => {
      seenKeys.push(key);
      return key; // echo the key back as the value
    },
  });

  try {
    const r0 = await ctx.host.interrupt({ question: "Q1?" });
    const r1 = await ctx.host.interrupt({ question: "Q2?" });
    const r2 = await ctx.host.interrupt({ question: "Q3?" });

    assert.ok(r0.ok && r1.ok && r2.ok);
    assert.deepEqual(seenKeys, ["int-0", "int-1", "int-2"]);
    assert.equal(r0.value, "int-0");
    assert.equal(r1.value, "int-1");
    assert.equal(r2.value, "int-2");
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: default fallback ────────────────────────────────────────────────

test("ctx.interrupt: no waitForInterrupt + opts.default → returns default immediately", async () => {
  const ctx = await makeInterruptCtx(); // no waitForInterrupt

  try {
    const result = await ctx.host.interrupt({
      question: "Proceed?",
      default: "skip",
    });
    assert.ok(result.ok);
    assert.equal(result.value, "skip");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: no waitForInterrupt + no default → returns null", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const result = await ctx.host.interrupt({ question: "Proceed?" });
    assert.ok(result.ok);
    assert.equal(result.value, null);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: string shorthand → treated as { question }", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const result = await ctx.host.interrupt("Continue?" as unknown);
    assert.ok(result.ok, "string shorthand should be accepted");
    // No default → null.
    assert.equal(result.value, null);
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: abort ───────────────────────────────────────────────────────────

test("ctx.interrupt: abort while waiting → returns error envelope", async () => {
  const ctx = await makeInterruptCtx({
    waitForInterrupt: (_key, signal) =>
      new Promise<unknown>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
  });

  try {
    const p = ctx.host.interrupt({ question: "Dangerous?" });
    await flushMicrotasks();
    ctx.ctrl.abort(new Error("run stopped by user"));

    const result = await p;
    assert.ok(!result.ok, "envelope should be error");
    assert.match(result.error.message, /aborted|stopped/i);
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: ledger entries ──────────────────────────────────────────────────

test("ctx.interrupt: ledger captures interrupt_requested + interrupt_resolved", async () => {
  const ctx = await makeInterruptCtx({
    waitForInterrupt: async () => ({ approved: true, note: "looks good" }),
  });

  try {
    const r = await ctx.host.interrupt({
      question: "Ship to prod?",
      choices: ["yes", "no", "later"],
      default: "later",
    });
    assert.ok(r.ok);

    const entries = readLedgerEntries(ctx.ledgerPath);
    const requested = entries.find((e) => e.type === "interrupt_requested");
    const resolved = entries.find((e) => e.type === "interrupt_resolved");

    assert.ok(requested, "interrupt_requested should be persisted");
    assert.equal(requested!.key, "int-0");
    assert.equal(requested!.question, "Ship to prod?");
    assert.deepEqual(requested!.choices, ["yes", "no", "later"]);
    assert.equal(requested!.default, "later");

    assert.ok(resolved, "interrupt_resolved should be persisted");
    assert.equal(resolved!.key, "int-0");
    assert.deepEqual(resolved!.value, { approved: true, note: "looks good" });
    assert.equal(resolved!.source, "ipc");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: default-resolved entry has source='default'", async () => {
  const ctx = await makeInterruptCtx(); // no waitForInterrupt

  try {
    await ctx.host.interrupt({ question: "Q?", default: "fallback" });

    const entries = readLedgerEntries(ctx.ledgerPath);
    const resolved = entries.find((e) => e.type === "interrupt_resolved");
    assert.ok(resolved);
    assert.equal(resolved!.source, "default");
    assert.equal(resolved!.value, "fallback");
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: overlay events ──────────────────────────────────────────────────

test("ctx.interrupt: emitOverlayEvent fires interrupt.requested + interrupt.resolved", async () => {
  let resolveInt!: (v: unknown) => void;
  const ctx = await makeInterruptCtx({
    waitForInterrupt: (_k, _s) =>
      new Promise<unknown>((res) => { resolveInt = res; }),
  });

  try {
    const p = ctx.host.interrupt({
      question: "Pick a target",
      choices: ["staging", "prod"],
    });
    await flushMicrotasks();

    const requestedEvent = ctx.emittedEvents.find(
      (e) => e.customType === "pi-workflows.interrupt.requested",
    );
    assert.ok(requestedEvent, "requested overlay event should fire");
    assert.equal(requestedEvent!.data.question, "Pick a target");
    assert.deepEqual(requestedEvent!.data.choices, ["staging", "prod"]);
    assert.equal(requestedEvent!.data.key, "int-0");

    resolveInt("prod");
    await p;

    const resolvedEvent = ctx.emittedEvents.find(
      (e) => e.customType === "pi-workflows.interrupt.resolved",
    );
    assert.ok(resolvedEvent, "resolved overlay event should fire");
    assert.equal(resolvedEvent!.data.value, "prod");
    assert.equal(resolvedEvent!.data.source, "ipc");
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: replay-perfect resume ───────────────────────────────────────────

test("ctx.interrupt: replayResolvedInterrupts short-circuits matching key", async () => {
  const replay = new Map<string, unknown>([
    ["int-0", "from-prior-run"],
    ["int-1", { saved: true }],
  ]);
  let waitCalled = 0;
  const ctx = await makeInterruptCtx({
    replayResolvedInterrupts: replay,
    waitForInterrupt: async () => {
      waitCalled++;
      throw new Error("waitForInterrupt MUST NOT be called when replay covers the key");
    },
  });

  try {
    const r0 = await ctx.host.interrupt({ question: "Q1?" });
    const r1 = await ctx.host.interrupt({ question: "Q2?" });

    assert.ok(r0.ok && r1.ok);
    assert.equal(r0.value, "from-prior-run");
    assert.deepEqual(r1.value, { saved: true });
    assert.equal(waitCalled, 0, "waitForInterrupt should be skipped on replay");

    // The new ledger gets fresh resolved entries with source='replay'
    // so a future resume of THIS run also short-circuits without
    // walking the prior ledger.
    const entries = readLedgerEntries(ctx.ledgerPath);
    const resolveds = entries.filter((e) => e.type === "interrupt_resolved");
    assert.equal(resolveds.length, 2);
    assert.equal(resolveds[0]!.source, "replay");
    assert.equal(resolveds[1]!.source, "replay");
    // No interrupt_requested entries should be written on a replay-hit.
    const requested = entries.filter((e) => e.type === "interrupt_requested");
    assert.equal(requested.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: replay miss falls through to live wait", async () => {
  // Replay only covers int-0; int-1 must hit the live waitForInterrupt path.
  const replay = new Map<string, unknown>([["int-0", "replayed"]]);
  let liveCalls = 0;
  const ctx = await makeInterruptCtx({
    replayResolvedInterrupts: replay,
    waitForInterrupt: async (key) => {
      liveCalls++;
      return `live-${key}`;
    },
  });

  try {
    const r0 = await ctx.host.interrupt({ question: "Q1?" });
    const r1 = await ctx.host.interrupt({ question: "Q2?" });

    assert.equal(r0.ok && r0.value, "replayed");
    assert.equal(r1.ok && r1.value, "live-int-1");
    assert.equal(liveCalls, 1, "live wait fires only for the un-replayed key");
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: validation ──────────────────────────────────────────────────────

test("ctx.interrupt: missing question → error envelope", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const r = await ctx.host.interrupt({});
    assert.ok(!r.ok);
    assert.match(r.error.message, /question/i);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: choices must be string[] → error envelope", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const r = await ctx.host.interrupt({
      question: "Pick",
      choices: [1, 2, 3] as unknown as string[],
    });
    assert.ok(!r.ok);
    assert.match(r.error.message, /choices/i);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: non-object opts → error envelope", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const r = await ctx.host.interrupt(42 as unknown);
    assert.ok(!r.ok);
    assert.match(r.error.message, /question/i);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt: circular default → error envelope (JSON-clone defense)", async () => {
  const ctx = await makeInterruptCtx();

  try {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const r = await ctx.host.interrupt({
      question: "Q?",
      default: cycle,
    });
    assert.ok(!r.ok);
    assert.match(r.error.message, /default.*JSON-serializable|circular/i);
  } finally {
    ctx.cleanup();
  }
});

// ─── Tests: WorkflowClient.resume + ctrl.jsonl wiring ───────────────────────

interface FakeRun {
  readonly run: Run;
  readonly received: Array<{ value: unknown; key?: string }>;
  readonly terminated: Promise<void>;
  end(): void;
}

function makeFakeRun(): FakeRun {
  const received: Array<{ value: unknown; key?: string }> = [];
  let resolveTerminated!: () => void;
  const terminated = new Promise<void>((r) => { resolveTerminated = r; });
  const noop = () => {};
  const run = {
    runId: "wf-fake",
    runDirAbs: "/dev/null",
    promise: new Promise<unknown>(() => {}),
    signal: new AbortController().signal,
    getFinishCallbackPrompt: () => null,
    cancel: noop,
    approvalDecision: null,
    pause: async () => false,
    resumePaused: async () => false,
    stop: noop,
    respondGate: noop,
    respondInterrupt: (value: unknown, key?: string): boolean => {
      received.push(key !== undefined ? { value, key } : { value });
      return true;
    },
    stopAgent: noop,
    restartAgent: noop,
    terminated,
  } as unknown as Run;
  return {
    run,
    received,
    terminated: terminated as unknown as Promise<void>,
    end: () => resolveTerminated(),
  };
}

test("WorkflowClient.resume: writes resume-interrupt ctrl line picked up by watcher", async () => {
  const runsHome = mkdtempSync(join(tmpdir(), "pi-wf-resume-"));
  const runId = "wf-resume01";
  const dir = join(runsHome, runId);
  const fr = makeFakeRun();
  // The watcher reads ctrl.jsonl in the run dir.
  Object.defineProperty(fr.run, "runDirAbs", { value: dir });

  try {
    // Mount the watcher on the temp run dir BEFORE writing ctrl lines.
    startCtrlWatcher(dir, fr.run, {
      // Tight poll so the test finishes quickly.
      pollIntervalMs: 25,
    });

    const client = new WorkflowClient({ runsHome });
    await client.resume(runId, { approved: true, version: "v2" });

    // Wait for the watcher to pick the line up.
    const deadline = Date.now() + 2000;
    while (fr.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(fr.received.length, 1, "respondInterrupt should be invoked");
    assert.deepEqual(fr.received[0]!.value, { approved: true, version: "v2" });
    assert.equal(fr.received[0]!.key, undefined);
  } finally {
    fr.end();
    rmSync(runsHome, { recursive: true, force: true });
  }
});

test("WorkflowClient.resume: with explicit key forwards the key field", async () => {
  const runsHome = mkdtempSync(join(tmpdir(), "pi-wf-resume-"));
  const runId = "wf-resume02";
  const dir = join(runsHome, runId);
  const fr = makeFakeRun();
  Object.defineProperty(fr.run, "runDirAbs", { value: dir });

  try {
    startCtrlWatcher(dir, fr.run, { pollIntervalMs: 25 });

    const client = new WorkflowClient({ runsHome });
    await client.resume(runId, "answer-A", { key: "int-7" });

    const deadline = Date.now() + 2000;
    while (fr.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(fr.received.length, 1);
    assert.equal(fr.received[0]!.value, "answer-A");
    assert.equal(fr.received[0]!.key, "int-7");
  } finally {
    fr.end();
    rmSync(runsHome, { recursive: true, force: true });
  }
});

test("WorkflowClient.resume: rejects non-JSON-cloneable value before writing", async () => {
  const runsHome = mkdtempSync(join(tmpdir(), "pi-wf-resume-"));
  const runId = "wf-resume03";

  try {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const client = new WorkflowClient({ runsHome });
    await assert.rejects(
      () => client.resume(runId, cycle),
      /JSON-serializable|circular/i,
    );
  } finally {
    rmSync(runsHome, { recursive: true, force: true });
  }
});
