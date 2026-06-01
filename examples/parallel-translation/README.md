# /parallel-translation

Demonstrates parallel agent fan-out and `ctx.vote()` for single-winner judging.

## Usage

```
/parallel-translation "The quick brown fox jumps over the lazy dog."
```

## What it does

| Phase | Agents | What happens |
|-------|--------|--------------|
| `translate` | 4 (one per language) | Translates input into French, German, Spanish, Japanese |
| `vote` (internal to `ctx.vote`) | 4 back-translators | Each translation is back-translated to English |
| `vote-judge` | 1 judge agent | LLM picks the best back-translation by index; `ctx.vote` returns it as `winner` |

Total: 9 agent calls.

## Output shape

```json
{
  "input": "original text",
  "translations": { "French": "...", "German": "...", "Spanish": "...", "Japanese": "..." },
  "bestLanguage": "German",
  "backTranslation": "the best back-translation text"
}
```

## What it demonstrates

- Parallel agents in a phase (fan-out)
- `ctx.vote(agents, judge)` — the stdlib helper for single-winner selection among N candidates. The judge is a function `(responses: string[]) => string | Promise<string>` that returns the winning string. Async judges may delegate to another LLM agent via `ctx.phase` (as this example does for `vote-judge`).
- `cacheKeyExtra` — stable cache per (language, input) pair on the translator agents
- Contrast with the manual Borda loop in `/codebase-audit`, which is better for ranked top-N
