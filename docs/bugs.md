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

## BUG-045 — Direct contradiction between promptGuidelines and promptSnippet on whether `AgentResult.output` exists

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:181 vs 198,217,224
**Discovered:** iteration-1

### Description

The `promptGuidelines` (line 181) explicitly state: "AgentResult has `.text` (string), `.usage`, `.durationMs`, `.cached` — NOT `.output`." But the promptSnippet comment (line 198) says: "AgentResult: { text, output?, usage, durationMs, cached } — use .text for prose, .output for schema results", and the promptSnippet code (line 224) uses `typed.output`. This internal contradiction within the same file will confuse LLMs unpredictably.

### Suggested Fix

Decide whether `AgentResult.output` is a real field (if so: document it in runtime-api.md and remove the 'NOT .output' guideline) or not (if so: remove .output from the promptSnippet comment and code, and remove the opts.schema example). Also update runtime-api.md AgentResult interface accordingly.

---

## BUG-046 — promptSnippet uses TypeScript `as` cast syntax inside a `.js` workflow file — invalid JavaScript

**Area:** writeWorkflowTool / docs
**Severity:** high
**Location:** src/runtime/writeWorkflowTool.ts:224 (promptSnippet)
**Discovered:** iteration-1

### Description

Line 224 of the promptSnippet uses `(typed.output as { issues: string[] }).issues` — this is TypeScript syntax. Workflow files are `.js` files executed inside `node:vm` with `allowCodeGeneration: false`. The `as` keyword is not valid JavaScript and will throw a SyntaxError when the vm tries to compile the script. Any LLM that copies this pattern will produce a workflow that fails at parse time.

### Suggested Fix

Replace `(typed.output as { issues: string[] }).issues` with plain JS: `/** @type {{ issues: string[] }} */ (typed.output).issues` or simply `typed.output?.issues ?? []`. Remove all TypeScript-specific syntax from the promptSnippet since workflows must be valid `.js`.

---

## BUG-047 — `codebase-audit.js` passes an object (not a string) as first arg to `ctx.log()`, contradicting the documented API

**Area:** examples
**Severity:** medium
**Location:** examples/codebase-audit/codebase-audit.js (ctx.log call in analyze error handler)
**Discovered:** iteration-1

### Description

In `examples/codebase-audit/codebase-audit.js` (the canonical reference implementation), `ctx.log` is called with an object as the first argument: `ctx.log({ msg: '...', agentId: ..., err: ... }, { level: 'warn' })`. But `runtime-api.md` documents `ctx.log(message: string, opts?)` — the first argument must be a string. At runtime this will log `[object Object]` instead of the intended message, making the warning useless.

### Suggested Fix

Change to `` ctx.log(`analyze agent returned unparseable JSON — agentId=${a.agentId} err=${e.message}`, { level: 'warn' }) `` to match the documented string signature.

---

## BUG-048 — `hello.js` and `codebase-audit.js` canonical examples omit `export const meta` — inconsistent with write_workflow validation requirement

**Area:** examples
**Severity:** medium
**Location:** examples/hello/hello.js, examples/codebase-audit/codebase-audit.js
**Discovered:** iteration-1

### Description

`writeWorkflowTool.ts` enforces that `export const meta = { name, description, version }` must be the FIRST meaningful statement, and the promptGuidelines say 'Always include export const meta as the FIRST statement'. Yet both `examples/hello/hello.js` and `examples/codebase-audit/codebase-audit.js` have no `export const meta` at all. Authors following these canonical examples will either produce workflows that pass through write_workflow validation failure, or be confused about when meta is required.

### Suggested Fix

Add `export const meta = { name: 'hello', description: '...', version: '1.0.0' }` as the first statement in both example files, making them consistent with the write_workflow validation contract and the authoring guidance.

---

## BUG-049 — `authoring.md` references `examples/codebase-audit.js` but actual file is at `examples/codebase-audit/codebase-audit.js`

**Area:** docs
**Severity:** low
**Location:** docs/authoring.md:164
**Discovered:** iteration-1

### Description

Line 164 of `authoring.md` says "See `examples/codebase-audit.js` for the full source." The actual file lives at `examples/codebase-audit/codebase-audit.js` — a subdirectory, not a flat `.js` file. The link is stale and will lead authors to a 404.

### Suggested Fix

Change `examples/codebase-audit.js` to `examples/codebase-audit/codebase-audit.js`.

---

## BUG-050 — promptGuideline tells LLM to say workflow "is already running" but write_workflow tool may only save (not start) the workflow

**Area:** writeWorkflowTool / docs
**Severity:** low
**Location:** src/runtime/writeWorkflowTool.ts (last promptGuideline entry)
**Discovered:** iteration-1

### Description

The last promptGuideline in `writeWorkflowTool.ts` instructs: "tell the user the workflow was saved and is already running — direct them to /workflows to monitor progress." However, the tool's own result card text handles three cases: run started, run failed to start, and not started ("It's now registered. Open /workflows to launch and monitor it."). The LLM narrative will say "already running" even when the tool reply says "registered but not started", creating a confusing mismatch.

### Suggested Fix

Change the promptGuideline to: "After calling write_workflow, tell the user the workflow was saved. If the result card says 'Run started', confirm it's running and direct to /workflows. Otherwise tell them to open /workflows to launch it manually."
