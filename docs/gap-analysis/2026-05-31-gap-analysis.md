# pi-workflows Gap Analysis

**Date:** 2026-05-31
**Scope:** Where `@samfp/pi-workflows` stands against Claude Code Dynamic Workflows, LangGraph, Temporal/Inngest/Restate, AutoGen/CrewAI, DSPy, Anthropic Skills + Subagents, and OpenAI Swarm / Semantic Kernel.

## TL;DR

pi-workflows has the strongest sandbox and the only true cross-process resume in the comparison set. The gaps are above the runtime: no persistent per-persona memory, no git-worktree isolation, no mid-phase HITL, no time-travel/fork. The cheapest immediate wins are wiring four already-implemented TUI hotkeys (`r`/`s`/`t`/`c`), shipping `ctx.extractJSON` + schema validation as stdlib, and adding `agent-memory/<name>/` auto-injection. Sandbox + ledger + supervision IPC remain the moats and don't need defending.

---

## Where pi-workflows stands today

### Current capabilities

- Three-scope workflow discovery (project `.pi/workflows/`, personal `~/.pi/agent/workflows/`, bundled) with slash-command registration and chokidar hot-reload.
- `node:vm` Context sandbox (frozen prototypes, `allowCodeGeneration:false`, curated globals) hosted in a `worker_thread` so `AbortSignal.terminate()` hard-kills runaway scripts including async-only loops.
- Full `ctx.*` author API: `agent`/`phase`/`cache`/`log`/`finishCallback`/`run`/`input`/`signal` plus stdlib `vote`/`consensus`/`parallel`/`retry`/`sleep`/`pipeline`/`memo`/`checkpoint`/`progress`/`report`/`budget`.
- FIFO async semaphore (default cap 16) with per-phase `maxConcurrent`, `timeoutMs`, `failMode: 'throw'|'null'`.
- `pi --mode json -p` subprocess fleet with JSON-stream parser, torn-line recovery, parent-death SIGTERM guard, schema validation (`KNOWN_EVENT_SHAPES`), and a mock-agents fixture branch.
- Run-scoped JSONL cache + cross-run global cache keyed by script SHA-256, plus `ctx.memo` with TTL.
- Append-only `ledger.jsonl` + state machine (`pending→approved→running→paused→done|failed|stopped`), crash sweep on session start, cooperative pause/resume, and resume across full pi restarts.
- Trust + approval flow: SHA-256 hash, first-run prompt with always/per-session, `BYPASS_TRUST=1` escape hatch, trust revocation on file change.
- TUI overlay (hotkey `w`) with three drill-down levels, GC dialog with active-lineage exclusion, transcript open, save-script-to-project, `[remote]` cross-process badges.
- File-based supervision IPC (`.active` index, `ledger.jsonl` tail, `ctrl.jsonl`) exposed via `WorkflowClient` — any sidecar can tail/append without a SDK.
- `write_workflow` LLM tool: model authors a script, SHA-trust gate, save → dashboard-visible → runnable in one tool call.
- Bundled `/codebase-audit` reference workflow + pi-dashboard plugin.

### Stack

`node:vm` Context + `worker_thread`; TypeScript dual-config (tsc + esbuild); peer-dep on `@earendil-works/pi-coding-agent`; `pi --mode json -p` subprocess fleet (no `pi-conductor` dep); chokidar 5; `isexe`; append-only JSONL with atomic tmp+rename + fsync; `node --import tsx --test` + c8 (≥85% line / ≥70% branch).

---

## What we do better than peers

**Hash-pinned trust + node:vm + worker_thread + AbortSignal.terminate is the strongest sandbox in the comparison set.** SHA-256 trust gate per `(absPath, content)`, frozen prototypes, IIFE-scoped init so `wrapHostMethod` / `__pi_unwrap` aren't reachable as globals (BUG-023), worker isolation so `AbortSignal.terminate()` actually kills async-only loops, bridge-nonce closure-hide with post-init tamper check. Of all eight peers, only pi-workflows isolates the orchestration script itself — Claude Code says "isolated environment" but exposes no hard-kill; LangGraph/AutoGen/CrewAI/DSPy are import-and-trust libraries; Temporal sandboxes only for determinism; Restate/Inngest run user code in your process.

