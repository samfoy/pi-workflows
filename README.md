# @samfp/pi-workflows

> Dynamic workflows for pi — sandboxed JS scripts that drive sub-agent fleets,
> with TUI inspection and resume across pi restarts. Pi-native sibling of
> [Claude Code's dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Quick start

```bash
# Install
npm install -g @samfp/pi-workflows

# Write a workflow
mkdir -p ~/.pi/agent/workflows
cat > ~/.pi/agent/workflows/summarize.js <<'EOF'
export default async function (ctx, input) {
  const [summary] = await ctx.phase("summarize", [
    ctx.agent(`Summarize this in 3 bullet points:\n\n${input}`),
  ]);
  return summary.text;
}
EOF

# Invoke it inside a pi session
/summarize <paste your text here>
```

That's it. pi discovers `summarize.js` from `~/.pi/agent/workflows/`, shows an approval prompt, then streams the run in the TUI.

## Installation

```bash
# Global (adds all bundled workflows to every pi session)
npm install -g @samfp/pi-workflows

# Project-local (adds to project scope only)
npm install --save-dev @samfp/pi-workflows
```

pi loads the extension on startup if it detects the `"pi.extensions"` field in `package.json` (global: auto; project: add `"@samfp/pi-workflows"` to `.pi/extensions.json` or use `npm install`).

## Writing workflow files

A workflow file is a plain `.js` (or `.mjs`) file with a default export:

```js
// ~/.pi/agent/workflows/my-workflow.js
export default async function (ctx, input) {
  // 1. Build agent handles (no spawn yet)
  const handles = [
    ctx.agent("Analyse the code for security issues", { id: "security" }),
    ctx.agent("Analyse the code for performance issues", { id: "perf" }),
  ];

  // 2. Run them in parallel (bounded by semaphore, default cap 16)
  const [security, perf] = await ctx.phase("analyse", handles);

  // 3. Vote on which finding is most critical
  const { winner } = await ctx.vote(
    [ctx.agent(`Security: ${security.text}\n\nPerf: ${perf.text}\n\nWhich is more critical?`)],
    (responses) => responses[0],
  );

  return winner;
}
```

### Invocation

Inside a pi session, type `/<workflow-name>` optionally followed by an argument string:

```
/my-workflow src/auth/
/codebase-audit src/
/summarize paste your text here
```

### Discovery order

1. **Project** — `.pi/workflows/*.js` (relative to git root)
2. **Personal** — `~/.pi/agent/workflows/*.js`
3. **Bundled** — workflows shipped with this package (currently: `codebase-audit`)

If names collide, project-level wins over personal, which wins over bundled.

### Approval flow

On first use of a workflow, pi computes its SHA-256, shows you the first 40 lines, and asks:

```
Allow /codebase-audit from ~/.pi/agent/workflows/codebase-audit.js? [y/N/always]
```

`always` saves a `{workflowName, sha256}` trust record in `.pi/workflows/trust.json` (project) or `~/.pi/agent/settings.json` (personal). If the file changes, pi re-prompts.

### Disabling workflows

To disable pi-workflows entirely in a project: add `"pi-workflows": { "enabled": false }` to `.pi/config.json`.

---

## Bundled workflow: `/codebase-audit`

Multi-agent static analysis of a directory (or the entire repo).

```
/codebase-audit [path]
```

**What it does:**

1. **Recon** (1 agent) — enumerates key areas and their files.
2. **Analyse** (1 agent per area, parallel) — deep-dives each area for issues.
3. **Vote** (3 agents, parallel) — Borda-count ranking of the findings.
4. **Summarise** (1 agent) — produces the final structured report.

**Example output shape:**

```
## Codebase Audit: src/

### Critical
- [auth/session.ts:42] Session token not rotated on privilege escalation

### High
- [api/upload.ts:88] No size limit on multipart uploads

### Medium
- [utils/retry.ts:14] Exponential backoff missing jitter — thundering-herd risk

---
Audited 4 phases · 7 agents · 1 cache hit · 12.4s
```

**Cache:** analyse results are cached by (promptHash + file content hash). Re-running against an unchanged codebase replays cached results.

---

## Runtime author API

Full reference: [`docs/runtime-api.md`](./docs/runtime-api.md)

| Symbol | Type | Description |
|---|---|---|
| `ctx.run` | `RunMeta` | Run metadata — id, workflowName, startedAt, cwd, resumed |
| `ctx.input` | `string` | Slash-command argument string |
| `ctx.signal` | `AbortSignal \| undefined` | Aborts on stop/kill/shutdown |
| `ctx.agent(prompt, opts?)` | `→ AgentHandle` | Build an agent handle (does not spawn) |
| `ctx.phase(name, handles)` | `→ Promise<AgentResult[]>` | Run handles in parallel, bounded by semaphore |
| `ctx.cache.get(key)` | `→ Promise<unknown>` | Read from run-scoped cache |
| `ctx.cache.set(key, val)` | `→ Promise<void>` | Write to run-scoped cache |
| `ctx.cache.has(key)` | `→ Promise<boolean>` | Cache key presence check |
| `ctx.cache.delete(key)` | `→ Promise<void>` | Evict a cache entry |
| `ctx.log(msg, opts?)` | `void` | Structured log — surfaced in TUI overlay |
| `ctx.finishCallback(prompt)` | `void` | Register a prompt to run after the workflow completes |
| `ctx.vote(agents, judge)` | `→ Promise<VoteResult>` | Multi-agent vote with a judge function |
| `ctx.consensus(agents, opts?)` | `→ Promise<ConsensusResult>` | Jaccard-similarity consensus check |
| `ctx.parallel(items, fn, opts?)` | `→ Promise<AgentResult[]>` | Map items to handles and run in one phase |
| `ctx.retry(fn, opts?)` | `→ Promise<T>` | Retry with exponential backoff |
| `ctx.sleep(ms, opts?)` | `→ Promise<void>` | Delay, honoring `ctx.signal` |

### Security model

Workflow scripts run inside a sandboxed `node:vm` Context. There is **no direct access** to `fs`, `net`, `child_process`, `process.env`, or any Node built-in not explicitly allowed. The sandbox exposes: `Buffer`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `crypto` (randomUUID/randomBytes/getRandomValues only), frozen `process` stub (platform/arch/versions — no env, no exit). `crypto.subtle` is deferred to v2 (see [parity gaps](./docs/parity-gaps.md)).

---

## TUI overlay

While a workflow is running, press `w` to open the workflows overlay:

| Key | Action |
|---|---|
| `↑` / `↓` | Select run |
| `Enter` | Drill into phase view |
| `Enter` (on phase) | Drill into agent detail |
| `o` | Open agent transcript in editor |
| `p` | Pause / resume |
| `k` | Kill |
| `r` | Restart (on terminal runs) |
| `s` | Save script to project workflows dir |
| `g` | GC — garbage-collect old terminal runs |
| `Esc` | Back / close overlay |

Runs survive pi restart. Use `/workflows resume <runId>` to re-attach to a completed run.

---

## Parity gaps vs Claude Code

See [`docs/parity-gaps.md`](./docs/parity-gaps.md) for the full list. Key v1 gaps:

- No `workflow` keyword trigger (requires `/` slash command)
- No `/effort ultracode` modifier
- `crypto.subtle` deferred to v2
- Synchronous infinite loop wedges the event loop (no worker-thread interrupt)
- `acceptEdits` permission elevation not supported — inherits parent allowlist

---

## Manual smoke test

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full manual smoke procedure (§12.8).

---

## Docs

- [`docs/runtime-api.md`](./docs/runtime-api.md) — full author API reference
- [`docs/authoring.md`](./docs/authoring.md) — authoring guide with patterns
- [`docs/integration-testing.md`](./docs/integration-testing.md) — mock-agents + fixtures
- [`docs/parity-gaps.md`](./docs/parity-gaps.md) — CC parity gap tracker
- [`docs/threat-model.md`](./docs/threat-model.md) — sandbox security model
- [`PRD.md`](./PRD.md) — product requirements (internal)
