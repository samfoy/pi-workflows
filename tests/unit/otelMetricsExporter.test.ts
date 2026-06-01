/**
 * tests/unit/otelMetricsExporter.test.ts — ZONE_OTEL: metrics export.
 *
 * Coverage matrix:
 *   - resolveOtelMetricsEndpoint: env vars (root + metrics-specific)
 *     honored, trim, empty-string treated as unset.
 *   - createOtelMetricsExporter: returns disabled handle when no env
 *     / no SDK is loadable; tail* methods return null.
 *   - Pure replay (`replayLedgerToMetrics`) emits the documented
 *     counter increments + histogram records from a hand-rolled
 *     ledger, end-to-end through an InMemoryMetricExporter.
 *   - Each counter is exercised independently:
 *       • pi.runs.started on `init`
 *       • pi.runs.completed on terminal `transition` (per-outcome)
 *       • pi.agents.invoked on `agent_start`
 *       • pi.agents.errored on `agent_error`
 *   - Each histogram is exercised independently:
 *       • gen_ai.client.token.usage on `agent_end.usage` (input/output)
 *       • gen_ai.client.operation.duration on `agent_end.durationMs`
 *       • pi.run.duration on init→terminal-transition wall time
 *   - End-to-end tail loop: write a small ledger.jsonl in tmpdir,
 *     start the metrics tailer, observe the same metrics the pure
 *     replay produces, and confirm the loop exits once the run is
 *     done.
 *   - OTEL_RESOURCE_ATTRIBUTES merges into the MeterProvider Resource
 *     and surfaces on collected ResourceMetrics.
 */

import { test, type TestContext } from "node:test";
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

import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

import {
  _resetOtelMetricsSdkCacheForTests,
  createMetricReplayState,
  createMetricsInstruments,
  createOtelMetricsExporter,
  feedLedgerEntryToMetrics,
  loadOtelMetricsSdk,
  replayLedgerToMetrics,
  resolveOtelMetricsEndpoint,
  tailRunLedgerForMetrics,
  type LoadedOtelMetricsSdk,
  type OtelMetricsInstruments,
} from "../../src/runtime/otelMetricsExporter.ts";
import type { LedgerEntry } from "../../src/types/internal.d.ts";

// ─── Test rig ──────────────────────────────────────────────────────────
//
// Each test that creates a rig MUST register cleanup via `t.after`.
// PeriodicExportingMetricReader holds an unref'd interval timer; if
// no other ref'd I/O keeps the event loop alive, Node's `beforeExit`
// hook can fire mid-test and shut the provider down out from under
// us — turning subsequent counter.add() into a silent no-op (the
// instrument keeps existing but its meter is inert per
// MeterProvider.shutdown semantics). Witnessed once before this
// guard was added.

interface TestRig {
  exporter: InMemoryMetricExporter;
  reader: PeriodicExportingMetricReader;
  provider: MeterProvider;
  instruments: OtelMetricsInstruments;
}

function makeRig(t: TestContext, extraResource?: Record<string, unknown>): TestRig {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  // Long export interval — we drive collection manually via forceFlush.
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const providerOpts: Record<string, unknown> = { readers: [reader] };
  if (extraResource !== undefined) {
    providerOpts["resource"] = makeResource({
      "service.name": "pi-workflows",
      ...extraResource,
    });
  }
  const provider = new MeterProvider(providerOpts as never);
  const meter = provider.getMeter("test", "0.0.0");
  const instruments = createMetricsInstruments({
    createCounter: (n, o) => meter.createCounter(n, o ?? {}),
    createHistogram: (n, o) => meter.createHistogram(n, o ?? {}),
  });
  // Per-test cleanup. Without this, the rig's PeriodicExportingMetricReader
  // and the tailer's polling setTimeout (both unref'd) leave the event
  // loop idle, which lets `beforeExit` race in and shut the provider
  // down mid-test.
  t.after(async () => {
    await provider.shutdown().catch(() => {});
  });
  return { exporter, reader, provider, instruments };
}

