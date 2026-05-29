# pi-workflows skill

## What this skill covers

Authoring and running dynamic workflow scripts in pi via `@samfp/pi-workflows`.
Workflows are sandboxed JS files that drive multi-agent pipelines, with TUI
inspection and resume across pi restarts.

Load this skill when the user asks to:
- Write a workflow script
- Run `/codebase-audit` or another workflow
- Understand why a workflow failed or stalled
- Debug the workflows TUI overlay
- Test a workflow with mock agents

---

## How to invoke a workflow

```
/<workflow-name> [argument]
```

Examples:
```
/codebase-audit src/auth/
/summarize paste your text here
/my-pipeline
```

pi discovers workflow files from:
1. `.pi/workflows/` (git root — project scope)
2. `~/.pi/agent/workflows/` (personal scope)
3. Built-in workflows shipped with pi-workflows

On first run pi shows an approval prompt with the file SHA-256 and first 40 lines.

---

## Writing a workflow

A workflow is a `.js` file with a default export:

```js
// ~/.pi/agent/workflows/my-workflow.js
export default async function (ctx, input) {
  const [result] = await ctx.phase("main", [
    ctx.agent(`Answer: ${input}`, { id: "answer" }),
  ]);
  return result.text;
}
```

Key `ctx` API:

| Call | What it does |
|---|---|
| `ctx.agent(prompt, { id })` | Build an agent handle (no spawn yet) |
| `ctx.phase("name", handles)` | Run handles in parallel, return results |
| `ctx.parallel(items, fn)` | Map items to handles and run in one phase |
| `ctx.vote(agents, judge)` | Fan-out vote with a judge function |
| `ctx.retry(fn, opts)` | Retry with exponential backoff |
| `ctx.sleep(ms)` | Delay (respects `ctx.signal`) |
| `ctx.cache.get/set/has/delete` | Run-scoped persistent cache |
| `ctx.log(msg)` | Log to TUI overlay and ledger |
| `ctx.finishCallback(prompt)` | Post a message to chat on completion |
| `ctx.signal` | AbortSignal — fires on kill/stop |
| `ctx.input` | Slash-command argument string |
| `ctx.run` | Run metadata (id, name, startedAt, cwd, resumed) |

Full reference: `docs/runtime-api.md` in the package.

---

## Security sandbox

Workflow scripts run inside `node:vm` with `allowCodeGeneration: false`.
No access to `fs`, `net`, `child_process`, `process.env`, `require`, or `import()`.
The `process` global is a frozen stub (platform/arch/versions only).
For file/shell operations, use `ctx.agent` with a pi tool call.

---

## TUI overlay

Open with `w` from any pi session while a workflow is running:

| Key | Action |
|---|---|
| `↑`/`↓` | Select run |
| `Enter` | Drill into phase view, then agent detail |
| `o` | Open agent transcript |
| `p` | Pause / resume |
| `k` | Kill |
| `r` | Restart (terminal runs only) |
| `s` | Save script to project workflows dir |
| `g` | GC old terminal runs |
| `Esc` | Back / close |

---

## `/codebase-audit [path]`

4-phase workflow:
1. **recon** — list key areas + files
2. **analyse** — parallel deep-dive per area (cached by prompt + file hash)
3. **vote** — 3-agent Borda-count ranking
4. **summarise** — final structured report

Cache: analyse results cache-hit on re-run if files unchanged.
Typical output: Critical / High / Medium findings with file:line citations.

---

## Testing a workflow with mock agents

```ts
import { runWorkflow } from "@samfp/pi-workflows/testing";

const result = await runWorkflow({
  workflowPath: "./my-workflow.js",
  input: "test input",
  mockAgents: true,
  seedFixturesJsonl: JSON.stringify({
    agentId: "answer",
    promptHash: sha256(`Answer: test input`),
    result: { text: "42", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } },
  }),
});
assert.equal(result.output, "42");
```

See `docs/integration-testing.md` for the full guide including cache assertions
and phase structure tests.

---

## Useful slash commands

```
/workflows list         # list active + recent runs
/workflows status <id>  # status of a specific run
/workflows resume <id>  # re-attach to a completed run
/workflows kill <id>    # kill a running workflow
/workflows gc           # garbage-collect old terminal runs
```

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Trust check failed` | SHA-256 changed (file edited) | Re-approve with `y` |
| Phase hangs forever | Agent timeout not set; check `opts.timeoutMs` | Add `timeoutMs` to `ctx.agent` opts |
| `Cannot find workflow` | File not in a discovered directory | Move to `~/.pi/agent/workflows/` or `.pi/workflows/` |
| `ReferenceError: require is not defined` | Workflow uses Node built-in | Use `ctx.agent` to delegate file/shell ops |
| `AbortError` mid-run | User pressed `k` or pi shut down | Check `ctx.signal?.aborted` in loops |
| TUI overlay shows `[remote]` | Run started in a different pi session | Kill/manage via `/workflows` commands |

---

## Parity gaps vs Claude Code (v1)

- Use `/workflow-name` not a `workflow` keyword
- No `/effort ultracode` modifier (v2)
- `crypto.subtle` not available (v2)
- Synchronous infinite loops wedge the event loop
- `acceptEdits` not supported — inherits parent allowlist

Full list: `docs/parity-gaps.md` in the package.
