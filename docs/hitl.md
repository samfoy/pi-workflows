# ZONE_HITL — mid-phase human-in-the-loop pause-and-route

`ctx.interrupt({ question, choices?, default? })` is the workflow author's
hook for **mid-phase HITL**: pause the run, surface a question to a
supervisor (TUI overlay or another `pi` process via `WorkflowClient`), and
resume with the supervisor's answer threaded back into the script.

It complements `ctx.gate(message, opts)` — `gate` is yes/no, `interrupt`
returns whatever JSON-cloneable value the supervisor injects.

## Author surface

```js
// 1. Free-form answer (string, object, anything JSON-cloneable).
const plan = await ctx.interrupt({
  question: "What should the rollout target look like?",
});

// 2. Multi-choice. The supervisor still picks the value (the choices
//    list is purely advisory metadata — useful for the TUI prompt).
const env = await ctx.interrupt({
  question: "Pick a deploy target",
  choices: ["staging", "prod", "abort"],
  default: "staging",
});

// 3. Shorthand: a bare string is treated as { question }.
const note = await ctx.interrupt("Add a release note?");
```

If no supervisor is wired (no `WorkflowClient` in the loop, no TUI), the
call resolves immediately with `opts.default ?? null`. This keeps unit
tests and headless runs unblocked.

## Supervisor surface

`WorkflowClient.resume(runId, value, opts?)` injects an answer:

```ts
import { WorkflowClient } from "@samfp/pi-workflows";

const client = new WorkflowClient();

// Resolve the FIFO-oldest pending interrupt.
await client.resume("wf-abc123", { approved: true, version: "v2" });

// Or target a specific call site by key.
await client.resume("wf-abc123", "ship-it", { key: "int-3" });
```

Under the hood `resume` writes one line to `<runDir>/ctrl.jsonl`:

```json
{ "type": "resume-interrupt", "at": "...", "value": "ship-it", "key": "int-3" }
```

The run's ctrl-file watcher (`startCtrlWatcher`) picks the line up via
`fs.watch` — with a 1s mtime poll backstop on filesystems where events
are unreliable (Docker, NFS) — and dispatches it to
`Run.respondInterrupt(value, key?)`. The same method is exposed for
in-process callers (TUI overlay, tests).

## On-disk protocol

Every interrupt round-trip writes two ledger entries:

```json
{ "type": "interrupt_requested", "at": "...", "key": "int-0",
  "question": "Pick a deploy target", "choices": ["staging","prod"], "default": "staging" }
{ "type": "interrupt_resolved",  "at": "...", "key": "int-0",
  "value": "prod", "source": "ipc" }
```

`source` distinguishes:

- `"ipc"` — supervisor injected via `ctrl.jsonl` / `respondInterrupt`.
- `"default"` — no supervisor wired; `opts.default` was used.
- `"replay"` — resumed run found a prior `interrupt_resolved` for this
  `key` and skipped the prompt entirely.

## Replay-perfect HITL across pi restart

Keys are deterministic. The Nth `ctx.interrupt(...)` call in a run gets
key `int-N` (`int-0`, `int-1`, ...). When the workflow re-executes after a
`/workflows resume <runId>`:

1. `resumeRun` walks the ledger and collects every
   `interrupt_resolved` entry into a `Map<key, value>`.
2. The map is threaded into `RunCtxHostOptions.replayResolvedInterrupts`.
3. Each `ctx.interrupt(...)` call checks the map BEFORE writing a new
   request entry. On a hit it returns the stored value immediately and
   appends a fresh `interrupt_resolved` with `source: "replay"` so the
   new ledger is self-contained (a downstream resume of THIS run also
   short-circuits without walking the prior ledger).
4. Misses fall through to the live `waitForInterrupt` path — meaning a
   crash mid-prompt resumes the workflow at the prompt, ready to receive
   a fresh `WorkflowClient.resume(...)` answer.

The Nth-call key is the load-bearing invariant: as long as a workflow's
control flow is deterministic up to the interrupt, replay always lines
up. Non-deterministic branches (random ids, wall-clock comparisons)
that change *which* call site executes the Nth interrupt will see the
prior answer for the wrong question — that's a workflow-author hazard,
documented here, mitigated in practice by the existing cache-key
guidance (avoid wall-clock + RNG, use `cacheKeyExtra`).

## Concurrency model

`Run` maintains a FIFO queue of pending interrupts in-memory.
`respondInterrupt(value)` (no key) resolves the oldest entry; with a
key it targets the matching one. Mismatches are silent — the
`ctrl.jsonl` line is fire-and-forget; the durable receipt is the
`interrupt_resolved` ledger entry.

A run-level `cancel`/`stop` aborts all pending interrupts via the same
`AbortSignal` listener wiring used by `ctx.gate`. The pending queue is
removed-from on settlement so a stale resolver can never fire after
abort.

## Validation

`ctx.interrupt(opts)` argument shape is parsed at the host boundary
(`parseInterruptOpts` in `src/runtime/runCtx.ts`):

- `opts` may be a plain string (treated as `{ question }`) or an object.
- `opts.question` must be a non-empty string.
- `opts.choices`, when present, must be an array of strings.
- `opts.default` is JSON-clone-validated at the host boundary (cycles
  and realm-leaks fail here, not on disk).

Invalid input fails the call envelope (`{ ok: false, error }`) without
writing to the ledger. The supervisor's `WorkflowClient.resume(value)`
applies the same JSON-clone defense to the injected `value`.

## Test coverage

- `tests/unit/interrupt.test.ts` — 18 tests covering basic resolution,
  sequential keying, default fallback, abort, ledger entries, overlay
  events, replay short-circuit, validation, and the end-to-end
  `WorkflowClient.resume` → `ctrl.jsonl` → `respondInterrupt` path.

Run the suite:

```sh
cd ~/Projects/pi-workflows
npx node --import tsx --test tests/unit/interrupt.test.ts
```

## Open follow-ups (deferred, non-blocking)

- ~~**TUI overlay surface.**~~ ✅ **Shipped** (zone-tui-hitl-fork).
  When `pi-workflows.interrupt.requested` fires, the overlay tracks the
  payload per-run, surfaces an enabled `i` bullet in the help line, and
  on press dispatches through `onInterruptAnswerRequested`. The
  production wiring (workflowCmd.ts) prompts via `ctx.ui.select` (when
  `choices` is set) or `ctx.ui.input` and posts the answer through
  `Run.respondInterrupt(value, key)`. End-to-end coverage:
  `tests/integration/hitlOverlayInterrupt.test.ts`.

- **Multiple concurrent interrupts in parallel phases.** The FIFO
  queue handles N pending interrupts but `WorkflowClient.resume`
  without a key targets the OLDEST. Authors who fan out interrupts in
  a parallel `ctx.phase(...)` should pass explicit keys (the
  `ctx.interrupt` ledger entry exposes them) to disambiguate. Open
  question: surface `ctx.interrupt(...)` returning the key alongside
  the value so authors can echo it. Deferred until a real workflow
  hits the case.

- **Schema validation on the resume value.** Today the supervisor can
  inject any JSON-cloneable value; if the workflow expects a specific
  shape, it must validate manually. A `schema` field on the request
  (mirroring `ctx.agent({ schema })`) would let the host validate the
  injection before resolving the call. Deferred — adds surface area
  with no proven need yet.
