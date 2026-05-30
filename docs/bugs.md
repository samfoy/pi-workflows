# Known Bugs

Tracked bugs that haven't been filed as GitHub issues yet. Fixed bugs are marked **✅ FIXED**.

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

## BUG-003 — Dispatcher: signal-killed process (timeout/abort) misclassified as MalformedAgentOutputError

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

## BUG-004 — Dispatcher: timeout sends SIGTERM with no SIGKILL escalation — can hang forever

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

## BUG-005 — ActiveRunsRegistry.reset() does not clear #everLocal, breaking test isolation

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

## BUG-006 — resumeRun uses !TERMINAL_STATES for resumability, diverging from the exported RESUMABLE_STATES contract

**Area:** resumeRun / ledger
**Severity:** medium
**Location:** resumeRun.ts:247-260 — resumability check; ledger.ts:94 — RESUMABLE_STATES definition
**Discovered:** iteration-1

### Description

The exported `RESUMABLE_STATES` constant (the published contract, described as 'Resumable-after-pi-crash states') lists only `{ 'paused', 'running' }`. `resumeRun`'s check at line 248 is `!TERMINAL_STATES.has(finalState)`, which also admits `'pending'` and `'approved'` as resumable. The function even has tailored handling for both states (forcing them to `'running'` via direct ledger appends). Two consequences: (1) `RESUMABLE_STATES` is exported but never imported by `resumeRun`, making it dead as a contract guard; (2) any UI or slash-command caller that gates the resume button on `RESUMABLE_STATES.has(state)` would suppress the button for `pending`/`approved` runs, yet calling `resumeRun` directly would succeed — a confusing split. The `resumeRun` docstring also says the valid set is `{paused, running, failed(parent-crash)}`, making the `pending`/`approved` paths undocumented.

### Suggested Fix

Either (a) extend `RESUMABLE_STATES` to include `'pending'` and `'approved'` and update the docstrings to match, making the behavior explicit and the constant accurate; or (b) change the `resumeRun` check to `RESUMABLE_STATES.has(finalState) || (finalState === 'failed' && ...)` and remove the `pending`/`approved` branches as unsupported paths with an explicit `ResumeNotAllowedError`. Option (a) is likely correct since the implementation code for those cases already exists and is functional.

---

## BUG-007 — dispose() leaks phase subscription, appendEntry shim, and agentDetailDebounceTimer

**Area:** overlay / TUI
**Severity:** high
**Location:** overlay.ts — makeOverlayComponent, component.dispose()
**Discovered:** iteration-1

### Description

The TUI component's `dispose()` method — called by pi-tui when it tears down the overlay externally — only calls `unsub()` and clears `renderTimer`. It does NOT call `unsubPhase()`, does NOT restore `opts.pi.appendEntry` to its pre-shim value, and does NOT clear `agentDetailDebounceTimer`. If pi-tui invokes `dispose()` without the user pressing Esc, the phase-registry subscription fires forever against a dead closure, the agent-log shim remains active on `opts.pi.appendEntry` pointing into garbage-collected state, and an in-flight debounce timer can fire after disposal. The `close()` function handles all of these correctly, but `dispose()` is a separate code path that does not delegate to it.

### Suggested Fix

Extract the cleanup body of `close()` into a shared `cleanup()` helper (guarded by a `let cleaned = false` flag for idempotency). Call `cleanup()` from both `close()` and `dispose()`. The guard prevents double-unsubscription when the user presses Esc and pi-tui also fires `dispose()`.

---

## BUG-008 — GC F4 filter checks the wrong direction: reads candidate's restartedFrom instead of active runs' restartedFrom

**Area:** gcDialog
**Severity:** medium
**Location:** gcDialog.ts — loadGcCandidates, the safeCandidates filter block (~line 80)
**Discovered:** iteration-1

### Description

