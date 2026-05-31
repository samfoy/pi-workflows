# OTel smoke test recipe

Local end-to-end verification that the pi-workflows OTel exporters
emit valid traces **and** metrics to a real OTLP collector. Useful when:

- You're hacking on `src/runtime/otelExporter.ts` or
  `src/runtime/otelMetricsExporter.ts` and want to see telemetry land
  in Jaeger / Prometheus / Grafana.
- You're integrating pi-workflows into a stack that already speaks
  OTLP and want to validate the receiver setup.
- A PR claims it "doesn't change OTel behavior" — run this before /
  after to confirm.

This recipe runs **without API tokens** by using mock-agent fixtures.

## What you need

- `docker` + `docker compose`
- `node` ≥ 22 with this repo built (`npm install && npm run build`)
- `pi` installed and configured

## Architecture

```
pi-workflows ──OTLP/HTTP──▶ otel-collector ──┬── traces ──▶ Jaeger
                                              └── /metrics ▶ Prometheus ──▶ Grafana
```

A single OpenTelemetry Collector receives both signals and fans them
out — closer to a realistic prod stack than running Jaeger all-in-one
and gives you a real metrics scrape pipeline to inspect.

## Step 1 — start the stack

From this directory:

```sh
docker compose up -d
```

This launches four containers:

- `pi-workflows-otel-collector` — exposes `:4318` (OTLP/HTTP) for
  pi-workflows to post to, plus `:8889` for Prometheus to scrape.
- `pi-workflows-jaeger` — Jaeger UI at <http://localhost:16686/>.
- `pi-workflows-prometheus` — Prometheus UI at <http://localhost:9090/>.
- `pi-workflows-grafana` — Grafana UI at <http://localhost:3000/>
  (`admin`/`admin`, anonymous viewer also works).

Wait ~10s for healthchecks to pass:

```sh
docker compose ps
# All STATUS columns should be "running" or "healthy".
```

## Step 2 — point pi-workflows at the collector

Use the catch-all endpoint so both signals flow through the same
collector:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# Optional: tag every span/metric with deployment info.
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=smoke,team=workflows"
# Mock fixtures keep the run free of API tokens / network calls.
export PI_WORKFLOWS_MOCK_AGENTS=1
```

Or, if you want signal-specific endpoints (e.g. metrics off, traces
on):

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
```

When you run pi after this, you should see both notifications:

```
[pi-workflows] OpenTelemetry exporter active → http://localhost:4318
[pi-workflows] OpenTelemetry metrics exporter active → http://localhost:4318
```

If you see _"falling back to no-op tracer"_ instead, the
`@opentelemetry/*` optional deps didn't install (run
`npm install --include=optional`).

## Step 3 — install the sample workflow

```sh
# From the pi-workflows repo root.
mkdir -p .pi/workflows
cp examples/otel-smoke/sample.workflow.js .pi/workflows/otel-smoke.js
```

## Step 4 — run the workflow

Start `pi`, accept the trust prompt for the new workflow, then:

```
/otel-smoke
```

You'll get a result card with the four canned greetings. Behind the
scenes pi-workflows tee'd `examples/otel-smoke/fixtures.jsonl` into
`<runDir>/fixtures.jsonl` because `PI_WORKFLOWS_MOCK_AGENTS=1` was
set. The simplest path is to use `pi`'s built-in JSON mode:

```sh
# Once the workflow has its run dir, copy fixtures in:
RUN_DIR=$(ls -td ~/.pi/agent/workflows/runs/wf-* | head -1)
cp examples/otel-smoke/fixtures.jsonl "$RUN_DIR/"
```

## Step 5 — inspect the trace

Open <http://localhost:16686/> in a browser. You should see:

- **Service**: `pi-workflows`
- **Operation**: `invoke_workflow otel-smoke`
- **Trace tree**:
  - `invoke_workflow otel-smoke` (root)
    - `phase greet`
      - `invoke_agent greet-en`
      - `invoke_agent greet-fr`
    - `phase summarize`
      - `invoke_agent summarize-1`
      - `invoke_agent summarize-2`
