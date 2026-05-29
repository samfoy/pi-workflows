# /codebase-audit

Bundled reference workflow for pi-workflows. A phased code audit that fans out over your repo's module boundaries.

## Usage

```
/codebase-audit              # audit cwd
/codebase-audit ./src        # audit a specific subtree
```

## What it does

| Phase | Agents | What happens |
|-------|--------|--------------|
| `recon` | 1 | Surveys the repo; identifies 5–8 module/area boundaries |
| `analyze` | N (one per area) | Each agent audits one area for bugs, dead code, tech debt, security smells |
| `vote` | 3 judges | Each judge rank-orders all findings; aggregated via Borda count → top 10 |
| `summarize` | 1 | Writes a 1-page report from the top 10 findings |

## Output shape

```json
{
  "runId": "wf-abc123...",
  "cwd": "/your/repo",
  "findingsConsidered": 34,
  "top10": [{ "title": "...", "severity": "high", "path": "src/auth.ts", "detail": "..." }],
  "report": "## Audit Report\n..."
}
```

## What this example demonstrates

- `ctx.phase()` — fan-out to N agents and await all results
- `ctx.agent()` with `cacheKeyExtra` — stable cache across script edits
- `ctx.cache.set/get` — save intermediate state for inspection/resume
- `ctx.log()` — structured progress logging
- `inheritSkills: true` — sub-agents inherit the parent's skill set
- Manual Borda aggregation vs `ctx.vote()` — use the explicit loop when you need ranked top-N from M voters; use `ctx.vote()` for single-winner judging

## Caching

The `analyze` agents use `cacheKeyExtra: { area: area.area }` so their results
are stable across script re-edits (as long as the area boundaries don't change).
`recon` and the `vote`/`summarize` agents are never cached — their prompts
include findings JSON that changes every run.
