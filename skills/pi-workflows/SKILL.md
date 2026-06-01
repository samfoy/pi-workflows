---
name: pi-workflows
description: Author and run dynamic workflow scripts in pi. Use when writing multi-agent pipelines, fan-out tasks, parallel research, or anything that benefits from orchestrating multiple agents. Covers the ctx.agent/phase/vote API, write_workflow tool, /workflows TUI, and resume/GC commands.
---

# pi-workflows skill

## What this skill covers

Authoring and running dynamic workflow scripts in pi via `@samfp/pi-workflows`.
Workflows are sandboxed JS files that drive multi-agent pipelines, with TUI
inspection, resume across pi restarts, persistent per-agent memory, git-worktree
isolation, mid-phase HITL, fork-from-checkpoint, and OpenTelemetry export.

Load this skill when the user asks to:
- Write a workflow script
- Run `/codebase-audit`, `/deep-research`, or another workflow
- Understand why a workflow failed or stalled
- Debug the workflows TUI overlay
- Test a workflow with mock agents
- Wire HITL prompts, per-agent memory, worktree isolation, fork-from-checkpoint, or OTel

---

## How to invoke a workflow

```
/<workflow-name> [argument]
```

Examples:
```
/codebase-audit src/auth/
/summarize paste your text here
/my-pipeline
```

pi discovers workflow files from:
1. `.pi/workflows/` (git root, project scope)
2. `~/.pi/agent/workflows/` (personal scope)
3. Built-in workflows shipped with pi-workflows (`codebase-audit`, `deep-research`)

On first run pi shows an approval prompt with the file SHA-256 and first 40 lines.

---

## Writing a workflow

A workflow file must start with `export const meta` as the first statement:

```js
export const meta = {
  name: "my-workflow",
  description: "What this workflow does",
  version: "1.0.0",
  whenToUse: "Hint for the model about when to call write_workflow for this task type",
  // Optional: auto-approve file edits for all subagents (like CC's acceptEdits mode).
  acceptEdits: true,
  phases: [
    { title: "Analyze" },
    { title: "Implement" },
  ],
};

export default async function (ctx, input) {
  const [result] = await ctx.phase("main", [
    ctx.agent(`Answer: ${input}`, { id: "answer" }),
  ]);
  return result.text;
}
```

**Keyword trigger:** include the word `workflow` (or `workflows`) anywhere in your prompt to automatically trigger `write_workflow`. Pi notifies you when the keyword is detected.

---

## Core `ctx` API

| Call | What it does |
|---|---|
| `ctx.agent(prompt, opts)` | Build an agent handle (no spawn yet) |
| `ctx.phase(name, handles, opts?)` | Run handles in parallel; `opts.failMode`, `timeoutMs`, `maxConcurrent` |
| `ctx.parallel(items, fn, opts?)` | Map items to handles and run in one phase |
| `ctx.pipeline(items, ...stages)` | Sequential stages, concurrent across items; auto-dispatches handles |
| `ctx.vote(agents, judge)` | Fan-out vote with a judge function |
| `ctx.consensus(agents, opts?)` | Jaccard-similarity agreement check |
| `ctx.retry(fn, opts)` | Retry with exponential backoff |
| `ctx.sleep(ms, opts?)` | Cancellable delay |
| `ctx.cache.get/set/has/delete` | Run-scoped persistent cache |
| `ctx.memo(key, fn, opts?)` | Cross-run memoization (TTL, scope) |
| `ctx.log(msg, opts?)` | Log to TUI overlay and ledger |
| `ctx.finishCallback(prompt)` | Post a message to chat on completion |
| `ctx.signal` | AbortSignal; fires on kill/stop |
| `ctx.input` | Slash-command argument string |
| `ctx.run` | Run metadata (id, name, startedAt, cwd, resumed) |
| `ctx.budget` | `{ total, spent(), remaining() }` token tracker |
| `ctx.progress(pct, msg?)` | Ephemeral overlay-only progress |
| `ctx.checkpoint(label, data?)` | Idempotent gate; returns `true` first time, `false` on resume hit |
| `ctx.report(eventType, data?)` | Structured ledger event |
| `ctx.report({ format: 'mermaid' })` | Returns the run's DAG as Mermaid `flowchart TD` |