- **Span events**: each `phase_*` span carries any `pi.log` events
  emitted while it was open. Each span carries Gen-AI semantic-
  convention attributes (`gen_ai.usage.input_tokens`, etc.).
- **Resource**: `deployment.environment=smoke`, `team=workflows`,
  plus the standard `service.name=pi-workflows`.

## Step 6 — inspect the metrics

Two paths.

**Prometheus UI** (<http://localhost:9090/>):

```
# Number of runs started, broken out by workflow.
sum by (workflow_name) (pi_runs_started_total)

# Run completions by outcome (done / failed / cancelled).
sum by (outcome) (pi_runs_completed_total)

# p95 token usage by direction.
histogram_quantile(0.95,
  sum by (gen_ai_token_type, le) (rate(gen_ai_client_token_usage_bucket[5m])))

# Agent invocations by phase.
sum by (phase_name, agent_id) (pi_agents_invoked_total)
```

> Counter names get an automatic `_total` suffix in Prometheus
> exposition; histograms split into `_bucket`, `_count`, and `_sum`
> series. Dot-separated OTel attribute keys (`gen_ai.system`) become
> underscored Prometheus labels (`gen_ai_system`).

**Grafana** (<http://localhost:3000/>):

The Prometheus datasource is auto-provisioned. Create an Explore tab,
pick **Prometheus**, and run any of the queries above. A canned
dashboard is **not** included — keep the smoke recipe minimal; build
your own panels against the queries you actually care about.

## Metrics

All metrics are emitted from the metrics exporter
(`src/runtime/otelMetricsExporter.ts`):

| Metric                              | Type      | Labels                                                  | Source                          |
| ----------------------------------- | --------- | ------------------------------------------------------- | ------------------------------- |
| `pi.runs.started`                   | Counter   | `workflow_name`                                         | ledger `init`                   |
| `pi.runs.completed`                 | Counter   | `workflow_name`, `outcome`                              | terminal `transition`           |
| `pi.agents.invoked`                 | Counter   | `workflow_name`, `phase_name`, `agent_id`               | `agent_start`                   |
| `pi.agents.errored`                 | Counter   | `workflow_name`, `phase_name`, `agent_id`, `error_class`| `agent_error`                   |
| `gen_ai.client.token.usage`         | Histogram | `gen_ai.system`, `gen_ai.token.type=input\|output`      | `agent_end.usage`               |
| `gen_ai.client.operation.duration`  | Histogram | `gen_ai.operation.name=invoke_agent`, `gen_ai.system`   | `agent_end.durationMs` (1000 → s) |
| `pi.run.duration`                   | Histogram | `workflow_name`, `outcome`                              | `init` → terminal `transition`  |

`outcome` collapses the four ledger terminal states into three for
dashboard sanity:

- `done` ← `transition.to = done`
- `failed` ← `transition.to = failed`
- `cancelled` ← `transition.to ∈ {stopped, cancelled-pre-run}`

## Step 7 — tear down

```sh
docker compose down
unset OTEL_EXPORTER_OTLP_ENDPOINT OTEL_RESOURCE_ATTRIBUTES PI_WORKFLOWS_MOCK_AGENTS
```

## Regenerating fixtures

If you change the prompts in `sample.workflow.js`, the mock fixtures
must be regenerated (mock-agent matching keys on `sha256(prompt)`):

```sh
node generate-fixtures.mjs > fixtures.jsonl
```

## What this recipe does NOT cover

- **Production deployment.** This stack is single-binary
  Jaeger + a small Prometheus + Grafana with 1h retention. For real
  ops you want a proper otel-collector deployment, persistent storage
  on Prometheus, and an HA Grafana with auth.
- **gRPC.** pi-workflows ships HTTP-only today. The compose stack
  exposes `:4317` for parity but pi-workflows does not currently emit
  on it.
- **Logs.** Only traces + metrics are exercised. A logs follow-up
  would extend the collector pipeline with the `loki` exporter.