// Build a Resource via the public constructor — sdk-metrics v2 takes
// resourceFromAttributes, but the in-memory tests need a minimal one.
function makeResource(attrs: Record<string, unknown>): unknown {
  // Use require-style dynamic so the test file doesn't pull in
  // `@opentelemetry/resources` at the top — the SDK does the resource
  // construction in production.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const resources = require("@opentelemetry/resources") as Record<string, unknown>;
  if (typeof resources["resourceFromAttributes"] === "function") {
    return (resources["resourceFromAttributes"] as (a: Record<string, unknown>) => unknown)(attrs);
  }
  if (typeof resources["Resource"] === "function") {
    const Ctor = resources["Resource"] as new (a: Record<string, unknown>) => unknown;
    return new Ctor(attrs);
  }
  return undefined;
}

async function collect(rig: TestRig): Promise<ResourceMetrics> {
  await rig.provider.forceFlush();
  const batches = rig.exporter.getMetrics();
  assert.ok(batches.length > 0, "exporter should have received at least one batch");
  return batches[batches.length - 1]!;
}

function tmpRunDir(prefix: string): {
  runDir: string;
  ledgerPath: string;
  cleanup: () => void;
} {
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
        runId: "wf-abc12345",
        workflowName: "audit",
        input: "fix bugs",
      },
    },
    { type: "transition", at: "2026-05-28T00:00:01.000Z", from: "pending", to: "approved" },
    { type: "transition", at: "2026-05-28T00:00:02.000Z", from: "approved", to: "running" },
    { type: "phase_start", at: "2026-05-28T00:00:03.000Z", phaseName: "discover", agentCount: 2 },
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
    { type: "transition", at: "2026-05-28T00:00:24.000Z", from: "running", to: "done" },
  ];
}

// ─── Helpers for asserting the exported batch ──────────────────────────

interface FlatPoint {
  attributes: Record<string, unknown>;
  value: number;
  buckets?: { boundaries: number[]; counts: number[] };
  count?: number;
  sum?: number;
}

function pointsFor(rm: ResourceMetrics, name: string): FlatPoint[] {
  const out: FlatPoint[] = [];
  for (const sm of rm.scopeMetrics) {
    for (const md of sm.metrics) {
      if (md.descriptor.name !== name) continue;
      for (const dp of md.dataPoints) {
        const flat: FlatPoint = {
          attributes: dp.attributes as Record<string, unknown>,
          value: typeof dp.value === "number" ? dp.value : 0,
        };
        if (md.dataPointType === DataPointType.HISTOGRAM) {
          const v = dp.value as { count: number; sum?: number; buckets: { boundaries: number[]; counts: number[] } };
          flat.value = v.count;
          flat.count = v.count;
          if (v.sum !== undefined) flat.sum = v.sum;
          flat.buckets = v.buckets;
        }
        out.push(flat);
      }
    }
  }
  return out;
}

function pointMatching(
  points: FlatPoint[],
  matcher: Record<string, unknown>,
): FlatPoint | undefined {
  return points.find((p) =>
    Object.entries(matcher).every(([k, v]) => p.attributes[k] === v),
  );
}

// ─── resolveOtelMetricsEndpoint ────────────────────────────────────────

test("resolveOtelMetricsEndpoint: metrics-specific wins over root", () => {
  assert.equal(
    resolveOtelMetricsEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://root/",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://metrics/",
    }),
    "http://metrics/",
  );
});

test("resolveOtelMetricsEndpoint: root falls through when metrics unset", () => {
  assert.equal(
    resolveOtelMetricsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://root/" }),
    "http://root/",
  );
});

test("resolveOtelMetricsEndpoint: unset / blank → null", () => {
  assert.equal(resolveOtelMetricsEndpoint({}), null);
  assert.equal(
    resolveOtelMetricsEndpoint({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "" }),
    null,
  );
  assert.equal(
    resolveOtelMetricsEndpoint({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "   " }),
    null,
  );
});

