# pi-workflows — Parity Gaps vs Claude Code Dynamic Workflows

This document tracks behaviors documented in the PRD or implied by
Anthropic's dynamic workflows blog post that we deliberately defer to
v2 (or beyond). Each row should cite the PRD/plan section, the slice
that reviewed the gap, and the trigger condition for revisiting.

## v1 deferred — schema validation of agent JSON output

**Trigger:** PRD §5.5.2 path 4 ("valid JSON / wrong schema") +
slice 8a concern F5.

**v1 behavior:** the dispatcher's JSON-stream parser checks structural
shape (one event per line, recognizable `type` field, `agent_end`
terminator). It does NOT validate that the events match a published
`pi --mode json` schema. The PRD's `MalformedAgentOutputError` reasons
include `unexpected-schema` but slice 6 never produces that value;
slice 8a confirmed and left the enum entry intact for v2.

**Why deferred:** the upstream pi `--mode json` schema is not yet
published. Defining a schema in pi-workflows would create a coupling
that breaks every time pi extends its event payload. Better to wait
for an upstream `pi --mode json --schema` machine-readable export.

**Revisit trigger:** when pi exposes a stable, versioned JSON schema
for `--mode json` events.

**Owner at revisit:** dispatcher (slice 6 successor).

## v1 deferred — `crypto.subtle`

**Trigger:** PRD §14 row 21.

**v1 behavior:** the sandbox exposes `crypto.randomUUID`,
`crypto.randomBytes`, `crypto.randomFillSync`, `crypto.getRandomValues`.
`crypto.subtle` is NOT exposed.

**Why deferred:** `crypto.subtle` is async and capability-heavy (key
material, signatures). Threading an async capability surface through
the realm boundary needs a careful design pass.

**Revisit trigger:** author demand.

## v1 deferred — `worker_threads` / interrupt-on-tick

**Trigger:** PRD §1.2 pin 5 + §8.3.6.

**v1 behavior:** sandbox is a `vm.Context`; a synchronous infinite
loop wedges the entire pi event loop. User must SIGINT pi from another
terminal.

**Why deferred:** `worker_threads` would solve this but adds a deep
re-architecture (different IPC model, no shared globals, async-only).
Out of scope for v1's "production-quality on a single host" bar.

**Revisit trigger:** persistent operator complaints about wedging, or
clear evidence of malicious DoS use cases.

## v1 deferred — true cross-run cache

**Trigger:** PRD §6.3 + slice 3.

**v1 behavior:** `cache.jsonl` lives under each run's directory. Cache
hits only happen WITHIN a single run unless the author preserves the
runDir (e.g. via `--keep-runs`). Slice 14's `s` save-script extracts
the cache for re-use.

**Why deferred:** workflow scripts are author-versioned. A cross-run
cache requires script-version-aware invalidation, which couples
slice 8a's cache key derivation to slice 14's save format. Slice 11
(resume) is the closest cousin and it does cross-run only WITHIN a
single workflow run.

**Revisit trigger:** documented author workflow that would benefit
(e.g. CI runs of the same audit workflow against PRs).

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

## v1 UX gap — r/s hotkeys on remote runs are silent

**Trigger:** slice 14 carry-forward U3, slice 15 F2.

**v1 behavior:** when a remote run is selected in the runs-list overlay,
pressing `r` (restart) or `s` (save-script) shows the message "operation
requires local handle" and takes no action. There is no toast or explicit
visual feedback beyond the status-line message.

**Why deferred:** implementing a full cross-process restart/save requires
IPC. Slice 14 chose option (a) — enforce rejection at the hotkey layer —
over option (b) (implement cross-process). The UX gap is the absence of a
proper toast.

**Revisit trigger:** user complaints about silent rejection on remote runs.

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
