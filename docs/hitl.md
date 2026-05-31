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
//    ctx.interrupt returns { key, value } so authors can disambiguate
//    concurrent interrupts — destructure or capture .key as needed.
const { value: plan } = await ctx.interrupt({
  question: "What should the rollout target look like?",
});

// 2. Multi-choice. The supervisor still picks the value (the choices
//    list is purely advisory metadata — useful for the TUI prompt).
const { value: env } = await ctx.interrupt({
  question: "Pick a deploy target",
  choices: ["staging", "prod", "abort"],
  default: "staging",
});

// 3. Schema validation on the resume value (gap follow-up #3).
const { value: cfg } = await ctx.interrupt({
  question: "Settings?",
  schema: {
    type: "object",
    required: ["approved"],
    properties: { approved: { type: "boolean" } },
  },
});
// If the supervisor's payload doesn't match the schema, the call
// throws InterruptValueValidationError to the workflow author. The
// supervisor sees the original prompt — they don't know the schema.

// 4. Concurrent interrupts — capture each key for explicit routing.
const [a, b] = await Promise.all([
  ctx.interrupt({ question: "Region A?" }),
  ctx.interrupt({ question: "Region B?" }),
]);
// a.key === "int-0", b.key === "int-1". Pass the key when answering:
//   await client.resume(runId, "...", { key: a.key });

// 5. Shorthand: a bare string is treated as { question }.
const { value: note } = await ctx.interrupt("Add a release note?");
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
- `opts.schema`, when present, must be a plain JSON-Schema-shaped
  object. After the supervisor's value is JSON-cloned, the host runs
  it through the same `validateAgainstSchema` validator used by
  `ctx.agent({schema})`. On mismatch the workflow's awaiter throws
  `InterruptValueValidationError` (with `key`, `path`, `expected`,
  `actual`) — the supervisor sees no error since the supervisor never
  sees the schema in the first place. The mismatched value is still
  ledgered as `interrupt_resolved` so a future replay sees what the
  supervisor sent.

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

- **Multiple concurrent interrupts in parallel phases.** ✅ **Shipped**
  (polish-memory-hitl). `ctx.interrupt(...)` now returns `{ key, value }`
  so authors fanning interrupts out across parallel agents can capture
  each call site's key and pass it to `WorkflowClient.resume(runId,
  value, { key })` for explicit disambiguation. Sequential callers can
  destructure or ignore the wrapping. Tests:
  `tests/unit/interrupt.test.ts — "concurrent interrupts: explicit
  key on resume targets the right pending"` and the existing key-N
  determinism + replay tests still cover the no-disambiguation case.

- **Schema validation on the resume value.** ✅ **Shipped**
  (polish-memory-hitl). `ctx.interrupt({ schema })` runs the
  supervisor's payload through `validateAgainstSchema` post-clone; on
  mismatch the workflow author sees a typed
  `InterruptValueValidationError` and the supervisor sees only their
  original prompt. Test: `tests/unit/interrupt.test.ts — "schema:
  resume value mismatches → InterruptValueValidationError"`.
