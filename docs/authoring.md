# pi-workflows — Authoring Guide

This guide walks you through writing a workflow script from scratch, shows
common patterns, and points you to the full API reference.

---

## 1. What is a workflow?

A workflow is a plain `.js` file with a default export:

```js
// ~/.pi/agent/workflows/my-workflow.js
export default async function (ctx, input) {
  const [result] = await ctx.phase("main", [
    ctx.agent(`Answer this question: ${input}`),
  ]);
  return result.text;
}
```

When you type `/my-workflow <question>` in a pi session, pi:

1. Discovers `my-workflow.js`, computes its SHA-256.
2. Shows an approval prompt (once per file version).
3. Runs your function with `ctx` and `input`.
4. Streams progress to the TUI overlay (`w` to open).
5. Posts the return value to your chat on completion.

---

## 2. Discovery and naming

The workflow name is the filename without extension. `my-workflow.js` becomes
`/my-workflow`. Discovery order (first match wins):

1. `.pi/workflows/` relative to git root (project scope)
2. `~/.pi/agent/workflows/` (personal scope)
3. Built-in workflows shipped with pi-workflows (e.g. `/codebase-audit`)

---

## 3. The `ctx` object

Everything you need is on `ctx`. Key members:

| Member | What it does |
|---|---|
| `ctx.input` | The slash-command argument string |
| `ctx.run` | Run metadata (id, name, startedAt, cwd, resumed) |
| `ctx.signal` | AbortSignal — aborts on kill/stop/shutdown |
| `ctx.agent(prompt, opts?)` | Build an agent handle (lazy — doesn't spawn yet) |
| `ctx.phase(name, handles)` | Run handles in parallel, return results |
| `ctx.cache.*` | Run-scoped persistent cache |
| `ctx.log(msg)` | Emit to TUI overlay and ledger |
| `ctx.finishCallback(prompt)` | Post a message to chat on completion |
| `ctx.vote / consensus / parallel / retry / sleep` | Stdlib helpers |

Full reference: [`docs/runtime-api.md`](./runtime-api.md)

---

## 4. Common patterns

### Fan-out / fan-in

```js
export default async function (ctx, input) {
  const files = input.split(",").map(f => f.trim());

  // Fan out — one agent per file
  const results = await ctx.parallel(files, (file) =>
    ctx.agent(`Review ${file} for issues`, { id: `review-${file}` }),
  );

  // Fan in — one summariser
  const combined = results.map((r, i) => `## ${files[i]}\n${r.text}`).join("\n\n");
  const [summary] = await ctx.phase("summarise", [
    ctx.agent(`Synthesise these reviews into a final report:\n\n${combined}`),
  ]);
  return summary.text;
}
```

### Multi-round with cache

```js
export default async function (ctx, input) {
  const CACHE_KEY = `outline:${input}`;
  let outline = await ctx.cache.get(CACHE_KEY);

  if (!outline) {
    const [r] = await ctx.phase("outline", [ctx.agent(`Outline a blog post about: ${input}`)]);
    outline = r.text;
    await ctx.cache.set(CACHE_KEY, outline);
  }

  const sections = outline.split("\n").filter(l => l.startsWith("##"));
  const drafts = await ctx.parallel(sections, (section) =>
    ctx.agent(`Write the "${section}" section`, { id: `draft-${section}` }),
  );

  const fullDraft = drafts.map(r => r.text).join("\n\n");
  ctx.finishCallback(`Here's your blog post draft:\n\n${fullDraft}`);
}
```

### Retry unreliable steps

```js
export default async function (ctx, input) {
  const result = await ctx.retry(
    async () => {
      const [r] = await ctx.phase("extract", [
        ctx.agent(`Extract JSON from: ${input}. Respond with valid JSON only.`),
      ]);
      JSON.parse(r.text); // throws if invalid — triggers retry
      return r.text;
    },
    { maxAttempts: 3, backoffMs: 500 },
  );
  return result;
}
```

### Abort-aware loops

```js
export default async function (ctx, input) {
  const items = input.split("\n");
  const results = [];

  for (const item of items) {
    if (ctx.signal?.aborted) break;
    const [r] = await ctx.phase("process", [ctx.agent(`Process: ${item}`)]);
    results.push(r.text);
  }
  return results.join("\n");
}
```

---

## 5. Walking through `/codebase-audit`

The bundled workflow illustrates most patterns:

```
/codebase-audit src/
```

**Phase 1 — recon (1 agent):** asks pi to list the key architectural areas of the
given path. Returns structured JSON.

**Phase 2 — analyse (N agents, parallel):** one agent per area, each doing a
deep security/quality dive. Results cached by prompt hash + file hash.

**Phase 3 — vote (3 agents, parallel):** each voter ranks the findings by
severity via Borda count. A Borda-count aggregation in the workflow script combines the ranked lists (no judge agent — pure JS aggregation).

**Phase 4 — summarise (1 agent):** takes the top-N findings and writes the
final structured report.

See `examples/codebase-audit/codebase-audit.js` for the full source.

---

## 6. Testing your workflow

Use the `mockAgents: true` option (or `--mock-agents` flag on the CLI) to run
your workflow without spawning real pi subprocesses. Provide a `fixtures.jsonl`
file to control what each agent returns.

See [`docs/integration-testing.md`](./integration-testing.md) for the full
testing guide.

---

## 7. Parity gaps vs Claude Code

pi-workflows is intentionally close to Claude Code's dynamic workflows, but
with a few v1 limitations. See [`docs/parity-gaps.md`](./parity-gaps.md).

The key practical differences:

- Use `/workflow-name` not a `workflow` keyword
- No `/effort ultracode` modifier (v2)
- `crypto.subtle` not available (v2)
- Synchronous infinite loops wedge the event loop (no worker-thread interrupt)

---

## 8. Timeouts and rate limits

**Default timeout: 600 seconds (10 minutes) per agent.**

This is fine for quick summarisation tasks, but too short for agents that need
to read multiple large files and make edits. Always set `timeoutMs` explicitly
for complex agents:

```js
// For agents doing multi-file reads + edits (up to 30 min)
ctx.agent(`Fix this bug in src/runtime/foo.ts...`, { timeoutMs: 30 * 60 * 1000 })

// For quick summarisation (default is fine, but explicit is clearer)
ctx.agent(`Summarise this file`, { timeoutMs: 5 * 60 * 1000 })
```

**Rate limit and concurrency:** When a phase spawns many agents (>10), they all
compete for API capacity. Agents that queue behind rate-limited requests consume
their timeout budget while waiting. With 38 agents and a 600s timeout, agents
that don't get API capacity within 10 minutes are killed having done no work.

Mitigations:
- Set a generous `timeoutMs` on agents doing real work (≥ 20 min)
- Keep phase sizes reasonable (≤ 16 agents) — this matches the default `maxConcurrent`
- Use `failMode: 'null'` on large phases so timeouts don't kill the whole run

```js
// Large fan-out: failMode + generous timeout
const results = await ctx.phase("analyze", files.map(f =>
  ctx.agent(`Analyze ${f}`, { timeoutMs: 20 * 60 * 1000 })
), { failMode: "null" });
```
