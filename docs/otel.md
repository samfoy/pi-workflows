# OpenTelemetry export (ZONE_OTEL)

Status: **shipped 2026-05-31** — traces + metrics exporters tail
`ledger.jsonl` and emit OTLP/HTTP. Gen-AI semantic conventions for
both signals.

## What it does

When `OTEL_EXPORTER_OTLP_ENDPOINT` (or one of the signal-specific
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`)
is set, pi-workflows tails every run's `<runDir>/ledger.jsonl` and
emits OpenTelemetry telemetry to the configured collector.

Traces and metrics are independent: enabling one does not enable the
other. Both share the resource (service.name, OTEL_RESOURCE_ATTRIBUTES)
and the optional dependency surface (`@opentelemetry/*` is
lazy-loaded; absent deps fall back to a no-op handle).

## Traces

The span tree mirrors the run structure:

```
invoke_workflow <name>          ← root
├── phase <phase-name>
│   ├── invoke_agent <agentId>
│   ├── invoke_agent <agentId>
│   └── invoke_agent <agentId>
└── phase <phase-name>
    └── invoke_agent <agentId>
```

Span attributes follow the
[OpenTelemetry Gen-AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/):

- `gen_ai.operation.name = invoke_workflow` (root) / `invoke_agent` (leaf)
- `gen_ai.provider.name = pi.workflows`
- `gen_ai.conversation.id = <runId>` — correlates spans across runs
- `gen_ai.usage.input_tokens` / `output_tokens` /
  `cache_read.input_tokens` / `cache_creation.input_tokens` —
  per-agent token usage, sourced from `agent_end` ledger entries
- `error.type` — agent error class (e.g. `MalformedAgentOutput`,
  `AgentSubprocess`) when an agent fails

Plus pi-specific custom attributes:

- `pi.workflow.name`, `pi.workflow.run_id`, `pi.workflow.input`
- `pi.workflow.final_state` (`done` / `failed` / `stopped` /
  `cancelled-pre-run`)
- `pi.workflow.phase.name`, `pi.workflow.phase.duration_ms`,
  `pi.workflow.phase.results.{ok,error,cache_hit}`
- `pi.agent.id`, `pi.agent.cached`, `pi.agent.duration_ms`,
  `pi.agent.prompt_hash`

## Activation

The exporter is **off by default**. To turn it on, set one of:

```sh
# Trace-specific endpoint (preferred — only this signal goes through pi-workflows).
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces

# Or the catch-all endpoint that other OTel signals also honor.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Then start pi as usual:

```sh
pi
# or in a project that depends on @samfp/pi-workflows
```

When the env var is set, pi-workflows surfaces a one-line confirmation
on `session_start`:

```
[pi-workflows] OpenTelemetry exporter active → http://localhost:4318/v1/traces
```

When the env var is **unset**, the exporter is a strict no-op: no SDK
is loaded, no background timers run, no spans are produced.

## Local collector for tinkering

The fastest path to a working trace is the
[Jaeger all-in-one](https://www.jaegertracing.io/docs/) image, which
ships an OTLP receiver out of the box:

```sh
docker run --rm -p 4318:4318 -p 16686:16686 \
  -e COLLECTOR_OTLP_ENABLED=true \
  jaegertracing/all-in-one:latest
```

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
pi
```

Run a workflow, then visit <http://localhost:16686/> — you'll see a
trace per run with one span per agent.

## Optional dependency

The `@opentelemetry/*` packages are listed under
`optionalDependencies`, so `npm install` installs them on supported
platforms but tolerates failures (e.g. a sandboxed CI without network
access). When the SDK is missing _and_ the env var is set,
pi-workflows logs a single warning and falls back to a no-op tracer:

```
[pi-workflows] OTEL_EXPORTER_OTLP_ENDPOINT set but @opentelemetry/* deps unavailable — falling back to no-op tracer (...)
```

## Configuration knobs

| Knob                                       | Default | Notes                                                         |
| ------------------------------------------ | ------- | ------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`       | unset   | Preferred for traces — overrides the catch-all when set.      |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`      | unset   | Preferred for metrics — overrides the catch-all when set.     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`              | unset   | Catch-all OTLP endpoint, honored by every OTel SDK signal.    |
| `OTEL_EXPORTER_OTLP_HEADERS`               | unset   | Standard OTel header. Honored by the OTLP exporters directly. |
| `OTEL_RESOURCE_ATTRIBUTES`                 | unset   | Comma-separated `k=v` pairs merged onto every span / metric.  |
| `OTEL_SERVICE_NAME`                        | `pi-workflows` | Resource attribute on every span / metric. Override via OTEL_RESOURCE_ATTRIBUTES. |

`pi-workflows` itself doesn't read additional knobs — everything beyond
the endpoints is forwarded to the OTel SDK, which honors the standard
`OTEL_*` environment variables.

## Span events

Host-side ledger entries that don't open spans (`log`, `agent_log`,
`gate_requested`, `gate_resolved`) are surfaced as **span events** on
the most-specific currently-open span. Events show up alongside the
span timeline in Jaeger / Honeycomb / Tempo and carry the same
resource as their parent span.

| Ledger entry      | Event name         | Attributes                                                          | Lands on              |
| ----------------- | ------------------ | ------------------------------------------------------------------- | --------------------- |
| `log`             | `pi.log`           | `severity`, `message` (clipped at 4 KiB)                            | most-recent open span |
| `agent_log`       | `pi.log`           | `severity`, `message`, `pi.agent.id`, `pi.workflow.phase.name`      | matching agent span   |
| `gate_requested`  | `pi.gate.request`  | `label` (the gate's prompt text)                                    | root                  |
| `gate_resolved`   | `pi.gate.decision` | `decision` (`approved` / `rejected`)                                | root                  |

"Most-recent open span" walks the open-span maps in insertion order
and picks the deepest match: agent > phase > root. Events that arrive
before the root span (i.e. before `init`) are dropped silently.

## Resource attributes

The exporter honors the standard
[`OTEL_RESOURCE_ATTRIBUTES`](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#general-sdk-configuration)
environment variable. Set a comma-separated list of `key=value`
pairs (values may be percent-encoded) and they will be merged onto
every span's resource alongside the built-in `service.name=pi-workflows`
and `service.version`:

```sh
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=workflows"
```

Caller-supplied attributes win when keys collide with the built-in
defaults — so `OTEL_RESOURCE_ATTRIBUTES=service.name=my-service` will
override the default `pi-workflows` service name. Malformed entries
(missing `=`, empty key, undecodable percent-encoding) are skipped
silently rather than crashing the exporter.

## Smoke testing locally

A full local end-to-end recipe ships at
[`examples/otel-smoke/`](../examples/otel-smoke/):

```sh
npm run smoke:otel    # prints a pointer to the README
```

The recipe covers a `docker compose` stack running Jaeger
all-in-one, the env-var configuration, mock-agent fixtures so the
workflow runs without API tokens, and a screenshot-shaped trace tree
you should see in the Jaeger UI. Use it before / after any change to
`src/runtime/otelExporter.ts` to confirm the integration didn't
regress.

## Implementation notes

- Source: `src/runtime/otelExporter.ts`.
- Activation: `src/index.ts` — `session_start` instantiates one
  `OtelExporterHandle` per session and subscribes to the active-runs
  registry. Each new run gets a per-run `tailRunLedger` handle that
  polls `<runDir>/ledger.jsonl` every 500ms until the root span ends
  (terminal transition observed) or the parent process shuts down.
- Span emission is driven by the **pure replay** function
  `feedLedgerEntry`, which is also exercised directly by tests with an
  `InMemorySpanExporter`. The same code path runs in production and
  tests — no fixtures diverge.
- Buffered writes: the OTLP exporter sits behind a `BatchSpanProcessor`
  so a slow collector never back-pressures the workflow runtime. On
  `session_shutdown` the handler calls `provider.forceFlush()` followed
  by `provider.shutdown()` so any in-flight spans land before the
  process exits.
- Crash safety: if pi crashes mid-run, the spans for that run never
  end (the tailer never observes a terminal transition). On the next
  `session_start`, a fresh tailer attaches to the resumed/swept run
  and finishes the work — terminal transitions persisted in
  `ledger.jsonl` are replayed verbatim, including `failed:
  parent-crash`.

## Metrics

The metrics exporter (`src/runtime/otelMetricsExporter.ts`) ships
counters for run / agent lifecycle events and Gen-AI-aligned
histograms for token usage, agent operation duration, and run
duration. A `MeterProvider` is constructed once per session and
shared across all runs; the per-run ledger tailer records into a
shared instrument set so cardinality is bounded by
(workflow_name × phase × agent_id × outcome) rather than per-run.

A `PeriodicExportingMetricReader` flushes every 60s by default and
on `session_shutdown`, so completed runs always export before pi
exits.

### Counters

| Metric                | Labels                                                  | Source                       |
| --------------------- | ------------------------------------------------------- | ---------------------------- |
| `pi.runs.started`     | `workflow_name`                                         | ledger `init`                |
| `pi.runs.completed`   | `workflow_name`, `outcome`                              | terminal `transition`        |
| `pi.agents.invoked`   | `workflow_name`, `phase_name`, `agent_id`               | `agent_start`                |
| `pi.agents.errored`   | `workflow_name`, `phase_name`, `agent_id`, `error_class`| `agent_error`                |

`outcome` is normalized from the four ledger terminal states to three
dashboard-friendly values:

- `done` ← `transition.to = done`
- `failed` ← `transition.to = failed`
- `cancelled` ← `transition.to ∈ {stopped, cancelled-pre-run}`

`error_class` falls back to the literal string `Unknown` when the
ledger entry's `error.class` is missing or non-string.

### Histograms

| Metric                              | Unit | Labels                                                | Source                                  |
| ----------------------------------- | ---- | ----------------------------------------------------- | --------------------------------------- |
| `gen_ai.client.token.usage`         | `{token}` | `gen_ai.system`, `gen_ai.token.type=input\|output` | `agent_end.usage.input` / `output`     |
| `gen_ai.client.operation.duration`  | `s`  | `gen_ai.operation.name=invoke_agent`, `gen_ai.system` | `agent_end.durationMs / 1000` (skipped when `cached=true`) |
| `pi.run.duration`                   | `s`  | `workflow_name`, `outcome`                            | `init` → terminal `transition` wall time |

Bucket boundaries follow the
[OTel Gen-AI metrics spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)
recommended defaults so dashboards built against upstream Gen-AI
conventions render identically. The `gen_ai.system` label is the
literal string `pi.workflows` (matching `gen_ai.provider.name` on
trace spans). `gen_ai.request.model` is **not** populated — the
ledger doesn't capture per-call model metadata today; if upstream
providers surface that, future ledger entries can carry it.

### Activation

Metrics are off by default. Either of:

```sh
# Metrics-specific endpoint.
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics

# Or the catch-all endpoint that all signals share.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

When the env var is set, pi-workflows surfaces a one-line
confirmation on `session_start`:

```
[pi-workflows] OpenTelemetry metrics exporter active → http://localhost:4318/v1/metrics
```

When the env var is **unset**, the metrics exporter is a strict no-op
separate from the trace exporter — you can run with traces enabled
and metrics off, or vice versa.

### Resource attributes

The metrics exporter shares the trace exporter's
`OTEL_RESOURCE_ATTRIBUTES` parser. Caller-supplied attributes win
over the built-in `service.name=pi-workflows` / `service.version`,
matching OTel SDK precedence rules.

### Optional dependencies

Metrics relies on `@opentelemetry/sdk-metrics` and
`@opentelemetry/exporter-metrics-otlp-http`, both listed under
`optionalDependencies` alongside the trace SDK packages. Missing deps
(e.g. a sandboxed CI without network access) fall back silently to a
disabled handle with a single warning:

```
[pi-workflows] OTel metrics endpoint set but @opentelemetry/sdk-metrics deps unavailable — falling back to no-op (...)
```

## Custom-attribute reference

| Attribute                                  | Span level | Origin                            |
| ------------------------------------------ | ---------- | --------------------------------- |
| `gen_ai.operation.name`                    | root, leaf | static — `invoke_workflow` / `invoke_agent` |
| `gen_ai.provider.name`                     | all        | static — `pi.workflows`           |
| `gen_ai.conversation.id`                   | all        | manifest.runId                    |
| `gen_ai.usage.input_tokens`                | leaf       | `agent_end.usage.input`           |
| `gen_ai.usage.output_tokens`               | leaf       | `agent_end.usage.output`          |
| `gen_ai.usage.cache_read.input_tokens`     | leaf       | `agent_end.usage.cacheRead`       |
| `gen_ai.usage.cache_creation.input_tokens` | leaf       | `agent_end.usage.cacheWrite`      |
| `error.type`                               | leaf       | `agent_error.error.class`         |
| `pi.workflow.name`                         | root       | manifest.workflowName             |
| `pi.workflow.input`                        | root       | manifest.input                    |
| `pi.workflow.final_state`                  | root       | terminal `transition.to`          |
| `pi.workflow.phase.name`                   | phase, leaf | `phase_start.phaseName`          |
| `pi.workflow.phase.agent_count`            | phase      | `phase_start.agentCount`          |
| `pi.workflow.phase.duration_ms`            | phase      | `phase_end.durationMs`            |
| `pi.workflow.phase.results.{ok,error,cache_hit}` | phase | `phase_end.agentResults`         |
| `pi.agent.id`                              | leaf       | `agent_start.agentId`             |
| `pi.agent.cached`                          | leaf       | `agent_end.cached`                |
| `pi.agent.duration_ms`                     | leaf       | `agent_end.durationMs`            |
| `pi.agent.prompt_hash`                     | leaf       | `agent_start.promptHash`          |
| `pi.agent.usage.total_tokens`              | leaf       | `agent_end.usage.totalTokens`     |

## Follow-ups

- **Metrics** — ✅ shipped 2026-05-31. See the
  [Metrics](#metrics) section. Logs remain the next signal candidate;
  the metrics exporter's structure (per-run ledger tailer feeding
  pre-built instruments) carries over directly.