**Cross-process durable resume across full pi restarts.** Append-only ledger with documented torn-write semantics, atomic `.active` index (tmp+rename+fsync), three-layer crash recovery (parent-death wrapper script + `sweepCrashedRuns` on `session_start` + advisory `failed→running` edge in `resumeRun`), bit-exact resume from frozen `runDir/script.js`. Claude Code's docs are blunt: *"If you exit Claude Code while a workflow is running, the next session starts the workflow fresh."* Only Temporal/Restate match cross-host, both at the cost of a server cluster.

**Externalised supervision IPC is broadly tail-able with no special API.** `.active` + `ledger.jsonl` + `ctrl.jsonl` are O_APPEND files under PIPE_BUF; any process can tail/append without coordination. pi-dashboard reads them today; a watchdog cron or observability sidecar can without an SDK. Claude Code's `/workflows` view is in-app only; LangGraph requires LangSmith credentials.

**Real OS subprocess agents, not in-process LLM calls.** Each agent is `pi --mode json -p` spawned via `nodeSpawn` with parent-death SIGTERM guard, JSON-stream parser with torn-line recovery, per-agent transcripts at `<runDir>/agents/<id>.jsonl`, mock-fixture branch for tests. `AgentSubprocessError` vs `MalformedAgentOutputError` vs `MockFixtureMissingError` taxonomy. LangGraph/AutoGen/CrewAI/DSPy run agents as functions in the parent process — no separate transcripts, no separate budgets, no harness-swap per agent.

**Late cache-hit recovery from on-disk transcripts.** `recoverFromTranscript` replays a tee'd `<agentId>.jsonl`, tolerates a torn trailing line, synthesizes an `AgentResult` if `agent_end` is present. A parent crashing *after* the subprocess exited but *before* `cache.setAgentResult` flushed doesn't burn tokens on resume. None of the peers have this.

**Wrapper-identity oracle as a structural regression test.** `tests/security/fixtures/host-realm-eval.workflow.js` asserts `surface.constructor === Function` for every host-bridged `ctx.*` method, every stdlib helper, every signal method. Adding a new method without `wrapHostMethod` immediately flips a check. Catches regressions by *absence of a row*, not by escape behaviour. No peer has anything like this.

**First-class fan-out/aggregate stdlib (vote, consensus, parallel, pipeline, retry, sleep, budget).** Stdlib is spliced as source string into the sandbox init so `.constructor === Function` inside the realm; tokenizer is a regex-free char-code loop to avoid catastrophic-backtracking. Swarm has only sequential `active_agent`; SK Concurrent broadcasts but doesn't aggregate; LangGraph requires authoring `Send()` + a reducer per case; AutoGen GroupChat is conversational convergence not aggregation; CrewAI Tasks are 1:1.

**LLM-authored workflows with SHA-trust gating.** `write_workflow` ships ~100 lines of LLM-targeted teaching as part of tool registration; `bundledWorkflows.ts` maintains a sha256-keyed managed-ledger so installs are upgrade-safe and never overwrite user edits. None of the peers treat user code as untrusted; none could ship this feature without rebuilding pi-workflows' isolation story.

---

## Gap matrix

