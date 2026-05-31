# Time travel / fork from checkpoint (ZONE_TIMETRAVEL)

Status: **shipped 2026-05-31** — runtime API + ledger-copy + cache-inheritance + manifest lineage. TUI hotkey deferred.

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

- **TUI hotkey.** No `f` key in the runs-list view yet. To fork
  interactively today, drop into a script:
  ```bash
  node -e "
    import('@samfp/pi-workflows').then(async ({ forkFromCheckpoint }) => {
      const r = await forkFromCheckpoint('<runId>', { atPhase: '<phase>', preApproved: true });
      await r.terminated;
    });
  "
  ```
- **Strict cache filtering.** Currently the entire `cache.jsonl` is
  copied; cache entries from phases ≥ `atPhase` are stale but
  harmless (overrides change cacheKey → cache miss → re-dispatch).
  A future revision could walk the parent ledger, compute which
  cache keys belong to the post-fork phases, and exclude them.
  Keep an eye on this when building forks against workflows whose
  post-fork prompts DON'T depend on `overrides` — those forks will
  cache-hit the parent's results and silently skip re-dispatch.
- **Fork lineage in resume errors.** `resumeRun` doesn't yet read
  `parentRunId` / `forkAtPhase` for diagnostics. Resuming a fork
  works (the manifest fields are preserved end-to-end) but
  ledger-output messaging treats it as a normal run.
- **Recursive forks.** Forking a fork is supported (the
  `parentRunId` field chains naturally) but not heavily exercised.
  GC walks the chain via `parentRunId` lookups — be aware that
  deleting a parent run that has live forks will leave dangling
  lineage references in the children's manifests.

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
