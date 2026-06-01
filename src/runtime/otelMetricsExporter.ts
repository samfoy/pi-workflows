/**
 * pi-workflows — OpenTelemetry metrics exporter (ZONE_OTEL).
 *
 * Companion to {@link ./otelExporter.ts}. Tails `<runDir>/ledger.jsonl`
 * and emits OpenTelemetry metrics following the Gen-AI semantic
 * conventions where applicable:
 *
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
 *
 * Counters
 * --------
 *   - `pi.runs.started`   (workflow_name)
 *   - `pi.runs.completed` (workflow_name, outcome={done|failed|cancelled})
 *   - `pi.agents.invoked` (workflow_name, phase_name)
 *   - `pi.agents.errored` (workflow_name, phase_name, error_class)
 *
 * Migration note (cardinality fix): the `agent_id` label was REMOVED
 * from `pi.agents.invoked` and `pi.agents.errored`. Workflows that
 * mint random agent IDs per run produced unbounded metric series
 * (one per distinct id, multiplied by every other label combination)
 * which broke any monitoring backend with cardinality limits. If you
 * need per-agent attribution, query the trace span attributes
 * (pi.agent.id) instead — spans carry full per-invocation detail and
 * are paid-for separately from metric cardinality budgets.
 *
 * Histograms
 * ----------
 *   - `gen_ai.client.token.usage`         (gen_ai.token.type={input|output},
 *                                          gen_ai.system,
 *                                          gen_ai.request.model?)
 *   - `gen_ai.client.operation.duration`  (gen_ai.operation.name=invoke_agent,
 *                                          gen_ai.system,
 *                                          gen_ai.request.model?)
 *   - `pi.run.duration`                   (workflow_name, outcome) — seconds
 *
 * Activation
 * ----------
 *   - When `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (preferred) or the
 *     catch-all `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, this module is
 *     a strict no-op — no SDK is loaded, no background timers run.
 *   - When set, `@opentelemetry/sdk-metrics` and
 *     `@opentelemetry/exporter-metrics-otlp-http` are loaded via
 *     dynamic `import()`. Missing optional deps fall back to a
 *     disabled handle (a single warning is logged).
 *   - `OTEL_RESOURCE_ATTRIBUTES` is honored — the parser is shared
 *     with the trace exporter (`parseOtelResourceAttributes`).
 *
 * Pure replay
 * -----------
 *   - {@link createMetricReplayState} + {@link feedLedgerEntryToMetrics}
 *     are pure transforms. Tests exercise them directly with an
 *     `InMemoryMetricExporter` so the production code path is the
 *     same code path under test.
 */

import { promises as fsp } from "node:fs";

import type { LedgerEntry, RunState } from "../types/internal.d.ts";
import { ledgerPath as defaultLedgerPath } from "../util/paths.ts";
import { parseOtelResourceAttributes } from "./otelExporter.ts";

// ─── Optional OTel SDK loader ──────────────────────────────────────────

/**
 * Minimal subset of `@opentelemetry/api` Metrics surface we depend on.
 * Typed loosely so the module compiles even when `@opentelemetry/*` is
 * absent at typecheck-time (the deps are optional).
 */
export interface OtelMetricsApi {
  // The metrics API only matters indirectly — instruments come from a
  // Meter, which we obtain from the SDK's MeterProvider. We retain the
  // shape for symmetry with the trace exporter.
  readonly metrics?: unknown;
}

export interface OtelCounter {
  add(value: number, attributes?: Record<string, unknown>): void;
}

export interface OtelHistogram {
  record(value: number, attributes?: Record<string, unknown>): void;
}

export interface OtelMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OtelCounter;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string; advice?: { explicitBucketBoundaries?: number[] } },
  ): OtelHistogram;
}

