# Known Bugs

Tracked bugs that haven't been filed as GitHub issues yet. Fixed bugs are marked **✅ FIXED**.

---

## BUG-W10 ✅ FIXED — `jsonStream`: pending buffer has no size cap — OOM on very long line from subprocess

**Discovered:** 2026-06-01  
**Severity:** Medium — Node.js heap exhaustion on subprocess emitting a line with no newline (multi-hundred-MB payload or deliberate garbage)

### Description

`pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])` grew the in-memory
line buffer without bound until a `0x0A` byte was found. `TRUNCATED_REGION_MAX` only capped
error-message excerpts, not the accumulation itself. A subprocess emitting a huge line (or
never emitting a newline at all) could consume all available heap before `JSON.parse` was
ever called.

### Fix

Added `MAX_LINE_BYTES = 64 MiB` constant. Before each `Buffer.concat` the guard checks
`pending.length + buf.length > MAX_LINE_BYTES`; if exceeded it throws a `JsonStreamError`
with `reason: "parse"`, the line number, byte offset, and a 256-byte excerpt of the start
of the oversized line. This stops accumulation at a safe threshold without affecting any
realistic pi JSON event.

---

## BUG-001 ✅ FIXED — `await ctx.agent()` silently returns a handle without spawning

**Discovered:** 2026-05-30  
**Severity:** High — silent data loss, no error thrown

### Description

`ctx.agent(prompt)` is synchronous and returns an `AgentHandle`. It does **not** spawn
anything. Calling `await ctx.agent(prompt)` resolves immediately with the handle — the
agent never executes and no error is thrown.

```js
// BROKEN — synthesis agent never runs, result is the handle object
const synthesis = await ctx.agent("Summarize everything...");
return synthesis.text; // undefined — no agent ran
```

### Expected behaviour

Either:
- `ctx.agent()` should throw (or return a rejected promise) when awaited directly without
  going through `ctx.phase()`, with a message like:
  `"AgentHandle is not awaitable. Use ctx.phase('name', [handle]) to run agents."`, or
- the docs/promptSnippet should make the constraint impossible to miss.

### Workaround

Always wrap in `ctx.phase()`, even for a single agent:

```js
// CORRECT
const [synthesis] = await ctx.phase("synthesize", [
  ctx.agent("Summarize everything..."),
]);
return synthesis.text;
```

### Root cause

`AgentHandle` has no `then` property, so `await handle` resolves immediately to the
handle itself. JavaScript does not distinguish between "intentional await of a plain
object" and "mistaken await of a non-promise."

### Suggested fix

Make `AgentHandle` a thenable that throws on `.then()`:

```ts
get then() {
  throw new Error(
    "AgentHandle is not awaitable. Use ctx.phase('name', [handle]) to run agents."
  );
}
```

This turns a silent bug into an immediate, descriptive error.

### Fix Applied

`src/runtime/sandbox.ts` — `__pi_build_ctx` now wraps `ctx.agent` to install a `then` getter
on every returned handle that throws `TypeError: AgentHandle is not awaitable` immediately,
turning the silent failure into an immediate descriptive error.

---

## BUG-002 ✅ FIXED — `ctx.phase()` throws `AggregateError` on any agent timeout, killing the whole workflow

**Area:** runtime-api  
**Severity:** High — one slow agent kills all results from the other agents  
**Location:** `src/runtime/runCtx.ts`, `docs/runtime-api.md`  
**Discovered:** 2026-05-30  

### Description

When any agent in a `ctx.phase()` call times out (exit code 143, SIGTERM), the phase throws
an `AggregateError` and all results from the other agents are discarded. Workflow authors
have no way to recover partial results without opting into `failMode: 'null'`.

The default behaviour of failing the entire phase on any single agent failure is surprising
and not clearly documented. Authors writing fan-out workflows (8 parallel agents, etc.) will
routinely lose all work if one agent takes too long.

### Suggested Fix

- Document `failMode: 'null'` prominently in the runtime-api.md and promptSnippet as the
  recommended default for fan-out phases.
- Consider making `failMode: 'null'` the default, or at minimum warning at phase-start if
  more than 3 agents are running without `failMode: 'null'` set.

### Fix Applied

`src/runtime/runCtx.ts` — when `ctx.phase()` is called with ≥3 agents and `failMode` is
the default `'throw'`, a `warn`-level ledger entry is written before the phase starts,
surfacing the risk in `/workflows` and in log tails. The `hunt-bugs` workflow also switched
to `failMode: 'null'` as a demonstration of the recommended pattern.

---

## BUG-003 ✅ FIXED — Dispatcher: signal-killed process (timeout/abort) misclassified as MalformedAgentOutputError

**Area:** dispatcher
**Severity:** high
**Location:** dispatcher.ts:493 — failure classification block (`if (exitCode !== 0 && exitCode !== null)`)
**Discovered:** iteration-1

### Description

When a child process is killed by a signal — either from the timeout handler (SIGTERM after 600s) or from the AbortSignal `onAbort` handler — the node `exit` event fires with `exitCode = null` and `exitSignal = 'SIGTERM'`. The failure-classification block at the bottom of `dispatchAgent` checks `exitCode !== 0 && exitCode !== null`, which is `false` when `exitCode === null`. Execution falls through to `throw new MalformedAgentOutputError(...)` with `reason = 'empty-stdout-failure'`. The `signal` field of `AgentSubprocessError` — which was designed exactly for this case — is never populated. Callers (e.g., the retry/ledger path in runCtx) see a malformed-output error where they should see a subprocess-kill error, making timeout kills undetectable from genuine corrupt output.

### Suggested Fix

Add a guard for the signal-killed case before the existing exit-code check:
```ts
if (exitSignal !== null) {
  throw new AgentSubprocessError({ agentId: opts.agentId, exitCode, signal: exitSignal });
}
if (exitCode !== 0 && exitCode !== null) {
  throw new AgentSubprocessError({ agentId: opts.agentId, exitCode, signal: exitSignal });
}
```
Or fold both into one condition: `exitCode !== 0 && exitCode !== null || exitSignal !== null`.

---

## BUG-004 ✅ FIXED (duplicate) — Dispatcher: timeout sends SIGTERM with no SIGKILL escalation — can hang forever

**Area:** dispatcher
**Severity:** medium
**Location:** dispatcher.ts:363-371 — `setTimeout` timeout handler
**Discovered:** iteration-1

### Description

The 600 s (default) timeout handler calls `child.kill('SIGTERM')` and does nothing else. The subsequent `await exitPromise` has no deadline. If the spawned `pi` process catches or ignores SIGTERM (e.g., a long-running tool call inside the sub-agent, or a stuck network call that never unblocks), `dispatchAgent` hangs indefinitely — blocking the semaphore slot, preventing pause/stop from progressing, and leaking the tee write-stream. The `timeoutMs` option is therefore not a reliable upper bound on dispatch duration.

### Suggested Fix

After sending SIGTERM, schedule a SIGKILL after a short grace period (e.g. 5 s):
```ts
const timeoutHandle = setTimeout(() => {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 5_000).unref();
}, timeoutMs);
```
Or store a `killHandle` reference and clear it alongside `clearTimeout(timeoutHandle)`.

---

## BUG-005 ✅ FIXED — ActiveRunsRegistry.reset() does not clear #everLocal, breaking test isolation

**Area:** activeRuns
**Severity:** low
**Location:** activeRuns.ts:373-377 — `reset()` method
**Discovered:** iteration-1

### Description

`reset()` is the test-seam that wipes all in-process state between test cases. It clears `#handles`, `#summaries`, and `#listeners` but leaves `#everLocal` untouched. Any `runId` registered via `register()` in a previous test will still return `true` from `wasLocalRun(runId)` in subsequent tests. Tests that assert the overlay's 'remote-only run — r/s disabled' path (which keys off `!wasLocalRun()`) will spuriously pass or fail depending on test order.

### Suggested Fix

Add `this.#everLocal.clear();` to `reset()`:
```ts
reset(): void {
  this.#handles.clear();
  this.#summaries.clear();
  this.#listeners.clear();
  this.#everLocal.clear(); // ← add this
}
```

---

## BUG-006 ✅ FIXED (duplicate) — resumeRun uses !TERMINAL_STATES for resumability, diverging from the exported RESUMABLE_STATES contract

**Area:** resumeRun / ledger
**Severity:** medium
**Location:** resumeRun.ts:247-260 — resumability check; ledger.ts:94 — RESUMABLE_STATES definition
**Discovered:** iteration-1

### Description

The exported `RESUMABLE_STATES` constant (the published contract, described as 'Resumable-after-pi-crash states') lists only `{ 'paused', 'running' }`. `resumeRun`'s check at line 248 is `!TERMINAL_STATES.has(finalState)`, which also admits `'pending'` and `'approved'` as resumable. The function even has tailored handling for both states (forcing them to `'running'` via direct ledger appends). Two consequences: (1) `RESUMABLE_STATES` is exported but never imported by `resumeRun`, making it dead as a contract guard; (2) any UI or slash-command caller that gates the resume button on `RESUMABLE_STATES.has(state)` would suppress the button for `pending`/`approved` runs, yet calling `resumeRun` directly would succeed — a confusing split. The `resumeRun` docstring also says the valid set is `{paused, running, failed(parent-crash)}`, making the `pending`/`approved` paths undocumented.

### Suggested Fix

Either (a) extend `RESUMABLE_STATES` to include `'pending'` and `'approved'` and update the docstrings to match, making the behavior explicit and the constant accurate; or (b) change the `resumeRun` check to `RESUMABLE_STATES.has(finalState) || (finalState === 'failed' && ...)` and remove the `pending`/`approved` branches as unsupported paths with an explicit `ResumeNotAllowedError`. Option (a) is likely correct since the implementation code for those cases already exists and is functional.

---

## BUG-007 ✅ FIXED — dispose() leaks phase subscription, appendEntry shim, and agentDetailDebounceTimer

**Area:** overlay / TUI
**Severity:** high
**Location:** overlay.ts — makeOverlayComponent, component.dispose()
**Discovered:** iteration-1

### Description

The TUI component's `dispose()` method — called by pi-tui when it tears down the overlay externally — only calls `unsub()` and clears `renderTimer`. It does NOT call `unsubPhase()`, does NOT restore `opts.pi.appendEntry` to its pre-shim value, and does NOT clear `agentDetailDebounceTimer`. If pi-tui invokes `dispose()` without the user pressing Esc, the phase-registry subscription fires forever against a dead closure, the agent-log shim remains active on `opts.pi.appendEntry` pointing into garbage-collected state, and an in-flight debounce timer can fire after disposal. The `close()` function handles all of these correctly, but `dispose()` is a separate code path that does not delegate to it.

### Suggested Fix

Extract the cleanup body of `close()` into a shared `cleanup()` helper (guarded by a `let cleaned = false` flag for idempotency). Call `cleanup()` from both `close()` and `dispose()`. The guard prevents double-unsubscription when the user presses Esc and pi-tui also fires `dispose()`.

### Fix Applied

`cleanup()` helper extracted in the BUG-001/010 batch fix (df3e993) with `let cleaned = false` idempotency guard — covers `renderTimer`, `agentDetailDebounceTimer`, `appendEntry` shim restore, `unsub()`, and `unsubPhase()`. `dispose()` updated to call `close()` (which calls `cleanup()`) in BUG-072 fix (d5d87df) so `opts.done()` also fires and `_overlayOpen` is cleared. Regression tests added: `BUG-007: dispose() cleans up phase subscription, appendEntry shim, and debounce timers` and `BUG-007: cleanup() is idempotent`.

---

## BUG-008 ✅ FIXED (duplicate) — GC F4 filter checks the wrong direction: reads candidate's restartedFrom instead of active runs' restartedFrom

**Area:** gcDialog
**Severity:** medium
**Location:** gcDialog.ts — loadGcCandidates, the safeCandidates filter block (~line 80)
**Discovered:** iteration-1

### Description

