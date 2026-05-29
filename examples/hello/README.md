# /hello

Minimal "hello world" pi workflow. One phase, one agent.

## Usage

```
/hello              # greets "world"
/hello Alice        # greets "Alice"
```

## What it demonstrates

- The minimal workflow shape: `export default async function main(ctx, input)`
- `ctx.phase()` with a single agent
- Returning a plain object as the workflow result
