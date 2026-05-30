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
  schema?: Record<string, unknown>; // JSON Schema for structured output
  [extra: string]: unknown;
}
```

**`schema`:** JSON Schema for structured output. When provided, the agent
returns parsed JSON in `result.output`. The schema is injected into the
agent's system prompt as a constraint. Example:

```js
const [h] = await ctx.phase("extract", [
  ctx.agent("List the top 3 issues found", {
    id: "issues",
    schema: {
      type: "object",
      properties: { issues: { type: "array", items: { type: "string" } } },
      required: ["issues"],
    },
  }),
]);
const { issues } = h.output; // typed parsed object
```

**Cache key:** `sha256(prompt + JSON.stringify(cacheKeyExtra ?? ""))`. Stable
across runs if `id` and `prompt` are stable. Omitting `id` still works but
reduces reproducibility.

---

## `ctx.phase(name, handles, opts?)` — Run agents in parallel

**Signature:**
```ts
phase(
  name: string,
  agents: ReadonlyArray<AgentHandle>,
  opts?: PhaseOpts,
): Promise<ReadonlyArray<AgentResult | null>>
```

Runs all handles concurrently, bounded by the run semaphore (default cap 16).
Results are returned in the same order as `agents` (position-stable).

**`PhaseOpts`:**
```ts
interface PhaseOpts {
  /**
   * How to handle agent failures.
   * `'throw'` (default): any failure rejects with AggregateError.
   * `'null'`: failed agents return null; the phase resolves with partial results.
   */
  failMode?: 'throw' | 'null';
}
```

With `failMode: 'null'`, elements in the result array are `AgentResult | null`.
Filter out nulls to work only with successful agents.

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
  readonly output?: unknown;        // parsed JSON object — set when opts.schema was provided to ctx.agent()
}
```

**Example — default (throw on failure):**
```js
const [analysis, review] = await ctx.phase("analyse+review", [
  ctx.agent("Analyse for security issues", { id: "sec" }),
  ctx.agent("Code review this PR", { id: "review" }),
]);
console.log(analysis.text, review.text);
```

**Example — `failMode: 'null'` (continue on partial failure):**
```js
const results = await ctx.phase("batch", handles, { failMode: 'null' });
const succeeded = results.filter(r => r !== null);
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
  threshold?: number; // default 0.6
}
```

`threshold` controls **both** the per-pair Jaccard similarity floor and the pair-fraction agreement check. A pair counts as "agreeing" if its Jaccard score ≥ `threshold`, and the overall result is `agreed: true` if the fraction of agreeing pairs ≥ `threshold`.

**`ConsensusResult`:**
```ts
interface ConsensusResult {
  readonly agreed: boolean;
  readonly majorityText: string;          // response with highest mean similarity
  readonly responses: ReadonlyArray<string>;
}
```

**Note (v1 limitation):** Jaccard overlap is crude on technical/code text.
For semantic consensus, use `ctx.vote` with a judge agent.

---

## `ctx.budget` — Token budget tracker

**Type:** read-only object (frozen)

```ts
{
  total: number | null;  // configured budget, or null if uncapped
  spent(): number;       // tokens consumed so far (sum of agent totalTokens)
  remaining(): number;   // remaining tokens, or Infinity when total is null
}
```

Updated after each agent completes. Use before launching expensive phases to
avoid blowing past a budget.

**Example — gating an expensive phase:**
```js
ctx.log(`tokens spent so far: ${ctx.budget.spent()}`);
if (ctx.budget.remaining() < 50_000) {
  ctx.log("Budget nearly exhausted — skipping deep analysis", { level: "warn" });
} else {
  const results = await ctx.phase("deep-analysis", handles);
}
```

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

## `ctx.pipeline(items, ...stages)` — Sequential stages, concurrent items

**Signature:**
```ts
pipeline<T, R>(
  items: T[],
  ...stages: Array<(prev: unknown, originalItem: T, index: number) => unknown>,
): Promise<R[]>
```

Runs items through sequential stages. Items are processed concurrently;
stages within a single item are sequential. If a stage returns an
`AgentHandle`, it is automatically executed via a single-agent phase —
the resolved `AgentResult` is passed to the next stage.

**Stage callback signature:**
```ts
(prevResult: unknown, originalItem: T, index: number) => unknown
// prevResult — result from the previous stage (or the raw item for stage 0)
// originalItem — the original item from the input array (unchanged)
// index — position in items[]
// return: any value, a Promise, or an AgentHandle (auto-dispatched)
```

**Example:**
```js
const files = ["src/auth.ts", "src/db.ts", "src/api.ts"];
const reports = await ctx.pipeline(
  files,
  // Stage 0: read the file (agent auto-dispatched)
  (file) => ctx.agent(`Read and summarise ${file}`, { id: `read-${file}` }),
  // Stage 1: fix issues found in stage 0 (AgentResult passed as prevResult)
  (readResult, file) => ctx.agent(
    `Fix issues in ${file} based on: ${readResult.text}`,
    { id: `fix-${file}` },
  ),
);
// reports[i].text = fix-agent response for files[i]
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
  attempts?: number;    // default 3
  backoffMs?: number;   // initial backoff in ms (default 100)
  signal?: AbortSignal; // additional abort signal (also checks ctx.signal)
}
```

```js
const result = await ctx.retry(
  () => fetchSomethingUnreliable(),
  { attempts: 5, backoffMs: 1000 },
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

## `ctx.memo(key, fn, opts?)` — Cross-run memoization

**Signature:**
```ts
memo<T = unknown>(
  key: string,
  fn: () => Promise<T>,
  opts?: { ttl?: number; scope?: 'global' | 'project' }
): Promise<T>
```

Runs `fn()` on the first call for `key` and stores the result in a
persistent JSONL file outside the run directory. Subsequent calls within
the TTL window return the cached value without running `fn`.

Use this for expensive operations that should not repeat across workflow
runs — codebase audits, dependency graphs, network lookups.

**`opts`:**
| Field | Default | Notes |
|-------|---------|-------|
| `ttl` | `86400000` (24 h) | TTL in milliseconds. |
| `scope` | `'global'` | `'global'` — shared across all projects. `'project'` — scoped to `ctx.run.cwd`. |

**Storage paths:**
- `global` → `~/.pi/agent/memos/global/memo.jsonl`
- `project` → `~/.pi/agent/memos/projects/<sha256(cwd)>/memo.jsonl`

Format: append-only JSONL, same atomic-write + compaction semantics as
`cache.jsonl`. Compaction fires at 500 entries and drops expired records.

```js
// Expensive codebase audit — redo at most once per day.
const modules = await ctx.memo(
  'codebase-modules-v1',
  async () => {
    const [result] = await ctx.phase('audit', [
      ctx.agent('List all modules in this codebase', { id: 'auditor' }),
    ]);
    return result.text;
  },
  { ttl: 24 * 60 * 60 * 1000, scope: 'project' },
);

// Short-TTL cache (1 hour), global scope.
const meta = await ctx.memo(
  'package-meta',
  async () => fetchPackageMeta(),
  { ttl: 60 * 60 * 1000 },
);
```

**Notes:**
- `fn` runs inside the sandbox. The *result* is what's stored, not the
  function source.
- The value must be JSON-serializable. Non-serializable returns throw a
  `TypeError` before writing to disk.
- `key` is sha256'd internally — you can use any human-readable string.
- Expired entries are evicted lazily (at read time). Compaction removes
  them at 500 appends.

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
