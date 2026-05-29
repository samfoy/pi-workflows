# Phase view + restart + save script (slice 14)

The `/workflows` overlay (mounted by slice 13) gains three new
flows in slice 14:

## Phase view (PRD §10.3)

Hit **Enter** on a runs-list row to drill into the **phase view**:

```
wf-9f3a2c8e  codebase-audit  running  3m 12s
Started: 1m ago   Path: ./.pi/workflows/runs/wf-9f3a2c8e

Phases
✓ recon          1 agent   12s
▸ analyze        4/7 agents done, 3 running   1m 22s elapsed
    ● analyze-0   running  18s    auth-utils
    ○ analyze-1   queued   —      api-handlers
    ✓ analyze-4   done     45s    config        (cached)
· vote           pending
· summarize      pending

Log (last 5)
  14:32:11  phase analyze starting (7 agents)
  14:33:11  agent analyze-4 cache hit
```

Phase rows render with progress glyphs (`✓` done, `▸` active,
`·` pending). Agent rows are shown only inside the active phase
to keep wireframe density manageable on many-phase runs. Updates
are debounced at 30ms via the appendEntry feed
(`pi-workflows.{phase,agent}.{started,ended}`).

**Esc** returns to the runs list.

## Restart (`r`) — PRD §10.4.1

`r` overloads to two operations based on the selected run's state:

| State                                       | Effect                          |
| ------------------------------------------- | ------------------------------- |
| `paused`                                    | **Resume** — same `runId`, same cache |
| `done` / `failed` / `stopped` / `cancelled` | **Restart** — NEW `runId`, fresh cache, lineage in manifest |
| `running` / `pending` / `approved`          | Disabled                        |

The new run's `manifest.json` carries `restartedFrom: <prior runId>`
for audit. The old run dir is preserved untouched.

## Save script (`s`) — PRD §10.7

`s` on a terminal run copies the frozen `<runDir>/script.js` to the
project's `.pi/workflows/<workflowName>.js`:

1. Walk up from `cwd` looking for `.git/` or `.pi/` (max 8 levels —
   PRD §15.C). If neither found, abort with "no project root".
2. If the source workflow already lives inside the project's
   `.pi/workflows/`, it's a no-op (already saved).
3. On filename collision, prompt: **overwrite / rename / cancel**.
   Rename picks `<name>-saved.js` (then `<name>-saved-2.js`, …).
4. Copy with mode `0o644`.
5. If `.git` is present, prompt `Add to git? (y/n)`. On `y`, run
   `git add <relPath>`.
6. If `.gitignore` ignores `.pi/`, warn that the saved file won't
   be tracked.

## Remote-run badge (concern U3)

Runs in the runs-list that this process does NOT hold a live `Run`
handle for (e.g. cross-process runs visible via the appendEntry
feed) get a `[remote]` badge. Hotkeys on remote runs:

- `x` (kill) and `p` (pause/resume) emit cross-process intent
  appendEntry events. The owning process picks them up.
- `r` (restart) and `s` (save) typically only operate on local
  runs; consult slice 14 manifest for the cross-process design.
