/**
 * tests/unit/otelExporter.test.ts — ZONE_OTEL: OpenTelemetry export.
 *
 * Coverage matrix:
 *   - resolveOtelEndpoint: env vars (root + traces-specific) honored,
 *     trim, empty-string treated as unset.
 *   - createOtelExporter: returns disabled handle when no env / no
 *     SDK is loadable; tail* methods return null.
 *   - Pure replay (`replayLedgerToSpans`) builds the documented
 *     span tree (root → phase → agent) from a hand-rolled ledger.
 *   - Pure replay attaches Gen-AI semantic-convention attributes
 *     (gen_ai.usage.input_tokens, etc.) to agent spans.
 *   - Cache-hit and agent-error paths produce ended spans with the
 *     expected status / attributes.
 *   - End-to-end tail loop: write a small ledger.jsonl in tmpdir,
 *     start the tailer with InMemorySpanExporter, observe the same
 *     span tree the pure replay produces, and confirm the loop exits
 *     once the root span has ended.
 *   - Abandoned-spans path: `endOpenSpans` ends every still-open
 *     span with status=ERROR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import {
  createOtelExporter,
  createReplayState,
  endOpenSpans,
  feedLedgerEntry,
  replayLedgerToSpans,
  resolveOtelEndpoint,
  tailRunLedger,
  type LoadedOtelSdk,
  type OtelApi,
  type OtelTracer,
} from "../../src/runtime/otelExporter.ts";
import type { LedgerEntry } from "../../src/types/internal.d.ts";

// ─── Test rig ──────────────────────────────────────────────────────────

interface TestRig {
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
  tracer: OtelTracer;
  api: OtelApi;
}

function makeRig(): TestRig {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("test", "0.0.0") as unknown as OtelTracer;
  return {
    exporter,
    provider,
    tracer,
    api: otelApi as unknown as OtelApi,
  };
}

function tmpRunDir(prefix: string): { runDir: string; ledgerPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const runId = "wf-" + Math.random().toString(36).slice(2, 14);
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  const ledgerPath = join(runDir, "ledger.jsonl");
  return {
    runDir,
    ledgerPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ts = (() => {
  let n = 0;
  return () => `2026-05-28T00:00:${String(n++).padStart(2, "0")}.000Z`;
})();

function makeFixture(): LedgerEntry[] {
  return [
    {
      type: "init",
      at: "2026-05-28T00:00:00.000Z",
      manifest: {
        runId: "wf-test12345678",
        workflowName: "audit",
        input: "fix bugs",
        piVersion: "0.5.0",
        piWorkflowsVersion: "0.2.0",
      },
    },
    { type: "transition", at: "2026-05-28T00:00:01.000Z", from: "pending", to: "approved" },
    { type: "transition", at: "2026-05-28T00:00:02.000Z", from: "approved", to: "running" },
    {
      type: "phase_start",
      at: "2026-05-28T00:00:03.000Z",
      phaseName: "discover",
      agentCount: 2,
    },
    {
      type: "agent_start",
      at: "2026-05-28T00:00:04.000Z",
      phaseName: "discover",
      agentId: "discover-1",
      promptHash: "h1",
    },
    {
      type: "agent_start",
      at: "2026-05-28T00:00:04.500Z",
      phaseName: "discover",
      agentId: "discover-2",
      promptHash: "h2",
    },
    {
      type: "agent_end",
      at: "2026-05-28T00:00:09.000Z",
      phaseName: "discover",
      agentId: "discover-1",
      durationMs: 5000,
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180 },
      cached: false,
    },
    {
      type: "agent_end",
      at: "2026-05-28T00:00:09.500Z",
      phaseName: "discover",
      agentId: "discover-2",
      durationMs: 5000,
      usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      cached: false,
    },
    {
      type: "phase_end",
      at: "2026-05-28T00:00:10.000Z",
      phaseName: "discover",
      durationMs: 7000,
      agentResults: { ok: 2, error: 0, cacheHit: 0 },
    },
    {
      type: "phase_start",
      at: "2026-05-28T00:00:11.000Z",
      phaseName: "audit",
      agentCount: 1,
    },
    {
      type: "agent_start",
      at: "2026-05-28T00:00:12.000Z",
      phaseName: "audit",
      agentId: "audit-1",
      promptHash: "h3",
    },
    {
      type: "agent_end",
      at: "2026-05-28T00:00:21.000Z",
      phaseName: "audit",
      agentId: "audit-1",
      durationMs: 9000,
      usage: { input: 200, output: 100, cacheRead: 50, cacheWrite: 25, totalTokens: 350 },
      cached: false,
    },
    {
      type: "phase_end",
      at: "2026-05-28T00:00:22.000Z",
      phaseName: "audit",
      durationMs: 11000,
      agentResults: { ok: 1, error: 0, cacheHit: 0 },
    },
    {
      type: "result",
      at: "2026-05-28T00:00:23.000Z",
      truncated: false,
      result: '"ok"',
    },
    { type: "transition", at: "2026-05-28T00:00:24.000Z", from: "running", to: "done" },
  ];
}

// ─── resolveOtelEndpoint ────────────────────────────────────────────────

test("resolveOtelEndpoint: traces-specific wins over root", () => {
  assert.equal(
    resolveOtelEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://root/",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces/",
    }),
    "http://traces/",
  );
});

test("resolveOtelEndpoint: root falls through when traces unset", () => {
  assert.equal(
    resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://root/" }),
    "http://root/",
  );
});

test("resolveOtelEndpoint: unset / blank → null", () => {
  assert.equal(resolveOtelEndpoint({}), null);
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }), null);
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }), null);
});

test("resolveOtelEndpoint: trims whitespace", () => {
  assert.equal(
    resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "  http://x/  " }),
    "http://x/",
  );
});

// ─── createOtelExporter (env-disabled path) ────────────────────────────

test("createOtelExporter: returns disabled handle when no endpoint configured", async () => {
  const handle = await createOtelExporter({ env: {} });
  assert.equal(handle.enabled, false);
  assert.equal(handle.tailRun("wf-x"), null);
  assert.equal(handle.tailRunDir("/run/wf-x"), null);
  await handle.flush();
  await handle.shutdown();
});

test("createOtelExporter: enabled handle with sdkOverride forwards to tail", async () => {
  const rig = makeRig();
  const sdk: LoadedOtelSdk = {
    api: rig.api,
    provider: rig.provider as unknown as LoadedOtelSdk["provider"],
    tracer: rig.tracer,
  };
  const handle = await createOtelExporter({ sdkOverride: sdk });
  assert.equal(handle.enabled, true);
  await handle.flush();
  await handle.shutdown();
});

// ─── Pure replay: span tree shape ──────────────────────────────────────

test("replayLedgerToSpans: emits root → phase → agent tree for a complete fixture", async () => {
  const rig = makeRig();
  const entries = makeFixture();
  replayLedgerToSpans(entries, rig.tracer, rig.api);
  await rig.provider.forceFlush();
  const spans = rig.exporter.getFinishedSpans();
  // 1 root + 2 phases + 3 agents = 6
  assert.equal(spans.length, 6);

  // Find the root by name.
  const root = spans.find((s) => s.name === "invoke_workflow audit");
  assert.ok(root, "root span exists");
  assert.equal(root!.parentSpanContext, undefined);

  // Phases parent to root.
  const phases = spans.filter((s) => s.name.startsWith("phase "));
  assert.equal(phases.length, 2);
  for (const p of phases) {
    assert.equal(p.parentSpanContext?.spanId, root!.spanContext().spanId);
  }

  // Agents parent to their phase.
  const agents = spans.filter((s) => s.name.startsWith("invoke_agent "));
  assert.equal(agents.length, 3);
  for (const a of agents) {
    const phaseName = a.attributes["pi.workflow.phase.name"] as string;
    const phaseSpan = phases.find(
      (p) => p.attributes["pi.workflow.phase.name"] === phaseName,
    );
    assert.ok(phaseSpan, `phase ${phaseName} found`);
    assert.equal(a.parentSpanContext?.spanId, phaseSpan!.spanContext().spanId);
  }
});

test("replayLedgerToSpans: root span carries Gen-AI workflow attributes", async () => {
  const rig = makeRig();
  replayLedgerToSpans(makeFixture(), rig.tracer, rig.api);
  await rig.provider.forceFlush();
  const root = rig.exporter
    .getFinishedSpans()
    .find((s) => s.name === "invoke_workflow audit")!;
  assert.equal(root.attributes["gen_ai.operation.name"], "invoke_workflow");
  assert.equal(root.attributes["gen_ai.provider.name"], "pi.workflows");
  assert.equal(root.attributes["gen_ai.conversation.id"], "wf-test12345678");
  assert.equal(root.attributes["pi.workflow.name"], "audit");
  assert.equal(root.attributes["pi.workflow.run_id"], "wf-test12345678");
  assert.equal(root.attributes["pi.workflow.input"], "fix bugs");
  assert.equal(root.attributes["pi.workflow.final_state"], "done");
  // status.code OK (1).
  assert.equal(root.status.code, 1);
});

test("replayLedgerToSpans: agent spans carry Gen-AI usage attributes", async () => {
  const rig = makeRig();
  replayLedgerToSpans(makeFixture(), rig.tracer, rig.api);
  await rig.provider.forceFlush();
  const agent = rig.exporter
    .getFinishedSpans()
    .find((s) => s.name === "invoke_agent audit-1")!;
  assert.equal(agent.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 200);
  assert.equal(agent.attributes["gen_ai.usage.output_tokens"], 100);
  assert.equal(agent.attributes["gen_ai.usage.cache_read.input_tokens"], 50);
  assert.equal(agent.attributes["gen_ai.usage.cache_creation.input_tokens"], 25);
  assert.equal(agent.attributes["pi.agent.id"], "audit-1");
  assert.equal(agent.attributes["pi.agent.cached"], false);
  assert.equal(agent.attributes["pi.agent.duration_ms"], 9000);
});

test("replayLedgerToSpans: phase span carries result counts + duration", async () => {
  const rig = makeRig();
  replayLedgerToSpans(makeFixture(), rig.tracer, rig.api);
  await rig.provider.forceFlush();
  const phase = rig.exporter
    .getFinishedSpans()
    .find((s) => s.attributes["pi.workflow.phase.name"] === "discover" && s.name.startsWith("phase "))!;
  assert.equal(phase.attributes["pi.workflow.phase.duration_ms"], 7000);
  assert.equal(phase.attributes["pi.workflow.phase.results.ok"], 2);
  assert.equal(phase.attributes["pi.workflow.phase.results.error"], 0);
  assert.equal(phase.attributes["pi.workflow.phase.agent_count"], 2);
});

// ─── agent_error path ──────────────────────────────────────────────────

test("agent_error: ends span with status=ERROR + error.type attribute", async () => {
  const rig = makeRig();
  const state = createReplayState();
  feedLedgerEntry(
    state,
    {
      type: "init",
      at: ts(),
      manifest: { runId: "wf-err", workflowName: "x" },
    },
    rig.tracer,
    rig.api,
  );
  feedLedgerEntry(
    state,
    { type: "phase_start", at: ts(), phaseName: "p", agentCount: 1 },
    rig.tracer,
    rig.api,
  );
  feedLedgerEntry(
    state,
    { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" },
    rig.tracer,
    rig.api,
  );
  feedLedgerEntry(
    state,
    {
      type: "agent_error",
      at: ts(),
      phaseName: "p",
      agentId: "a",
      error: { class: "AgentSubprocess", message: "exit 137", exitCode: 137 } as never,
    },
    rig.tracer,
    rig.api,
  );
  feedLedgerEntry(
    state,
    {
      type: "phase_end",
      at: ts(),
      phaseName: "p",
      durationMs: 100,
      agentResults: { ok: 0, error: 1, cacheHit: 0 },
    },
    rig.tracer,
    rig.api,
  );
  feedLedgerEntry(
    state,
    { type: "transition", at: ts(), from: "running", to: "failed", reason: "boom" },
    rig.tracer,
    rig.api,
  );
  await rig.provider.forceFlush();
  const spans = rig.exporter.getFinishedSpans();
  const agentSpan = spans.find((s) => s.name === "invoke_agent a")!;
  assert.equal(agentSpan.status.code, 2, "ERROR");
  assert.equal(agentSpan.attributes["error.type"], "AgentSubprocess");
  // Phase carries ERROR status when any agent failed.
  const phaseSpan = spans.find((s) => s.name === "phase p")!;
  assert.equal(phaseSpan.status.code, 2);
  // Root span ended with failed final_state.
  const root = spans.find((s) => s.name === "invoke_workflow x")!;
  assert.equal(root.attributes["pi.workflow.final_state"], "failed");
  assert.equal(root.status.code, 2);
});

// ─── agent_cache_hit path ──────────────────────────────────────────────

test("agent_cache_hit: emits a synthetic span with cached=true", async () => {
  const rig = makeRig();
  const state = createReplayState();
  feedLedgerEntry(state, { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "phase_start", at: ts(), phaseName: "p", agentCount: 1 }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "agent_cache_hit", at: ts(), phaseName: "p", agentId: "cached" }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "phase_end", at: ts(), phaseName: "p", durationMs: 1, agentResults: { ok: 0, error: 0, cacheHit: 1 } }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "transition", at: ts(), from: "running", to: "done" }, rig.tracer, rig.api);
  await rig.provider.forceFlush();
  const cached = rig.exporter.getFinishedSpans().find((s) => s.name === "invoke_agent cached")!;
  assert.equal(cached.attributes["pi.agent.cached"], true);
  assert.equal(cached.status.code, 1, "OK");
});

// ─── endOpenSpans ──────────────────────────────────────────────────────

test("endOpenSpans: ends every still-open span with ERROR status", async () => {
  const rig = makeRig();
  const state = createReplayState();
  feedLedgerEntry(state, { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "phase_start", at: ts(), phaseName: "p", agentCount: 1 }, rig.tracer, rig.api);
  feedLedgerEntry(state, { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" }, rig.tracer, rig.api);
  // Run abandoned without phase_end / agent_end / terminal transition.
  endOpenSpans(state, rig.api);
  await rig.provider.forceFlush();
  const spans = rig.exporter.getFinishedSpans();
  // 1 agent + 1 phase + 1 root = 3.
  assert.equal(spans.length, 3);
  for (const s of spans) {
    assert.equal(s.status.code, 2, `${s.name} should be ERROR`);
  }
});

// ─── Tailer end-to-end ─────────────────────────────────────────────────

test("tailRunLedger: tails a real ledger.jsonl, exits when terminal transition lands", async () => {
  const env = tmpRunDir("pi-wf-otel-tail-");
  try {
    const rig = makeRig();
    // Pre-write the init + phase_start so the tailer has something
    // to chew on its first poll.
    const head = makeFixture().slice(0, 4);
    writeFileSync(
      env.ledgerPath,
      head.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const handle = tailRunLedger({
      resolveLedgerPath: () => env.ledgerPath,
      tracer: rig.tracer,
      api: rig.api,
      pollIntervalMs: 25,
    });
    // Drain the head.
    await handle.drainNow();
    // Append the rest in one go.
    const tail = makeFixture().slice(4);
    appendFileSync(
      env.ledgerPath,
      tail.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await handle.done; // resolves once root span ends + drain settles.
    await rig.provider.forceFlush();
    const spans = rig.exporter.getFinishedSpans();
    assert.equal(spans.length, 6);
    assert.ok(spans.some((s) => s.name === "invoke_workflow audit"));
    assert.equal(
      spans.filter((s) => s.name.startsWith("phase ")).length,
      2,
    );
    assert.equal(
      spans.filter((s) => s.name.startsWith("invoke_agent ")).length,
      3,
    );
  } finally {
    env.cleanup();
  }
});

test("tailRunLedger: tolerates missing ledger file (run not yet started)", async () => {
  const env = tmpRunDir("pi-wf-otel-missing-");
  try {
    const rig = makeRig();
    const ac = new AbortController();
    const handle = tailRunLedger({
      resolveLedgerPath: () => env.ledgerPath, // does not exist yet
      tracer: rig.tracer,
      api: rig.api,
      pollIntervalMs: 10,
      signal: ac.signal,
    });
    // Wait a few polls.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await handle.done;
    assert.equal(rig.exporter.getFinishedSpans().length, 0);
  } finally {
    env.cleanup();
  }
});

test("tailRunLedger: corrupt JSON line is skipped (does not crash)", async () => {
  const env = tmpRunDir("pi-wf-otel-corrupt-");
  try {
    const rig = makeRig();
    const goodInit = JSON.stringify({
      type: "init",
      at: "2026-05-28T00:00:00.000Z",
      manifest: { runId: "wf-c", workflowName: "x" },
    });
    const corrupt = "{not json";
    const term = JSON.stringify({
      type: "transition",
      at: "2026-05-28T00:00:01.000Z",
      from: "running",
      to: "done",
    });
    writeFileSync(env.ledgerPath, [goodInit, corrupt, term].join("\n") + "\n");
    const handle = tailRunLedger({
      resolveLedgerPath: () => env.ledgerPath,
      tracer: rig.tracer,
      api: rig.api,
      pollIntervalMs: 10,
    });
    await handle.done;
    await rig.provider.forceFlush();
    const spans = rig.exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.name, "invoke_workflow x");
  } finally {
    env.cleanup();
  }
});

test("tailRunLedger: torn trailing line is buffered until next \\n arrives", async () => {
  const env = tmpRunDir("pi-wf-otel-torn-");
  try {
    const rig = makeRig();
    // Write a partial line WITHOUT a trailing newline.
    const partial = JSON.stringify({
      type: "init",
      at: "2026-05-28T00:00:00.000Z",
      manifest: { runId: "wf-t", workflowName: "x" },
    });
    writeFileSync(env.ledgerPath, partial); // no \n
    const ac = new AbortController();
    const handle = tailRunLedger({
      resolveLedgerPath: () => env.ledgerPath,
      tracer: rig.tracer,
      api: rig.api,
      pollIntervalMs: 10,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    // Still buffered — no spans yet.
    await rig.provider.forceFlush();
    assert.equal(rig.exporter.getFinishedSpans().length, 0);
    // Append the trailing newline + the terminal entry.
    const term = JSON.stringify({
      type: "transition",
      at: "2026-05-28T00:00:01.000Z",
      from: "running",
      to: "done",
    });
    appendFileSync(env.ledgerPath, "\n" + term + "\n");
    await handle.done;
    await rig.provider.forceFlush();
    const spans = rig.exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.name, "invoke_workflow x");
    void ac;
  } finally {
    env.cleanup();
  }
});