| Title | Category | Effort | Peers with it | Why it matters |
|---|---|---|---|---|
| No persistent per-agent / per-persona memory | capability | M | Claude Code, Anthropic Subagents | Saved workflows are stateless reruns. `agent-memory/<name>/` + auto-injected `MEMORY.md` turns each subagent into a compounding asset. Highest-leverage capability gap. |
| No git-worktree isolation per agent | capability | M | Claude Code Subagents (`isolation: worktree`) | Every agent shares parent CWD. `hunt-bugs-loop` documents BUG-W02 (same-file write race). Migration-class workflows can't fan out write-heavy work safely. |
| No mid-phase HITL pause-and-route primitive | capability | M | LangGraph (`interrupt()`), CrewAI (`@human_feedback`), Semantic Kernel (`InteractiveCallback`) | Run-level pause exists; "pause this phase, ask a structured question, route on the answer" doesn't. Three peers ship the same shape under three names. |
| No time-travel / fork-from-checkpoint | capability | L | LangGraph (`update_state(as_node=...)` + branch invoke), CrewAI (`restore_from_state_id`) | Append-only ledger enables resume from failure but not "rewind to phase 3, change one input, run a different branch." Every multi-phase workflow eventually wants this. |
| ~~No critique / adversarial-refute primitive~~ ✅ closed (ZONE_STDLIB) | capability | M | Claude Code, AutoGen Magentic-One, DSPy `MultiChainComparison` | `vote`/`consensus` cover N-peer aggregation; not 1-producer-1-judge or convergence-driven retry. Anthropic's framing is explicitly "agents address from independent angles, others refute, iterate until convergence." Closed via `ctx.critique({producer, critic, maxRounds, accept})` in `src/runtime/stdlib.ts`. |
| ~~No stdlib JSON extraction or schema-validated phase outputs~~ ✅ closed (ZONE_STDLIB) | capability | S | DSPy (typed `Signature` + `JSONAdapter`), LangGraph (typed State channels) | `extractJsonFromText` duplicated verbatim in 3 of 5 examples (~40 LOC each). `buildSchemaInstruction` only appended a schema string — zero validation post-parse, so "wrong shape" silently produced `output={wrongShape}`. Closed via `ctx.extractJSON(text)` (Context-realm, char-code, fence-aware) and `validateAgainstSchema` + `SchemaValidationError` invoked at the agent boundary. |
| ~~Better aggregation primitives (Borda / Schulze / ranked-pairs)~~ ✅ closed (ZONE_STDLIB) | capability | S | DSPy issue #8898 (working draft, MIT) | `codebase-audit` hand-rolls Borda over 3 voter agents because `ctx.vote` only does single-winner. Closed via `ctx.aggregate(method, ballots, opts)` (borda, schulze, ranked_pairs, kemeny_young, instant_runoff, coombs, score, approval) and `ctx.consensus(agents, { method })` integration. |
| TUI hotkeys r/s/t/c are not wired in production | dx | S | — | `s` shows literal `"save-script not wired (slice 14 callback missing)"`; `c` shows fake `"copied:"` banner; `r` emits a stub event; `t` doesn't open anything. The dispatcher, renderers, and `saveScript` module are implemented and tested — only `workflowCmd.ts:323` is missing callbacks. |
| No keyword-trigger workflow drafting | dx | S | Claude Code | Type `workflow` anywhere in a prompt → Claude Code drafts and offers to run a script. `write_workflow` already drafts; only the inline trigger + chip is missing. |
| Code-level dead weight from worker_threads migration | dx | S | — | `sandbox.ts` still defines `raceWithAbort`, `minimalCtxLiteral`, `installConsole`, `installCrypto`, `installBuffer`, `installWebApis`, `getSandboxObject`, `extractLoaderArgs`, `collectHostGlobals`, `bridgeNonce` — none referenced post-migration. ~600 LOC of shadow that drifts. |
| `ctrl.jsonl` IPC has no fallback when `fs.watch` silently fails | reliability | S | — | NFS/FUSE/Docker bind-mounts and macOS edge cases fail silently. Supervisor's pause/stop dropped with no surface signal. `processNewLines` reads whole file on every event with no rotation. |
| `Run.stop()` has no SIGKILL escalation | reliability | S | — | A `pi -p` sub-agent stuck in a tool call ignores SIGTERM and wedges the semaphore. Supervisor sends `{type:'stop'}`, gets no terminal entry, no error, just silence. Overnight-runs case is exactly when it matters. |
| macOS PID-recycle gap in crash sweep | reliability | S | — | `currentBootId` returns `""` on non-Linux. Long-uptime macOS hosts can recycle PIDs; crash sweep declines to reap an actually-dead run. Sam runs pi-workflows on a Mac. |
| `recoverFromTranscript` has no size cap | reliability | S | — | `dispatcher.ts:286` reads the entire transcript via `fs.readFile` during resume — no cap. A long-running agent that wrote a 500MiB transcript before crashing OOMs the resume path. |
| No OpenTelemetry export from the ledger | observability | M | AutoGen, LangGraph, DSPy `mlflow.dspy.autolog` | `ledger.jsonl` is replay-perfect but locked into pi-workflows' own consumers. Every observability ecosystem speaks OTel. Single biggest "integrate with the rest of the world" gap. |
| ~~No DAG / phase-graph visualization~~ ✅ closed (ZONE_VIZ) | observability | S | CrewAI `flow.plot()` | Closed via `src/runtime/visualize.ts` — emits Mermaid `flowchart TD` from `<runDir>/manifest.json` + `<runDir>/ledger.jsonl`. TUI hotkey `v` writes a `.mmd` to `os.tmpdir()`; `ctx.report({format:'mermaid'})` returns the same diagram from inside a workflow. Tested at `tests/unit/visualize.test.ts`. |
| `ctx.log` writes the ledger twice | observability | S | — | `logFn` calls both `ledgerLog` and `ledger.append({type:'agent_log',...})` plus an overlay event — three writes per `ctx.log("hi")`. `tail ledger.jsonl` shows every line twice. |
| Banner state has no TTL | dx | S | — | `"stopping agent abc…"` sticks long after the agent stopped. Reads as "TUI is confused" to anyone who hasn't read the source. |
| ~~`ctx.signal` polyfill diverges from web `AbortSignal`~~ ✅ closed (ZONE_STDLIB) | dx | S | — | No `throwIfAborted()`, no `AbortSignal.timeout`/`any`, `dispatchEvent` no-op. Authors using platform AbortSignal got TypeErrors. Closed via `throwIfAborted()`, real `dispatchEvent`, `globalThis.AbortSignal.timeout(ms)` and `AbortSignal.any(signals)` in `src/runtime/sandbox.ts`. |
| Hot-reload registers a no-op stub for newly added workflows | reliability | S | — | `hotReload.ts:218` registers `handler: async () => log('hot-reload: invoked stub handler')`. User adds a workflow, runs `/<name>`, hits the stub — no trust gate, no execution. |
| No path-sanitization on `agentId` | security | S | — | `agentTranscriptPath`/`agentStderrPath` blindly `join(<runDir>/agents, '${agentId}.jsonl')`. An `agentId` containing `..`, `/`, or NUL escapes `runDir`. Cheap to close. |
| `allowCodeGeneration.strings` defaults to `true`; threat-model says `false` | security | S | — | `sandbox.ts:418` `allowCodegen ?? true` and `threat-model.md:46-55` claim `strings:false` is the defense. Wrapper-identity makes codegen safe-by-construction, but the doc is wrong as written. |

