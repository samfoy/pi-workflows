# Workflow Supervision via File-Based IPC

pi-workflows exposes a file-based IPC surface that lets a supervisor pi
agent observe and control workflow runs **without** being in the same
process or holding a live pi session handle.

## Overview

The IPC surface is built on three files per run, plus one global index:

| File | Purpose |
|------|---------|
| `~/.pi/agent/workflows/runs/.active` | Active run IDs (JSON) |
| `<runDir>/ledger.jsonl` | Append-only event log (NDJSON) |
| `<runDir>/ctrl.jsonl` | Control commands from supervisor (NDJSON) |

All files use append-only NDJSON semantics or atomic JSON writes — a
supervisor can safely poll/tail them from any process.

---

## Using `WorkflowClient`

```ts
import { WorkflowClient } from "@samfp/pi-workflows";

const client = new WorkflowClient();

// 1. List currently active run IDs
const active = client.listActiveRuns();
// → ["wf-abc123", "wf-def456"]

// 2. Read current state of a specific run
const state = await client.getRunState("wf-abc123");
// → { state: "running", phases: ["research", "writing"], agentCounts: {...}, entries: [...] }

// 3. Subscribe to live events (poll-based file tail)
for await (const event of client.tailEvents("wf-abc123")) {
  if (event.type === "transition") {
    console.log(`State: ${event.from} → ${event.to}`);
  }
  if (event.type === "appendEntry") {
    console.log(`Overlay event: ${event.customType}`, event.data);
  }
}

// 4. Send control commands
await client.sendControl("wf-abc123", { type: "pause" });
await client.sendControl("wf-abc123", { type: "resume" });
await client.sendControl("wf-abc123", { type: "stop", reason: "supervisor-abort" });
```

### Constructor options

```ts
const client = new WorkflowClient({
  // Override the runs home directory (default: ~/.pi/agent/workflows/runs/)
  runsHome: "/custom/path/runs",
  // Poll interval for tailEvents() in ms (default: 200)
  pollIntervalMs: 100,
});
```

---

## Active-Runs Index (`~/.pi/agent/workflows/runs/.active`)

```json
{
  "runs": ["wf-abc123", "wf-def456"],
  "updatedAt": "2026-05-30T12:00:00.000Z"
}
```

- Written by `ActiveRunsRegistry.writeActiveIndex()` via **tmp+rename** for
  crash-safe atomicity.
- Updated on every registry notification: new run, state change, run ended.
- Contains only **non-terminal** runs (`running`, `paused`, `approved`, `pending`).
- `updatedAt` is an ISO-8601 timestamp from the writing process's clock.

A supervisor can poll this file to discover active runs without scanning the
entire `runs/` directory.

---

## Event Stream (`<runDir>/ledger.jsonl`)

The ledger is append-only NDJSON. Each line is a JSON object with a
`type` discriminator and an `at` ISO-8601 timestamp. A supervisor can
tail this file to observe all run events.

### Entry types

#### State machine entries (always present)

| Type | Fields | Description |
|------|--------|-------------|
| `init` | `manifest` | Run started; manifest snapshot |
| `transition` | `from`, `to`, `reason?` | State transition (see PRD §5.2) |
| `cancelled` | `cause` | Run cancelled before starting |
| `pause` | `reason?` | Cooperative pause requested |
| `resume` | `reason?` | Cooperative resume requested |
| `shutdown` | `graceful` | Session shutdown |

**Valid states:** `pending → approved → running → paused → running → done/failed/stopped`

#### Phase/agent lifecycle

| Type | Fields | Description |
|------|--------|-------------|
| `phase_start` | `phaseName`, `agentCount` | Phase began |
| `phase_end` | `phaseName`, `durationMs`, `agentResults` | Phase complete with counts |
| `agent_start` | `phaseName`, `agentId`, `promptHash` | Agent subprocess spawned |
| `agent_end` | `phaseName`, `agentId`, `durationMs`, `usage`, `cached` | Agent finished |
| `agent_error` | `phaseName`, `agentId`, `error` | Agent failed |
| `agent_cache_hit` | `phaseName`, `agentId` | Result served from cache |

#### Result and error

| Type | Fields | Description |
|------|--------|-------------|
| `result` | `result`, `truncated` | `main()` return value (≤4KB) |
| `error` | `error.name`, `error.message`, `error.stack?` | Unhandled exception |
| `log` | `level`, `message` | Workflow `console.log()` call |

#### Overlay events (`appendEntry`)

```json
{
  "type": "appendEntry",
  "at": "2026-05-30T12:00:05.123Z",
  "customType": "pi-workflows.agent.log",
  "data": { "runId": "wf-abc123", "agentId": "ag-001", "line": "Processing item 42…" }
}
```

