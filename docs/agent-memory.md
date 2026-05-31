# Persistent per-agent memory (ZONE_MEMORY)

Status: **shipped 2026-05-31** — auto-injection + write-back + manifest record. **Follow-ups #1, #2, #3, #6 shipped on `zone-memory-followups` branch (see below).**

## Surface

```js
ctx.agent("review the PR", {
  memory: "user",        // 'user' | 'project' | 'local' | false (default false)
  name: "code-reviewer", // optional persona name; defaults to opts.id / agentId
});
```

When `memory` is one of the three scopes, the runtime:

1. Resolves `<scopeRoot>/<name>/MEMORY.md` (paths below).
2. Reads up to 25 KiB and prepends `Persistent memory:\n<content>\n\n`
   to the prompt the sub-agent sees.
3. Records the resolved directory in `<runDir>/manifest.json`'s
   `agentMemoryDirs: { [name]: <dir> }` for resume + audit.
4. Streams the agent's `pi --mode json` output. Any event of shape
   `{ "type": "memory_update", "text": "<utf-8 string>" }` is
   appended (with a newline separator) to that same MEMORY.md
   **after** the stream settles (post-`agent_end`). A child crash
   before `agent_end` skips the flush.

Disabled / missing-file behavior:

- `memory: false` / `memory: undefined` → no injection, no manifest
  record, dispatcher behaves identically to the pre-feature path.
- File missing on first run → no injection (silent). The agent can
  still emit `memory_update` events and the file is created lazily.
