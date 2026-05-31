/**
 * pi-workflows — OpenTelemetry exporter (ZONE_OTEL).
 *
 * Tails `<runDir>/ledger.jsonl` and emits OpenTelemetry spans following
 * the Gen-AI semantic conventions:
 *
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 *
 * Span tree (per the ZONE_OTEL contract):
 *
 *   invoke_workflow <name>            ← root, one per run
 *   ├── phase <phase-1>               ← INTERNAL kind, parent = root
 *   │   ├── invoke_agent <agentId>    ← parent = phase span
 *   │   └── invoke_agent <agentId>
 *   └── phase <phase-2>
 *       └── invoke_agent <agentId>
 *
 * Activation
 * ----------
 *   - When `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 *     is unset, this module is a strict no-op — no SDK is loaded, no
 *     spans are created, no background timers run.
 *   - When set, the SDK is loaded via dynamic `import()`. If the
 *     optional `@opentelemetry/*` deps are missing (the user opted out
 *     of `optionalDependencies`), we fall back to a NoopTracerProvider
 *     and emit a single warning. This keeps the extension functional
 *     without OTel.
 *   - The host extension (`src/index.ts`) calls
 *     {@link createOtelExporter} once at session_start and
 *     `attachToActiveRuns()` to subscribe to per-run lifecycle.
 *
 * Pure replay
 * -----------
 *   - {@link createReplayState}, {@link feedLedgerEntry}, and
 *     {@link replayLedgerToSpans} are pure transforms over a stream of
 *     `LedgerEntry` values. They are independent of file I/O so tests
 *     can drive them with an `InMemorySpanExporter`.
 *
 * Tailing
 * -------
 *   - `tailRunLedger` polls `<runDir>/ledger.jsonl` every
 *     `pollIntervalMs` (default 500ms). Each pass re-stats the file
 *     and reads from the last byte position. Lines without a trailing
 *     newline are buffered until a subsequent pass observes the
 *     terminator (mirrors `LedgerReader`'s torn-tail tolerance).
 *   - When the run reaches a terminal state (root span ended) or the
 *     caller signals abort, the tailer drains a final time and
 *     disposes.
 */

import { promises as fsp } from "node:fs";

import type { LedgerEntry } from "../types/internal.d.ts";
import { ledgerPath as defaultLedgerPath } from "../util/paths.ts";

// ─── Optional OTel SDK loader ──────────────────────────────────────────

/**
 * Minimal subset of `@opentelemetry/api` that we depend on. We type
 * this loosely so the module compiles even when `@opentelemetry/*` is
 * absent at typecheck-time (the optional dep may not be installed in
 * a freshly-cloned tree).
 */
export interface OtelApi {
  readonly trace: {
    setSpan(ctx: unknown, span: unknown): unknown;
    setSpanContext(ctx: unknown, sc: unknown): unknown;
  };
  readonly context: {
    active(): unknown;
    with<T>(ctx: unknown, fn: () => T): T;
  };
  readonly SpanKind: {
    readonly INTERNAL: number;
    readonly CLIENT: number;
  };
  readonly SpanStatusCode: {
    readonly UNSET: number;
    readonly OK: number;
    readonly ERROR: number;
  };
}

/** Anything with `.startSpan(name, options?, ctx?)`. */
export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      kind?: number;
      startTime?: Date | number;
      attributes?: Record<string, unknown>;
    },
    context?: unknown,
  ): OtelSpan;
}

/** Subset of OTel Span we use. */
export interface OtelSpan {
  setAttribute(k: string, v: unknown): unknown;
  setAttributes(attrs: Record<string, unknown>): unknown;
  setStatus(s: { code: number; message?: string }): unknown;
  recordException(err: unknown): unknown;
  end(endTime?: Date | number): unknown;
  spanContext(): unknown;
}

