# OTel smoke test recipe

Local end-to-end verification that the pi-workflows OTel exporter
emits a valid trace tree to a real OTLP collector. Useful when:

- You're hacking on `src/runtime/otelExporter.ts` and want to see the
  spans land in Jaeger / Honeycomb / Tempo.
- You're integrating pi-workflows into a stack that already speaks
  OTLP and want to validate the receiver setup.
- A PR claims it "doesn't change OTel behavior" — run this before /
  after to confirm.

This recipe runs **without API tokens** by using mock-agent fixtures.

## What you need

- `docker` + `docker compose`
- `node` ≥ 22 with this repo built (`npm install && npm run build`)
- `pi` installed and configured

## Step 1 — start the collector

From this directory:

```sh
docker compose up -d
```

This launches `jaegertracing/all-in-one`, which exposes:

- `http://localhost:4318/v1/traces` — OTLP/HTTP receiver
- `http://localhost:16686/` — Jaeger UI

Wait ~5s for the healthcheck to pass:

```sh
docker compose ps
# STATUS should be "healthy"
```

## Step 2 — point pi-workflows at the collector

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
# Optional: tag every trace with deployment info.
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=smoke,team=workflows"
# Mock fixtures keep the run free of API tokens / network calls.
export PI_WORKFLOWS_MOCK_AGENTS=1
```

When you run pi after this, you should see:

```
[pi-workflows] OpenTelemetry exporter active → http://localhost:4318/v1/traces
```

If you see _"falling back to no-op tracer"_ instead, the
`@opentelemetry/*` optional deps didn't install (run
`npm install --include=optional`).

## Step 3 — install the sample workflow

The sample lives at `examples/otel-smoke/sample.workflow.js`. The
mock-agent dispatcher reads `<runDir>/fixtures.jsonl` per-run, so we
copy the workflow into a project-local workflow dir and prime the
fixture file.

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
set — actually, let's be explicit: the dispatcher reads
`<runDir>/fixtures.jsonl` only. So you must copy the fixtures into
the run dir _after_ the run is created. The simplest path is to use
`pi`'s built-in JSON mode:

```sh
# Once the workflow has its run dir, copy fixtures in:
RUN_DIR=$(ls -td ~/.pi/agent/workflows/runs/wf-* | head -1)
cp examples/otel-smoke/fixtures.jsonl "$RUN_DIR/"
```

Or pre-stage the fixtures via a `before_run` hook (see
`docs/runtime-api.md` once that section exists).

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

## Step 6 — tear down

```sh
docker compose down
unset OTEL_EXPORTER_OTLP_TRACES_ENDPOINT OTEL_RESOURCE_ATTRIBUTES PI_WORKFLOWS_MOCK_AGENTS
```

## Regenerating fixtures

If you change the prompts in `sample.workflow.js`, the mock fixtures
must be regenerated (mock-agent matching keys on `sha256(prompt)`):

```sh
node generate-fixtures.mjs > fixtures.jsonl
```

## What this recipe does NOT cover

- **Production deployment.** This stack is single-binary
  all-in-one Jaeger; for real ops you want a proper OTel collector
  (`otel/opentelemetry-collector-contrib`) with batching + retry
  config tuned to your tail rate.
- **gRPC.** pi-workflows ships HTTP-only today. The compose stack
  exposes 4317 for parity but pi-workflows does not currently emit
  on it.
- **Metrics / logs.** Only traces are exercised. The metrics
  follow-up in `docs/otel.md` would extend this recipe.