test("resolveOtelMetricsEndpoint: trims whitespace", () => {
  assert.equal(
    resolveOtelMetricsEndpoint({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "  http://x/  ",
    }),
    "http://x/",
  );
});

// ─── createOtelMetricsExporter (env-disabled path) ─────────────────────

test("createOtelMetricsExporter: returns disabled handle when no endpoint configured", async () => {
  const handle = await createOtelMetricsExporter({ env: {} });
  assert.equal(handle.enabled, false);
  assert.equal(handle.tailRun("wf-x"), null);
  assert.equal(handle.tailRunDir("/run/wf-x"), null);
  await handle.flush();
  await handle.shutdown();
});

test("createOtelMetricsExporter: enabled handle with sdkOverride forwards to tail", async (t) => {
  const rig = makeRig(t);
  const sdk: LoadedOtelMetricsSdk = {
    provider: rig.provider as unknown as LoadedOtelMetricsSdk["provider"],
    meter: {
      createCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
    },
    instruments: rig.instruments,
  };
  const handle = await createOtelMetricsExporter({ sdkOverride: sdk });
  assert.equal(handle.enabled, true);
  await handle.flush();
  await handle.shutdown();
});

// ─── Pure replay: counters ─────────────────────────────────────────────

test("replayLedgerToMetrics: pi.runs.started increments once on init", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.runs.started");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.attributes["workflow_name"], "audit");
  assert.equal(points[0]!.value, 1);
});

test("replayLedgerToMetrics: pi.runs.completed records terminal outcome=done", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.runs.completed");
  const done = pointMatching(points, { workflow_name: "audit", outcome: "done" });
  assert.ok(done, "done point recorded");
  assert.equal(done!.value, 1);
});

test("replayLedgerToMetrics: pi.runs.completed maps stopped/cancelled-pre-run → cancelled", async (t) => {
  const rig = makeRig(t);
  const stopped: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r1", workflowName: "wf-stop" } },
    { type: "transition", at: ts(), from: "running", to: "stopped" },
  ];
  const cancelled: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r2", workflowName: "wf-cancel" } },
    { type: "transition", at: ts(), from: "approved", to: "cancelled-pre-run" },
  ];
  replayLedgerToMetrics(stopped, rig.instruments);
  replayLedgerToMetrics(cancelled, rig.instruments, createMetricReplayState());
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.runs.completed");
  assert.ok(pointMatching(points, { workflow_name: "wf-stop", outcome: "cancelled" }));
  assert.ok(pointMatching(points, { workflow_name: "wf-cancel", outcome: "cancelled" }));
});

test("replayLedgerToMetrics: pi.runs.completed records outcome=failed", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r-f", workflowName: "boom" } },
    { type: "transition", at: ts(), from: "running", to: "failed", reason: "boom" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.runs.completed");
  const fail = pointMatching(points, { workflow_name: "boom", outcome: "failed" });
  assert.ok(fail);
  assert.equal(fail!.value, 1);
});

test("replayLedgerToMetrics: pi.agents.invoked counts each agent_start (collapsed by phase, no agent_id)", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.agents.invoked");
  // Cardinality fix: agent_id is no longer a label, so the two
  // discover-* agent_start entries collapse into a single point
  // with value 2.
  assert.equal(points.length, 1);
  const d = pointMatching(points, {
    workflow_name: "audit",
    phase_name: "discover",
  });
  assert.ok(d);
  assert.equal(d!.value, 2);
  assert.equal(d!.attributes["agent_id"], undefined, "agent_id label must not be emitted");
});