export interface OtelTracerProvider {
  getTracer(name: string, version?: string): OtelTracer;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

interface LoadedOtelSdk {
  readonly api: OtelApi;
  readonly provider: OtelTracerProvider;
  readonly tracer: OtelTracer;
}

/** Public alias — tests use this for the `sdkOverride` test seam. */
export type { LoadedOtelSdk };

const TRACER_NAME = "@samfp/pi-workflows";
const TRACER_VERSION = "0.2.0";

/**
 * Load the OTel SDK and wire an OTLP/HTTP exporter against `endpoint`.
 * Returns `null` if any dep is missing or the import fails for any
 * reason. Logs a single line to `log` on failure so the operator
 * knows OTel is silently disabled.
 *
 * The first successful call caches its result; subsequent calls with
 * the same `endpoint` reuse the same provider so multiple runs share
 * one batch span processor.
 */
let _cachedSdk: LoadedOtelSdk | null = null;
let _cachedSdkEndpoint: string | null = null;

export async function loadOtelSdk(opts: {
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly log?: (level: "warn" | "info", msg: string) => void;
}): Promise<LoadedOtelSdk | null> {
  if (_cachedSdk !== null && _cachedSdkEndpoint === opts.endpoint) {
    return _cachedSdk;
  }
  const log = opts.log ?? (() => {});
  try {
    // Dynamic imports keep the OTel deps strictly optional. A user
    // who sets OTEL_EXPORTER_OTLP_ENDPOINT but forgot to install the
    // SDK gets a single warning and a no-op exporter.
    const [api, base, exporter, resources] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);

    const otlpExporter = new exporter.OTLPTraceExporter({
      url: opts.endpoint,
    });
    const processor = new base.BatchSpanProcessor(otlpExporter);

    // `resourceFromAttributes` (sdk v2) or `Resource.default()` (sdk v1).
    // Cast through `unknown` to keep the call cross-version: the v1 and
    // v2 typings are incompatible at the structural level even though
    // they're functionally interchangeable for our purposes.
    let resource: unknown;
    const resourcesAny = resources as unknown as Record<string, unknown>;
    if (typeof resourcesAny["resourceFromAttributes"] === "function") {
      resource = (
        resourcesAny["resourceFromAttributes"] as (a: Record<string, unknown>) => unknown
      )({
        "service.name": opts.serviceName ?? "pi-workflows",
        "service.version": TRACER_VERSION,
      });
    } else if (typeof resourcesAny["Resource"] === "function") {
      const Ctor = resourcesAny["Resource"] as new (a: Record<string, unknown>) => unknown;
      resource = new Ctor({
        "service.name": opts.serviceName ?? "pi-workflows",
        "service.version": TRACER_VERSION,
      });
    }

    // BasicTracerProvider's typed config is a moving target across SDK
    // versions. Cast to `unknown` first so we can pass either v1
    // (`{ resource }`) or v2 (`{ resource, spanProcessors }`) shapes.
    const providerCtor = base.BasicTracerProvider as unknown as new (
      cfg: Record<string, unknown>,
    ) => OtelTracerProvider;
    const providerCfg: Record<string, unknown> = {
      spanProcessors: [processor],
    };
    if (resource !== undefined) providerCfg["resource"] = resource;
    const provider = new providerCtor(providerCfg);
    const tracer = provider.getTracer(TRACER_NAME, TRACER_VERSION);

    const sdk: LoadedOtelSdk = {
      api: api as unknown as OtelApi,
      provider: provider as unknown as OtelTracerProvider,
      tracer: tracer as unknown as OtelTracer,
    };
    _cachedSdk = sdk;
    _cachedSdkEndpoint = opts.endpoint;
    return sdk;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(
      "warn",
      `[pi-workflows] OTEL_EXPORTER_OTLP_ENDPOINT set but @opentelemetry/* deps unavailable — falling back to no-op tracer (${msg})`,
    );
    return null;
  }
}

/** Test seam — clear the SDK cache between tests. */
export function _resetOtelSdkCacheForTests(): void {
  _cachedSdk = null;
  _cachedSdkEndpoint = null;
}

// ─── Pure replay state machine ─────────────────────────────────────────

/**
 * Opaque state threaded through `feedLedgerEntry` calls. Holds the
 * root span, the per-phase span map, and the per-(phase,agentId)
 * span map. Callers must use {@link createReplayState} to construct;
 * the shape is internal and may grow new fields.
 */
