# pi-workflows — Runtime Author API Reference

Workflow scripts run inside a sandboxed `node:vm` Context. Every exported
symbol on this page is available as a method or property on the `ctx` object
passed to your `WorkflowMain` function.

```ts
export default async function (ctx: WorkflowContext, input: string) {
  // your workflow here
}
```

---

## `ctx.run` — Run metadata

**Type:** `RunMeta` (read-only, frozen at start)

```ts
interface RunMeta {
  readonly id: string;           // "wf-<12 hex chars>"
  readonly workflowName: string; // "codebase-audit"
  readonly startedAt: string;    // ISO-8601
  readonly cwd: string;          // working directory at invocation
  readonly resumed: boolean;     // true if this run was resumed from disk
}
```

**Example:**
```js
ctx.log(`Run ${ctx.run.id} started at ${ctx.run.startedAt}`);
```

---

## `ctx.input` — Slash-command argument

**Type:** `string`

The post-trim argument string from the slash command. Empty string if none provided.

```
/codebase-audit src/auth/
//→ ctx.input === "src/auth/"
```

---

## `ctx.signal` — Abort signal

**Type:** `AbortSignal | undefined`

Aborts when the user kills or pauses the run, or when pi shuts down. Always check
in long-running loops:

```js
for (const chunk of chunks) {
  if (ctx.signal?.aborted) break;
  await processChunk(chunk);
}
```

Pass to `ctx.sleep` to make delays cancellable:
```js
await ctx.sleep(5000, { signal: ctx.signal });
```

---

## `ctx.agent(prompt, opts?)` — Build an agent handle

**Signature:**
```ts
agent(prompt: string, opts?: AgentOpts): AgentHandle
```

Builds an agent handle. **Does not spawn** — `ctx.phase` does the spawning.

**`AgentOpts`:**
```ts
interface AgentOpts {
  id?: string;           // stable id for cache-key stability
  model?: string;        // e.g. "sonnet", "opus"
  thinking?: string;     // "on" | "off" | "auto"
  timeoutMs?: number;    // per-agent timeout
  cacheKeyExtra?: unknown; // additional cache key seed
  [extra: string]: unknown;
}
```

**Example:**
```js
const h = ctx.agent("List all TODO comments in this file", { id: "todos" });
```

**Cache key:** `sha256(prompt + JSON.stringify(cacheKeyExtra ?? ""))`. Stable
across runs if `id` and `prompt` are stable. Omitting `id` still works but
reduces reproducibility.

---

## `ctx.phase(name, handles)` — Run agents in parallel

**Signature:**
```ts
phase(name: string, agents: ReadonlyArray<AgentHandle>): Promise<ReadonlyArray<AgentResult>>
```

Runs all handles concurrently, bounded by the run semaphore (default cap 16).
Results are returned in the same order as `agents` (position-stable).

**`AgentResult`:**
```ts
interface AgentResult {
  readonly agentId: string;
  readonly text: string;           // agent's text response
  readonly usage: AgentUsage;      // token breakdown
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly transcriptPath: string; // path to .jsonl transcript on disk
  readonly cached: boolean;        // true if result replayed from cache
}
```

**Example:**
```js
const [analysis, review] = await ctx.phase("analyse+review", [
  ctx.agent("Analyse for security issues", { id: "sec" }),
  ctx.agent("Code review this PR", { id: "review" }),
]);
console.log(analysis.text, review.text);
```

**Notes:**
- Phase name is surfaced in the TUI overlay and ledger.
- A phase with zero handles resolves immediately to `[]`.
- `ctx.signal` abort mid-phase cancels queued (not yet started) agents; already-running agents run to completion unless their individual timeout fires.

---

## `ctx.cache.*` — Run-scoped key-value cache

All four methods are async. The cache is backed by `cache.jsonl` in the run
directory; it persists across resume. On cache hit, `ctx.phase` replays the
stored `AgentResult` without spawning a subprocess.

### `ctx.cache.get(key)`

**Signature:** `get(key: string): Promise<unknown>`

Returns the cached value or `undefined` if not found.

### `ctx.cache.set(key, value)`

**Signature:** `set(key: string, value: unknown): Promise<void>`

Writes a value. `value` must be JSON-serialisable. Overwrites any existing
entry for `key`.

### `ctx.cache.has(key)`

**Signature:** `has(key: string): Promise<boolean>`

### `ctx.cache.delete(key)`

**Signature:** `delete(key: string): Promise<void>`

Removes the entry. No-op if the key doesn't exist.

**Example — manual memoisation:**
```js
const CACHE_KEY = "expensive-result";
let result = await ctx.cache.get(CACHE_KEY);
if (!result) {
  const [agent] = await ctx.phase("compute", [ctx.agent("Do expensive thing")]);
  result = agent.text;
  await ctx.cache.set(CACHE_KEY, result);
}
```

---

## `ctx.log(message, opts?)` — Structured log

**Signature:**
```ts
log(message: string, opts?: { level?: "info" | "warn" | "error" }): void
```

Emits a log entry to the run's ledger and the TUI overlay log stream. Default
level is `"info"`.

```js
ctx.log("Starting analysis", { level: "info" });
ctx.log("Rate limit hit — retrying", { level: "warn" });
```

---

## `ctx.finishCallback(prompt)` — Post-completion prompt

**Signature:**
```ts
finishCallback(prompt: string): void
```

Registers a prompt string that pi sends to the user's active conversation
after the workflow completes. Useful for surfacing a summary or next steps.
Only the last `finishCallback` call wins.