test("replayLedgerToMetrics: pi.agents.errored counts each agent_error with error_class", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r-e", workflowName: "x" } },
    { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" },
    {
      type: "agent_error",
      at: ts(),
      phaseName: "p",
      agentId: "a",
      error: { class: "AgentSubprocess", message: "exit 137", exitCode: 137 } as never,
    },
    { type: "transition", at: ts(), from: "running", to: "failed" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.agents.errored");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.attributes["workflow_name"], "x");
  assert.equal(points[0]!.attributes["phase_name"], "p");
  assert.equal(points[0]!.attributes["agent_id"], undefined, "agent_id label removed for cardinality");
  assert.equal(points[0]!.attributes["error_class"], "AgentSubprocess");
  assert.equal(points[0]!.value, 1);
});

test("replayLedgerToMetrics: pi.agents.errored falls back to error_class=Unknown when class missing", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } },
    {
      type: "agent_error",
      at: ts(),
      phaseName: "p",
      agentId: "a",
      error: { message: "no class set" } as never,
    },
    { type: "transition", at: ts(), from: "running", to: "failed" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.agents.errored");
  assert.equal(points[0]!.attributes["error_class"], "Unknown");
});

// ─── Pure replay: histograms ───────────────────────────────────────────

test("replayLedgerToMetrics: gen_ai.client.token.usage records input + output as separate points", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "gen_ai.client.token.usage");
  const inputPoints = points.filter((p) => p.attributes["gen_ai.token.type"] === "input");
  const outputPoints = points.filter((p) => p.attributes["gen_ai.token.type"] === "output");
  assert.equal(inputPoints.length, 1, "single attr-set for input → one cumulative point");
  assert.equal(outputPoints.length, 1, "single attr-set for output → one cumulative point");
  // Two agent_end events: input=100,80 → sum=180; output=50,40 → sum=90.
  assert.equal(inputPoints[0]!.sum, 180);
  assert.equal(inputPoints[0]!.count, 2);
  assert.equal(outputPoints[0]!.sum, 90);
  assert.equal(outputPoints[0]!.count, 2);
  assert.equal(inputPoints[0]!.attributes["gen_ai.system"], "pi.workflows");
});

test("replayLedgerToMetrics: gen_ai.client.token.usage skips zero-token recordings", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } },
    { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" },
    {
      type: "agent_end",
      at: ts(),
      phaseName: "p",
      agentId: "a",
      durationMs: 100,
      // input=0 → no record. output=5 → recorded.
      usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      cached: false,
    },
    { type: "transition", at: ts(), from: "running", to: "done" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "gen_ai.client.token.usage");
  // Only the output point exists.
  const inputPoints = points.filter((p) => p.attributes["gen_ai.token.type"] === "input");
  const outputPoints = points.filter((p) => p.attributes["gen_ai.token.type"] === "output");
  assert.equal(inputPoints.length, 0);
  assert.equal(outputPoints.length, 1);
  assert.equal(outputPoints[0]!.sum ?? 0, 5);
});

test("replayLedgerToMetrics: gen_ai.client.operation.duration records seconds, omits cached agents", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "gen_ai.client.operation.duration");
  // Both agents have durationMs=5000 → 5s each. Two recordings, sum=10s.
  assert.equal(points.length, 1);
  assert.equal(points[0]!.count, 2);
  assert.equal(points[0]!.sum, 10);
  assert.equal(points[0]!.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(points[0]!.attributes["gen_ai.system"], "pi.workflows");
});

test("replayLedgerToMetrics: cached agent_end skipped from operation.duration histogram", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } },
    { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" },
    {
      type: "agent_end",
      at: ts(),
      phaseName: "p",
      agentId: "a",
      durationMs: 9999,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      cached: true,
    },
    { type: "transition", at: ts(), from: "running", to: "done" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "gen_ai.client.operation.duration");
  assert.equal(points.length, 0, "cached agent_end emits no duration histogram point");
});