export interface OtelMeterProvider {
  getMeter(name: string, version?: string): OtelMeter;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

interface LoadedOtelMetricsSdk {
  readonly provider: OtelMeterProvider;
  readonly meter: OtelMeter;
  readonly instruments: OtelMetricsInstruments;
}

/** Public alias — tests use this for the `sdkOverride` test seam. */
export type { LoadedOtelMetricsSdk };

/**
 * The full set of pre-created instruments. Constructed once when the
 * SDK loads so we don't churn instrument descriptors per run.
 */
export interface OtelMetricsInstruments {
  readonly runsStarted: OtelCounter;
  readonly runsCompleted: OtelCounter;
  readonly agentsInvoked: OtelCounter;
  readonly agentsErrored: OtelCounter;
  readonly tokenUsage: OtelHistogram;
  readonly operationDuration: OtelHistogram;
  readonly runDuration: OtelHistogram;
}

const METER_NAME = "@samfp/pi-workflows";
const METER_VERSION = "0.2.0";
/** Maximum bytes allowed in the tailer's partial-line buffer before discarding. Mirrors BUG-W12's cap in jsonStream.ts. */
const MAX_TAILER_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Build the instrument set against an existing meter. Exposed
 * separately so tests can wire the same shape to a hand-rolled meter
 * without going through `loadOtelMetricsSdk`.
 */
export function createMetricsInstruments(meter: OtelMeter): OtelMetricsInstruments {
  return {
    runsStarted: meter.createCounter("pi.runs.started", {
      description: "Number of workflow runs started.",
      unit: "{run}",
    }),
    runsCompleted: meter.createCounter("pi.runs.completed", {
      description:
        "Number of workflow runs completed (any terminal outcome — done, failed, cancelled).",
      unit: "{run}",
    }),
    agentsInvoked: meter.createCounter("pi.agents.invoked", {
      description: "Number of sub-agents dispatched (cache misses only).",
      unit: "{agent}",
    }),
    agentsErrored: meter.createCounter("pi.agents.errored", {
      description: "Number of sub-agent dispatches that errored.",
      unit: "{agent}",
    }),
    // Gen-AI semantic-convention histograms — bucket boundaries match
    // the spec's recommended defaults so dashboards built against
    // upstream Gen-AI conventions render identically.
    //   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      description:
        "Distribution of token counts per agent operation (input + output, recorded as separate data points keyed on gen_ai.token.type).",
      unit: "{token}",
      advice: {
        explicitBucketBoundaries: [
          1, 4, 16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864,
        ],
      },
    }),
    operationDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "Duration of an agent operation, in seconds.",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [
          0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
        ],
      },
    }),
    runDuration: meter.createHistogram("pi.run.duration", {
      description: "Duration of a workflow run, in seconds.",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [
          0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200,
        ],
      },
    }),
  };
}

let _cachedMetricsSdk: LoadedOtelMetricsSdk | null = null;
let _cachedMetricsSdkEndpoint: string | null = null;

/**
 * Load the OTel metrics SDK and wire an OTLP/HTTP exporter against
 * `endpoint`. Returns `null` if any dep is missing or import fails.
 *
 * The first successful call caches its result; subsequent calls with
 * the same `endpoint` reuse the same provider so a chatty workflow
 * shares one PeriodicExportingMetricReader.
 */
