# pi-workflows — PRD

**Status:** v0.1 design.
**Owner:** samfp
**Created:** 2026-05-28
**Last updated:** 2026-05-28
**Parity target:** Anthropic Claude Code "Dynamic Workflows" (2026-05-28 release).

---

## Table of contents

1. [TL;DR & locked decisions](#1-tldr--locked-decisions)
2. [Goals & non-goals](#2-goals--non-goals)
3. [User-facing surface](#3-user-facing-surface)
4. [Workflow author API (runtime stdlib)](#4-workflow-author-api-runtime-stdlib)
5. [Runtime architecture](#5-runtime-architecture)
6. [Persistence layout](#6-persistence-layout)
7. [Approval & permissions](#7-approval--permissions)
8. [Threat model](#8-threat-model)
9. [Bundled `/codebase-audit` workflow](#9-bundled-codebase-audit-workflow)
10. [TUI overlay design](#10-tui-overlay-design)
11. [Package layout](#11-package-layout)
12. [Test strategy](#12-test-strategy)
13. [Migration / coexistence](#13-migration--coexistence)
14. [Known parity gaps from Claude Code](#14-known-parity-gaps-from-claude-code)
15. [Open questions for the planner](#15-open-questions-for-the-planner)

---

## 1. TL;DR & locked decisions

### 1.1 TL;DR

`@samfp/pi-workflows` is a pi extension that ports Anthropic's **Dynamic Workflows** primitive to pi. A workflow is a JavaScript file in `.pi/workflows/<name>.js` (project) or `~/.pi/agent/workflows/<name>.js` (personal). Each workflow becomes a `/<name>` slash command. When invoked, it executes **out-of-process in a sandboxed `node:vm` Context**, drives sub-agents via `pi --mode json -p` subprocesses, and reports progress through pi's TUI. The conversation is **not** the orchestrator — the script is. The LLM only sees the final result.

Five-bullet summary:

- **Workflow == script-driven plan.** Loops, branching, and intermediate state live in JS variables, not chat turns. The LLM-as-orchestrator pattern (skills, subagents) is preserved for short tasks; workflows take over when the plan needs durable structure.
- **Sub-agent fleet is owned.** We spawn `pi --mode json -p` subprocesses ourselves. No hard dep on `pi-conductor`; if conductor is also loaded we emit a startup warning (two semaphores otherwise compete).
- **Sandbox is `node:vm` Context.** No `worker_thread` — too much overhead for no real security win when the user trusts the workflow author. Curated frozen globals only; no `fs`, `child_process`, network, dynamic `import`, `process`, or `require` inside the script.
- **Resume across pi restarts.** Append-only JSONL ledger at `~/.pi/agent/workflows/runs/<runId>/ledger.jsonl` lets `/workflows resume <id>` reconstruct state from disk alone.
- **Approval gates the run, not the agent.** First-run prompt with "don't ask again" persistence keyed on `(absPath, workflowName)`. Bypassed under `--bypass-permissions`, `pi -p`, and SDK calls — same precedence as Claude Code.

### 1.2 Locked decisions (do not relitigate)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Parity bar** | Behavioral parity, novel API. | CC deliberately doesn't publish a JS API surface for workflow authors; we invent + document one. `.pi/workflows/*.js` files are pi-specific (not portable to/from CC). |
| 2 | **Sub-agent backend** | Own subprocess fleet via `pi --mode json -p`. | `pi-conductor` exports zero TS surface today; making it a hard dep means landing a public API there first. We spawn directly and warn if conductor is loaded. |
| 3 | **Trigger scope v1** | Explicit `/<workflowName>` invocation only. | `workflow` keyword trigger, `/effort ultracode`, `alt+w` are CC-internal prompt-augmentation hooks pi doesn't expose. Documented as v2 parity gaps. |
| 4 | **Resume lifetime** | Across pi restarts. | Strictly more useful than CC's session-scoped resume. JSONL ledger is cheap. Opt-in via `/workflows resume <runId>`; cleaned via `/workflows gc`. |
| 5 | **Sandbox** | `node:vm` Context with frozen curated globals. | `worker_thread` adds startup cost and IPC complexity for no security improvement against an author who could just write a malicious extension instead. |
| 6 | **Concurrency** | Single in-runtime semaphore. Default 16, configurable via setting `pi-workflows.maxConcurrent`. | Matches CC. FIFO queue beyond cap. Per-run cap of 1000 total agent invocations matches CC. |
| 7 | **Permission v1** | Sub-agents inherit the parent's tool allowlist verbatim. **No `acceptEdits` upgrade.** | Pi has no primitive for permission elevation in child subprocesses. Approval gates the **whole run**, not per-agent. Documented as parity gap. |
| 8 | **Approval persistence** | Settings key `pi-workflows.trustedWorkflows: { "<absPath>": [{ name, sha256 }, ...] }`. Trust is keyed on `(absPath, sourceSha256)` — mutating the file invalidates trust. | Bypass cases: `--bypass-permissions`, SDK, `--mock-agents`. **`pi -p` is no longer an unconditional bypass** — see §7.4. Stricter than CC; called out in §14. |
| 9 | **Disable knobs** | Env `PI_DISABLE_WORKFLOWS=1` (hard kill switch, wins over the setting) AND setting `pi-workflows.disabled: true` (user-managed knob). | Env is checked first and short-circuits unconditionally; the setting is consulted only if env is unset. Both short-circuit at extension-load time. |
| 10 | **Bundled workflow** | `/codebase-audit` (pi-native). | Skips `/deep-research` v1 — pi's web search is DDG-fallback quality. `/codebase-audit` is pi-native and demonstrates the API authentically. |
| 11 | **Test fixtures** | `--mock-agents` runtime mode reads canned responses from `<runId>/fixtures.jsonl`, keyed by `(agentId, promptHash)`. | Lets integration tests exercise the full state machine without spawning real `pi -p` children. |
| 12 | **Sandbox model** | `vm.Context` per run, disposed at end. No reuse. | One context = one workflow run. No cross-run leakage. Disposal happens in `finally` of the run promise, regardless of outcome. |
| 13 | **Cancellation** | `AbortSignal` propagated through `pi.exec` to every spawned `pi -p` subprocess. | `x` (stop) hotkey → AbortController.abort() → SIGTERM in 5s, SIGKILL in 15s. (`s` is reserved for save — see §10.4.) |
| 14 | **Cache** | Per-agent result cache, keyed by `(workflow_version, phase_name, agent_id, prompt_hash, input_hash)`. JSONL on disk, restored on resume. | Resume-after-crash is the load-bearing case. Cache is workflow-scoped and run-scoped; never shared across runs (Claude Code matches). |
| 15 | **TUI overlay** | `ctx.ui.custom` overlay. Hotkeys ↑↓ Enter Esc j k p (pause) x (stop) r (restart) s (save) match CC. | Coexists with conductor's `Ctrl+G` overlay via push/pop ordering — most-recent overlay wins; Esc pops one. |
| 16 | **Slash-command handler** | Returns immediately. Workflow runs in a background fire-and-forget Promise. | Blocking the slash-command handler freezes pi's TUI. The handler emits a `pi.events` topic the overlay subscribes to. |

### 1.3 What this PRD pins down vs. defers

**Pinned in this PRD:**

- The full author-facing JS API (§4).
- The runtime state machine (§5).
- The on-disk persistence layout (§6).
- The approval model and its precedence (§7).
- Sandbox escape vectors and their mitigations (§8).
- The bundled `/codebase-audit` workflow as reference implementation (§9).
- TUI hotkeys and overlay structure (§10).
- Package layout and test runner choice (§11–12).

**Deferred to planner / builder slices:**

- Internal type names, file boundaries inside `src/`, function signatures of internals.
- esbuild bundle config minutiae.
- Exact ledger entry formats (general shape pinned; field-by-field schema is a builder concern).
- The mock-agents fixture format beyond the JSONL key shape.

---

## 2. Goals & non-goals

### 2.1 Goals

1. **Behavioral parity with CC Dynamic Workflows** for the surfaces where pi has equivalent primitives:
   - File-based workflows (`.pi/workflows/<name>.js`).
   - `/<name>` slash command per workflow.
   - Out-of-process sandboxed execution.
   - Phased execution with parallel sub-agents.
   - Per-run approval with persistence.
   - `/workflows` overlay for run/phase/agent inspection.
   - Pause / stop / restart hotkeys.
   - Sub-agent result cache + resume.
2. **Production quality.** Test pyramid (unit + integration + security), README, examples directory, type definitions for workflow authors, npm-publish-ready package layout.
3. **Pi-idiomatic.** Use pi's extension API surfaces verbatim (`pi.registerCommand`, `ctx.ui.custom`, `pi.events`, `pi.exec`, `pi.appendEntry`); follow `docs/packages.md` peer-deps convention; settings under `pi-workflows.*` namespace.
4. **Coexists with `pi-conductor`, `pi-essentials/subagent`, `pi-autoresearch`** — no name collisions, no shared global state, documented startup-warning when conductor is also loaded.
5. **Resumable across pi restarts** — a strictly larger feature than CC's session-scoped resume, achievable cheaply via append-only JSONL ledger.
6. **Honest parity gaps.** What we can't replicate is documented up front (§14), not papered over.

### 2.2 Non-goals

| Non-goal | Why |
|---|---|
| Portable workflow files between pi and CC | Different host APIs, different sub-agent backends, different sandbox semantics. Best-effort copy-paste compatibility is a maintenance trap. |
| `workflow` keyword auto-trigger from natural language | Requires a prompt-augmentation hook pi doesn't expose. v2 if pi adds the hook. |
| `/effort ultracode` integration | Same reason — internal CC effort-tier surface, no pi equivalent. |
| `alt+w` keyboard shortcut for explicit workflow mode | CC-internal mode toggle. Pi's slash-command discoverability serves the same need. |
| Per-agent permission elevation (`acceptEdits`) | Pi has no API to elevate a subprocess's tool allowlist. Approval gates the whole run instead. Documented as parity gap. |
| `agent-memory/` shared memory directory | CC-specific shared scratchpad surface; out of scope. Workflow authors can use the cache or pass values through script variables. |
| Hostile-author security | This is a **sandbox**, not a security perimeter. A malicious workflow author could already write a malicious pi extension; the threat model assumes the author is trusted (§8). |
| Web-research parity with `/deep-research` | Pi's web search is DDG-fallback grade. We ship `/codebase-audit` instead and document the gap. |
| Multi-machine / distributed runs | Single-host only. The runtime semaphore is in-process. |
| Workflow composition (workflow calling workflow) | Out of scope v1; introduces graph-cycle detection and cross-run scheduling complexity. v2 candidate. |
| GUI for authoring workflows | Workflows are JS files. Authors use their editor. |
| Streaming the script's `console.log` directly into the parent conversation | Workflow logs go to ledger + overlay; the parent conversation only sees the final result. This is the whole point of moving the plan into code. |

### 2.3 Acceptance criteria (production-quality bar)

The extension is "done" when all of the following are true:

- [ ] `pi install npm:@samfp/pi-workflows` succeeds and the extension auto-loads.
- [ ] A trivial workflow file (`.pi/workflows/hello.js`) exporting one phase shows up as `/hello`, runs, and prints a result via `pi.sendMessage`.
- [ ] `/workflows` opens the overlay; runs list → phase view → agent detail navigation works.
- [ ] `p` pauses, `r` resumes, `x` stops a running workflow; `s` saves the script to the project; `r` (on stopped run) restarts.
- [ ] Approval prompt appears on first invocation per `(absPath, name)`; "don't ask again" persists in settings; `--bypass-permissions`, `pi -p`, SDK skip the prompt.
- [ ] `--mock-agents` mode runs the integration suite end-to-end with no real `pi -p` subprocesses.
- [ ] Hostile-workflow security suite (§12.3) passes: vm escape attempts, prototype-pollution attempts, network access attempts all fail to escape.
- [ ] Resume across pi restarts: kill pi mid-run, restart, `/workflows resume <id>` continues where it left off, with cached agent results reused.
- [ ] `/codebase-audit` ships, runs against this repo, produces a meaningful audit summary.
- [ ] README + `docs/authoring.md` cover author API, examples, and parity-gap callouts.
- [ ] `npm publish --dry-run` produces a clean tarball; `peerDependencies` follow `docs/packages.md`.

---

## 3. User-facing surface

### 3.1 File layout & discovery

| Location | Scope | Precedence |
|---|---|---|
| `<project>/.pi/workflows/<name>.js` | Project | **Wins** over personal on name collision |
| `~/.pi/agent/workflows/<name>.js` | Personal (user-global) | Loses on collision |

**No other discovery paths.** Symmetric with `pi-conductor` personas. No XDG, no env-var search paths.

Discovery happens at:

- Extension load (`session_start`).
- `/reload` command.
- File-watcher hot-reload during a session: `chokidar` watches both directories; on `add | change | unlink`, the workflow registry is rebuilt and the slash-command set updated. **Currently-running workflows are not affected by hot-reload** — they hold a reference to the script text in their `vm.Context`. New invocations pick up the new script.

Discovery is **non-recursive**. `<name>.js` only — no `<dir>/index.js`, no nested directories. Symmetric with CC.

### 3.2 Filename rules

| Pattern | Result |
|---|---|
| `<name>.js` | Becomes `/<name>` |
| Reserved names (`workflows`, `reload`, `help`, etc., or any name already registered by another extension) | **Skipped at load.** A `workflow_load_error` ledger entry is appended and a `pi.notify` warning is emitted; the workflow does not become a slash command. |
| Non-`.js` extensions (`.ts`, `.mjs`) | Skipped at load with a `workflow_load_error` warning. v1 is JS-only; TypeScript authoring requires the user to compile. |
| Names containing `/`, `\`, whitespace, `..`, leading `.` | Skipped with warning. |
| Hidden files (e.g. `.foo.js`) | Skipped silently. |

### 3.3 Slash commands

| Command | Behavior |
|---|---|
| `/<name>` | Invoke workflow `<name>` with the user's argument string as initial input. Handler returns immediately; the run executes in the background. The TUI emits a one-line confirmation message via `pi.sendMessage` (e.g. `"Workflow `codebase-audit` started — run ID `wf-abc123`. Use `/workflows` to monitor."`). |
| `/workflows` | Open the runs overlay. §10 covers the layout. |
| `/workflows resume <runId>` | Resume a paused-or-crashed run from disk. Errors if `<runId>` is not in `~/.pi/agent/workflows/runs/` or is in a non-resumable state (`done`, `stopped`). |
| `/workflows gc` | Garbage-collect runs. Deletes runs older than `pi-workflows.gcAfterDays` (default 30) AND in a terminal state. Lists what would be deleted before confirmation. `/workflows gc --dry-run` lists without deleting. |
| `/workflows list` | Print active + recent runs as a table in the conversation (no overlay). Useful for SDK / `-p` mode. |
| `/workflows show <runId>` | Print one run's manifest + last 50 ledger entries. Useful for SDK / `-p` mode. |
| `/workflows kill <runId>` | Send abort signal to a run from the conversation (vs. `x` hotkey). |

### 3.4 Approval dialog UX

First invocation of `(absPath, workflowName)` triggers a confirm dialog via `ctx.ui.confirm`-derived `ctx.ui.custom` (we use `custom` because we need 4 distinct outcomes, which `confirm` doesn't support):

```
┌─ Run workflow `codebase-audit`? ──────────────────────────────────────┐
│ Source: ~/proj/.pi/workflows/codebase-audit.js                       │
│ First time running this workflow from this path.                    │
│ It will spawn up to 16 sub-agents and may invoke any tool the       │
│ parent session has access to.                                       │
│                                                                     │
│  [Y] Run once   [A] Run + always trust   [V] View source   [N] No   │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Outcome | Behavior |
|---|---|
| **Y** | Run this invocation. Don't persist trust. Re-prompt next time. |
| **A** | Run this invocation **and** add `(absPath, name, sourceSha256)` to `pi-workflows.trustedWorkflows`. Future invocations skip the prompt as long as the file's bytes match. If the file is later edited, the hash mismatches and approval is re-prompted with a `"this workflow file has changed since you last trusted it"` warning. |
| **V** | Open the script in `$EDITOR` (or display in a read-only `ctx.ui.custom` if `$EDITOR` is unset). Re-shows the dialog after view. |
| **N** | Cancel. Run state ends in `cancelled-pre-run`; ledger is created with one entry then closed. |

If trust is already recorded, the dialog is **skipped entirely**.

### 3.5 Bypass conditions

The approval dialog is bypassed (run proceeds without prompting) when:

| Condition | Source | Notes |
|---|---|---|
| `--bypass-permissions` flag | pi CLI | Always bypasses. |
| Running under SDK (`process.env.PI_MODE === "sdk" \|\| "json"`) | pi runtime | Always bypasses. |
| `--mock-agents` flag (test mode) | this extension's flag | Always bypasses. |
| `pi -p ...` (single-prompt mode) | pi CLI | **Bypass only if the workflow is already trusted** for `(absPath, sourceSha256)`. First-time invocation under `pi -p` errors with `"workflow `<name>` not yet trusted; run interactively first to grant trust."` See §7.4.1 for the security rationale. |

Precedence is checked in `pi.on("command_invoke")` for the workflow's slash command, before any UI is shown.

### 3.6 Disable knobs

| Knob | Effect |
|---|---|
| Setting `pi-workflows.disabled: true` (project or user `settings.json`) | Extension's default-export function exits early; no commands are registered, no overlay, no events. Logged once via `ctx.log.info("pi-workflows disabled by setting")`. |
| Env `PI_DISABLE_WORKFLOWS=1` | **Hard kill switch.** Checked **first** at extension load; if set, the extension exits before reading any settings. Wins over the setting unconditionally. |
| Env `PI_WORKFLOWS_RECURSIVE=1` (set by the dispatcher when spawning sub-agent children, §5.5) | Defensive in-depth: extension loads but **skips `registerCommand` for workflow files**, so a sub-agent child cannot invoke `/<workflowName>` and recursively spawn more workflows. Also skips installing the `/workflows` overlay. The `/workflows` namespace remains visible in `--help` (so users in nested sessions don't get confused), but slash invocations error with `"workflows are disabled in nested pi sessions"`. |

Both checks happen at extension-load time. **Order: env first (hard kill), then setting (user-managed knob).** Re-enabling requires a `/reload` or pi restart.

### 3.7 Argument passing

`/<name> <rest of line>` — `<rest of line>` is passed as a **single string** to the workflow's `main(ctx, input)` export. No shell-style argv parsing. Authors who want flags can `input.split(/\s+/)` themselves or use a known-good lightweight parser shipped via `cache.set` from a previous run (no, just kidding — they parse it themselves).

### 3.8 Result delivery to the conversation

When a workflow's `main()` resolves with a value, the runtime calls `pi.sendMessage` with a folded summary card:

```
✅ Workflow codebase-audit complete (4m 12s, 23 agents, 8 phases)
│ Result preview:
│   [first 400 chars of stringified result]
│ Full result: ~/.pi/agent/workflows/runs/wf-abc123/result.json
│ Re-open: /workflows show wf-abc123
```

If `main()` resolves with a **string**, that string is sent verbatim as a user-visible message **and** stored. If it resolves with a non-string, the result is JSON-stringified for the preview and stored at `result.json`.

If `main()` rejects, a `❌` card with the error message is sent and the ledger ends with `state: "failed"`.

### 3.9 finishCallback for LLM follow-up

The author API exposes `ctx.finishCallback(prompt: string)` which calls `pi.sendUserMessage` so the LLM picks up where the workflow left off. This is the bridge from "workflow finished its plan" to "LLM continues the conversation." Useful when the workflow produces a draft the LLM should refine, or when the workflow surfaces a question for the user.

Matches CC's pattern: workflows can choose to deliver structured output to the LLM as a follow-up turn, and the user sees it like any other turn.

---

## 4. Workflow author API (runtime stdlib)

The author writes a single JS file that **exports a default function** (or named `main`). The runtime injects a `ctx` object exposing the API below. The script is **not a CommonJS module and not an ESM module** — it is a string evaluated inside a `vm.Context`. The execution wrapper is morally equivalent to:

```js
async function userScript(ctx, input) {
  /* AUTHOR'S CODE PASTED HERE */
}
```

but compiled via `new vm.Script(...)` and run inside the run's Context.

### 4.1 Module shape

Authors write top-level code; the runtime treats the file as a function body. Two equivalent author-facing shapes are accepted by the loader:

```js
// Shape A: bare top-level (treated as function body)
const result = await ctx.phase("hello", [
  ctx.agent("say hi"),
]);
return result[0].text;
```

```js
// Shape B: explicit default export (transpiled by loader)
export default async function (ctx, input) {
  const result = await ctx.phase("hello", [
    ctx.agent("say hi"),
  ]);
  return result[0].text;
}
```

The loader auto-detects: if the source contains `export default` or `module.exports`, shape B; else shape A. Internally both compile to the same wrapped function. **Recommended in docs: shape B** — cleaner, lets editors highlight the function body correctly.

### 4.2 Public `ctx` API

#### 4.2.1 `ctx.agent(prompt, opts?) → AgentHandle`

Declares a sub-agent invocation. **Does not run yet** — returns a handle. `ctx.phase()` is what actually schedules them.

```ts
type AgentOpts = {
  id?: string;            // for cache key + UI; auto-generated UUIDv4 if omitted
  model?: string;         // pi model spec; defaults to inheriting parent's
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
  systemPrompt?: string;  // additional system prompt prepended to the agent
  inheritContext?: "none"|"filtered"|"full";  // default "none"
  inheritSkills?: boolean;     // default false
  timeoutMs?: number;          // default 600_000 (10min); hard timeout
  cacheKeyExtra?: unknown;     // mixed into the cache key for invalidation
};

type AgentHandle = {
  readonly kind: "agent";
  readonly id: string;
  readonly prompt: string;
  readonly opts: Readonly<AgentOpts>;
};

type AgentResult = {
  agentId: string;
  text: string;            // final user-visible response from the agent
  usage: { input: number; output: number; totalTokens: number; cost?: number };
  durationMs: number;
  cached: boolean;         // true if served from cache.jsonl
  toolCalls: number;       // count of tool invocations the agent made
  transcriptPath: string;  // absolute path to the agent's transcript JSONL
};
```

**`ctx.agent` is pure** — calling it twice with identical args twice schedules two distinct agents. Idempotency is the cache's job, not `ctx.agent`'s.

#### 4.2.2 `ctx.phase(name, agents) → Promise<AgentResult[]>`

Runs the given agents **in parallel**, subject to the runtime's concurrency semaphore (default 16). Resolves when **all** agents have settled. **Order in the returned array matches the input order**, regardless of completion order.

```ts
type Phase = (name: string, agents: AgentHandle[]) => Promise<AgentResult[]>;
```

- Phases are **sequential w.r.t. each other** — `await ctx.phase("a", ...)` then `await ctx.phase("b", ...)` runs `b` only after `a` completes.
- Within a phase, agents run in parallel up to the semaphore cap.
- If **any** agent throws (timeout, subprocess crash, sandbox violation), the phase rejects with `AggregateError` containing all per-agent errors. Other agents in the phase are aborted. The `AggregateError.errors` array is **preserved across the realm boundary** — see §8.3.4 for the reconstruction contract.
- The phase's `name` is used for UI grouping and ledger entries. It must be unique within a run.

#### 4.2.3 `ctx.cache`

```ts
type Cache = {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
};
```

Workflow-author-controlled cache, **separate** from the agent-result cache. Persisted in the same `cache.jsonl` (different record type tag). Survives resume. Authors use this for derived data they want preserved across runs (e.g. the result of an expensive parse).

Keys are strings; values are JSON-serializable. Non-serializable values throw on `set`.

#### 4.2.4 `ctx.log(msg, opts?)`

```ts
type LogOpts = { level?: "debug"|"info"|"warn"|"error" };
ctx.log(msg: string | object, opts?: LogOpts): void;
```

Writes to `ledger.jsonl` and the overlay's per-run log pane. **Not** sent to `console.log` (which is unavailable in the sandbox — §8). `console.log` and `console.error` are aliased to `ctx.log` for ergonomics.

#### 4.2.5 `ctx.finishCallback(prompt)`

```ts
ctx.finishCallback(prompt: string): void;
```

Queues a `pi.sendUserMessage(prompt)` to fire after the workflow's `main()` resolves. Allows the workflow to deliver a prompt to the LLM as if the user had typed it. Called at most once; subsequent calls overwrite.

#### 4.2.6 Helpers

These are stdlib-style helpers built on top of `ctx.agent` / `ctx.phase` and shipped as part of the runtime. Authors can also write their own.

```ts
ctx.vote(
  agents: AgentHandle[],
  judge: (responses: string[]) => Promise<string> | string
): Promise<{ winner: string; responses: string[] }>;

ctx.consensus(
  agents: AgentHandle[],
  opts?: { threshold?: number /* default 0.6 */ }
): Promise<{ agreed: boolean; majorityText: string; responses: string[] }>;

ctx.parallel<T>(
  items: T[],
  fn: (item: T, ctx: WorkflowContext) => AgentHandle | AgentHandle[],
  opts?: { phaseName?: string }
): Promise<AgentResult[]>;

ctx.retry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number /* default 3 */; backoffMs?: number }
): Promise<T>;

ctx.sleep(ms: number): Promise<void>;  // honors AbortSignal
```

`vote` and `consensus` reuse `ctx.phase` internally and respect the semaphore. `consensus` does naive string-similarity bucketing (Jaccard over tokenized words) for the v1 "agreed" determination (see §15.A for the LLM-judged-consensus question and recommended deferral).

#### 4.2.7 Run metadata

```ts
ctx.run = {
  readonly id: string;          // "wf-" + 12 hex chars
  readonly workflowName: string;
  readonly startedAt: string;   // ISO-8601
  readonly cwd: string;
  readonly resumed: boolean;
};

ctx.input: string;              // the slash-command argument string
ctx.signal: AbortSignal;        // aborts on stop / kill / pi shutdown
```

### 4.3 What is NOT in the sandbox

The sandbox provides **only** the curated globals listed below. Everything else is undefined.

| Global | Available? | Notes |
|---|---|---|
| `globalThis`, `Object`, `Array`, `Function`, `Promise`, `Error`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `Date`, `RegExp`, `Math`, `JSON`, `Number`, `String`, `Boolean`, `BigInt`, `ArrayBuffer`, `Uint8Array` (and other typed arrays), `DataView` | ✅ | Frozen via `Object.freeze` after Context init. |
| `console.log`, `console.error`, `console.warn`, `console.info`, `console.debug` | ✅ | Aliased to `ctx.log`. |
| `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, `queueMicrotask` | ✅ | Native Node timer functions, but tied to the run's AbortSignal: cleared on stop. |
| `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa` | ✅ | Pure data utilities. |
| `crypto.subtle`, `crypto.randomUUID()`, `crypto.getRandomValues()` | ⚠️ | Available, but `randomUUID` and `getRandomValues` are non-deterministic and break cache reproducibility — docs warn. **Same warning applies to `Date.now()` and `new Date()`** when their values flow into prompts that participate in cache keys: every run sees a different timestamp, so cache hits become impossible. Authors who must include time should round to a coarse bucket (hour/day) or pass it via `cacheKeyExtra` so the dependency is explicit. |
| `fs`, `node:fs`, `node:fs/promises` | ❌ | `require` and dynamic `import` are unavailable; can't be reached. |
| `child_process` | ❌ | Same. |
| `net`, `http`, `https`, `dns`, `tls`, `stream` | ❌ | Same. |
| `process` | ❌ | Replaced by a frozen stub: `{ env: {} (empty), platform, arch, versions: { node } }`. |
| `require`, `import()` (dynamic) | ❌ | Not in the Context. The script can't load other modules. |
| `eval`, `Function("...")` | ⚠️ | **Available but useless** — they evaluate inside the same Context, so cannot reach disallowed globals. They are a known sandbox-escape vector and §8 covers mitigations. |
| `worker_threads`, `vm` | ❌ | Not in the Context. |
| `Buffer` | ⚠️ | **Available**. Needed for crypto and binary handling, low risk on its own. |

### 4.4 Type definitions

The extension ships `dist/workflows.d.ts` and `dist/workflows.js` as a stub module authors can `import` for IDE assistance:

```js
// in a workflow file, optional, only for IDE help
/// <reference types="@samfp/pi-workflows" />
/** @type {import("@samfp/pi-workflows").WorkflowMain} */
export default async function (ctx, input) { ... }
```

The import is **not** resolved at runtime (the sandbox doesn't have `require`); it exists purely for tooling. The `dist/workflows.js` is a no-op stub so editors and `tsc --noEmit` resolve the types without runtime errors.

### 4.5 Cache key derivation

The agent-result cache key for an `AgentHandle` is:

```
sha256(
  workflow_version    // hash of script source
  + "|" + phase_name
  + "|" + agent.id
  + "|" + sha256(agent.prompt)
  + "|" + sha256(JSON.stringify(agent.opts, sorted-keys))
  + "|" + sha256(JSON.stringify(agent.opts.cacheKeyExtra ?? null, sorted-keys))
)
```

The workflow's `script.js` source hash is the **invalidation primitive**: edit the script → cache misses across the board. Authors who want stable cache across script edits can pin parts via `cacheKeyExtra` (e.g. include only the prompt and a model version).

**Cache is run-scoped, not global.** Each run has its own `cache.jsonl`. Resume of a run re-uses its cache. No cross-run sharing v1 — too easy to leak stale results across script versions.

---

## 5. Runtime architecture

### 5.1 Process model

```
┌──────────────────── pi process ────────────────────────────┐
│                                                              │
│   ┌─ pi-workflows extension ─────────────────────────────┐  │
│   │                                                       │  │
│   │  Registry (loaded workflows)                          │  │
│   │  RunManager  (active runs map)                        │  │
│   │  Semaphore   (max 16 concurrent agents, FIFO queue)    │  │
│   │  EventBus    (pi.events: pi-workflows.run.*, pi-workflows.agent.*, pi-workflows.phase.*) │
│   │              All topics use `pi-workflows.<noun>.<verb>` (dotted, no hyphens). │
│   │  Overlay     (ctx.ui.custom, lazy-mounted on /workflows)│  │
│   │                                                       │  │
│   │  per Run:                                             │  │
│   │    ┌─ vm.Context (frozen globals + ctx) ──────────┐  │  │
│   │    │    user script body                          │  │  │
│   │    │    awaits ctx.phase()                        │  │  │
│   │    └───────────────────────────────────────────────┘  │  │
│   │    LedgerWriter   (append-only JSONL)                │  │
│   │    CacheStore     (jsonl, mem-cached)                │  │
│   │    AbortController                                    │  │
│   └────────────────────────────────────────────────────────────┘  │
│                       │ spawns                                   │
│                       ▼                                          │
│   per AgentHandle running:                                       │
│   ┌─ child: pi --mode json -p <prompt> ... ─────┐                  │
│   │   isolated session, transcript JSONL,        │                  │
│   │   model = parent or override,                │                  │
│   │   tools = parent's allowlist (inherited)     │                  │
│   └─────────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Run state machine

```
         /workflows resume <id>          
               │                          
               ▼                          
  ┌────────┐   approve     ┌─────────┐   start         ┌─────────┐
  │ pending├─────────────▶│ approved├────────────────▶│ running │
  └───┬───┘               └─────────┘                 └┬───────┘
      │ reject                                          │ p
      ▼                                                 ▼
  ┌─────────────────┐                                  ┌────────┐
  │ cancelled-pre-run│                                  │ paused │
  └─────────────────┘                                  └┬───────┘
                                                       │ r
                                                       ▼
                                                  ┌─────────┐
                                                  │ running │ (back)
                                                  └─────────┘
                                                       │
               x (stop) / Ctrl+C / SIGTERM             │ main()
                       │                               │
  ┌────────┐                                          ▼
  │ stopped│ ◀───────────────────────────────────────────┌──────┐
  └───────┘                                          │ done │
  ┌────────┐                                          └──────┘
  │ failed │ ◀── thrown / timeout / sandbox-violation
  └────────┘
```

State transitions are recorded in `ledger.jsonl` as `{ "type": "transition", "from": "...", "to": "...", "at": "<ISO>" }`. **Resume reads the ledger and rebuilds state from the last transition.**

Terminal states (no further transitions): `cancelled-pre-run`, `done`, `failed`, `stopped`.
Non-terminal: `pending`, `approved`, `running`, `paused`.

Resumable from disk after a pi crash: `paused`, `running` (treated as crashed-mid-run; resume re-enters `running` after replaying cached agent results).

### 5.3 Lifecycle event handlers

| Event | Action |
|---|---|
| `session_start { reason: "new" }` | Load workflow registry, register slash commands, register `/workflows` overlay, subscribe to `pi.events`. |
| `session_start { reason: "resume" }` | Same as `new`, **plus** scan `~/.pi/agent/workflows/runs/` for non-terminal runs and surface them via `pi.appendEntry("pi-workflows.crashed-runs", [...])`. The `/workflows` overlay reads this entry on first open. **Do not auto-resume.** Auto-resume is dangerous (could re-spawn 16 agents on session restart); user explicitly opts in via `/workflows resume <id>`. |
| `session_shutdown` | For each non-terminal active run: append `{ type: "shutdown", graceful: true }` to its ledger and call `runManager.pause(runId)`. (Pi shutdown signals are short — we don't try to gracefully stop, we just record the state for resume.) |
| `resources_discover` | Re-scan workflow files; rebuild registry; diff slash-command set; emit `workflow.registry.changed` event. |

### 5.4 Concurrency & semaphore

One global semaphore per pi process, default `pi-workflows.maxConcurrent = 16`. Settings can lower or raise (1–64 valid range; outside range warns + clamps).

When `ctx.phase` schedules N agents:

1. Each agent's run-attempt is wrapped in `await semaphore.acquire()`.
2. Acquires are FIFO across all runs.
3. Released in `finally` of the agent's invocation (whether success, error, or abort).

This means **two parallel runs share the cap.** If run A is using all 16 slots, run B's agents queue. The overlay shows the queue length per run.

**Conductor coexistence:** if `pi-conductor` is also loaded, both extensions hold their own semaphores and **don't coordinate**. We log a warning at extension load:

```
[pi-workflows] pi-conductor is also loaded. Both extensions cap concurrent
sub-agents independently; effective parallelism may exceed pi-workflows'
maxConcurrent if conductor personas spawn alongside workflow agents.
```

### 5.5 Sub-agent dispatcher

```ts
function dispatchAgent(run: Run, agent: AgentHandle, signal: AbortSignal): Promise<AgentResult> {
  // 1. cache lookup
  const cacheKey = deriveCacheKey(run, agent);
  const cached = await run.cache.get(cacheKey);
  if (cached) {
    run.ledger.append({ type: "agent_cache_hit", runId: run.id, agentId: agent.id, cacheKey });
    return { ...cached, cached: true };
  }

  // 2. acquire semaphore
  await semaphore.acquire(signal);

  // 3. spawn pi -p subprocess
  const args = [
    "--mode", "json",
    "-p", agent.prompt,
    ...(agent.opts.model ? ["--model", agent.opts.model] : []),
    ...(agent.opts.thinking ? ["--thinking", agent.opts.thinking] : []),
    "--no-color",
    "--no-loading",
  ];
  if (run.options.mockAgents) {
    return readFromFixture(run, agent);
  }

  const child = await pi.exec("pi", args, {
    cwd: run.cwd,
    // Recursion guards: PI_DISABLE_WORKFLOWS hard-kills pi-workflows in the
    // child; PI_WORKFLOWS_RECURSIVE is defense-in-depth in case env loss
    // occurs (it makes the extension load but skip registerCommand). See §3.6.
    env: {
      ...process.env,
      PI_PARENT_RUN_ID: run.id,
      PI_PARENT_AGENT_ID: agent.id,
      PI_DISABLE_WORKFLOWS: "1",
      PI_WORKFLOWS_RECURSIVE: "1",
    },
    signal,
    timeout: agent.opts.timeoutMs ?? 600_000,
    // Subprocess lifecycle (§5.5.1):
    //   Linux:  prctl(PR_SET_PDEATHSIG, SIGTERM) via thin wrapper
    //   macOS:  the child polls process.ppid every 5s and self-SIGTERMs on reparent
    //   Both:   wrapper writes child PID + start-time into manifest for crash-sweep (§5.8)
    detached: false,
  });

  // 4. parse JSON stream, extract final result
  // Failure contract (§5.5.2): malformed JSON → MalformedAgentOutputError;
  //   the offending agent fails, the phase rejects via AggregateError only
  //   when all sibling agents have settled, and the run stays in `running`.
  const result = parseJsonStream(child.stdout);

  // 5. cache and return
  await run.cache.set(cacheKey, result);
  semaphore.release();
  return result;
}
```

#### 5.5.1 Subprocess lifecycle & orphan prevention

If the pi parent dies via `SIGKILL` (or any non-graceful exit), `pi -p` children are reparented to PID 1 and continue burning Bedrock tokens silently. The dispatcher mitigates this with a defense-in-depth approach:

| Layer | Linux | macOS / fallback |
|---|---|---|
| Kernel-signaled death | A small wrapper `pi-workflows-spawn` calls `prctl(PR_SET_PDEATHSIG, SIGTERM)` immediately before `execvp`-ing pi, so the kernel signals the child the moment the parent dies. | Not available. |
| Application-level death poll | (also runs as belt-and-braces) | The wrapper polls `process.ppid` every 5 seconds; when it changes (i.e. reparented to PID 1), the wrapper sends SIGTERM to the spawned pi and exits. |
| Crash sweep on next pi start | (covered by both) | (covered by both) |

The wrapper is a tiny native helper shipped with the package; on platforms where neither path is feasible, the dispatcher falls back to no-op and the manifest's `parentPid` + `parentStartTime` lets the next pi startup detect and clean up orphans (§5.8).

The `manifest.json` records:

```json
{
  "parentPid": 12345,
  "parentStartTime": "2026-05-28T14:30:11.000Z",
  "...": ""
}
```

PID alone is recyclable across reboots; pid + start-time is the stable identity.

#### 5.5.2 Malformed agent output

A child's `--mode json` stream may emit malformed JSON, partial JSON, or empty stdout (for crashes pre-flushing). The dispatcher's contract:

| Failure | Detection | Effect |
|---|---|---|
| Parse error mid-stream | `jsonStream.ts` throws | The **agent** rejects with `MalformedAgentOutputError` carrying: the malformed bytes (truncated to 256 bytes), the agent's `cwd`, and the child's exit code. |
| Empty stdout, child exited non-zero | exit code != 0, no result-event | Same `MalformedAgentOutputError`, with the bytes-buffer being whatever stderr produced (truncated to 256 bytes). |
| Empty stdout, child exited zero | exit code == 0, no result-event | Same error type but with detail `"empty stdout from successful subprocess"`. |
| Output is valid JSON but not the expected schema | Schema check after parse | `MalformedAgentOutputError`, detail `"unexpected schema"`. |

For each, the malformed bytes are **always** appended to `<runId>/agents/<agentId>.stderr` for forensics, regardless of cause.

The **phase** reaction:

- If **other** agents in the phase are still pending: this agent is marked failed; the phase waits for the others.
- Once **all** agents in the phase have settled: the phase rejects with `AggregateError` whose `.errors` includes this agent's `MalformedAgentOutputError`.

The **run** stays in `running` until the script either catches the rejection or unwinds to the top level. Only the offending agent is terminal-failed in the ledger; the run as a whole follows whatever the script does with the error.

Unit test `dispatcher.malformed-json.test.ts` (added to §12) verifies all four detection paths.

`pi.exec` is the abort-aware shell helper from pi's extension API. It is responsible for SIGTERM → SIGKILL escalation when the signal is aborted.

### 5.6 Cancellation propagation

Triggers:

| Trigger | Result |
|---|---|
| User presses `x` on the overlay or runs `/workflows kill <id>` | `runManager.stop(runId)` → `run.abortController.abort()` |
| `Ctrl+C` while overlay is focused | Same as above (`x` is the explicit form). |
| `session_shutdown` | Run is paused, not aborted (subprocesses are SIGTERM'd at process exit anyway). |
| Agent timeout (`opts.timeoutMs`) | The individual agent's `pi.exec` call is aborted; the phase rejects with `AggregateError`. |
| `--mock-agents` and the fixture file is missing for an agent | The agent's promise rejects; phase rejects. |

When the run's AbortController fires:

1. Every queued semaphore acquire rejects.
2. Every active agent's `pi.exec` aborts → SIGTERM in 5s, SIGKILL in 15s (pi.exec defaults).
3. The user-script's awaited `ctx.phase` call rejects with an `AbortError`.
4. The script's `try/finally` (if any) gets to clean up; the runtime gives it 5s wall-clock then forcibly disposes the `vm.Context`.
5. Final state transition: `stopped` (or `failed` if the cancellation was due to an error path).

### 5.7 Pause & resume

Pause is **cooperative at the agent boundary**:

- `runManager.pause(runId)` flips `run.paused = true`.
- Currently-running agents finish their `pi -p` subprocess (we don't SIGSTOP — subprocesses don't queue signals reliably and can deadlock waiting for stdin).
- The semaphore acquire wraps with a `paused` check; on pause, acquires block on a `while (run.paused) await event("resume")` loop.
- When the script awaits `ctx.phase` and the phase is paused, the next batch of agents waits for resume.
- The state transitions to `paused` once all currently-active agents complete or the phase has no active agents.

Resume reverses: `run.paused = false`, the resume event fires, queued acquires proceed.

### 5.8 Resume-from-disk after pi crash

A crashed run is one whose ledger ends in a non-terminal state without a `shutdown` entry. The resume flow:

1. `/workflows resume <runId>` validates `<runId>` exists and is non-terminal.
2. Re-load the workflow's `script.js` from `<runId>/script.js` (NOT from the current `.pi/workflows/` — we want bit-exact resume even if the author edited the script). The author can opt into running the latest version with `/workflows resume <runId> --latest`.
3. Re-load `cache.jsonl` into memory.
4. Construct a fresh `vm.Context` and a new `RunCtx` with `ctx.run.resumed = true`.
5. Re-execute the script from the top. Cache hits cover already-completed agents. The script's deterministic structure (no `Date.now`, no `Math.random` unless the author added them) means it deterministically re-walks to the same `ctx.phase` call where it crashed.

**The cache, not a checkpoint, is the resume primitive.** This is a deliberate choice over deep checkpointing: simpler, no continuation-stealing, no need for the script to be pause-aware.

#### 5.8.1 `--latest` cache behavior

Because cache keys include `workflow_version` (the script's sha256, see §4.5), opting into `--latest` rehashes the live script and **most cache entries will miss on lookup**. `--latest` is therefore mostly equivalent to a fresh run that reuses the run-id and parent context, not a true "resume with edits." Authors who want script edits to reuse cached agents should set explicit `cacheKeyExtra` on `agent()` calls so the cache key is decoupled from the full-script hash, and avoid `--latest`.

When `--latest` is invoked, the runtime emits a one-line warning to the conversation:

```
⚠  /workflows resume <runId> --latest: cache will mostly miss (script
   sha256 differs). To preserve cache across edits, use explicit
   cacheKeyExtra on individual agents.
```

#### 5.8.2 Crash sweep on pi startup

On `session_start { reason: "new" | "resume" }`, the extension scans `~/.pi/agent/workflows/runs/*/manifest.json`. For every manifest with a non-terminal latest ledger transition:

1. Read `parentPid` + `parentStartTime` from the manifest.
2. Check `/proc/<parentPid>/stat` (Linux) or `ps -o pid,lstart -p <parentPid>` (macOS) to verify the original parent is still alive **and** has the same start-time.
3. If absent or start-time mismatch → the parent is gone (crashed or rebooted). Append a ledger entry `{ type: "transition", from: "<latest>", to: "failed", reason: "parent-crash" }` and emit `pi-workflows.run.transition` event so any open overlay reflects the state.
4. If the parent is still alive (an unrelated pi instance is mid-run) → leave the manifest alone; the running pi owns it.

This sweep is safe to run concurrently across multiple pi instances because (a) it only writes to the ledger of definitely-dead runs, and (b) ledger appends are atomic via the OS write boundary.

**Resumable from disk after a pi crash:** runs whose latest transition is `paused` or `running` (treated as crashed-mid-run; resume re-enters `running` after replaying cached agent results). Runs marked `failed: parent-crash` by the sweep can also be resumed via `/workflows resume <runId>` — the sweep transitions are advisory, not destructive.

### 5.9 Slash-command handler shape

The handler returned to pi is non-blocking:

```ts
pi.registerCommand(name, {
  description: workflow.description ?? `Run workflow ${name}`,
  handler: async (args, cmdCtx) => {
    // 1. quick checks (disabled, bypass conditions)
    // 2. approval prompt if needed (this awaits)
    // 3. start the run via runManager.start(workflow, args)
    // 4. send a "started" notification message
    // 5. RETURN. The Promise from runManager.start lives in the background.
  },
});
```

The approval prompt is the only blocking operation in the handler. Once the prompt resolves, `runManager.start` is called fire-and-forget and the handler returns.

---

## 6. Persistence layout

### 6.1 Per-run directory

```
~/.pi/agent/workflows/runs/<runId>/
  manifest.json       — immutable run config (name, version, started_at, cwd, opts)
  script.js           — frozen copy of the script source at run-start (resume reads this)
  cache.jsonl         — append-only agent-result cache + author cache
  ledger.jsonl        — append-only run-state event log
  fixtures.jsonl      — (optional) canned agent responses for --mock-agents mode
  result.json         — final result of main() (only on terminal-success state)
  agents/             — directory of per-agent transcripts
    <agentId>.jsonl   — the pi -p subprocess's --mode json transcript
```

`<runId>` format: `wf-` + 12 hex chars (random). Example: `wf-9f3a2c8e7b1d`.

### 6.2 `manifest.json`

```json
{
  "runId": "wf-9f3a2c8e7b1d",
  "workflowName": "codebase-audit",
  "workflowAbsPath": "/home/samfp/proj/.pi/workflows/codebase-audit.js",
  "workflowSourceSha256": "<hex>",
  "input": "audit the auth module",
  "startedAt": "2026-05-28T14:30:12.345Z",
  "cwd": "/home/samfp/proj",
  "piVersion": "1.4.7",
  "piWorkflowsVersion": "0.1.0",
  "options": {
    "mockAgents": false,
    "maxConcurrent": 16,
    "perRunAgentCap": 1000
  },
  "trustedAtStart": true
}
```

Written once at run start. Never updated.

### 6.3 `cache.jsonl`

Append-only. One record per cache write. Records are typed:

```json
{ "type": "agent_result", "key": "<sha256>", "value": { "agentId": "...", "text": "...", "usage": {...}, "durationMs": 1234, "toolCalls": 5, "transcriptPath": "..." }, "at": "<ISO>" }
{ "type": "author_cache", "key": "user-key", "value": <any>, "at": "<ISO>" }
{ "type": "author_cache_delete", "key": "user-key", "at": "<ISO>" }
```

Reads at run-start replay the file and build an in-memory map. Last-write-wins on duplicate keys. Author-cache deletes remove the key from the in-memory map.

A periodic compaction (every 1000 entries) rewrites `cache.jsonl` to a new file with only the last value per key, atomically renames over the original. Compaction is **not** required for correctness; it bounds disk size.

### 6.4 `ledger.jsonl`

Append-only event log of run state. Entry types:

| Type | Fields | When |
|---|---|---|
| `init` | `manifest` | First entry, mirrors `manifest.json` |
| `transition` | `from`, `to`, `reason?` | State machine transition. `reason` is set on involuntary transitions (e.g. `parent-crash` from the §5.8.2 sweep). |
| `cancelled` | `cause: "user-N"|"disabled"` | The `pending → cancelled-pre-run` shortcut: user picked `[N]` in the approval dialog, or the workflow was disabled mid-prompt. Always followed by a terminal `transition` to `cancelled-pre-run`. |
| `phase_start` | `phaseName`, `agentCount` | `ctx.phase()` invocation |
| `phase_end` | `phaseName`, `durationMs`, `agentResults` (counts only, not text) | Phase resolves |
| `agent_start` | `phaseName`, `agentId`, `promptHash` | Sub-agent dispatched |
| `agent_end` | `phaseName`, `agentId`, `durationMs`, `usage`, `cached` | Sub-agent completes |
| `agent_error` | `phaseName`, `agentId`, `error` | Sub-agent fails |
| `agent_cache_hit` | `phaseName`, `agentId` | Resolved from cache |
| `log` | `level`, `message` | `ctx.log` call |
| `pause` / `resume` | (no fields) | Pause/resume |
| `shutdown` | `graceful: bool` | pi shutdown |
| `result` | `truncated: bool`, `result` (≤ first 4KB stringified) | `main()` resolves |
| `error` | `error: { name, message, stack }` | `main()` throws |

Ledger reconstructs full run state from disk alone. Used by:

- `/workflows resume`: latest `transition` determines current state.
- `/workflows show`: tail printer.
- TUI overlay: tail-and-stream subscriber.
- Debugging.

### 6.5 `agents/<agentId>.jsonl`

The sub-agent's full `pi --mode json` transcript. Captured by piping the subprocess's stdout through a stream that tees to this file. **Truncation:** if the file exceeds `pi-workflows.maxAgentTranscriptBytes` (default 16MB), the tail is dropped and a marker line is written.

### 6.6 Active-runs index (`pi.appendEntry`)

The extension keeps a small, in-session index using pi's own `appendEntry` mechanism:

```ts
pi.appendEntry("pi-workflows.run.started", { runId, workflowName, startedAt });
pi.appendEntry("pi-workflows.run.ended",   { runId, finalState, endedAt });
```

Key shape matches the `pi.events` topic taxonomy: `pi-workflows.<noun>.<verb>` (dotted, no hyphens between verb segments).

This lets pi's session-restore replay the index at next startup so the overlay knows which runs to surface as "recent." The on-disk `runs/` dir is the source of truth; `appendEntry` is the fast index.

### 6.7 GC policy

`/workflows gc` deletes runs that meet **all** of:

- Final state is terminal (`done`, `failed`, `stopped`, `cancelled-pre-run`).
- `endedAt` older than `pi-workflows.gcAfterDays` (default 30; 0 disables; ≥5475 (15 yr) clamped to 5475).

Running a GC is interactive: prints a list, waits for confirmation, then deletes. `--dry-run` skips deletion.

GC is **not** automatic in v1. Authors choosing to run a workflow loop overnight that creates 1000 runs need to manually GC, or set up their own cron. (See §15.8 for the auto-GC question; deferred to v2.)

### 6.8 Disk-usage discipline

| Stream | Default cap | Setting |
|---|---|---|
| Per-agent transcript | 16 MB | `pi-workflows.maxAgentTranscriptBytes` |
| Per-run ledger | uncapped | (compactable, but not auto) |
| Per-run cache | uncapped (compacted at 1000 entries) | (no setting) |
| Total runs/ dir | uncapped | (use `/workflows gc`) |

True "runaway disk" cases (a workflow with 1000 agents producing huge transcripts) can hit ~16 GB — documented as a known sharp edge.

---

## 7. Approval & permissions

### 7.1 What approval gates

Approval gates an **entire run**, not per-agent. The user agrees once: "yes, this workflow file may run, with all the tool access this pi session has." Sub-agents inherit the parent's tool allowlist verbatim; there is no per-agent elevation (no `acceptEdits`-equivalent).

CC's per-tool / per-agent permission elevation requires hooks pi doesn't expose. If pi adds those primitives later, we revisit (see §14).

### 7.2 Trust storage

Project and user `settings.json` both contribute to a merged map of trusted workflows. The setting key is:

```json
{
  "pi-workflows": {
    "trustedWorkflows": {
      "/abs/path/to/.pi/workflows/codebase-audit.js": [
        { "name": "codebase-audit", "sha256": "a3f2…e1" }
      ],
      "/home/user/.pi/agent/workflows/deep-think.js": [
        { "name": "deep-think", "sha256": "7c91…08" }
      ]
    }
  }
}
```

The outer key is the workflow file's **absolute path**. Each entry is `{ name, sha256 }` — the user-trusted name *and* the source-bytes hash at the moment of trust. Trust is keyed on the pair `(absPath, sourceSha256)`:

- A `git pull` (or any author edit) that mutates the file changes the sha256 and **invalidates the existing trust entry**. The next invocation re-prompts with a `"this workflow file has changed since you last trusted it"` warning.
- A workflow file moved to a new path is also re-prompted (different `absPath`).
- The list-of-entries shape (vs. single object) is preserved because in principle a JS file could expose multiple slash commands; v1 only exposes one, but the schema allows expansion.

**Precedence:** project setting wins for a given key. Personal setting is consulted as fallback. "Trusted in project, not in personal" → trusted. "Trusted in personal, not in project" → trusted. Pi's settings merge already does this; we use it directly.

### 7.3 Trust mutation

| Action | Effect |
|---|---|
| User picks `[A] Run + always trust` | Adds `(absPath, name, sourceSha256)` to settings. **Scope is detected by source path:** if the file is under `<cwd>/.pi/workflows/`, write to project settings (`<project>/.pi/settings.json`); if under `~/.pi/agent/workflows/`, write to personal settings (`~/.pi/agent/settings.json`). No modifier key, no ambiguity. |
| `/workflows trust <name>` | CLI form; same effect as `[A]` but invocable without running. Same path-detection rule. |
| `/workflows untrust <name>` | Removes from settings (both scopes if present). Next run prompts again. |

### 7.4 Bypass conditions (re-stated for completeness)

Approval is bypassed (run proceeds without prompting) when:

| Condition | Source | Detection | Notes |
|---|---|---|---|
| `--bypass-permissions` flag | pi CLI | `process.env.PI_BYPASS_PERMISSIONS === "1"` | Same precedence as CC. |
| Running under SDK | pi runtime | `process.env.PI_MODE === "sdk"` or `"json"` | Same precedence as CC. |
| `--mock-agents` (this extension) | pi-workflows | `cmdCtx.flags?.["mock-agents"] === true` | Test-only. |
| `pi -p <prompt>` (single-prompt mode) | pi CLI | `process.env.PI_PROMPT_MODE === "1"` | **Bypass only if `(absPath, sourceSha256)` is already in `trustedWorkflows`.** First-time invocation under `pi -p` errors with `"workflow `<name>` not yet trusted; run interactively first to grant trust."` Stricter than CC; documented as a deliberate parity drift in §14. |

**These are read from `process.env` at runtime**, not cached. If pi's CLI changes how it sets these, we follow.

#### 7.4.1 Why `pi -p` is stricter than CC

A `pi -p` session can be triggered by an LLM in the parent that retrieved adversarial context (poisoned README, malicious search result). If `pi -p` unconditionally bypassed approval, that adversarial context could induce the LLM to invoke `/<workflow>` and ship the user's repo to an attacker via a sub-agent's tool calls. By gating bypass on `(absPath, sourceSha256)` ∈ trusted, we preserve the user's intent (they trusted **this exact bytes** of **this exact file**) while still allowing fully-automated `pi -p` runs of trusted workflows.

This is documented as parity gap #16 in §14.

### 7.5 Permission inheritance into sub-agents

Each sub-agent's `pi --mode json -p` subprocess inherits:

- The parent's `PATH`, `HOME`, and other process env (modulo additions like `PI_PARENT_RUN_ID`).
- The parent's pi settings (per pi's existing default behavior).
- The parent's tool allowlist (whatever the parent session can do, the child can do).

**It does NOT inherit:**

- The parent session's conversation history (each agent is a fresh session).
- The parent session's `--bypass-permissions` flag (pass-through is **explicit**, not implicit — see below).

**Bypass pass-through:** if the parent session was launched with `--bypass-permissions`, sub-agents are also launched with `--bypass-permissions`. This is explicit and documented because it's an obvious surprise vector. It matches CC's behavior. **V1 is always-pass-through and not configurable** — see §15.B for the locked rationale.

### 7.6 Approval state from `--mock-agents`

In mock mode, the run still records what it would have approved. The mock fixture file controls agent responses; the trust state is unchanged. This means **integration tests that exercise approval do so by setting `pi-workflows.trustedWorkflows` in a temp settings file and pointing pi at it**, not by running mock mode.

### 7.7 First-run vs returning-run UX summary

| State | Dialog? | Run starts? |
|---|---|---|
| First time, interactive pi, not bypassed | Yes | After approval |
| Trusted in settings, interactive pi | No | Immediately |
| Untrusted, but bypassed via flag/SDK | No | Immediately |
| User picked `[N]` | No (cancelled) | No, state is `cancelled-pre-run` |
| Workflow disabled via setting | No | No, `/<name>` is not registered |

### 7.8 Parity-gap callout

**Documented in README + `docs/authoring.md`:**

> CC's Dynamic Workflows can elevate per-agent permissions to `acceptEdits` (auto-approve file edits without prompting per turn). Pi has no equivalent primitive in v1. Workflow approval in pi-workflows gates the **whole run** at start. Inside the run, sub-agents follow the parent session's normal tool allowlist; if a tool would normally prompt the user mid-conversation, it still prompts. We will revisit if pi adds a primitive.

---

## 8. Threat model

### 8.1 Trust assumption (load-bearing)

**This is a sandbox, not a security perimeter for hostile authors.** A malicious workflow author could equally write a malicious pi extension and bypass the sandbox entirely. The threat model assumes:

- The workflow author is **trusted** (you wrote it, or you reviewed it).
- The sandbox protects against **accidents** — author typos that read the wrong file, mistakenly enabled debug logging, or third-party code with surprising side effects.
- The sandbox **does not** protect against a determined attacker with code execution rights inside pi already.

Documented in README in bold: *Workflows run with full pi tool access via their sub-agents. Treat workflow files like any other code you'd run.*

### 8.2 Sandbox surface

The `vm.Context` is constructed with:

- A custom `globalThis` containing only the curated globals from §4.3.
- All built-in constructors and prototypes are reached via the new Context's intrinsics (Node 22's `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` is **not** used — we want the script to see the Context's intrinsics, not main's).
- After construction, all globals (and their prototypes one level deep) are `Object.freeze`'d.

### 8.3 Known escape vectors and mitigations

#### 8.3.1 `Object.constructor.constructor` ("Function constructor escape")

```js
// Author code:
const F = (() => {}).constructor;
const escape = new F("return this");
escape();  // Returns the Context's globalThis, NOT the host's.
```

**Mitigation:** This works but escapes only to the **Context's** globalThis, which is the same restricted object the script already has via `globalThis`. No additional capability is gained. **Not a real escape.**

In raw `vm.runInContext` (without a fresh Context), this would escape to the host's globalThis. We use `vm.createContext({ ... })` with a fresh sandbox object, which keeps `Function` constructor calls inside the Context.

#### 8.3.2 Prototype pollution

```js
// Author code:
Object.prototype.foo = "poisoned";
```

**Mitigation:** `Object.freeze(Object.prototype)` and friends after Context init. Throws `TypeError` on attempted assignment. Test fixture `tests/security/prototype-pollution.workflow.js` verifies.

#### 8.3.3 `AsyncFunction`-via-`Function`

```js
const AF = (async () => {}).constructor;
const f = new AF("...whatever...");
```

Same story as 8.3.1. Stays inside the Context. Not an escape.

#### 8.3.4 Reaching a host-realm value through a passed-in object

If the host passes a value into the Context that is from the host's realm (e.g. an `Error` object), and the script touches its `.constructor`, it can reach host intrinsics.

**Mitigation:** Every value the host passes into the Context is **structured-cloned** first (or, for primitives, passed directly). The `ctx` object is constructed inside the Context's realm with intrinsics from the Context. Specifically, the `RunCtx` factory uses `vm.runInContext` to construct it.

Methods on `ctx` are functions defined in the host realm, but they are **wrapped**: each method is `vm.runInContext("function () { return host_method.apply(this, arguments) }", ctx)` so the wrapper is a Context-realm function. Errors thrown by the host method are reconstructed as Context-realm errors via the contract below.

**Realm-error reconstruction contract** (load-bearing for `AggregateError` propagation, §4.2.2):

| Property | Preserved? | How |
|---|---|---|
| `error.name` | yes | Set on the reconstructed error so authors can `if (e.name === "AggregateError") ...`. |
| `error.message` | yes | Copied. |
| `error.cause` | yes (recursively) | If present, the cause is itself reconstructed via the same contract and assigned to `.cause`. |
| `AggregateError.errors` | yes (recursively) | Each element is reconstructed via the same contract; the outer error is built with `new vm.runInContext("AggregateError", ctx)(reconstructedErrors, message)`. |
| `error.stack` | yes (annotated) | Original stack is preserved; a final line `"    — reconstructed across realm boundary —"` is appended so debuggers know. |
| Custom subclass identity (e.g. `class FooError extends Error`) | **no** | Reconstructed as a Context-realm `Error` with `.name` set to the original constructor name. `instanceof FooError` will return false in the script. **Documented limitation.** |
| Non-`Error` thrown values (`throw 42`, `throw "oops"`, `throw Symbol("x")`, etc.) | wrapped | Reconstructed as a Context-realm `Error(String(value))` with `.wrappedNonError = true` and `.originalType` set to a normalized type tag: `"number"`, `"string"`, `"boolean"`, `"bigint"`, `"undefined"`, `"symbol"`, `"function"`, `"object"`, or `"null"` (special-cased; `typeof null` is otherwise `"object"`). `String(value)` is total — it stringifies symbols via `Symbol.prototype.toString` and objects via `Object.prototype.toString` without throwing. Preserves forensic intent without forcing scripts to juggle types: every `catch` clause sees an `Error` with `.stack`, `.message`, and the audit flags. |

The wrapper that performs reconstruction is a single `reconstructError(host_error, ctx)` helper used by all `ctx.*` method wrappers. Unit test `tests/unit/realmError.test.ts` verifies each row of the table.

This is the most subtle area. Test fixture `tests/security/realm-pierce.workflow.js` tries every known way to grab a host-realm intrinsic.

#### 8.3.5 Timer-based escapes

`setTimeout(callback, 0)` inside a vm.Context runs the callback via the host's event loop — the callback's `this` is host-realm.

**Mitigation:** A per-run **callback-handle table** indirects every timer callback through a Context-realm trampoline.

1. **Per-run state** (host-side):
   ```ts
   class CallbackTable {
     private next = 1;
     private map = new Map<number, Function>();
     register(fn: Function): number { const h = this.next++; this.map.set(h, fn); return h; }
     unregister(h: number): void { this.map.delete(h); }
     invoke(h: number, ctx: vm.Context): void {
       const fn = this.map.get(h);
       if (!fn) return;  // already cleared (abort)
       // Trampoline into the Context's realm to invoke fn.
       try {
         vm.runInContext(`__cbTable__.run(${h})`, ctx);
       } catch (host_err) {
         // Reconstruct as a Context-realm error and re-throw inside the Context
         // so the script's error handlers see the right realm.
         const reErr = reconstructError(host_err, ctx);
         vm.runInContext(`throw __cbTable__.lastError`, ctx, { displayErrors: false });
       }
     }
   }
   ```

2. **Context-realm trampoline** (installed at Context init via `vm.compileFunction`):
   ```js
   // Inside the Context. `__cbTable__` is a frozen object with one method.
   globalThis.__cbTable__ = Object.freeze({
     run(handle) {
       const fn = __cbStorage__[handle];  // Context-realm Map
       if (typeof fn === "function") fn();
     },
   });
   ```
   Authors cannot reach `__cbTable__` cleanly because we name-mangle and remove it from `globalThis` enumeration via `Object.defineProperty(globalThis, "__cbTable__", { enumerable: false, configurable: false, writable: false })`.

3. **`setTimeout` override** (Context-realm function, installed at init):
   ```js
   // Inside the Context.
   globalThis.setTimeout = (cb, ms, ...args) => {
     const h = __hostBridge__.registerCallback(() => cb(...args));
     return __hostBridge__.setHostTimeout(h, ms);  // returns a Context-realm timer ID
   };
   globalThis.clearTimeout = (id) => __hostBridge__.clearHostTimeout(id);
   // setInterval / clearInterval / setImmediate / queueMicrotask analogous.
   ```

4. **AbortSignal interaction:** when the run aborts, the host iterates `callbackTable.map`, calls `clearHostTimeout` for each, and clears the table. Already-fired-but-not-yet-invoked trampolines see `fn === undefined` and no-op. No Context-realm code runs after abort.

5. **Error path:** if `cb` throws inside the trampoline, the host catches the error, reconstructs it as a Context-realm error per §8.3.4, and re-throws *inside the Context* so author-level `try/catch` sees the right realm. Uncaught timer errors propagate to the run's failure path.

All outstanding timer handles are tracked in a per-run `Set<HostTimerId>` and cleared on AbortSignal trigger. Unit test `tests/unit/timerEscape.test.ts` verifies: (a) a callback's `this`-binding stays in the Context, (b) a thrown error's prototype is Context-realm `Error`, (c) abort clears all pending timers within 50ms, (d) nested `setTimeout`-chains still abort cleanly.

#### 8.3.6 Uncatchable errors / infinite loops

A workflow with `while (true) {}` blocks the event loop and prevents abort signals from firing. **There is no v1 mitigation; we accept this footgun.**

**Behavior:** A sync infinite loop wedges the entire pi process. The Node event loop cannot dispatch microtasks while a sync loop is running, so:

- Pi's TUI cannot receive keystrokes; **`x` (stop) will not fire**.
- The overlay cannot redraw.
- Other extensions' timers and event handlers are starved.
- The user must `kill -INT <pi-pid>` from another terminal, which terminates **every** active run, not only the offender.

We accept this in v1 because the alternative (worker_threads or interrupt-on-tick) is out of scope per pin 5. Documented in `parity-gaps.md` as `"sync-loop wedge"`. Cross-referenced in §14 row 17.

**Author guidance** (in `docs/authoring.md`): never write a CPU loop that doesn't `await` something at least every ~10ms. Common pitfall: a synchronous `for` over a large array without yielding. Fix: chunk the loop and `await ctx.sleep(0)` between chunks.

#### 8.3.7 Resource exhaustion (memory)

```js
const arr = []; while (true) arr.push(arr);  // OOM
```

**Mitigation:** None in v1. A malicious workflow could OOM pi. Documented as out of scope for the trust model. We rely on Node's default heap limit (`--max-old-space-size`, defaults to 4GB) for the whole pi process.

#### 8.3.8 Side-channel via cache / ledger

A workflow could write attacker-chosen values to `cache.jsonl` or trigger ledger entries that grow without bound.

**Mitigation:** None v1. Author is trusted. Documented.

#### 8.3.9 `process.env` leak

If `process` were exposed unmodified, `process.env` exposes secrets.

**Mitigation:** The sandbox `process` stub has `env: {}` (empty). Only `platform`, `arch`, `versions.node` are exposed.

#### 8.3.10 Network via DNS-resolved primitives

No `fetch`, no `http`, no `dns`. **None of the curated globals expose network.** A workflow author can still get network access via `ctx.agent` (the spawned `pi -p` child has full network), which is the **intended path**: any network needed must go through a tool the user has approved.

### 8.4 Audit trail

Every sandbox violation attempt that we can detect (frozen-write attempts, attempts to set restricted globals) is logged as `{ type: "sandbox_violation", detail: "..." }` to `ledger.jsonl`. Most violations are silent (they throw inside the script and the script handles them); explicit violations show up only when the runtime's wrapper catches them.

### 8.5 Out-of-scope

- Adversarial workflows attempting to compromise the host process. The author is trusted.
- Side-channel attacks (timing, cache).
- Persistence of sandbox state across runs (each run is its own Context).
- Multi-tenant pi (pi is single-user).

### 8.6 Test corpus

The security suite (`tests/security/`) contains one workflow per known escape vector, each asserting that the escape **does not yield a host-realm intrinsic** (we explicitly check `result.constructor !== global.Object` etc.):

- `prototype-pollution.workflow.js`
- `function-constructor.workflow.js`
- `async-function-constructor.workflow.js`
- `realm-pierce.workflow.js`
- `timer-escape.workflow.js`
- `process-env-leak.workflow.js`
- `network-via-fetch.workflow.js` (asserts `fetch` is undefined)
- `require-resolve.workflow.js` (asserts `require` is undefined)
- `dynamic-import.workflow.js` (asserts `import()` throws)

The security suite must pass before any release.

---

## 9. Bundled `/codebase-audit` workflow

The extension ships one bundled workflow as a reference implementation and self-contained demo. It lives at `examples/codebase-audit/codebase-audit.js` in the repo and is **copied into `~/.pi/agent/workflows/`** by `pi install` automatically (via the `pi:` field in `package.json`).

### 9.1 What it does

A phased audit of a codebase:

1. **Phase `recon`** — 1 agent scans the repo for entry points and module boundaries; produces a list of areas to audit.
2. **Phase `analyze`** — N agents in parallel (one per area), each analyzing one area for bugs, dead code, and tech debt.
3. **Phase `vote`** — 3 judges run in parallel and each rank-orders the findings; their votes are aggregated via a Borda count (full code in §9.2). The result is the consensus top 10.
4. **Phase `summarize`** — 1 agent writes a final audit report from the top findings.
5. The report is sent to the conversation via `pi.sendMessage` and saved at `<runId>/result.json`.

### 9.2 Reference script

This IS the canonical example. It pins what the author API looks like in practice. ~75 lines.

```js
/// <reference types="@samfp/pi-workflows" />

/**
 * /codebase-audit — phased audit of the current repo.
 * Phases: recon → analyze (parallel) → vote → summarize.
 */

export default async function main(ctx, input) {
  ctx.log(`codebase-audit starting on ${ctx.run.cwd}; input="${input}"`);

  // ---- Phase 1: recon ----
  const [recon] = await ctx.phase("recon", [
    ctx.agent(
      `Survey the repo at ${ctx.run.cwd}. Identify the 5–8 most important
      module/area boundaries. Output as a JSON array: [{"area": "...", "paths": ["..."], "why": "..."}].
      Focus on auth, data, IO boundaries, and anything mutating shared state.
      User context: "${input || "general audit"}"`,
      { id: "recon", inheritSkills: true },
    ),
  ]);

  let areas;
  try {
    const match = recon.text.match(/\[[\s\S]*\]/);
    areas = JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`recon agent did not return parseable JSON: ${e.message}`);
  }
  ctx.log(`recon: identified ${areas.length} areas to audit`);
  await ctx.cache.set("areas", areas);

  // ---- Phase 2: analyze (parallel, one agent per area) ----
  const analyzers = areas.map((area, i) =>
    ctx.agent(
      `Audit area "${area.area}" (paths: ${area.paths.join(", ")}). Look for:
      bugs, dead code, tech debt, missing tests, security smells, perf issues.
      Output 3–8 findings as JSON: [{"title": "...", "severity": "high|med|low",
      "path": "...", "detail": "..."}]. Be specific; cite line numbers.`,
      { id: `analyze-${i}`, inheritSkills: true, cacheKeyExtra: { area: area.area } },
    ),
  );
  const analyses = await ctx.phase("analyze", analyzers);

  const allFindings = [];
  for (const a of analyses) {
    try {
      const m = a.text.match(/\[[\s\S]*\]/);
      allFindings.push(...JSON.parse(m[0]));
    } catch (e) {
      ctx.log({ msg: "analyze agent returned unparseable JSON", agentId: a.agentId, err: e.message }, { level: "warn" });
    }
  }
  ctx.log(`analyze: ${allFindings.length} findings collected from ${analyses.length} agents`);
  await ctx.cache.set("findings", allFindings);

  if (allFindings.length === 0) {
    return { status: "clean", message: "No findings." };
  }

  // ---- Phase 3: vote on top 10 ----
  const findingsJson = JSON.stringify(allFindings, null, 2);
  const voters = [0, 1, 2].map((i) =>
    ctx.agent(
      `Below are ${allFindings.length} audit findings. Rank-order the TOP 10 most
      critical for a code review. Consider severity, blast radius, fix difficulty.
      Return JSON: [{"rank": 1, "title": "...", "justification": "..."}, ...].
      Findings:\n${findingsJson}`,
      { id: `voter-${i}`, thinking: "high" },
    ),
  );
  const votes = await ctx.phase("vote", voters);

  // simple Borda count over titles
  const scores = new Map();
  for (const v of votes) {
    try {
      const ranked = JSON.parse(v.text.match(/\[[\s\S]*\]/)[0]);
      for (const r of ranked) {
        scores.set(r.title, (scores.get(r.title) || 0) + (11 - r.rank));
      }
    } catch { /* skip malformed voter */ }
  }
  const top10 = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ---- Phase 4: summarize ----
  const top10Detail = top10.map(([title]) =>
    allFindings.find((f) => f.title === title)
  ).filter(Boolean);
  const [summary] = await ctx.phase("summarize", [
    ctx.agent(
      `Write a 1-page audit report. Group these top findings by severity and area.
      Include actionable next steps. Be specific and reference paths.
      Top findings:\n${JSON.stringify(top10Detail, null, 2)}`,
      { id: "summarize", thinking: "high" },
    ),
  ]);

  return {
    runId: ctx.run.id,
    cwd: ctx.run.cwd,
    findingsConsidered: allFindings.length,
    top10: top10Detail,
    report: summary.text,
  };
}
```

### 9.3 What this example pins down

- `ctx.phase` returns `AgentResult[]` with `.text`.
- Single-agent phases are a list-of-one for symmetry.
- `cacheKeyExtra` lets authors stabilize cache across script edits.
- `ctx.cache` is for author-controlled state (e.g. `findings` saved for inspection / resume).
- `ctx.log` is the only side-channel for visibility.
- The script itself is plain JS — no special syntax, no DSL.
- A bundled workflow demonstrates `inheritSkills: true` so sub-agents have access to skills like `code-overview`.

**Note on `ctx.vote` vs. the manual Borda loop in this example.** `ctx.vote()` (§4.2.6) is the standard helper for **single-winner** judging — "which of these N candidate answers is best?". It runs a judge agent that picks one. In contrast, this example needs **rank + selection** (top 10, ordered, from M voters), which is a different aggregation. Showing the explicit Borda loop pins how authors compose phases when they need richer aggregation than the stdlib helper covers, and demonstrates that the API is small but composable. Both are legitimate patterns; pick the one that matches your problem.

### 9.4 Installation path

`package.json`:

```json
{
  "pi": {
    "workflows": ["examples/codebase-audit/codebase-audit.js"]
  }
}
```

pi's package installer reads `pi.workflows` (we extend the existing `pi:` manifest convention) and copies listed files into `~/.pi/agent/workflows/`. `pi remove` deletes them. See §15.9 for the verification + fallback plan if pi-coding-agent's installer doesn't yet support this manifest field.

### 9.5 Why not `/deep-research`

CC's bundled `/deep-research` voted-and-cited web research workflow assumes a high-quality web search tool. Pi's web search story (DDG fallback in `web-search` skill) doesn't meet the bar. Shipping a degraded copy would mislead users about the feature's capability. We document the decision in the README and link to `/codebase-audit` as the canonical example.

If pi gains a high-quality web search tool, `/deep-research` becomes a reasonable v2 add. Until then, no.

---

## 10. TUI overlay design

### 10.1 Activation

`/workflows` opens the overlay via `ctx.ui.custom((tui, theme, kb, done) => { ... })`. The overlay subscribes to `pi.events` topics on mount and unsubscribes on `done()`.

If the overlay is already open and the user runs `/workflows` again, the second invocation is a no-op (we track open state via a module-level flag).

### 10.2 Three views

The overlay has three views, navigable by Enter/Esc:

```
  Runs list (default)
        │ Enter
        ▼
  Phase view (one run)
        │ Enter
        ▼
  Agent detail (one agent in one phase)
```

Esc pops one level. From Runs list, Esc closes the overlay.

### 10.3 Wireframes

#### Runs list

```
╔══ pi-workflows  · 16 max concurrent  · 0 queued ══════════════════════════╗
║                                                                          ║
║ Active                                                                   ║
║ ▸ wf-9f3a2c8e   codebase-audit   running     phase 2/4   3m 12s          ║
║   wf-7e1b4f0d   deep-think       paused      phase 1/2   1m  4s          ║
║                                                                          ║
║ Recent                                                                   ║
║   wf-2a5c9d11   codebase-audit   done        —           4m 45s   12:30  ║
║   wf-1b3e7f02   refactor-walk    failed      phase 3/3   8m 12s   11:14  ║
║   wf-0d8f1e3a   codebase-audit   stopped     phase 2/4   2m  9s   10:01  ║
║                                                                          ║
║ [↑↓ j k]  navigate    [Enter]  open run    [r]  resume    [x]  kill all  ║
║ [g]      gc dialog    [Esc]   close                                     ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

#### Phase view (one run)

```
╔══ wf-9f3a2c8e  codebase-audit  running  3m 12s  ═══════════════════════╗
║ Input: "audit the auth module"                                          ║
║ Started: 2026-05-28 14:30:12   Path: ./.pi/workflows/codebase-audit.js   ║
║                                                                          ║
║ Phases                                                                   ║
║ ✓ recon         1 agent   12s   1.4k tokens                              ║
║ ▸ analyze       4/7 agents running   1m 22s elapsed                       ║
║     ● analyze-0   running  18s    auth-utils                              ║
║     ○ analyze-1   queued   —      api-handlers                            ║
║     ● analyze-2   running  1m 4s  middleware                              ║
║     ○ analyze-3   queued   —      data-store                              ║
║     ✓ analyze-4   done     45s    config        (cached)                  ║
║     ✓ analyze-5   done     38s    cli                                     ║
║     ✓ analyze-6   done     1m 1s  routes                                  ║
║ · vote         pending                                                   ║
║ · summarize    pending                                                   ║
║                                                                          ║
║ Log (last 5)                                                             ║
║   14:32:10  recon: identified 7 areas to audit                            ║
║   14:32:11  cache: areas saved                                            ║
║   14:32:11  phase analyze starting (7 agents)                             ║
║   14:33:11  agent analyze-4 cache hit                                     ║
║   14:33:33  agent analyze-5 done (38s)                                    ║
║                                                                          ║
║ [↑↓]  agents   [Enter]  agent detail   [Esc]  back   [p]  pause           ║
║ [r]   resume    [x]      stop run       [s]    save script               ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

#### Agent detail

```
╔══ wf-9f3a2c8e · analyze · analyze-0  running  1m 22s  ══════════════════╗
║ Prompt:                                                                  ║
║   Audit area "auth-utils" (paths: src/auth/utils.ts).                    ║
║   Look for: bugs, dead code, tech debt, missing tests, security smells…  ║
║                                                                          ║
║ Model: anthropic/claude-sonnet-4   Thinking: high                        ║
║ Transcript: ~/.pi/agent/workflows/runs/wf-9f3a2c8e/agents/analyze-0.jsonl║
║                                                                          ║
║ Live tail (last 12 lines)                                                ║
║   {"type":"message","role":"assistant","content":[{"type":"thinking",…  ║
║   {"type":"toolCall","name":"read","args":{"path":"src/auth/utils.ts"}…   ║
║   …                                                                       ║
║                                                                          ║
║ [Esc]  back   [t]  open transcript in $EDITOR   [c]  copy prompt          ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

### 10.4 Hotkey table (full)

| Key | Runs list | Phase view | Agent detail |
|---|---|---|---|
| `↑` / `k` | move up | move agent cursor up | scroll log up |
| `↓` / `j` | move down | move agent cursor down | scroll log down |
| `Enter` | open phase view of selected run | open agent detail | (no-op) |
| `Esc` | close overlay | back to runs list | back to phase view |
| `p` | (no-op) | pause this run (if running) | (no-op) |
| `r` | resume selected run (if paused or stopped); restart selected run (if terminal) | resume / restart depending on state | (no-op) |
| `x` | stop selected run | stop this run | (no-op) |
| `s` | (no-op) | save current run's script.js into project's `.pi/workflows/` (with filename collision handling) | (no-op) |
| `g` | open GC dialog | (no-op) | (no-op) |
| `t` | (no-op) | (no-op) | open agent transcript in $EDITOR |
| `c` | (no-op) | (no-op) | copy prompt to clipboard (if `pbcopy`/`xclip`/`xsel` available) |
| `?` | toggle help | toggle help | toggle help |

Matches CC: `↑↓ Enter Esc j k p r x s` are all preserved.

#### 10.4.1 `r` (restart) semantics

`r` overloads two operations based on the selected run's state:

| State | Effect |
|---|---|
| `paused` | **Resume** — the run continues with the same `runId`, same cache. State → `running`. |
| `done`, `failed`, `stopped`, `cancelled-pre-run` | **Restart** — creates a **new `runId`**, copies `script.js` from the original run dir, and starts fresh. **The cache is NOT replayed** — restart is a clean run, not a cache replay. The old run's directory is preserved; the new run is a sibling. Approval is re-checked (the source hash is the same, so the user is not re-prompted unless trust was revoked). |
| `running` | Disabled (no-op). |
| `pending`, `approved` | Disabled (no-op — the run is already starting). |

Why clear cache on restart? A user typically presses restart because the previous run was unsatisfactory; reusing the cache would reproduce the unsatisfactory result. Authors who want to retry with cache-reuse can manually invoke `/<workflow>` again — cache hits will fire normally because cache keys are run-scoped (see §4.5).

#### 10.4.2 `r` on the runs list

In the runs list view, `r` operates on the **highlighted** run, with the same state-based dispatch as above. This means `r` is the single keystroke for both "keep going" and "start over."

### 10.5 Event subscriptions

The overlay subscribes to these `pi.events` topics on mount:

| Topic | Payload | Effect |
|---|---|---|
| `pi-workflows.run.started` | `{ runId, workflowName, startedAt }` | Add to active runs list |
| `pi-workflows.run.transitioned` | `{ runId, from, to, reason? }` | Update run status |
| `pi-workflows.run.ended` | `{ runId, finalState }` | Move to recent |
| `pi-workflows.phase.started` | `{ runId, phaseName, agentCount }` | Add phase row |
| `pi-workflows.phase.ended` | `{ runId, phaseName, durationMs }` | Mark phase done |
| `pi-workflows.agent.started` | `{ runId, phaseName, agentId, prompt }` | Add agent row |
| `pi-workflows.agent.ended` | `{ runId, phaseName, agentId, durationMs, cached }` | Mark agent done |
| `pi-workflows.agent.log` | `{ runId, phaseName, agentId, line }` | (only when agent detail is open) append to live tail |
| `pi-workflows.run.log` | `{ runId, message }` | Append to log pane |

### 10.6 Debounce strategy

High-frequency events (`agent.log`) are debounced at 100ms per (runId, agentId) pair. Coarse events (`run.transition`, `phase.*`) are not debounced — they're rare and important to render immediately.

The overlay uses `tui.requestRender()` with a 50ms throttle to coalesce screen updates.

### 10.7 `s` save-script hotkey detail

When the user hits `s` on the phase view of a run that originated from a personal-scope workflow file, the runtime offers to copy `<runId>/script.js` to the project's `.pi/workflows/`. Behavior:

1. Check there's a project root (heuristic: walk up from `cwd` looking for `.git` or `.pi/`; if neither found within 8 levels, abort with `"no project root found"`. See §15.C for the locked recommendation).
2. If `.pi/workflows/<name>.js` already exists, prompt for overwrite or rename.
3. Copy with `0o644` perms.
4. Show a notification: `"Saved to ./.pi/workflows/<name>.js. Add to git? (y/n)"` — if yes, run `git add` and notify result.
5. If `.gitignore` is configured to ignore `.pi/`, warn that the saved file won't be tracked.

### 10.8 Coexistence with conductor's `Ctrl+G` overlay

Both `pi-workflows`'s `/workflows` overlay and `pi-conductor`'s `Ctrl+G` focused-stream overlay use `ctx.ui.custom`. Pi's overlay model is push-pop: the most-recent-mounted overlay is on top; Esc closes the topmost one.

Design:

- If the user opens `/workflows` while conductor's overlay is up: workflows mounts on top. Esc returns to conductor.
- If the user opens conductor's overlay while `/workflows` is up: conductor mounts on top. Esc returns to workflows.
- Both overlays unsubscribe from events on `done()`, so events don't double-render.

See §15.D for the locked recommendation on `ctx.ui.custom` nesting (verified to support push/pop ordering; if not, we fall back to a close-other policy with a one-line warning).

### 10.9 No overlay in non-TTY mode

In `pi -p` and SDK modes, `ctx.ui.custom` is unavailable. `/workflows` falls back to **printing the runs table to the conversation** (same content as the runs list view but as plain text). `/<workflow>` invocation works fine in non-TTY — it returns when the run completes (we await the run promise instead of fire-and-forget when there's no TUI to subscribe).

---

## 11. Package layout

### 11.1 Directory tree

```
pi-workflows/
  package.json
  tsconfig.json
  README.md
  PRD.md                              (this file)
  CHANGELOG.md
  LICENSE
  .gitignore
  .npmignore

  src/
    index.ts                          (default export: ExtensionAPI fn)
    config.ts                         (settings + env-var reader)
    registry.ts                       (workflow file discovery + hot-reload)
    runManager.ts                     (in-process state of all runs)
    runtime/
      sandbox.ts                      (vm.Context construction + freeze)
      runCtx.ts                       (the `ctx` object exposed to scripts)
      semaphore.ts                    (FIFO async semaphore)
      dispatcher.ts                   (pi --mode json -p invocation)
      cache.ts                        (cache.jsonl reader/writer)
      ledger.ts                       (ledger.jsonl writer)
      stdlib.ts                       (vote, consensus, retry, parallel, sleep)
      mockAgents.ts                   (--mock-agents fixture loader)
    commands/
      workflowCmd.ts                  (registers the dynamic /<name> handler)
      workflowsCmd.ts                 (/workflows, resume, gc, list, show, kill)
    ui/
      overlay.tsx                     (the ctx.ui.custom overlay tree)
      runsList.tsx
      phaseView.tsx
      agentDetail.tsx
      approvalDialog.tsx
      tuiPrimitives.ts                (shared cursor/box helpers)
    types/
      public.d.ts                     (re-exported as workflows.d.ts in dist)
      internal.d.ts
    util/
      hash.ts                         (sha256 helpers)
      paths.ts                        (~/.pi/agent/workflows/runs/...)
      jsonStream.ts                   (parses --mode json subprocess output)

  examples/
    codebase-audit/
      codebase-audit.js               (the bundled workflow, ~75 lines)
      README.md
    hello/
      hello.js                        (10-line trivial example)
      README.md
    parallel-translation/
      translate.js                    (showcases vote helper)
      README.md

  skills/
    pi-workflows-author/
      SKILL.md                        (skill teaching how to author workflows)

  tests/
    unit/
      sandbox.test.ts
      cache.test.ts
      semaphore.test.ts
      ledger.test.ts
      registry.test.ts
      hash.test.ts
      jsonStream.test.ts
    integration/
      runEndToEnd.test.ts             (uses --mock-agents)
      resumeAfterCrash.test.ts
      pauseResume.test.ts
      hotReload.test.ts
      approval.test.ts
      bundledWorkflow.test.ts
    security/
      prototypePollution.workflow.js
      functionConstructor.workflow.js
      asyncFunctionConstructor.workflow.js
      realmPierce.workflow.js
      timerEscape.workflow.js
      processEnvLeak.workflow.js
      networkViaFetch.workflow.js
      requireResolve.workflow.js
      dynamicImport.workflow.js
      runner.test.ts                  (drives all .workflow.js fixtures)
    fixtures/
      basic.workflow.js
      basic.fixtures.jsonl
      with-cache.workflow.js
      with-cache.fixtures.jsonl
      ...
    helpers/
      makeFakePi.ts                   (in-memory pi runtime stub)
      makeRunDir.ts                   (tmpdir setup/teardown)

  docs/
    authoring.md                      (long-form author guide)
    api-reference.md                  (autogen from public.d.ts)
    integration-testing.md            (how to write workflow tests)
    parity-gaps.md                    (CC-vs-pi-workflows callout)
    threat-model.md                   (mirror of §8)

  dist/                               (built output, .npmignore'd from source)
    index.js
    index.d.ts
    workflows.js                      (no-op stub for type imports)
    workflows.d.ts                    (public type defs)
```

### 11.2 `package.json`

```json
{
  "name": "@samfp/pi-workflows",
  "version": "0.1.0",
  "description": "Dynamic workflows for pi — sandboxed JS scripts that drive sub-agent fleets, with TUI inspection and resume",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./workflows": { "types": "./dist/workflows.d.ts", "import": "./dist/workflows.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --external:@earendil-works/pi-coding-agent --external:typebox",
    "build:types": "tsc -p tsconfig.types.json --emitDeclarationOnly",
    "test": "node --import tsx --test tests/unit/*.test.ts tests/integration/*.test.ts tests/security/*.test.ts",
    "test:unit": "node --import tsx --test tests/unit/*.test.ts",
    "test:integration": "node --import tsx --test tests/integration/*.test.ts",
    "test:security": "node --import tsx --test tests/security/runner.test.ts",
    "prepublishOnly": "npm run build && npm test"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "^0.34.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^1.4.0",
    "@types/node": "^22.0.0",
    "esbuild": "^0.24.0",
    "tsx": "^4.0.0",
    "typebox": "^0.34.0",
    "typescript": "^5.5.0"
  },
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills": ["./skills/pi-workflows-author/SKILL.md"],
    "workflows": ["./examples/codebase-audit/codebase-audit.js"]
  },
  "files": [
    "dist/",
    "examples/",
    "skills/",
    "docs/",
    "README.md",
    "PRD.md",
    "LICENSE"
  ]
}
```

Key notes:

- `peerDependencies`: `@earendil-works/pi-coding-agent` is `"*"` per `docs/packages.md` (pi-core packages float on the user's installed version). `typebox` is pinned to `^0.34.0` because the `*` rule applies only to pi-core packages — third-party peers should pin a real range. **Not** pi-conductor's `^x.y.z` deviation on the pi-core peer; that's a known issue in conductor.
- `pi.workflows` is a proposed manifest extension; if pi's installer doesn't support it yet, fallback is the `installBundled` setting (§9.4).
- `pi.skills` ships an authoring skill so users can ask pi to write workflows for them.
- `type: module` because the runtime's sandbox loader handles ESM-style `export default`. The extension itself is ESM.
- `external` in esbuild config keeps pi's API as a runtime peer.

### 11.3 `tsconfig.json`

Baseline (extends a `tsconfig.base.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "lib": ["ES2022"]
  },
  "include": ["src/**/*"],
  "exclude": ["tests", "examples", "dist"]
}
```

A separate `tsconfig.test.json` includes `tests/` for `tsx` to consume.

### 11.4 Build via esbuild ESM

Bundle target is **single-file ESM** for the extension entry. Why bundle:

- pi's extension loader handles single files cleanly.
- Reduces install footprint on `npm:` install.
- Keeps internal module names from leaking into pi's resource namespace.

The `workflows.d.ts` / `workflows.js` type stub is **not bundled** — it's a separate small file authors `import`. The runtime stub `workflows.js` is literally `export {}` (no-op).

### 11.5 Test runner

`node:test` + `tsx`. Why:

- Zero extra deps.
- Native to the Node version pi targets.
- Same setup as `pi-conductor`.
- Plays nicely with `tsx` for TS tests.

### 11.6 npm scope and publishing

Published as `@samfp/pi-workflows`. Pi's installer accepts `npm:@samfp/pi-workflows` per `docs/packages.md`. See §15.E for the npm-scope question (recommendation: `@samfp` for v1; revisit only if a `@pi-community` umbrella materializes).

---

## 12. Test strategy

### 12.1 Test pyramid

| Layer | Where | Coverage |
|---|---|---|
| Unit | `tests/unit/` | Sandbox isolation, cache key derivation, semaphore correctness, ledger reconstruction, hash determinism, JSON-stream parsing. |
| Integration | `tests/integration/` | End-to-end workflow runs via `--mock-agents`, resume-after-crash, pause/resume, hot-reload, approval flow, bundled workflow. |
| Security | `tests/security/` | Hostile-workflow fixtures asserting sandbox holds. Run as part of CI; failure blocks release. |
| Manual smoke | (not in CI) | Real-world `/codebase-audit` against a real repo, observed via `/workflows` overlay. |

### 12.2 Unit tests

#### 12.2.1 `sandbox.test.ts`

- `vm.Context` exposes only the curated globals.
- `Object.prototype` is frozen; assignment throws.
- `process.env` stub is empty.
- `require`, `import()`, `fs`, `child_process`, `net`, `http` are all undefined.
- A passed-in host-realm value (e.g. an Error) does not leak its constructor.

#### 12.2.2 `cache.test.ts`

- Cache key for identical `(workflow, phase, agent)` triple is identical.
- Changing the script source changes the key (workflow_version contribution).
- Changing `cacheKeyExtra` changes the key.
- `delete` removes keys.
- Compaction at 1000 entries produces a single-snapshot file.
- Reading a corrupt JSONL line emits a warning and skips.

#### 12.2.3 `semaphore.test.ts`

- Cap of N admits at most N concurrent acquires.
- FIFO ordering when over cap.
- AbortSignal rejects waiters.
- Release without acquire is a no-op (defensive).
- Cap-of-zero blocks all acquires until raised.

#### 12.2.4 `ledger.test.ts`

- Ledger is append-only; concurrent writes serialize via mutex.
- Reading a ledger reconstructs the latest state correctly for each ledger-entry type.
- Crashed ledger (file not closed) is still readable.
- Each `transition` entry is well-formed and consecutive transitions are valid per the state machine.

#### 12.2.5 `registry.test.ts`

- Project workflows override personal on name collision.
- Reserved names are skipped with warnings.
- Filename validation rejects bad names.
- Hot-reload picks up new files within 100ms of fs change.

#### 12.2.6 `hash.test.ts` & `jsonStream.test.ts`

- sha256 of identical input is identical (sanity).
- JSON-stream parser handles incremental delivery, escape sequences, embedded newlines, and final-result extraction.

### 12.3 Integration tests

All integration tests use `--mock-agents` mode. Each test:

1. Creates a tmpdir with a `.pi/workflows/` subdir.
2. Drops a fixture workflow JS file.
3. Drops a `fixtures.jsonl` with canned agent responses keyed by `(agentId, promptHash)`.
4. Spawns the extension under a fake-pi harness (`makeFakePi.ts`).
5. Invokes the workflow via the harness's slash-command dispatcher.
6. Asserts on ledger content, result, side effects.

#### 12.3.1 `runEndToEnd.test.ts`

- A 3-phase workflow with 5 agents in phase 2 runs to completion.
- Result is delivered to the harness's `pi.sendMessage` mock.
- Ledger contains the expected sequence of state transitions.
- All agent transcripts are written under `agents/`.

#### 12.3.2 `resumeAfterCrash.test.ts`

- Run a workflow until phase 2/3 (force a crash mid-run by aborting the harness).
- Re-instantiate the harness; call `/workflows resume <runId>`.
- Assert that previously-completed agents are served from cache, only the remaining agent runs.
- Final result matches a non-crashed run.

#### 12.3.3 `pauseResume.test.ts`

- Mid-run, send a pause signal.
- No new agents start while paused.
- Resume; remaining agents run.
- State machine traversal: `running → paused → running → done`.

#### 12.3.4 `hotReload.test.ts`

- A workflow file is added; assert the slash command becomes available within 200ms.
- The file is modified; assert new invocations use the new script (a flag in the new script that wasn't in the old).
- The file is deleted; assert the slash command is unregistered.
- An in-flight run during a file modification continues with the **original** script.

#### 12.3.5 `approval.test.ts`

- First run prompts for approval (the harness's confirm dialog mock records the call).
- `[A]` adds to settings; second run skips prompt.
- `--bypass-permissions` env skips prompt.
- `[N]` cancels; state ends `cancelled-pre-run`.

#### 12.3.6 `bundledWorkflow.test.ts`

- Run `/codebase-audit` in mock mode against a fixture repo.
- Mock fixtures supply canned agent responses for recon, analyze, vote, summarize.
- Assert final result has the expected shape (`{ runId, top10, report }`).
- Assert at least one cache hit when run twice.

### 12.4 Security tests

Driven by `tests/security/runner.test.ts`. For each `*.workflow.js` fixture:

1. Load it as a real workflow under a controlled harness.
2. Run with `--mock-agents` and **no** fixtures (sub-agents are stubbed to return empty).
3. The script's job is to **try** to escape the sandbox.
4. The test asserts:
   - The script either threw inside the sandbox **or** completed without escaping.
   - The host's `globalThis` is unchanged (no prototype pollution leaked).
   - No host file was read or written outside the run dir.

The security suite runs in CI on every PR. **Any new escape vector found in the wild must be added here as a regression test.**

### 12.5 TUI tests — known gap

Pi has no documented snapshot-test harness for `ctx.ui.custom` overlays. We **do not** ship automated TUI tests in v1. Instead:

- `tests/integration/overlay.smoke.ts` is a manual harness that opens the overlay against a fake run with synthetic events. Tester verifies: layout, hotkeys, navigation. Listed in `docs/integration-testing.md` as a release-checklist item.
- See §15.F: if pi adds a TUI snapshot harness, port the overlay to it.

Flagged honestly in README under "Known gaps."

### 12.6 Coverage targets

| Component | Line coverage target |
|---|---|
| `src/runtime/` | 90% |
| `src/commands/` | 80% |
| `src/registry.ts`, `src/runManager.ts` | 85% |
| `src/ui/` | excluded from coverage (no test harness) |

Measured via `c8` (Node-native coverage), output to `coverage/` (gitignored).

### 12.7 CI integration

`prepublishOnly` runs `build && test`. CI (GH Actions or equivalent) runs `npm test` on push. **Any** test failure blocks publish. Security-suite failures are not flaky-allowed.

### 12.8 Manual smoke procedure

Documented in `docs/integration-testing.md`. Steps:

1. `pi -e ./dist/index.js` from the repo root with the `examples/codebase-audit/codebase-audit.js` workflow installed.
2. `/codebase-audit audit the auth module` against a real medium-sized repo.
3. Observe `/workflows` overlay updates as agents run.
4. Use `p` then `r` to pause/resume; verify it works.
5. Kill pi mid-run; restart pi; `/workflows resume <id>`; verify resume-from-cache works.
6. Inspect the final report.

Release blocks if any step fails.

---

## 13. Migration / coexistence

### 13.1 With `pi-conductor`

| Concern | Behavior |
|---|---|
| Concurrency contention | Both extensions hold independent semaphores. **Combined parallelism may exceed each extension's individual cap.** Startup warning emitted when both are loaded. |
| Naming | `/<workflowName>` (workflows) vs. `ensemble_*` tools + `/conductor *` commands (conductor). No collisions. |
| Sub-agent backend | Both spawn `pi --mode json -p`. They don't share subprocess state, but each subprocess does inherit the same environment (no isolation between them aside from process boundaries). |
| Overlays | `/workflows` overlay vs. conductor's `Ctrl+G` focused-stream overlay. Push/pop via `ctx.ui.custom` (§10.8). |
| Personas vs. workflow agents | A workflow agent is *not* a persona. Workflow authors who want to invoke a conductor persona inside an agent must specify the system prompt manually (e.g. read `~/.pi/agent/conductor/personas/oracle.md` and pass it as `systemPrompt` to `ctx.agent`). A `ctx.persona(name, prompt, opts)` helper is **deferred to v2** — see §14 row 18. |

### 13.2 With `pi-essentials/subagent`

| Concern | Behavior |
|---|---|
| Tool naming | `subagent` (essentials) vs. workflow-internal `ctx.agent` (this extension's API). No collision — essentials' `subagent` is an LLM tool; `ctx.agent` is an author API. |
| Mental model | Essentials is fire-and-forget LLM-callable tools; workflows are script-driven. Different audiences, no overlap. |
| Process model | Both spawn `pi -p` subprocesses. No shared semaphore. |

No conflict. The two can coexist; documented in README.

### 13.3 With `pi-autoresearch`

Pi-autoresearch operates on git worktrees and runs experiments — a different domain from workflow scripts. No interaction. Documented as "orthogonal" in README.

### 13.4 With future pi features

If pi gains:

- A **TUI snapshot test harness** → backfill `tests/ui/`.
- A **per-tool permission API** → implement `acceptEdits` (§14, parity gap #3).
- A **prompt-augmentation hook** → implement `workflow` keyword auto-trigger (§14, parity gap #1).
- A **first-class web search tool** → reconsider `/deep-research` (§14, parity gap #4).
- A **subprocess sandboxing primitive** (e.g. `worker_thread` extension API) → reconsider sandbox model (§8.3.6).

Each is a v2 candidate, not a v1 commitment.

### 13.5 Naming disambiguation: "conductor workflow"

Users familiar with pi-conductor's chain shapes (e.g. `clarifier → designer → planner → builder`) sometimes call those "workflows." In the README we explicitly disambiguate:

> **"Workflow" in this extension = a JavaScript file that drives sub-agents via a script.**
> **"Workflow" in pi-conductor docs = a multi-persona orchestration shape, executed by the LLM turn-by-turn.**
>
> These are different primitives at different layers. A pi-workflows file *can* invoke conductor personas as sub-agents, but doesn't replace conductor's chains.

### 13.6 Migration path for existing users

No migration needed. This is a new package. Existing pi-conductor and pi-essentials/subagent users install pi-workflows alongside; nothing changes for their existing workflows.

Users who want to *port* a Claude Code dynamic workflow to pi: there is no automated tool. The author API is **similar in spirit** but not identical (different `ctx` shape, different sub-agent dispatch). `docs/parity-gaps.md` documents the diff line by line for each CC API.

### 13.7 Workflows are not transitively spawnable

A workflow's sub-agent is a `pi -p` subprocess, which inherits the parent's allowlist and (in the bypass-pass-through case) `--bypass-permissions`. Without guards, that child could itself invoke `/<workflowName>` and recursively spawn more workflows — a fork-bomb shape.

**v1 explicitly forbids transitive workflow spawning.** The dispatcher (§5.5) sets two env vars on every spawned child:

- `PI_DISABLE_WORKFLOWS=1` (hard kill switch — the extension exits at load).
- `PI_WORKFLOWS_RECURSIVE=1` (defense-in-depth — if env-loss occurs, the extension still loads but skips `registerCommand`).

In nested pi sessions, `/<workflowName>` invocations error with `"workflows are disabled in nested pi sessions"` and `/workflows` is hidden from the overlay menu.

**Parity note:** CC's behavior on transitive workflows is not publicly documented. We believe it is also non-recursive (their similar dispatcher pattern), but we don't claim parity here. Documented as parity gap #19 in §14.

---

## 14. Known parity gaps from Claude Code

This section is the canonical source for what we **don't** match, and why. Mirrored in `docs/parity-gaps.md` so users can find it without reading this PRD.

| # | CC feature | Gap | Reason | v2 candidate? |
|---|---|---|---|---|
| 1 | `workflow` keyword natural-language trigger | Pi has no slash-command-augmenting prompt hook. Only explicit `/<name>` works. | No prompt-augmentation API in pi v1. | Yes — if pi adds the hook. |
| 2 | `/effort ultracode` integration (workflows triggered by effort tier) | No equivalent surface in pi. | CC-internal effort hooks not exposed. | Probably never — pi has no effort tier. |
| 3 | Per-agent `acceptEdits` permission elevation | Approval gates the **whole run**, not per agent. Sub-agents inherit parent allowlist verbatim. | No per-tool elevation primitive in pi v1. **Locked v1 decision** (formerly tracked as open question 15.5): not pursued in v1; revisit only if pi-coding-agent adds the primitive. | Yes — if pi adds the primitive. |
| 4 | `/deep-research` bundled workflow | Replaced with `/codebase-audit`. | Pi's web search is DDG-fallback grade; shipping a degraded copy would mislead users. | Yes — if pi adds first-class web search. |
| 5 | `agent-memory/` shared memory directory | Out of scope. | CC-specific surface; authors can use `ctx.cache` or pass through script vars. | Probably no — cache is sufficient. |
| 6 | `alt+w` workflow-mode keyboard shortcut | Not implemented. | CC-internal mode toggle. Pi's `/workflows` slash command serves discoverability. | No. |
| 7 | Cross-workflow composition (workflow calling workflow) | Each workflow is its own run. | v1 simplicity. v2 might add `ctx.invoke("<name>", input)`. | Yes. |
| 8 | Hot-swap script during a run | New invocations pick up the new script; in-flight runs use the original. | Bit-exact resume requires script immutability per-run. | No — deliberate. |
| 9 | Per-step user input prompts inside a workflow | Workflows are non-interactive once started. Use `finishCallback` to hand back to the LLM. | Interactive prompts inside a sandboxed background script complicate the TUI model. | Maybe — needs design. |
| 10 | Workflow files written in TypeScript | JS only in v1. | TS requires a transpilation step the sandbox doesn't run. Authors can compile externally. | Yes — ship a `tsx`-style loader. |
| 11 | Per-agent custom tools | Sub-agents inherit the parent's full tool set. | No tool-allowlist API for child sessions. | Yes — if pi adds the API. |
| 12 | Real-time TUI streaming of sub-agent thinking | Live tail in agent detail view shows JSONL transcript. | Pi's `--mode json` produces a transcript stream we can tail; we render it raw. CC has a richer streaming UI we don't replicate. | Maybe — nice-to-have, not blocking. |
| 13 | Cost / usage accounting per workflow | Per-agent usage in result; aggregated in ledger. No top-level summary view. | v1 scope. | Yes — add to the runs-list overlay. |
| 14 | Parallel-run shared semaphore with conductor | Each extension has its own. | No shared-state IPC primitive. | If a shared-state pi primitive lands. |
| 15 | Per-workflow effort/model defaults via frontmatter | Authors specify via `ctx.agent` opts; no JS file frontmatter. | JS files don't naturally have YAML frontmatter; comment-as-frontmatter is fragile. | No — the API surface is sufficient. |
| 16 | `pi -p` unconditionally bypasses approval | **Stricter:** `pi -p` bypasses approval **only if** `(absPath, sourceSha256)` is already trusted. First-run under `-p` errors. | Adversarial-context attack: poisoned README induces an LLM in `-p` to invoke a workflow with full bypass. Trust-on-bytes makes the bypass require explicit prior interactive approval. | No — deliberate hardening, not a gap to close. |
| 17 | Sync-loop wedge | A `while (true) {}` in a workflow wedges pi entirely; `x` cannot fire. | Pin 5 (`vm.Context`, no worker_threads). Author cooperation is the v1 mitigation. | Yes — if pi adds `worker_thread`-based extension primitive, revisit. |
| 18 | `ctx.persona(name, prompt, opts)` helper for conductor coexistence | Authors must read persona markdown manually and pass system prompt explicitly. | v1 scope; conductor doesn't expose a TS API for persona lookup, so the helper would re-implement parsing. 30 lines, but introduces a soft dependency on conductor's file layout. | Yes — if conductor coexistence becomes a marketed feature. |
| 19 | Transitive workflow spawning (workflow agents calling `/<workflow>` recursively) | **Forbidden.** Sub-agent children have `PI_DISABLE_WORKFLOWS=1` + `PI_WORKFLOWS_RECURSIVE=1` set; any `/<workflow>` invocation errors. | Recursion bomb prevention; CC's behavior on this is undocumented. | Maybe — if a real use case emerges, design a depth-limit primitive. |

Nothing on this list is a **silent** gap. Each is documented and visible to users.

---

## 15. Open questions for the planner

These are **slicing-strategy** questions, not design questions. The design is settled; planner decides how to chunk it into builder slices.

### 15.1 v0.1 vs v1.0 cut

What's the minimum-viable v0.1 we ship to get user feedback? Candidates:

- **Slim v0.1:** registry + `/<name>` + dispatcher + cache + ledger + a single `/codebase-audit` example. No overlay (just `pi.sendMessage` summaries). No resume. No pause. Approval as a plain `ctx.ui.confirm`.
- **Medium v0.1:** above + overlay (runs list only, no phase view) + pause/resume.
- **Full v1.0:** everything in this PRD.

Q: which v0.1 do we ship first?

### 15.2 Sandbox + dispatcher: one slice or two?

The `vm.Context` sandbox and the `pi -p` dispatcher are both load-bearing and tightly coupled by the agent invocation path. They could be:

- **One slice:** "runtime core" — sandbox + dispatcher + cache + ledger + state machine. Big slice, but it's a coherent unit and individual sub-pieces don't ship value alone.
- **Two slices:** sandbox + a stub dispatcher first (returns canned responses); real dispatcher second.

Q: planner picks. The two-slice path is friendlier for review but doubles the integration surface.

### 15.3 Bundled workflow: when does it land?

The `/codebase-audit` reference workflow exercises every API surface (phases, parallel agents, vote, cache, log). It's also the load-bearing demo. Should it land:

- **Early** (slice 2 or 3): drives API design under real use, even if the dispatcher is mocked.
- **Late** (last slice before release): the API is settled by then; the workflow is the capstone.

Q: planner picks. Recommendation: early-as-test-fixture, late-as-shipped-example.

### 15.4 TUI overlay: incremental or atomic?

The overlay has three views (runs list, phase view, agent detail). They share a `ctx.ui.custom` mounting model but are independent renderers.

- **Incremental:** runs list first, phase view second, agent detail third. Each is a slice.
- **Atomic:** all three together; smaller integration burden but bigger PR.

Q: planner picks.

### 15.5 _(removed — `acceptEdits` parity gap is now §14 row 3; v1 does not pursue.)_

### 15.6 _(removed — TS-transpiled workflows; locked as JS-only v1, see §14 row 10.)_

### 15.7 _(removed — `[A]` scope detection is locked: detect by source path, see §7.3.)_

### 15.8 GC auto-policy

§6.7: GC is manual. Q: at what disk-usage threshold do we change to auto-on-startup? Recommendation: defer to v2 unless users complain.

### 15.9 `pi:` manifest field for `workflows`

§9.4: `pi.workflows` is proposed; we haven't verified pi-coding-agent's installer supports it. Planner should land this in slice 1 by either (a) verifying pi supports it, or (b) implementing the fallback `installBundled` setting (default true) that the extension itself reads at startup and copies bundled workflows on first load.

### 15.10 _(removed — `ctx.persona` helper deferred to v2, see §14 row 18.)_

---

## 15.A LLM-judged consensus (forwarded from §4.2.6)

**Question:** should `ctx.consensus` use string-similarity bucketing (current v1) or an LLM judge?

**Options:**
- **String similarity (Jaccard over tokenized words).** Cheap, deterministic, works without spawning another agent. Crude on technical text ("the bug is in `auth.ts`" vs. "check `src/auth.ts` for the bug" don't bucket together).
- **LLM judge.** Spawn one extra agent that reads the N responses and decides if they agree. Expensive, non-deterministic, but semantically correct.

**Recommendation:** string similarity for v1; document the limitation in the helper's JSDoc and let authors fall back to manual `ctx.agent(judgePrompt, ...)` if they need semantic consensus. Revisit in v2 if a clear pattern emerges.

## 15.B Bypass pass-through configurability (forwarded from §7.5)

**Question:** should `--bypass-permissions` pass-through to sub-agents be configurable, or always-on?

**Options:**
- **Always-on (v1 default).** Matches CC. If the user opted into bypass at the parent, sub-agents inherit. Surprising but documented.
- **Configurable** via a `pi-workflows.passBypassToSubagents` setting. More verbose; arguably the right default in security-sensitive environments.

**Recommendation:** always-on for v1; add the setting in v2 if users request it. The case for configurability is real but is a v1 distraction.

## 15.C `s` save-script project-root detection (forwarded from §10.7)

**Question:** how does the `s` hotkey detect that the user has a project root to save into?

**Locked recommendation:** walk up from `cwd` looking for `.git/` or `.pi/`; if neither found within 8 directory levels, abort with `"no project root found; cannot save script"`. Same heuristic pi itself uses to find project-scope settings, so behavior is consistent. Builders can tune the depth limit if 8 turns out wrong.

## 15.D `/workflows` overlay nesting (forwarded from §10.8)

**Question:** does `ctx.ui.custom` support nesting (push/pop), and if not, what fallback?

**Recommendation:** verify in slice 1 that `ctx.ui.custom` supports nested mounts (multiple overlays stacked). If yes, push/pop is the v1 model. If no, fallback is **close-other**: opening `/workflows` closes any other overlay first, with a one-line message `"closed conductor overlay to open /workflows"`. Either way, builder slice 1 must produce a definitive answer; this is a small experiment, not a multi-day investigation.

## 15.E npm scope (forwarded from §11.6)

**Question:** publish under `@samfp` or wait for a `@pi-community` umbrella?

**Locked recommendation:** publish under `@samfp/pi-workflows` for v1. If a community scope materializes, transfer is straightforward (npm package transfers + a deprecation notice on the old name). Don't block v1 on a non-existent umbrella.

## 15.F TUI snapshot harness (forwarded from §12.5)

**Question:** if pi adds a snapshot test harness for `ctx.ui.custom`, do we backfill?

**Locked recommendation:** yes — backfill at first opportunity. The overlay is the most-visible surface and the riskiest area without automated tests. Tracked as a v2 task; manual smoke procedure (§12.8) covers v1.
