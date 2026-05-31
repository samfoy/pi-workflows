# Time travel / fork from checkpoint (ZONE_TIMETRAVEL)

Status: **shipped 2026-05-31** — runtime API + ledger-copy + cache-inheritance + manifest lineage. **Updated 2026-05-31 (zone-tui-hitl-fork):** TUI `f` hotkey + strict cache filtering shipped. **Updated 2026-05-31 (polish-timetravel):** resume-of-fork lineage + recursive-fork GC validation shipped.

## Surface

Two equivalent entry points:

```ts
import { forkFromCheckpoint, FORK_OVERRIDES_KEY } from "@samfp/pi-workflows";

const fork = await forkFromCheckpoint("wf-abc123", {
  atPhase: "p2",
  overrides: { phase2Prompt: "alt-strategy" },
  preApproved: true,         // or pass `approval: {...}` like startWorkflowRun
});
await fork.terminated;
```

Or via `WorkflowClient`:

```ts
import { WorkflowClient } from "@samfp/pi-workflows";

const client = new WorkflowClient();
const fork = await client.forkFromCheckpoint("wf-abc123", {
  atPhase: "p2",
  overrides: { phase2Prompt: "alt-strategy" },
  preApproved: true,
});
```

Inside the workflow, the override is read via `ctx.cache`:

```js
const overrides = await ctx.cache.get('__fork_overrides__');
const prompt = overrides?.phase2Prompt ?? "phase 2 default prompt";
```

## What gets inherited

When a fork is created from `parentRunId` at `atPhase`:

1. **Manifest lineage.** The new run's `manifest.json` carries
   `parentRunId: "wf-abc123"` and `forkAtPhase: "p2"`.
2. **Ledger prefix.** Every entry from the parent's `ledger.jsonl`
   appearing **before** the first `phase_start` entry whose
   `phaseName === atPhase` is copied verbatim into the new run's
   ledger — except `init`, `transition`, `result`, `error`,
   `shutdown`, `cancelled` (those would clash with the fresh state
   machine `startWorkflowRun` installs).
3. **Cache.** The parent's full `cache.jsonl` is copied. Pre-fork
   agents (e.g. phase-1) replay from cache because their
   `cacheKey` (sha of phase + agent id + prompt + opts +
   workflowSourceSha256) is identical to the parent's. Post-fork
   agents whose prompts depend on `overrides` get a different
   `cacheKey` and re-dispatch.
4. **Overrides.** `opts.overrides` is appended as an `author_cache`
   record under the reserved key `__fork_overrides__`. The workflow
   reads it via `ctx.cache.get('__fork_overrides__')`. When
   `overrides` is undefined, `null` is recorded so the workflow can
   detect the fork explicitly via `ctx.cache.has`.

The parent run is left **untouched** — its ledger / cache /
manifest are not modified.

## What gets re-run

The new run starts from a fresh state machine (`pending → approved
→ running`) and executes the workflow source from the top. Phases
before `atPhase` cache-hit (no real agent dispatch). Phases at or
after `atPhase` re-dispatch — fresh against the override values.

## Deferred items

- ~~**TUI hotkey.**~~ ✅ **Shipped** (zone-tui-hitl-fork). The runs-list
  view binds `f` to a fork-from-checkpoint dialog. Production wiring
  reads the parent ledger to enumerate phases, prompts via
  `ctx.ui.select` for `atPhase`, prompts via `ctx.ui.input` for
  optional `overrides` JSON, and calls `forkFromCheckpoint(...)`. The
  resulting fork's runId is surfaced in the overlay banner.
  End-to-end coverage: `tests/integration/forkOverlayHotkey.test.ts`.