The intent documented in the PRD comment is: *do not GC run A if a currently-active run B was spawned by restarting A* (B's manifest carries `restartedFrom = A.runId`). The current code does the opposite — it reads *candidate C's* `manifest.restartedFrom` field and skips C if the thing C was restarted FROM is active. That protects the restart-child (C, which is terminal and a valid GC target) rather than protecting the source run (A, whose data the active restart-child B may still reference). In the scenario that needs protection — A is terminal and GC-eligible, B is the active restart of A — nothing in the current filter excludes A from deletion because A's manifest has no `restartedFrom` entry at all.

### Suggested Fix

Build a reverse-lookup set from the active runs: for each active run, read its manifest and collect `restartedFrom` values into a `Set<string> protectedSources`. Then filter candidates with `!protectedSources.has(c.runId)` instead of checking the candidate's own manifest. This requires reading the active-run manifests once at dialog-open time rather than the candidate manifests.

---

## BUG-009 ✅ FIXED (duplicate) — phaseCursor bounded by totalAgents (all phases) but only running-phase agent rows are rendered, causing phantom cursor movement and wrong Enter target

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — handleAction 'navigate-down' (phase-view branch) and 'open-agent-detail' branch
**Discovered:** iteration-1

### Description

In the `navigate-down` handler for `phase-view`, the upper bound is `snap.totalAgents - 1` — the global agent count across all phases. But `renderPhaseView` only emits `agentRows` entries for the single *running* phase; agents in done and pending phases are omitted. Consequently, the cursor can advance well past the last visible row with no visual feedback (the highlight just disappears). Worse, `open-agent-detail` resolves the target by `flatMap`-ing ALL phases' agents and indexing by `phaseCursor`. If `phaseCursor` has advanced into the done-phase portion of the flat list, pressing Enter opens agent-detail for an agent the user never visually selected.

### Suggested Fix

Use `agentRows.length` (from a fresh `renderPhaseView` call or a cached count) as the exclusive upper bound for `phaseCursor`, not `totalAgents`. The `open-agent-detail` handler should also index into the rendered `agentRows` array rather than the full flatMap of all phases, to keep the two in sync.

---

## BUG-010 ✅ FIXED — isHotkeyEnabled returns false for p and x on phase-view but dispatchHotkey fires pause/stop actions

**Area:** hotkeys
**Severity:** low
**Location:** hotkeys.ts — isHotkeyEnabled, cases 'p' and 'x'
**Discovered:** iteration-1

### Description

`isHotkeyEnabled` gates `p` and `x` with `if (input.view !== 'runs-list') return false`, making them appear disabled on phase-view. However `dispatchHotkey` has no such view guard for these keys — it dispatches `pause`, `resume`, or `stop` based purely on `runState`. `helpForState` for phase-view explicitly lists `p` and `x` as valid (conditionally enabled) entries, which matches the dispatcher's behaviour but contradicts `isHotkeyEnabled`. Any caller (tests, external tooling) using `isHotkeyEnabled` to determine availability gets wrong answers for phase-view, and the grayed-out help hint shown to the user is misleading when state is running/paused.

### Suggested Fix

Remove the `if (input.view !== 'runs-list') return false` guards from the `p` and `x` cases in `isHotkeyEnabled` so they match the logic in `dispatchHotkey` and `helpForState`: enabled when `runState === 'running'` or `runState === 'paused'`, regardless of view.

---

## BUG-W01 ✅ FIXED — Workflow: hunt agents silently dropped when output is not bare JSON

**Area:** hunt-bugs-loop workflow  
**Severity:** Medium — bug findings silently lost, no user-visible error  
**Location:** `examples/hunt-bugs-loop/hunt-bugs-loop.js`, hunt phase parse loop  
**Discovered:** iteration-1  

### Description

Hunt agents frequently wrap their JSON output in markdown code fences
(` ```json ... ``` `) or add prose before/after the JSON object. The parse loop
strips fences with a regex but fails when agents emit prose like "Here are the
bugs I found:" before the JSON block. The result is silently discarded with a
generic `ctx.log("Could not parse hunt result")`. 4 of 6 agents were dropped in
iteration 1 — nearly all findings lost.

### Fix Applied

`examples/hunt-bugs-loop/hunt-bugs-loop.js` — `extractJsonFromText()` helper
added (inline in the main function body). Scans for the first `{` or `[`,
then walks forward tracking brace depth to extract the outermost balanced
JSON object/array. Handles markdown fences, leading prose, and trailing
content gracefully. Returns `null` (logged as warn) instead of silently
discarding. Also applied to `examples/codebase-audit/codebase-audit.js`
(recon, analyze, and voter output parsing).

---

## BUG-W02 ✅ FIXED — Workflow: fix agents run in parallel against the same worktree

**Area:** hunt-bugs-loop workflow  
**Severity:** High — concurrent edits to the same files cause conflicts and corrupt fixes  
**Location:** `examples/hunt-bugs-loop/hunt-bugs-loop.js`, fix phase  
**Discovered:** iteration-1  

### Description

All N fix agents run in parallel via `ctx.phase("fix-N", [...])` against the
same git working directory. If two bugs are in the same file (common), agents
race to read, edit, and write it — last writer wins, earlier fixes are silently
overwritten. The build gate may catch the corruption but by then the fixes are
lost and git history is a mess.

### Fix Applied

`examples/hunt-bugs-loop/hunt-bugs-loop.js` — Phase 3 uses `ctx.pipeline()`
instead of a flat `ctx.phase()` fan-out, dispatching each bug as an independent
item through the run semaphore. A `// BUG-W02 fix` comment block documents the
tradeoff and points authors toward the strictly-serial for-loop alternative
(or git-worktree isolation) for projects with high same-file bug density.

---

## BUG-013 ✅ FIXED (duplicate) — extractJson throws after agent_end ledger entry written and result cached — creates ledger inconsistency and permanent stuck-failure loop

**Area:** runtime/runCtx
**Severity:** high
**Location:** src/runtime/runCtx.ts — runOneAgent, cache-miss try block (~line 390-420): setAgentResult and ledger agent_end called before extractJson; cache-hit block (~line 330-360): agent_end logged but no catch around extractJson
**Discovered:** iteration-1

### Description

In runOneAgent (cache-miss path), opts.cache.setAgentResult and opts.ledger.append({type:'agent_end',...}) are both called BEFORE extractJson is invoked. If the agent returned malformed JSON, extractJson throws, which is caught by the surrounding try/catch and causes opts.ledger.append({type:'agent_error',...}) to also fire. The same agent now has both agent_end and agent_error in the ledger — a consistency violation. Worse: the cached result is retained. On the next run the cache-hit path is taken, which logs agent_end again and then calls extractJson on the same text, throws again, but this time there is NO catch block on the cache-hit path so agent_error is NOT appended. The ledger says the agent succeeded (agent_end present) but runOneAgent rejects, causing the phase to fail silently. This repeats on every run: the cached bad-JSON result is permanently stuck, the workflow can never proceed, and the ledger either over-reports both end+error (first run) or falsely reports success (all subsequent runs).

### Suggested Fix

Move extractJson call to BEFORE opts.cache.setAgentResult and opts.ledger.append({type:'agent_end'}). Only cache and log agent_end after JSON extraction succeeds. Alternatively, catch extractJson parse errors separately and surface them as a new MalformedSchemaOutputError without writing agent_end, so the agent is retryable rather than permanently cached.

---

## BUG-014 ✅ FIXED (duplicate) — Token budget check is not atomic — concurrent runOneAgent calls all pass the check before any updates budgetSpent, allowing large budget overruns

**Area:** runtime/runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts — runOneAgent, token budget check at function top before the semaphore acquire loop; budgetSpent update inside the try block after dispatch completes
**Discovered:** iteration-1

### Description

budgetSpent is a closure variable. The check 'if (tokenBudget !== null && budgetSpent >= tokenBudget)' and the update 'budgetSpent += result.usage.totalTokens' are not atomic. In a phase with N concurrent agents, all N calls to runOneAgent execute the guard before any of them finish and update budgetSpent. If budgetSpent is 0 and tokenBudget is 1000, all N agents pass the check simultaneously, each spending up to maxTokensPerAgent tokens. The actual spend can be N × maxTokensPerAgent — potentially an order of magnitude over budget with no rejection. The budget cap is effectively advisory-only for any multi-agent phase.

### Suggested Fix

Maintain a committed budget separate from spent budget. Before acquiring the semaphore, add the agent's estimated cost to a 'committed' counter and check committed+spent against the budget. On completion, move from committed to spent; on failure, subtract from committed. Alternatively, enforce the budget inside a serialized budget-manager object rather than a bare closure variable. Simplest fix: increment a 'reserved' counter atomically at the check site and use reserved+spent as the budget signal.

---

## BUG-015 ✅ FIXED (duplicate) — runtime-api.md documents RetryOpts.maxAttempts but implementation reads opts.attempts — authors using maxAttempts silently get default 3

**Area:** stdlib / docs
**Severity:** high
**Location:** src/runtime/stdlib.ts — retry() function: 'const rawAttempts = opts && typeof opts.attempts === 'number' ? opts.attempts : 3'; docs/runtime-api.md — RetryOpts interface listing maxAttempts
**Discovered:** iteration-1

### Description

runtime-api.md defines RetryOpts with 'maxAttempts?: number // default 3' and 'backoffMs?: number // initial backoff in ms (default 500)'. The stdlib implementation reads 'opts.attempts' (not 'opts.maxAttempts'). An author who reads the docs and passes { maxAttempts: 5, backoffMs: 2000 } will silently use 3 attempts with 100ms backoff instead of 5 attempts with 2000ms — no warning, no error. public.d.ts correctly uses 'attempts' so TypeScript users catch this, but JS workflow authors (the primary target) do not.

### Suggested Fix

Either (a) rename the implementation to read opts.maxAttempts and update public.d.ts to match the docs, or (b) update runtime-api.md to say 'attempts' not 'maxAttempts' and keep the implementation as-is. Read BOTH opts.attempts and opts.maxAttempts with maxAttempts taking priority during the transition to avoid silent breakage for any existing callers.

---

## BUG-016 ✅ FIXED (duplicate) — runtime-api.md documents ConsensusResult.scores field that does not exist — runtime TypeError for any author following the docs

**Area:** stdlib / docs
**Severity:** high
**Location:** docs/runtime-api.md — ConsensusResult interface and ConsensusOpts; src/runtime/stdlib.ts — consensus() return value; src/types/public.d.ts — ConsensusResult
**Discovered:** iteration-1

### Description

runtime-api.md defines ConsensusResult as '{ agreed: boolean; majorityText: string; scores: ReadonlyArray<{ agentId: string; meanSimilarity: number }> }'. Neither public.d.ts nor the stdlib implementation have a 'scores' field. The implementation returns '{ agreed, majorityText, responses }' where 'responses' is the raw array of agent text strings. An author who reads the docs and accesses result.scores[0].meanSimilarity will get a TypeError (cannot read properties of undefined). There is no runtime warning. Additionally, the docs-only 'similarity' field in ConsensusOpts (described as 'Jaccard floor per pair') is also absent from public.d.ts and silently ignored by the implementation.

### Suggested Fix

Update runtime-api.md to document the actual return shape: 'responses: ReadonlyArray<string>' instead of 'scores'. If per-agent similarity scores are genuinely desired, add them to the implementation and public types simultaneously with the docs update. Remove the undocumented 'similarity' opt or add it to both the implementation and public.d.ts.

---

## BUG-017 ✅ FIXED (duplicate) — consensus uses a single threshold for both Jaccard similarity floor and pair-fraction agreement — the docs describe two independent parameters but only one is implemented

**Area:** stdlib
**Severity:** medium
**Location:** src/runtime/stdlib.ts — consensus(): single 'threshold' variable used in both the Jaccard comparison and the ratio comparison; docs/runtime-api.md — ConsensusOpts documenting both threshold and similarity
**Discovered:** iteration-1

### Description

runtime-api.md describes two independent ConsensusOpts parameters: 'threshold' (fraction of pairs that must agree, default 0.5) and 'similarity' (Jaccard floor per pair, default 0.6). The implementation has a single 'threshold' (defaulting to 0.6) used for BOTH: 'if (sim >= threshold) crossed++' (Jaccard floor) and 'const agreed = ratio >= threshold' (pair fraction). The 'similarity' field is never read. Consequence 1: setting { threshold: 0.9 } for lenient fraction also makes the Jaccard floor 0.9 (very strict), so 'agreed' will almost always be false. Consequence 2: setting { threshold: 0.2 } for a low Jaccard floor also accepts only 20% of pairs needing to agree. The two-knob design intent is lost and the two concerns cannot be tuned independently.

### Suggested Fix

Split into two variables. Read 'opts.similarity' (default 0.6) for the Jaccard floor used inside 'if (sim >= similarity)'. Read 'opts.threshold' (default 0.5 per docs, or 0.6 to match current behavior) for 'const agreed = ratio >= threshold'. Add 'similarity?: number' to ConsensusOpts in public.d.ts.

---

## BUG-018 ✅ FIXED — failMode parsing in phase() is outside the try/catch block — adversarial opts can escape the RunCtxBridgeResult envelope

**Area:** runtime/runCtx
**Severity:** low
**Location:** src/runtime/runCtx.ts — phase() function, failMode const declaration before the try block (approximately line 170-175)
**Discovered:** iteration-1

### Description

In the phase() function, failMode is parsed from optsArg before the try block opens: 'const failMode = optsArg !== null && typeof optsArg === 'object' && (optsArg as Record<...>).failMode === 'null' ? 'null' : 'throw''. If optsArg is a Proxy (possible since it crosses the sandbox boundary) and its 'failMode' getter throws, the exception is NOT caught by the surrounding try/catch and does NOT produce a { ok: false, error } envelope. It propagates as an unhandled promise rejection, bypassing the error-reconstruction path in sandbox.ts and surfacing as an uncaught error to the script executor.

### Suggested Fix

Move the failMode parsing inside the try block so any access-time exception is captured by captureError() and returned as { ok: false, error }. Alternatively, JSON-clone optsArg before extracting failMode (the handles loop does this via JSON.parse(JSON.stringify(...)) — apply the same pattern to phase opts).

---

## BUG-019 ✅ FIXED (duplicate) — runtime-api.md documents retry default backoffMs as 500ms but implementation defaults to 100ms

**Area:** stdlib / docs
**Severity:** low
**Location:** src/runtime/stdlib.ts — retry() function backoffMs default; docs/runtime-api.md — RetryOpts.backoffMs comment
**Discovered:** iteration-1

### Description

runtime-api.md says 'backoffMs?: number; // initial backoff in ms (default 500)' inside RetryOpts. The stdlib.ts implementation uses 'const backoffMs = opts && typeof opts.backoffMs === 'number' && opts.backoffMs >= 0 ? opts.backoffMs : 100'. Authors relying on the documented default for rate-limit back-off scenarios will get 5× shorter delays than expected, likely triggering the same failures immediately.

### Suggested Fix

Either update the implementation default to 500ms to match the docs, or update the docs to say 100ms. Given that 500ms is more sensible as a default for retry scenarios (enough breathing room for transient API failures), updating the implementation to 500ms is preferred.

---

## BUG-020 ✅ FIXED (duplicate) — runtime-api.md documents consensus default threshold as 0.5 but implementation defaults to 0.6

**Area:** stdlib / docs
**Severity:** low
**Location:** src/runtime/stdlib.ts — consensus() function threshold default; docs/runtime-api.md — ConsensusOpts.threshold comment
**Discovered:** iteration-1

### Description

runtime-api.md documents ConsensusOpts.threshold as 'fraction of pairs that must agree (default 0.5)'. The stdlib.ts implementation defaults to 0.6: 'const threshold = opts && typeof opts.threshold === 'number' ? opts.threshold : 0.6'. Authors who rely on the undocumented default will get stricter consensus checks than the docs promise. Combined with BUG-015 (same threshold used for Jaccard floor), the discrepancy compounds: authors expect 50% of pairs to agree at the Jaccard level, but the actual behavior is 60% of pairs at a 0.6 Jaccard floor.

### Suggested Fix

Align to a single value. The docs say 0.5; the code says 0.6. Decide which is correct and update the other. If BUG-015 is fixed first (splitting into separate similarity/threshold params), the threshold default should be 0.5 (lenient fraction) and similarity default 0.6 (strict per-pair floor).

---

## BUG-021 ✅ FIXED (duplicate) — fireCtxAbort abort-listener never removed from host AbortSignal on non-abort completion

**Area:** sandbox
**Severity:** medium
**Location:** sandbox.ts, Sandbox.runScript(), ~line 700 — the hostSignal.addEventListener block has no corresponding removeEventListener in success or error paths
**Discovered:** iteration-1

### Description

In runScript(), hostSignal.addEventListener('abort', fireCtxAbort, { once: true }) is registered after the bind script runs. The { once: true } flag only removes the listener when the signal fires. On normal script completion (resolve) or non-abort rejection, raceWithAbort removes its own internal onAbort listener but never removes fireCtxAbort from hostSignal. If the Sandbox is driven by a long-lived or shared AbortSignal (e.g. a session-level controller), each runScript call leaks one listener. Additionally, if dispose() is called and then the signal fires later, signalAbortThunk is invoked into a Context whose timer bridge has been torn down, producing silent unexpected execution in a disposed context.

### Suggested Fix

Wrap the compile+run+raceWithAbort region in a try/finally that calls hostSignal.removeEventListener('abort', fireCtxAbort) unconditionally. Because { once: true } already self-removes on abort, the removeEventListener is a no-op in that case and safe to call.

---

## BUG-022 ✅ FIXED — __pi_build_ctx and __pi_make_signal left on globalThis throughout script execution — user code can create rogue ctx objects accessing the host bridge

**Area:** sandbox
**Severity:** high
**Location:** sandbox.ts, buildInitScript() — the globalThis.__pi_build_ctx and globalThis.__pi_make_signal assignments are permanent for the lifetime of the Context
**Discovered:** iteration-1

### Description

buildInitScript() assigns globalThis.__pi_build_ctx and globalThis.__pi_make_signal for the bind script (run via vm.runInContext before user code). After the bind, ctx is installed on globalThis.ctx and __pi_signal_pair__ is deleted, but __pi_build_ctx and __pi_make_signal are never removed before user code executes. A script can call globalThis.__pi_build_ctx(arbitraryMeta, arbitraryInput, anySignal) to obtain a second fully-wired ctx that wraps the exact same __runCtxHost bridge, enabling it to call ctx.agent(), ctx.phase(), ctx.log(), and ctx.cache.* outside the phase-tracking and ledger accounting of the higher-level runner. The rogue ctx's budget.spent() still reads the same counter, but untracked phase calls corrupt the run's agent-handle bookkeeping.

### Suggested Fix

After the bind script runs (and ctx is captured), run a small cleanup script via vm.runInContext that deletes globalThis.__pi_build_ctx and globalThis.__pi_make_signal. Store the factories in a host-side closure and re-inject them only at the START of the next runScript bind phase, before user code can observe them.

---

## BUG-023 ✅ FIXED — Init-script function declarations (wrapHostAsync, __pi_unwrap, etc.) become globalThis properties — user code can overwrite __pi_unwrap to bypass ctx method error handling

**Area:** sandbox
**Severity:** medium
**Location:** sandbox.ts, buildInitScript() — all function declarations at top level of the init script string become globalThis.* properties
**Discovered:** iteration-1

### Description

In buildInitScript(), wrapHostMethod, wrapHostAsync, wrapHostSync, __pi_clone_into_ctx, __pi_reconstruct_error, and __pi_unwrap are declared as top-level function declarations inside a vm script (not wrapped in an IIFE). In JavaScript, top-level function declarations in a script scope create enumerable, writable properties on globalThis. The returned closures from wrapHostAsync reference __pi_unwrap as a free variable resolved through the global scope at call time (not at definition time). User code can therefore do globalThis.__pi_unwrap = (x) => x.value before awaiting ctx.cache.get() or ctx.phase(), causing those calls to return the raw host-realm tagged envelope ({ok, value, error}) instead of the unwrapped value, silently suppressing error throws on host-side failures.

### Suggested Fix

Wrap all helper functions in an IIFE at the top of the init script: (function(){ function wrapHostAsync(...){...} ... globalThis.__pi_build_ctx = ...; }()). This makes the helpers closure-local and removes them from globalThis. The ctx method wrappers created inside the IIFE close over the IIFE-local (not global) references, so overwriting globalThis.wrapHostAsync or globalThis.__pi_unwrap from user code has no effect.

---

## BUG-024 ✅ FIXED — logSink accumulates across multiple runScript() calls on the same Sandbox instance

**Area:** sandbox
**Severity:** low
**Location:** sandbox.ts, Sandbox constructor (logSink init) and Sandbox.runScript() return statement
**Discovered:** iteration-1

### Description

this.logSink is a persistent array initialized once in the Sandbox constructor and appended to by every console.log and timer-error call for the lifetime of the Sandbox. runScript() returns this.logSink.slice() — all logs since construction, not just those from the current call. The convenience runScript() free function creates a new Sandbox per call (so it is unaffected), but the Sandbox class is explicitly noted as a candidate for reuse in slice 8a ('slice 8a may want to reuse Contexts for resume'). Any reuse scenario — including resume or the planned slice-8a workflow runner — would see logs from earlier runs in every subsequent result.

### Suggested Fix

At the start of runScript(), record const logStart = this.logSink.length and return this.logSink.slice(logStart) instead of this.logSink.slice(). The full history remains available via takeLog() for callers that need it.

---

## BUG-025 ✅ FIXED — Pre-run abort guard creates Error without name='AbortError', inconsistent with raceWithAbort

**Area:** sandbox
**Severity:** low
**Location:** sandbox.ts, Sandbox.runScript(), the if (this.opts.signal.aborted) block near the top of the method
**Discovered:** iteration-1

### Description

The early abort check at the top of runScript() throws: new ContextError('aborted before run') — a plain Error with name 'Error'. raceWithAbort() always sets Object.defineProperty(e, 'name', { value: 'AbortError' }) on its abort rejection. Scripts that catch errors and branch on e.name === 'AbortError' (a standard pattern for abort handling) will see 'Error' for pre-run aborts and 'AbortError' for mid-run aborts, making abort handling inconsistent depending on the race timing.

### Suggested Fix

After constructing the ContextError, call Object.defineProperty(e, 'name', { value: 'AbortError', configurable: true, writable: true, enumerable: false }) before throwing — matching the pattern in raceWithAbort.

---

## BUG-026 ✅ FIXED (duplicate) — approved/pending states listed as resumable in comment but excluded from RESUMABLE_STATES — handlers are dead code and those states are incorrectly rejected

**Area:** resumeRun / ledger
**Severity:** high
**Location:** resumeRun.ts lines ~134-165 (resumability check) and ~215-235 (dead elseif branches); ledger.ts RESUMABLE_STATES definition
**Discovered:** iteration-1

### Description

In resumeRun.ts the resumability guard comment explicitly states 'paused, running, approved, pending: resumable', but RESUMABLE_STATES (imported from ledger.ts) is defined as only {paused, running}. The check `RESUMABLE_STATES.has(finalState)` therefore returns false for both 'approved' and 'pending', causing ResumeNotAllowedError to be thrown before execution ever reaches the state-machine reset section. The two elseif branches that handle `finalState === 'approved'` and `finalState === 'pending'` (which append the correct ledger transitions) are completely unreachable dead code. A run left in 'approved' or 'pending' state after a pi crash — e.g. the process was killed while waiting for the approved→running runManager.start call — cannot be resumed even though the PRD and code comments explicitly intend those states to be resumable. NON_TERMINAL_STATES in ledger.ts correctly includes both 'approved' and 'pending', showing the original intent.

### Suggested Fix

Add 'approved' and 'pending' to RESUMABLE_STATES in ledger.ts: `export const RESUMABLE_STATES: ReadonlySet<RunState> = new Set<RunState>(['paused', 'running', 'approved', 'pending']);`. Alternatively, expand the resumeRun check to `RESUMABLE_STATES.has(finalState) || finalState === 'approved' || finalState === 'pending'` without changing the exported constant if downstream consumers depend on its current semantics.

---

## BUG-027 ✅ FIXED — RunStateMachine.go() has no concurrency guard — isValidTransition check and currentState update are not atomic, allowing two concurrent calls to both pass validation against the same stale state

**Area:** ledger
**Severity:** medium
**Location:** ledger.ts RunStateMachine.go() method (~line 185); race materializes where sm.go('done') in promise body races with pause's sm.go('paused') in controlChain callback
**Discovered:** iteration-1

### Description

In RunStateMachine.go(), the pattern is: (1) read `this.currentState` as `from`, (2) call `isValidTransition(from, to)`, (3) `await this.writer.append(entry)`, (4) `this.currentState = to`. Step 4 only executes after the async append resolves. If two callers invoke `go()` concurrently — e.g. the sandbox script completing and calling `sm.go('done')` while a `pause` control-chain callback calls `sm.go('paused')` — both read the same `from` state ('running'), both pass validation, both enqueue their writes. The LedgerWriter's writeQueue serializes the actual disk writes, but both transitions commit successfully. The ledger then contains `running→done` followed by `running→paused` (or vice versa), and replayState emits an invalid-transition warning for the second entry but the final replayed state is wrong.

### Suggested Fix

Serialize go() calls through an internal queue analogous to LedgerWriter.writeQueue: maintain a `private goQueue: Promise<void> = Promise.resolve()` in RunStateMachine, then in go() enqueue the full validate+append+advance as a single chained step so the second call sees the updated state from the first.

---

## BUG-028 ✅ FIXED — Resume lock held during interactive approval gate — lock blocks concurrent-resume detection for the entire duration of user input

**Area:** resumeRun
**Severity:** medium
**Location:** resumeRun.ts — acquireResumeLock call at ~line 167 precedes runApprovalGate at ~line 218
**Discovered:** iteration-1

### Description

In resumeRun.ts, `acquireResumeLock` is called synchronously before `runApprovalGate`. The approval gate can block for an arbitrarily long time (seconds to minutes) waiting for the user to accept or reject the prompt. During this entire window the .resume.lock file is held, so any other pi process that attempts to resume the same run will be correctly blocked — but a legitimate scenario is that the first pi process crashes mid-approval (after acquiring the lock but before the user responds). The stale-lock detection path in acquireResumeLock requires the original PID to be dead, which is correct, but if the first process is still alive and stuck at the prompt, the second process is blocked forever with only a user-visible error. More concretely: a resumed run that is then cancelled at the approval prompt still held the lock the whole time, and any subsequent legitimate resume from another window would fail with ResumeLockedError until the first process cleans up.

### Suggested Fix

Move acquireResumeLock to after the approval gate resolves with `approved: true`. Only acquire the lock once the user has consented and actual run execution is about to begin. If the approval is rejected, no lock is needed. This narrows the lock window to the actual execution period.

---

## BUG-029 ✅ FIXED — stderrTee WriteStream not closed on !child.stdout early-exit path in dispatchAgent

**Area:** dispatcher
**Severity:** low
**Location:** dispatcher.ts — early return block for `if (!child.stdout)` at ~line 290
**Discovered:** iteration-1

### Description

When child.stdout is null (line ~290 in dispatcher.ts), dispatchAgent correctly closes `tee` via the tee.end() / 'close' Promise before throwing AgentSubprocessError. However `stderrTee` is never ended or closed on this path. The `stderrTee.end()` is only called via the child.stderr 'end' event handler (normal path) or the `else` branch (child.stderr also null). If child.stdout is null but child.stderr is non-null, the 'end' event on child.stderr may never fire (the child never properly started), leaving stderrTee open. The writable stream holds an open file descriptor for the stderr capture file until GC eventually reclaims it.

### Suggested Fix

In the `!child.stdout` early-exit block, add `stderrTee.end()` (or `stderrTee.destroy()`) before or alongside the existing `tee.end()` cleanup, mirroring the pattern used for `tee`.

---

## BUG-030 ✅ FIXED (duplicate) — SIGKILL escalation timer (killHandle) inside timeout callback has no reference and cannot be cleared if child exits from SIGTERM

**Area:** dispatcher
**Severity:** low
**Location:** dispatcher.ts — inner killHandle setTimeout inside the timeoutHandle callback (~line 310)
**Discovered:** iteration-1

### Description

In dispatchAgent the outer `timeoutHandle` callback sends SIGTERM then creates an inner `killHandle = setTimeout(() => child.kill('SIGKILL'), 5000)`. `killHandle` is immediately `unref()`'d and has no reference outside the callback closure, so it cannot be cancelled. If the child exits cleanly from SIGTERM before the 5-second SIGKILL fires, the escalation still runs. Node.js's ChildProcess.kill() on an already-exited process is safe (throws or returns false caught by the surrounding try/catch), but the pattern creates a dangling timer after dispatchAgent has already resolved. In a high-throughput scenario with many agents timing out, a large number of these orphaned SIGKILL timers accumulate until they fire.

### Suggested Fix

Promote killHandle to outer scope with `let killHandle: ReturnType<typeof setTimeout> | undefined` and add `clearTimeout(killHandle)` in the post-stream cleanup after `await exitPromise`. This cancels the escalation if the child exits before the 5-second window.

---

## BUG-031 ✅ FIXED (duplicate) — phaseCursor not clamped when running agents decrease or phase completes

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts makeOverlayComponent › debouncedRender (does not clamp phaseCursor) and navigate-back (does not reset phaseCursor on phase end)
**Discovered:** iteration-1

### Description

debouncedRender clamps `cursor` (runs-list) when the snapshot shrinks but never clamps `phaseCursor`. When a running phase ends and its agents disappear, `phaseCursor` retains its prior value. On the next phase-view render, `buildRender` passes the stale `phaseCursor` to `renderPhaseView`, which silently drops the highlight (cursor >= agentRows.length). Worse, when the next phase starts, `phaseCursor` can immediately point to the wrong agent index from the previous phase, causing an unexpected agent-detail open on Enter.

### Suggested Fix

Inside debouncedRender, after rebuilding lastSnapshot, also clamp phaseCursor: if in phase-view, recompute visibleAgents from the phaseRegistry snapshot and do `if (phaseCursor >= visibleAgents) phaseCursor = Math.max(0, visibleAgents - 1)`. Also reset phaseCursor to 0 in the phase-subscription callback when the opened run's active phase changes.

---

## BUG-032 ✅ FIXED — helpForState marks 'r' as disabled for paused runs on runs-list, but dispatchHotkey enables r→resume for paused

**Area:** overlay / TUI
**Severity:** medium
**Location:** hotkeys.ts helpForState (runs-list branch, 'r' entry)
**Discovered:** iteration-1

### Description

In helpForState for the 'runs-list' view, the 'r' bullet is computed as `dis('r', 'restart', noSel || !isTerminal)`. This marks r as disabled whenever runState is 'paused' (because paused is not in TERMINAL). However, isHotkeyEnabled explicitly returns true for r when runState === 'paused' on runs-list, and dispatchHotkey dispatches `{ kind: 'resume' }` for that case. The help line incorrectly grays out r for paused runs, making the resume-via-r shortcut undiscoverable.

### Suggested Fix

Change the disabled predicate to `noSel || (!isTerminal && !isPaused)` so that r shows as enabled (labeled 'resume') when the run is paused, matching isHotkeyEnabled and dispatchHotkey. Optionally use `isPaused ? 'resume' : 'restart'` for the label.

---

## BUG-033 ✅ FIXED — isHotkeyEnabled unconditionally returns false for 'r' on phase-view, contradicting dispatchHotkey and helpForState

**Area:** overlay / TUI
**Severity:** low
**Location:** hotkeys.ts isHotkeyEnabled (case 'r')
**Discovered:** iteration-1

### Description

isHotkeyEnabled's 'r' case short-circuits with `if (input.view !== 'runs-list') return false`, so it returns false for phase-view. But dispatchHotkey handles r on phase-view (dispatching resume on paused or restart-requested on terminal), and helpForState for phase-view includes r in the help list with correct enabled/disabled logic. Any caller using isHotkeyEnabled to gate r on phase-view (e.g. a future test harness or accessibility layer) will incorrectly conclude r is disabled.

### Suggested Fix

Extend the 'r' case to also return true when `input.view === 'phase-view' && !input.isRemote && (input.runState === 'paused' || TERMINAL.has(input.runState))`, matching the dispatchHotkey and helpForState logic for phase-view.

---

## BUG-034 ✅ FIXED — navigate-up/down in agent-detail view adjusts the runs-list cursor, not a log-scroll offset

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts makeOverlayComponent › handleAction cases 'navigate-up' and 'navigate-down'
**Discovered:** iteration-1

### Description

handleAction for 'navigate-up' and 'navigate-down' only special-cases 'phase-view'; for agent-detail it falls through to the `cursor--` / `cursor++` branch, which adjusts the runs-list cursor variable. The help text for agent-detail shows '↑↓ jk scroll', but no scroll state exists for the agent log tail and no scroll offset is passed to renderAgentDetail. The net effect is that pressing j/k in agent-detail silently mutates the hidden runs-list cursor without scrolling the visible log, and snaps the selection when the user returns to runs-list.

### Suggested Fix

Add an `agentLogScrollOffset` variable (number, 0-based). In navigate-up/down when view === 'agent-detail', adjust agentLogScrollOffset clamped to [0, agentLogTail.length - visibleLines] and pass it to renderAgentDetail. Leave the runs-list cursor unmodified. Update renderAgentDetail to accept and apply the offset.

---

## BUG-035 ✅ FIXED (duplicate) — F4 GC guard direction is inverted: protects restart-of-active-original, but not source-of-active-restart

**Area:** gcDialog
**Severity:** medium
**Location:** gcDialog.ts loadGcCandidates (F4 filter, lines checking restartedFrom against activeRunIds)
**Discovered:** iteration-1

### Description

loadGcCandidates F4 filter reads each GC candidate C's own `restartedFrom` field and skips C if that value is in activeRunIds — i.e. it skips a terminal restart-run when the run it was restarted FROM is still active. The comment and PRD intent describe the opposite: skip the SOURCE run (the one that was restarted) when the RESTART SIBLING is still running, to avoid deleting artifacts the active restart depends on. As written, the original source run (GC candidate) is NOT protected when its restart sibling is active and running; only the (already-terminal) restart is protected in the edge case where the original is somehow still active.

### Suggested Fix

To protect the source: for each candidate C, check whether any active run B has `B.manifest.restartedFrom === C.runId`. This requires reading active runs' manifests (or passing a map of activeRun→restartedFrom). The current filter can remain as an additional guard but is insufficient on its own for the stated intent.

---

## BUG-036 ✅ FIXED — applyGc deletes without re-validating candidates against current active run state

**Area:** gcDialog
**Severity:** high
**Location:** gcDialog.ts applyGc (no active-state re-check before rmSync)
**Discovered:** iteration-1

### Description

The GC dialog is opened (loadGcCandidates runs), the user reads the summary, then confirms. applyGc receives the candidate list captured at dialog-open time and calls rmSync on each runDir without re-checking whether any candidate has since transitioned to active (e.g. a paused run resumed, or a cancelled-pre-run was retried). In practice this window is short, but it's observable: if a run is restarted between 'g' and the final 'y/Enter', its directory is deleted while the new run instance is live, corrupting its working state.

### Suggested Fix

Before the deletion loop in applyGc, accept an optional `activeRunIds` set. For each candidate, re-read its manifest (or accept the current active set from the caller) and skip any runId now present in activeRunIds, logging a warning. The overlay's gc-apply handler should pass the freshly-computed active set at the moment the user confirms.

---

## BUG-037 ✅ FIXED (duplicate) — CacheStore.runCompaction builds snapshot before queue drains — concurrent in-flight writes silently dropped from compacted file

**Area:** runtime/cache
**Severity:** high
**Location:** src/runtime/cache.ts — CacheStore.runCompaction(), lines 293–319 (snapshot build at 298–308, queue chain at 312–313)
**Discovered:** iteration-1

### Description

runCompaction() captures the snapshot string from the in-memory maps synchronously (lines 298–308) before chaining the snapshot write onto writeQueue. A concurrent caller that has already called appendRecord() (queuing its disk write) but has not yet completed `await appendRecord()` — and therefore has not yet called agentResults.set/authorCache.set — will have its write execute against the old cache.jsonl (before the rename), but the rename replaces the file with a snapshot that was built before that write was reflected in memory. Concrete sequence: (A) A calls appendRecord(a), B calls appendRecord(b) — both queued; (B) A's write completes, A.memory.set(a), A triggers runCompaction; (C) snapshot = {a} only, because B.memory.set(b) hasn't run; (D) queue is now [B's write, compaction rename]; (E) B writes to old cache.jsonl; (F) rename overwrites with snapshot missing b; (G) B.await resolves, B.memory.set(b) runs — memory has b, disk does not. Crash after step G loses b on replay.

### Suggested Fix

Move the snapshot construction inside the .then() callback so it executes after all pending disk writes complete and their memory updates have been applied: `const next = this.writeQueue.then(() => { const snap = this.buildSnapshotString(); return this.writeSnapshotAndRename(snap); })`. Extract the snapshot-building loop into a private buildSnapshotString() helper.

---

## BUG-038 ✅ FIXED — writeParentLivenessFields read-merge-write is unguarded — concurrent slice-6 and slice-8a manifest writes lose each other's fields

**Area:** manifestWriter
**Severity:** medium
**Location:** src/runtime/manifestWriter.ts — writeParentLivenessFields(), lines 80–121 (read at 88, rename at 120)
**Discovered:** iteration-1

### Description

writeParentLivenessFields() performs an unguarded read → merge → tmp-write → rename sequence. No per-runDir mutex exists. If slice-8a (which writes workflowName, runId, startedAt, etc.) and slice-6 (which calls writeParentLivenessFields for parentPid/parentStartTime/parentBootId) execute concurrently on the same runDir, both can read the same empty or partial manifest, build independent merged objects, and race on the rename. Last rename wins; the other's fields are silently lost. Missing parentPid/parentStartTime/parentBootId breaks the slice-5.8.2 liveness sweep (orphan detection). Missing workflowName/runId breaks the TUI overlay and GC.

### Suggested Fix

Introduce a per-runDir write mutex using the same acquireWriteSlot pattern from trustStore.ts, keyed by the manifest target path. Alternatively, define a single authoritative manifest writer (e.g., in slice-8a) that calls captureParentLiveness() itself and writes all fields in one atomic operation, eliminating the multi-writer race entirely.

---

## BUG-039 ✅ FIXED (duplicate) — writeResultFile does not fsync tmp file before rename — result.json durability gap on crash

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — writeResultFile(), lines 227–235
**Discovered:** iteration-1

### Description

writeResultFile() calls fs.writeFile(tmp) then fs.rename(tmp, target) with no fsync between them. The rename is atomic at the POSIX level, but the payload written by fs.writeFile may still reside only in the OS page cache at the time of rename. A power failure or kernel crash immediately after rename can leave result.json pointing to a file whose data was never flushed to storage, producing a zero-length or corrupt result on next read. By contrast, CacheStore.writeSnapshotAndRename() and CacheStore.appendLineSync() both explicitly call fsyncSync() before returning. The inconsistency is notable because result.json is the primary artifact consumers read after a run completes.

### Suggested Fix

Open the tmp file with openSync, writeSync the body, fsyncSync, closeSync, then fs.rename — mirroring writeSnapshotAndRename() in cache.ts. The deliverRunResult() already treats the write as non-fatal, so this is purely a durability improvement.

---

## BUG-040 ✅ FIXED (duplicate) — writeResultFile tmp filename has no entropy — sub-millisecond double-invoke produces same path, races on rename

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — writeResultFile(), line 232
**Discovered:** iteration-1

### Description

The tmp filename is `result.json.tmp-<process.pid>-<Date.now()>`. If deliverRunResult() is invoked twice for the same runDir within the same millisecond (e.g., error-path retry or test harness double-fire), both calls compute the identical tmp path. The second fs.writeFile() silently overwrites the first's in-flight content; the losing rename then throws ENOENT because the winning rename already moved the file away. manifestWriter.ts and trustStore.ts both append randomBytes(4).toString('hex') to their tmp names precisely to prevent this; writeResultFile does not.

### Suggested Fix

Append a 4-byte random hex suffix: `result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`. Import randomBytes from node:crypto (already imported in trustStore.ts and manifestWriter.ts as a pattern).

---

## BUG-041 ✅ FIXED (duplicate) — cancelReasonText returns 'approval denied' for decision.approved === true — misleading result card copy

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — cancelReasonText(), lines ~163–170
**Discovered:** iteration-1

### Description

cancelReasonText() contains `if (decision.approved) return 'approval denied'` (the second guard at line ~165). When an ApprovalDecision with approved=true is passed for a cancelled-pre-run outcome — an inconsistent state reachable if the approval result and cancellation path diverge — the result card displays 'Approval: approval denied' even though the stored decision record says the workflow was approved. This makes it impossible to distinguish a genuine denial from a cancellation-despite-approval, and will mislead any audit trail built on the card's details.approval field.

### Suggested Fix

Replace `if (decision.approved) return 'approval denied'` with `if (decision.approved) return 'cancelled despite approval (unexpected state)'` or narrow the guard to `if (!decision.approved)` and restructure the branches so approved=true falls through to a descriptive fallback rather than silently mislabeling the outcome.

---

## BUG-042 ✅ FIXED (duplicate) — promptSnippet uses `ctx.pipeline()` which is undocumented in runtime-api.md, authoring.md, and SKILL.md

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:183,232-238
**Discovered:** iteration-1

### Description

The `promptSnippet` in `writeWorkflowTool.ts` (lines 232–238) demonstrates `ctx.pipeline(items, ...stages)` as a standard API, and the `promptGuidelines` (line 183) also describe it. But `ctx.pipeline` does not appear anywhere in `runtime-api.md`, `authoring.md`, or `SKILL.md`. LLMs reading the promptSnippet will generate workflow code that calls `ctx.pipeline()` and get a ReferenceError at runtime.

### Suggested Fix

Either document ctx.pipeline in runtime-api.md (signature, semantics, example) and add it to the SKILL.md table, or remove it from the promptSnippet and promptGuidelines until it is implemented and documented.

---

## BUG-043 ✅ FIXED (duplicate) — promptSnippet uses `ctx.budget.spent()` which is undocumented everywhere

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:245-246
**Discovered:** iteration-1

### Description

Line 246 of the `promptSnippet` in `writeWorkflowTool.ts` uses `ctx.budget.spent()`, with a comment showing it as a normal API call. `ctx.budget` is not defined in `runtime-api.md`, `authoring.md`, or `SKILL.md`. LLMs will generate code calling `ctx.budget.spent()` and get a TypeError at runtime.

### Suggested Fix

Either document ctx.budget in runtime-api.md (interface, methods, semantics) and add it to the SKILL.md table, or remove the budget usage from the promptSnippet.

---

## BUG-044 ✅ FIXED (duplicate) — `promptGuidelines` and promptSnippet use `ctx.phase(name, handles, { failMode })` but runtime-api.md documents no third argument

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:189,242 vs docs/runtime-api.md (ctx.phase signature)
**Discovered:** iteration-1

### Description

The promptGuidelines (line 189) say to pass `{ failMode: 'null' }` as a third arg to `ctx.phase()`. The promptSnippet also uses it (line 242). But `runtime-api.md` documents `ctx.phase` as `phase(name: string, agents: ReadonlyArray<AgentHandle>): Promise<...>` — no third parameter. LLMs will generate `ctx.phase(..., { failMode: 'null' })` which will silently be ignored or throw, never achieving the intended resilience.

### Suggested Fix

Add the opts third parameter to the ctx.phase signature in runtime-api.md and document failMode options, OR remove the failMode usage from promptGuidelines and promptSnippet if the feature is not yet implemented.

---

## BUG-045 ✅ FIXED — Direct contradiction between promptGuidelines and promptSnippet on whether `AgentResult.output` exists

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:181 vs 198,217,224
**Discovered:** iteration-1

### Description

The `promptGuidelines` (line 181) explicitly state: "AgentResult has `.text` (string), `.usage`, `.durationMs`, `.cached` — NOT `.output`." But the promptSnippet comment (line 198) says: "AgentResult: { text, output?, usage, durationMs, cached } — use .text for prose, .output for schema results", and the promptSnippet code (line 224) uses `typed.output`. This internal contradiction within the same file will confuse LLMs unpredictably.

### Suggested Fix

Decide whether `AgentResult.output` is a real field (if so: document it in runtime-api.md and remove the 'NOT .output' guideline) or not (if so: remove .output from the promptSnippet comment and code, and remove the opts.schema example). Also update runtime-api.md AgentResult interface accordingly.

---

## BUG-046 ✅ FIXED — promptSnippet uses TypeScript `as` cast syntax inside a `.js` workflow file — invalid JavaScript

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:224 (promptSnippet)
**Discovered:** iteration-1

### Description

Line 224 of the promptSnippet uses `(typed.output as { issues: string[] }).issues` — this is TypeScript syntax. Workflow files are `.js` files executed inside `node:vm` with `allowCodeGeneration: false`. The `as` keyword is not valid JavaScript and will throw a SyntaxError when the vm tries to compile the script. Any LLM that copies this pattern will produce a workflow that fails at parse time.

### Suggested Fix

Replace `(typed.output as { issues: string[] }).issues` with plain JS: `/** @type {{ issues: string[] }} */ (typed.output).issues` or simply `typed.output?.issues ?? []`. Remove all TypeScript-specific syntax from the promptSnippet since workflows must be valid `.js`.

---

## BUG-047 ✅ FIXED — `codebase-audit.js` passes an object (not a string) as first arg to `ctx.log()`, contradicting the documented API

**Area:** examples
**Severity:** medium
**Location:** examples/codebase-audit/codebase-audit.js (ctx.log call in analyze error handler)
**Discovered:** iteration-1

### Description

In `examples/codebase-audit/codebase-audit.js` (the canonical reference implementation), `ctx.log` is called with an object as the first argument: `ctx.log({ msg: '...', agentId: ..., err: ... }, { level: 'warn' })`. But `runtime-api.md` documents `ctx.log(message: string, opts?)` — the first argument must be a string. At runtime this will log `[object Object]` instead of the intended message, making the warning useless.

### Suggested Fix

Change to `` ctx.log(`analyze agent returned unparseable JSON — agentId=${a.agentId} err=${e.message}`, { level: 'warn' }) `` to match the documented string signature.

---

## BUG-048 ✅ FIXED — `hello.js` and `codebase-audit.js` canonical examples omit `export const meta` — inconsistent with write_workflow validation requirement

**Area:** examples
**Severity:** medium
**Location:** examples/hello/hello.js, examples/codebase-audit/codebase-audit.js
**Discovered:** iteration-1

### Description

`writeWorkflowTool.ts` enforces that `export const meta = { name, description, version }` must be the FIRST meaningful statement, and the promptGuidelines say 'Always include export const meta as the FIRST statement'. Yet both `examples/hello/hello.js` and `examples/codebase-audit/codebase-audit.js` have no `export const meta` at all. Authors following these canonical examples will either produce workflows that pass through write_workflow validation failure, or be confused about when meta is required.

### Suggested Fix

Add `export const meta = { name: 'hello', description: '...', version: '1.0.0' }` as the first statement in both example files, making them consistent with the write_workflow validation contract and the authoring guidance.

---

## BUG-049 ✅ FIXED — `authoring.md` references `examples/codebase-audit.js` but actual file is at `examples/codebase-audit/codebase-audit.js`

**Area:** docs
**Severity:** low
**Location:** docs/authoring.md:164
**Discovered:** iteration-1

### Description

Line 164 of `authoring.md` says "See `examples/codebase-audit.js` for the full source." The actual file lives at `examples/codebase-audit/codebase-audit.js` — a subdirectory, not a flat `.js` file. The link is stale and will lead authors to a 404.

### Suggested Fix

Change `examples/codebase-audit.js` to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-050 ✅ FIXED — promptGuideline tells LLM to say workflow "is already running" but write_workflow tool may only save (not start) the workflow

**Area:** writeWorkflowTool / docs
**Severity:** low
**Location:** src/runtime/writeWorkflowTool.ts (last promptGuideline entry)
**Discovered:** iteration-1

### Description

The last promptGuideline in `writeWorkflowTool.ts` instructs: "tell the user the workflow was saved and is already running — direct them to /workflows to monitor progress." However, the tool's own result card text handles three cases: run started, run failed to start, and not started ("It's now registered. Open /workflows to launch and monitor it."). The LLM narrative will say "already running" even when the tool reply says "registered but not started", creating a confusing mismatch.

### Suggested Fix

Change the promptGuideline to: "After calling write_workflow, tell the user the workflow was saved. If the result card says 'Run started', confirm it's running and direct to /workflows. Otherwise tell them to open /workflows to launch it manually."

---

## BUG-051 ✅ FIXED — extractJson fallback broken for nested JSON: lastIndexOf finds innermost brace

**Area:** runtime / runCtx
**Severity:** high
**Location:** src/runtime/runCtx.ts: extractJson() lines 739-758
**Discovered:** iteration-2

### Description

extractJson's fallback path uses `text.lastIndexOf("{")` which finds the LAST (innermost) opening brace in nested objects, not the outermost. For a response like `...{"a":{"b":1}}`, `lastIndexOf` returns the position of `{"b"`, so `text.slice(start)` = `{"b":1}}` — an extra closing `}` causes JSON.parse to throw. Additionally, `text.slice(start)` goes to end-of-string, so any trailing prose after the JSON close also breaks parsing. Together these make the fallback path non-functional for any real schema with nested objects.

### Suggested Fix

Use a bracket-depth scan to find the matching close delimiter, or try JSON.parse over progressively smaller substrings from lastIndexOf. At minimum, trim from the start position until JSON.parse succeeds without trailing content.

---

## BUG-052 ✅ FIXED — extractJson fence regex matches FIRST code block, not LAST

**Area:** runtime / runCtx
**Severity:** high
**Location:** src/runtime/runCtx.ts: extractJson() line 742
**Discovered:** iteration-2

### Description

`` /```json\s*([\s\S]*?)```/.exec(text) `` finds the first (non-greedy) fence match. The schema instruction in buildSchemaInstruction tells agents to 'Place the JSON block at the END of your response', but when agents include an example block earlier in the response followed by the actual output block, the regex extracts the example not the result. Should use a global match and take the last capture.

### Suggested Fix

Replace `.exec(text)` with a global search (e.g. spread `` text.matchAll(/```json\s*([\s\S]*?)```/g) ``) and take the last match's capture group.

---

## BUG-053 ✅ FIXED — extractJson throws in cache-hit path: agent_error never logged, phase silently rejects

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: runOneAgent() lines 497-502 (cache-hit path)
**Discovered:** iteration-2

### Description

In the cache-hit branch of runOneAgent, `extractJson(result.text)` is called AFTER `agent_end` has already been appended to the ledger AND after the `try/catch` block that handles agent failures. If extractJson throws (malformed/missing JSON in cached text), the error propagates directly to Promise.allSettled in phase(). The ledger shows agent_start + agent_cache_hit + agent_end(cached:true) — a clean success — but the phase rejects. No agent_error entry is written. The misleading ledger state makes this failure invisible during debugging.

### Suggested Fix

Wrap the schema extraction in the cache-hit path with its own try/catch that appends agent_error to the ledger before rethrowing, or move extractJson before agent_end is logged.

---

## BUG-054 ✅ FIXED — Live-dispatch path: agent_end logged before extractJson; schema failure produces both agent_end and agent_error

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: runOneAgent() lines 555-600 (live dispatch path)
**Discovered:** iteration-2

### Description

In the non-cached dispatch path, `agent_end` is appended to the ledger (line ~566) before `extractJson` is called (line ~589). Both are inside the outer try/catch block that appends `agent_error` on any throw. If extractJson throws, the catch block fires and writes agent_error — giving the ledger both an agent_end (success) AND an agent_error for the same agent. This corrupts the ledger and will confuse any consumer that assumes agent_end and agent_error are mutually exclusive terminal events.

### Suggested Fix

Move `agent_end` logging to AFTER extractJson succeeds, or move extractJson before the agent_end log. Either way, ensure only one terminal ledger event is written per agent.

---

## BUG-055 ✅ FIXED — Token budget enforcement races in parallel phases — budget can be overshot

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: runOneAgent() lines 397-399
**Discovered:** iteration-2

### Description

In runOneAgent, the budget check `if (tokenBudget !== null && budgetSpent >= tokenBudget)` executes before dispatch, and `budgetSpent` is updated after each agent completes. In a parallel phase, all N agents check the budget simultaneously before any has updated it — if budgetSpent is near the limit, all N pass the check and all N run. The budget can be overshot by up to (N-1) * max_agent_tokens. The comment 'checked before dispatch so we don't start an agent we've already budgeted out of' is accurate for sequential phases but not parallel.

### Suggested Fix

Track budgetSpent as an atomic accumulation — increment an optimistic counter before dispatch (not after) and throw if the pre-increment value already exceeds budget. Or document the race as a known limitation (soft cap, not hard cap) in comments and docs.

---

## BUG-056 ✅ FIXED — failMode invalid values silently coerced to 'throw' — typos undetectable

**Area:** runtime / runCtx
**Severity:** low
**Location:** src/runtime/runCtx.ts: phase() lines 188-194
**Discovered:** iteration-2

### Description

The failMode parsing logic is `(optsArg as ...).failMode === 'null' ? 'null' : 'throw'`. Any value that is not exactly the string `'null'` — including typos like `'Throw'`, `'NULL'`, `'null-on-error'`, or even `true` — is silently accepted and treated as `'throw'`. Authors who misspell `failMode: 'null'` will get `failMode: 'throw'` behavior with no error or warning, making these bugs extremely hard to notice.

### Suggested Fix

After parsing failMode, validate that when `optsArg.failMode` is present it must be either `'throw'` or `'null'`. Throw TypeError for any other value.

---

## BUG-057 ✅ FIXED — phase() failMode='null' path casts Array<AgentResultLike | null> to readonly AgentResultLike[] — drops | null from bridge type

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: phase() line 321
**Discovered:** iteration-2

### Description

In the failMode='null' error path, `out` is declared as `Array<AgentResultLike | null>` and correctly contains nulls for failed agents, but the return is `{ ok: true, value: out as readonly AgentResultLike[] }`. The cast erases `| null` from the bridge result's value type. The sandbox wrapper receives `RunCtxBridgeResult<readonly AgentResultLike[]>` and its type-level knowledge that elements can be null is lost, breaking the type contract downstream.

### Suggested Fix

Change the return type of the host bridge method to `RunCtxBridgeResult<readonly (AgentResultLike | null)[]>` for this path, or update `RunCtxHost.phase` to reflect nullable elements. The cast should be `out as readonly (AgentResultLike | null)[]`.

---

## BUG-058 ✅ FIXED — runtime-api.md ctx.phase signature missing opts third parameter — failMode undiscoverable from docs

**Area:** docs
**Severity:** low
**Location:** docs/runtime-api.md: ctx.phase section, line ~118
**Discovered:** iteration-2

### Description

The runtime-api.md documents `ctx.phase(name, handles)` with a two-parameter signature and `AgentResult` return type (non-nullable). The actual signature is `phase(name, agents, opts?)` with `PhaseOpts` accepting `failMode` and a return of `ReadonlyArray<AgentResult | null>`. Authors reading only the docs will not know about `failMode: 'null'` and cannot write fault-tolerant workflows that handle partial failures.

### Suggested Fix

Update the docs signature to `phase(name: string, agents: ReadonlyArray<AgentHandle>, opts?: PhaseOpts): Promise<ReadonlyArray<AgentResult | null>>` and add a PhaseOpts table documenting `failMode`.

---

## BUG-059 ✅ FIXED — runtime-api.md ConsensusOpts and ConsensusResult document non-existent fields; wrong threshold default

**Area:** docs
**Severity:** medium
**Location:** docs/runtime-api.md: ctx.consensus section lines 268-286
**Discovered:** iteration-2

### Description

The docs document `ConsensusOpts.similarity` (Jaccard floor per pair) and `ConsensusResult.scores` (per-agent mean similarity array) — neither field exists in the implementation or in public.d.ts. The docs also state threshold default is `0.5` but the implementation defaults to `0.6`. Additionally `consensus` uses a single `threshold` value for both the Jaccard similarity floor AND the pair-fraction agreement check — they cannot be set independently as the docs imply. Code written against the documented interface will silently receive wrong results or undefined fields.

### Suggested Fix

Remove `similarity` from ConsensusOpts, remove `scores` from ConsensusResult, correct default from 0.5 to 0.6, add a note that threshold controls both the per-pair floor and the pair-fraction check.

---

## BUG-060 ✅ FIXED — runtime-api.md RetryOpts documents wrong field name maxAttempts and wrong backoffMs default 500

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md: ctx.retry section lines 335-348
**Discovered:** iteration-2

### Description

The docs show `RetryOpts.maxAttempts` (default 3) and `backoffMs` default 500. The actual implementation reads `opts.attempts` (not `maxAttempts`) and defaults `backoffMs` to 100. Code written from the docs will silently use the wrong field name — `opts.maxAttempts` is ignored (falls through to the default of 3 attempts) and will get 100ms backoff instead of the documented 500ms. The example in the docs passes `{ maxAttempts: 5, backoffMs: 1000 }` which would silently use 3 attempts instead of 5.

### Suggested Fix

Rename `maxAttempts` to `attempts` in the docs (matching public.d.ts and stdlib implementation), correct backoffMs default from 500 to 100, and fix the example.

---

## BUG-061 ✅ FIXED — `fireCtxAbort` abort listener never removed from `hostSignal` after normal script completion

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `Sandbox.runScript`, abort-listener registration block (~line 550 area)
**Discovered:** iteration-2

### Description

In `runScript`, `hostSignal.addEventListener('abort', fireCtxAbort, { once: true })` is called to wire the host AbortSignal to the Context-realm abort thunk. The listener is never explicitly removed via `removeEventListener` when the script completes normally or throws. The `{ once: true }` flag only auto-removes on signal fire. If the script finishes without abort, `fireCtxAbort` — which closes over `signalAbortThunk`, a Context-realm function — stays registered on `hostSignal` indefinitely. This (1) prevents the vm.Context from being GC'd after `dispose()` as long as the AbortController lives, and (2) on a long-lived or reused AbortController accumulates multiple stale listeners across runs.

### Suggested Fix

Wrap the `raceWithAbort` call in a try/finally and unconditionally call `hostSignal.removeEventListener('abort', fireCtxAbort)` in the finally block.

---

## BUG-062 ✅ FIXED — `RunCtxHostInternal` missing `tokenBudget` field — `ctx.budget.total` always `undefined`, `budget.remaining()` returns `NaN`

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `RunCtxHostInternal` interface (missing field) + `buildInitScript` `__pi_build_ctx` budget branch
**Discovered:** iteration-2

### Description

The init script's `__pi_build_ctx` reads `__runCtxHost.tokenBudget` to populate `budget.total` and `budget.remaining()`. However `tokenBudget` is not declared on the `RunCtxHostInternal` TypeScript interface defined in `sandbox.ts`. TypeScript does not type-check the string contents of the init script, so this goes undetected. At runtime the property access returns `undefined`. Consequently `ctx.budget.total === undefined` (not `null | number`), and `budget.remaining()` computes `Math.max(0, undefined - spent)` which is `NaN`. Workflow scripts gating on `ctx.budget.remaining() < threshold` see `NaN` comparisons that always evaluate `false`, silently masking budget exhaustion.

### Suggested Fix

Add `tokenBudget: number | null` to `RunCtxHostInternal`. Verify the host-side bridge object that gets assigned to `opts.runCtxHost` populates this field; add a TypeScript compile-time check so future additions to the interface flag missing implementations.

---

## BUG-063 ✅ FIXED — Context-realm `URLSearchParams` wrapper missing `[Symbol.iterator]` — `for...of` and spread throw `TypeError`

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `buildInitScript`, URLSearchParams constructor section
**Discovered:** iteration-2

### Description

The `URLSearchParams` constructor installed by the init script defines `get`, `getAll`, `has`, `set`, `append`, `delete`, `toString`, `entries`, `keys`, `values`, `forEach`, and `size`, but does NOT define `[Symbol.iterator]`. The ECMAScript spec requires `URLSearchParams` to be iterable via `[Symbol.iterator]` (aliased to `entries`). After `Object.freeze(this)` is called, `[Symbol.iterator]` can no longer be added. Any script using `for (const [k, v] of params)`, `[...params]`, or `Array.from(params)` throws `TypeError: params is not iterable`.

### Suggested Fix

Before `Object.freeze(this)` in the URLSearchParams constructor, add: `this[Symbol.iterator] = this.entries;` (or via `Object.defineProperty` with `enumerable: false`).

---

## BUG-064 ✅ FIXED — `Sandbox` constructor leaks `timerBridge` resources when init script throws

**Area:** runtime / sandbox
**Severity:** low
**Location:** src/runtime/sandbox.ts — `Sandbox` constructor, between `installTimerBridge` call and `vm.runInContext(buildInitScript(nonce), ...)` try/catch
**Discovered:** iteration-2

### Description

`installTimerBridge(context, { signal, ... })` is called before `vm.runInContext(buildInitScript(nonce), ...)`. The bridge registers a listener on `opts.signal` (and allocates other internal resources). If `buildInitScript` throws — caught and re-thrown as `SandboxViolationError('init-script-failed')` — the constructor exits without calling `this.timerBridge.dispose()`. The caller receives the violation error and has no handle on the partially-constructed `Sandbox`, so `dispose()` can never be called. The signal listener persists until the `AbortController` itself is GC'd.

### Suggested Fix

In the init-script catch block, call `this.timerBridge.dispose()` before re-throwing the `SandboxViolationError`.

---

## BUG-065 ✅ FIXED — Context-realm signal object not frozen — user code can replace `addEventListener`/`removeEventListener` on `ctx.signal`

**Area:** runtime / sandbox
**Severity:** low
**Location:** src/runtime/sandbox.ts — `buildInitScript`, `__pi_make_signal` return value
**Discovered:** iteration-2

### Description

`__pi_make_signal()` returns `{ signal, abort }` where `signal` is a plain unfrozen object. `__base.signal = signal` is assigned, then `ctx = Object.freeze(__base)`. `Object.freeze` only freezes the top-level `ctx` (making `ctx.signal` a non-writable reference), NOT the signal object itself. User code can do `ctx.signal.addEventListener = null` or `ctx.signal.removeEventListener = () => {}`. If any host-internal path (e.g. `ctx.phase` abort propagation) registers on the user-facing signal, replacement silently disables it. The scenario is limited by the trust model but violates the invariant that ctx surface is immutable.

### Suggested Fix

Add `Object.freeze(signal)` immediately before `return { signal: signal, abort: abort };` inside `__pi_make_signal`. The `abort` closure is host-captured separately and does not need freezing.

---

## BUG-066 ✅ FIXED — resumeRun: `approved` and `pending` states excluded from RESUMABLE_STATES — handling branches are dead code

**Area:** runtime / resumeRun
**Severity:** high
**Location:** src/runtime/resumeRun.ts — `resumeRun()` lines checking `RESUMABLE_STATES.has(finalState)` (~line 185); unreachable `else if (finalState === 'approved')` / `else if (finalState === 'pending')` branches below; src/runtime/ledger.ts — `RESUMABLE_STATES` definition (line ~72)
**Discovered:** iteration-2

### Description

In `resumeRun.ts`, the resumability check uses `RESUMABLE_STATES.has(finalState)` which only contains `"paused"` and `"running"`. The inline comment explicitly lists `approved` and `pending` as resumable: `// - paused, running, approved, pending: resumable.` but neither state is in `RESUMABLE_STATES`, so `resumable` stays `false` and `ResumeNotAllowedError` is thrown before execution can reach the `else if (finalState === 'approved')` and `else if (finalState === 'pending')` transition-append branches that follow. Those two branches (which handle the `pending→approved→running` and `approved→running` ledger writes) are completely unreachable dead code. A run that was approved or still pending at crash time cannot be resumed despite the design intent.

### Suggested Fix

Add `"approved"` and `"pending"` to `RESUMABLE_STATES` in `ledger.ts`: `new Set<RunState>(['paused', 'running', 'approved', 'pending'])`. The downstream handling branches in `resumeRun` already produce the correct transitions for those states once they become reachable.

---

## BUG-067 ✅ FIXED — dispatcher: stderrTee drain uses `writableEnded` instead of `writableFinished` — resolves before data is flushed

**Area:** runtime / dispatcher
**Severity:** medium
**Location:** src/runtime/dispatcher.ts — stderrTee drain `await new Promise<void>` block near bottom of `dispatchAgent`
**Discovered:** iteration-2

### Description

In `dispatchAgent`, the stderrTee drain guard reads `if (stderrTee.writableEnded) { resolve(); return; }`. `writableEnded` becomes `true` immediately when `end()` is called (which happens via the `child.stderr` `'end'` event handler right after the child exits). At that point `finish` has not yet fired and buffered data may not have been flushed. The Promise resolves immediately, and the subsequent `fs.readFile(stderrPath)` (inside the `!agg.agentEnd` branch) reads the file before the OS write-back completes, yielding an incomplete `stderrTail` that is then embedded in the `MalformedAgentOutputError`. The correct property to check is `writableFinished`, which is only `true` after the `'finish'` event fires.

### Suggested Fix

Replace `if (stderrTee.writableEnded)` with `if (stderrTee.writableFinished)` in the early-exit guard of the stderrTee drain promise. This ensures the early-resolution path only fires when all buffered data has actually been written.

---

## BUG-068 ✅ FIXED — dispatcher: inner SIGKILL timer `killHandle` is never cancelled — can fire against a recycled PID

**Area:** runtime / dispatcher
**Severity:** medium
**Location:** src/runtime/dispatcher.ts — `const timeoutHandle = setTimeout(...)` block; inner `const killHandle = setTimeout(...)` inside that callback
**Discovered:** iteration-2

### Description

Inside the `timeoutMs` callback in `dispatchAgent`, a secondary `setTimeout` (`killHandle`) is created to send SIGKILL 5 s after SIGTERM. `killHandle` is stored in a block-scoped `const` inside the outer timeout callback and is only `unref()`'d, never stored in a variable accessible from the cleanup path. If the child exits cleanly within the 5-second grace window (normal case after SIGTERM), `clearTimeout(timeoutHandle)` in the main path is a no-op (the timeout already fired), and `killHandle` remains live. When it fires it calls `child.kill('SIGKILL')` on a process handle whose PID may have been recycled by the OS, risking SIGKILL delivery to an unrelated process.

### Suggested Fix

Hoist `killHandle` to a variable in the outer `dispatchAgent` scope (e.g. `let killTimeoutHandle: ReturnType<typeof setTimeout> | null = null`). Inside the SIGTERM timeout callback, assign `killTimeoutHandle = setTimeout(...)`. In the main-path cleanup (`clearTimeout(timeoutHandle)` section) and all error-path cleanups, also call `if (killTimeoutHandle) clearTimeout(killTimeoutHandle)`.

---

## BUG-069 ✅ FIXED — runLock: TOCTOU window between O_EXCL create and writeSync allows concurrent process to steal the lock

**Area:** runtime / runLock
**Severity:** low
**Location:** src/runtime/runLock.ts — `acquireResumeLock()`, `tryCreate()` function and the subsequent `writeSync(fd, JSON.stringify(lockBody))` call
**Discovered:** iteration-2

### Description

In `acquireResumeLock`, `openSync(lockPath, 'wx')` creates the lockfile with O_EXCL atomicity, returning an fd to the winner. However, the lockfile body (`{ pid, bootId, ... }`) is written in a separate `writeSync` call. In the window between `openSync` success and `writeSync`, the file exists but is empty. A competing process that sees `EEXIST`, reads the empty file (`raw.trim().length > 0` is false), treats it as stale (body defaults to `holderPid=0`), unlinks it, and then re-runs `tryCreate()` will win the lock — leaving two processes both believing they hold it. The window is narrow (two adjacent synchronous syscalls) but real on preemptive multi-process systems.

### Suggested Fix

Write the lock body to a temp file first, then `renameSync` into the lock path after a successful O_EXCL create — but that loses O_EXCL atomicity. A simpler fix: treat an empty lock file (body length 0) as still-being-written and spin-wait/retry rather than treating it as stale. Or embed the pid in the filename itself so the existence of the file with the correct name is sufficient.

---

## BUG-070 ✅ FIXED — resumeRun: resume lock released prematurely if post-IIFE synchronous code throws while run promise is already executing

**Area:** runtime / resumeRun
**Severity:** low
**Location:** src/runtime/resumeRun.ts — `const promise = (async () => { ... })()` assignment and the `opts.activeRuns?.register(...)` call after it; outer `catch` block that calls `lock.release()`
**Discovered:** iteration-2

### Description

In `resumeRun`, `acquireResumeLock` is called before the outer `try` block. The `try/catch` releases the lock if anything throws before `return run`. The run's IIFE `(async () => { ... })()` is assigned to `const promise` inside the `try` block and begins executing synchronously up to its first `await sandbox.runScript(...)`. After that point, control returns to the outer `resumeRun` body which executes `const run: Run = { ... }` and `opts.activeRuns?.register(runId, run, ...)` synchronously. If `opts.activeRuns.register` (or any other code after `const promise = ...`) throws, the outer `catch` releases the lock — but the IIFE is already suspended mid-execution and will continue running. A sibling pi process can then acquire the lock and start another resume of the same run, causing two concurrent resumes against the same ledger and cache.

### Suggested Fix

Move `opts.activeRuns?.register(...)` into the IIFE's setup (before `sandbox.runScript`) so no synchronous post-IIFE code can throw after the IIFE starts. Alternatively, set a boolean `iifeLaunched = true` after `const promise = ...` and guard the outer `catch` release with `if (!iifeLaunched) lock.release()`.

---

## BUG-071 ✅ FIXED — activeRuns: `run.ended` applyEntry lacks terminal-state guard — duplicate or out-of-order entries can overwrite summary

**Area:** runtime / activeRuns
**Severity:** low
**Location:** src/runtime/activeRuns.ts — `case 'pi-workflows.run.ended':` inside `applyEntry()`
**Discovered:** iteration-2

### Description

`applyEntry` for `pi-workflows.run.started` and `pi-workflows.run.transitioned` both check `if (prior && isTerminalState(prior.state)) return` before mutating the summary. The `pi-workflows.run.ended` handler has no such guard. If two `run.ended` entries arrive for the same run (e.g. duplicate appendEntry delivery) or a `run.ended` arrives after `terminated.then()` has already set the state, the handler unconditionally overwrites `#summaries` with the new entry's data. A stale duplicate entry with missing optional fields (e.g. no `workflowName`, no `approvalReason`) silently degrades the stored summary.

### Suggested Fix

Add `if (prior && isTerminalState(prior.state)) return;` at the top of the `run.ended` case, consistent with the other two handlers. Since `run.ended` always intends to set terminal state, a once-terminal summary should never be overwritten by a later event.

---

## BUG-072 ✅ FIXED — _overlayOpen flag never cleared when pi-tui calls dispose() without resolving customApi promise

**Area:** overlay / TUI
**Severity:** high
**Location:** overlay.ts — TuiComponentLike.dispose() (~line 530) and mountOverlay .finally() (~line 230)
**Discovered:** iteration-2

### Description

In makeOverlayComponent, the component's dispose() method calls cleanup() but never calls opts.done(). The _overlayOpen = false reset lives exclusively in the .finally() handler on customApi(...), which only fires when done() is invoked. If pi-tui tears down the overlay by calling dispose() directly (e.g., forced unmount, session end) without resolving the custom promise, _overlayOpen stays true forever. Every subsequent /workflows invocation returns { mode: 'already-open' } and is a no-op.

### Suggested Fix

In dispose(), call opts.done() after cleanup() (guarded by the same idempotency the cleaned flag already provides). Alternatively, clear _overlayOpen directly inside cleanup() rather than relying on the promise chain.

---

## BUG-073 ✅ FIXED — phaseCursor not clamped when running-phase agent list shrinks during debounced registry update

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — debouncedRender setTimeout callback (~line 252) and navigate-down bound check (~line 365)
**Discovered:** iteration-2

### Description

debouncedRender clamps cursor against sorted.length but never clamps phaseCursor. When agents complete and the running-phase count decreases, phaseCursor can exceed visibleAgents - 1. The renderPhaseView guard (opts.cursor < agentRows.length) silently suppresses the highlight, so no crash occurs, but the stale phaseCursor means the next Enter (open-agent-detail) resolves agentEntry as undefined and silently no-ops — the user expects to open an agent they believe is selected.

### Suggested Fix

In the debouncedRender timeout callback, after clamping cursor, also clamp phaseCursor: if openedRunId is set, fetch the running-phase agent count from phaseRegistry.getRunSnapshot and clamp phaseCursor to Math.max(0, visibleAgents - 1).

---

## BUG-074 ✅ FIXED — buildRender mutates view and openedAgentId as side effects, leaving openedRunId and phaseCursor stale on fallback

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — buildRender, agent-detail fallback (~line 300) and phase-view fallback (~line 322)
**Discovered:** iteration-2

### Description

The two fallback paths inside buildRender (agent vanished → fall back to phase-view; run vanished → fall back to runs-list) directly mutate view and openedAgentId but do not clear openedRunId, phaseCursor, or banner. This means: (1) after the runs-list fallback, openedRunId still points to the vanished run — if a subscribe event fires and run data reappears transiently, the phase-view branch re-activates unexpectedly; (2) buildRender is not idempotent — calling it twice in the same render cycle produces different state each time; (3) phaseCursor is never reset to 0 on the auto-fallback path, unlike the explicit navigate-back action.

### Suggested Fix

Replace inline view mutations with explicit calls to handleAction({ kind: 'navigate-back' }) (or a dedicated private transitionToRunsList helper), which already handles clearing openedRunId, phaseCursor, openedAgentId, and banner atomically.

---

## BUG-075 ✅ FIXED — F4 GC protection is inverted: protects restart-child candidates instead of source runs

**Area:** overlay / gcDialog
**Severity:** medium
**Location:** gcDialog.ts — loadGcCandidates F4 filter block (~line 85)
**Discovered:** iteration-2

### Description

loadGcCandidates reads each GC candidate's manifest.restartedFrom and skips the candidate if that original runId is in activeRunIds. This protects restart-child runs (the candidate) when their parent is still active — not the dangerous direction. The real risk is the reverse: original run X is a GC candidate, active run Y has Y.restartedFrom = X. The current code never reads Y's manifest, so X is GC'd while Y is still running, destroying the provenance record of an active restart. The comment ('Avoids deleting the source run while a restart-sibling is still running') describes the correct intent but the implementation checks the wrong direction.

### Suggested Fix

For each active runId, read its manifest.json and collect the set of source runIds (manifest.restartedFrom values). Then filter candidates: skip any candidate whose runId appears in that protected-source set. This requires iterating active run manifests rather than candidate manifests.

---

## BUG-076 ✅ FIXED — GC done screen: y/Enter re-enters apply flow instead of closing

**Area:** overlay / gcDialog
**Severity:** low
**Location:** overlay.ts — handleKey GC dialog intercept (~line 420)
**Discovered:** iteration-2

### Description

In the GC dialog key intercept block of handleKey, the else if (gcDialogState.done !== undefined) branch only fires for keys that are neither y/Enter nor n/Esc. Pressing Enter on the done screen falls into the first branch and dispatches gc-apply. Since gcDialogState.confirming is false on the done state, gc-apply sets confirming: true on a state with candidates: [], rendering a confirm dialog for zero runs. The user must then press n/Esc to dismiss — two extra keystrokes after GC completes.

### Suggested Fix

Reorder the conditions: check gcDialogState.done !== undefined first (before y/Enter/n/Esc branches) and dispatch gc-cancel immediately, so any key closes the done screen as the rendered hint promises.

---

## BUG-077 ✅ FIXED — isHotkeyEnabled returns false for r on phase-view, contradicting dispatchHotkey

**Area:** overlay / hotkeys
**Severity:** low
**Location:** hotkeys.ts — isHotkeyEnabled case 'r' (~line 160)
**Discovered:** iteration-2

### Description

isHotkeyEnabled has an early return `if (input.view !== 'runs-list') return false` for key r, so it returns false for phase-view regardless of runState. But dispatchHotkey({ key: 'r', view: 'phase-view', runState: 'paused' }) returns { kind: 'resume' } — an enabled, meaningful action. helpForState computes phase-view help directly (not via isHotkeyEnabled) so the rendered help is correct, but any consumer (tests, future guards) using isHotkeyEnabled as a gate would incorrectly suppress the r/resume action on paused phase-view runs.

### Suggested Fix

Replace the blanket `if (input.view !== 'runs-list') return false` with view-specific logic mirroring dispatchHotkey: allow phase-view for paused (resume) and terminal (restart) states; keep runs-list constraint for restart-requested only.

---

## BUG-078 ✅ FIXED — g key opens GC dialog from phase-view and agent-detail views

**Area:** overlay / hotkeys
**Severity:** low
**Location:** hotkeys.ts — dispatchHotkey g branch (~line 210) and overlay.ts — handleKey view routing (~line 425)
**Discovered:** iteration-2

### Description

dispatchHotkey returns { kind: 'open-gc-dialog' } for key g regardless of view. The no-selection guard has an explicit k !== 'g' carve-out that lets g through in all views. handleKey in overlay.ts routes phase-view and agent-detail keystrokes through dispatchHotkey without a view pre-filter, so pressing g while inspecting an agent's detail or a run's phases unexpectedly opens the GC dialog. isHotkeyEnabled correctly gates g to runs-list but is not consulted in the dispatch path.

### Suggested Fix

In dispatchHotkey, add a view guard before returning open-gc-dialog: if (input.view !== 'runs-list') return { kind: 'noop', reason: 'disabled-for-state' }.

---

## BUG-079 ✅ FIXED — writeResultFile tmp filename lacks random suffix — same-millisecond concurrent calls share identical tmp path

**Area:** runtime / resultDelivery
**Severity:** medium
**Location:** src/runtime/resultDelivery.ts — writeResultFile, line: `const tmp = join(runDirAbs, \`result.json.tmp-${process.pid}-${Date.now()}\`)`
**Discovered:** iteration-2

### Description

writeResultFile builds its temp path as `result.json.tmp-${process.pid}-${Date.now()}`. Two concurrent calls in the same process within the same millisecond produce identical tmp paths. Both callers race-write to the same file; whichever fs.rename fires second wins while the first caller's data is silently replaced. Every other atomic-write site in the codebase (trustStore.ts addTrustUnlocked, manifestWriter.ts writeParentLivenessFields) appends randomBytes(4).toString('hex') to prevent exactly this. resultDelivery.ts is the only site that omits it. The docstring says 'Idempotent — caller may invoke twice' but conflates sequential idempotency with concurrent safety.

### Suggested Fix

Append a randomBytes(4).toString('hex') suffix identical to the pattern in manifestWriter.ts: `` result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')} ``; import randomBytes from node:crypto.

---

## BUG-080 ✅ FIXED — writeResultFile uses fs.writeFile without fsync — result.json silently losable on power failure

**Area:** runtime / resultDelivery
**Severity:** medium
**Location:** src/runtime/resultDelivery.ts — writeResultFile function (await fs.writeFile + await fs.rename block)
**Discovered:** iteration-2

### Description

writeResultFile calls `await fs.writeFile(tmp, body, 'utf8')` followed by `await fs.rename(tmp, target)` with no fsync of the tmp file. fs.writeFile drains to the OS page cache but makes no durability guarantee. A power loss between the OS accepting the write and flushing it to stable storage leaves an empty or partial tmp that gets atomically renamed into place — the caller sees no error, yet result.json is corrupt or zero-length. cache.ts is explicitly designed around openSync/writeSync/fsyncSync/closeSync for this reason. result.json is the primary persisted output of a run; losing it silently after the run 'succeeds' breaks `/workflows show` and any downstream consumer of the file. The comment 'result.json write failure is non-fatal' addresses I/O errors, not silent kernel-buffer loss.

### Suggested Fix

After writeFile and before rename, open the file and fsyncSync it (mirror the pattern in cache.ts appendLineSync), or use the open/write/fsync/close idiom directly so the durability guarantee is explicit.

---

## BUG-081 ✅ FIXED — writeParentLivenessFields uses fs.writeFile without fsync — manifest.json durability gap

**Area:** runtime / manifestWriter
**Severity:** medium
**Location:** src/runtime/manifestWriter.ts — writeParentLivenessFields function (await fs.writeFile + await fs.rename block)
**Discovered:** iteration-2

### Description

writeParentLivenessFields writes manifest.json via `await fs.writeFile(tmpName, json, 'utf8')` then `await fs.rename(tmpName, target)` with no fsync. Identical durability gap to BUG-080. A power loss after the OS accepts the write but before flush leaves a zero-length or partial manifest.json. The code path deliberately creates the run directory and writes the partial manifest as the very first durable record of a run; if that record is silently lost, the orphan run directory has no manifest and recovery logic may misclassify or discard the run. cache.ts fsyncs every append; the manifest writer does not.

### Suggested Fix

Add an fsync step after writeFile and before rename, matching the pattern established in cache.ts. Because the tmp file already includes randomBytes for collision safety, only the fsync step is missing.

---

## BUG-082 ✅ FIXED — cancelReasonText returns 'approval denied' when decision.approved is true — incorrect audit text

**Area:** runtime / resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — cancelReasonText function, line: `if (decision.approved) return 'approval denied'`
**Discovered:** iteration-2

### Description

cancelReasonText contains `if (decision.approved) return 'approval denied'`. If a RunResultFile is somehow written with outcome='cancelled-pre-run' AND approval.approved=true (e.g., a bug upstream sets the wrong outcome, or the fields are assembled inconsistently), the card footer and result.json both display 'approval denied' — which is the opposite of the truth and will mislead any audit. The correct response for an impossible-but-reachable branch is either a defensive assertion or a clearly labeled fallback string. The function should never silently mis-state the approval decision.

### Suggested Fix

Replace the approved=true guard with `if (decision.approved) return '(unexpected: approved=true on cancelled run)'` or throw an assertion error so the upstream inconsistency is surfaced rather than hidden.

---

## BUG-083 ✅ FIXED — loadTrust sha256 dedup keeps personal entry when project has same sha256 — contradicts 'project wins' contract

**Area:** runtime / trustStore
**Severity:** low
**Location:** src/runtime/trustStore.ts — loadTrust function, inner loop over Object.entries(project)
**Discovered:** iteration-2

### Description

loadTrust seeds `merged` with personal rows first, then iterates project rows and skips any whose sha256 is already in `seenShas`. When both personal and project contain a row for the same (absPath, sha256) but with different names, the personal row is kept and the project row is dropped. The function comment and inline comment both state 'Project entries win … project rows taking precedence at lookup time', but the implementation preserves the personal name. For the boolean isTrustedIn check this is benign (sha256 match returns true regardless). For any consumer that iterates rows to display or audit the trust entry's name (e.g. overlay UI, `--list-trusted` introspection), the personal name is shown instead of the project name, violating the PRD §7 precedence rule.

### Suggested Fix

Iterate project rows first (seeding `merged` with project entries), then iterate personal rows and skip sha256s already present from project, so project rows win on conflict consistently.

---

## BUG-084 ✅ FIXED — captureParentLiveness calls process.hrtime.bigint with wrong this context

**Area:** runtime / manifestWriter
**Severity:** low
**Location:** src/runtime/manifestWriter.ts — captureParentLiveness function, line: `const ht = (argv.hrtimeBigint ?? process.hrtime.bigint).call(process.hrtime)`
**Discovered:** iteration-2

### Description

captureParentLiveness calls `(argv.hrtimeBigint ?? process.hrtime.bigint).call(process.hrtime)`, passing `process.hrtime` as the `this` receiver. The correct receiver is `process` (i.e., `process.hrtime.bigint()` or `.call(process)`). `process.hrtime` is the outer namespace object, not the object that owns `bigint`. This works in current Node.js because hrtime.bigint ignores its `this`, but it is semantically incorrect and fragile against future Node.js internals changes or stricter receiver checks. Additionally, a test-supplied `argv.hrtimeBigint` arrow function would silently receive the wrong `this`, making the seam harder to reason about.

### Suggested Fix

Change to `const ht = argv.hrtimeBigint ? argv.hrtimeBigint() : process.hrtime.bigint()` — call the override directly, call the default with no `.call` override.

---

## BUG-085 ✅ FIXED — deliverRunResult pi API calls not awaited inside try/catch — async rejections escape unhandled

**Area:** runtime / resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — deliverRunResult function, all three pi.sendMessage / pi.appendEntry / pi.sendUserMessage call sites
**Discovered:** iteration-2

### Description

sendMessage, appendEntry, and sendUserMessage are each called without await inside bare try/catch blocks. If any of these methods return a rejected Promise (e.g., the pi host shuts down mid-delivery, the IPC channel is closed), the rejection is unhandled — the try/catch catches only synchronous throws, not async rejections. In Node.js ≥15 an unhandled rejection terminates the process by default, which would kill the pi workflow process after delivery instead of swallowing the error as intended. The comment 'swallow — best-effort surface' documents the intent but the implementation does not achieve it for async APIs.

### Suggested Fix

Either await each call inside its try/catch block (`try { await opts.pi.sendMessage(...) } catch { }`) or explicitly void the returned Promise with an attached .catch noop (`void Promise.resolve(opts.pi.sendMessage(...)).catch(() => {})`).

---

## BUG-086 ✅ FIXED — ctx.pipeline undocumented in runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md (missing section); src/runtime/writeWorkflowTool.ts lines 183, 232-238
**Discovered:** iteration-2

### Description

ctx.pipeline(items, ...stages) is fully implemented in stdlib.ts, typed in public.d.ts, and featured prominently in writeWorkflowTool.ts promptSnippet and promptGuidelines — but is completely absent from runtime-api.md. Authors following the API reference cannot discover this method exists.

### Suggested Fix

Add a `ctx.pipeline` section to runtime-api.md documenting the signature `pipeline(items, ...stages)`, stage callback signature `(prev, original, index)`, and a usage example mirroring the promptSnippet.

---

## BUG-087 ✅ FIXED — ctx.budget undocumented in runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md (missing section); src/runtime/writeWorkflowTool.ts line 246; src/types/public.d.ts lines 186-196
**Discovered:** iteration-2

### Description

ctx.budget (with .total, .spent(), .remaining()) is typed in public.d.ts, wired in sandbox.ts, and used in writeWorkflowTool.ts promptSnippet — but is completely absent from runtime-api.md. Authors have no way to discover or correctly use the token budget tracker from the docs alone.

### Suggested Fix

Add a `ctx.budget` section to runtime-api.md documenting the three members: `total: number | null`, `spent(): number`, `remaining(): number`, with a short example.

---

## BUG-088 ✅ FIXED — ctx.phase third argument (failMode) missing from runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md ctx.phase section; src/runtime/runCtx.ts lines 188-234; src/types/public.d.ts line 138
**Discovered:** iteration-2

### Description

ctx.phase accepts an optional third options argument `{ failMode: 'throw' | 'null' }` that is implemented in runCtx.ts, typed in public.d.ts, referenced in writeWorkflowTool.ts promptGuidelines ('Pass `{ failMode: "null" }` as third arg'), and even generates a runtime warning when omitted on large phases — but runtime-api.md shows only a two-argument signature with no mention of the third arg.

### Suggested Fix

Update the ctx.phase signature in runtime-api.md to `phase(name, agents, opts?)`, document PhaseOpts with `failMode: 'throw' | 'null'` (default 'throw'), explain partial-failure semantics, and add a resilient-phase example.

---

## BUG-089 ✅ FIXED — schema option missing from AgentOpts in runtime-api.md

**Area:** docs
**Severity:** medium
**Location:** docs/runtime-api.md AgentOpts section; src/types/public.d.ts line 50
**Discovered:** iteration-2

### Description

AgentOpts.schema is typed in public.d.ts (line 50) and AgentResult.output mentions 'set when opts.schema was provided to ctx.agent()' — but the AgentOpts interface in runtime-api.md omits schema entirely. Authors reading only the docs will not know they can get structured/parsed output from agents.

### Suggested Fix

Add `schema?: Record<string, unknown>` to the AgentOpts table in runtime-api.md with a description explaining that it causes the agent to return parsed JSON in result.output. Add a short example showing schema usage paired with result.output access.

---

## BUG-090 ✅ FIXED — Canonical examples missing required export const meta

**Area:** examples
**Severity:** high
**Location:** examples/codebase-audit/codebase-audit.js (no meta export); examples/hello/hello.js (no meta export)
**Discovered:** iteration-2

### Description

Both examples/codebase-audit/codebase-audit.js and examples/hello/hello.js lack `export const meta = { name, description, version }`. writeWorkflowTool.ts validates this as mandatory (hasMetaFirst check), and the SKILL.md documents it as a requirement. If a user submits either example via write_workflow it will fail validation with 'Script must start with export const meta'.

### Suggested Fix

Add `export const meta = { name: 'codebase-audit', description: '...', version: '1.0.0' }` as the first meaningful statement in codebase-audit.js, and similarly for hello.js with name 'hello'.

---

## BUG-091 ✅ FIXED — codebase-audit.js inlines large findings JSON into voter prompts — violates documented anti-pattern

**Area:** examples
**Severity:** medium
**Location:** examples/codebase-audit/codebase-audit.js lines for the vote phase; skills/pi-workflows/SKILL.md anti-pattern section
**Discovered:** iteration-2

### Description

codebase-audit.js serializes allFindings to `findingsJson = JSON.stringify(allFindings, null, 2)` then interpolates it inline into 3 parallel voter agent prompts. SKILL.md explicitly warns: 'Never inline file contents in prompts — causes context crashes on large files'. On a large repo this is the most token-heavy phase (3 agents × all findings). The canonical reference implementation teaches the exact anti-pattern it documents against.

### Suggested Fix

Cache allFindings to disk via ctx.cache.set and tell voter agents to read from the cache key or a temp file, or truncate findings passed inline to a safe size (e.g. top 30 by severity) with a count summary.

---

## BUG-092 ✅ FIXED — authoring.md section 5 cites wrong example path

**Area:** docs
**Severity:** low
**Location:** docs/authoring.md section 5 (Walking through /codebase-audit), last line
**Discovered:** iteration-2

### Description

authoring.md section 5 says 'See `examples/codebase-audit.js` for the full source' but the actual file lives at `examples/codebase-audit/codebase-audit.js`. The flat path does not exist.

### Suggested Fix

Change the path reference to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-093 ✅ FIXED — ctx.log level silently dropped when called with opts-object form

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts logFn lines 655-659; docs/runtime-api.md ctx.log section; examples/codebase-audit/codebase-audit.js warn log call
**Discovered:** iteration-2

### Description

The public API signature (runtime-api.md and public.d.ts) is `log(message: string, opts?: { level?: 'info'|'warn'|'error' })`. But the bridge logFn checks `levelArg === 'warn'` not `levelArg?.level === 'warn'`. Calling `ctx.log(msg, { level: 'warn' })` passes `{ level: 'warn' }` as levelArg; the equality check fails and the level silently defaults to 'info'. codebase-audit.js uses exactly this form, so all its warn-level logs are silently emitted as info. The bridge implementation and the public type are mismatched.

### Suggested Fix

Fix logFn to: `const level = (typeof levelArg === 'string' ? levelArg : (levelArg as any)?.level) ?? 'info'` to handle both the opts-object form and a direct string. Or update the public type to `log(message: string, level?: 'info'|'warn'|'error')` and update docs + examples to match.

---

## BUG-094 ✅ FIXED — writeWorkflowTool promptGuidelines tells LLM 'workflow is already running' when it may not be

**Area:** runtime / writeWorkflowTool
**Severity:** low
**Location:** src/runtime/writeWorkflowTool.ts promptGuidelines last entry (around line 192); result card text in execute() function
**Discovered:** iteration-2

### Description

The last entry in writeWorkflowTool.ts promptGuidelines says 'tell the user the workflow was saved and is already running — direct them to /workflows to monitor progress.' But the tool's result card reads 'It's now registered. Open /workflows to launch and monitor it.' when startRun is not wired. The LLM is instructed to assert running status that the tool result itself contradicts, leading to misleading user-facing summaries.

### Suggested Fix

Change the promptGuideline to 'tell the user the workflow was saved and registered as a slash command, then invite them to open /workflows to launch and monitor it.' Remove the 'already running' assertion.

---

## BUG-W03 ✅ FIXED (addressed) — Workflow: fix agents timeout waiting for API capacity, not doing work

**Area:** dispatcher / workflow authoring  
**Severity:** High — majority of agents silently killed before executing  
**Location:** `src/runtime/dispatcher.ts:362` (`timeoutMs ?? 600_000`)  
**Discovered:** iteration-1 post-mortem  

### Description

When a phase spawns many agents simultaneously (e.g. 38), they all compete for
API rate limit capacity. The 600s default timeout starts at subprocess spawn, not
at first API response. Agents that queue behind rate-limited requests are killed
after 600s having never executed a single tool call (their transcript contains only
the session header line). In fix-1, 32/38 agents were killed this way.

### Suggested Fix

Two complementary fixes:
1. For the workflow: pass `{ timeoutMs: 1_800_000 }` (30 min) on fix agents that
   need to read multiple files and make edits.
2. In the dispatcher: the timeout should reset (or not start) until the subprocess
   writes its first non-session event, giving queued agents a fair window once they
   actually get API capacity.

---

## BUG-W04 ✅ FIXED — `agent_start` ledger event logged before semaphore acquire

**Area:** `src/runtime/runCtx.ts`  
**Severity:** Low — misleading timing in TUI and logs  
**Location:** `src/runtime/runCtx.ts`, phase execution loop  
**Discovered:** iteration-1 post-mortem  

### Description

`agent_start` is appended to the ledger before `semaphore.acquire()`. With
`maxConcurrent=16` and 38 agents, all 38 show `started+0s` in the ledger even
though only 16 are actually running. The TUI phase view and any tooling that reads
the ledger will report 38 agents as "started" when 22 are still queued. This makes
it impossible to distinguish queued agents from running ones.

### Suggested Fix

Add a `queued` vs `running` distinction: log `agent_queued` before semaphore
acquire and `agent_start` after. Or keep current semantics but document the
behaviour clearly.

---

## BUG-W05 ✅ FIXED (addressed) — No per-agent `timeoutMs` guidance in docs or promptSnippet

**Area:** docs / `writeWorkflowTool.ts`  
**Severity:** Medium — common authoring footgun with no warning  
**Location:** `docs/authoring.md`, `src/runtime/writeWorkflowTool.ts` (promptSnippet)  
**Discovered:** iteration-1 post-mortem  

### Description

The default 600s timeout is appropriate for quick summarisation tasks but far too
short for agents doing multi-file reads + edits. The `timeoutMs` option on
`ctx.agent()` is the fix, but it appears nowhere in the authoring guide, the
promptSnippet shown to LLMs, or the skill file. Authors routinely omit it and lose
all their work silently.

### Suggested Fix

Add to `docs/authoring.md` a section on timeouts with a concrete example:
```js
ctx.agent(`Fix this bug...`, { timeoutMs: 30 * 60 * 1000 }) // 30 min for file edits
```
Add the same example to the `writeWorkflowTool.ts` promptSnippet and the
pi-workflows SKILL.md.

---

## BUG-095 ✅ FIXED (duplicate) — ctx.log level option silently ignored — all logs emit at info

**Area:** Runtime / Sandbox
**Severity:** High
**Location:** `src/runtime/runCtx.ts` logFn (levelArg check) + `src/runtime/sandbox.ts` wrapHostSync wiring
**Discovered:** iteration-3

### Description

wrapHostSync passes args through verbatim via Reflect.apply. When an author calls ctx.log(msg, { level: 'warn' }), the host's logFn receives the full opts object { level: 'warn' } as its levelArg parameter. The guard `levelArg === 'warn' || levelArg === 'error'` always fails (object !== string), so every ctx.log call defaults to level 'info' regardless of what the author passed. Warn and error severities are silently dropped.

### Suggested Fix

Change logFn to accept opts: { level?: string } as second argument and extract level via `(opts as Record<string,unknown>)?.level`, or add a level-extraction shim in the sandbox's ctx.log wrapper before calling the host.

---

## BUG-096 ✅ FIXED (duplicate) — ctx.retry maxAttempts in runtime-api.md vs attempts in implementation — silent ignore

**Area:** Runtime / stdlib
**Severity:** High
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE retry() + `docs/runtime-api.md` §ctx.retry
**Discovered:** iteration-3

### Description

runtime-api.md documents the option as `maxAttempts` (example: `{ maxAttempts: 5, backoffMs: 1000 }`), but the implementation reads `opts.attempts`. Authors following the docs who write `{ maxAttempts: 5 }` will silently get the default 3 attempts. The option is consumed without error but has no effect.

### Suggested Fix

Align the docs: rename `maxAttempts` to `attempts` in runtime-api.md and its code example, or make the implementation accept both (read `opts.maxAttempts ?? opts.attempts` with a deprecation note).

---

## BUG-097 ✅ FIXED (duplicate) — ctx.consensus result shape mismatch — docs promise scores field, impl returns responses

**Area:** Runtime / stdlib
**Severity:** High
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE consensus() + `docs/runtime-api.md` §ctx.consensus
**Discovered:** iteration-3

### Description

runtime-api.md documents ConsensusResult as having `scores: ReadonlyArray<{ agentId: string; meanSimilarity: number }>`. The implementation returns `{ agreed, majorityText, responses: string[] }` — no `scores` field. Any author who writes `result.scores` gets `undefined`. The agentId per-score shape requires tracking which agent produced each result, but the implementation only tracks array indices. public.d.ts correctly uses `responses`, but the runtime-api.md is the primary author-facing reference.

### Suggested Fix

Update runtime-api.md to show the actual ConsensusResult shape (responses: string[]) and remove the scores field, or implement scores by carrying agentId through the results map.

---

## BUG-098 ✅ FIXED (duplicate) — extractJson throws on schema parse failure — creates persistent failure loop

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` extractJson, runOneAgent cache-hit path (line ~501) and cache-miss path (line ~588)
**Discovered:** iteration-3

### Description

AgentResult.output is typed as `output?: unknown` with documented semantics 'Undefined otherwise'. extractJson throws (`no JSON found in agent output` or a SyntaxError from JSON.parse) instead of returning undefined when the agent output doesn't contain valid JSON. In the cache-miss path, if extractJson throws AFTER the result is successfully cached, the agent_error is logged, the phase fails — but on the next run the cache hit path calls extractJson again on the same text and fails again. The workflow is permanently stuck: the agent is never re-dispatched (cache hit) but always errors.

### Suggested Fix

Wrap extractJson calls in try-catch and return undefined on failure (honoring the 'undefined otherwise' contract). Consider logging a warn-level ledger entry so the author knows the schema didn't parse.

---

## BUG-099 ✅ FIXED (duplicate) — extractJson fence regex matches first fence not last — wrong JSON when agent includes examples

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` extractJson
**Discovered:** iteration-3

### Description

extractJson tries a fence regex first: `` /```json\s*([\s\S]*?)```/.exec(text) `` which returns the FIRST match. When an agent includes an example JSON block early in its response followed by the actual output block at the end (as instructed by buildSchemaInstruction), the first (example) block is parsed instead of the last (output). The lastIndexOf fallback correctly uses the last occurrence but the fence path is inconsistent.

### Suggested Fix

Replace `.exec(text)` with a global match (`` /```json\s*([\s\S]*?)```/g ``) and take the last capture group, consistent with the lastIndexOf fallback strategy.

---

## BUG-100 ✅ FIXED — budgetSpent charges cached token usage — cache replays can exhaust the token budget

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` runOneAgent cache-hit path (~line 482)
**Discovered:** iteration-3

### Description

In the cache-hit path of runOneAgent, `budgetSpent += result.usage.totalTokens` is executed using the token counts stored from the original dispatch. No real tokens are consumed on a cache hit, but the budget counter is decremented by the original cost. A workflow running entirely from cache can exhaust its token budget and start throwing 'token budget exhausted' errors on subsequent non-cached agents, even though zero real tokens were spent in the current run.

### Suggested Fix

Skip `budgetSpent` accumulation on cache hits, or only count cached tokens against a separate 'replay' counter that does not affect the enforcement gate.

---

## BUG-101 ✅ FIXED — timeoutMs included in opts hash for cache key — innocent timeout changes invalidate valid cache entries

**Area:** Runtime / cache
**Severity:** Medium
**Location:** `src/util/hash.ts` cacheKey + `src/runtime/runCtx.ts` runOneAgent
**Discovered:** iteration-3

### Description

cacheKey hashes the full opts object (canonicalJson(opts)), which includes timeoutMs. Changing only the per-agent timeout (e.g. from 30000 to 60000) produces a different hash and causes a cache miss, dispatching a fresh agent even though the prior result is completely reusable. timeoutMs is an execution constraint, not a content determinant — only model, thinking, and cacheKeyExtra should influence the cache key.

### Suggested Fix

Strip execution-constraint fields (timeoutMs, at minimum) from the opts object before computing optsHash, or maintain an explicit allowlist of cache-key-relevant opts fields (model, thinking, cacheKeyExtra).

---

## BUG-102 ✅ FIXED (duplicate) — ctx.consensus similarity option in runtime-api.md silently ignored — single threshold does double duty

**Area:** Runtime / stdlib / docs
**Severity:** Medium
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE consensus() + `docs/runtime-api.md` §ctx.consensus
**Discovered:** iteration-3

### Description

runtime-api.md documents ConsensusOpts as having two independent parameters: `threshold` (fraction of pairs that must agree) and `similarity` (Jaccard floor per pair). The implementation uses a single `threshold` for both purposes: pair similarity is compared against `threshold` AND the ratio is compared against `threshold`. Passing `{ threshold: 0.8, similarity: 0.5 }` silently ignores `similarity`. The default threshold is also inconsistent: public.d.ts comment says 0.6, runtime-api.md says 0.5.

### Suggested Fix

Either document that a single threshold controls both dimensions, or implement separate `threshold`/`similarity` params and update the type in public.d.ts.

---

## BUG-103 ✅ FIXED (duplicate) — schema extractJson failure logged as agent_error in ledger — misleading error attribution

**Area:** Runtime / runCtx / ledger
**Severity:** Low
**Location:** `src/runtime/runCtx.ts` runOneAgent catch block (~line 600) + extractJson invocation (~line 588)
**Discovered:** iteration-3

### Description

When extractJson throws in the cache-miss path of runOneAgent (inside the try block that also covers the dispatch), the catch block logs an agent_error ledger entry. The agent itself ran successfully; the error is in post-processing (JSON extraction). This pollutes error tracking and monitoring — the ledger shows agent failure when the actual failure was a schema mismatch in the host runtime. It also causes the result to be cached (setAgentResult runs before extractJson) while the ledger records an error for the same agent.

### Suggested Fix

Move extractJson call to after the try/catch/finally block (or to a separate try-catch that emits a schema_parse_error ledger type), decoupled from agent dispatch errors.

---

## BUG-104 ✅ FIXED (duplicate) — retry backoffMs default mismatch between docs and implementation

**Area:** Runtime / stdlib / docs
**Severity:** Low
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE retry() + `docs/runtime-api.md` §ctx.retry
**Discovered:** iteration-3

### Description

runtime-api.md documents the backoffMs default as 500ms (`// initial backoff in ms (default 500)`). The implementation defaults to 100ms. public.d.ts comment says 100 (matches implementation). Authors relying on the API reference docs will expect 500ms delays between retries and be surprised by faster retries than documented.

### Suggested Fix

Update runtime-api.md to say default 100ms, or change the implementation default to 500ms for consistency with the documented value.

---

## BUG-105 ✅ FIXED (duplicate) — ctx.phase failMode option entirely absent from runtime-api.md

**Area:** Docs
**Severity:** Low
**Location:** `docs/runtime-api.md` §ctx.phase
**Discovered:** iteration-3

### Description

runtime-api.md shows ctx.phase with only 2 parameters (`phase(name, handles)`) and a return type of `Promise<ReadonlyArray<AgentResult>>`. The PhaseOpts third parameter and failMode:'null' behavior (returning null entries for failed agents instead of throwing AggregateError) are not documented at all. Authors reading the reference docs cannot discover this feature, and the return type mismatch (docs omit the `| null`) could cause type confusion when failMode:'null' is eventually found via public.d.ts.

### Suggested Fix

Add PhaseOpts documentation to the ctx.phase section, document failMode:'throw' vs 'null' semantics, and update the return type to show ReadonlyArray<AgentResult | null>.

---

## BUG-106 ✅ FIXED — Reflect namespace not frozen — Reflect.apply poisonable at runtime

**Area:** Sandbox / Security
**Severity:** High
**Location:** `sandbox.ts` buildInitScript() — prototype freeze block at end of init script; also wrapHostMethod and wrapHostAsync definitions in the same init script body
**Discovered:** iteration-3

### Description

The init script freezes Object.prototype, Function.prototype, and other intrinsics per PRD §8.3.2, but never calls Object.freeze(Reflect). Every ctx bridge method (ctx.phase, ctx.cache.*, ctx.agent, ctx.finishCallback) delegates through wrapHostMethod or wrapHostAsync, both of which call Reflect.apply(host, this, args) at invocation time — not at wrap time. A script that runs `Reflect.apply = () => ({ok:true,value:null})` before calling any ctx method will silently no-op every bridge call, faking successful returns without executing any host logic. A logging variant can also exfiltrate the host-realm function references passed as the first argument.

### Suggested Fix

Add `Object.freeze(Reflect);` to the prototype-freeze block in buildInitScript(), immediately after `Object.freeze(Math);`. Also consider capturing a local alias `const __reflect_apply = Reflect.apply;` at the top of the init script and replacing all wrapHostMethod/wrapHostAsync callsites to use `__reflect_apply` directly, so even a post-freeze mutation is pre-empted.

---

## BUG-107 ✅ FIXED (duplicate) — fireCtxAbort abort listener never removed from hostSignal on successful completion

**Area:** Sandbox / Memory
**Severity:** Medium
**Location:** `sandbox.ts` Sandbox.runScript() — the hostSignal.addEventListener call around line 570, and the Sandbox.dispose() method
**Discovered:** iteration-3

### Description

In runScript(), the host-to-context signal bridge is wired via `hostSignal.addEventListener('abort', fireCtxAbort, { once: true })`. On the SUCCESS path, raceWithAbort() cleans up its own inner `onAbort` listener, but the outer `fireCtxAbort` registered directly on hostSignal is never removed. The { once: true } flag only auto-removes it when the signal fires; if the script completes normally and the signal never fires, the listener remains registered indefinitely. The closure captures `signalAbortThunk` (a Context-realm function), which in turn holds a reference to the Context's internal abort listeners array — preventing GC of the vm.Context even after dispose() is called. dispose() cannot fix this because fireCtxAbort is a per-call local, not a class field.

### Suggested Fix

Track the fireCtxAbort listener as a class field (e.g. `private _abortListener: (() => void) | null = null`). After raceWithAbort resolves (in a finally block), call `hostSignal.removeEventListener('abort', this._abortListener)` and null it out. Alternatively, restructure so a single per-Sandbox abort listener is registered in the constructor and cleaned in dispose().

---

## BUG-108 ✅ FIXED — AsyncFunction.prototype and GeneratorFunction.prototype not frozen

**Area:** Sandbox / Security
**Severity:** Medium
**Location:** `sandbox.ts` buildInitScript() — prototype freeze block at end of init script
**Discovered:** iteration-3

### Description

The init script's prototype-freeze block covers Function.prototype, Promise.prototype, and the collection types, but does NOT freeze AsyncFunction.prototype or GeneratorFunction.prototype (or their async-generator counterpart). These are reachable from inside the sandbox: `Object.getPrototypeOf(async function(){})` returns the AsyncFunction constructor, and `.prototype` gives its prototype. User code can add a `then` property to `AsyncFunction.prototype`, making every async function object in the sandbox thenable. stdlib helpers (vote, parallel, retry, sleep) are async functions — adding a poisoned `then` trap on their prototype can cause callers that do `await ctx.vote` (without invoking it) to get unexpected resolution. More broadly, arbitrary property injection on the AsyncFunction prototype leaks into all closure-captured stdlib helper instances.

### Suggested Fix

Add the following lines to the freeze block: `Object.freeze(Object.getPrototypeOf(async function(){}));` and `Object.freeze(Object.getPrototypeOf(function*(){}));` and `Object.freeze(Object.getPrototypeOf(async function*(){}));` — capturing each constructor's prototype before user code can touch it.

---

## BUG-109 ✅ FIXED — __pi_clone_into_ctx silently drops undefined values via JSON round-trip

**Area:** Sandbox
**Severity:** Medium
**Location:** `sandbox.ts` buildInitScript() — __pi_clone_into_ctx function definition in the init script string
**Discovered:** iteration-3

### Description

The __pi_clone_into_ctx function (defined in buildInitScript) uses JSON.parse(JSON.stringify(value)) for all object/array values. This has two silent data-loss behaviors: (1) object keys whose values are undefined are omitted entirely from the clone — e.g. {a: undefined, b: 1} becomes {b: 1}; (2) undefined elements in arrays become null — e.g. [undefined, 1] becomes [null, 1]. Any host bridge method that returns an ok:true envelope with a value containing undefined fields (for example a cache.get returning a sparse record, or phase results with optional undefined properties) will silently deliver a structurally different object to the script. Additionally, if a host method returns a value containing a circular reference, JSON.stringify throws a TypeError inside the Context, which surfaces as an unexpected ctx bridge failure rather than a clear 'circular value' error.

### Suggested Fix

Replace the JSON round-trip with a recursive structured-clone that preserves undefined (using a manual walk or a Context-realm structuredClone if available). At minimum, document the undefined-stripping as a known gap and add an explicit circular-reference guard with a descriptive error message.

---

## BUG-110 ✅ FIXED — Shape C second export-async-function regex replace is dead code

**Area:** Sandbox
**Severity:** Low
**Location:** `sandbox.ts` detectShape() — Shape C branch, the two-step .replace() chain
**Discovered:** iteration-3

### Description

In detectShape(), the Shape C transform applies two sequential .replace() calls on the source string. The first regex — `/^(\s*)export\s+(const|let|var|async\s+function|function)\s/gm` — already handles `export async function` via the `async\s+function` alternation in group 2, correctly producing `async function` in the replacement. The second regex — `/^(\s*)export\s+(async)\s+(function)\s/gm` — targets `export async function` in the already-transformed string, but those patterns were already consumed by the first pass. The second replace is always a no-op. The comment 'Ensure async function is preserved correctly after stripping export async function' is therefore misleading.

### Suggested Fix

Remove the second .replace() call and its comment. Optionally add a test asserting that `export async function main(ctx)` is correctly transformed to `async function main(ctx)` by the first replace alone.

---

## BUG-111 ✅ FIXED — globalThis.budget convenience alias is mutable and can be poisoned across runs

**Area:** Sandbox / Security
**Severity:** Low
**Location:** `sandbox.ts` buildInitScript() — the `globalThis.budget = ctx.budget;` line at the end of __pi_build_ctx
**Discovered:** iteration-3

### Description

At the end of __pi_build_ctx (in buildInitScript), `globalThis.budget = ctx.budget` installs a writable, configurable convenience alias on the Context's globalThis. Since globalThis is intentionally not frozen, user code can delete, overwrite, or replace globalThis.budget during a run. If the same Sandbox instance is used for multiple runScript() calls, a prior run's script could have set `globalThis.budget = null` or `Object.defineProperty(globalThis, 'budget', {get: () => Infinity})`. The next runScript() call rebuilds ctx.budget correctly inside __pi_build_ctx (the closure is fresh), but globalThis.budget is then overwritten with the new value. During that new run, any user code that reads globalThis.budget directly (instead of ctx.budget) sees the correct value — but mid-execution mutation of globalThis.budget is undetected and silently diverges from ctx.budget.

### Suggested Fix

Either use Object.defineProperty with writable:false and configurable:false to make the alias read-only, or remove the globalThis.budget alias entirely and require authors to access budget via ctx.budget. The ctx object itself is frozen, so ctx.budget is safe.

---

## BUG-112 ✅ FIXED (duplicate) — Dead code: `approved`/`pending` state-reset branches in `resumeRun` are unreachable

**Area:** Runtime / resumeRun
**Severity:** High
**Location:** `src/runtime/resumeRun.ts` — resumeRun(), the `else if (finalState === 'approved')` and `else if (finalState === 'pending')` blocks after lock acquisition
**Discovered:** iteration-3

### Description

In `resumeRun.ts`, the resumability gate checks `RESUMABLE_STATES.has(finalState)` (which only contains `'paused'` and `'running'`) and throws `ResumeNotAllowedError` for everything else that isn't `failed`. The `else if (finalState === 'approved')` and `else if (finalState === 'pending')` state-reset branches that follow later in the function (after lock acquisition) can never be reached — execution always throws before them. If the original intent was to support resuming `approved`/`pending` runs, `RESUMABLE_STATES` must include those states. As-is, a run stuck at `approved` (e.g., due to a crash during the approved→running transition) cannot be resumed.

### Suggested Fix

Either add `'approved'` and `'pending'` to `RESUMABLE_STATES` in `ledger.ts` and document the recovery intent, or delete the two dead branches and add a comment explaining those states are intentionally non-resumable.

---

## BUG-113 ✅ FIXED — TOCTOU race: ledger is read before the resume lock is acquired, `finalState` can be stale

**Area:** Runtime / resumeRun
**Severity:** High
**Location:** `src/runtime/resumeRun.ts` — resumeRun(), ledger read (~line 90) precedes `acquireResumeLock` call (~line 130)
**Discovered:** iteration-3

### Description

In `resumeRun.ts`, the ledger is read and `finalState` is derived, then the resumability check runs, and only after that is `acquireResumeLock` called. Between the ledger read and the lock acquisition another pi process can acquire the lock, append new transitions (including reaching a terminal state), and release its lock. `resumeRun` then proceeds with a stale `finalState` — potentially resuming a run that is already `done`, `stopped`, or concurrently running. The lock is supposed to prevent this, but it only guards after the state has already been consumed.

### Suggested Fix

Move `acquireResumeLock` before `reader.read()`, or re-read the ledger immediately after acquiring the lock and re-run the resumability check with the fresh state.

---

## BUG-114 ✅ FIXED (duplicate) — Inner SIGKILL escalation timer is never cancelled after child exits cleanly post-SIGTERM

**Area:** Runtime / dispatcher
**Severity:** Medium
**Location:** `src/runtime/dispatcher.ts` — `dispatchAgent()`, the nested `setTimeout` inside `timeoutHandle`'s callback
**Discovered:** iteration-3

### Description

In `dispatchAgent`, when the subprocess timeout fires it sends SIGTERM and schedules an inner `killHandle = setTimeout(() => child.kill('SIGKILL'), 5000)`. The outer `timeoutHandle` is cleared via `clearTimeout(timeoutHandle)` at the end of the dispatch, but `killHandle` is never stored or cancelled. If the child exits cleanly within the 5-second SIGTERM grace window, `killHandle` fires anyway and calls `child.kill('SIGKILL')` on the already-dead child. The `try/catch` around the `kill()` call swallows any error, but on a long-lived process the kernel could have reused the child PID by then, silently SIGKILL-ing an unrelated process.

### Suggested Fix

Capture `killHandle` in an outer variable and call `clearTimeout(killHandle)` after `exitPromise` resolves (i.e., after the child has exited), before the existing `clearTimeout(timeoutHandle)` call.

---

## BUG-115 ✅ FIXED — `stderrTee` WriteStream not drained before `fs.appendFile` in the parse-error path, causing a write race on the stderr file

**Area:** Runtime / dispatcher
**Severity:** Medium
**Location:** `src/runtime/dispatcher.ts` — `dispatchAgent()`, the `if (parseError)` block near the end of the function
**Discovered:** iteration-3

### Description

In `dispatchAgent`, when `parseError` is non-null the code calls `await fs.appendFile(stderrPath, parseError.truncatedRegion + '\n', 'utf8')` and then throws. At this point `stderrTee` (a `WriteStream` writing to the same `stderrPath`) may still have buffered data being flushed asynchronously via the child's `stderr.on('data')` handler. There is no `await` on `stderrTee` in this path (the drain `Promise` that waits for `stderrTee.close`/`finish` only runs in the success path). `fs.appendFile` and `stderrTee` can interleave, corrupting the stderr file with out-of-order content or partial appends.

### Suggested Fix

Before calling `fs.appendFile`, await the same `stderrTee` drain pattern used in the success path (wait for `'close'` or `'finish'` on `stderrTee`). Alternatively, call `stderrTee.end()` and await it before appending the parse-error bytes.

---

## BUG-116 ✅ FIXED — Resume lock file has an open-then-write TOCTOU race that can grant two processes the lock simultaneously

**Area:** Runtime / runLock
**Severity:** Medium
**Location:** `src/runtime/runLock.ts` — `acquireResumeLock()`, between the `openSync('wx')` call and the `writeSync` call
**Discovered:** iteration-3

### Description

In `acquireResumeLock`, the lock is created atomically via `openSync(lockPath, 'wx')` (O_EXCL), which returns an open file descriptor to an *empty* file. The lock body JSON is written in a subsequent `writeSync` call. Between the O_EXCL `openSync` and the `writeSync`, another process can call `readFileSync(lockPath)`, see an empty file (`raw.trim().length === 0`), classify it as stale, `unlinkSync` it, and create its own lock file at the same path. When the first process then calls `writeSync(fd, ...)`, it writes to the now-orphaned inode (the path has been replaced). Both processes believe they hold the lock. The module comment acknowledges NFS non-correctness but does not mention this local-fs race.

### Suggested Fix

Write a placeholder body (e.g., `{pid}` only) synchronously before `closeSync` so the file is never transiently empty. Also add `fsyncSync(fd)` between `writeSync` and `closeSync` to ensure the content is durable before the FD is released.

---

## BUG-117 ✅ FIXED (duplicate) — `applyEntry('run.ended')` does not guard against already-terminal summaries, unlike sibling handlers

**Area:** Runtime / activeRuns
**Severity:** Low
**Location:** `src/runtime/activeRuns.ts` — `ActiveRunsRegistry.applyEntry()`, case `'pi-workflows.run.ended'`
**Discovered:** iteration-3

### Description

In `ActiveRunsRegistry.applyEntry`, the `'pi-workflows.run.started'` and `'pi-workflows.run.transitioned'` cases both have an early return when `isTerminalState(prior.state)` is true, preventing out-of-order or duplicate entries from overwriting a final state. The `'pi-workflows.run.ended'` case has no such guard — it unconditionally overwrites `state`, `endedAt`, and `durationMs` even if the summary is already terminal. A delayed or replayed `run.ended` event from a cross-process feed (e.g., during crash-sweep recovery) can replace a correctly-computed terminal summary with stale values (wrong `durationMs`, different `endedAt`).

### Suggested Fix

Add a guard at the top of the `'pi-workflows.run.ended'` case: if `prior && isTerminalState(prior.state)` return early (same pattern as the `'run.transitioned'` case), or at minimum skip overwriting `endedAt`/`durationMs` if the prior summary already has them set.

---

## BUG-118 ✅ FIXED (duplicate) — phaseCursor not clamped when agents complete while phase-view is open

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — handleAction case 'navigate-up', phase-view branch (~line 534)
**Discovered:** iteration-3

### Description

In the phase-view navigate-up handler, the code only checks `phaseCursor > 0` before decrementing. When agents finish running and `visibleAgents` shrinks below `phaseCursor + 1`, the cursor is left at an OOB index (no row highlighted). Pressing ↑ decrements one step at a time from the OOB position instead of jumping directly to `visibleAgents - 1`, requiring multiple keypresses to recover. By contrast, navigate-down correctly computes `visibleAgents` from running-phase agents and guards the upper bound.

### Suggested Fix

After decrementing, clamp to `visibleAgents - 1`: compute `visibleAgents` from `opts.phaseRegistry.getRunSnapshot(openedRunId)?.phases.filter(p => p.status === 'running').flatMap(p => p.agents).length ?? 0` and set `phaseCursor = Math.min(phaseCursor - 1, Math.max(0, visibleAgents - 1))`; or clamp on entry (when debouncedRender fires, also clamp phaseCursor).

---

## BUG-119 ✅ FIXED (duplicate) — 'g' hotkey opens GC dialog from phase-view and agent-detail — view guard missing in dispatchHotkey

**Area:** TUI / hotkeys
**Severity:** Medium
**Location:** `hotkeys.ts` — dispatchHotkey, line ~228 (`if (k === 'g') return { kind: 'open-gc-dialog' }`)
**Discovered:** iteration-3

### Description

`isHotkeyEnabled` correctly gates `g` to `runs-list` (`return input.view === 'runs-list'`), but `dispatchHotkey` has no view guard for `g`. The dispatcher short-circuits the no-selection guard via `if (input.runId === undefined && k !== 'g')`, then unconditionally returns `{ kind: 'open-gc-dialog' }`. From phase-view, `runId` is passed as `openedRunId`, so the no-selection gate passes and the GC dialog opens. From agent-detail, `runId` is also undefined but the `k !== 'g'` exception still passes the guard and opens the dialog.

### Suggested Fix

Add a view guard: `if (k === 'g') { if (input.view !== 'runs-list') return { kind: 'noop', reason: 'disabled-for-state' }; return { kind: 'open-gc-dialog' }; }`

---

## BUG-120 ✅ FIXED (duplicate) — helpForState('runs-list') shows 'r' as disabled for paused runs — mismatch with dispatcher

**Area:** TUI / hotkeys
**Severity:** Low
**Location:** `hotkeys.ts` — helpForState, runs-list branch (~line 380): `dis('r', 'restart', noSel || !isTerminal)`
**Discovered:** iteration-3

### Description

In `helpForState` for the runs-list view: `dis('r', 'restart', noSel || !isTerminal)`. For a paused run, `!isTerminal` is `true`, so the hint renders `r` as disabled (grayed-out `(r restart)`). However, both `isHotkeyEnabled` and `dispatchHotkey` correctly enable `r` on paused runs as a 'resume' action. The help bar thus actively misleads the user into thinking `r` won't work, even though pressing it resumes the run. The phase-view help already handles this correctly with `isPaused ? 'resume' : 'restart'`.

### Suggested Fix

Mirror the phase-view logic: `dis('r', isPaused ? 'resume' : 'restart', noSel || (!isPaused && !isTerminal))`.

---

## BUG-121 ✅ FIXED — GC activeIds computed from stale lastSnapshot instead of live registry — newly-started runs unprotected

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — handleAction case 'open-gc-dialog' (~line 700): `const activeIds = new Set(lastSnapshot.filter(...)...)`
**Discovered:** iteration-3

### Description

In `handleAction('open-gc-dialog')`, `activeIds` is built from `lastSnapshot`: `lastSnapshot.filter(s => s.state === 'running' || s.state === 'paused').map(s => s.runId)`. `lastSnapshot` is only refreshed when the debounce timer fires (every ≥30 ms after a feed event). Any run that started after the last debounce cycle (including runs started on another process whose entry hasn't propagated) will be absent from `activeIds`. The F4 protection in `loadGcCandidates` uses `activeRunIds` to exclude candidates whose `restartedFrom` lineage is active — missing a live run from this set means the protection is silently bypassed for that run.

### Suggested Fix

Replace `lastSnapshot` with a live query: `opts.registry.listSummaries().filter(s => s.state === 'running' || s.state === 'paused').map(s => s.runId)`.

---

## BUG-122 ✅ FIXED — GC dialog Enter handler doesn't cover '\n' (Unix newline) — some terminals send LF for Enter

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — handleKey GC dialog intercept (~line 804): `if (k === 'y' || key === 'Enter' || key === 'RETURN' || key === '\r')`
**Discovered:** iteration-3

### Description

The inline GC dialog key intercept in `handleKey` checks `key === 'Enter' || key === 'RETURN' || key === '\r'` for the apply action. `'\n'` (LF) is omitted. On some terminals and in piped/non-TTY test environments, Enter produces `'\n'` rather than `'\r'`. This makes the GC dialog unresponsive to Enter on those terminals. The upstream `NORM_KEY` map in hotkeys.ts correctly maps `'\n'` to `'enter'`, but the GC intercept bypasses `dispatchHotkey` entirely and does its own raw key comparison.

### Suggested Fix

Add `|| key === '\n'` to the Enter condition, or route through the normalizer: `const norm = NORM_KEY.get(key) ?? key.toLowerCase(); if (norm === 'y' || norm === 'enter') { ... }`

---

## BUG-123 ✅ FIXED (duplicate) — cursor passed to renderPhaseView when totalAgents > 0, but phaseCursor indexes running agents only

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — buildRender() phase-view block (~line 503): `phaseSnap.totalAgents > 0`
**Discovered:** iteration-3

### Description

In `buildRender()`, `phaseCursor` is forwarded to `renderPhaseView` under the condition `phaseSnap.totalAgents > 0`. `totalAgents` counts all agents across all phases (done, queued, running). `phaseCursor` however indexes only into running-phase agents (matching the `agentRows` array in renderPhaseView). When all running agents have completed (`totalAgents > 0` but zero running), `phaseCursor` is still passed (possibly non-zero from prior navigation), causing `renderPhaseView` to silently show no highlight (since `phaseCursor >= agentRows.length`). The condition should guard on running agent count to communicate intent and avoid passing a meaningless cursor.

### Suggested Fix

Replace condition with running-agent count: `const runningCount = phaseSnap.phases.filter(p => p.status === 'running').reduce((s, p) => s + p.agents.length, 0); if (phaseSnap !== undefined && phaseCursor >= 0 && runningCount > 0)`.

---

## BUG-124 ✅ FIXED — agentDetailDebounceTimer not cleared on navigate-back from agent-detail — stale render triggered after transition

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — handleAction case 'navigate-back', agent-detail branch (~line 570)
**Discovered:** iteration-3

### Description

When the user presses Esc from agent-detail, `handleAction('navigate-back')` sets `view = 'phase-view'`, clears `openedAgentId` and `agentLogTail`, then calls `requestRender()`. However, it does NOT clear `agentDetailDebounceTimer`. If a `pi-workflows.agent.log` event arrived just before the Esc and the 100 ms debounce is still pending, the timer fires after the view transition, calling `requestRender()` again. This triggers a spurious phase-view render. While the render output is correct (view is already phase-view), the extra frame may cause a visible flicker or confuse timing-sensitive tests. The timer IS cleared in `cleanup()` (overlay close), but not on the mid-session view transition.

### Suggested Fix

Add `if (agentDetailDebounceTimer !== null) { clearTimeout(agentDetailDebounceTimer); agentDetailDebounceTimer = null; }` at the top of the agent-detail navigate-back branch, before setting `view = 'phase-view'`.

---

## BUG-125 ✅ FIXED (duplicate) — buildRender() mutates view and openedAgentId as side effects — repeated calls cause silent state transitions

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — buildRender() lines ~486-487 (agent vanished fallback) and ~513 (run vanished fallback)
**Discovered:** iteration-3

### Description

`buildRender()` is a render function called by the TUI's `render(width)` method and by the `currentLines` test-handle accessor. It contains two state-mutation side effects: (1) when `view === 'agent-detail'` and the agent has vanished from the registry, it sets `view = 'phase-view'` and `openedAgentId = undefined` inline before falling through; (2) when `view === 'phase-view'` and the run summary is gone, it sets `view = 'runs-list'` inline. Both mutations skip calling `requestRender()`. If the TUI calls `render()` twice in a single frame, the first call silently transitions state and the second call renders the fallback view — with no explicit re-render queued and no observable transition event fired. This also violates the component contract that `render()` be a pure projection of state.

### Suggested Fix

Move vanish-fallback transitions out of buildRender() into the subscription callback or a separate `reconcileViewState()` helper called from debouncedRender. buildRender() should treat a missing agent/run as a graceful no-op (render the fallback inline without mutating) and the subscription or a post-render hook should call the transition + requestRender().

---

## BUG-126 ✅ FIXED — Stale compaction snapshot overwrites concurrent write when threshold crossed

**Area:** Runtime / cache
**Severity:** Medium
**Location:** `src/runtime/cache.ts` — `runCompaction()`, lines building `snapshot` before chaining onto `this.writeQueue`
**Discovered:** iteration-3

### Description

In `runCompaction()`, the snapshot is built synchronously from in-memory maps before being chained onto the write queue. When two callers invoke `setAgentResult` concurrently (e.g., via `Promise.all`), the second caller's `appendRecord` is already enqueued before `runCompaction` chains its rename. Execution order becomes: K2_disk_write → compaction_rename. K2 is appended to cache.jsonl, then the stale snapshot (built with K1-only, before K2 entered memory) renames over cache.jsonl, erasing K2's append. K2's own `maybeCompact` triggers a second compaction that repairs it, but there is a crash window between the two consecutive compactions where K2 is permanently lost.

### Suggested Fix

Build the snapshot inside the queued callback (`this.writeQueue.then(() => { const snapshot = buildSnapshot(); return writeSnapshotAndRename(snapshot); })`) so it captures in-memory state only after all previously-queued writes have completed and their memory updates have run.

---

## BUG-127 ✅ FIXED (duplicate) — `writeResultFile` missing fsync before rename — weaker durability than documented

**Area:** Runtime / resultDelivery
**Severity:** Medium
**Location:** `src/runtime/resultDelivery.ts` — `writeResultFile()`, `fs.writeFile(tmp, ...)` call
**Discovered:** iteration-3

### Description

`writeResultFile` documents itself as 'atomic' via tmp+rename, but calls `fs.writeFile` (no explicit fsync) before `fs.rename`. A power loss or OS crash after the `rename` syscall completes can leave the renamed `result.json` with zero bytes or partial content because OS write buffers were not flushed to stable storage. `cache.ts`'s compaction path uses `fsyncSync(fd)` explicitly before rename. `writeResultFile`'s durability guarantee is weaker than its doc comment implies and inconsistent with the rest of the persistence layer.

### Suggested Fix

After `fs.writeFile(tmp, body)`, open the tmp file and call `fsync` before `fs.rename`: e.g., `const fd = await fsp.open(tmp, 'r+'); try { await fd.sync(); } finally { await fd.close(); }` — or use `fs.writeFile` followed by an explicit `fsync` via a file descriptor.

---

## BUG-128 ✅ FIXED (duplicate) — `cancelReasonText` returns 'approval denied' when `decision.approved === true`

**Area:** Runtime / resultDelivery
**Severity:** Low
**Location:** `src/runtime/resultDelivery.ts` — `cancelReasonText()`, second `if` branch
**Discovered:** iteration-3

### Description

In `cancelReasonText`, the branch `if (decision.approved) return "approval denied"` fires when the passed `ApprovalDecision` has `approved === true`. An outcome of `cancelled-pre-run` with an approved decision is logically contradictory; surfacing it as 'approval denied' is semantically wrong and will confuse debugging. The function is only called when `input.error` is absent, so this string reaches the user-visible result card.

### Suggested Fix

Replace `if (decision.approved) return "approval denied"` with `if (decision.approved) return "unexpected cancellation (decision was approved)"` or assert this case is unreachable and log a warning.

---

## BUG-129 ✅ FIXED — gitignore check in `runSaveScript` fires after the 'Add to git?' prompt

**Area:** Runtime / saveScript
**Severity:** Medium
**Location:** `src/runtime/saveScript.ts` — `runSaveScript()`, gitignore block placed after the `opts.ui.prompt` for git add
**Discovered:** iteration-3

### Description

In `runSaveScript`, the `.gitignore` read and `gitignoreCoversPi` check execute AFTER the `ui.prompt('Add to git?')` call. The user is asked whether to stage the file before being told that `.pi/` is ignored by git. If the user answers 'y', `runGitAdd` silently fails (git honors the ignore), and the warning fires as a non-actionable post-hoc notification. The correct behavior is to check `.gitignore` before the prompt and either suppress the prompt ('git ignores this file, skipping add') or include the warning inline so the user can make an informed choice.

### Suggested Fix

Move the `readGitIgnore` + `gitignoreCoversPi` check above the `ui.prompt('...Add to git?')` call. If `gitignoreWarned` is true, skip the prompt entirely and set `gitAdded = false` with a notification, or include the warning text in the prompt message.

---

## BUG-130 ✅ FIXED — Unused import `_tmpdir` in `manifestWriter.ts`

**Area:** Runtime / manifestWriter
**Severity:** Low
**Location:** `src/runtime/manifestWriter.ts` — top-level import block
**Discovered:** iteration-3

### Description

`import { tmpdir as _tmpdir } from 'node:os'` is imported at the top of the file but never referenced. The underscore prefix was added to suppress the lint warning, indicating this is a known-stale refactoring remnant. The tmp file was evidently moved from `os.tmpdir()` to `runDirAbs` (for same-filesystem rename atomicity), but the import was not removed. This will fail strict `no-unused-vars` checks and clutters the dependency surface.

### Suggested Fix

Remove the `tmpdir as _tmpdir` import. If `os` is not imported for any other reason, remove the entire `node:os` import line.

---

## BUG-131 ✅ FIXED — TOCTOU in `addTrustUnlocked`: `existsSync` then async `readFile` races with file deletion

**Area:** Runtime / trustStore
**Severity:** Low
**Location:** `src/runtime/trustStore.ts` — `addTrustUnlocked()`, `existsSync(path)` guard and subsequent `readFile` catch
**Discovered:** iteration-3

### Description

In `addTrustUnlocked`, `existsSync(path)` is called synchronously; if it returns true, `await fs.readFile(path)` is called next. Between the two calls another process (or an OS GC of `.pi/settings.json`) could delete the file. The `readFile` then throws ENOENT, which the catch block re-throws as `TrustWriteError(path, 'io', e)`. The correct behavior for a just-deleted settings file is to treat it as absent and start with `{}`, not to surface an I/O error to the caller.

### Suggested Fix

Remove the `existsSync` guard and handle ENOENT in the `readFile` catch block: `catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { /* treat as empty */ } else { throw new TrustWriteError(path, 'io', e); } }`.

---

## BUG-132 ✅ FIXED (duplicate) — `writeResultFile` tmp filename has no random component — same-millisecond collision

**Area:** Runtime / resultDelivery
**Severity:** Low
**Location:** `src/runtime/resultDelivery.ts` — `writeResultFile()`, `const tmp = join(...)` line
**Discovered:** iteration-3

### Description

The tmp file name is constructed as `result.json.tmp-${process.pid}-${Date.now()}`. Two concurrent calls to `writeResultFile` for the same `runDirAbs` within the same millisecond produce the same tmp path. Both calls write to the same tmp file concurrently and both call `fs.rename`; the result is a torn interleave (second rename wins with whichever partial content was written last). `manifestWriter.ts` avoids this with `randomBytes(4)` appended to its tmp names. `writeResultFile` documents itself as idempotent for dual calls ('caller may invoke twice') but the implementation only works safely when the calls are serialized.

### Suggested Fix

Append `crypto.randomBytes(4).toString('hex')` to the tmp filename: `result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}` — matching the pattern already used in manifestWriter and trustStore.

---

## BUG-133 ✅ FIXED (duplicate) — `ConsensusOpts.similarity` field documented but doesn't exist in actual types

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ConsensusOpts interface
**Discovered:** iteration-3

### Description

runtime-api.md documents a `similarity?: number` field in `ConsensusOpts` ("Jaccard floor per pair (default 0.6)") but `public.d.ts` only has `threshold?: number`. The `similarity` field is entirely fabricated in the docs — authors who set it will have it silently ignored.

### Suggested Fix

Remove the `similarity` field from the ConsensusOpts docs. The single `threshold` controls pair agreement.

---

## BUG-134 ✅ FIXED (duplicate) — `ConsensusOpts.threshold` default wrong — docs say 0.5, actual is 0.6

**Area:** Docs / runtime-api
**Severity:** Medium
**Location:** `docs/runtime-api.md` — ConsensusOpts `threshold` comment
**Discovered:** iteration-3

### Description

runtime-api.md says `threshold` defaults to `0.5` but `public.d.ts` documents `Default 0.6`. Authors tuning consensus behaviour will get the wrong baseline expectation.

### Suggested Fix

Change `// fraction of pairs that must agree (default 0.5)` to `// default 0.6`.

---

## BUG-135 ✅ FIXED (duplicate) — `RetryOpts.maxAttempts` wrong — actual field name is `attempts`

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — RetryOpts interface; `docs/authoring.md` section 4 retry example
**Discovered:** iteration-3

### Description

runtime-api.md documents `maxAttempts?: number` but `public.d.ts` and the implementation use `attempts?: number`. Code that sets `{ maxAttempts: 5 }` will silently be ignored (the extra-key passthrough won't apply the value). The authoring.md example also uses `maxAttempts: 3`.

### Suggested Fix

Rename `maxAttempts` to `attempts` in both docs/runtime-api.md and docs/authoring.md examples.

---

## BUG-136 ✅ FIXED (duplicate) — `RetryOpts.backoffMs` default wrong — docs say 500ms, actual is 100ms

**Area:** Docs / runtime-api
**Severity:** Medium
**Location:** `docs/runtime-api.md` — RetryOpts `backoffMs` comment
**Discovered:** iteration-3

### Description

runtime-api.md says `backoffMs` initial backoff defaults to 500ms but `public.d.ts` documents `Default 100`. Authors relying on the default for rate-limit backoff scenarios will get 5× less wait than expected.

### Suggested Fix

Change `// initial backoff in ms (default 500)` to `// initial backoff in ms (default 100)`.

---

## BUG-137 ✅ FIXED (duplicate) — `ctx.phase` missing third `opts?: PhaseOpts` parameter in runtime-api.md

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ctx.phase signature and Notes section
**Discovered:** iteration-3

### Description

The `ctx.phase` signature in runtime-api.md only shows two parameters but the actual type is `phase(name, agents, opts?: PhaseOpts)`. The `failMode: 'null'` option (referenced in authoring.md section 8, SKILL.md, and writeWorkflowTool.ts) is never reachable without the undocumented third argument. `PhaseOpts` is not defined anywhere in the docs.

### Suggested Fix

Add `opts?: PhaseOpts` to the signature, add a `PhaseOpts` interface block documenting `failMode: 'throw' | 'null'`, and update the Notes bullet to mention that the return type is `ReadonlyArray<AgentResult | null>` when `failMode: 'null'`.

---

## BUG-138 ✅ FIXED (duplicate) — `ctx.phase` return type wrong — omits `null` for `failMode: 'null'`

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ctx.phase signature
**Discovered:** iteration-3

### Description

runtime-api.md shows `Promise<ReadonlyArray<AgentResult>>` but the actual type is `Promise<ReadonlyArray<AgentResult | null>>`. When `failMode: 'null'` is used, failed agents produce `null` entries — code that assumes all elements are non-null will crash with `Cannot read properties of null`.

### Suggested Fix

Change return type to `Promise<ReadonlyArray<AgentResult | null>>` and add a note that entries are `null` when an agent fails and `failMode: 'null'` was passed.

---

## BUG-139 ✅ FIXED (duplicate) — `ctx.pipeline` not documented in runtime-api.md or authoring.md

**Area:** Docs
**Severity:** High
**Location:** `docs/runtime-api.md` — missing section; `docs/authoring.md` — ctx table
**Discovered:** iteration-3

### Description

`ctx.pipeline(items, ...stages)` is a real method in `public.d.ts` and is used in the `write_workflow` promptSnippet and promptGuidelines, but it has no entry in runtime-api.md and is absent from the authoring.md ctx table. Authors who encounter it in the promptSnippet have no reference to understand the stage signature `(prev, original, index)` or that returning an AgentHandle auto-executes it.

### Suggested Fix

Add a `ctx.pipeline` section to runtime-api.md documenting the variadic stage signature, automatic handle execution, and return type. Add a row to the authoring.md ctx table.

---

## BUG-140 ✅ FIXED (duplicate) — `ctx.budget` not documented in runtime-api.md

**Area:** Docs
**Severity:** Medium
**Location:** `docs/runtime-api.md` — missing section
**Discovered:** iteration-3

### Description

`ctx.budget` (with `total`, `spent()`, `remaining()`) is a real property in `public.d.ts` and is demonstrated in the `write_workflow` promptSnippet (`ctx.budget.spent()`), but it has no section in runtime-api.md. Authors who need to gate expensive phases on token budget have no documented API to rely on.

### Suggested Fix

Add a `ctx.budget` section documenting `total: number | null`, `spent(): number`, and `remaining(): number`.

---

## BUG-141 ✅ FIXED (duplicate) — `AgentOpts.schema` missing from runtime-api.md AgentOpts interface

**Area:** Docs
**Severity:** Medium
**Location:** `docs/runtime-api.md` — AgentOpts interface
**Discovered:** iteration-3

### Description

`AgentOpts.schema` is defined in `public.d.ts` and used in the promptSnippet (with `result.output` as the parsed object), but it is absent from the `AgentOpts` interface in runtime-api.md. The `AgentResult.output` field says "set when opts.schema was provided" but there is no documentation of what `schema` accepts or how it works.

### Suggested Fix

Add `schema?: Record<string, unknown>` to the AgentOpts block with a note that a JSON Schema instruction is appended to the prompt and the parsed result is available as `result.output`.

---

## BUG-142 ✅ FIXED (duplicate) — `hello.js` example missing required `export const meta`

**Area:** Examples
**Severity:** High
**Location:** `examples/hello/hello.js`
**Discovered:** iteration-3

### Description

`writeWorkflowTool.ts` `validateWorkflowScript` requires `export const meta = { name, ... }` as the FIRST meaningful statement, yet `hello.js` (the "good starting point for authors building their first workflow") has no `export const meta` at all. Any author who copies this example and submits it via `write_workflow` will get a validation error.

### Suggested Fix

Add `export const meta = { name: 'hello', description: 'Minimal hello-world workflow', version: '1.0.0' };` as the first statement before the default export.

---

## BUG-143 ✅ FIXED (duplicate) — `codebase-audit.js` canonical reference missing required `export const meta`

**Area:** Examples
**Severity:** High
**Location:** `examples/codebase-audit/codebase-audit.js`
**Discovered:** iteration-3

### Description

The bundled `/codebase-audit` workflow (described in authoring.md as "the canonical pi-workflows reference implementation") has no `export const meta`. Any author who copies it as a template will get a validation error from `write_workflow`. It also sets a bad example for the pattern that is explicitly required.

### Suggested Fix

Add `export const meta = { name: 'codebase-audit', description: '...', version: '1.0.0' };` as the first statement.

---

## BUG-144 ✅ FIXED (duplicate) — `ctx.log` called with an object in codebase-audit.js but typed as `string`

**Area:** Examples
**Severity:** Medium
**Location:** `examples/codebase-audit/codebase-audit.js` — analyze phase error handler
**Discovered:** iteration-3

### Description

codebase-audit.js calls `ctx.log({ msg: '...', agentId: ..., err: ... }, { level: 'warn' })` with a plain object as the first argument, but both `public.d.ts` and runtime-api.md type `log(message: string, ...)`. This will either silently coerce the object to `[object Object]` or crash depending on the runtime implementation.

### Suggested Fix

Change the object arg to a string: `` ctx.log(`analyze agent ${a.agentId} returned unparseable JSON: ${e.message}`, { level: 'warn' }) ``.

---

## BUG-145 ✅ FIXED (duplicate) — authoring.md section 5 references wrong example path

**Area:** Docs
**Severity:** Low
**Location:** `docs/authoring.md` — section 5
**Discovered:** iteration-3

### Description

authoring.md says "See `examples/codebase-audit.js` for the full source" but the actual file is at `examples/codebase-audit/codebase-audit.js`. The flat path doesn't exist.

### Suggested Fix

Change `examples/codebase-audit.js` to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-146 ✅ FIXED — authoring.md section 5 says vote phase uses a judge agent but codebase-audit uses JS Borda count

**Area:** Docs
**Severity:** Low
**Location:** `docs/authoring.md` — section 5, Phase 3 description
**Discovered:** iteration-3

### Description

authoring.md section 5 describes the vote phase as "The judge aggregates the ranking lists" implying a judge agent, but codebase-audit.js explicitly avoids `ctx.vote()` and uses plain JavaScript Borda-count aggregation instead. The comment in the code even explains why. This misleads authors about what the example demonstrates.

### Suggested Fix

Change "The judge aggregates the ranking lists" to "A Borda-count aggregation in the workflow script combines the ranked lists (no judge agent — see the source comments for why ctx.vote is not used here).".

---

## BUG-147 ✅ FIXED — SKILL.md testing example uses `sha256` without defining its source

**Area:** Docs / SKILL
**Severity:** Low
**Location:** `skills/pi-workflows/SKILL.md` — Testing a workflow section
**Discovered:** iteration-3

### Description

The testing example in SKILL.md uses `sha256(\`Answer: test input\`)` to compute `promptHash` but `sha256` is neither imported nor explained. Authors following this example will get `ReferenceError: sha256 is not defined`.

### Suggested Fix

Either show the import (`import { createHash } from 'node:crypto'; const sha256 = s => createHash('sha256').update(s).digest('hex')`) or replace `sha256(...)` with a note that the promptHash is available via a test helper exported from `@samfp/pi-workflows/testing`.

---

## BUG-148 ✅ FIXED (duplicate) — promptSnippet uses TypeScript `as` cast syntax inside a JS workflow example

**Area:** Runtime / writeWorkflowTool
**Severity:** Medium
**Location:** `src/runtime/writeWorkflowTool.ts` — promptSnippet
**Discovered:** iteration-3

### Description

The `promptSnippet` in `writeWorkflowTool.ts` contains `(typed.output as { issues: string[] }).issues` — TypeScript cast syntax. Workflow files are plain `.js` running inside `node:vm`; TypeScript syntax is not valid there and will throw a SyntaxError at parse time.

### Suggested Fix

Replace the TypeScript cast with a plain JS access: `typed.output?.issues` or add a JSDoc comment for type hint context instead.

## BUG-W06 — ctx.parallel fn receives (item, ctx) not (item, index)

**Discovered:** 2026-06-01
**Severity:** High — silent misuse produces invalid agentIds, all agents fail immediately

### Description

`ctx.parallel(items, fn, opts?)` calls `fn(items[i], ctx)` — the second
argument is the workflow context, not the item index. Authors who write
`(item, i) => ctx.agent({ id: 'fix-' + i })` get `i = ctx` (an object),
producing `agentId = 'fix-[object Object]'`. `assertSafeAgentId` rejects
this immediately, all agents fail, and `phase_end` shows `ok:0 error:N`
with a 4ms duration and no transcripts.

### Fix

If you need an index in `ctx.parallel`, map the array first:
```js
const fixResults = await ctx.parallel(
  bugs.map((bug, idx) => ({ ...bug, idx })),
  (bug) => ctx.agent({ id: 'fix-' + bug.idx, ... }),
);
```

Long-term: stdlib could pass `(item, index, ctx)` like `Array.prototype.map`.

## BUG-W07 ✅ FIXED — canonicalJson: BigInt serializes identically to its string equivalent

**Discovered:** 2026-06-01
**Severity:** Medium — cache-key collision between BigInt value and its numeric string equivalent

### Description

`canonicalJson(BigInt(123))` returned `'"123"'` — identical to
`canonicalJson("123")`. The culprit was `JSON.stringify((v as bigint).toString())`,
which wraps the BigInt's string representation in JSON string quotes, making it
indistinguishable from a plain string holding the same digits. Any `opts` object
with a BigInt field collides with one holding the numeric string equivalent,
violating the "1-bit change → different hash" guarantee.

### Fix

Changed the BigInt branch in `canonicalJson` (`src/util/hash.ts`) to emit a
bare `B`-prefixed token instead of a JSON-quoted string:

```diff
-  return JSON.stringify((v as bigint).toString());
+  // Prefix with "B" — no other walk branch emits a value starting with
+  // "B", so BigInt(123) → "B123" is distinct from string "123" → '"123"'.
+  return "B" + (v as bigint).toString();
```

`B` is safe as a discriminant: strings start with `"`, numbers with a
digit/`-`/`n` (NaN/Infinity → `"null"`), booleans with `t`/`f`,
arrays/objects with `[`/`{`, and null/undefined/symbols/functions with `n`.
No collision possible.

## BUG-W07 ✅ FIXED — appendMemoryUpdate: fs.appendFile without fsync — memory updates lost on crash

**Discovered:** 2026-06-01
**Severity:** High — memory_update payloads silently lost if process crashes after appendFile returns but before OS flushes its page-cache buffer

### Description

`appendMemoryUpdate` in `src/runtime/agentMemory.ts` called `fs.appendFile(p, payload, "utf8")` and returned immediately. `fs.appendFile` resolves as soon as the kernel accepts the write into its page cache; if the process crashes before the OS flushes, the data is gone with no error surfaced to the caller. Unlike `memoStore.ts`, which opens a file descriptor and calls `fsyncSync` after every write, this path had no durability guarantee.

### Fix

Replaced the bare `fs.appendFile` call with an explicit open (`'a'` flag) → `fh.writeFile` → `fh.datasync()` → `fh.close()` sequence. `datasync()` is the async equivalent of `fdatasync(2)` and flushes data (but not metadata) to durable storage before the promise resolves, matching the durability contract of `memoStore.ts`.

## BUG-W07 ✅ FIXED — `isLikeArray` accepted NaN / negative / Infinity `.length`

**Discovered:** 2026-06-01
**Severity:** Medium — silent zero-agent phase or unbounded loop

### Location

`src/runtime/ctx/utils.ts` — `isLikeArray`

### Description

`isLikeArray` only checked `typeof .length === 'number'`, which admits `NaN`,
`-1`, `Infinity`, and non-integer floats. In `phase.ts` the agents array is
iterated with `for (let i = 0; i < agentsArg.length; i++)`:

- `NaN` or negative length → 0 iterations; phase succeeds vacuously with all
  agents silently skipped.
- `Infinity` → unbounded loop / `RangeError: Maximum call stack size exceeded`.

### Fix

Added `Number.isFinite`, `>= 0`, and integer (`Math.floor(len) === len`) checks:

```ts
export function isLikeArray(v: unknown): v is ArrayLike<unknown> {
  if (v === null || typeof v !== "object") return false;
  const len = (v as { length?: unknown }).length;
  return typeof len === "number" && Number.isFinite(len) && len >= 0 && Math.floor(len) === len;
}
```

## BUG-W07 ✅ FIXED — NaN propagates to operationDuration histogram when durationMs is non-finite

**Discovered:** 2026-06-01
**Severity:** Medium — OTLP backends silently drop or error on NaN histogram values

### Description

`feedLedgerEntryToMetrics` recorded `entry.durationMs / 1000` into the
`gen_ai.client.operation.duration` histogram with no `Number.isFinite`
guard. A missing or `NaN` `durationMs` would propagate NaN into the
histogram. Token counters were protected by `(entry.usage.input > 0)`;
the duration path had no analogous guard. Most OTLP backends silently
drop or error on NaN values.

### Fix

Added `Number.isFinite(entry.durationMs)` to the existing `!entry.cached`
guard in `otelMetricsExporter.ts` near line 382:

```ts
if (!entry.cached && Number.isFinite(entry.durationMs)) {
  inst.operationDuration.record(entry.durationMs / 1000, { ... });
}
```

## BUG-W07 ✅ FIXED — checkpoint data not validated for JSON-serializability before setCheckpoint

**Discovered:** 2026-06-01
**Severity:** Medium — non-serializable data produces opaque error inside CacheStore instead of a descriptive error at ctx.checkpoint() call time

### File
`src/runtime/ctx/checkpointReport.ts`, `checkpointFn`

### Description

`reportFn` round-trips `data` through `JSON.parse(JSON.stringify(data))` before
persisting, so circular references or `BigInt` values produce a descriptive
`TypeError` at the call site. `checkpointFn` passed `data` directly to
`opts.cache.setCheckpoint` with no such validation, causing an opaque error deep
inside `CacheStore` instead of a clear error at `ctx.checkpoint()` call time.

### Fix

Added the same `JSON.parse(JSON.stringify(data))` round-trip in `checkpointFn`
before calling `setCheckpoint`, wrapping failures in a `TypeError` with the
message `ctx.checkpoint: data is not JSON-serializable (...)`. The validated
`safeData` value is passed to `setCheckpoint` instead of the raw `data`.

## BUG-W08 ✅ FIXED — compactMemoryFile: no fsync before rename — durability gap on crash

**Discovered:** 2026-06-01
**Severity:** Medium — silent data loss on OS crash between writeFile and rename

### File
`src/runtime/agentMemory.ts`, `compactMemoryFile`

### Description

`compactMemoryFile` called `fs.writeFile(tmp)` then `fs.rename(tmp, target)` with
no fsync in between. POSIX rename is atomic (the directory-entry swap is
all-or-nothing) but does **not** guarantee that the file's content has been
flushed from the OS page cache to stable storage. A crash or power loss
immediately after the rename could leave `MEMORY.md` pointing at a zero-length
or corrupt inode. `memoStore.ts` already fsyncs before its rename; `agentMemory.ts`
did not.

### Fix

After `fs.writeFile(tmp)`, open the tmp file in read mode, call `fd.sync()`, and
close before calling `fs.rename`:

```ts
const fd = await fs.open(tmp, "r");
try {
  await fd.sync();
} finally {
  await fd.close();
}
await fs.rename(tmp, target);
```

This matches the `fsyncSync` pattern already used in `memoStore.ts`.

## BUG-150 ✅ FIXED — `PI_WORKFLOWS_OTEL_INPUT=raw` emits unbounded input string as span attribute

**Discovered:** 2026-06-01
**Severity:** Medium — large prompts silently drop the entire span on OTLP backends with per-span size limits (Jaeger ~64 KB, Datadog ~128 KB)

### File

`src/runtime/otelExporter.ts`

### Description

`inputAttrs()` set `pi.workflow.input` to the full raw input string with no
length cap when `PI_WORKFLOWS_OTEL_INPUT=raw`. `excerpt` mode already capped
at 64 chars; `raw` had no cap at all. A large prompt caused the entire span
to be silently dropped by the OTLP backend.

### Fix

Added `OTEL_INPUT_RAW_MAX_CHARS = 4096` constant. `raw` mode now slices the
input to 4096 chars before assigning `pi.workflow.input`, using the same
guard pattern already used by `excerpt` mode:

```ts
const OTEL_INPUT_RAW_MAX_CHARS = 4096;
// …
out["pi.workflow.input"] =
  input.length <= OTEL_INPUT_RAW_MAX_CHARS
    ? input
    : input.slice(0, OTEL_INPUT_RAW_MAX_CHARS);
```

## BUG-149 ✅ FIXED — Post-fork checkpoint cache records not timestamp-filtered

**Area:** Runtime / forkRun
**Severity:** Medium
**Location:** `src/runtime/forkRun.ts` — `_classifyParentCacheLine`
**Discovered:** iteration-3

### Description

`_classifyParentCacheLine` applied `cutAt` timestamp filtering only to `agent_result` records. `author_cache` entries with a `__chk__` key prefix (written by `ctx.checkpoint`) were unconditionally returned as `"keep"`, so post-fork checkpoints were seeded verbatim into the fork's `cache.jsonl`. When the fork re-ran those phases, `ctx.checkpoint(label)` found the key and returned `true`, silently skipping re-execution of the guarded work block.

### Fix

Added an early guard in `_classifyParentCacheLine`: if the record type is `author_cache` and the key starts with `__chk__`, apply the same `cutAt` comparison using `r.at` before falling through to the existing `agent_result` path. Malformed `__chk__` entries (missing `at`) are dropped defensively.

---

## BUG-W07 ✅ FIXED — gate: gate_requested written to ledger without abort pre-check; gate_resolved never written on abort

**Area:** Runtime / ctx.gate
**Severity:** Medium
**Location:** `src/runtime/ctx/gate.ts`
**Discovered:** iteration-14

### Description

`gate_requested` was appended to the ledger before checking whether
`opts.signal` was already aborted. If the signal fired before `gate` was
called, the ledger gained an orphaned `gate_requested` entry with no
matching `gate_resolved`. The same orphan could occur when the signal
fired during `waitForGate` — the outer catch returned `{ ok: false }`
without writing `gate_resolved`.

### Fix

1. Added an `opts.signal?.aborted` guard immediately before the
   `gate_requested` ledger write; returns `{ ok: false, error: AbortError }`
   without touching the ledger when already aborted.
2. Wrapped `waitForGate` in a try/catch; on abort-during-wait, writes
   `gate_resolved(approved: false)` before re-throwing, ensuring every
   `gate_requested` entry is always paired with a `gate_resolved`.

## BUG-W07 ✅ FIXED — createOtelExporter registers no process-exit flush hook — spans dropped on fast exit

**Discovered:** 2026-06-01
**Severity:** Medium — silent span/metric loss on short-lived workflow runs

### Description

`createOtelExporter` returns a handle with `flush()`/`shutdown()` but never
registered `process.on('beforeExit')` or `process.on('SIGTERM')` hooks to
drain the `BatchSpanProcessor`. For short workflow runs the process can exit
before the processor's 5-second periodic interval fires, silently dropping
every span.

### Fix

After the SDK loads successfully, register two hooks before returning the handle:

- `beforeExit`: calls `sdk.provider.forceFlush?.()` — covers natural event-loop draining exits.
- `SIGTERM`: calls `sdk.provider.shutdown?.()` then `process.exit(0)` — covers signal termination.

`shutdown()` now also removes both listeners via `process.off(...)` to avoid
dangling handlers if the caller explicitly shuts down the exporter.

## BUG-W08 ✅ FIXED — Orphaned fork run directory when startWorkflowRun throws after seed

**Discovered:** 2026-06-01
**Severity:** High — orphan directories accumulate in GC scans and /workflows list

### Description

In `forkFromCheckpoint` (`src/runtime/forkRun.ts`), `wrappedResolveRunDir` creates
the run directory and writes `ledger.jsonl` + `cache.jsonl` seed files before
`startWorkflowRun` returns. If `startWorkflowRun` throws (approval denied, hash
mismatch, etc.) there was no cleanup path — the partially-seeded directory was
left on disk. It appeared in GC scans and `/workflows list` with inherited parent
ledger entries, polluting the run index and confusing users.

### Fix

Wrapped the `startWorkflowRun` call in a `try/catch`. On error, if
`mintedRunId !== null` (meaning `wrappedResolveRunDir` was invoked and the
directory was created), the orphan is removed via `fs.rm(..., { recursive: true,
force: true })` before rethrowing the original error. Cleanup failures are
swallowed to avoid masking the root cause.

## BUG-W09 ✅ FIXED — interrupt: waitForInterrupt called with no signal.aborted pre-check

**Discovered:** 2026-06-01
**Severity:** Medium — can stall teardown and leaves orphaned interrupt_requested in ledger

### Description

In `ctx/interrupt.ts`, the Block path called `opts.waitForInterrupt(key, opts.signal)` with
no prior check on `opts.signal?.aborted`. If the signal was already aborted at that point,
`waitForInterrupt` would be invoked unnecessarily, potentially stalling teardown. When it
subsequently rejected, execution jumped to the outer catch, meaning `interrupt_resolved` was
never written — leaving the `interrupt_requested` entry permanently orphaned in the ledger.

### Fix

Folded the aborted guard into the condition:
```ts
// Before
if (opts.waitForInterrupt !== undefined) {

// After
if (opts.waitForInterrupt !== undefined && !opts.signal?.aborted) {
```

When the signal is already aborted, the block falls through to the default path
(`cfg.defaultValue ?? null`, `source = "default"`), which continues to write
`interrupt_resolved` and returns cleanly. The abort propagates naturally at the run level.

## BUG-W09 ✅ FIXED — `endOpenSpans` uses wall-clock `new Date()` — child spans outlive root span end time

**Discovered:** 2026-06-01  
**Severity:** Medium — OTel parent-child timing invariant violated; rendering artefacts in Jaeger/Tempo/Honeycomb

### Description

`endOpenSpans()` computed `const now = new Date()` at the moment `dispose()` was called.
The root span had already been closed using the ledger-entry timestamp `t` (which is in the
past). Any still-open agent/phase spans therefore received an end time strictly greater than
their parent's end time, violating the OTel invariant `child.endTime ≤ parent.endTime`.
This produced rendering artefacts (negative-duration children, timeline overflows) in
Jaeger, Tempo, and Honeycomb.

### Fix

Added `lastEntryTime: Date | null` to `ReplayState`. `feedLedgerEntry` updates it on every
entry (`state.lastEntryTime = t`). `endOpenSpans` now uses `state.lastEntryTime ?? new Date()`
so abandoned spans are capped at the last observed ledger timestamp instead of wall-clock now.

## BUG-W10 ✅ FIXED — `schedule` setTimeout callback calls `handleEvent` without try/catch — uncaught exception crashes host process

**Discovered:** 2026-06-01  
**Severity:** Medium — any synchronous throw inside a hot-reload handler propagates as an uncaught timer exception, triggering `uncaughtException` and crashing the host pi process

### Description

`handleAdd`, `handleChange`, and `handleUnlink` (all reachable via `handleEvent`) call
`registerCommand`, `pi.registerCommand`, and `pi.unregisterCommand`. These calls are
synchronous and can throw (e.g. invalid command name, registry corruption, null dereference).
They ran inside the `setTimeout` callback in `schedule` without any try/catch wrapper.
Node.js timer callbacks are outside the normal async stack; an unhandled throw there emits
`uncaughtException`, which by default terminates the process and kills all active workflow runs.

### Fix

Wrapped the `handleEvent(absPath, event)` call in the `setTimeout` callback with a
`try/catch` block that logs the error at `"error"` level (via the `log` sink) and swallows
the exception, preventing crash propagation to the host process.

```typescript
// Before
const timer = setTimeout(() => {
  debounceTimers.delete(absPath);
  if (closed) return;
  handleEvent(absPath, event);
}, debounceMs);

// After
const timer = setTimeout(() => {
  debounceTimers.delete(absPath);
  if (closed) return;
  try {
    handleEvent(absPath, event);
  } catch (err) {
    log("error", `hot-reload: unhandled error in ${event} handler`, {
      absPath,
      error: String(err),
    });
  }
}, debounceMs);
```

## BUG-150 ✅ FIXED — TOCTOU race in checkpointFn — concurrent agents with same label both return true

**Discovered:** 2026-06-01
**Severity:** Medium

### File
`src/runtime/ctx/checkpointReport.ts` — `checkpointFn`

### Description

`hasCheckpoint` and `setCheckpoint` were two separate `await`ed calls with no
lock between them. Two parallel agents calling `ctx.checkpoint('same-label')`
could both observe `false` from `hasCheckpoint` before either wrote, then both
proceed to `setCheckpoint`. Both returned `{ok:true, value:true}`, violating the
idempotency contract and causing the guarded work block to execute twice.

### Fix

Added a per-label async mutex (`cpLocks: Map<string, Promise<void>>`) inside
`createCheckpointReportMethods`. Before the `hasCheckpoint` read, each call:

1. Snapshots the current in-flight promise for the label (or `Promise.resolve()` if none).
2. Creates a new `ticket` promise and stores it in `cpLocks` for subsequent callers to await.
3. `await`s the previous promise, serializing execution.
4. Runs the check-then-set body inside a `try/finally` that calls `release()` on completion.

The second concurrent caller blocks at step 3 until the first finishes; by then
`hasCheckpoint` returns `true` and the second caller correctly returns
`{ok:true, value:false}`.

---

## BUG-151 ✅ FIXED — memo_check silently ignores caller-supplied ttlMs — stale entries returned when freshness filtering expected

**Discovered:** 2026-06-01
**Severity:** Medium — silent stale-cache hits when caller expects stricter freshness

### Description

`memo_check` called `parseMemoOpts(optsArg)` (which parses `ttl` into `ttlMs`) but then executed `void ttlMs` and discarded it. The hit/miss decision was delegated entirely to `store.has(keyHash)`, which gates against the TTL baked in at `set`-time. A caller writing `ctx.memo.check(key, { ttl: 3_600_000 })` expecting entries fresher than one hour would silently receive entries up to 24 hours old with no error or diagnostic.

### Fix

Removed `void ttlMs` and added a check-time freshness gate after `store.get()`:

```ts
if (Date.now() - entry.writtenAt > ttlMs) {
  return { ok: true, value: { hit: false } };
}
```

The caller-supplied TTL now acts as a maximum-age gate: an entry that passes the set-time TTL check but exceeds the check-time TTL is returned as a miss. This is strictly additive — passing a larger TTL than the set-time value has no effect (the entry would already be expired by `store.get()`).

## BUG-151 ✅ FIXED — sendControl creates phantom run directory instead of throwing for non-existent runId

**File:** `src/client.ts` — `WorkflowClient.sendControl`
**Discovered:** 2026-06-01
**Severity:** Medium — silent phantom directory creation; durable ctrl commands written but never consumed

### Description

`sendControl` called `fsp.mkdir(dir, { recursive: true })` unconditionally before writing the
control command. This silently created the run directory when the `runId` didn't exist (typo'd
ID, stale ID, or long-dead run). The JSDoc contract documented `@throws if the run directory
doesn't exist or the write fails`, but the implementation did the opposite — the command was
durably fsynced into a directory that no run process ever watched.

### Fix

Replaced `fsp.mkdir(dir, { recursive: true })` with `fsp.access(dir)`, which throws `ENOENT`
if the directory is absent, matching the documented `@throws` contract. The directory is never
created by this method.

## BUG-151 ✅ FIXED — `resumePaused` returns false without calling `pauseGate.resume()` — queued agents block indefinitely

**File:** `src/runManager.ts`
**Discovered:** 2026-06-01
**Severity:** Medium — permanent deadlock for queued agents when a run fails while paused

### Description

Two early-return paths in `resumePaused` (inside `withControlLock`) returned `false` without calling `pauseGate.resume()`:

1. The re-check after `ledger.append` — fires when `sm.state !== "paused" || ctrl.signal.aborted` after the ledger write.
2. The `sm.go("running")` catch block — fires when the state transition races with a concurrent advance.

The critical path: a phase throws with `failMode:'throw'`, causing `sm.go('failed')` to run outside `withControlLock`. When a `resumePaused` IPC call then arrives, the re-check sees `sm.state !== 'paused'` and returns `false` — but the pause gate is never opened. Any `runOneAgent` call already queued on `pauseGate.waitWhilePaused` blocks indefinitely.

The `pause()` method's own catch/rollback path correctly called `pauseGate.resume()`, making this an asymmetric omission.

### Fix

Added `pauseGate.resume()` before each `return false` in `resumePaused`, mirroring the existing rollback in `pause()`. Updated the catch-block comment to document the intent.

## BUG-151 ✅ FIXED — onTimerError never called for normal callback throws — run-failure hook bypassed

**File:** `src/runtime/timerTable.ts`, `invokeWrapped()`
**Discovered:** 2026-06-01
**Severity:** High — sandbox timer callback throws silently swallowed; run never fails

### Description

In `invokeWrapped()`, when `wrapped()` throws and `rethrowAcrossRealm()` succeeds, the code
called `opts.onTimerContextError?.(ctxErr)` then immediately returned. `opts.onTimerError` was
never invoked in this path. The JSDoc for `onTimerError` explicitly states it is "invoked when a
timer callback throws" and "decides whether to fail the run." Production wires `onTimerError` to
the run-failure path; `onTimerContextError` is a test-only sink. Any sandbox timer callback that
threw would be silently swallowed — the run never failed regardless of the error. `onTimerError`
was only reached when `rethrowAcrossRealm` itself threw a `SandboxViolationError` (the exceptional
case, not the normal throw path).

### Fix

Added `opts.onTimerError?.(ctxErr)` immediately before `opts.onTimerContextError?.(ctxErr)` in the
`rethrowAcrossRealm` success branch, so the run-failure hook fires unconditionally on any caught
timer error. `onTimerContextError` is retained (test sink) but now always accompanies `onTimerError`.

## BUG-152 ✅ FIXED — `runDir()` passes `runId` directly to `path.join` without validation — path traversal into arbitrary directories

**File:** `src/util/paths.ts`
**Severity:** High

### Description

`runDir(runId)` returned `join(runsHome(), runId)` with no validation. `path.join` normalises
`..` segments, so `runDir('../../../../etc/passwd')` resolved to `/etc/passwd` on a typical
system. Every derived helper — `ctrlPath`, `cachePath`, `cachePathTmp`, `manifestPath`,
`fixturesPath`, `ledgerPath`, `agentsDir` — inherited the bug because they all call
`runDir()`. Any code path that accepts a `runId` from user-controlled input (CLI resume,
`run_workflow` tool, TUI `r` keybind) and passes it to these functions without prior
validation exposed arbitrary file read/write.

The contrast with `agentTranscriptPath`/`agentStderrPath` (which call `assertSafeAgentId`
before building the path) shows the pattern was known and intentionally applied for
`agentId` but omitted for `runId`.

### Fix

Added `InvalidRunIdError` class and `assertSafeRunId(runId: unknown)` function to
`src/util/paths.ts`, mirroring `InvalidAgentIdError`/`assertSafeAgentId`. `assertSafeRunId`
delegates to the existing `isRunId()` regex (`wf-[0-9a-f]{12}`) imported from `./runId.js`
and throws `InvalidRunIdError` on any non-matching value. `runDir()` now calls
`assertSafeRunId(runId)` as its first statement, so all downstream path helpers are
automatically protected.

## BUG-W07 — ctx.parallel with large agent count silently fails all agents (unresolved)

**Discovered:** 2026-06-01  
**Severity:** High — 0 agents run, all appear as FAILED, no error in ledger

### Description

When `ctx.parallel(items, fn, { failMode: 'null' })` is called with 33 items, all 33
`runOneAgent` promises reject in ~5ms with no `agent_start` or `agent_error` ledger entries.
This is logically impossible under the documented `runOneAgent` code path — every rejection
path before the outer try/catch either (a) requires `agentCount >= perRunAgentCap` (not met at
33/1000) or (b) requires `tokenBudget !== null` (disabled by default). The `phase_end` shows
`ok:0 error:33 durationMs:5` with zero agent transcripts.

### Observed conditions

- 33 agents, `maxConcurrent: 16` (run-level cap)
- 6 hunt agents + 1 dedupe agent completed beforehand (all via BUG-149 recovery, no `agent_end`)
- `failMode: 'null'` on the parallel call
- All agents had distinct valid IDs (`fix-0` — `fix-32`), prompts ~900 chars

### Workaround

Replace `ctx.parallel(items, fn)` with a `for-of` loop using `ctx.phase('fix-N', [agent], { failMode: 'null' })`.
This is serial but avoids the concurrency failure entirely.

### Suspected root cause (unconfirmed)

Possibly related to the 6 preceding agents completing via BUG-149 synthetic path — they have
`ok:true` but no `agent_end` in the transcript. Unclear if the `state.agentCount` or semaphore
state becomes corrupted in this scenario.

## BUG-W10 ✅ FIXED — Mermaid header comment injection via unescaped manifest fields

**File:** `src/runtime/visualize.ts` — `emitMermaid()`
**Discovered:** 2026-06-01
**Severity:** High — user-controlled input can break out of Mermaid `%%` comment line

### Description

In `emitMermaid()`, `manifest.runId`, `manifest.workflowName`, and `manifest.input` were
interpolated into the `%%` comment line without sanitization. `escapeLabel()` was never called
on these values. A newline (`\n`, `\r`) in any field — especially `manifest.input`, which is
user-supplied — breaks out of the comment and injects arbitrary nodes or edges into the rendered
diagram. Example: `input='audit\nStart --> Injected\nInjected([pwned])'` produces a live Mermaid
node after the comment line.

### Fix

Wrapped each value through `escapeLabel()` (which already strips `\u0000–\u001F`, covering `\r`
and `\n`) before concatenation. `String()` coercion added so non-string manifest fields don't
cause a runtime exception:

```ts
if (manifest.runId) headerBits.push(`run=${escapeLabel(String(manifest.runId))}`);
if (manifest.workflowName) headerBits.push(`workflow=${escapeLabel(String(manifest.workflowName))}`);
if (manifest.input) headerBits.push(`input=${escapeLabel(truncate(String(manifest.input), 60))}`);
```

## BUG-W10 ✅ FIXED — Gate fallback branch ignores already-aborted signal — gate auto-approves during cancellation

**Discovered:** 2026-06-01
**Severity:** Medium — cancelled run continues executing after abort signal fires

### Description

In `ctx/gate.ts`, when `opts.waitForGate` is undefined (headless / no TUI), the `else`
fallback branch assigned `approved = defaultAnswer` without first checking
`opts.signal?.aborted`. If cancellation fired between the initial pre-ledger guard and this
point, the gate would write `gate_requested`, then immediately auto-approve with
`defaultAnswer` (true by default) and write `gate_resolved`, causing the workflow to
continue executing a run the host intended to stop.

The same issue existed in `ctx/interrupt.ts`: the `else` branch (reached when
`waitForInterrupt` is undefined or the signal was already aborted) fell through to
`value = cfg.defaultValue ?? null` without an abort check, so an in-flight interrupt
auto-resolved with its default answer instead of propagating the abort.

### Fix

In both `else` fallback branches, added an abort guard immediately before the default
assignment:

```ts
// gate.ts
} else {
  if (opts.signal?.aborted)
    throw opts.signal.reason ?? new DOMException('Run was aborted', 'AbortError');
  approved = defaultAnswer;
}

// interrupt.ts
} else {
  if (opts.signal?.aborted)
    throw opts.signal.reason ?? new DOMException('Run was aborted', 'AbortError');
  value = cfg.hasDefault ? cfg.defaultValue : null;
  source = "default";
}
```

In `gate.ts` the throw is caught by the surrounding `try/catch (waitErr)` block, which
already writes `gate_resolved(approved: false)` on abort — so the ledger remains balanced.

## BUG-153 ✅ FIXED — MemoStore cross-process compaction race: fixed tmp path + non-atomic rename loses concurrent appends

**File:** `src/runtime/memoStore.ts` — `writeSnapshotAndRename()`
**Discovered:** 2026-06-01
**Severity:** High — two processes sharing memo.jsonl can silently lose appended entries during compaction

### Description

`writeSnapshotAndRename` wrote every compaction snapshot to the same fixed
`memo.jsonl.tmp` path (resolved once at construction time from `resolveMemoPathTmp`).
When two processes sharing the same `memo.jsonl` both trigger compaction concurrently:

1. Process A builds its snapshot and opens `memo.jsonl.tmp` with `O_WRONLY|O_CREAT|O_TRUNC`.
2. Process B opens the same path — the `O_TRUNC` flag truncates Process A's in-flight snapshot.
3. One process's `renameSync(memo.jsonl.tmp → memo.jsonl)` wins; the surviving `memo.jsonl`
   contains only one process's snapshot, potentially at an earlier logical time.
4. O_APPEND entries the other process wrote to the live file between its snapshot build and
   the rename are permanently lost.

`writeQueue` serializes writes within a single process but provides no cross-process protection.

### Fix

Generate a per-compaction unique tmp path inside `writeSnapshotAndRename` by appending
`.<pid>.<4-random-hex-bytes>` to the base `memoPathTmp`:

```ts
const uniqueTmp =
  `${this.memoPathTmp}.${process.pid}.${Math.random().toString(16).slice(2, 10)}`;
```

Each process writes its snapshot to an exclusively-owned tmp file, eliminating the
truncation collision. The final `renameSync` remains atomic (same directory, same
filesystem). Added `unlinkSync` best-effort cleanup if the rename throws.
Also added `unlinkSync` to the import list.

**Files changed:** `src/runtime/memoStore.ts`

## BUG-W11 ✅ FIXED — No cap on concurrent timer registrations — timer table unbounded growth

**Discovered:** 2026-06-01
**Severity:** Medium — host OOM risk from adversarial or buggy workflow scripts

### Description

`scheduleTimeout`, `scheduleInterval`, and `scheduleImmediate` each push entries
into `callbackTable` and their respective ID maps with no upper bound. A sandboxed
script could call `setTimeout(fn, 1e12)` in a tight loop, growing all four maps
indefinitely until host OOM. The `disposed` guard only activates after the
`AbortSignal` fires, which can be arbitrarily delayed.

### Fix

1. Added `MAX_OUTSTANDING = 10_000` module-level constant in `timerTable.ts`.
2. Added `makeTableLimitError()` local factory producing a `SandboxViolationError`
   with `violation: "timer-table-limit-exceeded"`.
3. Added `"timer-table-limit-exceeded"` to the `SandboxViolationError["violation"]`
   union in `src/types/internal/sandbox.d.ts`.
4. In each `schedule*` method, checked `callbackTable.size >= MAX_OUTSTANDING`
   before inserting: on breach, calls `dispose()` (cancels all outstanding timers
   and marks the bridge disposed) then invokes `opts.onTimerError?.(makeTableLimitError())`.
   Returns handle `0` (same as the already-disposed path).

---

## BUG-153 ✅ FIXED — progressFn: NaN passes the [0,100] range guard and is emitted as a progress value
**File:** `src/runtime/ctx/logProgress.ts`, `progressFn()`
**Discovered:** 2026-06-01
**Severity:** Low — NaN silently emitted as progress value to overlay consumers

### Description

The guard `typeof pct !== 'number' || pct < 0 || pct > 100` does not reject `NaN`.
`typeof NaN === 'number'` is `true`, and both `NaN < 0` and `NaN > 100` are `false`, so
`ctx.progress(NaN)` passes validation and emits `{ pct: NaN }` to the overlay. Any consumer
performing arithmetic on the value silently propagates `NaN`.

### Fix

Added `!isFinite(pct)` as the second condition in the guard:
`typeof pct !== 'number' || !isFinite(pct) || pct < 0 || pct > 100`.
`isFinite` rejects both `NaN` and `±Infinity`, closing the gap.

## BUG-W12 ✅ FIXED — Unbounded `pending` buffer growth on lines with no newline — OOM on adversarial input

**Discovered:** 2026-06-01  
**Severity:** Medium — Node process OOM-killed or swapped under adversarial/broken subprocess output

### Description

`pending = Buffer.concat([pending, buf])` accumulated every incoming chunk unconditionally
until a `0x0A` byte was found. There was no line-length cap anywhere in the parser, so a
subprocess that writes a continuous stream with no newlines would grow `pending` without
bound until the Node process was OOM-killed or the OS began swapping.
`TRUNCATED_REGION_MAX=256` limits only error-message content, not the in-flight buffer.

### Fix

Added `DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024` (4 MiB) constant and a `maxLineBytes`
option to `ParseJsonStreamOptions` (defaults to `DEFAULT_MAX_LINE_BYTES`; set to `0` to
disable). After the inner while loop exhausts all complete lines, if `pending` (the
in-flight partial line) exceeds the cap, a `JsonStreamError` with `reason='parse'` is thrown
immediately, carrying the first 256 bytes of the offending region as `truncatedRegion`.

---

## BUG-155 ✅ FIXED — clipMessage compares code-unit length against MAX_BYTES — over-emits for multibyte Unicode

**File:** `src/runtime/otelExporter.ts`, `clipMessage()`
**Discovered:** 2026-06-01
**Severity:** Low — OTLP payloads up to 3× larger than intended for CJK/emoji-heavy messages

### Description

`LOG_MESSAGE_MAX_BYTES = 4096` but the guard `s.length <= LOG_MESSAGE_MAX_BYTES` compared UTF-16
code units, not bytes. A message of 4,096 CJK characters passed the guard yet encoded to ~12,288
UTF-8 bytes in the OTLP protobuf payload — 3× the intended limit. The truncation path had the
same flaw: `s.slice(0, LOG_MESSAGE_MAX_BYTES)` sliced by character count rather than byte budget.

### Fix

Replaced `s.length` guard with `Buffer.byteLength(s, "utf8") <= LOG_MESSAGE_MAX_BYTES`.
Replaced the character-based `s.slice(...)` truncation with
`Buffer.from(s, "utf8").slice(0, LOG_MESSAGE_MAX_BYTES).toString("utf8")`, which truncates at a
UTF-8 byte boundary (Node.js handles any incomplete trailing sequence gracefully).

## BUG-W10 ✅ FIXED — `memoryOversizeWarned` keyed by name only, not scope:name — warning dedup leaks across scopes

**Discovered:** 2026-06-01  
**Severity:** Low — incorrect dedup suppresses oversize warnings when two scopes share the same agent name

### Description

`memoryOversizeWarned` used only `safeName` as its key. Two scopes with identically-named
agents (e.g. `user:agent1` and `project:agent1`) shared the same dedup slot. A warning fired
for one scope would suppress the warning for the other. Symmetrically, `memoryCompact`
called `memoryOversizeWarned.delete(safeName)`, which cleared the flag for *all* scopes
sharing that name rather than just the one that was compacted. `readOnlyMemoryKeys` already
used the `scope:name` composite via `memoryReadOnlyKey`; `memoryOversizeWarned` was
inconsistently keyed.

### Fix

In `memoryRead`: destructure `scope: parsedScope` from `resolveMemoryArgs`, compute
`const oversizeKey = memoryReadOnlyKey(parsedScope, safeName)`, and use `oversizeKey` for
`.has` / `.add` instead of bare `safeName`.

In `memoryCompact`: destructure `scope: parsedScope` from `resolveMemoryArgs` and use
`memoryReadOnlyKey(parsedScope, safeName)` for `.delete` instead of bare `safeName`.

Updated the `MemoryDeps` interface JSDoc and the file-header comment to reflect
`Set<scope:name>` rather than `Set<name>`.

## BUG-154 ✅ FIXED — readMemoryFileWithMeta: TOCTOU between fs.stat and fs.open produces wrong truncated flag

**File:** `src/runtime/agentMemory.ts` — `readMemoryFileWithMeta`  
**Discovered:** 2026-06-01  
**Severity:** Low — spurious or missed `truncated` flag; no data loss

### Description

`readMemoryFileWithMeta` called `fs.stat(p)` to capture `totalBytes`, then separately
called `fs.open(p, "r")`. A concurrent `compactMemoryFile` rename between those two
awaits could cause the fd to refer to the post-compaction file while `totalBytes` still
held the pre-compaction size (or vice versa), producing a spurious `truncated: true` (or
a missed `truncated: true`) on an otherwise correctly-read buffer.

### Fix

Removed the pre-open `fs.stat(p)` call. After `fs.open`, `fh.stat()` is called on the
open file handle — this stats the already-open inode, so `totalBytes` and the
subsequent `fh.read` are guaranteed to refer to the same file regardless of concurrent
renames on the path.

---

## BUG-155 ✅ FIXED — appendMemoryUpdate concurrent writes unserialised — stat/read-tail/appendFile sequence not atomic

**File:** `src/runtime/agentMemory.ts` — `appendMemoryUpdate`  
**Discovered:** 2026-06-01  
**Severity:** Low — double blank separators between entries; no data loss

### Description

Multiple concurrent `appendMemoryUpdate` calls for the same `dir` were not serialised. The
sequence — (1) `fs.stat(p)` to get size, (2) `fs.open(p,'r')` and read the last byte, (3)
decide on `needsLeadingNewline`, (4) `fs.appendFile(p, payload)` — could be interleaved. Two
concurrent callers could both execute steps 1–3, both see the same non-newline tail byte, both
set `needsLeadingNewline = true`, and both prepend `\n`, producing double blank separators.

### Fix

Already resolved prior to this audit. The entire stat/read-tail/append sequence runs inside
`await enqueueWrite(dir, async () => { ... })`, which serialises all calls per-directory
through the `writeQueues: Map<string, Promise<void>>` promise chain. The `enqueueWrite`
helper uses the same write-queue pattern as `compactMemoryFile`. No code change required.

## BUG-W13 ✅ FIXED — `globalCachePath` uses unvalidated `scriptSha256` slice as a path segment — path traversal

**File:** `src/util/paths.ts` — `globalCachePath()` / `globalCachePathTmp()`
**Discovered:** 2026-06-01
**Severity:** Medium — limited path traversal within the home tree

### Description

`globalCachePath(scriptSha256)` and `globalCachePathTmp(scriptSha256)` passed
`scriptSha256.slice(0, 16)` directly to `path.join` with no validation. A caller
supplying a value beginning with `'../'` (e.g. `'../../malicious/x' + 'a'.repeat(50)`)
would produce a traversal: `join(workflowsHome(), 'global-cache', '../../malicious', 'cache.jsonl')`
normalizes to a path outside `workflowsHome()`. The legitimate value is always a
64-char SHA-256 hex string, but the function did not enforce this.
`agentTranscriptPath` and `runDir` both validate their inputs via `assertSafe*`
helpers; `globalCachePath` was inconsistent.

### Fix

Added `assertValidScriptSha256(scriptSha256: unknown)` — same pattern as the
existing `assertSafeRunId` / `assertSafeAgentId` guards — that throws if the input
doesn't match `/^[0-9a-f]{64}$/i`. Called at the top of both `globalCachePath` and
`globalCachePathTmp` before any slice/join:

```ts
function assertValidScriptSha256(scriptSha256: unknown): asserts scriptSha256 is string {
  if (typeof scriptSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(scriptSha256)) {
    throw new Error(
      `invalid scriptSha256 ${JSON.stringify(scriptSha256)}: must be a 64-char hex string`,
    );
  }
}
```

## BUG-155 ✅ FIXED — `readManifest` reads manifest.json with no size cap — OOM on large/crafted file

**File:** `src/runtime/crashSweep.ts` — `readManifest`  
**Discovered:** 2026-06-01  
**Severity:** Medium — unbounded memory load from corrupted or crafted manifest.json

### Description

`readManifest()` called `readFileSync(path, 'utf-8')` with no prior size check. A
corrupted or adversarially crafted `manifest.json` of arbitrary size would be loaded
entirely into memory before any parsing occurred. The analogous `recoverFromTranscript`
path in `dispatcher.ts` was already guarded with `TRANSCRIPT_RECOVERY_MAX_BYTES`
(64 MiB); manifest reads had no equivalent guard.

### Fix

Added `MANIFEST_MAX_BYTES = 1 * 1024 * 1024` (1 MiB) constant immediately before
`readManifest`. The function now calls `statSync(path).size` before reading; if the file
exceeds the cap it returns `null` immediately (same treatment as a corrupt manifest), so
the sweep treats the run as unreadable and skips it. `statSync` was already imported.

## BUG-156 ✅ FIXED — `writeAllSync` does not retry on EINTR — partial write on signal-interrupted fd

**File:** `src/util/writeAllSync.ts`  
**Discovered:** 2026-06-01  
**Severity:** Low — only affects callers writing to stdout, pipes, or sockets; regular files on Linux are unaffected

### Description

The `while` loop correctly retried short writes, but if `writeSync` threw a system error
with `code === 'EINTR'` (possible when the process receives a signal mid-syscall on a
pipe/socket fd) the exception propagated immediately with `offset < buf.length`, leaving
a torn JSONL line on the fd.

### Fix

Wrapped the `writeSync` call in a `try/catch`. On `EINTR` the loop body is retried via
`continue`; all other errors are rethrown unchanged.

---

## BUG-W13 ✅ FIXED — parseMemoOpts silently coerces any non-'project' scope to 'global' — invalid scope values misrouted without error

**File:** `src/runtime/ctx/memo.ts`, `parseMemoOpts()`
**Discovered:** 2026-06-01
**Severity:** Low — invalid scope values (e.g. `'local'`, `'user'`) stored/retrieved from wrong global store with no error

### Description

`parseMemoOpts` resolved `scope` as `"project"` only when `optsArg.scope === "project"`,
and fell through to `"global"` for everything else. A caller passing `{ scope: 'local' }`
or `{ scope: 'user' }` silently had their memo entries routed to the global store. No
`TypeError`, no warning — the invalid scope was treated as a valid alias for `"global"`.

### Fix

Replaced the ternary with an explicit allowlist: if `rawScope` is present and is neither
`"global"` nor `"project"`, a `TypeError` is thrown immediately:

```ts
if (rawScope !== "global" && rawScope !== "project") {
  throw new TypeError(
    `ctx.memo: invalid scope "${String(rawScope)}" — must be "global" or "project"`,
  );
}
```

`undefined` scope (opts omitted or `scope` key absent) still defaults to `"global"`.
Updated the JSDoc to match the new contract. Matches the strict validation pattern used
by `resolveMemoryArgs` in `memory.ts`.

---

## BUG-155 ✅ FIXED — logFn fires-and-forgets async ledger write — errors silently discarded while caller sees success

**File:** `src/runtime/ctx/logProgress.ts` — `logFn`  
**Discovered:** 2026-06-01  
**Severity:** Low — ledger write failures (disk full, closed handle) silently dropped; caller always sees `{ ok: true }`

### Description

`void ledgerLog(...).catch(() => undefined)` unconditionally swallowed all ledger write
errors. Every other ctx method (`interrupt`, `gate`) awaits its ledger append and
propagates failures. If the ledger began failing, all `ctx.log()` entries would be lost
with no signal to the user or TUI.

### Fix

Replaced `.catch(() => undefined)` with a `.catch` handler that emits a
`pi-workflows.agent.log.error` overlay event carrying the error message. This matches
the pattern used elsewhere in the file (overlay failures are still swallowed, but ledger
failures are now surfaced to the TUI rather than silently discarded).

## BUG-156 ✅ FIXED — `memoryOversizeWarned` set keyed by name only in auto-injection path — same-name different-scope agents share warn-dedup slot

**File:** `src/runtime/ctx/phase.ts` — auto-injection block  
**Discovered:** 2026-06-01  
**Severity:** Low — incorrect dedup suppresses or incorrectly re-arms oversize warnings when two scopes share the same memory name

### Description

In the auto-injection block in `phase.ts`, `state.memoryOversizeWarned` was checked and
populated using bare `memoryName` rather than the composite `scope:name` key. Two memory
mounts with identical names but different scopes (e.g. `user:planner` and
`project:planner`) shared the same dedup slot: a warning fired for `user:planner` would
suppress the warning for `project:planner`, and vice versa. `readOnlyMemoryKeys` in the
same block already used `memoryReadOnlyKey(memoryScope, memoryName)` as the composite key;
`memoryOversizeWarned` was inconsistently keyed. The explicit `ctx.memory.read` and
`ctx.memory.compact` paths in `memory.ts` were fixed separately (see the earlier
BUG-W10 entry); this is the missed auto-injection site.

### Fix

Replaced both bare `memoryName` references in the auto-injection block with
`memoryReadOnlyKey(memoryScope, memoryName)` — the same composite-key helper already
imported and used on the adjacent `readOnlyMemoryKeys` line:

```ts
// Before
!state.memoryOversizeWarned.has(memoryName)
) {
  state.memoryOversizeWarned.add(memoryName);

// After
!state.memoryOversizeWarned.has(memoryReadOnlyKey(memoryScope, memoryName))
) {
  state.memoryOversizeWarned.add(memoryReadOnlyKey(memoryScope, memoryName));
```

## BUG-157 ✅ FIXED — Unbounded Mermaid output size — no phase or agent cap

**File:** `src/runtime/visualize.ts` — `emitMermaid`  
**Discovered:** 2026-06-01  
**Severity:** Low — potential OOM / blocked renderer for large runs

### Description

`emitMermaid()` iterated all phases and all agents within each phase with no output size
limit. A run with P phases × A agents/phase produces O(P×A) Mermaid lines. At 200×200
that's ~40 k lines (~2–3 MB), which can block the TUI card renderer or OOM
`writeMermaidToTmp` consumers.

### Fix

Added two module-level constants:

```ts
const MAX_PHASES = 100;
const MAX_AGENTS_PER_PHASE = 50;
```

Both loops are now capped to those limits. When agents are truncated within a phase, a
placeholder node `P${i}_trunc["… N more agents (truncated)"]` is appended inside the
subgraph. When phases are truncated, a `PTrunc["… N more phases (truncated)"]` node is
inserted between the last rendered phase and the `End` node so the diagram remains
syntactically valid and visually signals the truncation. The inter-phase edge condition
`i + 1 < phases.length` was updated to `i + 1 < renderedPhaseCount` to avoid a dangling
edge to a non-existent subgraph when truncation is active.

## BUG-153 ✅ FIXED — `jsonStream`: UTF-8 BOM not stripped — `JSON.parse` throws `SyntaxError` on first line of BOM-prefixed stream

**File:** `src/util/jsonStream.ts`, `parseJsonStream()`
**Discovered:** 2026-06-01
**Severity:** Low — first NDJSON line of any BOM-prefixed stream throws `JsonStreamError(reason:'parse')`

### Description

`lineBytes.toString('utf8')` preserves any leading UTF-8 BOM (EF BB BF), producing a `lineStr`
starting with `\uFEFF`. `JSON.parse` does not accept a leading BOM, so the very first line of a
BOM-prefixed stream threw a `JsonStreamError` with `reason:'parse'`. The BOM-strip guard
(`lineStr = lineStr.slice(1)`) had already been added, but `lineStr` was declared `const`,
making the assignment a TypeScript compile error (TS2588) that prevented the fix from taking effect.

### Fix

Changed `const lineStr` to `let lineStr` so the BOM-strip assignment on the next line compiles
and executes correctly.

## BUG-W13 ✅ FIXED — Orphaned fork directory on seed write failure — no cleanup on exception path

**File:** `src/runtime/forkRun.ts` — `wrappedResolveRunDir`  
**Discovered:** 2026-06-01  
**Severity:** Low — orphaned directories accumulate until GC collects them; no data loss

### Description

`mkdirSync(d, { recursive: true })` in `wrappedResolveRunDir` created the fork directory
before the `openSync`/`writeSync` calls that seed `ledger.jsonl` and `cache.jsonl`. If
either write threw (disk full, permissions error, etc.), the exception propagated out of
the resolver while the partially-created directory — containing no manifest — remained on
disk. GC would eventually collect it, but until then it appeared as an orphaned run
directory.

### Fix

Added `rmSync` to the `node:fs` import. Wrapped the entire block from `mkdirSync` through
`seedDone = true` in a `try/catch`: on any thrown error, `rmSync(d, { recursive: true,
force: true })` removes the directory before re-throwing, ensuring no orphaned directories
are left behind on the failure path.

## BUG-W11 ✅ FIXED — Missing fsync on seed writeFileSync calls — durability gap inconsistent with rest of persistence layer

**Discovered:** 2026-06-01  
**Severity:** Low — OS crash between manifest fsync and page-cache flush leaves seed files zero-length/corrupt; fork appears valid but all pre-fork agents re-dispatch instead of cache-hitting

### Description

`wrappedResolveRunDir` in `forkRun.ts` used `writeFileSync` for both seed files
(`ledger.jsonl` at line 292, `cache.jsonl` at line 327). `startWorkflowRun` subsequently
writes and fsyncs the manifest, making the fork run "officially valid". If the OS crashes
between that manifest fsync and the OS flushing the seed page-cache buffers, the manifest
exists but the seed files are zero-length or corrupt. The fork then re-dispatches all
pre-fork agents instead of cache-hitting, defeating the entire purpose of forking from a
checkpoint. The rest of the persistence layer (`cache.ts appendLineSync`) already uses
`openSync` / `writeSync` / `fsyncSync` / `closeSync` to guarantee durability.

### Fix

Replaced both `writeFileSync` calls with explicit `openSync` / `writeSync` / `fsyncSync` /
`closeSync` sequences wrapped in try/finally (matching the `cache.ts` pattern). Updated the
`node:fs` import to drop `writeFileSync` and add `closeSync`, `fsyncSync`, `openSync`, and
`writeSync`.

## BUG-159 ✅ FIXED — checkpointFn TOCTOU: concurrent callers can both return true for the same label

**Discovered:** 2026-06-01
**Severity:** Medium — checkpoint-gated work executes twice when parallel agents race on the same label

### Description

`checkpointFn` in `src/runtime/ctx/checkpointReport.ts` performed
`await opts.cache.hasCheckpoint(label)` and `await opts.cache.setCheckpoint(label, data)`
as two separate async steps with no synchronisation between them. Two concurrent callers
(e.g. parallel `ctx.phase` agents or `Promise.all` in a workflow) could both observe
`hasCheckpoint=false` before either write completed, both fall through to `setCheckpoint`,
and both return `{ok:true, value:true}` — each believing it was the first writer. The
checkpoint-gated work would then execute twice.

### Fix

Added a per-label async mutex (`cpLocks: Map<string, Promise<void>>`) in the closure of
`createCheckpointReportMethods`. Each `checkpointFn` call chains onto the previous in-flight
ticket for the same label (`await previous`) before executing the has→set sequence,
serialising concurrent callers. The `finally` block resolves the current ticket and removes
the map entry when no further callers are queued (checked via identity:
`cpLocks.get(label) === ticket`), preventing unbounded map growth.

## BUG-158 ✅ FIXED — ctrl.jsonl rotation silently drops commands appended between readFileSync and renameSync

**File:** `src/runManager.ts` (`startCtrlWatcher`)
**Discovered:** 2026-06-01
**Severity:** Low — ctrl commands (pause/resume/stop/resume-interrupt) appended in the narrow window between `readFileSync` and `renameSync` are silently lost

### Description

In `processNewLines`, `buf = readFileSync(ctrlFile)` captures the file contents, then after
dispatching commands, `maybeRotate()` calls `renameSync(ctrlFile, archivedFile)`. If a
supervisor appends a command to `ctrl.jsonl` between the `readFileSync` and `renameSync`,
that command lands in the archived file but was never in `buf`. After the rename, `bytesRead`
resets to 0 and a fresh `ctrl.jsonl` is created on the next write; the command in
`.archived` is never read again and is permanently lost.

### Fix

Extracted the command-dispatch loop into a `dispatchLines(data: string): void` helper.
`processNewLines` now calls `dispatchLines(newData)` instead of inlining the loop.
In `maybeRotate`, the prior `bytesRead` offset is saved before the rename; after
`renameSync`, the archived file is read from that offset and any trailing bytes are
passed to `dispatchLines` to drain commands that raced in during the window. The drain
read is best-effort (failures are swallowed) — a failure to read the archived file is
non-fatal and never affects the live run.

## BUG-160 ✅ FIXED — tailEvents may silently break without yielding the terminal transition entry

**File:** `src/client.ts` (`tailEvents`)
**Discovered:** 2026-06-01
**Severity:** Medium — callers relying on `ev.type === 'transition' && ev.to === 'done'` to detect completion silently see the generator exit with no terminal event

### Description

In the poll loop's anti-spin secondary check, `bytesRead` is set to `buf.length` **before**
the inner for-loop, so `buf.length === bytesRead` is always true by the time the check runs
— the guard was a no-op. `getRunState()` then performs its own independent `readFile` on the
ledger. If a terminal transition entry is appended between the `fsp.readFile(ledgerFile)` at
the top of the iteration and the `getRunState()` call, `getRunState` observes the terminal
state while `buf` does not contain that entry. The always-true `buf.length === bytesRead`
condition lets the break fire, exiting the loop before the terminal entry is ever yielded.

### Fix

Replaced the no-op `buf.length === bytesRead` guard with `freshBuf.length === bytesRead`
where `freshBuf` is a new `fsp.readFile(ledgerFile)` call made immediately before the
`getRunState` check. If new bytes have landed since `buf` was read (i.e. the terminal
transition arrived between the two reads), `freshBuf.length > bytesRead` and the break is
skipped; the next iteration reads and yields those bytes normally. When
`freshBuf.length === bytesRead` the file has not grown since the current iteration's `buf`
read, so `getRunState` is reading from the same data and the break is safe.

## BUG-161 ✅ FIXED — logFn backpressure and error surfacing incomplete — no drain path, overlay-only error channel

**File:** `src/runtime/ctx/logProgress.ts` — `logFn()`
**Discovered:** 2026-06-01
**Severity:** Low — ctx.log write failures not visible outside TUI overlay; callers have no explicit drain point

### Description

BUG-155 added error surfacing via `opts.emitOverlayEvent?.('pi-workflows.agent.log.error', ...)`
but that channel is optional and unwired in most environments (unit tests, direct process
spawns without a TUI). Write failures remained invisible in production when no overlay was
attached. Additionally, `void ledgerLog(...).catch(...)` still left writes in-flight with no
caller-accessible drain point — unlike `ctx.gate` and `ctx.interrupt` which await their
ledger writes before resolving.

### Fix

1. Replaced the overlay-only `.catch` with a `pendingWrite` serialisation chain:
   ```ts
   let pendingWrite: Promise<void> = Promise.resolve();
   // inside logFn:
   const write = ledgerLog(opts.ledger, level, msg, deps.nowIso);
   pendingWrite = pendingWrite.then(() => write).catch((err: unknown) => {
     console.error('[pi-workflows] ctx.log ledger write failed:', err);
   });
   ```
   Write failures now always reach `console.error`. Writes are FIFO-serialised through the
   chain so ordering is preserved.
2. Added `drainPendingLog(): Promise<void>` to the factory return, resolving when all
   queued writes have settled.
3. Exposed `drainPendingLog` from `createRunCtxHost`'s return type and body (`runCtx.ts`).
4. In `resumeRun.ts`, added `await ctxHost.drainPendingLog().catch(() => undefined)`
   immediately after `await ledger.flush()` so in-flight log writes are drained before the
   run's terminal resolve fires.

## BUG-162 ✅ FIXED — createOtelMetricsExporter registers no beforeExit/SIGTERM flush hooks — all metrics silently dropped on short-lived process exit

**File:** `src/runtime/otelMetricsExporter.ts`
**Severity:** High — metrics (pi.runs.started, token usage, operation duration, etc.) silently discarded for any workflow completing in under 60 s (the default exportIntervalMillis)

### Description

`createOtelExporter` (traces) was fixed by BUG-W07 to register `process.on('beforeExit', forceFlush)` and `process.on('SIGTERM', shutdown→exit)`. `createOtelMetricsExporter` never received the same fix. The `PeriodicExportingMetricReader` defaults to `exportIntervalMillis=60000`; any workflow completing in under 60 s exits before the reader's first scheduled export fires, silently dropping all accumulated counter/histogram values.

### Fix

Mirrored the hooks from `otelExporter.ts` lines 1115–1123 into `createOtelMetricsExporter`, inserted immediately before the `return { enabled: true, … }` block:

```ts
const onBeforeExit = (): void => {
  void sdk.provider.forceFlush?.();
};
const onSigterm = (): void => {
  void sdk.provider.shutdown?.().finally(() => process.exit(0));
};
process.on("beforeExit", onBeforeExit);
process.on("SIGTERM", onSigterm);
```

## BUG-163 ✅ FIXED — WorkflowClient.#runDir bypasses assertSafeRunId when runsHomeOverride is set — path traversal

**File:** `src/client.ts`
**Severity:** High — path traversal via attacker-controlled runId when `runsHomeOverride` is set

### Description

`#runDir` returned `join(this.#runsHomeOverride, runId)` without calling `assertSafeRunId()`. The else-branch delegated to `runDirFor(runId)` which calls `assertSafeRunId` internally, but the override branch skipped it entirely. A runId of `../../../../etc/passwd` would resolve outside the intended directory. Every caller of `#runDir` (`sendControl`, `getRunState`, `tailEvents`, `resume`) inherited the traversal. The `forkFromCheckpoint` inline `resolveRunDir` closure had the identical pattern.

### Fix

1. Added `assertSafeRunId` to the import from `./util/paths.js` in `client.ts`.
2. Moved `assertSafeRunId(runId)` to the top of `#runDir` (before the branch), so both the override path and the default path are guarded uniformly.
3. Updated the `forkFromCheckpoint` `resolveRunDir` closure to call `assertSafeRunId(id)` before joining with `runsHomeOverride`.

## BUG-164 ✅ FIXED — assertSafeMemoryName allows control characters (\n, \r) — prompt injection in defaultCompactSummarize

**File:** `src/runtime/agentMemory.ts`
**Severity:** Medium — prompt injection via control characters in memory name

### Description

`assertSafeMemoryName` rejected NUL, `/`, `\`, `..`, and leading `.`, but did not reject newlines (`\n`), carriage returns (`\r`), or other ASCII control characters. These are valid Linux directory/file name characters and passed validation unchallenged. In `defaultCompactSummarize` (`ctx/memory.ts`), the name is embedded verbatim as `` `Agent name: ${name}` `` inside an LLM prompt. A name like `"agent\n\nIgnore previous instructions…"` injects arbitrary lines into the prompt, allowing workflow authors who control the `name` parameter to manipulate the compact-memory agent's behavior.

### Fix

Added a control-character check after the leading-dot check in `assertSafeMemoryName`:

```ts
if (/[\x00-\x1f\x7f]/.test(name)) {
  throw new InvalidMemoryNameError(name, "contains control character");
}
```

This covers the full C0 control range (0x00–0x1F, including `\n` and `\r`) plus DEL (0x7F). The NUL check above it is now redundant but kept for documentation clarity.

---

## BUG-165 ✅ FIXED — `memoryCompact` has no concurrent-call guard — duplicate LLM agents and non-deterministic MEMORY.md

**File:** `src/runtime/ctx/memory.ts`  
**Severity:** Medium — wasted LLM calls and non-deterministic compaction output under concurrent access

### Description

`memoryCompact` called `compactMemoryFile` without any per-`(scope, name)` in-flight guard.
If two workflow coroutines concurrently called `ctx.memory.compact('agent', 'user')`:

1. Both read the same original file before either write landed.
2. Both called `defaultCompactSummarize(name, original)`, each spawning a separate pi sub-agent at LLM cost.
3. Both queued writes sequentially. The second call's tail-rescue saw `current` (= first summary) did not `startsWith(original)`, so `tail = ''` and it wrote `summarize(original)` again, overwriting the first result.

Two LLM calls wasted, final MEMORY.md non-deterministic.

### Fix

Added a `compactInFlight: Map<string, Promise<RunCtxBridgeResult<...>>>` closure variable
inside `createMemoryMethods`, keyed by `memoryReadOnlyKey(scope, name)`. Before spawning
a new compaction, `memoryCompact` checks whether a promise for that key already exists and
returns it directly if so — both callers await the same promise and receive the same result.
The map entry is removed in a `finally` block when the work settles, so subsequent calls
(after the first completes) start a fresh compaction as normal.

---

## BUG-166 ✅ FIXED — `forkFromCheckpoint`: `opts.overrides` not validated for JSON-serializability before seed write

**File:** `src/runtime/forkRun.ts`, `wrappedResolveRunDir` seed block  
**Severity:** Medium — silent behavioral divergence (functions/Symbols dropped) or unhelpful TypeError (circular refs)

### Description

`wrappedResolveRunDir` appended `JSON.stringify(overridesRecord)` where `overridesRecord.value` was
`opts.overrides` with no prior serializability guard. Two failure modes:

1. **Silent drop**: `opts.overrides` contains `function` or `Symbol` values — `JSON.stringify` silently
   omits them, so `ctx.cache.get('__fork_overrides__')` returns a structurally different object
   (e.g. `{fn:()=>{}}` becomes `{}`) with no error or warning to the caller.
2. **Unhelpful TypeError**: `opts.overrides` is circular — `JSON.stringify` throws
   `TypeError: Converting circular structure to JSON` from inside the synchronous seed closure;
   the outer catch cleans up the run dir and re-throws the raw error with no mention of
   `opts.overrides` or the callsite.

`checkpointReport.ts` applies `JSON.parse(JSON.stringify(data))` with a descriptive error for the
identical pattern (BUG-W07 fix); `forkFromCheckpoint` never received the same treatment.

### Fix

Replaced the bare `opts.overrides` assignment with an explicit validation block using a custom
`JSON.stringify` replacer that throws on `function` or `symbol` values (catching silent drops
before they happen), wrapped in a `try/catch` that re-throws a descriptive
`TypeError: forkFromCheckpoint: opts.overrides is not JSON-serializable (...)` for both cases.
The seed uses `JSON.parse(rawOverrides)` — the round-tripped clone — as the stored value,
matching the defensive pattern used in `checkpointReport.ts` and `ctx/cache.ts`.

---

## BUG-167 ✅ FIXED — `createOtelExporter` accumulates `beforeExit`/`SIGTERM` listeners — listener leak and redundant shutdowns

**File:** `src/runtime/otelExporter.ts`, `createOtelExporter`  
**Severity:** Medium — `MaxListenersExceededWarning` in test suites; redundant concurrent provider shutdowns on SIGTERM

### Description

Every call to `createOtelExporter` unconditionally registered two new process-level listeners
(`process.on('beforeExit', onBeforeExit)` and `process.on('SIGTERM', onSigterm)`) as new closure
objects. The SDK is globally cached (`_cachedSdk`), so multiple callers sharing the same endpoint
reuse the same provider — but each call captured independent closure references. The per-handle
`shutdown()` only removed its own closures; earlier registrations from other handles persisted.

After N calls, N `beforeExit` and N `SIGTERM` listeners were live on the process. When SIGTERM
fired, all N `onSigterm` closures ran concurrently, each calling `sdk.provider.shutdown()` on the
same (shared) provider and all N scheduling `process.exit(0)` in `.finally()`. In test suites
that called `createOtelExporter` per test without resetting process listeners, this triggered
`MaxListenersExceededWarning` after 10 calls.

### Fix

Replaced the per-call closure approach with three module-level singletons:
- `_processListenersRegistered: boolean` — guards registration to happen at most once.
- `_moduleOnBeforeExit` — calls `_cachedSdk?.provider.forceFlush?.()` via the module-level cache ref.
- `_moduleOnSigterm` — calls `_cachedSdk?.provider.shutdown?.().finally(() => process.exit(0))`.

`_ensureProcessListeners()` registers both listeners on first call and is a no-op on subsequent
calls. `createOtelExporter` calls `_ensureProcessListeners()` instead of `process.on(...)` directly.
`shutdown()` deregisters via `process.off(...)` against the stable module-level references and resets
`_processListenersRegistered`. `_resetOtelSdkCacheForTests()` also deregisters the listeners
and resets the flag so tests get a clean slate between calls.

## BUG-168 ✅ FIXED — Concurrent `readChunk()` from `loopOnce` and `dispose()` — duplicate ledger line processing, phantom spans, double-incremented metrics

**File:** `src/runtime/otelExporter.ts`, `tailRunLedger`; `src/runtime/otelMetricsExporter.ts`, `tailRunLedgerForMetrics`  
**Severity:** Medium — duplicate OTel spans / corrupted trace, double-incremented counters, OTel span lifecycle violation

### Description

Both `tailRunLedger` and `tailRunLedgerForMetrics` share the closure variables `pos` and `buffer`
across two async callers of `readChunk()`. Race: (1) `loopOnce` is suspended inside `await readChunk()`
at the file-read await; (2) the abort signal fires, `onAbort` calls `void dispose()`; (3) `dispose()`
sets `stopped = true` then immediately calls `await readChunk()`. Both invocations concurrently read
the same `pos` value, stat the same file size, allocate the same `len`, issue `fh.read` from the
same byte offset, advance `pos` to the same value, and process the exact same lines.

Every `feedLedgerEntry` / `feedLedgerEntryToMetrics` call fires twice: spans are started and ended
twice, `agent_start` creates a duplicate span with no matching end, and counters are incremented
twice. The second `span.end()` on an already-closed span violates the OTel span lifecycle and
corrupts the exported trace.

### Fix

Added a promise-chain mutex (`readLock`) in each closure. Each call to `readChunk()` appends to the
chain and waits for the previous call to finish before running the body (extracted to
`_readChunkImpl()`). Concurrent callers are serialized — the second caller processes only bytes
appended after the first caller advanced `pos`, so no line is processed twice.

## BUG-169 ✅ FIXED — gate: orphaned gate_requested when waitForGate throws for non-abort reason

**File:** `src/runtime/ctx/gate.ts`
**Severity:** Medium

### Description

The `catch` block around `waitForGate` (introduced by BUG-W07 to handle the abort case) only wrote
`gate_resolved(false)` when `opts.signal?.aborted` was true. If `waitForGate` rejected for any
other reason — IPC failure, network timeout, or an internal error — the condition was false, the
`gate_resolved` append was skipped, and the ledger was left with an orphaned `gate_requested` entry
with no matching `gate_resolved`. Any ledger consumer that expects paired entries would see an
unresolved gate.

### Fix

Removed the `if (opts.signal?.aborted)` guard. `gate_resolved(false)` is now written
unconditionally on any throw from the `waitForGate` block, covering abort, IPC failures, network
timeouts, and all other error paths.

---

## BUG-170 ✅ FIXED — interrupt: orphaned interrupt_requested when signal is pre-aborted

**File:** `src/runtime/ctx/interrupt.ts`
**Severity:** Medium

### Description

`interruptFn` had no early `opts.signal?.aborted` guard before touching state. When the signal was
already aborted at call time, `nextInterruptIdx()` still burned a counter slot and
`ledger.append(interrupt_requested)` still fired. The abort was only detected later at the
`waitForInterrupt` condition, causing a throw that exited through the outer catch with no
`interrupt_resolved` written. Result: an orphaned `interrupt_requested` entry with no paired
resolution, and a wasted `int-N` key. `gate.ts` guarded this with an early return before any
ledger write; `interrupt.ts` had no equivalent.

### Fix

Added a pre-state-mutation abort guard (step 0) after `parseInterruptOpts` but before
`nextInterruptIdx()`. When `opts.signal?.aborted` is true at entry, the function returns
`{ ok: false, error: captureError(signal.reason ?? AbortError) }` immediately — no counter
increment, no ledger write. Mirrors the identical guard in `gate.ts` lines 44–51.

## BUG-172 ✅ FIXED — timerTable: invokeWrapped rethrows SandboxViolationError from timer callbacks — uncaught exception in event loop

**File:** `src/runtime/timerTable.ts`
**Severity:** Medium

### Description

In `invokeWrapped()`, the `catch(reconErr)` block (handling failed `rethrowAcrossRealm`
reconstruction) called `opts.onTimerError?.(violation)` then executed `throw violation`. This throw
escaped the host arrow wrappers (`() => { invokeWrapped(h, wrapped); }`) passed to
`setTimeout`/`setInterval`/`setImmediate` — nothing wrapped those callbacks with try/catch. Node.js
treats such throws as uncaughtExceptions, crashing the process if no handler is registered. For
`setInterval` the situation was worse: if `onTimerError` did not call `dispose()` (e.g. a test
sink), the interval kept firing, producing an uncaught exception on every tick. BUG-151 fixed the
missing `onTimerError` call on the normal path; the exceptional-path `throw` remained.

### Fix

Replaced `throw violation` with `return` in the `catch(reconErr)` block of `invokeWrapped()`.
`opts.onTimerError` is the correct escalation boundary; rethrowing from an async timer callback
achieves nothing useful and is process-crashing. The hook is responsible for failing the run.

---

## BUG-171 ✅ FIXED — interrupt: waitForInterrupt rejection mid-wait leaves interrupt_requested orphaned in ledger

**File:** `src/runtime/ctx/interrupt.ts`
**Severity:** Medium

### Description

When `waitForInterrupt` rejected mid-wait (signal fires after the call started, or IPC error), the
exception propagated directly to the outer `catch` which returned `{ ok: false }` without writing
`interrupt_resolved`. The ledger was left with an `interrupt_requested` entry permanently unpaired.
`gate.ts` already handled this by wrapping `waitForGate` in a dedicated try/catch that writes
`gate_resolved(approved: false)` before re-throwing; `interrupt.ts` had no equivalent wrapper.

### Fix

Wrapped the step-4 `waitForInterrupt` block in a try/catch. On any throw, writes
`interrupt_resolved` with `value: null` and `source: "abort"` before re-throwing, ensuring every
`interrupt_requested` entry is always paired with a resolution regardless of how the wait
terminates. Also added `"abort"` to the `source` union in `src/types/internal/ledger.d.ts` to
type the new cleanup entry. Mirrors the gate.ts BUG-169 pattern.

## BUG-172 ✅ FIXED — queueMicrotask has no MAX_OUTSTANDING cap — unlimited microtask scheduling starves event loop

**File:** `src/runtime/timerTable.ts`
**Severity:** Medium

### Description

BUG-W11's fix added `callbackTable.size >= MAX_OUTSTANDING` guards to `scheduleTimeout`,
`scheduleInterval`, and `scheduleImmediate`, but `queueMicrotask` was skipped. Microtasks are not
stored in `callbackTable` and have no cancellable handle. An adversarial sandbox script could call
`queueMicrotask` in a tight loop — each microtask re-queuing itself — filling the microtask queue
unboundedly. Because the microtask checkpoint drains to empty before the next event-loop tick, this
permanently stalls the host event loop: no I/O, no timers, and no AbortSignal callbacks can fire to
trigger `dispose()`.

### Fix

Added a separate `microtaskCount` counter (not backed by `callbackTable`). `queueMicrotask` now
gates on `microtaskCount >= MAX_OUTSTANDING` using the same threshold — on breach it calls
`dispose()` and `opts.onTimerError?.(makeTableLimitError())`. The counter increments before
scheduling and decrements inside the host microtask wrapper (before the early-exit `disposed`
check, so the count stays accurate even when the bridge is already disposed). `dispose()` resets
`microtaskCount = 0` to prevent re-entrant paths from bypassing the guard after teardown. Also
added `outstandingMicrotasks` to the `stats` getter and `TimerBridge.stats` interface for
test observability.

## BUG-173 ✅ FIXED — sendControl and resume write durably to terminated-run directories without detecting liveness

**File:** `src/client.ts`
**Severity:** Medium

### Description

`sendControl` verified liveness with `fsp.access(dir)` (F_OK), which only confirms the run
directory exists on disk. Terminated run directories persist until GC, so the check passed for
already-finished runs. After termination, `startCtrlWatcher` tears down the poll timer and
`fs.watcher` (`runManager.ts:1323`), so `ctrl.jsonl` is no longer monitored. Any command written
after that point — including `resume()` answers to pending interrupts — was fsynced durably and
silently discarded. Callers had no way to detect this; `resume()` in particular would return
successfully while the workflow was already gone.

### Fix

Added a terminal-state guard in `sendControl` immediately after the directory existence check.
After `fsp.access(dir)` passes, `getRunState(runId)` is called to replay the ledger and derive
the current state. If the state is in `{"done", "failed", "stopped", "cancelled-pre-run"}`, an
`Error` is thrown before any write occurs, with a message identifying the run ID and its terminal
state. Because `resume()` delegates to `sendControl`, it inherits the guard at no extra cost.

## BUG-174 ✅ FIXED — compactMemoryFile: TOCTOU between fs.stat and fs.readFile allows beforeBytes to describe a different inode than original

**File:** `src/runtime/agentMemory.ts`
**Severity:** Low

### Description

Lines 529–531 captured `beforeBytes` via `fs.stat(target)` and then read `original` via
`fs.readFile(target, 'utf8')` as two separate awaited calls, both outside the per-directory write
queue. A concurrent `compactMemoryFile` call (same process or another process) could rename a new
summary file over `target` between these two awaits. When that happened, `beforeBytes` held the
old inode's size while `original` contained the new (already-summarised) file's content. The
rescue logic inside the queue then saw `current.startsWith(original) === false` (summary ≠
original), set `tail = ''`, and called `summarize(original)` on the already-compacted content,
producing a summary-of-a-summary and overwriting the concurrent call's result. BUG-154 applied
the fd-open-then-stat fix to `readMemoryFileWithMeta` but the same TOCTOU was not fixed in
`compactMemoryFile`.

### Fix

Replaced the separate `fs.stat(target)` + `fs.readFile(target, 'utf8')` calls with a single
`fs.open(target, 'r')` that returns a `FileHandle`, followed by `fh.stat()` and
`fh.readFile({ encoding: 'utf8' })` through the same handle (with a `finally` close). Both
operations now refer to the same inode, eliminating the TOCTOU window. Pattern mirrors the
BUG-154 fix in `readMemoryFileWithMeta`.

---

## BUG-175 ✅ FIXED — memoStore replay() does not validate value field — corrupt JSONL entries stored with undefined value

### Location

`src/runtime/memoStore.ts` — `replay()` method, guard block near line 288.

### Description

`replay()` validated `key` (string), `writtenAt` (number), and `ttlMs` (number) on each parsed
JSONL line, but never checked that the `value` field was present. A corrupt or crafted line such
as `{"key":"k","writtenAt":1,"ttlMs":60000}` (no `value` field) passed all guards and was stored
via `this.entries.set(r.key, parsed as MemoEntry)`. `get()` then returned the entry with
`entry.value === undefined`, and `memo_check` returned `{ hit: true, value: undefined }`.

This state is unreachable through normal `set()` calls because `JSON.stringify(undefined)` returns
`undefined` (not a string), causing `set()` to throw before any write. Only a corrupt JSONL file
can produce it. Callers that branch on `result.hit` and then use `result.value` receive
`undefined` unexpectedly.

### Fix

Added `!("value" in r)` to the guard that already checks `key`, `writtenAt`, and `ttlMs`.
Entries missing the `value` field are now silently skipped like other malformed lines.

## BUG-176 ✅ FIXED — reportFn: parsedData spread to overlay cast as Record<string,unknown> is unsound for primitive data arguments

**File:** `src/runtime/ctx/checkpointReport.ts` — `reportFn`, overlay emit block.

### Description

The overlay event was built with `{ data: parsedData as Record<string, unknown> }`. The
`as`-cast is TypeScript-only and has no runtime effect. `parsedData` is the result of
`JSON.parse(JSON.stringify(data))`, which is valid for any JSON-serializable value including
strings, numbers, and arrays. If a workflow author called `ctx.report('event', 'some string')`
or `ctx.report('event', [1,2,3])`, the overlay event received `data: 'string'` or
`data: [1,2,3]` typed as `Record<string,unknown>`. Overlay consumers doing `Object.keys(event.data)`,
`event.data.someField`, or `Object.entries(event.data)` received character-index entries,
`undefined`, or array-index entries respectively. The surrounding try/catch swallowed any
resulting consumer errors silently. The ledger `append` call was unaffected — it always
stored `parsedData` without casting.

### Fix

Added a runtime plain-object guard before building the overlay payload. `overlayData` is set
only when `parsedData` is a non-null, non-array object; otherwise it is `undefined` and the
`data` key is omitted from the overlay event entirely. The `as Record<string,unknown>` cast
is now only applied after the shape check, making it sound.

---

## BUG-156

**File:** `src/runtime/otelExporter.ts`
**Severity:** low

### Description

`_moduleOnSigterm` contained `void _cachedSdk?.provider.shutdown?.().finally(() => process.exit(0))`.
When `sdk.provider.shutdown` is `undefined`, the optional chain `shutdown?.()` short-circuits
to `undefined`. The immediately-following `.finally(...)` is then called on `undefined`,
throwing `TypeError: Cannot read properties of undefined (reading 'finally')` synchronously
inside the SIGTERM handler. This uncaught exception causes the process to exit via
`uncaughtException` rather than the controlled `process.exit(0)`, skipping the intended
shutdown path.

### Fix

Added a second `?.` to chain the `.finally` call: `shutdown?.()?.finally(() => process.exit(0))`.
If `shutdown` is undefined the entire expression short-circuits to `undefined` without
invoking `.finally`, and the `void` operand silently discards it.

---

## BUG-177 ✅ FIXED — Token histogram records Infinity — > 0 guard passes for Infinity, Number.isFinite guard absent on token counts

**File:** `src/runtime/otelMetricsExporter.ts` — `feedLedgerEntryToMetrics`, `agent_end` case.
**Severity:** low

### Description

The `agent_end` case guarded token recording with `if (entry.usage.input > 0)` and
`if (entry.usage.output > 0)`. The `> 0` check correctly rejects `NaN` (`NaN > 0` is
`false`) but passes for `Infinity` (`Infinity > 0` is `true`). A ledger entry with
`usage.input = Infinity` would call `inst.tokenUsage.record(Infinity, ...)`. OTel SDK
behaviour for `Infinity` histogram values is unspecified; most OTLP backends silently
drop or error on the data point. The sibling `durationMs` check at the same site already
used `Number.isFinite(entry.durationMs)` correctly — the same guard was simply missing
from the two token fields.

### Fix

Changed both token guards from `entry.usage.X > 0` to
`Number.isFinite(entry.usage.X) && entry.usage.X > 0`, matching the pattern already
used for `durationMs`.

---

## BUG-178 ✅ FIXED — Tailer buffer string accumulation has no size cap — OOM on large or adversarially crafted ledger line

**Files:** `src/runtime/otelExporter.ts` — `_readChunkImpl`; `src/runtime/otelMetricsExporter.ts` — `_readChunkImpl`.
**Severity:** low

### Description

Both OTel tailers accumulated file bytes into a closure-captured `buffer` string via
`buffer += buf.toString("utf8")` with no upper bound before scanning for newlines.
A ledger entry missing a newline terminator (corrupted or adversarially written) caused
`buffer` to grow to the full file size before any line was emitted, risking Node.js
heap exhaustion. BUG-W12 applied a `DEFAULT_MAX_LINE_BYTES` (4 MiB) guard to
`jsonStream.ts`'s `pending` buffer; the same protection was absent from the two OTel
tailers.

### Fix

Added `MAX_TAILER_BUFFER_BYTES = 4 * 1024 * 1024` (4 MiB) to each file. In
`_readChunkImpl`, immediately before `buffer += buf.toString("utf8")`, checks
`if (buffer.length + buf.length > MAX_TAILER_BUFFER_BYTES)`: logs a `warn`, resets
`buffer = ""`, then continues — allowing the fresh chunk to be appended and scanned
for complete lines rather than silently losing all future events.

---

## BUG-179 ✅ FIXED — logFn log level not validated at runtime — invalid levels silently stored in ledger

**File:** `src/runtime/ctx/logProgress.ts` — `logFn`.
**Severity:** low

### Description

The `level` variable was built from `levelArg` with an `as "info" | "warn" | "error"`
TypeScript cast — a compile-time annotation only. A caller passing `"debug"`,
`"verbose"`, or any arbitrary string bypassed the type system; the invalid level
propagated to `ledgerLog` and the OTel exporter. Downstream consumers that enumerate
exactly the three valid levels (e.g. switch/if chains in ledger readers or alert rules)
would silently miss those entries.

### Fix

Extracted a module-level `VALID_LOG_LEVELS = new Set(["info", "warn", "error"])` and a
`coerceLevel(raw)` helper that returns the candidate string when it is a member of the
set, falling back to `"info"` otherwise. `logFn` now calls `coerceLevel(levelArg)`
instead of performing the unsafe cast, ensuring only the three valid levels ever reach
`ledgerLog` and the overlay event.

## BUG-181 ✅ FIXED — pause() missing W2 abort recheck before SM transition; orphan ledger entry when concurrent stop() fires in the gap
`pause()` performed a single guard (`sm.state !== "running" || ctrl.signal.aborted`) at
entry, then called `pauseGate.pause()` and proceeded directly to `sm.go("paused")`.
Because `stop()` is synchronous and not serialised through `withControlLock`, it can
call `ctrl.abort()` in the window between that guard and the SM transition. If the abort
fires after the SM transition succeeds (state briefly reaches `paused`), the subsequent
`ledger.append` records a pause entry for a run that is already stopping — an orphan
event that misleads trace replay. `resumePaused` already had an analogous W2 recheck
(`sm.state !== "paused" || ctrl.signal.aborted`) before its SM transition; `pause()` had
no equivalent.

### Fix
Added a W2 recheck immediately after `const at = ...` and before `sm.go("paused")`:
```ts
if (sm.state !== "running" || ctrl.signal.aborted) {
  pauseGate.resume();
  return false;
}
```
If `stop()` has fired `ctrl.abort()` in the gap, the gate is rolled back and `pause()`
returns `false` cleanly without writing the ledger, preventing the orphan entry.

## BUG-180 ✅ FIXED — renderMermaidSync reads entire ledger.jsonl with no file-size guard — event loop blocked, unbounded allocation on large ledgers
`renderMermaidSync` called `readFileSync` on `ledger.jsonl` with no size check; for
large/long-running parallel workflows the synchronous read could block the event loop
for the entire I/O duration and allocate a proportionally large `entries[]` before any
entries were discarded by the downstream `MAX_PHASES`/`MAX_AGENTS_PER_PHASE` caps.
Added a 32 MiB guard via `statSync` before `readFileSync`: if the ledger exceeds the
limit the function returns a stub Mermaid diagram with a human-readable warning instead
of blocking on the read. Also added `statSync` to the `node:fs` import.

## BUG-181 ✅ FIXED — tee marker `droppedBytes` undercounts total data loss — only captures triggering chunk
In `writeTee`, the truncation marker was written with `droppedBytes` equal only to the
bytes from the chunk that triggered the cap. After `teeTruncated = true`, all subsequent
chunks were silently discarded in the early-return path with no byte accounting, so a
forensic reader of the tee file would believe only the chunk-local byte count was lost
when the actual total could be orders of magnitude higher. Fixed by: (1) renaming the
marker field to `droppedBytesAtCap` to make the chunk-local scope explicit; (2) splitting
the early-return on `!tee` vs `teeTruncated` so post-cap chunks accumulate into a new
`teeDroppedBytes` variable; (3) initializing `teeDroppedBytes` with the triggering chunk's
drop on first truncation; (4) exposing `teeDroppedBytes(): number` on the `JsonStreamParse`
interface so callers can retrieve the true total after iteration completes.

## BUG-182 ✅ FIXED — `assertSafeAgentId` imposes no maximum length — agentId > 255 bytes causes OS-level ENAMETOOLONG
The allowlist regex `^[A-Za-z0-9._-]+$` had no length quantifier and there was no
explicit length check. An agentId of 300+ characters passed every validation gate but
triggered ENAMETOOLONG at the OS level when the runtime tried to create
`agents/<agentId>.jsonl` (Linux NAME_MAX = 255 bytes). Callers received an opaque
syscall error rather than the descriptive `InvalidAgentIdError` they would get for any
other invalid input. Added an explicit `agentId.length > 128` check before the regex
gate that throws `InvalidAgentIdError` with a clear message including the actual length.
128 characters covers all realistic agentId shapes and leaves headroom well below
NAME_MAX once the `.jsonl` suffix and any path prefix are added.