Full reference: `docs/runtime-api.md` in the package.

---

## Stdlib helpers

### `ctx.extractJSON(text)`

Pure: parses fenced JSON from agent prose. Last-fence-wins, bracket-depth fallback when no fence.

```js
const [r] = await ctx.phase("plan", [ctx.agent("Return a JSON plan")]);
const plan = ctx.extractJSON(r.text);   // throws if no JSON found
```

### `ctx.aggregate(method, ballots, opts?)`

Pure ranked-aggregation. Eight methods: `borda`, `schulze`, `ranked_pairs`, `kemeny_young`, `instant_runoff`, `coombs`, `score`, `approval`. Returns `{ winner, ranking }`.

```js
// `ballots` is an array of ranked lists (best to worst) for ordinal methods.
const ballots = [
  ["A", "B", "C"],
  ["A", "C", "B"],
  ["B", "A", "C"],
];
const { winner, ranking } = ctx.aggregate("schulze", ballots);

// `score` and `approval` use different ballot shapes.
ctx.aggregate("score", [{ A: 5, B: 3 }, { A: 4, B: 4 }]);
ctx.aggregate("approval", [["A", "B"], ["A"], ["B"]]);

// kemeny_young is exhaustive: max 8 candidates.
```

`ctx.consensus(agents, { method: 'schulze' })` plugs the same aggregator into a phase result.

### `ctx.critique({ producer, critic, accept, maxRounds })`

Producer-critic loop. Each round: `producer(lastCritique, round)` produces output, `critic(output, round)` produces a critique, `accept(critique, output)` decides. Returns `{ accepted, output, critique, rounds, history }`.

```js
const result = await ctx.critique({
  producer: async (lastCritique) => {
    const promptSuffix = lastCritique ? `\nCritique: ${lastCritique}` : "";
    const [r] = await ctx.phase("draft", [
      ctx.agent(`Draft a release note.${promptSuffix}`, { id: "drafter" }),
    ]);
    return r.text;
  },
  critic: async (output) => {
    const [r] = await ctx.phase("critique", [
      ctx.agent(`Critique this draft. Reply LGTM if shippable:\n${output}`, { id: "critic" }),
    ]);
    return r.text;
  },
  accept: (critique) => /^LGTM/i.test(critique),
  maxRounds: 3,
});
```

`producer`, `critic`, and `accept` are author-supplied. The helper is realm-pure: it doesn't spawn agents itself, only orchestrates whatever the callbacks return.

---

## Persistent per-agent memory

`ctx.agent(prompt, { memory })` mounts a `MEMORY.md` file. The runtime injects up to 25 KiB into the prompt and captures `memory_update` events the sub-agent emits.

```js
// Read-write mount: persona accretes notes across runs.
await ctx.phase("review", [
  ctx.agent("Review this PR", {
    id: "reviewer",
    memory: "user",          // 'user' | 'project' | 'local'
    name: "code-reviewer",   // optional persona name; defaults to opts.id
  }),
]);

// Read-only mount: shared playbook persona, updates dropped silently.
await ctx.phase("apply-playbook", [
  ctx.agent("Apply the migration playbook", {
    id: "applier",
    memory: { scope: "project", readOnly: true },
    name: "migration-playbook",
  }),
]);
```

Scope paths:

| scope     | path                                                      |
|-----------|-----------------------------------------------------------|
| `user`    | `~/.pi/agent/workflows/agent-memory/<name>/MEMORY.md`     |
| `project` | `<cwd>/.pi/workflows/agent-memory/<name>/MEMORY.md`       |
| `local`   | `<runDir>/agent-memory/<name>/MEMORY.md`                  |

### `readOnly` semantics

