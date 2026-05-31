# Changelog

All notable changes to `@samfp/pi-workflows` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Fixed
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
