# Changelog

All notable changes to `@samfp/pi-workflows` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

**`run_workflow` LLM tool.** The model can now trigger an existing workflow
by name without the user having to type the slash command. Companion to
`write_workflow`: same `pi.registerTool` plumbing, same `startWorkflowRun`
+ `wireRunDelivery` path the `/<name>` slash-command takes. Closes the gap
where the model could *list* workflows but couldn't *invoke* one.
Parameters: `name` (slug, leading `/` tolerated) and optional `input` (the
slash-command argument). Lookup miss returns the available-workflows list
so the model can correct the name on retry. `tests/unit/runWorkflowTool.test.ts`
covers normalisation, registration, lookup, dispatch, and start failures.

### Fixed

**Workflow completions now reliably notify the conductor.** When a workflow
run terminates while the parent pi session is mid-stream (the common case —
workflow runs are typically invoked as a tool call), `pi.sendUserMessage`
was being called without `deliverAs`, which throws when the agent is
streaming. The thrown error was silently swallowed, so the conductor never
learned the workflow finished. `deliverRunResult` now passes
`{ deliverAs: "followUp" }`, queuing the completion message until the
conductor goes idle and then triggering a turn. Older pi builds that reject
the second arg fall back to the no-options form. See
`tests/unit/resultDelivery.test.ts` for the regression coverage.

## [0.5.0] - 2026-06-01

### Fixed (automated bug-hunt — 5 passes, ~35 bugs)

- **sandbox**: timer callback throws now abort the run via `_runAbort` — previously logged silently and execution continued
- **dispatcher**: `tool_execution_start` counted as a tool call; BUG-149 context-overflow recovery (`AgentResult.truncated`); spawn errors preserved; abort listener cleaned on all exit paths
- **ctx/phase**: `agentCount` decremented on failure — each failed agent was permanently consuming a concurrency slot
- **runLock**: unlink on write failure; stale-lock process-liveness recovery; `statSync` errors in `ResumeLockedError`; fd guarded
- **gc**: fork-children filter runs in dry-run mode too (no phantom deletions); `ageDays` floored at 0
- **cache / memoStore**: `entriesSinceCompaction` compare-and-swap reset; `drainBatchSync` surfaces fs errors
- **timerTable**: no double-fire of `onTimerError` on successful realm-error reconstruction
- **stdlib**: `ctx.parallel` fn receives `(item, index, ctx)` like `Array.prototype.map` — BUG-W06
- **worktree**: LFS support; named-branch flag (`{ mode: 'worktree', branch }`) end-to-end
- **runManager / resumeRun**: `PauseGate` released after state transition confirmed

### Added

- `run_workflow` LLM tool — model can trigger workflows by name without slash command
- `AgentResult.truncated` — signals context-overflow synthetic result

## [0.3.0] - 2026-05-31

### Added

**Persistent per-agent memory.** New `memory` opt on `ctx.agent` mounts a
`MEMORY.md` under one of three scopes (`'user'` → `~/.pi/agent/workflows/agent-memory/`,
`'project'` → `<cwd>/.pi/workflows/agent-memory/`, `'local'` → per-runDir);
up to 25 KiB is auto-injected as `Persistent memory:\n…` and sub-agents emit
`{type:'memory_update'}` JSONL events to append back. `{ scope, readOnly: true }`
for shared playbook personas. Stdlib helpers `ctx.memory.read/append/compact`.
See `docs/agent-memory.md`.

**Git-worktree isolation.** New `isolation: 'worktree'` opt on `ctx.agent`
creates `<runDir>/worktrees/<agentId>/` off HEAD, swaps the agent's cwd,
and emits `<agentId>.diff` on success. `ctx.promote(agentId, {strategy})`
applies or rebases worktree edits back to the parent. GC auto-prunes on run
delete (refuses dirty worktrees without `force: true`). See `docs/agent-worktree.md`.

