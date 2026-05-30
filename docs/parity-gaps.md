# pi-workflows — Parity Gaps vs Claude Code Dynamic Workflows

This document tracks behaviors documented in the PRD or implied by
Anthropic's dynamic workflows blog post that we deliberately defer to
v2 (or beyond). Each row should cite the PRD/plan section, the slice
that reviewed the gap, and the trigger condition for revisiting.

## ✅ FIXED — schema validation of agent JSON output

**Trigger:** PRD §5.5.2 path 4 ("valid JSON / wrong schema") +
slice 8a concern F5.

**Fixed:** `dispatcher.ts` now defines `KNOWN_EVENT_SHAPES` — a map of
confirmed `pi --mode json` event types to their required fields (derived
from real pi 0.74.0 output). After parsing each JSON line, if the event
type is in the map and a required field is absent, the dispatcher throws
`MalformedAgentOutputError` with `reason: "unexpected-schema"` immediately.
Unknown event types pass through unchanged (forward-compat).

**Scope:** Only `agent_end: ["messages"]` is validated today — the only
event type whose required fields are verified against real pi output. Other
event types can be added to `KNOWN_EVENT_SHAPES` as their schemas are confirmed.

**Why previously deferred:** the upstream pi schema was unpublished. The
current fix takes a conservative "only confirm what we've observed" approach
rather than coupling to a hypothetical schema export.

## ✅ FIXED — `crypto.subtle`

**Trigger:** PRD §14 row 21.

**Fixed:** `sandbox.ts` `buildInitScript` now assigns `cryptoNs.subtle = HC.subtle`
after the other crypto methods. The `SubtleCrypto` instance is assigned
directly (no `wrapHostMethod` wrapper) — all its methods are already async
and work across vm.Context realm boundaries in Node.js. Verified: workflows
can call `await crypto.subtle.digest('SHA-256', data)` and receive the
correct 32-byte result.

**Why it was deferred:** `subtle` was described as "capability-heavy (key
material, signatures)". In practice, the Node.js vm.Context boundary already
provides adequate isolation; `subtle` methods are stateless transforms that
don't escalate sandbox privileges.

✅ PARTIALLY FIXED — worker_threads / interrupt-on-tick

**Trigger:** PRD §1.2 pin 5 + §8.3.6.

**What's fixed:** `vm.Script.runInContext` now runs with a `runScriptTimeoutMs`
timeout (default 5 000 ms). Synchronous infinite loops — including tight loops
inside `async function main()` before the first `await` — are terminated and
raise a `SandboxViolationError` with reason `"sync-timeout"`.

**Still unaddressed:** after the first `await`, control returns to the Node.js
event loop and the sync timeout no longer applies. An async infinite loop
(`while(true) { await ctx.sleep(0); }`) still wedges the workflow process.
Full fix requires running the sandbox in a `worker_thread` so it can be killed
externally. That re-architecture is deferred to v2.

**Workaround for async loops:** SIGINT pi from another terminal.

## ✅ FIXED — true cross-run cache

**Trigger:** PRD §6.3 + slice 3.

**Fixed:** `CacheStore.openGlobal(scriptSha256)` opens a shared cache at
`~/.pi/agent/workflows/global-cache/<sha16>/cache.jsonl` keyed by the first
16 hex chars of the workflow script's sha256. Any change to the workflow
source produces a different directory — natural cache invalidation with no
explicit versioning bookkeeping. Both production call sites (`workflowCmd.ts`
and the `write_workflow` tool path in `index.ts`) now pass `enableGlobalCache: true`
so global cache is on by default for all workflow runs. The per-run
`runCtx.ts` cache lookup checks the global store first, then falls back to
the per-run store. Cache writes go to both. Tests: `tests/integration/globalCache.test.ts`
(cold start, hit, disabled, sha256-invalidation).