When any agent in a run mounts a `(scope, name)` tuple with `readOnly: true`:
- The dispatcher logs and drops `memory_update` events from that agent.
- `ctx.memory.append(name, scope, text)` for the same tuple throws `ReadOnlyMemoryError`.
- A second agent that mounts the same tuple read-write later in the run is allowed: the read-only flag is per-mount, the append guard is per-tuple-seen-read-only-this-run.

### Stdlib helpers

```js
const current = await ctx.memory.read("code-reviewer", "user");
await ctx.memory.append("code-reviewer", "user", "- async/await foot-gun in PR #42\n");
const { beforeBytes, afterBytes, ratio } = await ctx.memory.compact("code-reviewer", "user");
```

`compact` spawns a single summarizer agent that preserves recent entries verbatim and condenses older ones. On any failure the original file is left intact and the call rejects with `CompactionError`.

Memory is **not** in the agent cache key. Editing `MEMORY.md` does not invalidate cached results. Toggle `bindToWorkflowVersion: false` or vary `cacheKeyExtra` if you need a different cache posture.

Path-traversal `name` and unknown `scope` values throw `TypeError` / `InvalidMemoryNameError`.

---

## Git-worktree isolation

`ctx.agent(prompt, { isolation: 'worktree' })` runs the sub-agent in a private git worktree under `<runDir>/worktrees/<agentId>/` (`git worktree add --detach`). Edits land there. On success a `<agentId>.diff` is captured (8 MiB cap with marker line on overflow).

```js
const handles = files.map((file) =>
  ctx.agent(`Migrate ${file}. Read it, edit it, verify.`, {
    id: `migrate-${file}`,
    isolation: "worktree",
  })
);
await ctx.phase("migrate", handles);
```

Cwd is asserted to be inside a git worktree before dispatch. Outside a git tree throws `NotAGitRepoError`. Worktree mode is **not** in the cache key (mirrors memory).

### `ctx.promote(agentId, opts?)`

Promote a worktree's edits to the parent CWD.

```js
// Default: 'apply' strategy. Reads <runDir>/worktrees/<agentId>.diff and
// runs `git apply` against the parent CWD. Empty diff is a no-op success.
const a = await ctx.promote("migrate-src/auth.ts");
// → { strategy: 'apply', applied: true, files: ['src/auth.ts'] }

// 'rebase' strategy. Runs `git rebase --onto <target>` inside the worktree.
// Default target is HEAD. Lets the operator handle conflicts in the worktree.
const r = await ctx.promote("migrate-src/auth.ts", { strategy: "rebase", target: "main" });
```

Conflicts surface as `PromoteError` with `conflictFiles` parsed from git stderr.

GC auto-prunes worktrees when the run is cleaned up. Dirty worktrees (`git status --porcelain` non-empty) are skipped with a warn log; pass `forceRemoveDirtyWorktrees: true` to override. `pruneWorktrees: false` disables prune entirely. Resume cross-checks `manifest.agentWorktrees` against `git worktree list` and warns on drift.

---

## Mid-phase HITL: `ctx.interrupt`

Suspends the run until a supervisor injects an answer. Returns `{ key, value }`.

```js
// Free-form answer.
const { value: plan } = await ctx.interrupt({ question: "What's the rollout plan?" });

// Multi-choice with default.
const { value: env } = await ctx.interrupt({
  question: "Pick a deploy target",
  choices: ["staging", "prod", "abort"],
  default: "staging",
});

// Schema validation on the supervisor's answer.
const { value: cfg } = await ctx.interrupt({
  question: "Settings?",
  schema: {
    type: "object",
    required: ["approved"],
    properties: { approved: { type: "boolean" } },
  },
});
// → throws InterruptValueValidationError to the workflow if the value
//   doesn't match. The supervisor sees only the original question.

// String shorthand.
const { value: note } = await ctx.interrupt("Add a release note?");

// Concurrent interrupts: capture each key for explicit routing.
const [a, b] = await Promise.all([
  ctx.interrupt({ question: "Region A?" }),
  ctx.interrupt({ question: "Region B?" }),
]);
// a.key === "int-0", b.key === "int-1"
```