**Time-travel / fork-from-checkpoint.** `forkFromCheckpoint(parentRunId, {atPhase, overrides})`
copies the parent ledger and (filtered) cache up to `atPhase` into a new
runDir; overrides land in `__fork_overrides__` cache key. Strict cache
filtering excludes phases ≥ atPhase to prevent silent cache-hits. Resume of
a fork surfaces `parentRunId` / `forkAtPhase` in errors and a `fork_lineage`
ledger entry. GC refuses to delete a parent run with live forks unless
`force: true`. New `f` hotkey in the runs-list view. See `docs/time-travel.md`.

**Mid-phase HITL.** `ctx.interrupt({question, choices?, default?, schema?})`
pauses the run, writes an `interrupt_requested` ledger entry, and blocks
until a `resume` ctrl entry arrives. Returns `{key, value}` so authors who
fan out concurrent interrupts can route resumes deterministically.
`WorkflowClient.resume(runId, value, {key?})` is the supervisor injection
point. Optional `schema` validates resume value before the call resolves.
New `i` hotkey in the overlay surfaces an inline prompt via `pi.ui.confirm` /
`pi.ui.input`. See `docs/hitl.md`.

**OpenTelemetry export.** New `src/runtime/otelExporter.ts` (traces) and
`otelMetricsExporter.ts` (metrics) tail `ledger.jsonl` and emit OTel signals
with Gen-AI semantic conventions. Span tree: `invoke_workflow` → `phase` →
`invoke_agent`; `log` and `gate_*` ledger entries attach as span events.
Metrics: counters (`pi.runs.started/completed`, `pi.agents.invoked/errored`)
and histograms (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`,
`pi.run.duration`). Activated via `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`; absent → strict no-op. SDK packages
in `optionalDependencies` so install never blocks. Honors
`OTEL_RESOURCE_ATTRIBUTES`. Smoke recipe at `examples/otel-smoke/`
(Jaeger + Prometheus + Grafana via `docker-compose`). See `docs/otel.md`.

**Stdlib expansion.** `ctx.extractJSON(text)` (char-code, fence-aware,
truncation-tolerant). Phase-boundary schema validation when `opts.schema`
set (throws `SchemaValidationError`). `ctx.aggregate(method, ballots, opts)`
ports DSPy issue #8898's working draft (MIT): `borda`, `schulze`, `ranked_pairs`,
`kemeny_young`, `instant_runoff`, `coombs`, `score`, `approval`. `ctx.consensus`
now accepts `method` in addition to its prior Jaccard heuristic.
`ctx.critique({producer, critic, accept, maxRounds})` 1-producer-1-judge
convergence loop. Real `AbortSignal` polyfill: `throwIfAborted()`,
`AbortSignal.timeout`, `AbortSignal.any`, working `dispatchEvent`.

**TUI hotkeys.** `r` (restart phase), `s` (save script), `t` (open transcript
in editor), `c` (copy to clipboard), `i` (answer interrupt), `v` (Mermaid DAG
to tmp), `f` (fork-from-here in runs-list). Banner state now `{text, expiresAtMs}`
with 4 s default TTL.

**DAG visualization.** `src/runtime/visualize.ts::renderMermaid(runDir|manifest)`
emits a `flowchart TD`. `ctx.report({format:'mermaid'})` exposes the same
in-workflow.

**Public type surface.** `src/types/public.d.ts` extended with
`MemoryScope`, `MemoryCompactResult`, `IsolationMode`, `AggregateMethod`,
`AggregateResult`, `CritiqueOpts/Result`, `InterruptOpts/Result`,
`PromoteOpts/Result`, `AgentOpts.memory`, `AgentOpts.isolation`,
`WorkflowContext.{extractJSON, aggregate, critique, memory.*, interrupt, promote}`
and a `report({format:'mermaid'}): string` overload. Shipped to `dist/types/`
and re-exported from `index` so authors get types via either
`/// <reference types="@samfp/pi-workflows" />` or explicit `import type`.

### Fixed

- **SIGKILL escalation grace timer was unref'd**, so libuv didn't wake the
  loop until the test's 5 s timeout fired. Cooperative `Run.stop()` paths
  also left a 5-second ghost `SIGKILL` timer firing against an already-dead
  PID. Both fixed by ref-ing the grace timer and clearing it on cooperative
  exit.
- **`recoverFromTranscript` had no size cap.** Now caps at 64 MiB; oversize
  files are tail-read so `agent_end` recovery still works without OOM.
- **`agentTranscriptPath`/`agentStderrPath` accepted any `agentId`.** Now
  rejects `..`, `/`, `\`, NUL, and leading `.` via `assertSafeAgentId`.
- **`currentBootId` returned `""` on macOS,** so long-uptime hosts never
  reaped crashed runs. Now uses `sysctl kern.boottime` (`darwin-<sec>`).
- **`ctx.log` wrote the ledger twice.** Each call now produces exactly one
  `log` ledger entry (overlay event preserved).
- **`ctrl.jsonl` IPC had no fallback.** Polls 1 s mtime alongside `fs.watch`
  so silent watch-failures (NFS, Docker bind-mounts) don't drop control
  messages. Byte-offset tracking + 8 MiB rotation.
- **Hot-reload registered a no-op stub** for newly-added workflows. Both
  stub sites now route through `registerSingleWorkflowCommand`.
- **`allowCodeGeneration.strings` defaulted to `true`** while threat-model
  said `false`. Default flipped to `false`; the two security fixtures that
  need codegen on opt in explicitly.
- **Sandbox dead-weight cleanup** removed `installConsole/Crypto/Buffer/WebApis`,
  `getSandboxObject`, `extractLoaderArgs`, `minimalCtxLiteral` and other
  pre-bridge helpers (~70 lines).
- **Resume cross-check** for memory + worktree paths warns when the live
  re-resolver disagrees with the manifest entry (e.g. cwd changed between
  parent crash and resume).
- **`fakeChild` test fixture leaked a 60 s `setTimeout` ref'd**, causing
  `dispatcher.test.ts` to take 60+ s wall time. Now cleared on `kill()`.
  Suite is back to ~12 s.

### Build

- `dist/sandboxWorker.js` and `dist/sandboxWorkerBoot.mjs` shipped via a
  second esbuild entrypoint + copy step (was failing at runtime with
  "Cannot find module .../sandboxWorkerBoot.mjs"). Removed in favor of
  in-process `vm.runInContext` once the worker_threads experiment was
  rolled back.
- `dist/types/public.d.ts` and `dist/types/internal.d.ts` now copied at
  build time (tsc's `--declaration` doesn't emit from `.d.ts` inputs).
  Public types now reach end users via the package's main `dist/index.d.ts`.

### Other

- `write_workflow` tool path now wires `Run.terminated → deliverRunResult`,
  so workflows kicked off via the tool fire the result card AND
  `pi.sendUserMessage` when they finish. Previously the run completed
  silently — no card, no `result.json`, and the host pi conversation
  never resumed. The slash-command path (`/<workflow-name>`) was
  unaffected. Both call sites now share the new `wireRunDelivery`
  helper in `src/runtime/resultDelivery.ts`.

## [0.2.0] - 2026-05-29

### Added
- `write_workflow` LLM tool — the model can now write and save workflow scripts
  directly when the user asks for fan-out, multi-agent, or parallel tasks.
  The tool validates the `export const meta = {...}` header, saves to
  `.pi/workflows/<name>.js`, and offers to run the workflow immediately.
  This is the "keyword trigger" equivalent for pi (analogous to Claude Code's
  `workflow` keyword detection).
- `promptGuidelines` teach the model when to invoke the tool and how to write
  correct workflow syntax using the full `ctx.*` API surface.
- `hasMetaFirst()` strip-then-check validates that `export const meta` is the
  first meaningful statement — correctly rejects scripts with imports or
  function declarations before the meta export.
- `runNow: boolean` parameter — when `true`, the tool invokes `startWorkflowRun`
  immediately after saving, going through the standard slice-9 approval gate.
  The freshly-saved `WorkflowFile` is looked up from the live registry first;
  falls back to an inline stub if hot-reload hasn't fired yet.
- `.gitignore` update: first save of any workflow adds a comment block so
  developers can opt-in to committing workflow scripts intentionally.
- `pi-workflows.workflow-saved` appendEntry emission for dashboard live-update.

**pi-dashboard plugin (`plugins/pi-workflows/`)**
- `WriteWorkflowRenderer` — rich tool-renderer card for `write_workflow` calls:
  shows workflow name, save path, overwrite/saved badge, expandable script
  preview, and run command hint. Handles loading/error states.
- `WorkflowResultCard` — system-message-renderer for `pi-workflows.result`
  messages: outcome icon + badge, duration, agent count, cache hits, error line.
- `WorkflowsPanel` — sidebar panel that tracks active/recent runs and saved
  workflows from the `pi-dashboard:system-message` event stream. Subscribes to
  `pi-workflows.run.{started,ended,transitioned}` and `pi-workflows.workflow-saved`.
- Dashboard shell changes (already in pi-dashboard): `system-message-renderer`
  slot type, `SystemMessageRendererSlot` consumer, `details` propagation in
  `pi-manager.ts`, and `SystemMessage.tsx` routing.

## [0.1.0] - 2026-05-29

Initial release of pi-workflows — dynamic workflow scripting for pi.

### Added

**Core runtime (slices 0-2)**
- `node:vm` Context sandbox with `allowCodeGeneration: false` and prototype freeze
- Host-realm escape mitigations: `Function.constructor`, `eval`, `import()`, prototype pollution,
  `process.env` leak, microtask escape, timer-callback `this` leak, `fetch`, `require` pierce
- `realmError.ts` — host-to-Context error reconstruction with `wrappedNonError` + `originalType`
  flags, AggregateError recursion, `.cause` chain, cycle-break
- `timerTable.ts` — host-side timer handle table; strict-mode arrow callbacks, AbortSignal
  dispose sweep, MUTATION-PROBE tests

**Cache (slice 3)**
- `cache.jsonl` reader/writer with JSONL append, corruption-tolerant reader
- SHA-256-based cache key derivation from `(agentId, prompt, cacheKeyExtra)`

**Concurrency (slice 4)**
- FIFO async semaphore (`src/runtime/semaphore.ts`) — default cap 16, configurable via `setCap(n)`
- AbortSignal-aware acquisition, microtask-scheduled release (no reentrancy on same call stack)
- `inFlight` / `queueDepth` introspection for TUI and ledger

**Subprocess fleet (slices 5-6)**
- `pi --mode json` JSON-stream parser with torn-line recovery
- Subprocess dispatcher: `pi -p <prompt> --mode json` subprocess pool, parent-death guard (SIGTERM
  on parent PID loss), partial manifest write, mock-agents branch for test injection

**Ledger and state machine (slice 7)**
- `ledger.jsonl` writer + corruption-tolerant reader (torn-tail recovery)
- State machine with legal-transition enforcement: `pending → approved → running → done/failed/stopped`
- Phase events (`phase_start/end`), agent events (`agent_start/end`), pause/resume entries

**Run context and author API (slice 8a)**
- `WorkflowContext` (`ctx.agent`, `ctx.phase`, `ctx.cache.*`, `ctx.log`, `ctx.finishCallback`,
  `ctx.run`, `ctx.input`, `ctx.signal`)
- `RunManager` — per-run coordinator: sandbox lifecycle, semaphore ownership, cache routing
- `AggregateError` preservation across realm boundary

**Stdlib helpers (slice 8b)**
- `ctx.vote(agents, judge)` — multi-agent vote with pluggable judge
- `ctx.consensus(agents, opts?)` — Jaccard-similarity agreement check
- `ctx.parallel(items, fn, opts?)` — map-phase convenience
- `ctx.retry(fn, opts?)` — exponential backoff with AbortError short-circuit
- `ctx.sleep(ms, opts?)` — AbortSignal-aware delay

**Approval flow and trust (slice 9)**
- SHA-256 file hash on every run; first-run approval prompt in pi chat
- Trust records persisted to `.pi/workflows/trust.json` (project) or
  `~/.pi/agent/settings.json` (personal) with `always` / per-session granularity
- `BYPASS_TRUST=1` env var for CI; announce banner on trust grant

**Result delivery (slice 10)**
- `finishCallback` firing after workflow return
- `/workflows` slash command: `list`, `status`, `resume`, `kill`, `gc`
- `enabled: false` config knob for project-level disable

**Resume and crash recovery (slice 11)**
- Resume from disk: re-attach to a running or paused run across pi restarts
- Crash sweep on session start: `running` runs from dead PIDs rolled back to `failed`
- GC: configurable `gcAfterDays` (default 30); skips active runs and mid-resume safety check

**Cooperative pause/resume (slice 12)**
- `p` hotkey pauses/resumes a run; state persisted to ledger
- `running → paused` transition gates new phase dispatches; in-flight agents complete

**TUI overlay (slice 13)**
- `w` hotkey opens the workflows overlay from any pi session
- Runs list: runId, workflowName, state badge, phase progress, token total, elapsed
- Remote-run badge (`[remote]`) for cross-process registry summaries
- Active-runs registry for cross-process visibility

**Phase view and save-script (slice 14)**
- Drill-down from runs list (Enter): phase view with per-phase agent counts and token totals
- `r` hotkey: restart a terminal run (new runId, lineage tracked via `restartedFrom`)
- `s` hotkey: save the run's workflow script to `.pi/workflows/<name>.js`

**Agent detail and GC dialog (slice 15)**
- Third overlay level: agent detail (agentId, prompt, state, tokens, tool calls, transcript)
- `o` hotkey: open agent transcript in `pi.ui.editor` or fallback TUI viewer
- `g` hotkey: GC dialog with state breakdown, Apply/Cancel, active-lineage exclusion (F4)

**Hot-reload (slice 16)**
- `chokidar` file watcher on discovered workflow directories
- File change triggers SHA-256 re-hash + trust revocation prompt
- Debounced (200ms) to coalesce rapid saves

**Bundled `/codebase-audit` workflow (slice 17)**
- 4-phase workflow: recon → analyse (parallel, per-area) → vote (Borda count) → summarise
- Full integration test with mock-agents fixture branch
- Self-install: `npx @samfp/pi-workflows install` copies bundled workflows to personal dir

**Documentation and skills (slice 18)**
- `README.md` — full user-facing docs with quick-start, API table, TUI hotkey reference
- `docs/runtime-api.md` — per-method API reference with TypeScript signatures and examples
- `docs/authoring.md` — authoring guide with fan-out/fan-in, cache, retry, abort patterns
- `docs/integration-testing.md` — mock-agents testing guide
- `docs/parity-gaps.md` — complete CC parity gap tracker
- `docs/threat-model.md` — sandbox escape-vector matrix and mitigations
- `skills/pi-workflows/SKILL.md` — pi skill for workflow authoring
- `CONTRIBUTING.md` — manual smoke procedure (§12.8)
- `.npmignore` — excludes tests/, scripts/, tsconfig*.json from npm pack

### Known limitations (v1)

- No `workflow` keyword trigger — use `/workflow-name` slash command
- No `/effort ultracode` modifier
- `crypto.subtle` not available (deferred to v2)
- Synchronous infinite loops wedge the event loop (no worker-thread interrupt)
- `acceptEdits` permission elevation not supported — inherits parent allowlist
- Cross-run cache requires save-script export (no automatic cross-run sharing)

### Parity with Claude Code dynamic workflows

Behavioral parity on: parallel sub-agent fan-out, per-run cache with cache-hit
replay, resume across restarts, approval flow, result delivery to chat,
cooperative pause/resume, GC, TUI live inspection.

Novel pi-specific additions: FIFO semaphore with configurable cap, vote/consensus
stdlib primitives, hot-reload, save-script hotkey, cross-process runs registry.