---

## Per-peer comparison

### Claude Code Dynamic Workflows

- **Model.** JS orchestration scripts Claude *writes for the task it's given*, executed in a closed-source background runtime. Concurrency cap 16, hard cap 1000 agent invocations per run. Saved runs become `/<name>` slash commands at `.claude/workflows/` (project) or `~/.claude/workflows/` (user).
- **Killer features pi-workflows lacks.** `agent-memory/<name>/` with auto-injected `MEMORY.md` (three scopes: user/project/local) — highest-leverage port. Inline `workflow` keyword trigger that drafts a script. `/effort ultracode` auto-orchestration mode. `isolation: worktree` subagents. Adversarial-refute as a default convergence pattern.
- **Where pi-workflows wins.** Cross-CLI-restart durability (Claude Code's docs say *"the next session starts the workflow fresh"*). Hard-killable sandbox (their docs expose no hard-kill; only cooperative `x`). Externalised supervision IPC.
- **Sources.** [Workflows docs](https://code.claude.com/docs/en/workflows) · [Anthropic launch post](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) · [Subagents memory + worktree](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory).

### LangGraph

- **Model.** Stateful directed *cyclic* graph with typed `State`, per-key reducers, `Nodes` (`State → Partial[State]`), and edges (static, conditional, or returned as `Command`). Pregel/BSP runtime: each super-step activates nodes whose channels updated, runs them in parallel, merges through reducers. Dynamic fan-out via `Send` API.
- **Killer features.** Time-travel — replay or fork via `update_state(as_node=...)` + `invoke(None, branch_config)`. Generic HITL via `interrupt(payload)` + `Command(resume=value)`. Subgraphs as first-class composition. Resumable streaming with last-event-ID.
- **Trust posture.** Effectively none — a node is a Python function in your process. Recent CVEs (`langgraph-checkpoint <4.0.0` `pickle.loads` RCE, msgpack object reconstruction). Trust the author of every `.py` you import.
- **Where pi-workflows wins.** Real sandbox; subprocess agents instead of in-process LLM calls; single-binary local TUI vs. browser-based LangGraph Studio + LangSmith credentials.
- **Sources.** [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) · [Time-travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel) · [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · [GHSA-mhr3-j7m5-c7c9](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-mhr3-j7m5-c7c9).

### Temporal / Inngest / Restate

- **Model.** All three are imperative-code-with-checkpoints, not graph builders. Temporal: deterministic workflow functions + activities, replay from event history. Inngest: regular functions, `step.run("id", () => ...)` boundaries are memoized by HTTP step. Restate: Basic Service / Virtual Object (Orleans-style keyed entity) / Workflow (exactly-once `run` per ID).
- **Killer features.** Cross-host durability with replay/memoization. Signals/queries/updates against running runs (Temporal, Restate). Idempotency keys + attach-to-running (Restate). Engine-level flow control: throttling, debouncing, rate limits, fairness (Inngest). Versioning + safe redeploy mid-run (Temporal `getVersion`, Restate immutable deployments).
- **Trust posture.** None of the three sandboxes user code for security. Temporal's `node:vm` setup is for determinism, not isolation. Restate/Inngest run user code in your process.
- **Where pi-workflows wins.** Agent-native primitives (vote/consensus/parallel/Borda — none of the three understand "this step is an LLM call that may need re-spawning"). Zero infrastructure (Temporal needs Cassandra/Postgres + worker fleet; Restate needs the server binary). Sandbox-as-trust-boundary + LLM-authorable workflows.
- **Worth porting.** Step-level memoization inside `ctx.run` so a phase resumes mid-flight. Signals + `ctx.waitForSignal(name)` against running phases. Idempotency keys to dedup re-launches of `/<name>`.
- **Sources.** [Temporal workflows](https://docs.temporal.io/workflows) · [Inngest function execution](https://www.inngest.com/docs/learn/how-functions-are-executed) · [Restate key concepts](https://docs.restate.dev/concepts/key-concepts).

### AutoGen and CrewAI

- **Model.** AutoGen v0.4+ is a layered actor framework with team presets (`RoundRobin`, `Selector`, `Swarm`, `MagenticOneGroupChat`, `SocietyOfMindAgent`). **Officially in maintenance mode** — Microsoft now points new users at "Microsoft Agent Framework." CrewAI is roles + tasks under `sequential`/`hierarchical` Process modes, plus a separate Flows layer with `@start`/`@listen`/`@router`/`and_`/`or_` decorators on Pydantic state.
- **Killer features.** Magentic-One Task Ledger / Progress Ledger (planner that re-plans when stuck). CrewAI `@human_feedback` with LLM-classified `emit=["approved","rejected","needs_revision"]` routing. CrewAI `flow.plot()` interactive HTML DAG. CrewAI `kickoff(restore_from_state_id=<uuid>)` forks. AutoGen built-in OpenTelemetry with Gen-AI semantic conventions.
- **Trust posture.** AutoGen sandboxes *agent-generated* code (Docker executor with `approval_func`), not the orchestrator script. CrewAI has zero sandboxing of user code.
- **Where pi-workflows wins.** Sandboxing the orchestration script itself. Voting/consensus as first-class API (AutoGen GroupChat is conversational convergence; CrewAI Tasks are 1:1). Slash-command ergonomics in an interactive session.
- **Worth porting.** `ctx.critique({producer, critic, maxRounds, accept})` for the 1-producer-1-judge case. `ctx.feedback({emit, default})` modeled on `@human_feedback`. Mermaid emission from AST or ledger.
- **Sources.** [AutoGen Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) · [Magentic-One paper](https://arxiv.org/abs/2411.04468) · [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) · [CrewAI human feedback](https://docs.crewai.com/en/learn/human-feedback-in-flows) · [AutoGen tracing](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tracing.html).

### DSPy

- **Model.** Library-style declarative programming. Subclass `dspy.Module`, declare typed `Signature`s, compose in `forward()`. Built-in `Predict`/`ChainOfThought`/`ReAct`/`MultiChainComparison`/`Ensemble`. The twist: a *compiler* (`MIPROv2`, `GEPA`, `BootstrapFewShot`) takes program + metric + trainset and mutates prompts/demos to improve the metric — programs are "trainable."
- **Killer features.** Prompt/program optimizers as first-class. Typed Signatures + Adapters (`JSONAdapter` for structured outputs). Open issue #8898 has working drafts of `borda_count`, `ranked_pairs`, `schulze_method`, `kemeny_young`, `instant_runoff`, `coombs_method`, `score_voting`, `approval_voting` under MIT — straight lift target. MLflow autolog for traces + optimizer experiments. Three-layer LM cache (LRU → diskcache → provider prompt cache).
- **Trust posture.** None. `cloudpickle.dump(program)` + warning to "only load from trusted sources."
- **Where pi-workflows wins.** Trust + sandbox boundary. Durable resumable supervisable runs (DSPy "persistence" is fitted weights, not run state). Real subprocess fleet vs. `ThreadPoolExecutor` over LM calls.
- **Worth porting.** Borda/Schulze code from #8898 directly into `ctx.consensus`. Typed/structured outputs at the phase boundary.
- **Sources.** [Modules](https://dspy.ai/learn/programming/modules/) · [Signatures](https://dspy.ai/learn/programming/signatures/) · [MIPROv2](https://dspy.ai/api/optimizers/MIPROv2/) · [Aggregation issue #8898](https://github.com/stanfordnlp/dspy/issues/8898) · [MLflow autolog](https://mlflow.org/docs/latest/genai/tracing/integrations/listing/dspy/).

### Anthropic Skills + Subagents (pi-conductor sibling)

- **Skills.** Folder of `SKILL.md` + bundled scripts. Three-level progressive disclosure: name+description (~100 tokens always-on) → body (<5k loaded on match) → bundled files (only when invoked). Not a workflow language; lazy-loaded prompt fragments + helper scripts.
- **Subagents.** Markdown + YAML frontmatter at `.claude/agents/<name>.md`. Frontmatter fields: `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `skills`, `memory`, `isolation: worktree`, `background`, `effort`. Orchestration shape = "tell Claude in English to spawn N in parallel." No graph, no voting, no consensus.
- **Killer features.** Progressive disclosure as a loading model. `isolation: worktree` with auto-cleanup. `memory: user|project|local` mounting `agent-memory/<name>/`. `PreToolUse` shell hooks for individual tool-call validation. Inline-scoped MCP servers per subagent. Open standard at [agentskills.io](https://agentskills.io) (Dec 18 2025).
- **Trust posture.** Skills explicitly punt: *"Treat like installing software. Only use Skills from trusted sources."* No SHA pinning, no first-run prompt, no signature.
- **Coexistence with pi-conductor.** Two independent semaphores (conductor default 4, workflows default 16) — a workflow inside a conductor session can spawn 4 + 16 = 20 children. State dirs are disjoint. Tool-routing ambiguity (model can pick `ensemble_spawn` when it should `/<workflow>`). **Action items:** warn at run start when conductor mode is on; document the dual-cap math; add system-prompt hint to prefer `/<workflow>` for deterministic phase plans.
- **Sources.** [Subagents docs](https://docs.claude.com/en/docs/claude-code/sub-agents) · [Skills overview](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) · [Skills launch post](https://www.anthropic.com/news/skills) · [agentskills.io](https://agentskills.io).

### OpenAI Swarm / Microsoft Semantic Kernel

- **Model.** Swarm: two primitives — `Agent` (instructions + tools) and *handoff* (a tool returning another `Agent`). One synchronous `while` loop. Stateless across calls. **Officially deprecated** in favor of OpenAI Agents SDK. Semantic Kernel original Stepwise/Handlebars planners are also **removed** — replaced by plain function-calling. SK Agent Orchestration (experimental) ships five named patterns: `Concurrent` / `Sequential` / `Handoff` / `GroupChat` / `Magentic`.
- **Killer features.** Magentic planner-manager (LLM manager picks specialist + synthesizes final report). Typed handoff graph with rationale strings (`OrchestrationHandoffs.Add(triage, status, "Transfer if order-status related")`). Five orchestration shapes behind one interface. SK Process Framework with Dapr/Orleans distributed durable runtime. `InteractiveCallback` for synchronous mid-run user questions.
- **Trust posture.** Zero in both. Swarm is library-style; SK assumes you own the host process.
- **Where pi-workflows wins.** Sandboxed trust-gated hot-reloaded user scripts. Real durable resume (SK Agent Orchestration is in-memory actors with no documented resume; Swarm is explicitly stateless). Parallel sub-agent fleet with per-phase concurrency caps (Swarm is strictly sequential).
- **Honest take on "should we grow a planner?"** Magentic is the strongest argument for *yes* — but as an additive opt-in, not a default. A `ctx.magentic({members, manager, max})` stdlib helper that internally builds a script-equivalent run record (so resume still works) covers the open-ended-research case that's awkward to express today.
- **Sources.** [Swarm core.py](https://github.com/openai/swarm/blob/main/swarm/core.py) · [SK planning deprecation](https://learn.microsoft.com/en-us/semantic-kernel/concepts/planning) · [SK Magentic](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/magentic) · [SK Handoff](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff).

---

## Next three

### 1. Finish wiring TUI hotkeys (r/s/t/c) and add banner TTL

Slice 14 is unfinished. Pressing `s` shows the literal string `"save-script not wired"`; `c` shows a fake `"copied:"` banner; `r` emits a stub event; `t` doesn't open anything. The dispatcher, renderers, `saveScript` module, and `openTranscriptInEditor` are all implemented and tested — only `workflowCmd.ts` needs the callbacks. Cheapest morale and credibility win available, fixes the most-noticed UX paper-cut, clears the path for persona-memory and worktree work. Add `{text, expiresAtMs}` to the banner shape with a 4s default TTL while in there.

### 2. Persistent per-agent memory (`agent-memory/<name>/` + MEMORY.md auto-injection)

Highest-leverage capability port from the peer set: turns saved workflows into compounding assets across runs instead of stateless reruns. Surface is small — frontmatter field on phase/agent, auto-mount, auto-inject the first ~25KB of `MEMORY.md`. Claude Code shipped this as the headline feature for subagents; pi-workflows has the trust model and OS-subprocess primitives that make it strictly safer to host. Track in the manifest so resume re-mounts the same dir.

### 3. Stdlib `ctx.extractJSON` + schema validation at the phase boundary

The single biggest stdlib gap visible from the bundled examples — 3 of 5 duplicate ~40 lines of brace-walking with the same char-code workaround comment. Most concrete reliability win: today an agent returning the wrong shape silently produces `output={wrongShape}`. Pairs naturally with a one-shot port of DSPy issue #8898's Borda/Schulze code (MIT, working draft already exists) so `ctx.consensus` stops being a Jaccard-token-overlap heuristic. Small effort, immediate win for every workflow author.

---

## Appendix

This report lives at `/Users/sam.painter/Projects/pi-workflows/docs/gap-analysis/`. The recon, explore, and research transcripts that fed it are recorded in the workflow ledger at `~/.pi/agent/workflows/runs/` under the runIds from this session — drill in via `/workflows` (hotkey `w`) for full agent transcripts, or tail `ledger.jsonl` directly.