```js
ctx.finishCallback(`Audit complete. Here are the top findings:\n\n${summary}`);
```

---

## `ctx.vote(agents, judge)` — Multi-agent vote

**Signature:**
```ts
vote(
  agents: ReadonlyArray<AgentHandle>,
  judge: (responses: ReadonlyArray<string>) => string | Promise<string>,
): Promise<VoteResult>
```

Runs all handles in a single phase, then calls `judge` with all response
texts. `judge` must return the winning text verbatim (or a transformed
version). For structured winner selection, spawn a judge agent inside `judge`:

```js
const { winner } = await ctx.vote(
  [
    ctx.agent("Approach A: ...", { id: "a" }),
    ctx.agent("Approach B: ...", { id: "b" }),
    ctx.agent("Approach C: ...", { id: "c" }),
  ],
  async (responses) => {
    const [judgeResult] = await ctx.phase("judge", [
      ctx.agent(`Pick the best approach:\n${responses.join("\n---\n")}`),
    ]);
    return judgeResult.text;
  },
);
```

**`VoteResult`:**
```ts
interface VoteResult {
  readonly winner: string;
  readonly responses: ReadonlyArray<string>;
}
```

---

## `ctx.consensus(agents, opts?)` — Agreement check

**Signature:**
```ts
consensus(
  agents: ReadonlyArray<AgentHandle>,
  opts?: ConsensusOpts,
): Promise<ConsensusResult>
```

Runs all handles, then measures pairwise Jaccard token-overlap. Returns
`agreed: true` if at least `threshold` fraction of pairs exceeded the
similarity floor.

**`ConsensusOpts`:**
```ts
interface ConsensusOpts {
  threshold?: number;    // fraction of pairs that must agree (default 0.5)
  similarity?: number;   // Jaccard floor per pair (default 0.6)
}
```

**`ConsensusResult`:**
```ts
interface ConsensusResult {
  readonly agreed: boolean;
  readonly majorityText: string; // highest mean similarity to all others
  readonly scores: ReadonlyArray<{ agentId: string; meanSimilarity: number }>;
}
```

**Note (v1 limitation):** Jaccard overlap is crude on technical/code text.
For semantic consensus, use `ctx.vote` with a judge agent.

---

## `ctx.parallel(items, fn, opts?)` — Map-phase

**Signature:**
```ts
parallel<T>(
  items: ReadonlyArray<T>,
  fn: (item: T, ctx: WorkflowContext) => AgentHandle | AgentHandle[],
  opts?: ParallelOpts,
): Promise<ReadonlyArray<AgentResult>>
```

Convenience over `ctx.phase`: maps each item to one or more handles, then
runs them all in a single phase. Results are flat — one `AgentResult` per
handle, in item order.

```js
const files = ["auth.ts", "api.ts", "db.ts"];
const results = await ctx.parallel(files, (file) =>
  ctx.agent(`Review ${file} for security issues`, { id: `review-${file}` }),
);
```

**`ParallelOpts`:**
```ts
interface ParallelOpts {
  phaseName?: string; // default: "parallel"
}
```

---

## `ctx.retry(fn, opts?)` — Retry with backoff

**Signature:**
```ts
retry<T>(fn: () => Promise<T> | T, opts?: RetryOpts): Promise<T>
```

Calls `fn()`. On rejection, waits `backoffMs * 2^attempt` and retries.
`AbortError` (from `ctx.signal`) short-circuits immediately — it is never
swallowed.

**`RetryOpts`:**
```ts
interface RetryOpts {
  maxAttempts?: number; // default 3
  backoffMs?: number;   // initial backoff in ms (default 500)
  signal?: AbortSignal; // additional abort signal (also checks ctx.signal)
}
```

```js
const result = await ctx.retry(
  () => fetchSomethingUnreliable(),
  { maxAttempts: 5, backoffMs: 1000 },
);
```

---

## `ctx.sleep(ms, opts?)` — Delay

**Signature:**
```ts
sleep(ms: number, opts?: SleepOpts): Promise<void>
```

Resolves after `ms` milliseconds. Aborts early if `opts.signal` or
`ctx.signal` fires. The abort listener is removed on natural resolution.

```js
await ctx.sleep(2000);                          // plain 2s delay
await ctx.sleep(2000, { signal: ctx.signal });  // cancellable
```

---

## Security model

Workflow scripts execute inside a `node:vm` Context. The sandbox:

- **Has:** `Buffer`, `URL`, `URLSearchParams`, `TextEncoder/Decoder`,
  `atob/btoa`, `crypto` (randomUUID/randomBytes/getRandomValues), frozen
  `process` stub (platform/arch/versions only), `setTimeout/setInterval/
  clearTimeout/clearInterval/setImmediate/clearImmediate/queueMicrotask`
  (host-side timer table — see [threat model](./threat-model.md)).
- **Does not have:** `require`, `import()`, `fs`, `net`, `child_process`,
  `process.env`, `process.exit`, `Worker`, `Atomics.wait`, `eval`
  (via `allowCodeGeneration: false`).
- **Constructor escape:** `Function.constructor("return process")` returns
  the **Context's** globalThis, not the host's — enforced by
  `allowCodeGeneration: false` + prototype freeze.
- **v2 deferred:** `crypto.subtle`, worker-thread interrupt on sync loops.

See [`docs/threat-model.md`](./threat-model.md) for the full escape-vector matrix.
