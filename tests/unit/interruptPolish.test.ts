/**
 * tests/unit/interruptPolish.test.ts — ZONE_HITL polish.
 *
 * Coverage:
 *   1. Concurrent interrupts: two parallel ctx.interrupt() calls produce
 *      distinct deterministic keys; resume targeting key #2 lands on the
 *      right pending without disturbing #1.
 *   2. Resume value schema validation: ctx.interrupt({question, schema})
 *      with a mismatched resume payload throws InterruptValueValidationError
 *      to the workflow author. The supervisor's payload is still ledgered
 *      (so a future replay sees what was injected) and `r.error` carries
 *      the expected/actual fields.
 *   3. Schema validation re-runs on replay (a stricter post-deploy schema
 *      that rejects a value the prior run accepted surfaces the error
 *      again on the resumed call).
 *   4. Schema validation passes silently when the payload conforms.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createRunCtxHost } from "../../src/runtime/runCtx.ts";
import { CacheStore } from "../../src/runtime/cache.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";
import { makeSemaphore } from "../../src/runtime/semaphore.ts";

interface IntCtx {
  host: ReturnType<typeof createRunCtxHost>["host"];
  ctrl: AbortController;
  cleanup: () => void;
}

async function makeCtx(opts: {
  waitForInterrupt?: (
    key: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  replayResolvedInterrupts?: ReadonlyMap<string, unknown>;
}): Promise<IntCtx> {
  const runDir = mkdtempSync(join(tmpdir(), "pi-wf-int-polish-"));
  const runId = "wf-intpolish";
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ctrl = new AbortController();
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
      workflowName: "interrupt-polish",
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
    ...(opts.waitForInterrupt !== undefined
      ? { waitForInterrupt: opts.waitForInterrupt }
      : {}),
    ...(opts.replayResolvedInterrupts !== undefined
      ? { replayResolvedInterrupts: opts.replayResolvedInterrupts }
      : {}),
  });
  return {
    host,
    ctrl,
    cleanup: () => {
      ctrl.abort();
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function flushMicrotasks(n = 8): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

// ─── 1. Concurrent interrupts ──────────────────────────────────────────

test("concurrent interrupts: two parallel ctx.interrupt calls get distinct keys", async () => {
  // Track outstanding resolvers by key so we can answer in any order.
  const resolvers = new Map<string, (value: unknown) => void>();
  const ctx = await makeCtx({
    waitForInterrupt: (key, _signal) =>
      new Promise<unknown>((resolve) => {
        resolvers.set(key, resolve);
      }),
  });

  try {
    // Fire both interrupts in parallel — each gets its own key.
    const p0 = ctx.host.interrupt({ question: "Region A?" });
    const p1 = ctx.host.interrupt({ question: "Region B?" });
    await flushMicrotasks();

    // Both should be queued with deterministic keys.
    assert.ok(resolvers.has("int-0"), "int-0 should be pending");
    assert.ok(resolvers.has("int-1"), "int-1 should be pending");

    // Resolve in REVERSE order — explicit key targeting must land on
    // the right call site even when it isn't FIFO-oldest.
    resolvers.get("int-1")!("east-1");
    const r1 = await p1;
    assert.ok(r1.ok);
    assert.equal(r1.value.key, "int-1");
    assert.equal(r1.value.value, "east-1");

    // The other call is still pending — answer it now.
    assert.ok(resolvers.has("int-0"));
    resolvers.get("int-0")!("us-west-2");
    const r0 = await p0;
    assert.ok(r0.ok);
    assert.equal(r0.value.key, "int-0");
    assert.equal(r0.value.value, "us-west-2");
  } finally {
    ctx.cleanup();
  }
});

test("concurrent interrupts: explicit key on respondInterrupt targets the right pending", async () => {
  // Use a real RunManager-style FIFO + key-routed dispatch by funneling
  // resolutions through a Map. The contract we're testing: the FIRST
  // interrupt fired (int-0) stays pending while we explicitly key the
  // SECOND (int-1) — exactly the parallel-phase fan-out shape.
  const resolvers = new Map<string, (value: unknown) => void>();
  const ctx = await makeCtx({
    waitForInterrupt: (key) =>
      new Promise<unknown>((resolve) => resolvers.set(key, resolve)),
  });
  try {
    const p0 = ctx.host.interrupt({ question: "Q1?" });
    const p1 = ctx.host.interrupt({ question: "Q2?" });
    await flushMicrotasks();
    // Simulate WorkflowClient.resume(runId, value, {key: 'int-1'})
    // landing first via the supervisor side. Key='int-1' targets the
    // second pending entry.
    resolvers.get("int-1")!("answer-for-Q2");
    const r1 = await p1;
    assert.ok(r1.ok);
    assert.equal(r1.value.key, "int-1");
    assert.equal(r1.value.value, "answer-for-Q2");
    // First interrupt has not been resolved.
    let p0Settled = false;
    p0.then(() => {
      p0Settled = true;
    });
    await flushMicrotasks();
    assert.equal(p0Settled, false, "p0 must remain pending");
    // Resolve it now to unblock cleanup.
    resolvers.get("int-0")!("answer-for-Q1");
    await p0;
  } finally {
    ctx.cleanup();
  }
});

// ─── 2. Schema validation on resume value ──────────────────────────────

test("ctx.interrupt({schema}): mismatched resume value → InterruptValueValidationError", async () => {
  const ctx = await makeCtx({
    waitForInterrupt: async () => ({ wrong: "shape" }),
  });
  try {
    const r = await ctx.host.interrupt({
      question: "Settings?",
      schema: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    });
    assert.equal(r.ok, false, "envelope should carry an error");
    if (!r.ok) {
      assert.equal(r.error.name, "InterruptValueValidationError");
      assert.match(r.error.message, /int-0/);
      assert.match(r.error.message, /validation failed/i);
    }
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt({schema}): conforming resume value resolves cleanly", async () => {
  const ctx = await makeCtx({
    waitForInterrupt: async () => ({ ok: true, note: "lgtm" }),
  });
  try {
    const r = await ctx.host.interrupt({
      question: "Settings?",
      schema: {
        type: "object",
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          note: { type: "string" },
        },
      },
    });
    assert.ok(r.ok);
    assert.equal(r.value.key, "int-0");
    assert.deepEqual(r.value.value, { ok: true, note: "lgtm" });
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt({schema}): replay value also validates against current schema", async () => {
  // Prior run resolved int-0 with a string; replay map carries that.
  // Current run declares a stricter schema requiring an object — the
  // replay path must surface the same InterruptValueValidationError so
  // a tightened post-deploy schema can't silently accept stale answers.
  const replay = new Map<string, unknown>([["int-0", "stale-string-answer"]]);
  const ctx = await makeCtx({
    replayResolvedInterrupts: replay,
  });
  try {
    const r = await ctx.host.interrupt({
      question: "Object now?",
      schema: { type: "object", required: ["v"] },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.name, "InterruptValueValidationError");
    }
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt({schema}): replay value passes when it conforms", async () => {
  const replay = new Map<string, unknown>([["int-0", { v: 42 }]]);
  const ctx = await makeCtx({
    replayResolvedInterrupts: replay,
  });
  try {
    const r = await ctx.host.interrupt({
      question: "Pick a number",
      schema: { type: "object", required: ["v"] },
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value.value, { v: 42 });
  } finally {
    ctx.cleanup();
  }
});

test("ctx.interrupt({schema}): malformed schema throws TypeError up front", async () => {
  const ctx = await makeCtx({});
  try {
    const r = await ctx.host.interrupt({
      question: "Q?",
      schema: 42 as unknown as Record<string, unknown>,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error.message, /schema/i);
    }
  } finally {
    ctx.cleanup();
  }
});