- File > 25 KiB → only the leading 25 KiB is injected. The on-disk
  file is left intact. A one-shot `log: warn` per `(run, name)` pair
  surfaces the cap once so authors notice (follow-up #2).

## Stdlib helpers (`ctx.memory.*`)

Workflow authors can read or update a persona's memory directly
without routing through a sub-agent's `memory_update` event:

```js
const current = await ctx.memory.read("code-reviewer", "user");
await ctx.memory.append("code-reviewer", "user", "- saw async/await foot-gun in PR #42\n");
const { beforeBytes, afterBytes, ratio } = await ctx.memory.compact(
  "code-reviewer",
  "user",
);
```

Semantics:

- `read(name, scope)` — returns the leading `MEMORY_READ_CAP_BYTES`
  (25 KiB) of MEMORY.md, or `null` for missing/empty.
- `append(name, scope, text)` — lazy-creates the scope dir, writes
  with a separator newline if the prior tail lacks one. Identical
  on-disk shape to a sub-agent's `memory_update` flush.
- `compact(name, scope)` — spawns a single `pi --mode json -p`
  summarizer that preserves recent entries verbatim and condenses
  older ones, then atomically writes the result back. Returns
  `{beforeBytes, afterBytes, ratio}`. On any failure the original
  file is left intact and the call rejects with `CompactionError`.

All three helpers reject path-traversal `name` and unknown `scope`
values with typed errors (`TypeError`, `InvalidMemoryNameError`).

## Scope paths

| scope     | path                                                          |
|-----------|---------------------------------------------------------------|
| `user`    | `~/.pi/agent/workflows/agent-memory/<name>/MEMORY.md`         |
| `project` | `<cwd>/.pi/workflows/agent-memory/<name>/MEMORY.md`           |
| `local`   | `<runDir>/agent-memory/<name>/MEMORY.md`                      |

`<name>` is sanitized via `assertSafeMemoryName` — same disallow list
as `assertSafeAgentId` (no `/`, `\`, `..`, NUL, leading `.`).

## Cache key

Memory content is **not** part of the agent cache key. A change to
MEMORY.md does not invalidate cached results. This mirrors how
`opts.schema` is treated and matches the typical workflow expectation
(memory is a soft input that should accrete without forcing reruns).
Authors who want memory updates to invalidate cache should toggle
`bindToWorkflowVersion: false` or vary an opts field that does enter
the key.

## Tests

`tests/unit/memory.test.ts` covers:

- `parseMemoryScope`: false/undefined/null disable; valid strings
  pass; bad shapes throw `TypeError`.
- `assertSafeMemoryName`: rejects empty, separators, `..`, NUL, hidden
  files.
- `resolveMemoryDir`: returns the documented path for each of the
  three scopes; rejects unsafe names.
- `readMemoryFile`: missing file → null; missing dir → null; empty
  file → null; small file verbatim; oversize file truncated at exactly
  `MEMORY_READ_CAP_BYTES`.
- `buildPromptWithMemory`: null/empty memory leaves prompt verbatim;
  populated memory prepends the documented header.
- `appendMemoryUpdate`: creates dir + file lazily; non-string text is
  no-op; consecutive updates separated by `\n` even when prior tail
  lacks one.
- `recordAgentMemoryDir`: fresh write; merge with prior manifest;
  idempotent re-record; concurrent writers serialize.
- `dispatchAgent` integration: `memory_update` events flush after
  `agent_end`; multiple events flush in order; non-string `text`
  silently ignored; no `memoryDir` set → events accepted but never
  flushed; child crash before `agent_end` skips flush.
- `dispatchAgent` prompt verbatim: dispatcher does not mutate
  `opts.prompt`; the runtime layer is responsible for injection.

## Resume cross-check

`resumeRun` reads `manifest.agentMemoryDirs` from the original run.
For each recorded `(name, dir)` pair, it re-resolves the live dir
across all three scopes (`user`/`project`/`local`) using the current
`cwd`/`$HOME`. If the recorded path matches none of the live
candidates, a `log: warn` ledger entry surfaces the divergence:

```
agent-memory: dir for "code-reviewer" moved between runs
  (recorded: /old/path/.pi/workflows/agent-memory/code-reviewer;
   live: user=..., project=..., local=...)
```

The warning is advisory — resume continues and the post-resume
dispatch will use the live-resolved path. The warning lets the
operator notice that the prior persona's accreted memory is parked
at the old path and isn't being seen by the resumed run.

## Follow-ups (remaining, not blocking)

1. ~~**Compaction.**~~ ✅ shipped — `ctx.memory.compact(name, scope)`.
2. ~~**Oversize warning.**~~ ✅ shipped — one-shot `log: warn` per
   `(run, name)` pair when MEMORY.md exceeds the 25 KiB read cap.
3. ~~**Resume cross-check.**~~ ✅ shipped — see above.
4. **GC integration.** `local`-scope memory dirs live inside the
   runDir and are GC'd with the run. `user` / `project` dirs persist
   forever; the existing `gc` module should not touch them but may
   want to surface their disk footprint in the dashboard. *Deferred.*
5. ~~**Read-only memory.**~~ ✅ **shipped** (polish-memory-hitl).
   `memory: { scope: 'user' | 'project' | 'local', readOnly: true }`
   on `ctx.agent()` injects MEMORY.md as usual but instructs the
   dispatcher to log + drop any `{type:'memory_update'}` events the
   sub-agent emits. `ctx.memory.append(name, scope)` for the same
   `(scope, name)` tuple throws `ReadOnlyMemoryError` so workflow
   authors can’t accidentally write to a tuple another call mounted
   read-only. Useful for shared "playbook" personas. Test:
   `tests/unit/memory.test.ts — "readOnly mode"` group.
6. ~~**Stdlib helper.**~~ ✅ shipped — `ctx.memory.read` /
   `ctx.memory.append` / `ctx.memory.compact`.

## Files touched in this slice

- `src/runtime/agentMemory.ts` — new module (scope resolution,
  read/append, prompt builder, name sanitizer).
- `src/runtime/manifestWriter.ts` — `recordAgentMemoryDir` helper +
  per-runDir write queue reuse.
- `src/runtime/dispatcher.ts` — `memoryDir` opt + `memory_update`
  event capture + post-`agent_end` flush.
- `src/runtime/runCtx.ts` — resolve + read + inject before dispatch;
  pass `memoryDir` through; record dir into manifest.
- `src/types/internal.d.ts` — `agentMemoryDirs` field on
  `RunManifest`; `memoryDir` field on `DispatcherOptions`.
- `tests/unit/memory.test.ts` — 38 tests covering everything above.

## Follow-up slice (`zone-memory-followups` branch)

- `src/runtime/agentMemory.ts` — `readMemoryFileWithMeta` (truncated
  flag), `crossCheckAgentMemoryDirs`, `compactMemoryFile`,
  `CompactionError`.
- `src/runtime/runCtx.ts` — oversize-warn dedup `Set`,
  `memoryRead` / `memoryAppend` / `memoryCompact` host bridges,
  default `compactSummarize` hook (spawns one `pi -p` agent).
- `src/runtime/sandbox.ts` — `ctx.memory = Object.freeze({read, append,
  compact})` wired in the init script.
- `src/runtime/resumeRun.ts` — cross-check call after the resume
  ledger entry; one warn per mismatched name.
- `src/types/internal.d.ts` — `memory_read` / `memory_append` /
  `memory_compact` on `RunCtxHost`.
- `tests/unit/stdlib-memory.test.ts` — 13 tests covering oversize
  warn dedup, cross-check, round-trip read/append, compact happy
  path, compact failure paths.