The intent documented in the PRD comment is: *do not GC run A if a currently-active run B was spawned by restarting A* (B's manifest carries `restartedFrom = A.runId`). The current code does the opposite — it reads *candidate C's* `manifest.restartedFrom` field and skips C if the thing C was restarted FROM is active. That protects the restart-child (C, which is terminal and a valid GC target) rather than protecting the source run (A, whose data the active restart-child B may still reference). In the scenario that needs protection — A is terminal and GC-eligible, B is the active restart of A — nothing in the current filter excludes A from deletion because A's manifest has no `restartedFrom` entry at all.

### Suggested Fix

Build a reverse-lookup set from the active runs: for each active run, read its manifest and collect `restartedFrom` values into a `Set<string> protectedSources`. Then filter candidates with `!protectedSources.has(c.runId)` instead of checking the candidate's own manifest. This requires reading the active-run manifests once at dialog-open time rather than the candidate manifests.

---

## BUG-009 — phaseCursor bounded by totalAgents (all phases) but only running-phase agent rows are rendered, causing phantom cursor movement and wrong Enter target

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — handleAction 'navigate-down' (phase-view branch) and 'open-agent-detail' branch
**Discovered:** iteration-1

### Description

In the `navigate-down` handler for `phase-view`, the upper bound is `snap.totalAgents - 1` — the global agent count across all phases. But `renderPhaseView` only emits `agentRows` entries for the single *running* phase; agents in done and pending phases are omitted. Consequently, the cursor can advance well past the last visible row with no visual feedback (the highlight just disappears). Worse, `open-agent-detail` resolves the target by `flatMap`-ing ALL phases' agents and indexing by `phaseCursor`. If `phaseCursor` has advanced into the done-phase portion of the flat list, pressing Enter opens agent-detail for an agent the user never visually selected.

### Suggested Fix

Use `agentRows.length` (from a fresh `renderPhaseView` call or a cached count) as the exclusive upper bound for `phaseCursor`, not `totalAgents`. The `open-agent-detail` handler should also index into the rendered `agentRows` array rather than the full flatMap of all phases, to keep the two in sync.

---

## BUG-010 — isHotkeyEnabled returns false for p and x on phase-view but dispatchHotkey fires pause/stop actions

**Area:** hotkeys
**Severity:** low
**Location:** hotkeys.ts — isHotkeyEnabled, cases 'p' and 'x'
**Discovered:** iteration-1

### Description

`isHotkeyEnabled` gates `p` and `x` with `if (input.view !== 'runs-list') return false`, making them appear disabled on phase-view. However `dispatchHotkey` has no such view guard for these keys — it dispatches `pause`, `resume`, or `stop` based purely on `runState`. `helpForState` for phase-view explicitly lists `p` and `x` as valid (conditionally enabled) entries, which matches the dispatcher's behaviour but contradicts `isHotkeyEnabled`. Any caller (tests, external tooling) using `isHotkeyEnabled` to determine availability gets wrong answers for phase-view, and the grayed-out help hint shown to the user is misleading when state is running/paused.

### Suggested Fix

Remove the `if (input.view !== 'runs-list') return false` guards from the `p` and `x` cases in `isHotkeyEnabled` so they match the logic in `dispatchHotkey` and `helpForState`: enabled when `runState === 'running'` or `runState === 'paused'`, regardless of view.

---

## BUG-W01 — Workflow: hunt agents silently dropped when output is not bare JSON

**Area:** hunt-bugs-loop workflow  
**Severity:** Medium — bug findings silently lost, no user-visible error  
**Location:** `~/.pi/agent/workflows/hunt-bugs-loop.js`, hunt phase parse loop  
**Discovered:** iteration-1  

### Description

Hunt agents frequently wrap their JSON output in markdown code fences
(` ```json ... ``` `) or add prose before/after the JSON object. The parse loop
strips fences with a regex but fails when agents emit prose like "Here are the
bugs I found:" before the JSON block. The result is silently discarded with a
generic `ctx.log("Could not parse hunt result")`. 4 of 6 agents were dropped in
iteration 1 — nearly all findings lost.

### Suggested Fix

Use a more robust extractor: scan for the first `{` or `[`, then extract the
outermost balanced JSON object/array from that point. Fall back to asking a
triage agent to re-parse the raw text as a last resort.

---

## BUG-W02 — Workflow: fix agents run in parallel against the same worktree

**Area:** hunt-bugs-loop workflow  
**Severity:** High — concurrent edits to the same files cause conflicts and corrupt fixes  
**Location:** `~/.pi/agent/workflows/hunt-bugs-loop.js`, fix phase  
**Discovered:** iteration-1  

### Description

All N fix agents run in parallel via `ctx.phase("fix-N", [...])` against the
same git working directory. If two bugs are in the same file (common), agents
race to read, edit, and write it — last writer wins, earlier fixes are silently
overwritten. The build gate may catch the corruption but by then the fixes are
lost and git history is a mess.

### Suggested Fix

Use `git worktree add /tmp/pi-fix-<bugId> -b fix/<bugId>` to give each fix
agent an isolated working tree. After all fixes succeed, cherry-pick each branch
back to main in order. If worktree setup is unavailable, fall back to
`ctx.pipeline` (serial execution) which eliminates the race at the cost of speed.

---

## BUG-013 — extractJson throws after agent_end ledger entry written and result cached — creates ledger inconsistency and permanent stuck-failure loop

**Area:** runtime/runCtx
**Severity:** high
**Location:** src/runtime/runCtx.ts — runOneAgent, cache-miss try block (~line 390-420): setAgentResult and ledger agent_end called before extractJson; cache-hit block (~line 330-360): agent_end logged but no catch around extractJson
**Discovered:** iteration-1

### Description

In runOneAgent (cache-miss path), opts.cache.setAgentResult and opts.ledger.append({type:'agent_end',...}) are both called BEFORE extractJson is invoked. If the agent returned malformed JSON, extractJson throws, which is caught by the surrounding try/catch and causes opts.ledger.append({type:'agent_error',...}) to also fire. The same agent now has both agent_end and agent_error in the ledger — a consistency violation. Worse: the cached result is retained. On the next run the cache-hit path is taken, which logs agent_end again and then calls extractJson on the same text, throws again, but this time there is NO catch block on the cache-hit path so agent_error is NOT appended. The ledger says the agent succeeded (agent_end present) but runOneAgent rejects, causing the phase to fail silently. This repeats on every run: the cached bad-JSON result is permanently stuck, the workflow can never proceed, and the ledger either over-reports both end+error (first run) or falsely reports success (all subsequent runs).

### Suggested Fix

Move extractJson call to BEFORE opts.cache.setAgentResult and opts.ledger.append({type:'agent_end'}). Only cache and log agent_end after JSON extraction succeeds. Alternatively, catch extractJson parse errors separately and surface them as a new MalformedSchemaOutputError without writing agent_end, so the agent is retryable rather than permanently cached.

---

## BUG-014 — Token budget check is not atomic — concurrent runOneAgent calls all pass the check before any updates budgetSpent, allowing large budget overruns

**Area:** runtime/runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts — runOneAgent, token budget check at function top before the semaphore acquire loop; budgetSpent update inside the try block after dispatch completes
**Discovered:** iteration-1

### Description

budgetSpent is a closure variable. The check 'if (tokenBudget !== null && budgetSpent >= tokenBudget)' and the update 'budgetSpent += result.usage.totalTokens' are not atomic. In a phase with N concurrent agents, all N calls to runOneAgent execute the guard before any of them finish and update budgetSpent. If budgetSpent is 0 and tokenBudget is 1000, all N agents pass the check simultaneously, each spending up to maxTokensPerAgent tokens. The actual spend can be N × maxTokensPerAgent — potentially an order of magnitude over budget with no rejection. The budget cap is effectively advisory-only for any multi-agent phase.

### Suggested Fix

Maintain a committed budget separate from spent budget. Before acquiring the semaphore, add the agent's estimated cost to a 'committed' counter and check committed+spent against the budget. On completion, move from committed to spent; on failure, subtract from committed. Alternatively, enforce the budget inside a serialized budget-manager object rather than a bare closure variable. Simplest fix: increment a 'reserved' counter atomically at the check site and use reserved+spent as the budget signal.

---

## BUG-015 — runtime-api.md documents RetryOpts.maxAttempts but implementation reads opts.attempts — authors using maxAttempts silently get default 3

**Area:** stdlib / docs
**Severity:** high
**Location:** src/runtime/stdlib.ts — retry() function: 'const rawAttempts = opts && typeof opts.attempts === 'number' ? opts.attempts : 3'; docs/runtime-api.md — RetryOpts interface listing maxAttempts
**Discovered:** iteration-1

### Description

runtime-api.md defines RetryOpts with 'maxAttempts?: number // default 3' and 'backoffMs?: number // initial backoff in ms (default 500)'. The stdlib implementation reads 'opts.attempts' (not 'opts.maxAttempts'). An author who reads the docs and passes { maxAttempts: 5, backoffMs: 2000 } will silently use 3 attempts with 100ms backoff instead of 5 attempts with 2000ms — no warning, no error. public.d.ts correctly uses 'attempts' so TypeScript users catch this, but JS workflow authors (the primary target) do not.

### Suggested Fix

Either (a) rename the implementation to read opts.maxAttempts and update public.d.ts to match the docs, or (b) update runtime-api.md to say 'attempts' not 'maxAttempts' and keep the implementation as-is. Read BOTH opts.attempts and opts.maxAttempts with maxAttempts taking priority during the transition to avoid silent breakage for any existing callers.

---

## BUG-016 — runtime-api.md documents ConsensusResult.scores field that does not exist — runtime TypeError for any author following the docs

**Area:** stdlib / docs
**Severity:** high
**Location:** docs/runtime-api.md — ConsensusResult interface and ConsensusOpts; src/runtime/stdlib.ts — consensus() return value; src/types/public.d.ts — ConsensusResult
**Discovered:** iteration-1

### Description

runtime-api.md defines ConsensusResult as '{ agreed: boolean; majorityText: string; scores: ReadonlyArray<{ agentId: string; meanSimilarity: number }> }'. Neither public.d.ts nor the stdlib implementation have a 'scores' field. The implementation returns '{ agreed, majorityText, responses }' where 'responses' is the raw array of agent text strings. An author who reads the docs and accesses result.scores[0].meanSimilarity will get a TypeError (cannot read properties of undefined). There is no runtime warning. Additionally, the docs-only 'similarity' field in ConsensusOpts (described as 'Jaccard floor per pair') is also absent from public.d.ts and silently ignored by the implementation.

### Suggested Fix

Update runtime-api.md to document the actual return shape: 'responses: ReadonlyArray<string>' instead of 'scores'. If per-agent similarity scores are genuinely desired, add them to the implementation and public types simultaneously with the docs update. Remove the undocumented 'similarity' opt or add it to both the implementation and public.d.ts.

---

## BUG-017 — consensus uses a single threshold for both Jaccard similarity floor and pair-fraction agreement — the docs describe two independent parameters but only one is implemented

**Area:** stdlib
**Severity:** medium
**Location:** src/runtime/stdlib.ts — consensus(): single 'threshold' variable used in both the Jaccard comparison and the ratio comparison; docs/runtime-api.md — ConsensusOpts documenting both threshold and similarity
**Discovered:** iteration-1

### Description

runtime-api.md describes two independent ConsensusOpts parameters: 'threshold' (fraction of pairs that must agree, default 0.5) and 'similarity' (Jaccard floor per pair, default 0.6). The implementation has a single 'threshold' (defaulting to 0.6) used for BOTH: 'if (sim >= threshold) crossed++' (Jaccard floor) and 'const agreed = ratio >= threshold' (pair fraction). The 'similarity' field is never read. Consequence 1: setting { threshold: 0.9 } for lenient fraction also makes the Jaccard floor 0.9 (very strict), so 'agreed' will almost always be false. Consequence 2: setting { threshold: 0.2 } for a low Jaccard floor also accepts only 20% of pairs needing to agree. The two-knob design intent is lost and the two concerns cannot be tuned independently.

### Suggested Fix

Split into two variables. Read 'opts.similarity' (default 0.6) for the Jaccard floor used inside 'if (sim >= similarity)'. Read 'opts.threshold' (default 0.5 per docs, or 0.6 to match current behavior) for 'const agreed = ratio >= threshold'. Add 'similarity?: number' to ConsensusOpts in public.d.ts.

---

## BUG-018 — failMode parsing in phase() is outside the try/catch block — adversarial opts can escape the RunCtxBridgeResult envelope

**Area:** runtime/runCtx
**Severity:** low
**Location:** src/runtime/runCtx.ts — phase() function, failMode const declaration before the try block (approximately line 170-175)
**Discovered:** iteration-1

### Description

In the phase() function, failMode is parsed from optsArg before the try block opens: 'const failMode = optsArg !== null && typeof optsArg === 'object' && (optsArg as Record<...>).failMode === 'null' ? 'null' : 'throw''. If optsArg is a Proxy (possible since it crosses the sandbox boundary) and its 'failMode' getter throws, the exception is NOT caught by the surrounding try/catch and does NOT produce a { ok: false, error } envelope. It propagates as an unhandled promise rejection, bypassing the error-reconstruction path in sandbox.ts and surfacing as an uncaught error to the script executor.

### Suggested Fix

Move the failMode parsing inside the try block so any access-time exception is captured by captureError() and returned as { ok: false, error }. Alternatively, JSON-clone optsArg before extracting failMode (the handles loop does this via JSON.parse(JSON.stringify(...)) — apply the same pattern to phase opts).

---

## BUG-019 — runtime-api.md documents retry default backoffMs as 500ms but implementation defaults to 100ms

**Area:** stdlib / docs
**Severity:** low
**Location:** src/runtime/stdlib.ts — retry() function backoffMs default; docs/runtime-api.md — RetryOpts.backoffMs comment
**Discovered:** iteration-1

### Description

runtime-api.md says 'backoffMs?: number; // initial backoff in ms (default 500)' inside RetryOpts. The stdlib.ts implementation uses 'const backoffMs = opts && typeof opts.backoffMs === 'number' && opts.backoffMs >= 0 ? opts.backoffMs : 100'. Authors relying on the documented default for rate-limit back-off scenarios will get 5× shorter delays than expected, likely triggering the same failures immediately.

### Suggested Fix

Either update the implementation default to 500ms to match the docs, or update the docs to say 100ms. Given that 500ms is more sensible as a default for retry scenarios (enough breathing room for transient API failures), updating the implementation to 500ms is preferred.

---

## BUG-020 — runtime-api.md documents consensus default threshold as 0.5 but implementation defaults to 0.6

**Area:** stdlib / docs
**Severity:** low
**Location:** src/runtime/stdlib.ts — consensus() function threshold default; docs/runtime-api.md — ConsensusOpts.threshold comment
**Discovered:** iteration-1

### Description

runtime-api.md documents ConsensusOpts.threshold as 'fraction of pairs that must agree (default 0.5)'. The stdlib.ts implementation defaults to 0.6: 'const threshold = opts && typeof opts.threshold === 'number' ? opts.threshold : 0.6'. Authors who rely on the undocumented default will get stricter consensus checks than the docs promise. Combined with BUG-015 (same threshold used for Jaccard floor), the discrepancy compounds: authors expect 50% of pairs to agree at the Jaccard level, but the actual behavior is 60% of pairs at a 0.6 Jaccard floor.

### Suggested Fix

Align to a single value. The docs say 0.5; the code says 0.6. Decide which is correct and update the other. If BUG-015 is fixed first (splitting into separate similarity/threshold params), the threshold default should be 0.5 (lenient fraction) and similarity default 0.6 (strict per-pair floor).

---

## BUG-021 — fireCtxAbort abort-listener never removed from host AbortSignal on non-abort completion

**Area:** sandbox
**Severity:** medium
**Location:** sandbox.ts, Sandbox.runScript(), ~line 700 — the hostSignal.addEventListener block has no corresponding removeEventListener in success or error paths
**Discovered:** iteration-1

### Description

In runScript(), hostSignal.addEventListener('abort', fireCtxAbort, { once: true }) is registered after the bind script runs. The { once: true } flag only removes the listener when the signal fires. On normal script completion (resolve) or non-abort rejection, raceWithAbort removes its own internal onAbort listener but never removes fireCtxAbort from hostSignal. If the Sandbox is driven by a long-lived or shared AbortSignal (e.g. a session-level controller), each runScript call leaks one listener. Additionally, if dispose() is called and then the signal fires later, signalAbortThunk is invoked into a Context whose timer bridge has been torn down, producing silent unexpected execution in a disposed context.

### Suggested Fix

Wrap the compile+run+raceWithAbort region in a try/finally that calls hostSignal.removeEventListener('abort', fireCtxAbort) unconditionally. Because { once: true } already self-removes on abort, the removeEventListener is a no-op in that case and safe to call.

---

## BUG-022 — __pi_build_ctx and __pi_make_signal left on globalThis throughout script execution — user code can create rogue ctx objects accessing the host bridge

**Area:** sandbox
**Severity:** high
**Location:** sandbox.ts, buildInitScript() — the globalThis.__pi_build_ctx and globalThis.__pi_make_signal assignments are permanent for the lifetime of the Context
**Discovered:** iteration-1

### Description

buildInitScript() assigns globalThis.__pi_build_ctx and globalThis.__pi_make_signal for the bind script (run via vm.runInContext before user code). After the bind, ctx is installed on globalThis.ctx and __pi_signal_pair__ is deleted, but __pi_build_ctx and __pi_make_signal are never removed before user code executes. A script can call globalThis.__pi_build_ctx(arbitraryMeta, arbitraryInput, anySignal) to obtain a second fully-wired ctx that wraps the exact same __runCtxHost bridge, enabling it to call ctx.agent(), ctx.phase(), ctx.log(), and ctx.cache.* outside the phase-tracking and ledger accounting of the higher-level runner. The rogue ctx's budget.spent() still reads the same counter, but untracked phase calls corrupt the run's agent-handle bookkeeping.

### Suggested Fix

After the bind script runs (and ctx is captured), run a small cleanup script via vm.runInContext that deletes globalThis.__pi_build_ctx and globalThis.__pi_make_signal. Store the factories in a host-side closure and re-inject them only at the START of the next runScript bind phase, before user code can observe them.

---

## BUG-023 — Init-script function declarations (wrapHostAsync, __pi_unwrap, etc.) become globalThis properties — user code can overwrite __pi_unwrap to bypass ctx method error handling

**Area:** sandbox
**Severity:** medium
**Location:** sandbox.ts, buildInitScript() — all function declarations at top level of the init script string become globalThis.* properties
**Discovered:** iteration-1

### Description

In buildInitScript(), wrapHostMethod, wrapHostAsync, wrapHostSync, __pi_clone_into_ctx, __pi_reconstruct_error, and __pi_unwrap are declared as top-level function declarations inside a vm script (not wrapped in an IIFE). In JavaScript, top-level function declarations in a script scope create enumerable, writable properties on globalThis. The returned closures from wrapHostAsync reference __pi_unwrap as a free variable resolved through the global scope at call time (not at definition time). User code can therefore do globalThis.__pi_unwrap = (x) => x.value before awaiting ctx.cache.get() or ctx.phase(), causing those calls to return the raw host-realm tagged envelope ({ok, value, error}) instead of the unwrapped value, silently suppressing error throws on host-side failures.

### Suggested Fix

Wrap all helper functions in an IIFE at the top of the init script: (function(){ function wrapHostAsync(...){...} ... globalThis.__pi_build_ctx = ...; }()). This makes the helpers closure-local and removes them from globalThis. The ctx method wrappers created inside the IIFE close over the IIFE-local (not global) references, so overwriting globalThis.wrapHostAsync or globalThis.__pi_unwrap from user code has no effect.

---

## BUG-024 — logSink accumulates across multiple runScript() calls on the same Sandbox instance

**Area:** sandbox
**Severity:** low
**Location:** sandbox.ts, Sandbox constructor (logSink init) and Sandbox.runScript() return statement
**Discovered:** iteration-1

### Description

this.logSink is a persistent array initialized once in the Sandbox constructor and appended to by every console.log and timer-error call for the lifetime of the Sandbox. runScript() returns this.logSink.slice() — all logs since construction, not just those from the current call. The convenience runScript() free function creates a new Sandbox per call (so it is unaffected), but the Sandbox class is explicitly noted as a candidate for reuse in slice 8a ('slice 8a may want to reuse Contexts for resume'). Any reuse scenario — including resume or the planned slice-8a workflow runner — would see logs from earlier runs in every subsequent result.

### Suggested Fix

At the start of runScript(), record const logStart = this.logSink.length and return this.logSink.slice(logStart) instead of this.logSink.slice(). The full history remains available via takeLog() for callers that need it.

---

## BUG-025 — Pre-run abort guard creates Error without name='AbortError', inconsistent with raceWithAbort

**Area:** sandbox
**Severity:** low
**Location:** sandbox.ts, Sandbox.runScript(), the if (this.opts.signal.aborted) block near the top of the method
**Discovered:** iteration-1

### Description

The early abort check at the top of runScript() throws: new ContextError('aborted before run') — a plain Error with name 'Error'. raceWithAbort() always sets Object.defineProperty(e, 'name', { value: 'AbortError' }) on its abort rejection. Scripts that catch errors and branch on e.name === 'AbortError' (a standard pattern for abort handling) will see 'Error' for pre-run aborts and 'AbortError' for mid-run aborts, making abort handling inconsistent depending on the race timing.

### Suggested Fix

After constructing the ContextError, call Object.defineProperty(e, 'name', { value: 'AbortError', configurable: true, writable: true, enumerable: false }) before throwing — matching the pattern in raceWithAbort.

---

## BUG-026 — approved/pending states listed as resumable in comment but excluded from RESUMABLE_STATES — handlers are dead code and those states are incorrectly rejected

**Area:** resumeRun / ledger
**Severity:** high
**Location:** resumeRun.ts lines ~134-165 (resumability check) and ~215-235 (dead elseif branches); ledger.ts RESUMABLE_STATES definition
**Discovered:** iteration-1

### Description

In resumeRun.ts the resumability guard comment explicitly states 'paused, running, approved, pending: resumable', but RESUMABLE_STATES (imported from ledger.ts) is defined as only {paused, running}. The check `RESUMABLE_STATES.has(finalState)` therefore returns false for both 'approved' and 'pending', causing ResumeNotAllowedError to be thrown before execution ever reaches the state-machine reset section. The two elseif branches that handle `finalState === 'approved'` and `finalState === 'pending'` (which append the correct ledger transitions) are completely unreachable dead code. A run left in 'approved' or 'pending' state after a pi crash — e.g. the process was killed while waiting for the approved→running runManager.start call — cannot be resumed even though the PRD and code comments explicitly intend those states to be resumable. NON_TERMINAL_STATES in ledger.ts correctly includes both 'approved' and 'pending', showing the original intent.

### Suggested Fix

Add 'approved' and 'pending' to RESUMABLE_STATES in ledger.ts: `export const RESUMABLE_STATES: ReadonlySet<RunState> = new Set<RunState>(['paused', 'running', 'approved', 'pending']);`. Alternatively, expand the resumeRun check to `RESUMABLE_STATES.has(finalState) || finalState === 'approved' || finalState === 'pending'` without changing the exported constant if downstream consumers depend on its current semantics.

---

## BUG-027 — RunStateMachine.go() has no concurrency guard — isValidTransition check and currentState update are not atomic, allowing two concurrent calls to both pass validation against the same stale state

**Area:** ledger
**Severity:** medium
**Location:** ledger.ts RunStateMachine.go() method (~line 185); race materializes where sm.go('done') in promise body races with pause's sm.go('paused') in controlChain callback
**Discovered:** iteration-1

### Description

In RunStateMachine.go(), the pattern is: (1) read `this.currentState` as `from`, (2) call `isValidTransition(from, to)`, (3) `await this.writer.append(entry)`, (4) `this.currentState = to`. Step 4 only executes after the async append resolves. If two callers invoke `go()` concurrently — e.g. the sandbox script completing and calling `sm.go('done')` while a `pause` control-chain callback calls `sm.go('paused')` — both read the same `from` state ('running'), both pass validation, both enqueue their writes. The LedgerWriter's writeQueue serializes the actual disk writes, but both transitions commit successfully. The ledger then contains `running→done` followed by `running→paused` (or vice versa), and replayState emits an invalid-transition warning for the second entry but the final replayed state is wrong.

### Suggested Fix

Serialize go() calls through an internal queue analogous to LedgerWriter.writeQueue: maintain a `private goQueue: Promise<void> = Promise.resolve()` in RunStateMachine, then in go() enqueue the full validate+append+advance as a single chained step so the second call sees the updated state from the first.

---

## BUG-028 — Resume lock held during interactive approval gate — lock blocks concurrent-resume detection for the entire duration of user input

**Area:** resumeRun
**Severity:** medium
**Location:** resumeRun.ts — acquireResumeLock call at ~line 167 precedes runApprovalGate at ~line 218
**Discovered:** iteration-1

### Description

In resumeRun.ts, `acquireResumeLock` is called synchronously before `runApprovalGate`. The approval gate can block for an arbitrarily long time (seconds to minutes) waiting for the user to accept or reject the prompt. During this entire window the .resume.lock file is held, so any other pi process that attempts to resume the same run will be correctly blocked — but a legitimate scenario is that the first pi process crashes mid-approval (after acquiring the lock but before the user responds). The stale-lock detection path in acquireResumeLock requires the original PID to be dead, which is correct, but if the first process is still alive and stuck at the prompt, the second process is blocked forever with only a user-visible error. More concretely: a resumed run that is then cancelled at the approval prompt still held the lock the whole time, and any subsequent legitimate resume from another window would fail with ResumeLockedError until the first process cleans up.

### Suggested Fix

Move acquireResumeLock to after the approval gate resolves with `approved: true`. Only acquire the lock once the user has consented and actual run execution is about to begin. If the approval is rejected, no lock is needed. This narrows the lock window to the actual execution period.

---

## BUG-029 — stderrTee WriteStream not closed on !child.stdout early-exit path in dispatchAgent

**Area:** dispatcher
**Severity:** low
**Location:** dispatcher.ts — early return block for `if (!child.stdout)` at ~line 290
**Discovered:** iteration-1

### Description

When child.stdout is null (line ~290 in dispatcher.ts), dispatchAgent correctly closes `tee` via the tee.end() / 'close' Promise before throwing AgentSubprocessError. However `stderrTee` is never ended or closed on this path. The `stderrTee.end()` is only called via the child.stderr 'end' event handler (normal path) or the `else` branch (child.stderr also null). If child.stdout is null but child.stderr is non-null, the 'end' event on child.stderr may never fire (the child never properly started), leaving stderrTee open. The writable stream holds an open file descriptor for the stderr capture file until GC eventually reclaims it.

### Suggested Fix

In the `!child.stdout` early-exit block, add `stderrTee.end()` (or `stderrTee.destroy()`) before or alongside the existing `tee.end()` cleanup, mirroring the pattern used for `tee`.

---

## BUG-030 — SIGKILL escalation timer (killHandle) inside timeout callback has no reference and cannot be cleared if child exits from SIGTERM

**Area:** dispatcher
**Severity:** low
**Location:** dispatcher.ts — inner killHandle setTimeout inside the timeoutHandle callback (~line 310)
**Discovered:** iteration-1

### Description

In dispatchAgent the outer `timeoutHandle` callback sends SIGTERM then creates an inner `killHandle = setTimeout(() => child.kill('SIGKILL'), 5000)`. `killHandle` is immediately `unref()`'d and has no reference outside the callback closure, so it cannot be cancelled. If the child exits cleanly from SIGTERM before the 5-second SIGKILL fires, the escalation still runs. Node.js's ChildProcess.kill() on an already-exited process is safe (throws or returns false caught by the surrounding try/catch), but the pattern creates a dangling timer after dispatchAgent has already resolved. In a high-throughput scenario with many agents timing out, a large number of these orphaned SIGKILL timers accumulate until they fire.

### Suggested Fix

Promote killHandle to outer scope with `let killHandle: ReturnType<typeof setTimeout> | undefined` and add `clearTimeout(killHandle)` in the post-stream cleanup after `await exitPromise`. This cancels the escalation if the child exits before the 5-second window.

---

## BUG-031 — phaseCursor not clamped when running agents decrease or phase completes

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts makeOverlayComponent › debouncedRender (does not clamp phaseCursor) and navigate-back (does not reset phaseCursor on phase end)
**Discovered:** iteration-1

### Description

debouncedRender clamps `cursor` (runs-list) when the snapshot shrinks but never clamps `phaseCursor`. When a running phase ends and its agents disappear, `phaseCursor` retains its prior value. On the next phase-view render, `buildRender` passes the stale `phaseCursor` to `renderPhaseView`, which silently drops the highlight (cursor >= agentRows.length). Worse, when the next phase starts, `phaseCursor` can immediately point to the wrong agent index from the previous phase, causing an unexpected agent-detail open on Enter.

### Suggested Fix

Inside debouncedRender, after rebuilding lastSnapshot, also clamp phaseCursor: if in phase-view, recompute visibleAgents from the phaseRegistry snapshot and do `if (phaseCursor >= visibleAgents) phaseCursor = Math.max(0, visibleAgents - 1)`. Also reset phaseCursor to 0 in the phase-subscription callback when the opened run's active phase changes.

---

## BUG-032 — helpForState marks 'r' as disabled for paused runs on runs-list, but dispatchHotkey enables r→resume for paused

**Area:** overlay / TUI
**Severity:** medium
**Location:** hotkeys.ts helpForState (runs-list branch, 'r' entry)
**Discovered:** iteration-1

### Description

In helpForState for the 'runs-list' view, the 'r' bullet is computed as `dis('r', 'restart', noSel || !isTerminal)`. This marks r as disabled whenever runState is 'paused' (because paused is not in TERMINAL). However, isHotkeyEnabled explicitly returns true for r when runState === 'paused' on runs-list, and dispatchHotkey dispatches `{ kind: 'resume' }` for that case. The help line incorrectly grays out r for paused runs, making the resume-via-r shortcut undiscoverable.

### Suggested Fix

Change the disabled predicate to `noSel || (!isTerminal && !isPaused)` so that r shows as enabled (labeled 'resume') when the run is paused, matching isHotkeyEnabled and dispatchHotkey. Optionally use `isPaused ? 'resume' : 'restart'` for the label.

---

## BUG-033 — isHotkeyEnabled unconditionally returns false for 'r' on phase-view, contradicting dispatchHotkey and helpForState

**Area:** overlay / TUI
**Severity:** low
**Location:** hotkeys.ts isHotkeyEnabled (case 'r')
**Discovered:** iteration-1

### Description

isHotkeyEnabled's 'r' case short-circuits with `if (input.view !== 'runs-list') return false`, so it returns false for phase-view. But dispatchHotkey handles r on phase-view (dispatching resume on paused or restart-requested on terminal), and helpForState for phase-view includes r in the help list with correct enabled/disabled logic. Any caller using isHotkeyEnabled to gate r on phase-view (e.g. a future test harness or accessibility layer) will incorrectly conclude r is disabled.

### Suggested Fix

Extend the 'r' case to also return true when `input.view === 'phase-view' && !input.isRemote && (input.runState === 'paused' || TERMINAL.has(input.runState))`, matching the dispatchHotkey and helpForState logic for phase-view.

---

## BUG-034 — navigate-up/down in agent-detail view adjusts the runs-list cursor, not a log-scroll offset

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts makeOverlayComponent › handleAction cases 'navigate-up' and 'navigate-down'
**Discovered:** iteration-1

### Description

handleAction for 'navigate-up' and 'navigate-down' only special-cases 'phase-view'; for agent-detail it falls through to the `cursor--` / `cursor++` branch, which adjusts the runs-list cursor variable. The help text for agent-detail shows '↑↓ jk scroll', but no scroll state exists for the agent log tail and no scroll offset is passed to renderAgentDetail. The net effect is that pressing j/k in agent-detail silently mutates the hidden runs-list cursor without scrolling the visible log, and snaps the selection when the user returns to runs-list.

### Suggested Fix

Add an `agentLogScrollOffset` variable (number, 0-based). In navigate-up/down when view === 'agent-detail', adjust agentLogScrollOffset clamped to [0, agentLogTail.length - visibleLines] and pass it to renderAgentDetail. Leave the runs-list cursor unmodified. Update renderAgentDetail to accept and apply the offset.

---

## BUG-035 — F4 GC guard direction is inverted: protects restart-of-active-original, but not source-of-active-restart

**Area:** gcDialog
**Severity:** medium
**Location:** gcDialog.ts loadGcCandidates (F4 filter, lines checking restartedFrom against activeRunIds)
**Discovered:** iteration-1

### Description

loadGcCandidates F4 filter reads each GC candidate C's own `restartedFrom` field and skips C if that value is in activeRunIds — i.e. it skips a terminal restart-run when the run it was restarted FROM is still active. The comment and PRD intent describe the opposite: skip the SOURCE run (the one that was restarted) when the RESTART SIBLING is still running, to avoid deleting artifacts the active restart depends on. As written, the original source run (GC candidate) is NOT protected when its restart sibling is active and running; only the (already-terminal) restart is protected in the edge case where the original is somehow still active.

### Suggested Fix

To protect the source: for each candidate C, check whether any active run B has `B.manifest.restartedFrom === C.runId`. This requires reading active runs' manifests (or passing a map of activeRun→restartedFrom). The current filter can remain as an additional guard but is insufficient on its own for the stated intent.

---

## BUG-036 — applyGc deletes without re-validating candidates against current active run state

**Area:** gcDialog
**Severity:** high
**Location:** gcDialog.ts applyGc (no active-state re-check before rmSync)
**Discovered:** iteration-1

### Description

The GC dialog is opened (loadGcCandidates runs), the user reads the summary, then confirms. applyGc receives the candidate list captured at dialog-open time and calls rmSync on each runDir without re-checking whether any candidate has since transitioned to active (e.g. a paused run resumed, or a cancelled-pre-run was retried). In practice this window is short, but it's observable: if a run is restarted between 'g' and the final 'y/Enter', its directory is deleted while the new run instance is live, corrupting its working state.

### Suggested Fix

Before the deletion loop in applyGc, accept an optional `activeRunIds` set. For each candidate, re-read its manifest (or accept the current active set from the caller) and skip any runId now present in activeRunIds, logging a warning. The overlay's gc-apply handler should pass the freshly-computed active set at the moment the user confirms.

---

## BUG-037 — CacheStore.runCompaction builds snapshot before queue drains — concurrent in-flight writes silently dropped from compacted file

**Area:** runtime/cache
**Severity:** high
**Location:** src/runtime/cache.ts — CacheStore.runCompaction(), lines 293–319 (snapshot build at 298–308, queue chain at 312–313)
**Discovered:** iteration-1

### Description

runCompaction() captures the snapshot string from the in-memory maps synchronously (lines 298–308) before chaining the snapshot write onto writeQueue. A concurrent caller that has already called appendRecord() (queuing its disk write) but has not yet completed `await appendRecord()` — and therefore has not yet called agentResults.set/authorCache.set — will have its write execute against the old cache.jsonl (before the rename), but the rename replaces the file with a snapshot that was built before that write was reflected in memory. Concrete sequence: (A) A calls appendRecord(a), B calls appendRecord(b) — both queued; (B) A's write completes, A.memory.set(a), A triggers runCompaction; (C) snapshot = {a} only, because B.memory.set(b) hasn't run; (D) queue is now [B's write, compaction rename]; (E) B writes to old cache.jsonl; (F) rename overwrites with snapshot missing b; (G) B.await resolves, B.memory.set(b) runs — memory has b, disk does not. Crash after step G loses b on replay.

### Suggested Fix

Move the snapshot construction inside the .then() callback so it executes after all pending disk writes complete and their memory updates have been applied: `const next = this.writeQueue.then(() => { const snap = this.buildSnapshotString(); return this.writeSnapshotAndRename(snap); })`. Extract the snapshot-building loop into a private buildSnapshotString() helper.

---

## BUG-038 — writeParentLivenessFields read-merge-write is unguarded — concurrent slice-6 and slice-8a manifest writes lose each other's fields

**Area:** manifestWriter
**Severity:** medium
**Location:** src/runtime/manifestWriter.ts — writeParentLivenessFields(), lines 80–121 (read at 88, rename at 120)
**Discovered:** iteration-1

### Description

writeParentLivenessFields() performs an unguarded read → merge → tmp-write → rename sequence. No per-runDir mutex exists. If slice-8a (which writes workflowName, runId, startedAt, etc.) and slice-6 (which calls writeParentLivenessFields for parentPid/parentStartTime/parentBootId) execute concurrently on the same runDir, both can read the same empty or partial manifest, build independent merged objects, and race on the rename. Last rename wins; the other's fields are silently lost. Missing parentPid/parentStartTime/parentBootId breaks the slice-5.8.2 liveness sweep (orphan detection). Missing workflowName/runId breaks the TUI overlay and GC.

### Suggested Fix

Introduce a per-runDir write mutex using the same acquireWriteSlot pattern from trustStore.ts, keyed by the manifest target path. Alternatively, define a single authoritative manifest writer (e.g., in slice-8a) that calls captureParentLiveness() itself and writes all fields in one atomic operation, eliminating the multi-writer race entirely.

---

## BUG-039 — writeResultFile does not fsync tmp file before rename — result.json durability gap on crash

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — writeResultFile(), lines 227–235
**Discovered:** iteration-1

### Description

writeResultFile() calls fs.writeFile(tmp) then fs.rename(tmp, target) with no fsync between them. The rename is atomic at the POSIX level, but the payload written by fs.writeFile may still reside only in the OS page cache at the time of rename. A power failure or kernel crash immediately after rename can leave result.json pointing to a file whose data was never flushed to storage, producing a zero-length or corrupt result on next read. By contrast, CacheStore.writeSnapshotAndRename() and CacheStore.appendLineSync() both explicitly call fsyncSync() before returning. The inconsistency is notable because result.json is the primary artifact consumers read after a run completes.

### Suggested Fix

Open the tmp file with openSync, writeSync the body, fsyncSync, closeSync, then fs.rename — mirroring writeSnapshotAndRename() in cache.ts. The deliverRunResult() already treats the write as non-fatal, so this is purely a durability improvement.

---

## BUG-040 — writeResultFile tmp filename has no entropy — sub-millisecond double-invoke produces same path, races on rename

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — writeResultFile(), line 232
**Discovered:** iteration-1

### Description

The tmp filename is `result.json.tmp-<process.pid>-<Date.now()>`. If deliverRunResult() is invoked twice for the same runDir within the same millisecond (e.g., error-path retry or test harness double-fire), both calls compute the identical tmp path. The second fs.writeFile() silently overwrites the first's in-flight content; the losing rename then throws ENOENT because the winning rename already moved the file away. manifestWriter.ts and trustStore.ts both append randomBytes(4).toString('hex') to their tmp names precisely to prevent this; writeResultFile does not.

### Suggested Fix

Append a 4-byte random hex suffix: `result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`. Import randomBytes from node:crypto (already imported in trustStore.ts and manifestWriter.ts as a pattern).

---

## BUG-041 — cancelReasonText returns 'approval denied' for decision.approved === true — misleading result card copy

**Area:** resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — cancelReasonText(), lines ~163–170
**Discovered:** iteration-1

### Description

cancelReasonText() contains `if (decision.approved) return 'approval denied'` (the second guard at line ~165). When an ApprovalDecision with approved=true is passed for a cancelled-pre-run outcome — an inconsistent state reachable if the approval result and cancellation path diverge — the result card displays 'Approval: approval denied' even though the stored decision record says the workflow was approved. This makes it impossible to distinguish a genuine denial from a cancellation-despite-approval, and will mislead any audit trail built on the card's details.approval field.

### Suggested Fix

Replace `if (decision.approved) return 'approval denied'` with `if (decision.approved) return 'cancelled despite approval (unexpected state)'` or narrow the guard to `if (!decision.approved)` and restructure the branches so approved=true falls through to a descriptive fallback rather than silently mislabeling the outcome.

---

## BUG-042 — promptSnippet uses `ctx.pipeline()` which is undocumented in runtime-api.md, authoring.md, and SKILL.md

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:183,232-238
**Discovered:** iteration-1

### Description

The `promptSnippet` in `writeWorkflowTool.ts` (lines 232–238) demonstrates `ctx.pipeline(items, ...stages)` as a standard API, and the `promptGuidelines` (line 183) also describe it. But `ctx.pipeline` does not appear anywhere in `runtime-api.md`, `authoring.md`, or `SKILL.md`. LLMs reading the promptSnippet will generate workflow code that calls `ctx.pipeline()` and get a ReferenceError at runtime.

### Suggested Fix

Either document ctx.pipeline in runtime-api.md (signature, semantics, example) and add it to the SKILL.md table, or remove it from the promptSnippet and promptGuidelines until it is implemented and documented.

---

## BUG-043 — promptSnippet uses `ctx.budget.spent()` which is undocumented everywhere

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:245-246
**Discovered:** iteration-1

### Description

Line 246 of the `promptSnippet` in `writeWorkflowTool.ts` uses `ctx.budget.spent()`, with a comment showing it as a normal API call. `ctx.budget` is not defined in `runtime-api.md`, `authoring.md`, or `SKILL.md`. LLMs will generate code calling `ctx.budget.spent()` and get a TypeError at runtime.

### Suggested Fix

Either document ctx.budget in runtime-api.md (interface, methods, semantics) and add it to the SKILL.md table, or remove the budget usage from the promptSnippet.

---

## BUG-044 — `promptGuidelines` and promptSnippet use `ctx.phase(name, handles, { failMode })` but runtime-api.md documents no third argument

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

## BUG-055 — Token budget enforcement races in parallel phases — budget can be overshot

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: runOneAgent() lines 397-399
**Discovered:** iteration-2

### Description

In runOneAgent, the budget check `if (tokenBudget !== null && budgetSpent >= tokenBudget)` executes before dispatch, and `budgetSpent` is updated after each agent completes. In a parallel phase, all N agents check the budget simultaneously before any has updated it — if budgetSpent is near the limit, all N pass the check and all N run. The budget can be overshot by up to (N-1) * max_agent_tokens. The comment 'checked before dispatch so we don't start an agent we've already budgeted out of' is accurate for sequential phases but not parallel.

### Suggested Fix

Track budgetSpent as an atomic accumulation — increment an optimistic counter before dispatch (not after) and throw if the pre-increment value already exceeds budget. Or document the race as a known limitation (soft cap, not hard cap) in comments and docs.

---

## BUG-056 — failMode invalid values silently coerced to 'throw' — typos undetectable

**Area:** runtime / runCtx
**Severity:** low
**Location:** src/runtime/runCtx.ts: phase() lines 188-194
**Discovered:** iteration-2

### Description

The failMode parsing logic is `(optsArg as ...).failMode === 'null' ? 'null' : 'throw'`. Any value that is not exactly the string `'null'` — including typos like `'Throw'`, `'NULL'`, `'null-on-error'`, or even `true` — is silently accepted and treated as `'throw'`. Authors who misspell `failMode: 'null'` will get `failMode: 'throw'` behavior with no error or warning, making these bugs extremely hard to notice.

### Suggested Fix

After parsing failMode, validate that when `optsArg.failMode` is present it must be either `'throw'` or `'null'`. Throw TypeError for any other value.

---

## BUG-057 — phase() failMode='null' path casts Array<AgentResultLike | null> to readonly AgentResultLike[] — drops | null from bridge type

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts: phase() line 321
**Discovered:** iteration-2

### Description

In the failMode='null' error path, `out` is declared as `Array<AgentResultLike | null>` and correctly contains nulls for failed agents, but the return is `{ ok: true, value: out as readonly AgentResultLike[] }`. The cast erases `| null` from the bridge result's value type. The sandbox wrapper receives `RunCtxBridgeResult<readonly AgentResultLike[]>` and its type-level knowledge that elements can be null is lost, breaking the type contract downstream.

### Suggested Fix

Change the return type of the host bridge method to `RunCtxBridgeResult<readonly (AgentResultLike | null)[]>` for this path, or update `RunCtxHost.phase` to reflect nullable elements. The cast should be `out as readonly (AgentResultLike | null)[]`.

---

## BUG-058 — runtime-api.md ctx.phase signature missing opts third parameter — failMode undiscoverable from docs

**Area:** docs
**Severity:** low
**Location:** docs/runtime-api.md: ctx.phase section, line ~118
**Discovered:** iteration-2

### Description

The runtime-api.md documents `ctx.phase(name, handles)` with a two-parameter signature and `AgentResult` return type (non-nullable). The actual signature is `phase(name, agents, opts?)` with `PhaseOpts` accepting `failMode` and a return of `ReadonlyArray<AgentResult | null>`. Authors reading only the docs will not know about `failMode: 'null'` and cannot write fault-tolerant workflows that handle partial failures.

### Suggested Fix

Update the docs signature to `phase(name: string, agents: ReadonlyArray<AgentHandle>, opts?: PhaseOpts): Promise<ReadonlyArray<AgentResult | null>>` and add a PhaseOpts table documenting `failMode`.

---

## BUG-059 — runtime-api.md ConsensusOpts and ConsensusResult document non-existent fields; wrong threshold default

**Area:** docs
**Severity:** medium
**Location:** docs/runtime-api.md: ctx.consensus section lines 268-286
**Discovered:** iteration-2

### Description

The docs document `ConsensusOpts.similarity` (Jaccard floor per pair) and `ConsensusResult.scores` (per-agent mean similarity array) — neither field exists in the implementation or in public.d.ts. The docs also state threshold default is `0.5` but the implementation defaults to `0.6`. Additionally `consensus` uses a single `threshold` value for both the Jaccard similarity floor AND the pair-fraction agreement check — they cannot be set independently as the docs imply. Code written against the documented interface will silently receive wrong results or undefined fields.

### Suggested Fix

Remove `similarity` from ConsensusOpts, remove `scores` from ConsensusResult, correct default from 0.5 to 0.6, add a note that threshold controls both the per-pair floor and the pair-fraction check.

---

## BUG-060 — runtime-api.md RetryOpts documents wrong field name maxAttempts and wrong backoffMs default 500

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md: ctx.retry section lines 335-348
**Discovered:** iteration-2

### Description

The docs show `RetryOpts.maxAttempts` (default 3) and `backoffMs` default 500. The actual implementation reads `opts.attempts` (not `maxAttempts`) and defaults `backoffMs` to 100. Code written from the docs will silently use the wrong field name — `opts.maxAttempts` is ignored (falls through to the default of 3 attempts) and will get 100ms backoff instead of the documented 500ms. The example in the docs passes `{ maxAttempts: 5, backoffMs: 1000 }` which would silently use 3 attempts instead of 5.

### Suggested Fix

Rename `maxAttempts` to `attempts` in the docs (matching public.d.ts and stdlib implementation), correct backoffMs default from 500 to 100, and fix the example.

---

## BUG-061 — `fireCtxAbort` abort listener never removed from `hostSignal` after normal script completion

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `Sandbox.runScript`, abort-listener registration block (~line 550 area)
**Discovered:** iteration-2

### Description

In `runScript`, `hostSignal.addEventListener('abort', fireCtxAbort, { once: true })` is called to wire the host AbortSignal to the Context-realm abort thunk. The listener is never explicitly removed via `removeEventListener` when the script completes normally or throws. The `{ once: true }` flag only auto-removes on signal fire. If the script finishes without abort, `fireCtxAbort` — which closes over `signalAbortThunk`, a Context-realm function — stays registered on `hostSignal` indefinitely. This (1) prevents the vm.Context from being GC'd after `dispose()` as long as the AbortController lives, and (2) on a long-lived or reused AbortController accumulates multiple stale listeners across runs.

### Suggested Fix

Wrap the `raceWithAbort` call in a try/finally and unconditionally call `hostSignal.removeEventListener('abort', fireCtxAbort)` in the finally block.

---

## BUG-062 — `RunCtxHostInternal` missing `tokenBudget` field — `ctx.budget.total` always `undefined`, `budget.remaining()` returns `NaN`

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `RunCtxHostInternal` interface (missing field) + `buildInitScript` `__pi_build_ctx` budget branch
**Discovered:** iteration-2

### Description

The init script's `__pi_build_ctx` reads `__runCtxHost.tokenBudget` to populate `budget.total` and `budget.remaining()`. However `tokenBudget` is not declared on the `RunCtxHostInternal` TypeScript interface defined in `sandbox.ts`. TypeScript does not type-check the string contents of the init script, so this goes undetected. At runtime the property access returns `undefined`. Consequently `ctx.budget.total === undefined` (not `null | number`), and `budget.remaining()` computes `Math.max(0, undefined - spent)` which is `NaN`. Workflow scripts gating on `ctx.budget.remaining() < threshold` see `NaN` comparisons that always evaluate `false`, silently masking budget exhaustion.

### Suggested Fix

Add `tokenBudget: number | null` to `RunCtxHostInternal`. Verify the host-side bridge object that gets assigned to `opts.runCtxHost` populates this field; add a TypeScript compile-time check so future additions to the interface flag missing implementations.

---

## BUG-063 — Context-realm `URLSearchParams` wrapper missing `[Symbol.iterator]` — `for...of` and spread throw `TypeError`

**Area:** runtime / sandbox
**Severity:** medium
**Location:** src/runtime/sandbox.ts — `buildInitScript`, URLSearchParams constructor section
**Discovered:** iteration-2

### Description

The `URLSearchParams` constructor installed by the init script defines `get`, `getAll`, `has`, `set`, `append`, `delete`, `toString`, `entries`, `keys`, `values`, `forEach`, and `size`, but does NOT define `[Symbol.iterator]`. The ECMAScript spec requires `URLSearchParams` to be iterable via `[Symbol.iterator]` (aliased to `entries`). After `Object.freeze(this)` is called, `[Symbol.iterator]` can no longer be added. Any script using `for (const [k, v] of params)`, `[...params]`, or `Array.from(params)` throws `TypeError: params is not iterable`.

### Suggested Fix

Before `Object.freeze(this)` in the URLSearchParams constructor, add: `this[Symbol.iterator] = this.entries;` (or via `Object.defineProperty` with `enumerable: false`).

---

## BUG-064 — `Sandbox` constructor leaks `timerBridge` resources when init script throws

**Area:** runtime / sandbox
**Severity:** low
**Location:** src/runtime/sandbox.ts — `Sandbox` constructor, between `installTimerBridge` call and `vm.runInContext(buildInitScript(nonce), ...)` try/catch
**Discovered:** iteration-2

### Description

`installTimerBridge(context, { signal, ... })` is called before `vm.runInContext(buildInitScript(nonce), ...)`. The bridge registers a listener on `opts.signal` (and allocates other internal resources). If `buildInitScript` throws — caught and re-thrown as `SandboxViolationError('init-script-failed')` — the constructor exits without calling `this.timerBridge.dispose()`. The caller receives the violation error and has no handle on the partially-constructed `Sandbox`, so `dispose()` can never be called. The signal listener persists until the `AbortController` itself is GC'd.

### Suggested Fix

In the init-script catch block, call `this.timerBridge.dispose()` before re-throwing the `SandboxViolationError`.

---

## BUG-065 — Context-realm signal object not frozen — user code can replace `addEventListener`/`removeEventListener` on `ctx.signal`

**Area:** runtime / sandbox
**Severity:** low
**Location:** src/runtime/sandbox.ts — `buildInitScript`, `__pi_make_signal` return value
**Discovered:** iteration-2

### Description

`__pi_make_signal()` returns `{ signal, abort }` where `signal` is a plain unfrozen object. `__base.signal = signal` is assigned, then `ctx = Object.freeze(__base)`. `Object.freeze` only freezes the top-level `ctx` (making `ctx.signal` a non-writable reference), NOT the signal object itself. User code can do `ctx.signal.addEventListener = null` or `ctx.signal.removeEventListener = () => {}`. If any host-internal path (e.g. `ctx.phase` abort propagation) registers on the user-facing signal, replacement silently disables it. The scenario is limited by the trust model but violates the invariant that ctx surface is immutable.

### Suggested Fix

Add `Object.freeze(signal)` immediately before `return { signal: signal, abort: abort };` inside `__pi_make_signal`. The `abort` closure is host-captured separately and does not need freezing.

---

## BUG-066 — resumeRun: `approved` and `pending` states excluded from RESUMABLE_STATES — handling branches are dead code

**Area:** runtime / resumeRun
**Severity:** high
**Location:** src/runtime/resumeRun.ts — `resumeRun()` lines checking `RESUMABLE_STATES.has(finalState)` (~line 185); unreachable `else if (finalState === 'approved')` / `else if (finalState === 'pending')` branches below; src/runtime/ledger.ts — `RESUMABLE_STATES` definition (line ~72)
**Discovered:** iteration-2

### Description

In `resumeRun.ts`, the resumability check uses `RESUMABLE_STATES.has(finalState)` which only contains `"paused"` and `"running"`. The inline comment explicitly lists `approved` and `pending` as resumable: `// - paused, running, approved, pending: resumable.` but neither state is in `RESUMABLE_STATES`, so `resumable` stays `false` and `ResumeNotAllowedError` is thrown before execution can reach the `else if (finalState === 'approved')` and `else if (finalState === 'pending')` transition-append branches that follow. Those two branches (which handle the `pending→approved→running` and `approved→running` ledger writes) are completely unreachable dead code. A run that was approved or still pending at crash time cannot be resumed despite the design intent.

### Suggested Fix

Add `"approved"` and `"pending"` to `RESUMABLE_STATES` in `ledger.ts`: `new Set<RunState>(['paused', 'running', 'approved', 'pending'])`. The downstream handling branches in `resumeRun` already produce the correct transitions for those states once they become reachable.

---

## BUG-067 — dispatcher: stderrTee drain uses `writableEnded` instead of `writableFinished` — resolves before data is flushed

**Area:** runtime / dispatcher
**Severity:** medium
**Location:** src/runtime/dispatcher.ts — stderrTee drain `await new Promise<void>` block near bottom of `dispatchAgent`
**Discovered:** iteration-2

### Description

In `dispatchAgent`, the stderrTee drain guard reads `if (stderrTee.writableEnded) { resolve(); return; }`. `writableEnded` becomes `true` immediately when `end()` is called (which happens via the `child.stderr` `'end'` event handler right after the child exits). At that point `finish` has not yet fired and buffered data may not have been flushed. The Promise resolves immediately, and the subsequent `fs.readFile(stderrPath)` (inside the `!agg.agentEnd` branch) reads the file before the OS write-back completes, yielding an incomplete `stderrTail` that is then embedded in the `MalformedAgentOutputError`. The correct property to check is `writableFinished`, which is only `true` after the `'finish'` event fires.

### Suggested Fix

Replace `if (stderrTee.writableEnded)` with `if (stderrTee.writableFinished)` in the early-exit guard of the stderrTee drain promise. This ensures the early-resolution path only fires when all buffered data has actually been written.

---

## BUG-068 — dispatcher: inner SIGKILL timer `killHandle` is never cancelled — can fire against a recycled PID

**Area:** runtime / dispatcher
**Severity:** medium
**Location:** src/runtime/dispatcher.ts — `const timeoutHandle = setTimeout(...)` block; inner `const killHandle = setTimeout(...)` inside that callback
**Discovered:** iteration-2

### Description

Inside the `timeoutMs` callback in `dispatchAgent`, a secondary `setTimeout` (`killHandle`) is created to send SIGKILL 5 s after SIGTERM. `killHandle` is stored in a block-scoped `const` inside the outer timeout callback and is only `unref()`'d, never stored in a variable accessible from the cleanup path. If the child exits cleanly within the 5-second grace window (normal case after SIGTERM), `clearTimeout(timeoutHandle)` in the main path is a no-op (the timeout already fired), and `killHandle` remains live. When it fires it calls `child.kill('SIGKILL')` on a process handle whose PID may have been recycled by the OS, risking SIGKILL delivery to an unrelated process.

### Suggested Fix

Hoist `killHandle` to a variable in the outer `dispatchAgent` scope (e.g. `let killTimeoutHandle: ReturnType<typeof setTimeout> | null = null`). Inside the SIGTERM timeout callback, assign `killTimeoutHandle = setTimeout(...)`. In the main-path cleanup (`clearTimeout(timeoutHandle)` section) and all error-path cleanups, also call `if (killTimeoutHandle) clearTimeout(killTimeoutHandle)`.

---

## BUG-069 — runLock: TOCTOU window between O_EXCL create and writeSync allows concurrent process to steal the lock

**Area:** runtime / runLock
**Severity:** low
**Location:** src/runtime/runLock.ts — `acquireResumeLock()`, `tryCreate()` function and the subsequent `writeSync(fd, JSON.stringify(lockBody))` call
**Discovered:** iteration-2

### Description

In `acquireResumeLock`, `openSync(lockPath, 'wx')` creates the lockfile with O_EXCL atomicity, returning an fd to the winner. However, the lockfile body (`{ pid, bootId, ... }`) is written in a separate `writeSync` call. In the window between `openSync` success and `writeSync`, the file exists but is empty. A competing process that sees `EEXIST`, reads the empty file (`raw.trim().length > 0` is false), treats it as stale (body defaults to `holderPid=0`), unlinks it, and then re-runs `tryCreate()` will win the lock — leaving two processes both believing they hold it. The window is narrow (two adjacent synchronous syscalls) but real on preemptive multi-process systems.

### Suggested Fix

Write the lock body to a temp file first, then `renameSync` into the lock path after a successful O_EXCL create — but that loses O_EXCL atomicity. A simpler fix: treat an empty lock file (body length 0) as still-being-written and spin-wait/retry rather than treating it as stale. Or embed the pid in the filename itself so the existence of the file with the correct name is sufficient.

---

## BUG-070 — resumeRun: resume lock released prematurely if post-IIFE synchronous code throws while run promise is already executing

**Area:** runtime / resumeRun
**Severity:** low
**Location:** src/runtime/resumeRun.ts — `const promise = (async () => { ... })()` assignment and the `opts.activeRuns?.register(...)` call after it; outer `catch` block that calls `lock.release()`
**Discovered:** iteration-2

### Description

In `resumeRun`, `acquireResumeLock` is called before the outer `try` block. The `try/catch` releases the lock if anything throws before `return run`. The run's IIFE `(async () => { ... })()` is assigned to `const promise` inside the `try` block and begins executing synchronously up to its first `await sandbox.runScript(...)`. After that point, control returns to the outer `resumeRun` body which executes `const run: Run = { ... }` and `opts.activeRuns?.register(runId, run, ...)` synchronously. If `opts.activeRuns.register` (or any other code after `const promise = ...`) throws, the outer `catch` releases the lock — but the IIFE is already suspended mid-execution and will continue running. A sibling pi process can then acquire the lock and start another resume of the same run, causing two concurrent resumes against the same ledger and cache.

### Suggested Fix

Move `opts.activeRuns?.register(...)` into the IIFE's setup (before `sandbox.runScript`) so no synchronous post-IIFE code can throw after the IIFE starts. Alternatively, set a boolean `iifeLaunched = true` after `const promise = ...` and guard the outer `catch` release with `if (!iifeLaunched) lock.release()`.

---

## BUG-071 — activeRuns: `run.ended` applyEntry lacks terminal-state guard — duplicate or out-of-order entries can overwrite summary

**Area:** runtime / activeRuns
**Severity:** low
**Location:** src/runtime/activeRuns.ts — `case 'pi-workflows.run.ended':` inside `applyEntry()`
**Discovered:** iteration-2

### Description

`applyEntry` for `pi-workflows.run.started` and `pi-workflows.run.transitioned` both check `if (prior && isTerminalState(prior.state)) return` before mutating the summary. The `pi-workflows.run.ended` handler has no such guard. If two `run.ended` entries arrive for the same run (e.g. duplicate appendEntry delivery) or a `run.ended` arrives after `terminated.then()` has already set the state, the handler unconditionally overwrites `#summaries` with the new entry's data. A stale duplicate entry with missing optional fields (e.g. no `workflowName`, no `approvalReason`) silently degrades the stored summary.

### Suggested Fix

Add `if (prior && isTerminalState(prior.state)) return;` at the top of the `run.ended` case, consistent with the other two handlers. Since `run.ended` always intends to set terminal state, a once-terminal summary should never be overwritten by a later event.

---

## BUG-072 — _overlayOpen flag never cleared when pi-tui calls dispose() without resolving customApi promise

**Area:** overlay / TUI
**Severity:** high
**Location:** overlay.ts — TuiComponentLike.dispose() (~line 530) and mountOverlay .finally() (~line 230)
**Discovered:** iteration-2

### Description

In makeOverlayComponent, the component's dispose() method calls cleanup() but never calls opts.done(). The _overlayOpen = false reset lives exclusively in the .finally() handler on customApi(...), which only fires when done() is invoked. If pi-tui tears down the overlay by calling dispose() directly (e.g., forced unmount, session end) without resolving the custom promise, _overlayOpen stays true forever. Every subsequent /workflows invocation returns { mode: 'already-open' } and is a no-op.

### Suggested Fix

In dispose(), call opts.done() after cleanup() (guarded by the same idempotency the cleaned flag already provides). Alternatively, clear _overlayOpen directly inside cleanup() rather than relying on the promise chain.

---

## BUG-073 — phaseCursor not clamped when running-phase agent list shrinks during debounced registry update

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — debouncedRender setTimeout callback (~line 252) and navigate-down bound check (~line 365)
**Discovered:** iteration-2

### Description

debouncedRender clamps cursor against sorted.length but never clamps phaseCursor. When agents complete and the running-phase count decreases, phaseCursor can exceed visibleAgents - 1. The renderPhaseView guard (opts.cursor < agentRows.length) silently suppresses the highlight, so no crash occurs, but the stale phaseCursor means the next Enter (open-agent-detail) resolves agentEntry as undefined and silently no-ops — the user expects to open an agent they believe is selected.

### Suggested Fix

In the debouncedRender timeout callback, after clamping cursor, also clamp phaseCursor: if openedRunId is set, fetch the running-phase agent count from phaseRegistry.getRunSnapshot and clamp phaseCursor to Math.max(0, visibleAgents - 1).

---

## BUG-074 — buildRender mutates view and openedAgentId as side effects, leaving openedRunId and phaseCursor stale on fallback

**Area:** overlay / TUI
**Severity:** medium
**Location:** overlay.ts — buildRender, agent-detail fallback (~line 300) and phase-view fallback (~line 322)
**Discovered:** iteration-2

### Description

The two fallback paths inside buildRender (agent vanished → fall back to phase-view; run vanished → fall back to runs-list) directly mutate view and openedAgentId but do not clear openedRunId, phaseCursor, or banner. This means: (1) after the runs-list fallback, openedRunId still points to the vanished run — if a subscribe event fires and run data reappears transiently, the phase-view branch re-activates unexpectedly; (2) buildRender is not idempotent — calling it twice in the same render cycle produces different state each time; (3) phaseCursor is never reset to 0 on the auto-fallback path, unlike the explicit navigate-back action.

### Suggested Fix

Replace inline view mutations with explicit calls to handleAction({ kind: 'navigate-back' }) (or a dedicated private transitionToRunsList helper), which already handles clearing openedRunId, phaseCursor, openedAgentId, and banner atomically.

---

## BUG-075 — F4 GC protection is inverted: protects restart-child candidates instead of source runs

**Area:** overlay / gcDialog
**Severity:** medium
**Location:** gcDialog.ts — loadGcCandidates F4 filter block (~line 85)
**Discovered:** iteration-2

### Description

loadGcCandidates reads each GC candidate's manifest.restartedFrom and skips the candidate if that original runId is in activeRunIds. This protects restart-child runs (the candidate) when their parent is still active — not the dangerous direction. The real risk is the reverse: original run X is a GC candidate, active run Y has Y.restartedFrom = X. The current code never reads Y's manifest, so X is GC'd while Y is still running, destroying the provenance record of an active restart. The comment ('Avoids deleting the source run while a restart-sibling is still running') describes the correct intent but the implementation checks the wrong direction.

### Suggested Fix

For each active runId, read its manifest.json and collect the set of source runIds (manifest.restartedFrom values). Then filter candidates: skip any candidate whose runId appears in that protected-source set. This requires iterating active run manifests rather than candidate manifests.

---

## BUG-076 — GC done screen: y/Enter re-enters apply flow instead of closing

**Area:** overlay / gcDialog
**Severity:** low
**Location:** overlay.ts — handleKey GC dialog intercept (~line 420)
**Discovered:** iteration-2

### Description

In the GC dialog key intercept block of handleKey, the else if (gcDialogState.done !== undefined) branch only fires for keys that are neither y/Enter nor n/Esc. Pressing Enter on the done screen falls into the first branch and dispatches gc-apply. Since gcDialogState.confirming is false on the done state, gc-apply sets confirming: true on a state with candidates: [], rendering a confirm dialog for zero runs. The user must then press n/Esc to dismiss — two extra keystrokes after GC completes.

### Suggested Fix

Reorder the conditions: check gcDialogState.done !== undefined first (before y/Enter/n/Esc branches) and dispatch gc-cancel immediately, so any key closes the done screen as the rendered hint promises.

---

## BUG-077 — isHotkeyEnabled returns false for r on phase-view, contradicting dispatchHotkey

**Area:** overlay / hotkeys
**Severity:** low
**Location:** hotkeys.ts — isHotkeyEnabled case 'r' (~line 160)
**Discovered:** iteration-2

### Description

isHotkeyEnabled has an early return `if (input.view !== 'runs-list') return false` for key r, so it returns false for phase-view regardless of runState. But dispatchHotkey({ key: 'r', view: 'phase-view', runState: 'paused' }) returns { kind: 'resume' } — an enabled, meaningful action. helpForState computes phase-view help directly (not via isHotkeyEnabled) so the rendered help is correct, but any consumer (tests, future guards) using isHotkeyEnabled as a gate would incorrectly suppress the r/resume action on paused phase-view runs.

### Suggested Fix

Replace the blanket `if (input.view !== 'runs-list') return false` with view-specific logic mirroring dispatchHotkey: allow phase-view for paused (resume) and terminal (restart) states; keep runs-list constraint for restart-requested only.

---

## BUG-078 — g key opens GC dialog from phase-view and agent-detail views

**Area:** overlay / hotkeys
**Severity:** low
**Location:** hotkeys.ts — dispatchHotkey g branch (~line 210) and overlay.ts — handleKey view routing (~line 425)
**Discovered:** iteration-2

### Description

dispatchHotkey returns { kind: 'open-gc-dialog' } for key g regardless of view. The no-selection guard has an explicit k !== 'g' carve-out that lets g through in all views. handleKey in overlay.ts routes phase-view and agent-detail keystrokes through dispatchHotkey without a view pre-filter, so pressing g while inspecting an agent's detail or a run's phases unexpectedly opens the GC dialog. isHotkeyEnabled correctly gates g to runs-list but is not consulted in the dispatch path.

### Suggested Fix

In dispatchHotkey, add a view guard before returning open-gc-dialog: if (input.view !== 'runs-list') return { kind: 'noop', reason: 'disabled-for-state' }.

---

## BUG-079 — writeResultFile tmp filename lacks random suffix — same-millisecond concurrent calls share identical tmp path

**Area:** runtime / resultDelivery
**Severity:** medium
**Location:** src/runtime/resultDelivery.ts — writeResultFile, line: `const tmp = join(runDirAbs, \`result.json.tmp-${process.pid}-${Date.now()}\`)`
**Discovered:** iteration-2

### Description

writeResultFile builds its temp path as `result.json.tmp-${process.pid}-${Date.now()}`. Two concurrent calls in the same process within the same millisecond produce identical tmp paths. Both callers race-write to the same file; whichever fs.rename fires second wins while the first caller's data is silently replaced. Every other atomic-write site in the codebase (trustStore.ts addTrustUnlocked, manifestWriter.ts writeParentLivenessFields) appends randomBytes(4).toString('hex') to prevent exactly this. resultDelivery.ts is the only site that omits it. The docstring says 'Idempotent — caller may invoke twice' but conflates sequential idempotency with concurrent safety.

### Suggested Fix

Append a randomBytes(4).toString('hex') suffix identical to the pattern in manifestWriter.ts: `` result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')} ``; import randomBytes from node:crypto.

---

## BUG-080 — writeResultFile uses fs.writeFile without fsync — result.json silently losable on power failure

**Area:** runtime / resultDelivery
**Severity:** medium
**Location:** src/runtime/resultDelivery.ts — writeResultFile function (await fs.writeFile + await fs.rename block)
**Discovered:** iteration-2

### Description

writeResultFile calls `await fs.writeFile(tmp, body, 'utf8')` followed by `await fs.rename(tmp, target)` with no fsync of the tmp file. fs.writeFile drains to the OS page cache but makes no durability guarantee. A power loss between the OS accepting the write and flushing it to stable storage leaves an empty or partial tmp that gets atomically renamed into place — the caller sees no error, yet result.json is corrupt or zero-length. cache.ts is explicitly designed around openSync/writeSync/fsyncSync/closeSync for this reason. result.json is the primary persisted output of a run; losing it silently after the run 'succeeds' breaks `/workflows show` and any downstream consumer of the file. The comment 'result.json write failure is non-fatal' addresses I/O errors, not silent kernel-buffer loss.

### Suggested Fix

After writeFile and before rename, open the file and fsyncSync it (mirror the pattern in cache.ts appendLineSync), or use the open/write/fsync/close idiom directly so the durability guarantee is explicit.

---

## BUG-081 — writeParentLivenessFields uses fs.writeFile without fsync — manifest.json durability gap

**Area:** runtime / manifestWriter
**Severity:** medium
**Location:** src/runtime/manifestWriter.ts — writeParentLivenessFields function (await fs.writeFile + await fs.rename block)
**Discovered:** iteration-2

### Description

writeParentLivenessFields writes manifest.json via `await fs.writeFile(tmpName, json, 'utf8')` then `await fs.rename(tmpName, target)` with no fsync. Identical durability gap to BUG-080. A power loss after the OS accepts the write but before flush leaves a zero-length or partial manifest.json. The code path deliberately creates the run directory and writes the partial manifest as the very first durable record of a run; if that record is silently lost, the orphan run directory has no manifest and recovery logic may misclassify or discard the run. cache.ts fsyncs every append; the manifest writer does not.

### Suggested Fix

Add an fsync step after writeFile and before rename, matching the pattern established in cache.ts. Because the tmp file already includes randomBytes for collision safety, only the fsync step is missing.

---

## BUG-082 — cancelReasonText returns 'approval denied' when decision.approved is true — incorrect audit text

**Area:** runtime / resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — cancelReasonText function, line: `if (decision.approved) return 'approval denied'`
**Discovered:** iteration-2

### Description

cancelReasonText contains `if (decision.approved) return 'approval denied'`. If a RunResultFile is somehow written with outcome='cancelled-pre-run' AND approval.approved=true (e.g., a bug upstream sets the wrong outcome, or the fields are assembled inconsistently), the card footer and result.json both display 'approval denied' — which is the opposite of the truth and will mislead any audit. The correct response for an impossible-but-reachable branch is either a defensive assertion or a clearly labeled fallback string. The function should never silently mis-state the approval decision.

### Suggested Fix

Replace the approved=true guard with `if (decision.approved) return '(unexpected: approved=true on cancelled run)'` or throw an assertion error so the upstream inconsistency is surfaced rather than hidden.

---

## BUG-083 — loadTrust sha256 dedup keeps personal entry when project has same sha256 — contradicts 'project wins' contract

**Area:** runtime / trustStore
**Severity:** low
**Location:** src/runtime/trustStore.ts — loadTrust function, inner loop over Object.entries(project)
**Discovered:** iteration-2

### Description

loadTrust seeds `merged` with personal rows first, then iterates project rows and skips any whose sha256 is already in `seenShas`. When both personal and project contain a row for the same (absPath, sha256) but with different names, the personal row is kept and the project row is dropped. The function comment and inline comment both state 'Project entries win … project rows taking precedence at lookup time', but the implementation preserves the personal name. For the boolean isTrustedIn check this is benign (sha256 match returns true regardless). For any consumer that iterates rows to display or audit the trust entry's name (e.g. overlay UI, `--list-trusted` introspection), the personal name is shown instead of the project name, violating the PRD §7 precedence rule.

### Suggested Fix

Iterate project rows first (seeding `merged` with project entries), then iterate personal rows and skip sha256s already present from project, so project rows win on conflict consistently.

---

## BUG-084 — captureParentLiveness calls process.hrtime.bigint with wrong this context

**Area:** runtime / manifestWriter
**Severity:** low
**Location:** src/runtime/manifestWriter.ts — captureParentLiveness function, line: `const ht = (argv.hrtimeBigint ?? process.hrtime.bigint).call(process.hrtime)`
**Discovered:** iteration-2

### Description

captureParentLiveness calls `(argv.hrtimeBigint ?? process.hrtime.bigint).call(process.hrtime)`, passing `process.hrtime` as the `this` receiver. The correct receiver is `process` (i.e., `process.hrtime.bigint()` or `.call(process)`). `process.hrtime` is the outer namespace object, not the object that owns `bigint`. This works in current Node.js because hrtime.bigint ignores its `this`, but it is semantically incorrect and fragile against future Node.js internals changes or stricter receiver checks. Additionally, a test-supplied `argv.hrtimeBigint` arrow function would silently receive the wrong `this`, making the seam harder to reason about.

### Suggested Fix

Change to `const ht = argv.hrtimeBigint ? argv.hrtimeBigint() : process.hrtime.bigint()` — call the override directly, call the default with no `.call` override.

---

## BUG-085 — deliverRunResult pi API calls not awaited inside try/catch — async rejections escape unhandled

**Area:** runtime / resultDelivery
**Severity:** low
**Location:** src/runtime/resultDelivery.ts — deliverRunResult function, all three pi.sendMessage / pi.appendEntry / pi.sendUserMessage call sites
**Discovered:** iteration-2

### Description

sendMessage, appendEntry, and sendUserMessage are each called without await inside bare try/catch blocks. If any of these methods return a rejected Promise (e.g., the pi host shuts down mid-delivery, the IPC channel is closed), the rejection is unhandled — the try/catch catches only synchronous throws, not async rejections. In Node.js ≥15 an unhandled rejection terminates the process by default, which would kill the pi workflow process after delivery instead of swallowing the error as intended. The comment 'swallow — best-effort surface' documents the intent but the implementation does not achieve it for async APIs.

### Suggested Fix

Either await each call inside its try/catch block (`try { await opts.pi.sendMessage(...) } catch { }`) or explicitly void the returned Promise with an attached .catch noop (`void Promise.resolve(opts.pi.sendMessage(...)).catch(() => {})`).

---

## BUG-086 — ctx.pipeline undocumented in runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md (missing section); src/runtime/writeWorkflowTool.ts lines 183, 232-238
**Discovered:** iteration-2

### Description

ctx.pipeline(items, ...stages) is fully implemented in stdlib.ts, typed in public.d.ts, and featured prominently in writeWorkflowTool.ts promptSnippet and promptGuidelines — but is completely absent from runtime-api.md. Authors following the API reference cannot discover this method exists.

### Suggested Fix

Add a `ctx.pipeline` section to runtime-api.md documenting the signature `pipeline(items, ...stages)`, stage callback signature `(prev, original, index)`, and a usage example mirroring the promptSnippet.

---

## BUG-087 — ctx.budget undocumented in runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md (missing section); src/runtime/writeWorkflowTool.ts line 246; src/types/public.d.ts lines 186-196
**Discovered:** iteration-2

### Description

ctx.budget (with .total, .spent(), .remaining()) is typed in public.d.ts, wired in sandbox.ts, and used in writeWorkflowTool.ts promptSnippet — but is completely absent from runtime-api.md. Authors have no way to discover or correctly use the token budget tracker from the docs alone.

### Suggested Fix

Add a `ctx.budget` section to runtime-api.md documenting the three members: `total: number | null`, `spent(): number`, `remaining(): number`, with a short example.

---

## BUG-088 — ctx.phase third argument (failMode) missing from runtime-api.md

**Area:** docs
**Severity:** high
**Location:** docs/runtime-api.md ctx.phase section; src/runtime/runCtx.ts lines 188-234; src/types/public.d.ts line 138
**Discovered:** iteration-2

### Description

ctx.phase accepts an optional third options argument `{ failMode: 'throw' | 'null' }` that is implemented in runCtx.ts, typed in public.d.ts, referenced in writeWorkflowTool.ts promptGuidelines ('Pass `{ failMode: "null" }` as third arg'), and even generates a runtime warning when omitted on large phases — but runtime-api.md shows only a two-argument signature with no mention of the third arg.

### Suggested Fix

Update the ctx.phase signature in runtime-api.md to `phase(name, agents, opts?)`, document PhaseOpts with `failMode: 'throw' | 'null'` (default 'throw'), explain partial-failure semantics, and add a resilient-phase example.

---

## BUG-089 — schema option missing from AgentOpts in runtime-api.md

**Area:** docs
**Severity:** medium
**Location:** docs/runtime-api.md AgentOpts section; src/types/public.d.ts line 50
**Discovered:** iteration-2

### Description

AgentOpts.schema is typed in public.d.ts (line 50) and AgentResult.output mentions 'set when opts.schema was provided to ctx.agent()' — but the AgentOpts interface in runtime-api.md omits schema entirely. Authors reading only the docs will not know they can get structured/parsed output from agents.

### Suggested Fix

Add `schema?: Record<string, unknown>` to the AgentOpts table in runtime-api.md with a description explaining that it causes the agent to return parsed JSON in result.output. Add a short example showing schema usage paired with result.output access.

---

## BUG-090 — Canonical examples missing required export const meta

**Area:** examples
**Severity:** high
**Location:** examples/codebase-audit/codebase-audit.js (no meta export); examples/hello/hello.js (no meta export)
**Discovered:** iteration-2

### Description

Both examples/codebase-audit/codebase-audit.js and examples/hello/hello.js lack `export const meta = { name, description, version }`. writeWorkflowTool.ts validates this as mandatory (hasMetaFirst check), and the SKILL.md documents it as a requirement. If a user submits either example via write_workflow it will fail validation with 'Script must start with export const meta'.

### Suggested Fix

Add `export const meta = { name: 'codebase-audit', description: '...', version: '1.0.0' }` as the first meaningful statement in codebase-audit.js, and similarly for hello.js with name 'hello'.

---

## BUG-091 — codebase-audit.js inlines large findings JSON into voter prompts — violates documented anti-pattern

**Area:** examples
**Severity:** medium
**Location:** examples/codebase-audit/codebase-audit.js lines for the vote phase; skills/pi-workflows/SKILL.md anti-pattern section
**Discovered:** iteration-2

### Description

codebase-audit.js serializes allFindings to `findingsJson = JSON.stringify(allFindings, null, 2)` then interpolates it inline into 3 parallel voter agent prompts. SKILL.md explicitly warns: 'Never inline file contents in prompts — causes context crashes on large files'. On a large repo this is the most token-heavy phase (3 agents × all findings). The canonical reference implementation teaches the exact anti-pattern it documents against.

### Suggested Fix

Cache allFindings to disk via ctx.cache.set and tell voter agents to read from the cache key or a temp file, or truncate findings passed inline to a safe size (e.g. top 30 by severity) with a count summary.

---

## BUG-092 — authoring.md section 5 cites wrong example path

**Area:** docs
**Severity:** low
**Location:** docs/authoring.md section 5 (Walking through /codebase-audit), last line
**Discovered:** iteration-2

### Description

authoring.md section 5 says 'See `examples/codebase-audit.js` for the full source' but the actual file lives at `examples/codebase-audit/codebase-audit.js`. The flat path does not exist.

### Suggested Fix

Change the path reference to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-093 — ctx.log level silently dropped when called with opts-object form

**Area:** runtime / runCtx
**Severity:** medium
**Location:** src/runtime/runCtx.ts logFn lines 655-659; docs/runtime-api.md ctx.log section; examples/codebase-audit/codebase-audit.js warn log call
**Discovered:** iteration-2

### Description

The public API signature (runtime-api.md and public.d.ts) is `log(message: string, opts?: { level?: 'info'|'warn'|'error' })`. But the bridge logFn checks `levelArg === 'warn'` not `levelArg?.level === 'warn'`. Calling `ctx.log(msg, { level: 'warn' })` passes `{ level: 'warn' }` as levelArg; the equality check fails and the level silently defaults to 'info'. codebase-audit.js uses exactly this form, so all its warn-level logs are silently emitted as info. The bridge implementation and the public type are mismatched.

### Suggested Fix

Fix logFn to: `const level = (typeof levelArg === 'string' ? levelArg : (levelArg as any)?.level) ?? 'info'` to handle both the opts-object form and a direct string. Or update the public type to `log(message: string, level?: 'info'|'warn'|'error')` and update docs + examples to match.

---

## BUG-094 — writeWorkflowTool promptGuidelines tells LLM 'workflow is already running' when it may not be

**Area:** runtime / writeWorkflowTool
**Severity:** low
**Location:** src/runtime/writeWorkflowTool.ts promptGuidelines last entry (around line 192); result card text in execute() function
**Discovered:** iteration-2

### Description

The last entry in writeWorkflowTool.ts promptGuidelines says 'tell the user the workflow was saved and is already running — direct them to /workflows to monitor progress.' But the tool's result card reads 'It's now registered. Open /workflows to launch and monitor it.' when startRun is not wired. The LLM is instructed to assert running status that the tool result itself contradicts, leading to misleading user-facing summaries.

### Suggested Fix

Change the promptGuideline to 'tell the user the workflow was saved and registered as a slash command, then invite them to open /workflows to launch and monitor it.' Remove the 'already running' assertion.

---

## BUG-W03 — Workflow: fix agents timeout waiting for API capacity, not doing work

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

## BUG-W04 — `agent_start` ledger event logged before semaphore acquire

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

## BUG-W05 — No per-agent `timeoutMs` guidance in docs or promptSnippet

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

## BUG-095 — ctx.log level option silently ignored — all logs emit at info

**Area:** Runtime / Sandbox
**Severity:** High
**Location:** `src/runtime/runCtx.ts` logFn (levelArg check) + `src/runtime/sandbox.ts` wrapHostSync wiring
**Discovered:** iteration-3

### Description

wrapHostSync passes args through verbatim via Reflect.apply. When an author calls ctx.log(msg, { level: 'warn' }), the host's logFn receives the full opts object { level: 'warn' } as its levelArg parameter. The guard `levelArg === 'warn' || levelArg === 'error'` always fails (object !== string), so every ctx.log call defaults to level 'info' regardless of what the author passed. Warn and error severities are silently dropped.

### Suggested Fix

Change logFn to accept opts: { level?: string } as second argument and extract level via `(opts as Record<string,unknown>)?.level`, or add a level-extraction shim in the sandbox's ctx.log wrapper before calling the host.

---

## BUG-096 — ctx.retry maxAttempts in runtime-api.md vs attempts in implementation — silent ignore

**Area:** Runtime / stdlib
**Severity:** High
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE retry() + `docs/runtime-api.md` §ctx.retry
**Discovered:** iteration-3

### Description

runtime-api.md documents the option as `maxAttempts` (example: `{ maxAttempts: 5, backoffMs: 1000 }`), but the implementation reads `opts.attempts`. Authors following the docs who write `{ maxAttempts: 5 }` will silently get the default 3 attempts. The option is consumed without error but has no effect.

### Suggested Fix

Align the docs: rename `maxAttempts` to `attempts` in runtime-api.md and its code example, or make the implementation accept both (read `opts.maxAttempts ?? opts.attempts` with a deprecation note).

---

## BUG-097 — ctx.consensus result shape mismatch — docs promise scores field, impl returns responses

**Area:** Runtime / stdlib
**Severity:** High
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE consensus() + `docs/runtime-api.md` §ctx.consensus
**Discovered:** iteration-3

### Description

runtime-api.md documents ConsensusResult as having `scores: ReadonlyArray<{ agentId: string; meanSimilarity: number }>`. The implementation returns `{ agreed, majorityText, responses: string[] }` — no `scores` field. Any author who writes `result.scores` gets `undefined`. The agentId per-score shape requires tracking which agent produced each result, but the implementation only tracks array indices. public.d.ts correctly uses `responses`, but the runtime-api.md is the primary author-facing reference.

### Suggested Fix

Update runtime-api.md to show the actual ConsensusResult shape (responses: string[]) and remove the scores field, or implement scores by carrying agentId through the results map.

---

## BUG-098 — extractJson throws on schema parse failure — creates persistent failure loop

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` extractJson, runOneAgent cache-hit path (line ~501) and cache-miss path (line ~588)
**Discovered:** iteration-3

### Description

AgentResult.output is typed as `output?: unknown` with documented semantics 'Undefined otherwise'. extractJson throws (`no JSON found in agent output` or a SyntaxError from JSON.parse) instead of returning undefined when the agent output doesn't contain valid JSON. In the cache-miss path, if extractJson throws AFTER the result is successfully cached, the agent_error is logged, the phase fails — but on the next run the cache hit path calls extractJson again on the same text and fails again. The workflow is permanently stuck: the agent is never re-dispatched (cache hit) but always errors.

### Suggested Fix

Wrap extractJson calls in try-catch and return undefined on failure (honoring the 'undefined otherwise' contract). Consider logging a warn-level ledger entry so the author knows the schema didn't parse.

---

## BUG-099 — extractJson fence regex matches first fence not last — wrong JSON when agent includes examples

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` extractJson
**Discovered:** iteration-3

### Description

extractJson tries a fence regex first: `` /```json\s*([\s\S]*?)```/.exec(text) `` which returns the FIRST match. When an agent includes an example JSON block early in its response followed by the actual output block at the end (as instructed by buildSchemaInstruction), the first (example) block is parsed instead of the last (output). The lastIndexOf fallback correctly uses the last occurrence but the fence path is inconsistent.

### Suggested Fix

Replace `.exec(text)` with a global match (`` /```json\s*([\s\S]*?)```/g ``) and take the last capture group, consistent with the lastIndexOf fallback strategy.

---

## BUG-100 — budgetSpent charges cached token usage — cache replays can exhaust the token budget

**Area:** Runtime / runCtx
**Severity:** Medium
**Location:** `src/runtime/runCtx.ts` runOneAgent cache-hit path (~line 482)
**Discovered:** iteration-3

### Description

In the cache-hit path of runOneAgent, `budgetSpent += result.usage.totalTokens` is executed using the token counts stored from the original dispatch. No real tokens are consumed on a cache hit, but the budget counter is decremented by the original cost. A workflow running entirely from cache can exhaust its token budget and start throwing 'token budget exhausted' errors on subsequent non-cached agents, even though zero real tokens were spent in the current run.

### Suggested Fix

Skip `budgetSpent` accumulation on cache hits, or only count cached tokens against a separate 'replay' counter that does not affect the enforcement gate.

---

## BUG-101 — timeoutMs included in opts hash for cache key — innocent timeout changes invalidate valid cache entries

**Area:** Runtime / cache
**Severity:** Medium
**Location:** `src/util/hash.ts` cacheKey + `src/runtime/runCtx.ts` runOneAgent
**Discovered:** iteration-3

### Description

cacheKey hashes the full opts object (canonicalJson(opts)), which includes timeoutMs. Changing only the per-agent timeout (e.g. from 30000 to 60000) produces a different hash and causes a cache miss, dispatching a fresh agent even though the prior result is completely reusable. timeoutMs is an execution constraint, not a content determinant — only model, thinking, and cacheKeyExtra should influence the cache key.

### Suggested Fix

Strip execution-constraint fields (timeoutMs, at minimum) from the opts object before computing optsHash, or maintain an explicit allowlist of cache-key-relevant opts fields (model, thinking, cacheKeyExtra).

---

## BUG-102 — ctx.consensus similarity option in runtime-api.md silently ignored — single threshold does double duty

**Area:** Runtime / stdlib / docs
**Severity:** Medium
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE consensus() + `docs/runtime-api.md` §ctx.consensus
**Discovered:** iteration-3

### Description

runtime-api.md documents ConsensusOpts as having two independent parameters: `threshold` (fraction of pairs that must agree) and `similarity` (Jaccard floor per pair). The implementation uses a single `threshold` for both purposes: pair similarity is compared against `threshold` AND the ratio is compared against `threshold`. Passing `{ threshold: 0.8, similarity: 0.5 }` silently ignores `similarity`. The default threshold is also inconsistent: public.d.ts comment says 0.6, runtime-api.md says 0.5.

### Suggested Fix

Either document that a single threshold controls both dimensions, or implement separate `threshold`/`similarity` params and update the type in public.d.ts.

---

## BUG-103 — schema extractJson failure logged as agent_error in ledger — misleading error attribution

**Area:** Runtime / runCtx / ledger
**Severity:** Low
**Location:** `src/runtime/runCtx.ts` runOneAgent catch block (~line 600) + extractJson invocation (~line 588)
**Discovered:** iteration-3

### Description

When extractJson throws in the cache-miss path of runOneAgent (inside the try block that also covers the dispatch), the catch block logs an agent_error ledger entry. The agent itself ran successfully; the error is in post-processing (JSON extraction). This pollutes error tracking and monitoring — the ledger shows agent failure when the actual failure was a schema mismatch in the host runtime. It also causes the result to be cached (setAgentResult runs before extractJson) while the ledger records an error for the same agent.

### Suggested Fix

Move extractJson call to after the try/catch/finally block (or to a separate try-catch that emits a schema_parse_error ledger type), decoupled from agent dispatch errors.

---

## BUG-104 — retry backoffMs default mismatch between docs and implementation

**Area:** Runtime / stdlib / docs
**Severity:** Low
**Location:** `src/runtime/stdlib.ts` STDLIB_INIT_SOURCE retry() + `docs/runtime-api.md` §ctx.retry
**Discovered:** iteration-3

### Description

runtime-api.md documents the backoffMs default as 500ms (`// initial backoff in ms (default 500)`). The implementation defaults to 100ms. public.d.ts comment says 100 (matches implementation). Authors relying on the API reference docs will expect 500ms delays between retries and be surprised by faster retries than documented.

### Suggested Fix

Update runtime-api.md to say default 100ms, or change the implementation default to 500ms for consistency with the documented value.

---

## BUG-105 — ctx.phase failMode option entirely absent from runtime-api.md

**Area:** Docs
**Severity:** Low
**Location:** `docs/runtime-api.md` §ctx.phase
**Discovered:** iteration-3

### Description

runtime-api.md shows ctx.phase with only 2 parameters (`phase(name, handles)`) and a return type of `Promise<ReadonlyArray<AgentResult>>`. The PhaseOpts third parameter and failMode:'null' behavior (returning null entries for failed agents instead of throwing AggregateError) are not documented at all. Authors reading the reference docs cannot discover this feature, and the return type mismatch (docs omit the `| null`) could cause type confusion when failMode:'null' is eventually found via public.d.ts.

### Suggested Fix

Add PhaseOpts documentation to the ctx.phase section, document failMode:'throw' vs 'null' semantics, and update the return type to show ReadonlyArray<AgentResult | null>.

---

## BUG-106 — Reflect namespace not frozen — Reflect.apply poisonable at runtime

**Area:** Sandbox / Security
**Severity:** High
**Location:** `sandbox.ts` buildInitScript() — prototype freeze block at end of init script; also wrapHostMethod and wrapHostAsync definitions in the same init script body
**Discovered:** iteration-3

### Description

The init script freezes Object.prototype, Function.prototype, and other intrinsics per PRD §8.3.2, but never calls Object.freeze(Reflect). Every ctx bridge method (ctx.phase, ctx.cache.*, ctx.agent, ctx.finishCallback) delegates through wrapHostMethod or wrapHostAsync, both of which call Reflect.apply(host, this, args) at invocation time — not at wrap time. A script that runs `Reflect.apply = () => ({ok:true,value:null})` before calling any ctx method will silently no-op every bridge call, faking successful returns without executing any host logic. A logging variant can also exfiltrate the host-realm function references passed as the first argument.

### Suggested Fix

Add `Object.freeze(Reflect);` to the prototype-freeze block in buildInitScript(), immediately after `Object.freeze(Math);`. Also consider capturing a local alias `const __reflect_apply = Reflect.apply;` at the top of the init script and replacing all wrapHostMethod/wrapHostAsync callsites to use `__reflect_apply` directly, so even a post-freeze mutation is pre-empted.

---

## BUG-107 — fireCtxAbort abort listener never removed from hostSignal on successful completion

**Area:** Sandbox / Memory
**Severity:** Medium
**Location:** `sandbox.ts` Sandbox.runScript() — the hostSignal.addEventListener call around line 570, and the Sandbox.dispose() method
**Discovered:** iteration-3

### Description

In runScript(), the host-to-context signal bridge is wired via `hostSignal.addEventListener('abort', fireCtxAbort, { once: true })`. On the SUCCESS path, raceWithAbort() cleans up its own inner `onAbort` listener, but the outer `fireCtxAbort` registered directly on hostSignal is never removed. The { once: true } flag only auto-removes it when the signal fires; if the script completes normally and the signal never fires, the listener remains registered indefinitely. The closure captures `signalAbortThunk` (a Context-realm function), which in turn holds a reference to the Context's internal abort listeners array — preventing GC of the vm.Context even after dispose() is called. dispose() cannot fix this because fireCtxAbort is a per-call local, not a class field.

### Suggested Fix

Track the fireCtxAbort listener as a class field (e.g. `private _abortListener: (() => void) | null = null`). After raceWithAbort resolves (in a finally block), call `hostSignal.removeEventListener('abort', this._abortListener)` and null it out. Alternatively, restructure so a single per-Sandbox abort listener is registered in the constructor and cleaned in dispose().

---

## BUG-108 — AsyncFunction.prototype and GeneratorFunction.prototype not frozen

**Area:** Sandbox / Security
**Severity:** Medium
**Location:** `sandbox.ts` buildInitScript() — prototype freeze block at end of init script
**Discovered:** iteration-3

### Description

The init script's prototype-freeze block covers Function.prototype, Promise.prototype, and the collection types, but does NOT freeze AsyncFunction.prototype or GeneratorFunction.prototype (or their async-generator counterpart). These are reachable from inside the sandbox: `Object.getPrototypeOf(async function(){})` returns the AsyncFunction constructor, and `.prototype` gives its prototype. User code can add a `then` property to `AsyncFunction.prototype`, making every async function object in the sandbox thenable. stdlib helpers (vote, parallel, retry, sleep) are async functions — adding a poisoned `then` trap on their prototype can cause callers that do `await ctx.vote` (without invoking it) to get unexpected resolution. More broadly, arbitrary property injection on the AsyncFunction prototype leaks into all closure-captured stdlib helper instances.

### Suggested Fix

Add the following lines to the freeze block: `Object.freeze(Object.getPrototypeOf(async function(){}));` and `Object.freeze(Object.getPrototypeOf(function*(){}));` and `Object.freeze(Object.getPrototypeOf(async function*(){}));` — capturing each constructor's prototype before user code can touch it.

---

## BUG-109 — __pi_clone_into_ctx silently drops undefined values via JSON round-trip

**Area:** Sandbox
**Severity:** Medium
**Location:** `sandbox.ts` buildInitScript() — __pi_clone_into_ctx function definition in the init script string
**Discovered:** iteration-3

### Description

The __pi_clone_into_ctx function (defined in buildInitScript) uses JSON.parse(JSON.stringify(value)) for all object/array values. This has two silent data-loss behaviors: (1) object keys whose values are undefined are omitted entirely from the clone — e.g. {a: undefined, b: 1} becomes {b: 1}; (2) undefined elements in arrays become null — e.g. [undefined, 1] becomes [null, 1]. Any host bridge method that returns an ok:true envelope with a value containing undefined fields (for example a cache.get returning a sparse record, or phase results with optional undefined properties) will silently deliver a structurally different object to the script. Additionally, if a host method returns a value containing a circular reference, JSON.stringify throws a TypeError inside the Context, which surfaces as an unexpected ctx bridge failure rather than a clear 'circular value' error.

### Suggested Fix

Replace the JSON round-trip with a recursive structured-clone that preserves undefined (using a manual walk or a Context-realm structuredClone if available). At minimum, document the undefined-stripping as a known gap and add an explicit circular-reference guard with a descriptive error message.

---

## BUG-110 — Shape C second export-async-function regex replace is dead code

**Area:** Sandbox
**Severity:** Low
**Location:** `sandbox.ts` detectShape() — Shape C branch, the two-step .replace() chain
**Discovered:** iteration-3

### Description

In detectShape(), the Shape C transform applies two sequential .replace() calls on the source string. The first regex — `/^(\s*)export\s+(const|let|var|async\s+function|function)\s/gm` — already handles `export async function` via the `async\s+function` alternation in group 2, correctly producing `async function` in the replacement. The second regex — `/^(\s*)export\s+(async)\s+(function)\s/gm` — targets `export async function` in the already-transformed string, but those patterns were already consumed by the first pass. The second replace is always a no-op. The comment 'Ensure async function is preserved correctly after stripping export async function' is therefore misleading.

### Suggested Fix

Remove the second .replace() call and its comment. Optionally add a test asserting that `export async function main(ctx)` is correctly transformed to `async function main(ctx)` by the first replace alone.

---

## BUG-111 — globalThis.budget convenience alias is mutable and can be poisoned across runs

**Area:** Sandbox / Security
**Severity:** Low
**Location:** `sandbox.ts` buildInitScript() — the `globalThis.budget = ctx.budget;` line at the end of __pi_build_ctx
**Discovered:** iteration-3

### Description

At the end of __pi_build_ctx (in buildInitScript), `globalThis.budget = ctx.budget` installs a writable, configurable convenience alias on the Context's globalThis. Since globalThis is intentionally not frozen, user code can delete, overwrite, or replace globalThis.budget during a run. If the same Sandbox instance is used for multiple runScript() calls, a prior run's script could have set `globalThis.budget = null` or `Object.defineProperty(globalThis, 'budget', {get: () => Infinity})`. The next runScript() call rebuilds ctx.budget correctly inside __pi_build_ctx (the closure is fresh), but globalThis.budget is then overwritten with the new value. During that new run, any user code that reads globalThis.budget directly (instead of ctx.budget) sees the correct value — but mid-execution mutation of globalThis.budget is undetected and silently diverges from ctx.budget.

### Suggested Fix

Either use Object.defineProperty with writable:false and configurable:false to make the alias read-only, or remove the globalThis.budget alias entirely and require authors to access budget via ctx.budget. The ctx object itself is frozen, so ctx.budget is safe.

---

## BUG-112 — Dead code: `approved`/`pending` state-reset branches in `resumeRun` are unreachable

**Area:** Runtime / resumeRun
**Severity:** High
**Location:** `src/runtime/resumeRun.ts` — resumeRun(), the `else if (finalState === 'approved')` and `else if (finalState === 'pending')` blocks after lock acquisition
**Discovered:** iteration-3

### Description

In `resumeRun.ts`, the resumability gate checks `RESUMABLE_STATES.has(finalState)` (which only contains `'paused'` and `'running'`) and throws `ResumeNotAllowedError` for everything else that isn't `failed`. The `else if (finalState === 'approved')` and `else if (finalState === 'pending')` state-reset branches that follow later in the function (after lock acquisition) can never be reached — execution always throws before them. If the original intent was to support resuming `approved`/`pending` runs, `RESUMABLE_STATES` must include those states. As-is, a run stuck at `approved` (e.g., due to a crash during the approved→running transition) cannot be resumed.

### Suggested Fix

Either add `'approved'` and `'pending'` to `RESUMABLE_STATES` in `ledger.ts` and document the recovery intent, or delete the two dead branches and add a comment explaining those states are intentionally non-resumable.

---

## BUG-113 — TOCTOU race: ledger is read before the resume lock is acquired, `finalState` can be stale

**Area:** Runtime / resumeRun
**Severity:** High
**Location:** `src/runtime/resumeRun.ts` — resumeRun(), ledger read (~line 90) precedes `acquireResumeLock` call (~line 130)
**Discovered:** iteration-3

### Description

In `resumeRun.ts`, the ledger is read and `finalState` is derived, then the resumability check runs, and only after that is `acquireResumeLock` called. Between the ledger read and the lock acquisition another pi process can acquire the lock, append new transitions (including reaching a terminal state), and release its lock. `resumeRun` then proceeds with a stale `finalState` — potentially resuming a run that is already `done`, `stopped`, or concurrently running. The lock is supposed to prevent this, but it only guards after the state has already been consumed.

### Suggested Fix

Move `acquireResumeLock` before `reader.read()`, or re-read the ledger immediately after acquiring the lock and re-run the resumability check with the fresh state.

---

## BUG-114 — Inner SIGKILL escalation timer is never cancelled after child exits cleanly post-SIGTERM

**Area:** Runtime / dispatcher
**Severity:** Medium
**Location:** `src/runtime/dispatcher.ts` — `dispatchAgent()`, the nested `setTimeout` inside `timeoutHandle`'s callback
**Discovered:** iteration-3

### Description

In `dispatchAgent`, when the subprocess timeout fires it sends SIGTERM and schedules an inner `killHandle = setTimeout(() => child.kill('SIGKILL'), 5000)`. The outer `timeoutHandle` is cleared via `clearTimeout(timeoutHandle)` at the end of the dispatch, but `killHandle` is never stored or cancelled. If the child exits cleanly within the 5-second SIGTERM grace window, `killHandle` fires anyway and calls `child.kill('SIGKILL')` on the already-dead child. The `try/catch` around the `kill()` call swallows any error, but on a long-lived process the kernel could have reused the child PID by then, silently SIGKILL-ing an unrelated process.

### Suggested Fix

Capture `killHandle` in an outer variable and call `clearTimeout(killHandle)` after `exitPromise` resolves (i.e., after the child has exited), before the existing `clearTimeout(timeoutHandle)` call.

---

## BUG-115 — `stderrTee` WriteStream not drained before `fs.appendFile` in the parse-error path, causing a write race on the stderr file

**Area:** Runtime / dispatcher
**Severity:** Medium
**Location:** `src/runtime/dispatcher.ts` — `dispatchAgent()`, the `if (parseError)` block near the end of the function
**Discovered:** iteration-3

### Description

In `dispatchAgent`, when `parseError` is non-null the code calls `await fs.appendFile(stderrPath, parseError.truncatedRegion + '\n', 'utf8')` and then throws. At this point `stderrTee` (a `WriteStream` writing to the same `stderrPath`) may still have buffered data being flushed asynchronously via the child's `stderr.on('data')` handler. There is no `await` on `stderrTee` in this path (the drain `Promise` that waits for `stderrTee.close`/`finish` only runs in the success path). `fs.appendFile` and `stderrTee` can interleave, corrupting the stderr file with out-of-order content or partial appends.

### Suggested Fix

Before calling `fs.appendFile`, await the same `stderrTee` drain pattern used in the success path (wait for `'close'` or `'finish'` on `stderrTee`). Alternatively, call `stderrTee.end()` and await it before appending the parse-error bytes.

---

## BUG-116 — Resume lock file has an open-then-write TOCTOU race that can grant two processes the lock simultaneously

**Area:** Runtime / runLock
**Severity:** Medium
**Location:** `src/runtime/runLock.ts` — `acquireResumeLock()`, between the `openSync('wx')` call and the `writeSync` call
**Discovered:** iteration-3

### Description

In `acquireResumeLock`, the lock is created atomically via `openSync(lockPath, 'wx')` (O_EXCL), which returns an open file descriptor to an *empty* file. The lock body JSON is written in a subsequent `writeSync` call. Between the O_EXCL `openSync` and the `writeSync`, another process can call `readFileSync(lockPath)`, see an empty file (`raw.trim().length === 0`), classify it as stale, `unlinkSync` it, and create its own lock file at the same path. When the first process then calls `writeSync(fd, ...)`, it writes to the now-orphaned inode (the path has been replaced). Both processes believe they hold the lock. The module comment acknowledges NFS non-correctness but does not mention this local-fs race.

### Suggested Fix

Write a placeholder body (e.g., `{pid}` only) synchronously before `closeSync` so the file is never transiently empty. Also add `fsyncSync(fd)` between `writeSync` and `closeSync` to ensure the content is durable before the FD is released.

---

## BUG-117 — `applyEntry('run.ended')` does not guard against already-terminal summaries, unlike sibling handlers

**Area:** Runtime / activeRuns
**Severity:** Low
**Location:** `src/runtime/activeRuns.ts` — `ActiveRunsRegistry.applyEntry()`, case `'pi-workflows.run.ended'`
**Discovered:** iteration-3

### Description

In `ActiveRunsRegistry.applyEntry`, the `'pi-workflows.run.started'` and `'pi-workflows.run.transitioned'` cases both have an early return when `isTerminalState(prior.state)` is true, preventing out-of-order or duplicate entries from overwriting a final state. The `'pi-workflows.run.ended'` case has no such guard — it unconditionally overwrites `state`, `endedAt`, and `durationMs` even if the summary is already terminal. A delayed or replayed `run.ended` event from a cross-process feed (e.g., during crash-sweep recovery) can replace a correctly-computed terminal summary with stale values (wrong `durationMs`, different `endedAt`).

### Suggested Fix

Add a guard at the top of the `'pi-workflows.run.ended'` case: if `prior && isTerminalState(prior.state)` return early (same pattern as the `'run.transitioned'` case), or at minimum skip overwriting `endedAt`/`durationMs` if the prior summary already has them set.

---

## BUG-118 — phaseCursor not clamped when agents complete while phase-view is open

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — handleAction case 'navigate-up', phase-view branch (~line 534)
**Discovered:** iteration-3

### Description

In the phase-view navigate-up handler, the code only checks `phaseCursor > 0` before decrementing. When agents finish running and `visibleAgents` shrinks below `phaseCursor + 1`, the cursor is left at an OOB index (no row highlighted). Pressing ↑ decrements one step at a time from the OOB position instead of jumping directly to `visibleAgents - 1`, requiring multiple keypresses to recover. By contrast, navigate-down correctly computes `visibleAgents` from running-phase agents and guards the upper bound.

### Suggested Fix

After decrementing, clamp to `visibleAgents - 1`: compute `visibleAgents` from `opts.phaseRegistry.getRunSnapshot(openedRunId)?.phases.filter(p => p.status === 'running').flatMap(p => p.agents).length ?? 0` and set `phaseCursor = Math.min(phaseCursor - 1, Math.max(0, visibleAgents - 1))`; or clamp on entry (when debouncedRender fires, also clamp phaseCursor).

---

## BUG-119 — 'g' hotkey opens GC dialog from phase-view and agent-detail — view guard missing in dispatchHotkey

**Area:** TUI / hotkeys
**Severity:** Medium
**Location:** `hotkeys.ts` — dispatchHotkey, line ~228 (`if (k === 'g') return { kind: 'open-gc-dialog' }`)
**Discovered:** iteration-3

### Description

`isHotkeyEnabled` correctly gates `g` to `runs-list` (`return input.view === 'runs-list'`), but `dispatchHotkey` has no view guard for `g`. The dispatcher short-circuits the no-selection guard via `if (input.runId === undefined && k !== 'g')`, then unconditionally returns `{ kind: 'open-gc-dialog' }`. From phase-view, `runId` is passed as `openedRunId`, so the no-selection gate passes and the GC dialog opens. From agent-detail, `runId` is also undefined but the `k !== 'g'` exception still passes the guard and opens the dialog.

### Suggested Fix

Add a view guard: `if (k === 'g') { if (input.view !== 'runs-list') return { kind: 'noop', reason: 'disabled-for-state' }; return { kind: 'open-gc-dialog' }; }`

---

## BUG-120 — helpForState('runs-list') shows 'r' as disabled for paused runs — mismatch with dispatcher

**Area:** TUI / hotkeys
**Severity:** Low
**Location:** `hotkeys.ts` — helpForState, runs-list branch (~line 380): `dis('r', 'restart', noSel || !isTerminal)`
**Discovered:** iteration-3

### Description

In `helpForState` for the runs-list view: `dis('r', 'restart', noSel || !isTerminal)`. For a paused run, `!isTerminal` is `true`, so the hint renders `r` as disabled (grayed-out `(r restart)`). However, both `isHotkeyEnabled` and `dispatchHotkey` correctly enable `r` on paused runs as a 'resume' action. The help bar thus actively misleads the user into thinking `r` won't work, even though pressing it resumes the run. The phase-view help already handles this correctly with `isPaused ? 'resume' : 'restart'`.

### Suggested Fix

Mirror the phase-view logic: `dis('r', isPaused ? 'resume' : 'restart', noSel || (!isPaused && !isTerminal))`.

---

## BUG-121 — GC activeIds computed from stale lastSnapshot instead of live registry — newly-started runs unprotected

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — handleAction case 'open-gc-dialog' (~line 700): `const activeIds = new Set(lastSnapshot.filter(...)...)`
**Discovered:** iteration-3

### Description

In `handleAction('open-gc-dialog')`, `activeIds` is built from `lastSnapshot`: `lastSnapshot.filter(s => s.state === 'running' || s.state === 'paused').map(s => s.runId)`. `lastSnapshot` is only refreshed when the debounce timer fires (every ≥30 ms after a feed event). Any run that started after the last debounce cycle (including runs started on another process whose entry hasn't propagated) will be absent from `activeIds`. The F4 protection in `loadGcCandidates` uses `activeRunIds` to exclude candidates whose `restartedFrom` lineage is active — missing a live run from this set means the protection is silently bypassed for that run.

### Suggested Fix

Replace `lastSnapshot` with a live query: `opts.registry.listSummaries().filter(s => s.state === 'running' || s.state === 'paused').map(s => s.runId)`.

---

## BUG-122 — GC dialog Enter handler doesn't cover '\n' (Unix newline) — some terminals send LF for Enter

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — handleKey GC dialog intercept (~line 804): `if (k === 'y' || key === 'Enter' || key === 'RETURN' || key === '\r')`
**Discovered:** iteration-3

### Description

The inline GC dialog key intercept in `handleKey` checks `key === 'Enter' || key === 'RETURN' || key === '\r'` for the apply action. `'\n'` (LF) is omitted. On some terminals and in piped/non-TTY test environments, Enter produces `'\n'` rather than `'\r'`. This makes the GC dialog unresponsive to Enter on those terminals. The upstream `NORM_KEY` map in hotkeys.ts correctly maps `'\n'` to `'enter'`, but the GC intercept bypasses `dispatchHotkey` entirely and does its own raw key comparison.

### Suggested Fix

Add `|| key === '\n'` to the Enter condition, or route through the normalizer: `const norm = NORM_KEY.get(key) ?? key.toLowerCase(); if (norm === 'y' || norm === 'enter') { ... }`

---

## BUG-123 — cursor passed to renderPhaseView when totalAgents > 0, but phaseCursor indexes running agents only

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — buildRender() phase-view block (~line 503): `phaseSnap.totalAgents > 0`
**Discovered:** iteration-3

### Description

In `buildRender()`, `phaseCursor` is forwarded to `renderPhaseView` under the condition `phaseSnap.totalAgents > 0`. `totalAgents` counts all agents across all phases (done, queued, running). `phaseCursor` however indexes only into running-phase agents (matching the `agentRows` array in renderPhaseView). When all running agents have completed (`totalAgents > 0` but zero running), `phaseCursor` is still passed (possibly non-zero from prior navigation), causing `renderPhaseView` to silently show no highlight (since `phaseCursor >= agentRows.length`). The condition should guard on running agent count to communicate intent and avoid passing a meaningless cursor.

### Suggested Fix

Replace condition with running-agent count: `const runningCount = phaseSnap.phases.filter(p => p.status === 'running').reduce((s, p) => s + p.agents.length, 0); if (phaseSnap !== undefined && phaseCursor >= 0 && runningCount > 0)`.

---

## BUG-124 — agentDetailDebounceTimer not cleared on navigate-back from agent-detail — stale render triggered after transition

**Area:** TUI / overlay
**Severity:** Low
**Location:** `overlay.ts` — handleAction case 'navigate-back', agent-detail branch (~line 570)
**Discovered:** iteration-3

### Description

When the user presses Esc from agent-detail, `handleAction('navigate-back')` sets `view = 'phase-view'`, clears `openedAgentId` and `agentLogTail`, then calls `requestRender()`. However, it does NOT clear `agentDetailDebounceTimer`. If a `pi-workflows.agent.log` event arrived just before the Esc and the 100 ms debounce is still pending, the timer fires after the view transition, calling `requestRender()` again. This triggers a spurious phase-view render. While the render output is correct (view is already phase-view), the extra frame may cause a visible flicker or confuse timing-sensitive tests. The timer IS cleared in `cleanup()` (overlay close), but not on the mid-session view transition.

### Suggested Fix

Add `if (agentDetailDebounceTimer !== null) { clearTimeout(agentDetailDebounceTimer); agentDetailDebounceTimer = null; }` at the top of the agent-detail navigate-back branch, before setting `view = 'phase-view'`.

---

## BUG-125 — buildRender() mutates view and openedAgentId as side effects — repeated calls cause silent state transitions

**Area:** TUI / overlay
**Severity:** Medium
**Location:** `overlay.ts` — buildRender() lines ~486-487 (agent vanished fallback) and ~513 (run vanished fallback)
**Discovered:** iteration-3

### Description

`buildRender()` is a render function called by the TUI's `render(width)` method and by the `currentLines` test-handle accessor. It contains two state-mutation side effects: (1) when `view === 'agent-detail'` and the agent has vanished from the registry, it sets `view = 'phase-view'` and `openedAgentId = undefined` inline before falling through; (2) when `view === 'phase-view'` and the run summary is gone, it sets `view = 'runs-list'` inline. Both mutations skip calling `requestRender()`. If the TUI calls `render()` twice in a single frame, the first call silently transitions state and the second call renders the fallback view — with no explicit re-render queued and no observable transition event fired. This also violates the component contract that `render()` be a pure projection of state.

### Suggested Fix

Move vanish-fallback transitions out of buildRender() into the subscription callback or a separate `reconcileViewState()` helper called from debouncedRender. buildRender() should treat a missing agent/run as a graceful no-op (render the fallback inline without mutating) and the subscription or a post-render hook should call the transition + requestRender().

---

## BUG-126 — Stale compaction snapshot overwrites concurrent write when threshold crossed

**Area:** Runtime / cache
**Severity:** Medium
**Location:** `src/runtime/cache.ts` — `runCompaction()`, lines building `snapshot` before chaining onto `this.writeQueue`
**Discovered:** iteration-3

### Description

In `runCompaction()`, the snapshot is built synchronously from in-memory maps before being chained onto the write queue. When two callers invoke `setAgentResult` concurrently (e.g., via `Promise.all`), the second caller's `appendRecord` is already enqueued before `runCompaction` chains its rename. Execution order becomes: K2_disk_write → compaction_rename. K2 is appended to cache.jsonl, then the stale snapshot (built with K1-only, before K2 entered memory) renames over cache.jsonl, erasing K2's append. K2's own `maybeCompact` triggers a second compaction that repairs it, but there is a crash window between the two consecutive compactions where K2 is permanently lost.

### Suggested Fix

Build the snapshot inside the queued callback (`this.writeQueue.then(() => { const snapshot = buildSnapshot(); return writeSnapshotAndRename(snapshot); })`) so it captures in-memory state only after all previously-queued writes have completed and their memory updates have run.

---

## BUG-127 — `writeResultFile` missing fsync before rename — weaker durability than documented

**Area:** Runtime / resultDelivery
**Severity:** Medium
**Location:** `src/runtime/resultDelivery.ts` — `writeResultFile()`, `fs.writeFile(tmp, ...)` call
**Discovered:** iteration-3

### Description

`writeResultFile` documents itself as 'atomic' via tmp+rename, but calls `fs.writeFile` (no explicit fsync) before `fs.rename`. A power loss or OS crash after the `rename` syscall completes can leave the renamed `result.json` with zero bytes or partial content because OS write buffers were not flushed to stable storage. `cache.ts`'s compaction path uses `fsyncSync(fd)` explicitly before rename. `writeResultFile`'s durability guarantee is weaker than its doc comment implies and inconsistent with the rest of the persistence layer.

### Suggested Fix

After `fs.writeFile(tmp, body)`, open the tmp file and call `fsync` before `fs.rename`: e.g., `const fd = await fsp.open(tmp, 'r+'); try { await fd.sync(); } finally { await fd.close(); }` — or use `fs.writeFile` followed by an explicit `fsync` via a file descriptor.

---

## BUG-128 — `cancelReasonText` returns 'approval denied' when `decision.approved === true`

**Area:** Runtime / resultDelivery
**Severity:** Low
**Location:** `src/runtime/resultDelivery.ts` — `cancelReasonText()`, second `if` branch
**Discovered:** iteration-3

### Description

In `cancelReasonText`, the branch `if (decision.approved) return "approval denied"` fires when the passed `ApprovalDecision` has `approved === true`. An outcome of `cancelled-pre-run` with an approved decision is logically contradictory; surfacing it as 'approval denied' is semantically wrong and will confuse debugging. The function is only called when `input.error` is absent, so this string reaches the user-visible result card.

### Suggested Fix

Replace `if (decision.approved) return "approval denied"` with `if (decision.approved) return "unexpected cancellation (decision was approved)"` or assert this case is unreachable and log a warning.

---

## BUG-129 — gitignore check in `runSaveScript` fires after the 'Add to git?' prompt

**Area:** Runtime / saveScript
**Severity:** Medium
**Location:** `src/runtime/saveScript.ts` — `runSaveScript()`, gitignore block placed after the `opts.ui.prompt` for git add
**Discovered:** iteration-3

### Description

In `runSaveScript`, the `.gitignore` read and `gitignoreCoversPi` check execute AFTER the `ui.prompt('Add to git?')` call. The user is asked whether to stage the file before being told that `.pi/` is ignored by git. If the user answers 'y', `runGitAdd` silently fails (git honors the ignore), and the warning fires as a non-actionable post-hoc notification. The correct behavior is to check `.gitignore` before the prompt and either suppress the prompt ('git ignores this file, skipping add') or include the warning inline so the user can make an informed choice.

### Suggested Fix

Move the `readGitIgnore` + `gitignoreCoversPi` check above the `ui.prompt('...Add to git?')` call. If `gitignoreWarned` is true, skip the prompt entirely and set `gitAdded = false` with a notification, or include the warning text in the prompt message.

---

## BUG-130 — Unused import `_tmpdir` in `manifestWriter.ts`

**Area:** Runtime / manifestWriter
**Severity:** Low
**Location:** `src/runtime/manifestWriter.ts` — top-level import block
**Discovered:** iteration-3

### Description

`import { tmpdir as _tmpdir } from 'node:os'` is imported at the top of the file but never referenced. The underscore prefix was added to suppress the lint warning, indicating this is a known-stale refactoring remnant. The tmp file was evidently moved from `os.tmpdir()` to `runDirAbs` (for same-filesystem rename atomicity), but the import was not removed. This will fail strict `no-unused-vars` checks and clutters the dependency surface.

### Suggested Fix

Remove the `tmpdir as _tmpdir` import. If `os` is not imported for any other reason, remove the entire `node:os` import line.

---

## BUG-131 — TOCTOU in `addTrustUnlocked`: `existsSync` then async `readFile` races with file deletion

**Area:** Runtime / trustStore
**Severity:** Low
**Location:** `src/runtime/trustStore.ts` — `addTrustUnlocked()`, `existsSync(path)` guard and subsequent `readFile` catch
**Discovered:** iteration-3

### Description

In `addTrustUnlocked`, `existsSync(path)` is called synchronously; if it returns true, `await fs.readFile(path)` is called next. Between the two calls another process (or an OS GC of `.pi/settings.json`) could delete the file. The `readFile` then throws ENOENT, which the catch block re-throws as `TrustWriteError(path, 'io', e)`. The correct behavior for a just-deleted settings file is to treat it as absent and start with `{}`, not to surface an I/O error to the caller.

### Suggested Fix

Remove the `existsSync` guard and handle ENOENT in the `readFile` catch block: `catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { /* treat as empty */ } else { throw new TrustWriteError(path, 'io', e); } }`.

---

## BUG-132 — `writeResultFile` tmp filename has no random component — same-millisecond collision

**Area:** Runtime / resultDelivery
**Severity:** Low
**Location:** `src/runtime/resultDelivery.ts` — `writeResultFile()`, `const tmp = join(...)` line
**Discovered:** iteration-3

### Description

The tmp file name is constructed as `result.json.tmp-${process.pid}-${Date.now()}`. Two concurrent calls to `writeResultFile` for the same `runDirAbs` within the same millisecond produce the same tmp path. Both calls write to the same tmp file concurrently and both call `fs.rename`; the result is a torn interleave (second rename wins with whichever partial content was written last). `manifestWriter.ts` avoids this with `randomBytes(4)` appended to its tmp names. `writeResultFile` documents itself as idempotent for dual calls ('caller may invoke twice') but the implementation only works safely when the calls are serialized.

### Suggested Fix

Append `crypto.randomBytes(4).toString('hex')` to the tmp filename: `result.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}` — matching the pattern already used in manifestWriter and trustStore.

---

## BUG-133 — `ConsensusOpts.similarity` field documented but doesn't exist in actual types

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ConsensusOpts interface
**Discovered:** iteration-3

### Description

runtime-api.md documents a `similarity?: number` field in `ConsensusOpts` ("Jaccard floor per pair (default 0.6)") but `public.d.ts` only has `threshold?: number`. The `similarity` field is entirely fabricated in the docs — authors who set it will have it silently ignored.

### Suggested Fix

Remove the `similarity` field from the ConsensusOpts docs. The single `threshold` controls pair agreement.

---

## BUG-134 — `ConsensusOpts.threshold` default wrong — docs say 0.5, actual is 0.6

**Area:** Docs / runtime-api
**Severity:** Medium
**Location:** `docs/runtime-api.md` — ConsensusOpts `threshold` comment
**Discovered:** iteration-3

### Description

runtime-api.md says `threshold` defaults to `0.5` but `public.d.ts` documents `Default 0.6`. Authors tuning consensus behaviour will get the wrong baseline expectation.

### Suggested Fix

Change `// fraction of pairs that must agree (default 0.5)` to `// default 0.6`.

---

## BUG-135 — `RetryOpts.maxAttempts` wrong — actual field name is `attempts`

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — RetryOpts interface; `docs/authoring.md` section 4 retry example
**Discovered:** iteration-3

### Description

runtime-api.md documents `maxAttempts?: number` but `public.d.ts` and the implementation use `attempts?: number`. Code that sets `{ maxAttempts: 5 }` will silently be ignored (the extra-key passthrough won't apply the value). The authoring.md example also uses `maxAttempts: 3`.

### Suggested Fix

Rename `maxAttempts` to `attempts` in both docs/runtime-api.md and docs/authoring.md examples.

---

## BUG-136 — `RetryOpts.backoffMs` default wrong — docs say 500ms, actual is 100ms

**Area:** Docs / runtime-api
**Severity:** Medium
**Location:** `docs/runtime-api.md` — RetryOpts `backoffMs` comment
**Discovered:** iteration-3

### Description

runtime-api.md says `backoffMs` initial backoff defaults to 500ms but `public.d.ts` documents `Default 100`. Authors relying on the default for rate-limit backoff scenarios will get 5× less wait than expected.

### Suggested Fix

Change `// initial backoff in ms (default 500)` to `// initial backoff in ms (default 100)`.

---

## BUG-137 — `ctx.phase` missing third `opts?: PhaseOpts` parameter in runtime-api.md

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ctx.phase signature and Notes section
**Discovered:** iteration-3

### Description

The `ctx.phase` signature in runtime-api.md only shows two parameters but the actual type is `phase(name, agents, opts?: PhaseOpts)`. The `failMode: 'null'` option (referenced in authoring.md section 8, SKILL.md, and writeWorkflowTool.ts) is never reachable without the undocumented third argument. `PhaseOpts` is not defined anywhere in the docs.

### Suggested Fix

Add `opts?: PhaseOpts` to the signature, add a `PhaseOpts` interface block documenting `failMode: 'throw' | 'null'`, and update the Notes bullet to mention that the return type is `ReadonlyArray<AgentResult | null>` when `failMode: 'null'`.

---

## BUG-138 — `ctx.phase` return type wrong — omits `null` for `failMode: 'null'`

**Area:** Docs / runtime-api
**Severity:** High
**Location:** `docs/runtime-api.md` — ctx.phase signature
**Discovered:** iteration-3

### Description

runtime-api.md shows `Promise<ReadonlyArray<AgentResult>>` but the actual type is `Promise<ReadonlyArray<AgentResult | null>>`. When `failMode: 'null'` is used, failed agents produce `null` entries — code that assumes all elements are non-null will crash with `Cannot read properties of null`.

### Suggested Fix

Change return type to `Promise<ReadonlyArray<AgentResult | null>>` and add a note that entries are `null` when an agent fails and `failMode: 'null'` was passed.

---

## BUG-139 — `ctx.pipeline` not documented in runtime-api.md or authoring.md

**Area:** Docs
**Severity:** High
**Location:** `docs/runtime-api.md` — missing section; `docs/authoring.md` — ctx table
**Discovered:** iteration-3

### Description

`ctx.pipeline(items, ...stages)` is a real method in `public.d.ts` and is used in the `write_workflow` promptSnippet and promptGuidelines, but it has no entry in runtime-api.md and is absent from the authoring.md ctx table. Authors who encounter it in the promptSnippet have no reference to understand the stage signature `(prev, original, index)` or that returning an AgentHandle auto-executes it.

### Suggested Fix

Add a `ctx.pipeline` section to runtime-api.md documenting the variadic stage signature, automatic handle execution, and return type. Add a row to the authoring.md ctx table.

---

## BUG-140 — `ctx.budget` not documented in runtime-api.md

**Area:** Docs
**Severity:** Medium
**Location:** `docs/runtime-api.md` — missing section
**Discovered:** iteration-3

### Description

`ctx.budget` (with `total`, `spent()`, `remaining()`) is a real property in `public.d.ts` and is demonstrated in the `write_workflow` promptSnippet (`ctx.budget.spent()`), but it has no section in runtime-api.md. Authors who need to gate expensive phases on token budget have no documented API to rely on.

### Suggested Fix

Add a `ctx.budget` section documenting `total: number | null`, `spent(): number`, and `remaining(): number`.

---

## BUG-141 — `AgentOpts.schema` missing from runtime-api.md AgentOpts interface

**Area:** Docs
**Severity:** Medium
**Location:** `docs/runtime-api.md` — AgentOpts interface
**Discovered:** iteration-3

### Description

`AgentOpts.schema` is defined in `public.d.ts` and used in the promptSnippet (with `result.output` as the parsed object), but it is absent from the `AgentOpts` interface in runtime-api.md. The `AgentResult.output` field says "set when opts.schema was provided" but there is no documentation of what `schema` accepts or how it works.

### Suggested Fix

Add `schema?: Record<string, unknown>` to the AgentOpts block with a note that a JSON Schema instruction is appended to the prompt and the parsed result is available as `result.output`.

---

## BUG-142 — `hello.js` example missing required `export const meta`

**Area:** Examples
**Severity:** High
**Location:** `examples/hello/hello.js`
**Discovered:** iteration-3

### Description

`writeWorkflowTool.ts` `validateWorkflowScript` requires `export const meta = { name, ... }` as the FIRST meaningful statement, yet `hello.js` (the "good starting point for authors building their first workflow") has no `export const meta` at all. Any author who copies this example and submits it via `write_workflow` will get a validation error.

### Suggested Fix

Add `export const meta = { name: 'hello', description: 'Minimal hello-world workflow', version: '1.0.0' };` as the first statement before the default export.

---

## BUG-143 — `codebase-audit.js` canonical reference missing required `export const meta`

**Area:** Examples
**Severity:** High
**Location:** `examples/codebase-audit/codebase-audit.js`
**Discovered:** iteration-3

### Description

The bundled `/codebase-audit` workflow (described in authoring.md as "the canonical pi-workflows reference implementation") has no `export const meta`. Any author who copies it as a template will get a validation error from `write_workflow`. It also sets a bad example for the pattern that is explicitly required.

### Suggested Fix

Add `export const meta = { name: 'codebase-audit', description: '...', version: '1.0.0' };` as the first statement.

---

## BUG-144 — `ctx.log` called with an object in codebase-audit.js but typed as `string`

**Area:** Examples
**Severity:** Medium
**Location:** `examples/codebase-audit/codebase-audit.js` — analyze phase error handler
**Discovered:** iteration-3

### Description

codebase-audit.js calls `ctx.log({ msg: '...', agentId: ..., err: ... }, { level: 'warn' })` with a plain object as the first argument, but both `public.d.ts` and runtime-api.md type `log(message: string, ...)`. This will either silently coerce the object to `[object Object]` or crash depending on the runtime implementation.

### Suggested Fix

Change the object arg to a string: `` ctx.log(`analyze agent ${a.agentId} returned unparseable JSON: ${e.message}`, { level: 'warn' }) ``.

---

## BUG-145 — authoring.md section 5 references wrong example path

**Area:** Docs
**Severity:** Low
**Location:** `docs/authoring.md` — section 5
**Discovered:** iteration-3

### Description

authoring.md says "See `examples/codebase-audit.js` for the full source" but the actual file is at `examples/codebase-audit/codebase-audit.js`. The flat path doesn't exist.

### Suggested Fix

Change `examples/codebase-audit.js` to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-146 — authoring.md section 5 says vote phase uses a judge agent but codebase-audit uses JS Borda count

**Area:** Docs
**Severity:** Low
**Location:** `docs/authoring.md` — section 5, Phase 3 description
**Discovered:** iteration-3

### Description

authoring.md section 5 describes the vote phase as "The judge aggregates the ranking lists" implying a judge agent, but codebase-audit.js explicitly avoids `ctx.vote()` and uses plain JavaScript Borda-count aggregation instead. The comment in the code even explains why. This misleads authors about what the example demonstrates.

### Suggested Fix

Change "The judge aggregates the ranking lists" to "A Borda-count aggregation in the workflow script combines the ranked lists (no judge agent — see the source comments for why ctx.vote is not used here).".

---

## BUG-147 — SKILL.md testing example uses `sha256` without defining its source

**Area:** Docs / SKILL
**Severity:** Low
**Location:** `skills/pi-workflows/SKILL.md` — Testing a workflow section
**Discovered:** iteration-3

### Description

The testing example in SKILL.md uses `sha256(\`Answer: test input\`)` to compute `promptHash` but `sha256` is neither imported nor explained. Authors following this example will get `ReferenceError: sha256 is not defined`.

### Suggested Fix

Either show the import (`import { createHash } from 'node:crypto'; const sha256 = s => createHash('sha256').update(s).digest('hex')`) or replace `sha256(...)` with a note that the promptHash is available via a test helper exported from `@samfp/pi-workflows/testing`.

---

## BUG-148 — promptSnippet uses TypeScript `as` cast syntax inside a JS workflow example

**Area:** Runtime / writeWorkflowTool
**Severity:** Medium
**Location:** `src/runtime/writeWorkflowTool.ts` — promptSnippet
**Discovered:** iteration-3

### Description

The `promptSnippet` in `writeWorkflowTool.ts` contains `(typed.output as { issues: string[] }).issues` — TypeScript cast syntax. Workflow files are plain `.js` running inside `node:vm`; TypeScript syntax is not valid there and will throw a SyntaxError at parse time.

### Suggested Fix

Replace the TypeScript cast with a plain JS access: `typed.output?.issues` or add a JSDoc comment for type hint context instead.