export async function loadOtelMetricsSdk(opts: {
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly extraResourceAttributes?: Record<string, string>;
  /** Override the export interval (ms). Default 60_000 (matches OTel). */
  readonly exportIntervalMillis?: number;
  readonly log?: (level: "warn" | "info", msg: string) => void;
}): Promise<LoadedOtelMetricsSdk | null> {
  if (_cachedMetricsSdk !== null && _cachedMetricsSdkEndpoint === opts.endpoint) {
    return _cachedMetricsSdk;
  }
  const log = opts.log ?? (() => {});
  try {
    const [sdkMetrics, exporter, resources] = await Promise.all([
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/resources"),
    ]);

    const otlpExporter = new exporter.OTLPMetricExporter({
      url: opts.endpoint,
    });
    const reader = new sdkMetrics.PeriodicExportingMetricReader({
      exporter: otlpExporter,
      exportIntervalMillis: opts.exportIntervalMillis ?? 60_000,
    });

    const mergedAttrs: Record<string, unknown> = {
      "service.name": opts.serviceName ?? "pi-workflows",
      "service.version": METER_VERSION,
      ...(opts.extraResourceAttributes ?? {}),
    };

    let resource: unknown;
    const resourcesAny = resources as unknown as Record<string, unknown>;
    if (typeof resourcesAny["resourceFromAttributes"] === "function") {
      resource = (
        resourcesAny["resourceFromAttributes"] as (a: Record<string, unknown>) => unknown
      )(mergedAttrs);
    } else if (typeof resourcesAny["Resource"] === "function") {
      const Ctor = resourcesAny["Resource"] as new (a: Record<string, unknown>) => unknown;
      resource = new Ctor(mergedAttrs);
    }

    const providerCtor = sdkMetrics.MeterProvider as unknown as new (
      cfg: Record<string, unknown>,
    ) => OtelMeterProvider;
    const providerCfg: Record<string, unknown> = {
      readers: [reader],
    };
    if (resource !== undefined) providerCfg["resource"] = resource;
    const provider = new providerCtor(providerCfg);
    const meter = provider.getMeter(METER_NAME, METER_VERSION);
    const instruments = createMetricsInstruments(meter);

    const sdk: LoadedOtelMetricsSdk = { provider, meter, instruments };
    _cachedMetricsSdk = sdk;
    _cachedMetricsSdkEndpoint = opts.endpoint;
    return sdk;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(
      "warn",
      `[pi-workflows] OTel metrics endpoint set but @opentelemetry/sdk-metrics deps unavailable — falling back to no-op (${msg})`,
    );
    return null;
  }
}

/** Test seam — clear the SDK cache between tests. */
export function _resetOtelMetricsSdkCacheForTests(): void {
  _cachedMetricsSdk = null;
  _cachedMetricsSdkEndpoint = null;
}

// ─── Pure replay ───────────────────────────────────────────────────────

/**
 * Per-run state threaded through `feedLedgerEntryToMetrics` calls.
 * Holds the workflow name (so subsequent entries can label their
 * counter increments) and the run start time (so the run duration
 * histogram can compute total wall time). Per-(phase,agentId) start
 * times are tracked when an `agent_end` arrives but we want a server-
 * computed duration; in practice the ledger already stores
 * `durationMs` so this map is rarely populated.
 */
export interface MetricReplayState {
  workflowName: string | null;
  runId: string | null;
  initAtMs: number | null;
  runOutcomeRecorded: boolean;
  runStartedRecorded: boolean;
}

export function createMetricReplayState(): MetricReplayState {
  return {
    workflowName: null,
    runId: null,
    initAtMs: null,
    runOutcomeRecorded: false,
    runStartedRecorded: false,
  };
}

/** Map a terminal RunState onto the public `outcome` label. */
function outcomeFromTransition(
  to: RunState,
): "done" | "failed" | "cancelled" | null {
  switch (to) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
    case "cancelled-pre-run":
      return "cancelled";
    default:
      return null;
  }
}