export interface ReplayState {
  /** Root span (`invoke_workflow`); `null` until the `init` entry. */
  rootSpan: OtelSpan | null;
  /** Active context with `rootSpan` attached. `null` until init. */
  rootContext: unknown | null;
  /** Phase span by phaseName; child of rootSpan. */
  readonly phaseSpans: Map<string, OtelSpan>;
  /** Active context with phase span attached. */
  readonly phaseContexts: Map<string, unknown>;
  /** Agent span keyed by `${phaseName}\u0000${agentId}`. */
  readonly agentSpans: Map<string, OtelSpan>;
  /** Cached run id (for cross-correlation). */
  runId: string | null;
  workflowName: string | null;
  /** Set once the run has emitted a terminal transition or `result`. */
  rootEnded: boolean;
}

export function createReplayState(): ReplayState {
  return {
    rootSpan: null,
    rootContext: null,
    phaseSpans: new Map(),
    phaseContexts: new Map(),
    agentSpans: new Map(),
    runId: null,
    workflowName: null,
    rootEnded: false,
  };
}

function agentKey(phaseName: string, agentId: string): string {
  return `${phaseName}\u0000${agentId}`;
}

function entryDate(at: string): Date {
  // Tolerate non-ISO strings — fall back to "now" if Date.parse fails.
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Map ledger usage → Gen-AI semantic-conventions attribute names.
 * The ledger fields are camelCase; OTel uses dotted snake_case.
 */
function genAiUsageAttrs(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}): Record<string, number> {
  return {
    "gen_ai.usage.input_tokens": usage.input,
    "gen_ai.usage.output_tokens": usage.output,
    "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
    "pi.agent.usage.total_tokens": usage.totalTokens,
  };
}

/** Status codes — local copies of OTel's enum so we don't need the api at type-check time. */
const STATUS_OK = 1;
const STATUS_ERROR = 2;
const KIND_INTERNAL = 0;

/**
 * Apply one ledger entry to the replay state. Pure with respect to
 * the tracer (the tracer's own internal queues are an implementation
 * detail of the OTel SDK).
 *
 * Idempotency: replaying the same entry twice is _not_ idempotent
 * (you'd start two phase spans). The tailer is responsible for
 * giving each entry to this function exactly once.
 */
