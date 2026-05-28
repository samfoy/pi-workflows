# @samfp/pi-workflows

> Dynamic workflows for pi — sandboxed JS scripts that drive sub-agent fleets,
> with TUI inspection and resume across pi restarts. Pi-native sibling of
> Claude Code's "dynamic workflows" feature.

**Status:** in development. v0.1 cut targets explicit `/<workflowName>`
invocation, project + personal workflow discovery, sandboxed runtime, and
the bundled `/codebase-audit` workflow. See [`PRD.md`](./PRD.md) for the full
spec, [`plan.md`](./plan.md) for the implementation plan.

## Quick start (placeholder — fully wired in slice 18)

```bash
npm install -g @samfp/pi-workflows   # not yet published
mkdir -p ~/.pi/agent/workflows
cat > ~/.pi/agent/workflows/hello.js <<'EOF'
export default async function (ctx, input) {
  return `hello, ${input || "world"}!`;
}
EOF
pi
# in pi: /hello world
```

## What this slice delivers

This is **slice 1** in the build plan: the extension skeleton + workflow
discovery + slash-command stubs. Slash commands are registered but the
runtime is a stub — invoking `/<name>` returns
`"workflows runtime not yet wired in this slice"`.

Subsequent slices add: vm sandbox (slice 2), cache (3), semaphore (4),
JSON-stream parser (5), sub-agent dispatcher (6), ledger (7), `RunCtx` + the
`ctx.*` author API (8a–8b), approval flow (9), full slash handler (10),
resume (11), pause (12), TUI overlay (13–15), hot-reload (16), bundled
`/codebase-audit` (17), and docs/skills/publish (18).

## Disable knobs

| Knob | Effect |
|---|---|
| `PI_DISABLE_WORKFLOWS=1` env | Hard kill switch (wins over setting). |
| `pi-workflows.disabled: true` setting | User-managed knob (project + user `settings.json`). |
| `PI_WORKFLOWS_RECURSIVE=1` env | Set by future dispatcher; skips `registerCommand` for discovered files. |

## License

MIT.