### Resume routing

```ts
import { WorkflowClient } from "@samfp/pi-workflows";
const client = new WorkflowClient();

// Resolve the FIFO-oldest pending interrupt.
await client.resume("wf-abc123", { approved: true });

// Or target a specific call site by key (for concurrent interrupts).
await client.resume("wf-abc123", "ship-it", { key: "int-3" });
```

### Replay across pi restart

Keys are deterministic: the Nth `ctx.interrupt(...)` call gets `int-N`. On `/workflows resume <runId>`, prior `interrupt_resolved` ledger entries replay verbatim without re-prompting. Schema validation re-runs on replay so a tightened schema can't accept stale answers.

If no supervisor is wired (no TUI, no `WorkflowClient` in the loop), the call resolves immediately with `opts.default ?? null`. Headless tests stay unblocked.

Full spec: `docs/hitl.md` in the package.

---

## Fork from checkpoint

Replay a parent run's ledger up to a phase, then run a new branch with author-supplied overrides.

```ts
import { forkFromCheckpoint, WorkflowClient } from "@samfp/pi-workflows";

// Direct API.
const fork = await forkFromCheckpoint("wf-abc123", {
  atPhase: "deploy",
  overrides: { target: "staging" },
  preApproved: true,
});
await fork.terminated;

// Via WorkflowClient.
const client = new WorkflowClient();
const fork2 = await client.forkFromCheckpoint("wf-abc123", {
  atPhase: "deploy",
  overrides: { target: "prod" },
});
```

Inside the workflow:

```js
const overrides = await ctx.cache.get("__fork_overrides__");
const target = overrides?.target ?? "staging";
```

What's inherited:
- Manifest carries `parentRunId` and `forkAtPhase`.
- Parent's pre-`atPhase` ledger entries copied verbatim (excluding init/transition/result/error/shutdown/cancelled).
- Parent's `cache.jsonl` copied raw. Pre-fork agents cache-hit. Post-fork `agent_result` records are filtered out so post-fork phases re-dispatch even when prompts didn't change.
- Author overrides stored under `__fork_overrides__` (exported as `FORK_OVERRIDES_KEY`).

Errors: `ForkRunNotFoundError` (parent runId resolves to no dir), `ForkPhaseNotFoundError` (phase not in parent ledger; carries `availablePhases`).

GC validation: a parent with surviving forks is refused by default (`reason: "has-fork-children"`). Pass `force: true` to delete the parent; surviving forks get `parentDeletedAt` patched into their manifest and a tombstone `log: warn` line in their ledger.

Full spec: `docs/time-travel.md`.

---

## Per-phase opts

```js
await ctx.phase("slow-fan-out", handles, {
  failMode: "null",       // null entries for failed agents; default 'throw' rejects with AggregateError
  timeoutMs: 30_000,      // phase-level wall-clock timeout
  maxConcurrent: 4,       // child semaphore for this phase only
});
```

---

## Per-agent opts

```js
ctx.agent(prompt, {
  id: "stable-id",                    // recommended; cache-key stability
  model: "sonnet",                    // model override
  thinking: "on",                     // 'on' | 'off' | 'auto'
  timeoutMs: 600_000,                 // per-agent timeout (default 10 min run-wide)
  cacheKeyExtra: { v: 2 },            // additional cache-key seed
  schema: { /* JSON Schema */ },      // structured output → result.output
  bindToWorkflowVersion: false,       // exclude workflow SHA from cache key (resume-stable recon agents)
  memory: "user",                     // see memory section above
  isolation: "worktree",              // see worktree section above
});
```

---

## Security sandbox

Workflow scripts run inside `node:vm` with `allowCodeGeneration: false`.
No access to `fs`, `net`, `child_process`, `process.env`, `require`, or `import()`.
The `process` global is a frozen stub (platform/arch/versions only).
For file/shell operations, use `ctx.agent` with a pi tool call.

---

## TUI overlay

Open with `w` from any pi session while a workflow is running.

### Runs list