export function feedLedgerEntry(
  state: ReplayState,
  entry: LedgerEntry,
  tracer: OtelTracer,
  api: OtelApi,
): void {
  const t = entryDate(entry.at);
  const SpanKind = api.SpanKind ?? { INTERNAL: KIND_INTERNAL, CLIENT: 2 };
  const SpanStatusCode = api.SpanStatusCode ?? {
    UNSET: 0,
    OK: STATUS_OK,
    ERROR: STATUS_ERROR,
  };

  switch (entry.type) {
    case "init": {
      // Manifest is a Record<string, unknown>; cherry-pick the fields
      // we care about with safe casts.
      const m = entry.manifest as Record<string, unknown>;
      const runId = typeof m["runId"] === "string" ? (m["runId"] as string) : "";
      const workflowName =
        typeof m["workflowName"] === "string"
          ? (m["workflowName"] as string)
          : "";
      state.runId = runId;
      state.workflowName = workflowName;
      const span = tracer.startSpan(
        `invoke_workflow ${workflowName || "<unknown>"}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: t,
          attributes: {
            "gen_ai.operation.name": "invoke_workflow",
            "gen_ai.provider.name": "pi.workflows",
            "gen_ai.conversation.id": runId,
            "pi.workflow.name": workflowName,
            "pi.workflow.run_id": runId,
            ...(typeof m["input"] === "string"
              ? { "pi.workflow.input": m["input"] as string }
              : {}),
            ...(typeof m["piVersion"] === "string"
              ? { "pi.version": m["piVersion"] as string }
              : {}),
            ...(typeof m["piWorkflowsVersion"] === "string"
              ? { "pi.workflows.version": m["piWorkflowsVersion"] as string }
              : {}),
          },
        },
      );
      state.rootSpan = span;
      state.rootContext = api.trace.setSpan(api.context.active(), span);
      return;
    }

    case "phase_start": {
      if (state.rootContext === null) return; // init missing; bail.
      const ctx = state.rootContext;
      const span = tracer.startSpan(
        `phase ${entry.phaseName}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: t,
          attributes: {
            "pi.workflow.phase.name": entry.phaseName,
            "pi.workflow.phase.agent_count": entry.agentCount,
            ...(state.runId ? { "pi.workflow.run_id": state.runId } : {}),
          },
        },
        ctx,
      );
      state.phaseSpans.set(entry.phaseName, span);
      state.phaseContexts.set(entry.phaseName, api.trace.setSpan(ctx, span));
      return;
    }

    case "phase_end": {
      const span = state.phaseSpans.get(entry.phaseName);
      if (span === undefined) return;
      span.setAttributes({
        "pi.workflow.phase.duration_ms": entry.durationMs,
        "pi.workflow.phase.results.ok": entry.agentResults.ok,
        "pi.workflow.phase.results.error": entry.agentResults.error,
        "pi.workflow.phase.results.cache_hit": entry.agentResults.cacheHit,
      });
      if (entry.agentResults.error > 0) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${entry.agentResults.error} agent error(s)`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(t);
      state.phaseSpans.delete(entry.phaseName);
      state.phaseContexts.delete(entry.phaseName);
      return;
    }

    case "agent_start": {
      const phaseCtx =
        state.phaseContexts.get(entry.phaseName) ?? state.rootContext;
      if (phaseCtx === null || phaseCtx === undefined) return;
      const span = tracer.startSpan(
        `invoke_agent ${entry.agentId}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: t,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.provider.name": "pi.workflows",
            ...(state.runId
              ? { "gen_ai.conversation.id": state.runId }
              : {}),
            "pi.agent.id": entry.agentId,
            "pi.workflow.phase.name": entry.phaseName,
            "pi.agent.prompt_hash": entry.promptHash,
          },
        },
        phaseCtx,
      );
      state.agentSpans.set(agentKey(entry.phaseName, entry.agentId), span);
      return;
    }

    case "agent_end": {
      const key = agentKey(entry.phaseName, entry.agentId);
      const span = state.agentSpans.get(key);
      if (span === undefined) return;
      span.setAttributes({
        ...genAiUsageAttrs(entry.usage),
        "pi.agent.duration_ms": entry.durationMs,
        "pi.agent.cached": entry.cached,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end(t);
      state.agentSpans.delete(key);
      return;
    }

    case "agent_cache_hit": {
      // A cache hit short-circuits dispatch — there is no preceding
      // agent_start. Emit a synthetic span that starts and ends at
      // the same instant so the dashboard shows the agent ran (cached).
      const phaseCtx =
        state.phaseContexts.get(entry.phaseName) ?? state.rootContext;
      if (phaseCtx === null || phaseCtx === undefined) return;
      const span = tracer.startSpan(
        `invoke_agent ${entry.agentId}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: t,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.provider.name": "pi.workflows",
            ...(state.runId
              ? { "gen_ai.conversation.id": state.runId }
              : {}),
            "pi.agent.id": entry.agentId,
            "pi.workflow.phase.name": entry.phaseName,
            "pi.agent.cached": true,
          },
        },
        phaseCtx,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      span.end(t);
      return;
    }

    case "agent_error": {
      const key = agentKey(entry.phaseName, entry.agentId);
      let span = state.agentSpans.get(key);
      // If agent_start was somehow missing (mock fixture missing path
      // can fail before agent_start), synthesise a zero-duration error
      // span attached to the phase for visibility.
      if (span === undefined) {
        const phaseCtx =
          state.phaseContexts.get(entry.phaseName) ?? state.rootContext;
        if (phaseCtx === null || phaseCtx === undefined) return;
        span = tracer.startSpan(
          `invoke_agent ${entry.agentId}`,
          {
            kind: SpanKind.INTERNAL,
            startTime: t,
            attributes: {
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.provider.name": "pi.workflows",
              "pi.agent.id": entry.agentId,
              "pi.workflow.phase.name": entry.phaseName,
            },
          },
          phaseCtx,
        );
      }
      const errClass = (entry.error as { class?: unknown }).class;
      const errMsg =
        (entry.error as { message?: unknown }).message ??
        (entry.error as { reason?: unknown }).reason;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: typeof errMsg === "string" ? errMsg : "agent error",
      });
      span.setAttribute(
        "error.type",
        typeof errClass === "string" ? errClass : "Unknown",
      );
      span.end(t);
      state.agentSpans.delete(key);
      return;
    }

    case "transition": {
      // Terminal transitions close the root span.
      if (
        (entry.to === "done" ||
          entry.to === "failed" ||
          entry.to === "stopped" ||
          entry.to === "cancelled-pre-run") &&
        state.rootSpan !== null &&
        !state.rootEnded
      ) {
        state.rootSpan.setAttribute("pi.workflow.final_state", entry.to);
        if (entry.to === "failed") {
          state.rootSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: entry.reason ?? "workflow failed",
          });
        } else if (entry.to === "stopped" || entry.to === "cancelled-pre-run") {
          state.rootSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: entry.reason ?? `workflow ${entry.to}`,
          });
        } else {
          state.rootSpan.setStatus({ code: SpanStatusCode.OK });
        }
        state.rootSpan.end(t);
        state.rootEnded = true;
      }
      return;
    }

    case "error": {
      // `error` entries are workflow-level (host-side throws). Record
      // the exception on the root span without ending it; the
      // subsequent `transition → failed` is what closes the span.
      if (state.rootSpan !== null && !state.rootEnded) {
        state.rootSpan.recordException({
          name: entry.error.name,
          message: entry.error.message,
          stack: entry.error.stack ?? "",
        });
      }
      return;
    }

    default:
      // Other entry types (log, agent_log, pause, resume, gate_*, etc.)
      // do not produce spans. Future: emit them as span events on the
      // currently-open ancestor span.
      return;
  }
}

/**
 * One-shot replay of a finite array of entries. Convenience wrapper
 * around {@link feedLedgerEntry}; primarily used by tests and by the
 * "drain on terminal" path of {@link tailRunLedger}.
 */
export function replayLedgerToSpans(
  entries: ReadonlyArray<LedgerEntry>,
  tracer: OtelTracer,
  api: OtelApi,
  state: ReplayState = createReplayState(),
): ReplayState {
  for (const e of entries) {
    feedLedgerEntry(state, e, tracer, api);
  }
  return state;
}

/**
 * Force-end any spans still open at tailer shutdown. Used when a run
 * is abandoned (parent SIGKILL, sweep) so spans don't dangle in OTel
 * batch processors.
 */
export function endOpenSpans(state: ReplayState, api: OtelApi): void {
  const SpanStatusCode = api.SpanStatusCode ?? { ERROR: STATUS_ERROR };
  const now = new Date();
  for (const [, span] of state.agentSpans) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: "abandoned" });
    span.end(now);
  }
  state.agentSpans.clear();
  for (const [, span] of state.phaseSpans) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: "abandoned" });
    span.end(now);
  }
  state.phaseSpans.clear();
  state.phaseContexts.clear();
  if (state.rootSpan !== null && !state.rootEnded) {
    state.rootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: "abandoned",
    });
    state.rootSpan.end(now);
    state.rootEnded = true;
  }
}

// ─── Live tailer ───────────────────────────────────────────────────────

export interface TailRunLedgerOptions {
  readonly runId?: string;
  readonly runDir?: string;
  /** Test seam — override resolution. */
  readonly resolveLedgerPath?: () => string;
  readonly tracer: OtelTracer;
  readonly api: OtelApi;
  /** Default 500ms. Tests pass small numbers. */
  readonly pollIntervalMs?: number;
  /** Aborts the tail loop when fired. */
  readonly signal?: AbortSignal;
  /** Best-effort log sink. */
  readonly log?: (level: "warn" | "info", msg: string) => void;
}

export interface TailRunLedgerHandle {
  /** Resolves once the tail loop has exited. */
  readonly done: Promise<void>;
  /** Drain the file once and return immediately (does not stop tailing). */
  drainNow(): Promise<void>;
  /** Stop tailing and end any still-open spans. */
  dispose(): Promise<void>;
}

/**
 * Tail `<runDir>/ledger.jsonl`, feeding each parsed entry into a
 * fresh `ReplayState`. Resolves the `done` promise when (a) the root
 * span has ended (terminal transition observed) AND a final drain
 * has settled, (b) the abort signal fires, or (c) `dispose()` is
 * called.
 */
export function tailRunLedger(opts: TailRunLedgerOptions): TailRunLedgerHandle {
  const path =
    opts.resolveLedgerPath?.() ??
    (opts.runId
      ? defaultLedgerPath(opts.runId)
      : (() => {
          throw new TypeError(
            "tailRunLedger: one of runId or resolveLedgerPath required",
          );
        })());
  const pollMs = opts.pollIntervalMs ?? 500;
  const log = opts.log ?? (() => {});
  const state = createReplayState();
  let pos = 0;
  let buffer = "";
  let stopped = false;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let timer: NodeJS.Timeout | null = null;

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
    let st: { size: number };
    try {
      st = await fsp.stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // ledger not yet created
      log("warn", `[pi-workflows] otel: stat ledger failed: ${(err as Error).message}`);
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
      buffer += buf.toString("utf8");
    } catch (err) {
      log("warn", `[pi-workflows] otel: read ledger failed: ${(err as Error).message}`);
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
        feedLedgerEntry(state, parsed as LedgerEntry, opts.tracer, opts.api);
      } catch (err) {
        log(
          "warn",
          `[pi-workflows] otel: feedLedgerEntry threw on line: ${(err as Error).message}`,
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
    if (state.rootEnded) {
      // Run completed — final drain then exit.
      await dispose();
      return;
    }
    if (!stopped) {
      timer = setTimeout(loopOnce, pollMs);
      // Don't keep the event loop alive purely for OTel polling.
      timer.unref?.();
    }
  }

  // Kick off the loop on next tick so the caller can wire up signal /
  // dispose before the first poll.
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
    // Drain whatever's left so we don't lose trailing entries.
    try {
      await readChunk();
    } catch {
      /* swallow */
    }
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
    endOpenSpans(state, opts.api);
    resolveDone();
  }

  return { done, drainNow, dispose };
}

// ─── Activation glue ───────────────────────────────────────────────────

export interface CreateOtelExporterOptions {
  /** OTLP traces endpoint. Falls back to env var when omitted. */
  readonly endpoint?: string;
  /** Override env reader (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override service.name resource attribute. */
  readonly serviceName?: string;
  /** Inject an SDK pre-loaded (tests). When supplied, no dynamic import is performed. */
  readonly sdkOverride?: LoadedOtelSdk;
  /** Best-effort log sink. */
  readonly log?: (level: "warn" | "info", msg: string) => void;
}

export interface OtelExporterHandle {
  readonly enabled: boolean;
  /** Tail one run by `runId`. Returns `null` if exporter is disabled. */
  tailRun(runId: string, signal?: AbortSignal): TailRunLedgerHandle | null;
  /** Tail one run by absolute runDir (for tests). */
  tailRunDir(runDir: string, signal?: AbortSignal): TailRunLedgerHandle | null;
  /** Flush the underlying provider's batch processor. */
  flush(): Promise<void>;
  /** Tear down the provider. */
  shutdown(): Promise<void>;
}

/**
 * Resolve the OTel endpoint from env. Honors both the catch-all
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and the trace-specific
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Returns `null` when neither
 * is set (the no-op activation path).
 */
export function resolveOtelEndpoint(env: NodeJS.ProcessEnv): string | null {
  const traces = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  if (traces && traces.trim().length > 0) return traces.trim();
  const root = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (root && root.trim().length > 0) {
    // OTLP/HTTP convention: when only the root is set, append the
    // traces path. The OTLPTraceExporter will do this automatically
    // when given an endpoint without a path, but we must not strip
    // a user-supplied path either. Hand the raw value through.
    return root.trim();
  }
  return null;
}

/**
 * Top-level entry. Returns a handle whose `enabled` flag is `false`
 * (and whose tail* methods return `null`) when no endpoint is
 * configured. The host extension calls this once at session_start.
 */
export async function createOtelExporter(
  opts: CreateOtelExporterOptions = {},
): Promise<OtelExporterHandle> {
  const env = opts.env ?? process.env;
  const endpoint = opts.endpoint ?? resolveOtelEndpoint(env);
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
    (await loadOtelSdk({
      endpoint: endpoint!,
      ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
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
  return {
    enabled: true,
    tailRun(runId, signal) {
      return tailRunLedger({
        runId,
        tracer: sdk.tracer,
        api: sdk.api,
        ...(signal !== undefined ? { signal } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
    },
    tailRunDir(runDir, signal) {
      return tailRunLedger({
        resolveLedgerPath: () => defaultLedgerPath(runDir, true),
        tracer: sdk.tracer,
        api: sdk.api,
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
