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

## Slice 8a author-API alignment

For reference, the slice-8a public author API (`ctx.agent`,
`ctx.phase`, `ctx.cache`, `ctx.log`, `ctx.finishCallback`, `ctx.run`,
`ctx.input`, `ctx.signal`) matches PRD §4.2.1–4.2.5 + §4.2.7 fully.
The stdlib helpers (`ctx.vote`, `ctx.consensus`, `ctx.parallel`,
`ctx.retry`, `ctx.sleep` per §4.2.6) land in slice 8b.