| Key | Action |
|---|---|
| `↑`/`↓` / `j`/`k` | Move selection |
| `Enter` | Drill into phase view |
| `p` | Pause / resume |
| `x` | Stop |
| `r` | Restart (terminal) / resume (paused). Disabled on remote runs. |
| `v` | Render the run's DAG to a `.mmd` tmp file |
| `i` | Answer the oldest pending `ctx.interrupt(...)` (enabled when there's a pending interrupt) |
| `f` | Fork from checkpoint (interactive `atPhase` + overrides JSON dialog) |
| `g` | GC dialog |
| `Esc` | Close |
| `?` | Toggle help |

### Phase view

| Key | Action |
|---|---|
| `↑`/`↓` / `j`/`k` | Move agent cursor |
| `Enter` | Open agent detail |
| `p` | Pause / resume |
| `x` | Stop the run, or stop the selected running agent |
| `r` | Restart the run, or restart the selected running agent |
| `s` | Save script to `.pi/workflows/<name>.js` (terminal runs, local only) |
| `v` | Render the DAG |
| `i` | Answer pending interrupt |
| `Esc` | Back |

### Agent detail

| Key | Action |
|---|---|
| `↑`/`↓` / `j`/`k` | Scroll |
| `t` | Open transcript in `$EDITOR` (TUI viewer fallback) |
| `c` | Copy prompt to clipboard |
| `Esc` | Back |

---

## Observability: OpenTelemetry

Both exporters are off by default and tail `<runDir>/ledger.jsonl` independently.

```sh
# Catch-all: both signals share an endpoint.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Or signal-specific.
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics

# Optional: tag every span/metric.
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=workflows"
```

**Traces** follow the OTel Gen-AI semantic conventions. Span tree: `invoke_workflow` → `phase` → `invoke_agent`. Per-leaf attributes include `gen_ai.usage.{input,output,cache_read,cache_creation}_tokens`. Span events surface `ctx.log` and `ctx.gate` entries that don't open their own span.

**Metrics**: counters (`pi.runs.started`, `pi.runs.completed{outcome}`, `pi.agents.invoked`, `pi.agents.errored{error_class}`) and Gen-AI histograms (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `pi.run.duration`). Flushed every 60s and on session shutdown.

OTel SDK packages are in `optionalDependencies`. Missing deps fall back to a no-op handle with one warning.

Local smoke recipe with Jaeger + Prometheus + Grafana: `examples/otel-smoke/` in the package, or `npm run smoke:otel` for a pointer. Full reference: `docs/otel.md`.

---

## `/codebase-audit [path]`

4-phase workflow:
1. **recon**: list key areas + files
2. **analyse**: parallel deep-dive per area (cached by prompt + file hash)
3. **vote**: 3-agent Borda-count ranking
4. **summarise**: final structured report

Cache: analyse results cache-hit on re-run if files unchanged.

## `/deep-research <question>`

Bundled. Fans web research across 4 to 6 angles, cross-checks uncertain claims, returns a cited Markdown report.

---

## Testing a workflow with mock agents

```ts
import { runWorkflow } from "@samfp/pi-workflows/testing";
import { createHash } from "node:crypto";

const promptHash = createHash("sha256").update("Answer: test input").digest("hex");

const result = await runWorkflow({
  workflowPath: "./my-workflow.js",
  input: "test input",
  mockAgents: true,
  seedFixturesJsonl: JSON.stringify({
    agentId: "answer",
    promptHash,
    result: { text: "42", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } },
  }),
});
assert.equal(result.text, "42");
```

See `docs/integration-testing.md` for cache assertions, phase-structure tests, and fixture authoring.

---

## Useful slash commands

```
/workflows list         # list active + recent runs
/workflows status <id>  # status of a specific run
/workflows resume <id>  # re-attach to a completed run (gates through pi.ui.confirm)
/workflows kill <id>    # kill a running workflow
/workflows gc           # garbage-collect old terminal runs
/workflows keyword on   # toggle the `workflow` keyword auto-trigger
```

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Trust check failed` | SHA-256 changed (file edited) | Re-approve with `y` |
| Phase hangs forever | Agent timeout not set; check `opts.timeoutMs` | Add `timeoutMs` to `ctx.agent` opts, or `timeoutMs` on `ctx.phase` |
| `Cannot find workflow` | File not in a discovered directory | Move to `~/.pi/agent/workflows/` or `.pi/workflows/` |
| `ReferenceError: require is not defined` | Workflow uses Node built-in | Use `ctx.agent` to delegate file/shell ops |
| `ReferenceError: X is not defined` | Variable declared at module level | Move ALL `const`/`let` inside `export default function` body. Only `export const meta` and `export default function` are valid at module level |
| `AbortError` mid-run | User pressed `x` or pi shut down | Check `ctx.signal?.aborted` in loops |
| TUI overlay shows `[remote]` | Run started in a different pi session | Manage via `/workflows`; `r`/`s` are disabled on remote runs |
| `empty-stdout-failure` on agent crash | Agent prompt is too large | Don't interpolate full file contents into prompts; tell agents to read files themselves |
| `ReadOnlyMemoryError` | `ctx.memory.append` against a tuple some agent mounted `readOnly: true` | Drop the readOnly flag on the agent, or use a different `(scope, name)` |
| `NotAGitRepoError` | `isolation: 'worktree'` outside a git tree | Cd into a git work tree, or drop the isolation flag |
| `PromoteError` with `conflictFiles` | `ctx.promote` ran into merge conflicts | Resolve in the worktree (rebase strategy leaves it mid-rebase) or fall back to manual git ops |
| `InterruptValueValidationError` | Supervisor's resume value didn't match `opts.schema` | Tighten/loosen the schema, or have the supervisor send a conformant value |
| `ForkPhaseNotFoundError` | `atPhase` not in parent ledger | Check `error.availablePhases` for spelling |

---

## Authoring patterns

### File content: never inline, always delegate
```js
// WRONG: interpolating file content into downstream agent prompts
// causes context crashes on large files
const impl = await ctx.agent(`Fix this file:\n${fileContent}`)

// RIGHT: tell agents to read files using their tools
const impl = await ctx.agent(`Read /path/to/file, then fix the issue.`)
```

### Implement agents should write directly; skip a separate apply phase
Give implement agents write tool access. They read, modify, verify in one turn.
A separate "apply" agent that receives full file contents as interpolated strings will hit context limits and crash.

### Scope ALL variables inside the function body
```js
// WRONG: module-level const silently unavailable inside the function
const BASE = '/Users/me/project'
export default async function(ctx) {
  ctx.agent(`${BASE}/file.ts`) // ReferenceError: BASE is not defined
}

// RIGHT
export default async function(ctx) {
  const BASE = '/Users/me/project'
  // ...
}
```

### Return structured data from recon agents
End recon agent prompts with an explicit JSON format instruction, or set `opts.schema`. Use `ctx.extractJSON(text)` to parse fenced JSON tolerantly. Downstream agents receive structured data, not prose. Less parsing ambiguity.

### Phase failure is an AggregateError
`ctx.phase()` throws `AggregateError` if any agent fails. Wrap phases in try/catch, or pass `{ failMode: 'null' }` so failed agents become `null` entries in the result array.

### Use worktrees for parallel write-heavy work
Agents that edit files should run with `isolation: 'worktree'` when fanned out. Stops same-file write races. Promote the diffs back with `ctx.promote(agentId)` once the phase resolves.

### Use HITL for irreversible decisions
Don't infer "ship to prod" from a chain of agent prose. `ctx.interrupt({ choices: [...] })` makes the human decision explicit, ledgered, and replayable.

---

## Bundled workflows

`/codebase-audit` and `/deep-research` self-install to `~/.pi/agent/workflows/` on first session start.

---

## Parity gaps vs Claude Code (v1)

- No `/effort ultracode` modifier (auto-workflow for every task).
- Logs are not exported via OTel (traces and metrics ship in v0.3).

Full list: `docs/parity-gaps.md` in the package.
