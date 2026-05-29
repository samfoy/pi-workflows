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
| `back-translate` | 4 | Each translation is back-translated to English |
| vote judgment | 1 judge | `ctx.vote()` picks the back-translation closest to the original |

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
- `ctx.vote()` — the stdlib helper for single-winner selection among N candidates
- `cacheKeyExtra` — stable cache per (language, input) pair
- Contrast with the manual Borda loop in `/codebase-audit`, which is better for ranked top-N