function entryAtMs(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** Parsed `gen_ai.system` value — mirrors the trace exporter convention. */
const GEN_AI_SYSTEM = "pi.workflows";

/**
 * Apply one ledger entry to the metric instruments. Pure with respect
 * to the SDK (the SDK's internal aggregation queues are an
 * implementation detail of the OTel SDK).
 */
export function feedLedgerEntryToMetrics(
  state: MetricReplayState,
  entry: LedgerEntry,
  inst: OtelMetricsInstruments,
): void {
  switch (entry.type) {
    case "init": {
      const m = entry.manifest as Record<string, unknown>;
      const workflowName =
        typeof m["workflowName"] === "string" ? (m["workflowName"] as string) : "";
      const runId = typeof m["runId"] === "string" ? (m["runId"] as string) : "";
      state.workflowName = workflowName;
      state.runId = runId;
      state.initAtMs = entryAtMs(entry.at);
      if (!state.runStartedRecorded) {
        inst.runsStarted.add(1, { workflow_name: workflowName });
        state.runStartedRecorded = true;
      }
      return;
    }

    case "agent_start": {
      const wfName = state.workflowName ?? "";
      inst.agentsInvoked.add(1, {
        workflow_name: wfName,
        phase_name: entry.phaseName,
        // agent_id intentionally NOT a label — cardinality blow-up. See
        // module header migration note. Per-agent detail lives on spans.
      });
      return;
    }

    case "agent_end": {
      // Token usage (Gen-AI conventions: separate data points per type).
      const tokenAttrs: Record<string, unknown> = {
        "gen_ai.system": GEN_AI_SYSTEM,
      };
      // gen_ai.request.model is unknown to the ledger; omit unless we
      // gain visibility into the underlying provider.
      if (Number.isFinite(entry.usage.input) && entry.usage.input > 0) {
        inst.tokenUsage.record(entry.usage.input, {
          ...tokenAttrs,
          "gen_ai.token.type": "input",
        });
      }
      if (Number.isFinite(entry.usage.output) && entry.usage.output > 0) {
        inst.tokenUsage.record(entry.usage.output, {
          ...tokenAttrs,
          "gen_ai.token.type": "output",
        });
      }
      // Operation duration (seconds). Skip cached results — their
      // duration is dispatcher overhead, not the agent's wall time.
      if (!entry.cached && Number.isFinite(entry.durationMs)) {
        inst.operationDuration.record(entry.durationMs / 1000, {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.system": GEN_AI_SYSTEM,
        });
      }
      return;
    }

    case "agent_error": {
      const wfName = state.workflowName ?? "";
      const errClass = (entry.error as { class?: unknown }).class;
      inst.agentsErrored.add(1, {
        workflow_name: wfName,
        phase_name: entry.phaseName,
        // agent_id intentionally NOT a label — cardinality blow-up.
        error_class: typeof errClass === "string" ? errClass : "Unknown",
      });
      return;
    }

    case "transition": {
      // Terminal transition — record run completion + duration.
      const outcome = outcomeFromTransition(entry.to);
      if (outcome === null) return;
      if (state.runOutcomeRecorded) return;
      const wfName = state.workflowName ?? "";
      inst.runsCompleted.add(1, {
        workflow_name: wfName,
        outcome,
      });
      if (state.initAtMs !== null) {
        const endAtMs = entryAtMs(entry.at);
        const durSec = Math.max(0, (endAtMs - state.initAtMs) / 1000);
        inst.runDuration.record(durSec, {
          workflow_name: wfName,
          outcome,
        });
      }
      state.runOutcomeRecorded = true;
      return;
    }

    default:
      // Other entry types (phase_start, log, gate_*, etc.) don't
      // produce metrics today. Future: per-phase counters.
      return;
  }
}

/**
 * One-shot replay of a finite array of entries. Convenience wrapper
 * around {@link feedLedgerEntryToMetrics}.
 */
export function replayLedgerToMetrics(
  entries: ReadonlyArray<LedgerEntry>,
  inst: OtelMetricsInstruments,
  state: MetricReplayState = createMetricReplayState(),
): MetricReplayState {
  for (const e of entries) {
    feedLedgerEntryToMetrics(state, e, inst);
  }
  return state;
}

// ─── Live tailer ───────────────────────────────────────────────────────

export interface TailRunMetricsOptions {
  readonly runId?: string;
  readonly runDir?: string;
  /** Test seam — override resolution. */
  readonly resolveLedgerPath?: () => string;
  readonly instruments: OtelMetricsInstruments;
  /** Default 500ms. Tests pass small numbers. */
  readonly pollIntervalMs?: number;
  /** Aborts the tail loop when fired. */
  readonly signal?: AbortSignal;
  /** Best-effort log sink. */
  readonly log?: (level: "warn" | "info", msg: string) => void;
}

export interface TailRunMetricsHandle {
  /** Resolves once the tail loop has exited. */
  readonly done: Promise<void>;
  /** Drain the file once and return immediately (does not stop tailing). */
  drainNow(): Promise<void>;
  /** Stop tailing. */
  dispose(): Promise<void>;
}

/**
 * Tail `<runDir>/ledger.jsonl`, feeding each parsed entry into a fresh
 * `MetricReplayState`. Resolves the `done` promise when (a) a terminal
 * `transition` has been observed AND a final drain has settled,
 * (b) the abort signal fires, or (c) `dispose()` is called.
 */
export function tailRunLedgerForMetrics(
  opts: TailRunMetricsOptions,
): TailRunMetricsHandle {
  const path =
    opts.resolveLedgerPath?.() ??
    (opts.runId
      ? defaultLedgerPath(opts.runId)
      : (() => {
          throw new TypeError(
            "tailRunLedgerForMetrics: one of runId or resolveLedgerPath required",
          );
        })());
  const pollMs = opts.pollIntervalMs ?? 500;
  const log = opts.log ?? (() => {});
  const state = createMetricReplayState();
  let pos = 0;
  let buffer = "";
  let stopped = false;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let timer: NodeJS.Timeout | null = null;
  // Serializes concurrent readChunk() calls (loopOnce vs dispose race).
  let readLock: Promise<void> = Promise.resolve();

  const onAbort = (): void => {
    if (stopped) return;
    void dispose();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  async function readChunk(): Promise<void> {
    let unlock!: () => void;
    const prev = readLock;
    readLock = new Promise<void>((r) => (unlock = r));
    await prev;
    try {
      await _readChunkImpl();
    } finally {
      unlock();
    }
  }

  async function _readChunkImpl(): Promise<void> {
    let st: { size: number };
    try {
      st = await fsp.stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // ledger not yet created
      log(
        "warn",
        `[pi-workflows] otel-metrics: stat ledger failed: ${(err as Error).message}`,
      );
      return;
    }
    if (st.size <= pos) return;
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(path, "r");
      const len = st.size - pos;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      pos = st.size;
      if (buffer.length + buf.length > MAX_TAILER_BUFFER_BYTES) {
        log(
          "warn",
          `[pi-workflows] otel-metrics: tailer buffer exceeded ${MAX_TAILER_BUFFER_BYTES} bytes — discarding partial line`,
        );
        buffer = "";
      }
      buffer += buf.toString("utf8");
    } catch (err) {
      log(
        "warn",
        `[pi-workflows] otel-metrics: read ledger failed: ${(err as Error).message}`,
      );
      return;
    } finally {
      await fh?.close().catch(() => {});
    }

    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip corrupt line — matches LedgerReader policy.
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      try {
        feedLedgerEntryToMetrics(
          state,
          parsed as LedgerEntry,
          opts.instruments,
        );
      } catch (err) {
        log(
          "warn",
          `[pi-workflows] otel-metrics: feedLedgerEntryToMetrics threw on line: ${(err as Error).message}`,
        );
      }
    }
  }

  async function loopOnce(): Promise<void> {
    if (stopped) return;
    try {
      await readChunk();
    } catch {
      /* swallow — never let exporter errors crash the host */
    }
    if (state.runOutcomeRecorded) {
      // Run completed — final drain then exit.
      await dispose();
      return;
    }
    if (!stopped) {
      timer = setTimeout(loopOnce, pollMs);
      timer.unref?.();
    }
  }

  // Kick off the loop on next tick.
  timer = setTimeout(loopOnce, 0);
  timer.unref?.();

  async function drainNow(): Promise<void> {
    if (stopped) return;
    await readChunk();
  }

  async function dispose(): Promise<void> {
    if (stopped) {
      await done;
      return;
    }
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await readChunk();
    } catch {
      /* swallow */
    }
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
    resolveDone();
  }

  return { done, drainNow, dispose };
}

