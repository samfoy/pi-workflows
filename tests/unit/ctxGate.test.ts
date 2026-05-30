/**
 * tests/unit/ctxGate.test.ts — ctx.gate() human-in-the-loop primitive.
 *
 * Covers:
 *   1. ctx.gate() returns true when respondGate(true) is called.
 *   2. ctx.gate() returns false when respondGate(false) is called.
 *   3. ctx.gate() resolves with defaultAnswer when no waitForGate is wired.
 *   4. ctx.gate() rejects with AbortError when run is aborted while waiting.
 *   5. Ledger emits gate_requested and gate_resolved entries.
 *   6. emitOverlayEvent fires gate.requested and gate.resolved.
 *   7. Abort before gate is reached is handled cleanly (no pending resolver).
 *   8. Two sequential gates work correctly.
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

// ─── Helpers ────────────────────────────────────────────────────────────────

interface GateCtx {
  host: ReturnType<typeof createRunCtxHost>["host"];
  ctrl: AbortController;
  ledgerPath: string;
  runDir: string;
  emittedEvents: Array<{ customType: string; data: Record<string, unknown> }>;
  cleanup: () => void;
}

async function makeGateCtx(opts?: {
  waitForGate?: (message: string, signal: AbortSignal) => Promise<boolean>;
}): Promise<GateCtx> {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-gate-"));
  const runId = "wf-gatetest";
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
      workflowName: "gate-test",
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
    ...(opts?.waitForGate !== undefined ? { waitForGate: opts.waitForGate } : {}),
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

// ─── Tests ──────────────────────────────────────────────────────────────────

test("ctx.gate: approved=true → resolves with true", async () => {
  let resolveGate!: (approved: boolean) => void;
  const ctx = await makeGateCtx({
    waitForGate: (_msg, _sig) =>
      new Promise<boolean>((res) => { resolveGate = res; }),
  });

  try {
    const gatePromise = ctx.host.gate("Deploy to production?", {});
    await flushMicrotasks();

    // Resolve the gate from the "TUI" side.
    resolveGate(true);

    const result = await gatePromise;
    assert.ok(result.ok, "gate should succeed");
    assert.equal(result.value, true, "should return true");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: approved=false → resolves with false", async () => {
  let resolveGate!: (approved: boolean) => void;
  const ctx = await makeGateCtx({
    waitForGate: (_msg, _sig) =>
      new Promise<boolean>((res) => { resolveGate = res; }),
  });

  try {
    const gatePromise = ctx.host.gate("Delete all data?", {});
    await flushMicrotasks();

    resolveGate(false);

    const result = await gatePromise;
    assert.ok(result.ok, "gate should succeed");
    assert.equal(result.value, false, "should return false");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: no waitForGate → resolves with default=true immediately", async () => {
  const ctx = await makeGateCtx(); // no waitForGate

  try {
    const result = await ctx.host.gate("Proceed?", {});
    assert.ok(result.ok);
    assert.equal(result.value, true, "default answer is true");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: no waitForGate + default=false → resolves with false", async () => {
  const ctx = await makeGateCtx();

  try {
    const result = await ctx.host.gate("Skip dangerous step?", { default: false });
    assert.ok(result.ok);
    assert.equal(result.value, false, "respects opts.default=false");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: abort while waiting → returns error envelope (AbortError)", async () => {
  const ctx = await makeGateCtx({
    waitForGate: (_msg, signal) =>
      new Promise<boolean>((_resolve, reject) => {
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
    const gatePromise = ctx.host.gate("Dangerous operation?", {});
    await flushMicrotasks();

    // Abort the run while gate is pending.
    ctx.ctrl.abort(new Error("run stopped by user"));

    const result = await gatePromise;
    assert.ok(!result.ok, "gate should fail when aborted");
    assert.match(result.error.message, /aborted|stopped/i);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: gate_requested and gate_resolved ledger entries are written", async () => {
  let resolveGate!: (approved: boolean) => void;
  const ctx = await makeGateCtx({
    waitForGate: (_msg, _sig) =>
      new Promise<boolean>((res) => { resolveGate = res; }),
  });

  try {
    const gatePromise = ctx.host.gate("Deploy?", {});
    await flushMicrotasks();
    resolveGate(true);
    await gatePromise;

    const entries = readLedgerEntries(ctx.ledgerPath);
    const requested = entries.find((e) => e.type === "gate_requested");
    const resolved = entries.find((e) => e.type === "gate_resolved");

    assert.ok(requested !== undefined, "gate_requested entry should be in ledger");
    assert.equal(requested!.message, "Deploy?");
    assert.ok(typeof requested!.at === "string", "gate_requested has at timestamp");

    assert.ok(resolved !== undefined, "gate_resolved entry should be in ledger");
    assert.equal(resolved!.approved, true);
    assert.ok(typeof resolved!.at === "string", "gate_resolved has at timestamp");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: emitOverlayEvent fires gate.requested and gate.resolved", async () => {
  let resolveGate!: (approved: boolean) => void;
  const ctx = await makeGateCtx({
    waitForGate: (_msg, _sig) =>
      new Promise<boolean>((res) => { resolveGate = res; }),
  });

  try {
    const gatePromise = ctx.host.gate("Check deployment?", {});
    await flushMicrotasks();

    const requestedEvent = ctx.emittedEvents.find(
      (e) => e.customType === "pi-workflows.gate.requested",
    );
    assert.ok(requestedEvent !== undefined, "gate.requested overlay event should fire");
    assert.equal(requestedEvent!.data.message, "Check deployment?");
    assert.equal(requestedEvent!.data.defaultAnswer, true);

    resolveGate(false);
    await gatePromise;

    const resolvedEvent = ctx.emittedEvents.find(
      (e) => e.customType === "pi-workflows.gate.resolved",
    );
    assert.ok(resolvedEvent !== undefined, "gate.resolved overlay event should fire");
    assert.equal(resolvedEvent!.data.approved, false);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: non-string message → error envelope", async () => {
  const ctx = await makeGateCtx();

  try {
    const result = await ctx.host.gate(42 as unknown as string, {});
    assert.ok(!result.ok, "should return error for non-string message");
    assert.match(result.error.message, /message.*expected string|message must be/i);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: two sequential gates work correctly", async () => {
  const responses: boolean[] = [true, false];
  let callIndex = 0;
  const ctx = await makeGateCtx({
    waitForGate: (_msg, _sig) =>
      Promise.resolve(responses[callIndex++] ?? false),
  });

  try {
    const r1 = await ctx.host.gate("First gate?", {});
    assert.ok(r1.ok);
    assert.equal(r1.value, true);

    const r2 = await ctx.host.gate("Second gate?", { default: false });
    assert.ok(r2.ok);
    assert.equal(r2.value, false);

    assert.equal(callIndex, 2, "waitForGate called twice");
  } finally {
    ctx.cleanup();
  }
});

test("ctx.gate: defaultAnswer propagated to overlay event", async () => {
  const ctx = await makeGateCtx(); // no waitForGate — resolves immediately

  try {
    await ctx.host.gate("Skip?", { default: false });

    const ev = ctx.emittedEvents.find(
      (e) => e.customType === "pi-workflows.gate.requested",
    );
    assert.ok(ev !== undefined);
    assert.equal(ev!.data.defaultAnswer, false);
  } finally {
    ctx.cleanup();
  }
});