test("replayLedgerToMetrics: pi.run.duration records init→terminal-transition wall time", async (t) => {
  const rig = makeRig(t);
  replayLedgerToMetrics(makeFixture(), rig.instruments);
  const rm = await collect(rig);
  const points = pointsFor(rm, "pi.run.duration");
  // init at 00:00, transition→done at 00:24 → 24s.
  assert.equal(points.length, 1);
  assert.equal(points[0]!.count, 1);
  assert.equal(points[0]!.sum, 24);
  assert.equal(points[0]!.attributes["workflow_name"], "audit");
  assert.equal(points[0]!.attributes["outcome"], "done");
  // Bucket boundaries match the documented Gen-AI-aligned set.
  assert.deepEqual(
    points[0]!.buckets!.boundaries,
    [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200],
  );
});

test("replayLedgerToMetrics: terminal transition recorded only once even on duplicates", async (t) => {
  const rig = makeRig(t);
  const fixture: LedgerEntry[] = [
    { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } },
    { type: "transition", at: ts(), from: "running", to: "done" },
    // Duplicate terminal transition (resume-from-disk replays could
    // theoretically produce one). The state guard suppresses it.
    { type: "transition", at: ts(), from: "running", to: "done" },
  ];
  replayLedgerToMetrics(fixture, rig.instruments);
  const rm = await collect(rig);
  const completed = pointsFor(rm, "pi.runs.completed");
  assert.equal(completed[0]!.value, 1, "no double-count on duplicate terminal transition");
});

// ─── Tailer end-to-end ─────────────────────────────────────────────────

test("tailRunLedgerForMetrics: tails a real ledger.jsonl, exits when terminal transition lands", async (t) => {
  const env = tmpRunDir("pi-wf-otel-metrics-tail-");
  try {
    const rig = makeRig(t);
    const head = makeFixture().slice(0, 4);
    writeFileSync(
      env.ledgerPath,
      head.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const handle = tailRunLedgerForMetrics({
      resolveLedgerPath: () => env.ledgerPath,
      instruments: rig.instruments,
      pollIntervalMs: 25,
    });
    await handle.drainNow();
    const tail = makeFixture().slice(4);
    appendFileSync(
      env.ledgerPath,
      tail.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await handle.done;
    const rm = await collect(rig);
    const started = pointsFor(rm, "pi.runs.started");
    assert.equal(started[0]!.value, 1);
    const completed = pointsFor(rm, "pi.runs.completed");
    assert.ok(pointMatching(completed, { workflow_name: "audit", outcome: "done" }));
    const invoked = pointsFor(rm, "pi.agents.invoked");
    // After cardinality fix: 2 agent_starts in same phase collapse to 1
    // point with value 2 (no agent_id label to split them).
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0]!.value, 2);
    const tokens = pointsFor(rm, "gen_ai.client.token.usage");
    assert.ok(tokens.length >= 1);
  } finally {
    env.cleanup();
  }
});

