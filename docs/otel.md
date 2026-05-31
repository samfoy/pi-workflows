# OpenTelemetry export (ZONE_OTEL)

Status: **shipped 2026-05-31** — tail ledger.jsonl → OTLP/HTTP exporter,
Gen-AI semantic conventions, in-process span processor.

## What it does

When `OTEL_EXPORTER_OTLP_ENDPOINT` (or the trace-specific
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set, pi-workflows tails every
run's `<runDir>/ledger.jsonl` and emits OpenTelemetry spans to the
configured collector. The span tree mirrors the run structure:

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
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`       | unset   | Preferred — overrides the catch-all endpoint when set.        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`              | unset   | Catch-all OTLP endpoint, honored by every OTel SDK signal.    |
| `OTEL_EXPORTER_OTLP_HEADERS`               | unset   | Standard OTel header. Honored by `@opentelemetry/exporter-trace-otlp-http` directly. |
| `OTEL_SERVICE_NAME`                        | `pi-workflows` | Resource attribute on every span. Override at the OTel SDK layer. |

`pi-workflows` itself doesn't read additional knobs — everything beyond
the endpoint is forwarded to the OTel SDK, which honors the standard
`OTEL_*` environment variables.

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

- **Span events** — host-side `log` and `gate_*` ledger entries are
  not yet attached as span events. The tail loop drops them. Could be
  added without changing the span tree.
- **Metrics** — only traces ship today. A complementary metrics
  exporter (run rate, agent error rate, p50/p95 token usage) could
  reuse the same ledger source.
- **Resource detection** — the resource currently carries only
  `service.name` and `service.version`. Honoring the standard
  `OTEL_RESOURCE_ATTRIBUTES` env var (e.g. for `deployment.environment`)
  is a one-line change.