**Partial mitigation preserved:** `ctx.memo(key, fn, opts?)` remains available
as an author-controlled cross-run memoization primitive with TTL and scope
controls — it provides finer-grained control than the automatic global cache.
See `src/runtime/memoStore.ts`.

**Why previously deferred:** the original concern was coupling cache key
derivation to save format for script-version-aware invalidation. The sha256-
based directory approach solves this cleanly without that coupling.

## Author-API alignment (slice 9 update)

The slice-9 public author API (`ctx.agent`, `ctx.phase`, `ctx.cache`,
`ctx.log`, `ctx.finishCallback`, `ctx.run`, `ctx.input`, `ctx.signal`)
matches PRD §4.2.1–§4.2.5 + §4.2.7 + §4 line 420 fully. The stdlib
helpers (`ctx.vote`, `ctx.consensus`, `ctx.parallel`, `ctx.retry`,
`ctx.sleep` per §4.2.6) landed in slice 8b. `ctx.signal` is a Context-
realm AbortSignal-shaped polyfill (built per-runScript by
`__pi_make_signal()`) that bridges to the host run's AbortSignal
through a closure-captured abort thunk — same pattern as the timer
bridge (PRD §8.3.4 host-realm-eval defense). Tests:
`tests/security/fixtures/host-realm-eval.workflow.js` `ctx-signal`
rows + `tests/integration/abortSignalE2E.test.ts`.

For reference, before slice 9 the parity-gaps doc claimed slice 8a's
surface matched the API "fully". That was incorrect — `ctx.signal` was
deferred to slice 9. The wording above corrects the false claim.

## ✅ FIXED — r/s hotkeys on remote runs are silent

**Trigger:** slice 14 carry-forward U3, slice 15 F2.

**Fixed:** `hotkeys.ts` now returns `reason: "disabled-for-remote"` (distinct from
`"disabled-for-state"`) when `r`/`s` is pressed on a remote run. `overlay.ts`
checks this reason in the `noop` handler and sets a banner:
`"operation requires a local run (r/s unavailable on remote sessions)"`.
The banner is visible immediately and clears on the next key press.

**Why it was silent:** the `noop` action had no reason differentiation —
all disabled keys returned `"disabled-for-state"` and the overlay discarded
them silently.

## v1 doc gap — `--no-color` and `--no-loading` flags removed

**Trigger:** slice 18 docs review.

**v1 behavior:** the PRD §5.5 originally documented `--no-color` and
`--no-loading` as flags on the pi subprocess invocation. Both were removed
from the implementation (the subprocess fleet uses `pi --mode json` which
has no color/loading output). The docs now correctly omit these flags.

**Why:** `pi --mode json` suppresses all interactive output by design; the
flags are redundant.

## v1 behavior note — `agent_end` as final event type

**Trigger:** slice 18 docs review.

**v1 behavior:** the JSON-stream parser (slice 5) treats `agent_end` as
the sentinel event that terminates an agent's event stream. This matches
the actual pi `--mode json` output vocabulary. Earlier drafts of the PRD
used `run_end` — the implementation uses `agent_end`.

## v1 behavior note — save-script silently skips `git add`

**Trigger:** slice 14 save-script implementation.

**v1 behavior:** the `s` save-script hotkey writes the script to
`.pi/workflows/<name>.js` but silently skips `git add` when the project
has no `.git` root (e.g. home directory, tmpdir). This is intentional —
forcing a `git add` in a non-git tree would fail noisily. The TUI shows
the save path regardless.

**Revisit trigger:** user wants auto-staging in git repos.

## v1 behavior note — `pi.exec` vs `child_process.spawn`

**Trigger:** slice 18 docs review.

**v1 behavior:** workflow scripts do NOT have access to `pi.exec` or any
child_process API. The sandbox explicitly excludes `child_process`.
If a workflow needs to run a shell command, it should use `ctx.agent`
to ask pi to run it via a tool call. This matches the security model
(sandboxed scripts should not get unmediated shell access).