Any `pi.appendEntry` event from the `pi-workflows.*` namespace whose payload
includes a `runId` field is mirrored to the run's ledger. This includes:

- `pi-workflows.run.started` — run started (with `runDir`, `workflowName`, `args`)
- `pi-workflows.run.ended` — run ended (with `outcome`, `durationMs`)
- `pi-workflows.phase.started` / `pi-workflows.phase.ended`
- `pi-workflows.agent.started` / `pi-workflows.agent.ended`
- `pi-workflows.agent.log` — real-time log lines from running agents
- `pi-workflows.run.transitioned` — state change broadcast

### Replay example

A supervisor can derive full run state without the in-process registry:

```ts
const state = await client.getRunState("wf-abc123");
console.log(state.state);        // "running"
console.log(state.phases);       // ["research", "writing"]
console.log(state.agentCounts);  // { research: { ok: 5, error: 0, cacheHit: 2 } }
```

---

## Control Protocol (`<runDir>/ctrl.jsonl`)

A supervisor sends control commands by **appending** JSON lines to
`<runDir>/ctrl.jsonl`. The run's ctrl-file watcher picks them up and
dispatches to the appropriate `Run` method.

### Command format

```json
{ "type": "pause",  "at": "2026-05-30T12:00:10.000Z", "reason": "supervisor-pause" }
{ "type": "resume", "at": "2026-05-30T12:00:15.000Z" }
{ "type": "stop",   "at": "2026-05-30T12:00:20.000Z", "reason": "abort" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"pause" \| "resume" \| "stop"` | ✅ | Command type |
| `at` | ISO-8601 string | optional | When the command was issued |
| `reason` | string | optional | Free-text reason for logging |

### Effect mapping

| `type` | Run method called |
|--------|-------------------|
| `pause` | `run.pause(reason ?? "ctrl-ipc")` |
| `resume` | `run.resumePaused(reason ?? "ctrl-ipc")` |
| `stop` | `run.stop(reason ?? "ctrl-ipc")` |

Commands are idempotent at the `Run` level — sending `pause` to an
already-paused run returns `false` and emits no ledger entry.

The ctrl-file watcher uses `fs.watch()` on the run directory (not the
file itself) so it fires even when `ctrl.jsonl` is created for the first
time. The watcher is torn down when the run reaches a terminal state.

---

## Architecture

```
Supervisor process                      pi-workflows process
─────────────────                       ───────────────────
WorkflowClient                          bindRegistryToFeed (overlay.ts)
  .listActiveRuns()   ←── reads ───     activeReg.writeActiveIndex()
  .getRunState()      ←── reads ───     LedgerWriter.append()
  .tailEvents()       ←── polls ───     (appendEntryToLedger helper)
  .sendControl()      ──── writes ──→   startCtrlWatcher (runManager.ts)
                                            → run.pause/resume/stop()
```

### Durability guarantees

| File | Write method | fsync? |
|------|-------------|--------|
| `.active` index | tmp+rename | ✅ (before rename) |
| `ledger.jsonl` (state entries) | append + fsync | ✅ |
| `ledger.jsonl` (appendEntry events) | append + fsync | ✅ |
| `ctrl.jsonl` | append + fsync | ✅ |

All writes are `O_APPEND` which is atomic for writes ≤ PIPE_BUF (~4KB)
on POSIX systems. Each ledger line is a single JSON object well under
this limit, so interleaved writes from concurrent processes are safe.

---

## Supervisor Agent Example

```ts
// supervisor-agent.ts — poll for active runs and log state changes

import { WorkflowClient } from "@samfp/pi-workflows";

async function main() {
  const client = new WorkflowClient();
  
  // Find an active run
  const runs = client.listActiveRuns();
  if (runs.length === 0) {
    console.log("No active runs");
    return;
  }
  
  const runId = runs[0]!;
  console.log(`Supervising ${runId}`);
  
  // Read initial state
  const initial = await client.getRunState(runId);
  console.log("Initial state:", initial?.state);
  
  // Tail events until done
  let phaseCount = 0;
  for await (const event of client.tailEvents(runId)) {
    if (event.type === "phase_start") {
      phaseCount++;
      console.log(`Phase ${phaseCount}: ${event.phaseName}`);
    }
    if (event.type === "transition") {
      console.log(`→ ${event.to}`);
    }
    if (event.type === "appendEntry" && event.customType === "pi-workflows.agent.log") {
      // Real-time agent log lines
      const d = event.data as { agentId: string; line: string };
      console.log(`  [${d.agentId}] ${d.line}`);
    }
  }
  
  console.log(`Done. Phases observed: ${phaseCount}`);
}

main();
```