// ─── Activation glue ───────────────────────────────────────────────────

export interface CreateOtelMetricsExporterOptions {
  /** OTLP metrics endpoint. Falls back to env var when omitted. */
  readonly endpoint?: string;
  /** Override env reader (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override service.name resource attribute. */
  readonly serviceName?: string;
  /** Inject an SDK pre-loaded (tests). When supplied, no dynamic import is performed. */
  readonly sdkOverride?: LoadedOtelMetricsSdk;
  /** Override the periodic export interval (ms). */
  readonly exportIntervalMillis?: number;
  /** Best-effort log sink. */
  readonly log?: (level: "warn" | "info", msg: string) => void;
}

export interface OtelMetricsExporterHandle {
  readonly enabled: boolean;
  /** Tail one run by `runId`. Returns `null` if exporter is disabled. */
  tailRun(runId: string, signal?: AbortSignal): TailRunMetricsHandle | null;
  /** Tail one run by absolute runDir (for tests). */
  tailRunDir(runDir: string, signal?: AbortSignal): TailRunMetricsHandle | null;
  /** Flush the underlying provider's metric reader. */
  flush(): Promise<void>;
  /** Tear down the provider. */
  shutdown(): Promise<void>;
}

/**
 * Resolve the OTel metrics endpoint from env. Honors the metrics-
 * specific `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and the catch-all
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. Returns `null` when neither is set.
 */