- ~~**Strict cache filtering.**~~ ✅ **Shipped** (zone-tui-hitl-fork).
  The fork seed copies parent `cache.jsonl` lines through
  `_classifyParentCacheLine`: `agent_result` records with `at >=`
  parent's `phase_start` for `atPhase` are dropped. Author-controlled
  `author_cache` records are kept verbatim. Net effect: post-fork
  phases re-dispatch even when their prompts don't depend on
  `overrides`. Coverage:
  `tests/unit/forkCacheFilter.test.ts` (helper-level) +
  `tests/integration/forkFromCheckpoint.test.ts` ("strict cache
  filtering — post-fork phases re-dispatch" case).
- ~~**Fork lineage in resume errors.**~~ ✅ **Shipped** (polish-timetravel).
  `resumeRun` reads `manifest.parentRunId` + `manifest.forkAtPhase` and:
  (a) emits a single `{type:'fork_lineage', parentRunId, forkAtPhase}`
  ledger entry directly after the `resume` entry so observability
  tools (overlay, OTel exporter, third-party tail readers) can render
  the lineage without re-reading the manifest; (b) prefixes any error
  captured during the resumed run with `fork of <parent> at phase
  <forkAtPhase> failed: …` — visible in the `error` ledger entry
  and in the terminal `RunTerminalInfo.error.message`. The runs-list
  overlay surfaces a `(fork of <short>)` badge in the workflow column
  for any run whose registry summary carries `parentRunId`. Coverage:
  `tests/unit/resumeForkLineage.test.ts` (5 tests — ledger entry,
  error prefix on fork + non-fork regression guard, registry patch,
  no-emit on non-fork) +
  `tests/unit/runsList.test.ts` (fork-badge cell rendering).
- ~~**Recursive forks.**~~ ✅ **Shipped** (polish-timetravel). GC builds
  a child→parent index over the runs root before scanning candidates.
  When pruning a run, `runGc` checks the index for any other run on
  disk whose `manifest.parentRunId` points at the candidate. By
  default GC **refuses** to delete such a parent: it moves to
  `result.skipped` with `reason: "has-fork-children"` and `details:
  "forks: [...]"`. Pass `force: true` to override; on force-delete,
  each surviving fork's `manifest.json` is patched with
  `parentDeletedAt: <iso>` and a `log: warn` tombstone line is
  appended to its `ledger.jsonl` so observability tools render the
  broken-lineage state. Forks whose `parentRunId` doesn't appear on
  disk are logged as orphans (advisory — the orphan itself remains
  GC-eligible). Coverage:
  `tests/unit/gcRecursiveFork.test.ts` (5 tests — A→B refused, A→B
  force-delete writes tombstone, A→B→C chain refuses GC of B,
  orphan logged + still GC'd).

## Errors

- `ForkRunNotFoundError` — `parentRunId` resolves to a directory
  that doesn't exist.
- `ForkPhaseNotFoundError` — `atPhase` does not appear as a
  `phase_start` in the parent's ledger. The error carries
  `availablePhases` (the phases observed in the parent ledger,
  in start order) for diagnosability.

## Tests

`tests/integration/forkFromCheckpoint.test.ts` covers:

- 3-phase parent → fork at phase 2 with override → asserts (a) parent
  intact, (b) phase-1 cache reused (`agent_cache_hit` in fork ledger
  + `cached: true` in returned result), (c) phase-2 dispatched against
  the override prompt, (d) fork manifest carries `parentRunId` +
  `forkAtPhase`.
- Unknown `parentRunId` → `ForkRunNotFoundError`.
- Unknown `atPhase` → `ForkPhaseNotFoundError` with available phases.
- Overrides record stored under `__fork_overrides__` in the fork's
  `cache.jsonl`.

## Known gotchas

- **mockAgents fixtures.** When forking with `mockAgents: true`, the
  fork needs its own `seedFixturesJsonl` covering any agent that
  will re-dispatch (i.e. any agent whose prompt differs from the
  parent's). Cache hits don't need fixtures.
- **Workflow source must still exist.** The fork reads the workflow
  via `parentManifest.workflowAbsPath`. If the file was deleted or
  moved between parent run and fork, the fork will fail to load it.
- **`enableGlobalCache` is not auto-inherited.** Pass it explicitly
  on the fork if you want global cache participation; otherwise the
  fork uses only per-run cache.
