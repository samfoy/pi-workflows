# @samfp/pi-workflows

> Dynamic workflows for pi: sandboxed JS scripts that drive sub-agent fleets, with TUI inspection, resume across pi restarts, persistent per-agent memory, git-worktree isolation, mid-phase HITL prompts, fork-from-checkpoint, and OpenTelemetry export. Pi-native sibling of [Claude Code's dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Quick start

```bash
# Install
npm install -g @samfp/pi-workflows

# Write a workflow
mkdir -p ~/.pi/agent/workflows
cat > ~/.pi/agent/workflows/summarize.js <<'EOF'
export default async function (ctx, input) {
  const [summary] = await ctx.phase("summarize", [
    ctx.agent(`Summarize this in 3 bullet points:\n\n${input}`),
  ]);
  return summary.text;
}
EOF

# Invoke it inside a pi session
/summarize <paste your text here>
```

That's it. pi discovers `summarize.js` from `~/.pi/agent/workflows/`, shows an approval prompt, then streams the run in the TUI.

## Installation

```bash
# Global (adds all bundled workflows to every pi session)
npm install -g @samfp/pi-workflows

# Project-local (adds to project scope only)
npm install --save-dev @samfp/pi-workflows
```

pi loads the extension on startup if it detects the `"pi.extensions"` field in `package.json` (global: auto; project: add `"@samfp/pi-workflows"` to `.pi/extensions.json` or use `npm install`).

## Capabilities

What ships in v0.3:

- **Sub-agent fan-out.** `ctx.phase(name, handles)` runs agent handles in parallel under a FIFO semaphore (default cap 16, configurable per phase via `maxConcurrent`).
- **Resume across pi restart.** Every run writes `manifest.json`, an append-only `ledger.jsonl`, and `cache.jsonl`. A killed pi resumes the run via `/workflows resume <id>`. A crashed pi reaps dead-PID runs on next session start.
- **Per-run cache and cross-run global cache.** Cached `AgentResult`s replay without spawning a subprocess. Global cache is keyed by `sha256(workflowSource)`, so editing the script invalidates automatically. `ctx.memo(key, fn, opts)` adds author-controlled cross-run memoization with TTL.
- **Persistent per-agent memory.** `ctx.agent(prompt, { memory: 'user' })` mounts a `MEMORY.md` file under one of three scopes (`user`, `project`, `local`). The runtime injects up to 25 KiB into the prompt and captures `memory_update` events the sub-agent emits to grow the file. `ctx.agent({ memory: { scope, readOnly: true } })` mounts read-only: updates are dropped, and `ctx.memory.append` for the same `(scope, name)` throws `ReadOnlyMemoryError`. Stdlib helpers `ctx.memory.read / append / compact` operate on the same files from workflow code.
- **Per-agent git-worktree isolation.** `ctx.agent(prompt, { isolation: 'worktree' })` runs the sub-agent in `<runDir>/worktrees/<agentId>/` (`git worktree add --detach`). Edits land there, and a `<agentId>.diff` is captured on success. `ctx.promote(agentId, opts)` applies the diff back to the parent CWD (`'apply'` strategy) or rebases the worktree onto a target ref (`'rebase'`). GC auto-prunes stale worktrees, and resume cross-checks recorded paths against `git worktree list` and warns on drift.
- **Fork from checkpoint.** `forkFromCheckpoint(parentRunId, { atPhase, overrides })` (or `WorkflowClient.forkFromCheckpoint`) creates a new run that replays the parent's ledger up to `atPhase`, copies the parent's cache, and re-dispatches from there. Author-supplied `overrides` are available via `ctx.cache.get('__fork_overrides__')`. Strict cache filtering drops parent agent results from `atPhase` onward, so post-fork phases re-run even when prompts didn't change. The TUI runs-list `f` hotkey opens an interactive fork dialog.
- **Mid-phase HITL.** `ctx.interrupt({ question, choices?, default?, schema? })` suspends the run until a supervisor injects an answer (TUI `i` hotkey, or `WorkflowClient.resume(runId, value, { key? })`). Returns `{ key, value }` so concurrent interrupts in parallel agents can be disambiguated. Replay-perfect across restart: prior `interrupt_resolved` ledger entries short-circuit the prompt on resume.
- **Vote, consensus, aggregation.** `ctx.vote(agents, judge)` and `ctx.consensus(agents, opts)` cover simple agreement. `ctx.aggregate(method, ballots, opts)` ships eight ranked-aggregation methods: `borda`, `schulze`, `ranked_pairs`, `kemeny_young`, `instant_runoff`, `coombs`, `score`, `approval`.
- **Critique / refute loop.** `ctx.critique({ producer, critic, accept, maxRounds })` runs an iterative producer-critic loop and returns the first accepted output (or the last attempt after `maxRounds`).
- **Cooperative pause / stop / restart.** Every run is interactive from the TUI overlay (`p` pause, `x` stop, `r` restart). Stop escalates SIGTERM to SIGKILL after 5s if the child ignores it.
- **OpenTelemetry export.** Both traces (Gen-AI semantic conventions) and metrics (Gen-AI histograms plus run/agent counters) tail `ledger.jsonl` and emit OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Off by default, optional deps. See [Observability](#observability).
- **Sandboxed execution.** Every workflow runs in a `node:vm` Context with `allowCodeGeneration: false`. No `fs`, `net`, `child_process`, `process.env`, or `require`. See [Security model](#security-model) and [`docs/threat-model.md`](./docs/threat-model.md).

## Writing workflow files

A workflow file is a plain `.js` (or `.mjs`) file with a default export:

```js
// ~/.pi/agent/workflows/my-workflow.js
export default async function (ctx, input) {
  // 1. Build agent handles (no spawn yet)
  const handles = [
    ctx.agent("Analyse the code for security issues", { id: "security" }),
    ctx.agent("Analyse the code for performance issues", { id: "perf" }),
  ];

  // 2. Run them in parallel (bounded by semaphore, default cap 16)
  const [security, perf] = await ctx.phase("analyse", handles);

  // 3. Vote on which finding is most critical
  const { winner } = await ctx.vote(
    [ctx.agent(`Security: ${security.text}\n\nPerf: ${perf.text}\n\nWhich is more critical?`)],
    (responses) => responses[0],
  );

  return winner;
}
```

### Invocation

Inside a pi session, type `/<workflow-name>` optionally followed by an argument string:

```
/my-workflow src/auth/
/codebase-audit src/
/summarize paste your text here
```

### Discovery order

1. **Project**: `.pi/workflows/*.js` (relative to git root)
2. **Personal**: `~/.pi/agent/workflows/*.js`
3. **Bundled**: workflows shipped with this package (currently `codebase-audit` and `deep-research`, self-installed to `~/.pi/agent/workflows/` on first session start)

If names collide, project-level wins over personal, which wins over bundled.

### Approval flow

On first use of a workflow, pi computes its SHA-256, shows you the first 40 lines, and asks:

```
Allow /codebase-audit from ~/.pi/agent/workflows/codebase-audit.js? [y/N/always]
```

`always` saves a `{workflowName, sha256}` trust record in `.pi/workflows/trust.json` (project) or `~/.pi/agent/settings.json` (personal). If the file changes, pi re-prompts.

### Disabling workflows

To disable pi-workflows entirely in a project: add `"pi-workflows": { "enabled": false }` to `.pi/config.json`.

---

## Bundled workflows

### `/codebase-audit [path]`

Multi-agent static analysis of a directory (or the entire repo).

1. **Recon** (1 agent): enumerates key areas and their files.
2. **Analyse** (1 agent per area, parallel): deep-dives each area for issues.
3. **Vote** (3 agents, parallel): Borda-count ranking of the findings.
4. **Summarise** (1 agent): produces the final structured report.

Cache: analyse results cache-hit on re-run if files haven't changed.

### `/deep-research <question>`

Fans web research out across 4 to 6 angles, cross-checks uncertain claims, and returns a cited Markdown report.

---

## Examples

### Memory + worktree fan-out

Each agent gets its own persistent `MEMORY.md` for the persona and its own git worktree, so parallel migration work doesn't race on the same files. Successful diffs are promoted back to the parent CWD.

```js
export default async function (ctx) {
  const files = ["src/auth.ts", "src/api.ts", "src/db.ts"];

  const handles = files.map((file) =>
    ctx.agent(`Migrate ${file} to the new error type. Read the file first, edit it, then verify.`, {
      id: `migrate-${file}`,
      memory: { scope: "project" },   // project-scoped MEMORY.md per agent name
      isolation: "worktree",          // private git worktree per agent
    })
  );

  const results = await ctx.phase("migrate", handles, { failMode: "null" });

  // Promote diffs from the agents that succeeded.
  for (const [i, r] of results.entries()) {
    if (r === null) continue;
    const promoted = await ctx.promote(`migrate-${files[i]}`); // strategy:'apply' is the default
    ctx.log(`promoted ${files[i]}: ${promoted.files.length} files`);
  }
}
```

### HITL interrupt

The workflow halts mid-phase and asks the supervisor (TUI `i` hotkey, or `WorkflowClient.resume`) to pick a deploy target. Replay-perfect across pi restart: a resumed run replays the prior answer without re-prompting.

```js
export default async function (ctx) {
  const [plan] = await ctx.phase("plan", [
    ctx.agent("Draft the deploy plan", { id: "planner" }),
  ]);

  const { value: target } = await ctx.interrupt({
    question: "Pick a deploy target",
    choices: ["staging", "prod", "abort"],
    default: "staging",
  });

  if (target === "abort") return "cancelled";

  const [result] = await ctx.phase("deploy", [
    ctx.agent(`Deploy to ${target}. Plan:\n${plan.text}`, { id: "deployer" }),
  ]);
  return result.text;
}
```

---

## Runtime author API

Full reference: [`docs/runtime-api.md`](./docs/runtime-api.md)

### Core

| Symbol | Type | Description |
|---|---|---|
| `ctx.run` | `RunMeta` | Run metadata: id, workflowName, startedAt, cwd, resumed |
| `ctx.input` | `string` | Slash-command argument string |
| `ctx.signal` | `AbortSignal \| undefined` | Aborts on stop/kill/shutdown |
| `ctx.agent(prompt, opts?)` | `AgentHandle` | Build an agent handle (does not spawn) |
| `ctx.phase(name, handles, opts?)` | `Promise<AgentResult[]>` | Run handles in parallel; opts: `failMode`, `timeoutMs`, `maxConcurrent` |
| `ctx.cache.get/set/has/delete` | `Promise<...>` | Run-scoped cache backed by `cache.jsonl` |
| `ctx.log(msg, opts?)` | `void` | Structured log, surfaced in TUI overlay |
| `ctx.finishCallback(prompt)` | `void` | Register a prompt to send to chat after the run completes |
| `ctx.budget` | object | `total` / `spent()` / `remaining()` token tracker |

### Stdlib helpers

| Symbol | Type | Description |
|---|---|---|
| `ctx.vote(agents, judge)` | `Promise<VoteResult>` | Multi-agent vote with a pluggable judge |
| `ctx.consensus(agents, opts?)` | `Promise<ConsensusResult>` | Jaccard-similarity agreement check |
| `ctx.aggregate(method, ballots, opts?)` | `{ winner, ranking }` | Pure ranked aggregation: `borda`, `schulze`, `ranked_pairs`, `kemeny_young`, `instant_runoff`, `coombs`, `score`, `approval` |
| `ctx.critique({ producer, critic, accept, maxRounds })` | `Promise<CritiqueResult>` | Producer-critic loop; returns `{ accepted, output, critique, rounds, history }` |
| `ctx.extractJSON(text)` | `unknown` | Pure: parse fenced JSON from agent output (last-fence-wins, bracket-depth fallback) |
| `ctx.parallel(items, fn, opts?)` | `Promise<AgentResult[]>` | Map items to handles and run in one phase |
| `ctx.pipeline(items, ...stages)` | `Promise<unknown[]>` | Sequential stages, concurrent across items; auto-dispatches handles |
| `ctx.retry(fn, opts?)` | `Promise<T>` | Retry with exponential backoff; respects `ctx.signal` |
| `ctx.sleep(ms, opts?)` | `Promise<void>` | Cancellable delay |
| `ctx.memo(key, fn, opts?)` | `Promise<T>` | Cross-run memoization (TTL + scope) |
| `ctx.progress(pct, message?)` | `void` | Ephemeral overlay-only progress event |
| `ctx.checkpoint(label, data?)` | `Promise<boolean>` | Idempotent gate; `true` on first write, `false` on resume hit |
| `ctx.report(eventType, data?)` | `void` | Structured ledger event for observability |
| `ctx.report({ format: 'mermaid' })` | `string` | Render the run's DAG as Mermaid `flowchart TD` |

### Memory

| Symbol | Type | Description |
|---|---|---|
| `ctx.memory.read(name, scope)` | `Promise<string \| null>` | Read up to 25 KiB from `MEMORY.md`; `null` if missing |
| `ctx.memory.append(name, scope, text)` | `Promise<void>` | Lazy-create dir and append (with `\n` separator); throws `ReadOnlyMemoryError` if any agent mounted the tuple read-only |
| `ctx.memory.compact(name, scope)` | `Promise<{ beforeBytes, afterBytes, ratio }>` | Spawn a summarizer agent and atomically rewrite `MEMORY.md`; preserves recent entries verbatim |

`scope` is `'user'` (`~/.pi/agent/workflows/agent-memory/<name>/`), `'project'` (`<cwd>/.pi/workflows/agent-memory/<name>/`), or `'local'` (`<runDir>/agent-memory/<name>/`).

### HITL

| Symbol | Type | Description |
|---|---|---|
| `ctx.interrupt(opts)` | `Promise<{ key, value }>` | Suspend the run until a supervisor injects an answer. `opts`: `{ question, choices?, default?, schema? }`, or a bare string shorthand. Throws `InterruptValueValidationError` if the supplied value fails `schema`. |

### Worktrees

| Symbol | Type | Description |
|---|---|---|
| `ctx.promote(agentId, opts?)` | `Promise<{ strategy, applied, files }>` | Promote a worktree's edits to the parent CWD. `opts.strategy: 'apply'` (default; runs `git apply` on the captured diff) or `'rebase'` with optional `opts.target` (default `HEAD`). Conflicts surface as `PromoteError` with `conflictFiles`. |

### Per-agent options that landed in v0.3

| Field | Type | Description |
|---|---|---|
| `opts.memory` | `'user' \| 'project' \| 'local' \| { scope, readOnly?: true } \| false` | Mount `MEMORY.md` under the chosen scope. Read-only mounts drop `memory_update` events and refuse `ctx.memory.append` for the same tuple. |
| `opts.isolation` | `'worktree' \| 'none'` | Run the sub-agent in a private git worktree. Captures a diff on success. |
| `opts.bindToWorkflowVersion` | `boolean` (default `true`) | When `false`, exclude the workflow source SHA from this agent's cache key. Useful for stable recon agents that should survive a script edit on resume. |

### Top-level exports

```ts
import {
  WorkflowClient,
  forkFromCheckpoint,
  ForkRunNotFoundError,
  ForkPhaseNotFoundError,
  FORK_OVERRIDES_KEY,
} from "@samfp/pi-workflows";
```

`WorkflowClient` is pure file I/O. No live pi process required. Use it for inspection, `WorkflowClient.resume(runId, value, opts?)` to answer interrupts, and `WorkflowClient.forkFromCheckpoint(parentRunId, opts)` to fork programmatically.

### Security model

Workflow scripts run inside a sandboxed `node:vm` Context. There is **no direct access** to `fs`, `net`, `child_process`, `process.env`, or any Node built-in not explicitly allowed. The sandbox exposes `Buffer`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `crypto` (randomUUID/randomBytes/getRandomValues/subtle), and a frozen `process` stub (platform/arch/versions only; no env, no exit). `allowCodeGeneration` defaults to `false`, so `eval` and `Function(...)` throw. See [`docs/threat-model.md`](./docs/threat-model.md) for the escape-vector matrix.

---

## TUI overlay

While a workflow is running, press `w` to open the workflows overlay. The same hotkeys work in remote-run summaries from other pi processes (with `r` and `s` disabled; they require a local run).

### Runs list

| Key | Action |
|---|---|
| `↑` / `↓` / `j` / `k` | Move selection |
| `Enter` | Drill into phase view |
| `p` | Pause (running) / resume (paused) |
| `x` | Stop |
| `r` | Restart (terminal) / resume (paused). Disabled on remote runs. |
| `v` | Render the run's DAG to a `.mmd` tmp file (Mermaid `flowchart TD`) |
| `i` | Answer the oldest pending `ctx.interrupt(...)` (enabled when `pendingInterruptCount > 0`) |
| `f` | Fork from checkpoint; picks `atPhase` and optional overrides JSON |
| `g` | GC dialog: preview and apply terminal-run cleanup |
| `Esc` | Close overlay |
| `?` | Toggle help line |

### Phase view

| Key | Action |
|---|---|
| `↑` / `↓` / `j` / `k` | Move agent cursor |
| `Enter` | Open agent detail |
| `p` | Pause / resume |
| `x` | Stop the run, or stop the selected running agent |
| `r` | Restart the run, or restart the selected running agent |
| `s` | Save the run's workflow script to `.pi/workflows/<name>.js` (terminal runs only, local only) |
| `v` | Render the DAG to Mermaid |
| `i` | Answer pending interrupt |
| `Esc` | Back to runs list |

### Agent detail

| Key | Action |
|---|---|
| `↑` / `↓` / `j` / `k` | Scroll transcript |
| `t` | Open the agent's `.jsonl` transcript in `$EDITOR` (falls back to a TUI viewer) |
| `c` | Copy the agent's prompt to the clipboard |
| `Esc` | Back to phase view |

Runs survive pi restart. Use `/workflows resume <runId>` to re-attach to a completed or paused run; the resume path gates through `pi.ui.confirm` first.

---

## Observability

### OpenTelemetry

Two exporters tail `<runDir>/ledger.jsonl` and emit OTLP/HTTP independently.

- **Traces**: Gen-AI semantic conventions. Span tree is `invoke_workflow → phase → invoke_agent`. Attributes include `gen_ai.operation.name`, `gen_ai.provider.name=pi.workflows`, `gen_ai.conversation.id` (= runId), and `gen_ai.usage.{input,output,cache_read,cache_creation}_tokens`. Span events surface `ctx.log` and `ctx.gate` entries that don't open their own span.
- **Metrics**: counters (`pi.runs.started`, `pi.runs.completed`, `pi.agents.invoked`, `pi.agents.errored`) and Gen-AI histograms (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `pi.run.duration`). A `PeriodicExportingMetricReader` flushes every 60s and on session shutdown.

### Activation

Off by default. Set one or both:

```sh
# Catch-all: both signals share an endpoint.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Or signal-specific (preferred when running mixed routing).
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
```

`OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=workflows"` merges onto every span and metric. Caller-supplied attributes win over the built-in `service.name=pi-workflows`.

The OTel SDK packages are in `optionalDependencies`. Missing deps fall back to a no-op handle with a single warning.

### Local smoke test

```sh
npm run smoke:otel    # prints a pointer to the recipe
```

The full recipe at [`examples/otel-smoke/`](./examples/otel-smoke/) ships a `docker compose` stack (otel-collector, Jaeger, Prometheus, Grafana), a sample workflow, and pre-computed mock fixtures so the run needs no API tokens. See `examples/otel-smoke/README.md` for the step-by-step.

### DAG visualization

Press `v` in the TUI runs-list or phase view, or call `ctx.report({ format: 'mermaid' })` from inside a workflow. Both produce a Mermaid `flowchart TD` diagram with one subgraph per phase, one node per agent, and per-agent status (`ok` / `error` / `cache-hit` / `running`).

---

## Reliability

What v0.3 hardened:

- **SIGKILL escalation on stop.** `Run.stop()` sends SIGTERM, then escalates to SIGKILL after a 5s grace if the child ignores SIGTERM. Idempotent: abort and timeout paths can both fire safely. Configurable via the `killGraceMs` test seam.
- **Transcript size cap.** `recoverFromTranscript` reads at most the trailing 64 MiB of an agent's `.jsonl` transcript on crash recovery. Larger files get tail-only parsing; pathological cases trigger a normal re-dispatch instead of OOMing.
- **`agentId` path sanitization.** `assertSafeAgentId` rejects `..`, `/`, `\`, NUL, leading `.`, and empty/non-string ids before any spawn. Applied to transcript path, stderr path, worktree path, and memory path derivations.
- **`ctrl.jsonl` polling fallback.** The watcher runs `fs.watch` *and* a 1s mtime poll alongside it. NFS, Docker bind mounts, and FUSE mounts where `fs.watch` silently fails still deliver pause / stop / resume-interrupt commands. Cost: one `statSync` per second per active run.
- **macOS PID-recycle fix.** Crash sweep derives a `darwin-<sec>` boot-id from `sysctl kern.boottime` so the previously-skipped "mismatched bootId then dead" path actually executes on long-uptime macOS hosts. Linux still uses `/proc/sys/kernel/random/boot_id`.
- **One-write `ctx.log`.** Each `ctx.log()` produces exactly one `log` ledger entry. Earlier versions wrote it twice and downstream tools saw duplicates.
- **Banner TTL.** Overlay banners self-clear after 4s instead of sticking forever.

---

## Parity gaps vs Claude Code

See [`docs/parity-gaps.md`](./docs/parity-gaps.md) for the full list. Remaining gaps:

- No `/effort ultracode` modifier (auto-workflow for every task).
- Logs are not exported via OTel (traces and metrics ship in v0.3).

---

## Manual smoke test

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full manual smoke procedure (section 12.8).

---

## Docs

- [`docs/runtime-api.md`](./docs/runtime-api.md): full author API reference
- [`docs/authoring.md`](./docs/authoring.md): authoring guide with patterns
- [`docs/agent-memory.md`](./docs/agent-memory.md): persistent per-agent memory (scopes, sanitizer, resume cross-check)
- [`docs/agent-worktree.md`](./docs/agent-worktree.md): git-worktree isolation, `ctx.promote`, prune semantics
- [`docs/hitl.md`](./docs/hitl.md): `ctx.interrupt`, on-disk protocol, replay rules
- [`docs/time-travel.md`](./docs/time-travel.md): fork-from-checkpoint, lineage, GC
- [`docs/otel.md`](./docs/otel.md): OTel traces and metrics reference
- [`docs/integration-testing.md`](./docs/integration-testing.md): mock-agents and fixtures
- [`docs/parity-gaps.md`](./docs/parity-gaps.md): CC parity gap tracker
- [`docs/threat-model.md`](./docs/threat-model.md): sandbox security model
- [`PRD.md`](./PRD.md): product requirements (internal)