export function resolveOtelMetricsEndpoint(
  env: NodeJS.ProcessEnv,
): string | null {
  const metrics = env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"];
  if (metrics && metrics.trim().length > 0) return metrics.trim();
  const root = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (root && root.trim().length > 0) return root.trim();
  return null;
}

/**
 * Top-level entry. Returns a handle whose `enabled` flag is `false`
 * (and whose tail* methods return `null`) when no endpoint is
 * configured. The host extension calls this once at session_start.
 */
export async function createOtelMetricsExporter(
  opts: CreateOtelMetricsExporterOptions = {},
): Promise<OtelMetricsExporterHandle> {
  const env = opts.env ?? process.env;
  const endpoint = opts.endpoint ?? resolveOtelMetricsEndpoint(env);
  if (!endpoint && !opts.sdkOverride) {
    return {
      enabled: false,
      tailRun: () => null,
      tailRunDir: () => null,
      flush: async () => {},
      shutdown: async () => {},
    };
  }
  const sdk =
    opts.sdkOverride ??
    (await loadOtelMetricsSdk({
      endpoint: endpoint!,
      ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
      ...(opts.exportIntervalMillis !== undefined
        ? { exportIntervalMillis: opts.exportIntervalMillis }
        : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      // Honor OTEL_RESOURCE_ATTRIBUTES (shared parser with the trace
      // exporter — same env-var spec, same precedence rules).
      extraResourceAttributes: parseOtelResourceAttributes(
        env["OTEL_RESOURCE_ATTRIBUTES"],
      ),
    }));
  if (sdk === null) {
    return {
      enabled: false,
      tailRun: () => null,
      tailRunDir: () => null,
      flush: async () => {},
      shutdown: async () => {},
    };
  }
  // Drain the PeriodicExportingMetricReader before the process exits.  Without
  // these hooks a short-lived workflow (< exportIntervalMillis, default 60 s)
  // exits before the reader's first scheduled export fires, silently dropping
  // every accumulated counter/histogram value.
  const onBeforeExit = (): void => {
    void sdk.provider.forceFlush?.();
  };
  const onSigterm = (): void => {
    void sdk.provider.shutdown?.().finally(() => process.exit(0));
  };
  process.on("beforeExit", onBeforeExit);
  process.on("SIGTERM", onSigterm);
  return {
    enabled: true,
    tailRun(runId, signal) {
      return tailRunLedgerForMetrics({
        runId,
        instruments: sdk.instruments,
        ...(signal !== undefined ? { signal } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
    },
    tailRunDir(runDir, signal) {
      return tailRunLedgerForMetrics({
        resolveLedgerPath: () => defaultLedgerPath(runDir, true),
        instruments: sdk.instruments,
        ...(signal !== undefined ? { signal } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
    },
    async flush() {
      await sdk.provider.forceFlush?.();
    },
    async shutdown() {
      await sdk.provider.shutdown?.();
    },
  };
}