test("tailRunLedgerForMetrics: tolerates missing ledger file and abort signal", async (t) => {
  const env = tmpRunDir("pi-wf-otel-metrics-missing-");
  try {
    const rig = makeRig(t);
    const ac = new AbortController();
    const handle = tailRunLedgerForMetrics({
      resolveLedgerPath: () => env.ledgerPath,
      instruments: rig.instruments,
      pollIntervalMs: 10,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await handle.done;
    // No metrics produced (no ledger entries).
    const rm = rig.exporter.getMetrics();
    if (rm.length > 0) {
      const started = pointsFor(rm[rm.length - 1]!, "pi.runs.started");
      assert.equal(started.length, 0);
    }
  } finally {
    env.cleanup();
  }
});

test("tailRunLedgerForMetrics: corrupt JSON line is skipped", async (t) => {
  const env = tmpRunDir("pi-wf-otel-metrics-corrupt-");
  try {
    const rig = makeRig(t);
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
    const handle = tailRunLedgerForMetrics({
      resolveLedgerPath: () => env.ledgerPath,
      instruments: rig.instruments,
      pollIntervalMs: 10,
    });
    await handle.done;
    const rm = await collect(rig);
    const started = pointsFor(rm, "pi.runs.started");
    assert.equal(started[0]!.value, 1);
    const completed = pointsFor(rm, "pi.runs.completed");
    assert.equal(completed[0]!.value, 1);
  } finally {
    env.cleanup();
  }
});

// ─── feedLedgerEntryToMetrics: defensive paths ─────────────────────────

test("feedLedgerEntryToMetrics: agent_start before init still increments counter (workflow_name='')", async (t) => {
  const rig = makeRig(t);
  const state = createMetricReplayState();
  // No init yet — workflow_name falls back to "".
  feedLedgerEntryToMetrics(
    state,
    { type: "agent_start", at: ts(), phaseName: "p", agentId: "a", promptHash: "h" },
    rig.instruments,
  );
  const rm = await collect(rig);
  const invoked = pointsFor(rm, "pi.agents.invoked");
  assert.equal(invoked[0]!.attributes["workflow_name"], "");
  assert.equal(invoked[0]!.attributes["phase_name"], "p");
});

test("feedLedgerEntryToMetrics: non-terminal transition does not record completion", async (t) => {
  const rig = makeRig(t);
  const state = createMetricReplayState();
  feedLedgerEntryToMetrics(
    state,
    { type: "init", at: ts(), manifest: { runId: "r", workflowName: "x" } },
    rig.instruments,
  );
  feedLedgerEntryToMetrics(
    state,
    { type: "transition", at: ts(), from: "pending", to: "approved" },
    rig.instruments,
  );
  feedLedgerEntryToMetrics(
    state,
    { type: "transition", at: ts(), from: "approved", to: "running" },
    rig.instruments,
  );
  const rm = await collect(rig);
  const completed = pointsFor(rm, "pi.runs.completed");
  assert.equal(completed.length, 0, "non-terminal transitions emit nothing");
});

// ─── OTEL_RESOURCE_ATTRIBUTES end-to-end ───────────────────────────────

test("loadOtelMetricsSdk: extraResourceAttributes land on the MeterProvider Resource", async () => {
  _resetOtelMetricsSdkCacheForTests();
  const sdk = await loadOtelMetricsSdk({
    endpoint: "http://localhost:0/v1/metrics",
    extraResourceAttributes: {
      "deployment.environment": "test",
      team: "workflows",
    },
  });
  assert.ok(sdk, "metrics SDK loaded");
  // Provider exposes the resource via internal field — same approach
  // as the trace exporter's own test seam.
  const internal = sdk!.provider as unknown as {
    _sharedState?: { resource?: { attributes?: Record<string, unknown> } };
    _resource?: { attributes?: Record<string, unknown> };
  };
  const attrs =
    internal._sharedState?.resource?.attributes ??
    internal._resource?.attributes ??
    {};
  assert.equal(attrs["deployment.environment"], "test");
  assert.equal(attrs["team"], "workflows");
  assert.equal(attrs["service.name"], "pi-workflows");
  await sdk!.provider.shutdown?.();
  _resetOtelMetricsSdkCacheForTests();
});

test("createOtelMetricsExporter: env OTEL_RESOURCE_ATTRIBUTES flows through to loadOtelMetricsSdk", async () => {
  _resetOtelMetricsSdkCacheForTests();
  const handle = await createOtelMetricsExporter({
    env: {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://localhost:0/v1/metrics",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=ci,team=workflows",
    },
  });
  assert.equal(handle.enabled, true);
  // Cached SDK is the same instance — read its resource.
  const cached = await loadOtelMetricsSdk({
    endpoint: "http://localhost:0/v1/metrics",
  });
  assert.ok(cached);
  const internal = cached!.provider as unknown as {
    _sharedState?: { resource?: { attributes?: Record<string, unknown> } };
    _resource?: { attributes?: Record<string, unknown> };
  };
  const attrs =
    internal._sharedState?.resource?.attributes ??
    internal._resource?.attributes ??
    {};
  assert.equal(attrs["deployment.environment"], "ci");
  assert.equal(attrs["team"], "workflows");
  await handle.shutdown();
  _resetOtelMetricsSdkCacheForTests();
});
