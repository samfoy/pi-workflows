# pi-workflows v1 — build plan

Source of truth: `PRD.md` (2135 lines). This plan slices the design into ordered, atomic, vertical commits. **No code in this document.** Each slice is one builder pass, one git commit, ≤300 LOC delta soft target.

---

## 1. Slicing strategy

### 1.1 How slices are cut

Every slice ships **user-observable** behavior end-to-end through whatever subset of the architecture is built so far. We avoid horizontal layering ("first all types, then all runtime, then all UI"); each slice walks from the slash-command entry point down through whatever stack it touches and returns observable output to a test or to a real pi session. The runtime is built **bottom-up** (sandbox → cache → semaphore → json-stream → dispatcher → ledger → runCtx) but each of those slices is shipped together with a test harness that exercises it through the public API surface, not as a free-floating library. The result is that even the "low-level" slices land with concrete behavior the critic can verify in isolation.

**Slice 0** is the one exception: it produces only a research artifact (`SPIKE-FINDINGS.md`) answering two questions whose answers are load-bearing inputs to slices 13 and 17. It deliberately ships no runtime code so the spike outcome can't get entangled with scaffolding review. Every code slice (1–18) is vertical and testable.

The slicing DAG is chosen over alternatives (e.g. "TUI-first dogfood loop") because the **dispatcher contract** is the load-bearing risk in the design and the TUI overlay is a relatively safe rendering layer on top of completed events. Landing the runtime first, then the overlay, lets us discover dispatcher-shape mistakes in slice 6/8 with cheap mock fixtures rather than during overlay slice 13. The cost is that v0.1 has no overlay (uses `pi.sendMessage` summaries only) — explicitly accepted in §15.1.

### 1.2 Tier definitions

| Tier | Definition | Slice count |
|---|---|---|
| **research** | Pre-build investigations producing decision documents the rest of the slices read. No runtime code. | 1 (slice 0) |
| **v0.1** | Slim end-to-end: registry → `/<name>` → sandbox → dispatcher → cache → ledger → approval → result delivery. **No** overlay (pi.sendMessage summaries), **no** resume, **no** pause. Approval as a `ctx.ui.custom` 4-outcome dialog. Bundled workflow not yet shipped. Internal dogfood-able. | 11 (slices 1–10, with 8 split into 8a/8b) |
| **v0.5** | v0.1 + resume from disk + pause/resume + crash sweep + non-overlay slash sub-commands (`list`, `show`, `kill`, `resume`) + `/workflows` overlay runs-list view. Externally usable by power users. | 3 (slices 11–13) |
| **v1.0** | v0.5 + phase view + agent detail + GC dialog + save-script (`s`) + hot-reload + bundled `/codebase-audit` + full docs + npm publish. Production-quality bar. | 5 (slices 14–18) |

Each slice carries its tier tag; the conductor can stop at any tier and ship.

### 1.3 Cross-slice contracts (what each slice publishes)

The list below names the symbols each slice introduces into the codebase that subsequent slices import. Concrete signatures are the builder's call inside each slice; the **shape** is fixed here so dependencies can be DAG-walked without ambiguity.

| Slice | Publishes |
|---|---|
| 0 | `SPIKE-FINDINGS.md` (overlay-nesting answer + `pi.workflows` manifest answer) |
| 1 | `WorkflowFile`, `WorkflowRegistry`, `Config` (env+settings reader), `ExtensionAPI` (default-export fn shape), `RunManifest` (interface stub — fields filled by slices 6 + 8a per §6.2) |
| 2 | `Sandbox`, `runScript(source, ctx, signal)`, `SandboxViolationError`, `wrapHostError()` (used by 8a) |
| 3 | `CacheStore`, `cacheKey(run, agent)`, `sha256()`, `runDir(runId)` |
| 4 | `Semaphore`, `AcquireToken` |
| 5 | `parseJsonStream(stream)`, `JsonStreamError` |
| 6 | `dispatchAgent(run, agent, signal)`, `MalformedAgentOutputError`, `AgentResult` (concrete type), `mockDispatch()` (gated by `run.options.mockAgents`); writes `RunManifest.parentPid` / `parentStartTime` / `parentBootId` |
| 7 | `LedgerWriter`, `LedgerReader`, `RunState`, `Transition`, `LedgerEntry`, fsync policy doc'd inline |
| 8a | `RunCtx`, `Run`, `AgentHandle`, `RunManager` (start/in-memory only), AggregateError-preserving phase impl; merges remaining `RunManifest` fields (`runId`, `workflowName`, `workflowSourceSha256`, `startedAt`, `cwd`, `piVersion`, `piWorkflowsVersion`, `options`, `trustedAtStart`, `input`) into the partial manifest written by slice 6 |
| 8b | `ctx.vote`, `ctx.consensus`, `ctx.parallel`, `ctx.retry`, `ctx.sleep` (stdlib) |
| 9 | `ApprovalDialog` component, trust storage I/O, bypass-precedence checker, **bypass-banner** emitter |
| 10 | Slash-command full handler (result delivery + finishCallback + summary card), `pi.appendEntry` active-runs index, full disable-knobs (env+setting+recursive guard) |
| 11 | `resumeRun(runId)`, crash-sweep on `session_start`, non-overlay sub-commands |
| 12 | `pauseRun`/`resumeRun` cooperative pause |
| 13 | `Overlay` framework, `RunsList` view, push/pop coexistence with conductor |
| 14 | `PhaseView` view, `s` save-script handler (project-root walk + git add) |
| 15 | `AgentDetail` view, `GCDialog`, transcript open-in-`$EDITOR` |
| 16 | `chokidar` hot-reload over registry |
| 17 | `examples/codebase-audit/`, `bundledWorkflow.test.ts`, `pi.workflows` install path (or fallback) |
| 18 | `docs/` tree, `CHANGELOG.md`, `skills/pi-workflows-author/SKILL.md`, npm-publish-ready repo |

A type lands the slice it's first needed in and is **not** moved later. Types graduate from `src/types/internal.d.ts` to `src/types/public.d.ts` at slice 8a, when the author-facing API stabilizes.

---

## 2. Dependency DAG

A dedicated **Slice 0** sits above the existing tree as a research-only prerequisite to slice 1; everything else is unchanged from the previous revision.

```
          ┌─────────────────────────────────────────┐
          │ Slice 0: SPIKE-FINDINGS.md (research only) │
          │  · §15.D ctx.ui.custom nesting              │
          │  · §15.9 pi.workflows manifest field         │
          └─────────────────────┬─────────────────────┘
                                  ▼                       (slice 1 below)
```

```
                ┌─────────────────────────────────────────────────┐
                │                                                 │
                │  Slice 1: skeleton + registry + slash stub      │
                │           (consumes §15.D + §15.9 from slice 0)  │
                │                                                 │
                └────────────┬────────────────┬───────────────────┘
                             │                │
                  ┌──────────┴──────────┐     │
                  │                     │     │
                  ▼                     ▼     ▼
              ┌────────┐  ┌────────┐ ┌─────────┐  ┌───────────┐ ┌──────────┐
              │ 2 sand │  │ 3 cache│ │ 4 sema  │  │ 5 jsonStr │ │ 7 ledger │
              │  -box  │  │  +hash │ │ -phore  │  │  parser   │ │ +SM      │
              └────┬───┘  └────┬───┘ └────┬────┘  └─────┬─────┘ └─────┬────┘
                   │           │          │             │             │
                   │           │          └──────┬──────┘             │
                   │           │                 ▼                    │
                   │           │           ┌──────────┐                │
                   │           │           │ 6  disp- │                │
                   │           │           │ atcher   │                │
                   │           │           └────┬─────┘                │
                   │           │                │                      │
                   └───────────┴────────────────┴──────────────────────┘
                                                │
                                                ▼
                                         ┌────────────┐
                                         │ 8a  RunCtx │
                                         │ +RunMgr    │
                                         └─────┬──────┘
                                               │
                                  ┌────────────┴──────────────┐
                                  │                            │
                                  ▼                            ▼
                            ┌────────────┐               ┌────────────┐
                            │ 8b  stdlib │               │ 9 approval │
                            │  helpers   │               │ +bypass    │
                            └─────┬──────┘               └─────┬──────┘
                                  │                            │
                                  └─────────────┬──────────────┘
                                                ▼
                                         ┌────────────┐
                                         │ 10  result │
                                         │  delivery  │
                                         │  (v0.1✓)   │
                                         └─────┬──────┘
                                               │
                                  ┌────────────┴──────────────┐
                                  │                            │
                                  ▼                            ▼
                            ┌────────────┐               ┌────────────┐
                            │ 11 resume  │               │ 12 pause/  │
                            │ +crash sw  │               │  resume    │
                            └─────┬──────┘               └─────┬──────┘
                                  │                            │
                                  └─────────────┬──────────────┘
                                                ▼
                                         ┌────────────┐
                                         │ 13 overlay │
                                         │ runs list  │
                                         │  (v0.5✓)   │
                                         └─────┬──────┘
                                               │
                                  ┌────────────┴──────────────┐
                                  ▼                            ▼
                            ┌────────────┐               ┌────────────┐
                            │ 14 phase   │               │ 16 hot-    │
                            │ view + s   │               │  reload    │
                            └─────┬──────┘               └─────┬──────┘
                                  │                            │
                                  ▼                            │
                            ┌────────────┐                     │
                            │ 15 agent   │                     │
                            │ detail+gc  │                     │
                            └─────┬──────┘                     │
                                  │                            │
            ┌─────────────────────┴───────────┬────────────────┘
            │                                  │
            ▼                                  ▼
     ┌────────────┐                     ┌────────────┐
     │ 17 bundled │  (depends on 9, 10, │ 18 docs    │
     │ wf+install │   16 for hot demo)  │ +finalize  │
     └─────┬──────┘                     └─────┬──────┘
           └──────────────┬─────────────────  ┘
                          ▼
                     v1.0 release
```

**Critical path:** longest path through the DAG is `0 → 1 → 7 → 6 → 8a → 9 → 10 → 13 → 14 → 15 → 18`. **11 nodes, 10 edges.** (Equivalent routes through 4→6 or 5→6 substitute for the 7→6 hop with the same length; the 7→6 form is shown because 7 is also a direct dependency of 8a.) Slice 17 is depth 7 and joins at slice 18 as a parallel branch off the {11, 12, 13} layer; it is **not** on the critical path. Slices 2/3/4/5/7 can run in parallel after slice 1 if multiple builders are spawned, collapsing wall time.

**Parallelizable slice clusters (after slice 1):**
- {2, 3, 4, 5, 7} — five independent low-level libraries; can be built in any order, all feed into 6 or 8a.
- {11, 12} — both extend RunManager from slice 10; can be built in parallel.
- {14, 16} — phase view and hot-reload don't share files; can be built in parallel.
- {17} — once {8b, 9, 10} are landed, 17 is independent of the {11, 12, 13, 14, 15, 16} chain and can run in parallel with the overlay slices.

---

## 3. Slice index

| # | Name | Tier | Depends-on | Est. LOC | Risk |
|---|---|---|---|---|---|
| 0 | Spike investigations — overlay nesting + manifest field | research | — | ~50 LOC + ~150–300 lines findings doc | Wrong conclusion blocks slice 13 / 17 — mitigation: "escape hatch" required in findings doc |
| 1 | Skeleton + registry + slash stub | v0.1 | 0 | ~280 | Manifest field decision from slice 0 may force slice-17 fallback path |
| 2 | vm.Context sandbox + frozen globals + security tests | v0.1 | 1 | ~250 | AggregateError-preserving wrapper contract |
| 3 | Cache + cacheKey + cache.jsonl reader/writer + paths | v0.1 | 1 | ~200 | Compaction race during run |
| 4 | FIFO async semaphore | v0.1 | 1 | ~120 | AbortSignal propagation through queued waiters |
| 5 | JSON-stream parser for `pi --mode json` output | v0.1 | 1 | ~150 | Embedded newlines + escape sequences in transcript JSON |
| 6 | Sub-agent dispatcher + parent-death guard + mock branch + env injection | v0.1 | 3,4,5 | ~300 | prctl wrapper portability; parent-death cleanup correctness; **recursive-detonation guard env vars** |
| 7 | Ledger writer + state machine + corruption-tolerant reader | v0.1 | 1 | ~250 | **fsync semantics** — must explicitly fsync after each transition |
| 8a | RunCtx + RunManager core + AggregateError preservation | v0.1 | 2,3,6,7 | ~250 | Realm-boundary error reconstruction |
| 8b | stdlib helpers (vote, consensus, parallel, retry, sleep) | v0.1 | 8a | ~150 | Jaccard implementation correctness |
| 9 | Approval flow + trust storage + bypass + announce banner | v0.1 | 8a | ~250 | `pi -p` strict mode; loud bypass announcement (oracle flag #4) |
| 10 | Result delivery + finishCallback + index + disable knobs | v0.1 | 9 | ~200 | finishCallback firing order vs main() resolution |
| 11 | Resume from disk + crash sweep on session_start | v0.5 | 10 | ~280 | Multi-pi-process safety of crash sweep |
| 12 | Cooperative pause / resume | v0.5 | 10 | ~150 | Acquire-loop deadlock under abort+pause race |
| 13 | TUI overlay framework + runs list view | v0.5 | 0,10 | ~280 | Push/pop coexistence with conductor (dep on slice-0 spike) |
| 14 | Overlay phase view + `s` save-script | v1.0 | 13 | ~280 | Project-root walk; collision UX |
| 15 | Overlay agent detail + GC dialog + transcript open | v1.0 | 14 | ~280 | $EDITOR portability; clipboard fallback chain |
| 16 | Hot-reload via chokidar | v1.0 | 1 | ~150 | In-flight runs holding old script reference |
| 17 | Bundled `/codebase-audit` + install path + integ test | v1.0 | 0,8b,9,10 | ~250 | `pi.workflows` manifest field decision from slice 0 |
| 18 | Docs + skills + CHANGELOG + npm publish dry-run | v1.0 | 15,16,17 | ~250 (mostly docs) | Doc accuracy vs final API surface |

**Totals:** 20 slices (slice 0 + 19 build slices); research = 1, v0.1 = 11, v0.5 = 3, v1.0 = 5. Critical path: 11 nodes / 10 edges.

---

## 4. Slice details

### Slice 0 — Spike investigations (research only)

**Goal.** Produce `SPIKE-FINDINGS.md` answering two questions whose answers are load-bearing inputs to slices 13 and 17. Tier: research (prerequisite to v0.1; ships no runtime code).

1. **§15.D — does `ctx.ui.custom` support nested mounts?** (push/pop on top of conductor's `Ctrl+G` overlay.) Recommendation: push/pop. Fallback: close-other.
2. **§15.9 — does pi-coding-agent's installer read the `pi.workflows` manifest field?** (Determines whether bundled `/codebase-audit` ships via the manifest field or needs a fallback `installBundled` setting that the extension self-runs at session_start.)

This slice deliberately ships **no** runtime code beyond the minimum needed to run a pi session that exercises the surfaces. Decoupling the spike from the scaffolding (slice 1) prevents both rushed conclusions and a hard-to-review combined commit.

**Files touched.**
- `package.json` (init only — enough for `git init` + a clean repo state; full package layout is slice 1's concern)
- `LICENSE` (MIT, matches pi-conductor)
- `.gitignore`
- `SPIKE-FINDINGS.md` (the deliverable)
- `scripts/spike-overlay-nest.mjs` — 30-line investigation script that mounts two overlays via `ctx.ui.custom` and observes Esc behavior
- `scripts/spike-pi-workflows-manifest.mjs` — inspects `pi-coding-agent` installer source / runs `pi install` against a fixture pkg with a `pi.workflows` field and observes whether files are copied to `~/.pi/agent/workflows/`

**PRD references.** §15.D (overlay nesting), §15.9 (manifest field), §10.8 (overlay coexistence with conductor).

**Acceptance.**
- `SPIKE-FINDINGS.md` exists at repo root with two top-level sections, one per question.
- Each section has four required sub-headings (in order):
  1. **Question** — one-sentence statement of what's being investigated.
  2. **Method** — exact commands run; inputs.
  3. **Observed** — verbatim or sanitized output snippets from a real pi session, dated.
  4. **Recommendation + escape hatch** — explicit "v1 ships behavior X; if X turns out broken, fall back to Y."
- For §15.D specifically: the recommendation is **push/pop** if observable behavior supports it, **close-other** if not. The slice 13 builder reads this constant and encodes it.
- For §15.9 specifically: the recommendation is either **"manifest field works — slice 17 uses it directly"** or **"fallback needed — slice 17 self-installs via session_start hook"**. Slice 17 reads this and follows the path.
- `git init` succeeds; `git status` is clean post-commit.
- No runtime code introduced (`src/` does not exist after this slice).

**Verification.**
- `cat SPIKE-FINDINGS.md` shows both sections with all four sub-headings each.
- `git log --stat` shows only the listed files.
- `bash scripts/spike-overlay-nest.mjs` and `bash scripts/spike-pi-workflows-manifest.mjs` are both runnable (they're how a builder reproduces the findings if the recommendation is later challenged).

**Dependencies.** None.

**Risks.**
- The spike conclusion is wrong — either pi changes behavior between slice 0 and slice 13/17, or the test environment didn't exercise the right surface. Mitigation: every recommendation has a documented "escape hatch" so slice 13/17 can pivot without re-running the spike. Findings doc carries a date stamp; if pi-coding-agent's surface changes later, re-run the spike and update the file.
- Builder rushes the investigation. Mitigation: critic checklist requires concrete commands + observed output, not handwaving.

**Builder brief outline.**
1. Initialise repo at `/home/samfp/scratch/pi-workflows`. `git init`, baseline `package.json`, `.gitignore`, `LICENSE`.
2. Write `scripts/spike-overlay-nest.mjs`: a 30-line script that loads as a tiny pi extension, registers a slash command that opens overlay A via `ctx.ui.custom`, then opens overlay B from inside A. Observe whether B mounts on top (push/pop), replaces A (close-other), or errors.
3. Write `scripts/spike-pi-workflows-manifest.mjs`: inspect pi-coding-agent's installer source (or `pi install --help`) for `pi.workflows` handling; if unclear, build a tiny fixture package with `pi.workflows: ["./test.js"]`, run `pi install ./fixture`, and check `~/.pi/agent/workflows/` for the file.
4. Run both under a real pi session (TUI live for the overlay test). Capture observed output verbatim.
5. Write `SPIKE-FINDINGS.md` per the four-sub-heading template above.
6. Commit.

**Critic checklist.**
- Findings doc has concrete commands (not "I think push/pop works"); observed output is dated and verbatim or sanitized snippets, not paraphrased.
- Each question has an explicit recommendation **and** an escape hatch named.
- The recommendation is operationalizable: a single constant slice 13 / slice 17 can `import` or read.
- No `src/` files are introduced.
- Both spike scripts are runnable end-to-end.

**Estimated complexity.** S (~50 LOC of script + ~150–300 lines of findings doc).

---

### Slice 1 — Skeleton + registry + slash-command stub

**Goal.** A new `npm:@samfp/pi-workflows` package that, when loaded into pi, scans `<cwd>/.pi/workflows/*.js` and `~/.pi/agent/workflows/*.js` and registers a `/<name>` slash command per file (handler returns `"workflows runtime not yet wired in this slice"`). Tier: v0.1.

**Files touched.**
- `package.json` (full — supersedes slice-0 stub), `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`, `.npmignore`
- `README.md` (skeleton — full polish in slice 18)
- `src/index.ts` — extension default-export; checks `PI_DISABLE_WORKFLOWS` env first, then `pi-workflows.disabled` setting; calls registry.
- `src/config.ts` — env + setting reader (typed via typebox).
- `src/registry.ts` — discovery, filename rules (per §3.2), project-wins-over-personal merge.
- `src/commands/workflowCmd.ts` — `pi.registerCommand` per workflow with stub handler.
- `src/util/paths.ts` — `runDir(runId)`, `workflowsHome()`, project root finder (used here only for discovery; full `s`-hotkey walk lives in slice 14).
- `src/types/internal.d.ts` — `WorkflowFile`, `Config`, `ExtensionAPI`, **`RunManifest` (interface stub — fields filled by slices 6 and 8a; see §6.2 for the full schema)**.
- `tests/unit/registry.test.ts`, `tests/unit/config.test.ts`
- `tests/integration/skeleton.smoke.ts`
- `tests/helpers/makeFakePi.ts` — in-memory pi runtime stub (used by all later integration tests)

**PRD references.** §3.1 (file layout), §3.2 (filename rules), §3.6 (disable knobs — order: env first), §6.2 (manifest schema — stub here, populated incrementally), §11.1–11.5 (package layout, build).

**Acceptance.**
- `npm install && npm run build && npm test` clean.
- `tests/unit/registry.test.ts` covers: project-wins-over-personal collision, reserved-name skip with warning, bad-filename skip, hidden-file silent skip, non-`.js` rejection. ≥6 named test cases.
- `tests/unit/config.test.ts` covers: `PI_DISABLE_WORKFLOWS=1` short-circuits before settings read; setting alone disables; both off → enabled.
- `tests/integration/skeleton.smoke.ts` (under fake-pi harness): drop `<tmp>/.pi/workflows/foo.js` → `pi.commands` map contains `/foo` → invoking `/foo` returns the stub message.
- `RunManifest` interface stub exists in `src/types/internal.d.ts` with all fields per PRD §6.2 declared (typed but not all populated yet — builder slices fill them: slice 6 owns `parentPid`, `parentStartTime`, `parentBootId`; slice 8a owns the rest).
- `npm run build` produces a single-file `dist/index.js` ESM bundle.

**Verification.**
- `cd /home/samfp/scratch/pi-workflows && npm test`
- `cd /home/samfp/scratch/pi-workflows && npm run build && node -e 'console.log(typeof require("./dist/index.js").default)'` (manual sanity).
- `cat src/types/internal.d.ts | grep RunManifest` shows the interface declared.

**Dependencies.** Slice 0 (consumes `SPIKE-FINDINGS.md` recommendations — reads the file at design time, not runtime; encoded as constants where needed in later slices).

**Risks.**
- The `RunManifest` schema is shared between slice 6 and slice 8a; getting the field split wrong here means both later slices need to re-touch the type. Mitigation: critic verifies the field split matches PRD §6.2 and the contracts table in §1.3.
- Reserved-name list may need additions later (e.g. if pi adds new built-in commands); list lives inline in `registry.ts` and is easy to extend.

**Builder brief outline.**
1. Use `pi-conductor`'s `package.json` / `tsconfig.json` / esbuild script as starting templates (do not depend on conductor — read-only reference).
2. Implement registry + commands stub. Filename validation per §3.2 must be exhaustive; reserved-name list defined inline.
3. Declare full `RunManifest` interface in `internal.d.ts` with comments noting which slice populates each field.
4. Write tests; ensure fake-pi harness in `tests/helpers/makeFakePi.ts` provides `registerCommand`, `events`, `appendEntry`, `notify`, `confirm`, `custom` mocks.
5. Confirm `npm test` and `npm run build` clean; commit.

**Critic checklist.**
- Disable-knobs order matches §3.6: env beats setting, both checked at extension-load (not on each command).
- Project workflow `<cwd>/.pi/workflows/foo.js` correctly wins over `~/.pi/agent/workflows/foo.js` on collision (test asserts this explicitly).
- Reserved-name rejection emits both ledger entry shape (even though ledger is slice 7 — the entry is structured-logged via `ctx.log` for now) AND `pi.notify` warning.
- `RunManifest` stub matches PRD §6.2 schema; field-ownership comments correctly attribute fields to slice 6 vs slice 8a.
- esbuild output is single-file ESM; `--external:@earendil-works/pi-coding-agent` honored.

**Estimated complexity.** M.

---

### Slice 2 — vm.Context sandbox + frozen globals + security tests

**Goal.** A `Sandbox` class that takes a script source, a `RunCtx` (mocked at this layer), and an `AbortSignal`, and runs the script inside a `node:vm` Context with curated frozen globals. Hostile-workflow security tests pass against the known-vector corpus. Tier: v0.1.

**Files touched.**
- `src/runtime/sandbox.ts` — Context construction, freezing, timer wrapping, console aliasing, process stub, `wrapHostError()` helper.
- `src/runtime/sandbox-internal.ts` — string-template wrapper compiled via `vm.Script`.
- `src/types/internal.d.ts` (extend) — `SandboxViolationError`.
- `tests/unit/sandbox.test.ts` — 12+ assertions covering §4.3 globals table.
- `tests/security/runner.test.ts` — drives all `*.workflow.js` fixtures.
- `tests/security/prototypePollution.workflow.js`
- `tests/security/functionConstructor.workflow.js`
- `tests/security/asyncFunctionConstructor.workflow.js`
- `tests/security/realmPierce.workflow.js`
- `tests/security/timerEscape.workflow.js`
- `tests/security/processEnvLeak.workflow.js`
- `tests/security/networkViaFetch.workflow.js`
- `tests/security/requireResolve.workflow.js`
- `tests/security/dynamicImport.workflow.js`

**PRD references.** §4.1–4.3 (module shape + globals table), §4.4 (type def stub), §8.2–8.4 (sandbox surface + escape vectors + audit trail), §8.6 (test corpus).

**Acceptance.**
- `tests/unit/sandbox.test.ts` enumerates §4.3 row-by-row: each ✅ row asserts the global is callable; each ❌ row asserts it is `undefined` or throws.
- `Object.freeze(Object.prototype)` is verified post-init (assignment throws).
- A passed-in host-realm Error is reconstructed using `wrapHostError()` such that the script's `result.constructor !== globalThis.Error` (i.e. we crossed the realm without leaking the host Error class).
- **`AggregateError` preservation contract:** `wrapHostError()` accepts an AggregateError, converts each `.errors[i]` independently (preserving `name`, `message`, `stack`, `cause`), and passes the reconstructed AggregateError into the sandbox. Tested in `sandbox.test.ts::aggregate-error-preservation`. Non-Error throws are wrapped as `Error(String(value))` with a `wrappedNonError: true` flag.
- `tests/security/runner.test.ts` runs all 9 hostile fixtures; each asserts the host's `globalThis` is unchanged after the script finishes (reference-equal pre/post check).
- `npm run test:security` exits 0.
- Timer wrappers (`setTimeout` etc.) clear automatically when the run's AbortSignal fires (testable: spawn a 1s timer, abort at 100ms, ensure the callback never runs).

**Verification.**
- `npm run test:unit -- sandbox.test.ts`
- `npm run test:security`

**Dependencies.** Slice 1.

**Risks.**
- Timer wrappers' AbortSignal coupling can deadlock if `clearTimeout` is also wrapped; verify `clearTimeout(setTimeout(...))` is a no-op even after abort.
- The `wrapHostError` contract is **load-bearing for slice 8a**. If 2's design here is wrong, slice 8a's phase-rejection path also fails. Critic must specifically verify the AggregateError test exists in slice 2.

**Builder brief outline.**
1. Build the script-wrapping template: `(async function(ctx, input) { 'use strict'; <SOURCE> })(ctx, input)`. Both shape A (bare body) and shape B (`export default async function`) auto-detect per §4.1; shape B is rewritten to a body wrapper.
2. Construct vm.Context with curated globals; deep-freeze prototypes that need it.
3. Write console aliases that funnel to `ctx.log` (signature available — slice 8a will plug in real ctx.log).
4. Write timer wrappers that register cleanup with the AbortSignal.
5. Write `wrapHostError()` per §8.3.4 — explicit handling of AggregateError, cause chains, non-Error throws.
6. Author 9 hostile fixtures + runner; each fixture is ≤30 lines.

**Critic checklist.**
- `eval` and `Function("...")` are present but cannot reach disallowed globals (verify with a test that calls `Function('return require')()` and asserts undefined).
- AggregateError test is named `aggregate-error-preservation` and explicitly checks `result.errors.length === 3` and each child's `.message` survives.
- `process.env` stub is `{}` — not undefined, not the host's env.
- `Buffer` is present (per §4.3) — verify a test asserts this (regression guard against accidental over-locking).
- Security runner does NOT load fixtures via `import` — it reads them as strings and feeds to the sandbox directly.

**Estimated complexity.** M.

---

### Slice 3 — Cache + cacheKey + cache.jsonl reader/writer + path helpers

**Goal.** A `CacheStore` class for per-run agent-result and author cache, persisted to `<runId>/cache.jsonl`, with last-write-wins replay and compaction at 1000 entries. Tier: v0.1.

**Files touched.**
- `src/runtime/cache.ts` — CacheStore class (get/set/delete/has/replay/compact).
- `src/util/hash.ts` — `sha256()`, `cacheKey(run, agent)` per §4.5 formula.
- `src/util/paths.ts` (extend) — `cachePath(runId)`, `runDir(runId)`.
- `src/types/internal.d.ts` (extend) — `CacheRecord` union (`agent_result | author_cache | author_cache_delete`).
- `tests/unit/cache.test.ts`
- `tests/unit/hash.test.ts`

**PRD references.** §4.5 (cache key), §6.3 (cache.jsonl format).

**Acceptance.**
- `tests/unit/cache.test.ts`: identical-args same key; script-source change → key change; `cacheKeyExtra` change → key change; `delete` removes; replay round-trips; compaction at 1000 entries produces single-snapshot file with `last-value-per-key` semantics; corrupt JSONL line emits `ctx.log.warn` and skips, replay continues.
- `tests/unit/hash.test.ts`: sha256 is hex, deterministic, length 64.
- Compaction is **atomic**: write to `cache.jsonl.tmp`, fsync, rename — verified by killing the process mid-compaction in a test (using a stub that throws before the rename) and asserting the original file is intact.
- `cacheKey` returns identical hashes for two `AgentHandle`s constructed with the same prompt and opts but different `JSON.stringify` key order in `opts` (sorted-keys requirement from §4.5).

**Verification.**
- `npm run test:unit -- cache.test.ts hash.test.ts`

**Dependencies.** Slice 1.

**Risks.**
- Sorted-keys serializer for `cacheKeyExtra` must handle nested objects deterministically. Use a known canonical-JSON helper or roll one ≤20 lines and test extensively.
- Compaction race during a write-heavy run; the slice 8a runtime never compacts mid-write (it batches), so v1 risk is low — document the constraint in `cache.ts` JSDoc.

**Builder brief outline.**
1. Implement `CacheStore` with in-memory map + append-only file. Reads at construction replay the file.
2. Compaction is triggered when entries-since-last-compaction ≥ 1000. Atomicity via `fs.rename`.
3. Cache key derivation per §4.5 — write canonical-JSON helper.
4. Tests cover the eight named cases above.

**Critic checklist.**
- Canonical-JSON serializer handles `null`, nested objects, arrays in deterministic order. Add a property test if feasible.
- Compaction never triggers when there are zero writes since last compact (defensive).
- Reader skips corrupt lines without aborting; warning is structured (not just `console.warn`).
- Cache key formula matches §4.5 byte-for-byte; an explicit test computes the expected hash from the formula.
- `delete` writes a `author_cache_delete` record to disk (so resume reflects the delete).

**Estimated complexity.** M.

---

### Slice 4 — FIFO async semaphore

**Goal.** An async semaphore with FIFO ordering and AbortSignal cancellation; used by slice 6 (dispatcher) and slice 8a (RunCtx phase). Tier: v0.1.

**Files touched.**
- `src/runtime/semaphore.ts`
- `tests/unit/semaphore.test.ts`

**PRD references.** §5.4 (concurrency), §6.7 (per-run agent cap — enforced via semaphore + counter).

**Acceptance.**
- Cap of N admits at most N concurrent acquires (assert via Promise.all + side-effect counter).
- Over-cap waiters resume in FIFO order (10 acquires queued, releases in order, observed acquisition order matches).
- AbortSignal: queued waiter rejects with AbortError when the signal fires; never-acquired waiter does not call `release()`.
- Cap of 0 blocks all acquires until cap is raised via `setCap(n)`.
- `release()` without prior `acquire()` is a no-op (no negative count).
- Cap can be raised live and queued waiters proceed.

**Verification.**
- `npm run test:unit -- semaphore.test.ts`

**Dependencies.** Slice 1.

**Risks.**
- AbortSignal listener leaks if not removed on success; test for listener count.
- FIFO violation under microtask scheduling — use an explicit queue, not Promise resolution order.

**Builder brief outline.**
1. Internal queue of `{ resolve, reject, signal, listener }`.
2. `acquire(signal)` increments active count if under cap, else queues.
3. `release()` dequeues + resolves the head waiter.
4. `signal.aborted` checked on entry; `signal.addEventListener('abort', ...)` for queued path.
5. Tests as above.

**Critic checklist.**
- AbortSignal listener is **removed** in both success and abort paths (memory-leak guard; assert via `signal.eventNames()` or inspecting the abort listener).
- FIFO under contention: 10 staggered queues + releases produce monotonically-increasing acquire IDs.
- `setCap(0)` mid-run does not break already-acquired holders.
- `acquire(undefined)` works (no signal supplied) — defensive.
- Active count never goes negative.

**Estimated complexity.** S.

---

### Slice 5 — JSON-stream parser for `pi --mode json` output

**Goal.** A streaming parser that consumes `pi --mode json -p ...` stdout, emits intermediate transcript events (for slice 13's live-tail), and extracts the final result event. Tier: v0.1.

**Files touched.**
- `src/util/jsonStream.ts`
- `tests/unit/jsonStream.test.ts`
- `tests/fixtures/json-stream/` — synthetic pi-mode-json transcripts (success, malformed-mid, empty, schema-mismatch).

**PRD references.** §5.5 (dispatcher consumes this), §5.5.2 (malformed-output failure modes).

**Acceptance.**
- Parses canonical pi-mode-json line-delimited stream.
- Handles partial chunks (split across stream events); reassembles correctly.
- Handles embedded newlines within JSON-encoded strings (NDJSON: each line is a complete JSON object).
- Handles UTF-8 escape sequences in strings.
- Detects the final `result` event and surfaces it via `getResult()`.
- Throws `JsonStreamError` with the truncated-256-byte offending region on parse failure (used by dispatcher to construct `MalformedAgentOutputError`).
- Tee-to-file behavior: parser writes raw stream to a configurable WriteStream (used to capture `agents/<agentId>.jsonl`).
- 16MB cap honored — past cap, writes are dropped and a marker line is emitted to the tee file.

**Verification.**
- `npm run test:unit -- jsonStream.test.ts`

**Dependencies.** Slice 1.

**Risks.**
- pi-mode-json's exact event schema is owned by pi-coding-agent; we should consume **defensively** (any object with a `type` field is preserved; only the final-result extraction is schema-aware).

**Builder brief outline.**
1. Buffer-based line splitter (NDJSON; tolerates `\n`, `\r\n`).
2. JSON parse per line; tolerate empty lines.
3. On parse error: emit JsonStreamError with line content (truncated to 256 bytes) and position.
4. Watch for the final-result event shape; once seen, latch and surface.
5. Tee write-through path with 16MB cap.
6. Synthetic fixtures for the four scenarios.

**Critic checklist.**
- `tests/fixtures/json-stream/empty.txt` (empty stdout) → `getResult()` returns `undefined`, no JsonStreamError thrown (the dispatcher distinguishes empty from malformed via `child.exitCode`).
- A 17MB transcript hits the cap and writes the marker line; the marker line is documented in `agents/*.jsonl` schema.
- Multi-line embedded strings (e.g. an assistant message containing a code block with newlines) survive round-trip.
- The parser does not throw on unknown event types — it surfaces them to the consumer.

**Estimated complexity.** M.

---

### Slice 6 — Sub-agent dispatcher + parent-death guard + mock branch

**Goal.** `dispatchAgent(run, agent, signal)` spawns `pi --mode json -p` via `pi.exec`, parses the output via slice 5, writes the transcript, returns an `AgentResult`. Includes the parent-death wrapper for orphan prevention and a `mockAgents` branch reading from `fixtures.jsonl`. Tier: v0.1.

**Files touched.**
- `src/runtime/dispatcher.ts`
- `src/runtime/mockAgents.ts` — reader for `<runId>/fixtures.jsonl`.
- `scripts/pi-workflows-spawn.c` — Linux prctl wrapper (~30 lines).
- `scripts/pi-workflows-spawn-fallback.sh` — macOS ppid-poll fallback (or self-killer node helper).
- `scripts/build-spawn.sh` — compiles the wrapper at install-time (postinstall) when on Linux.
- `src/runtime/spawnWrapper.ts` — Node-side glue choosing wrapper vs raw spawn based on platform.
- `src/types/internal.d.ts` (extend) — `AgentResult` (concrete; supersedes the slice-1 stub), `MalformedAgentOutputError`.
- `tests/unit/dispatcher.malformed-json.test.ts` — 4 detection paths from §5.5.2.
- `tests/unit/dispatcher.mock.test.ts` — mock-fixture branch.
- `tests/unit/dispatcher.envInjection.test.ts` — verifies recursive-detonation guard env vars on every spawned child.
- `tests/fixtures/dispatcher/fixtures.jsonl` — sample.

**PRD references.** §5.5 (dispatcher), §5.5.1 (orphan prevention), §5.5.2 (malformed output), §6.2 (manifest fields owned here: `parentPid`, `parentStartTime`, `parentBootId`), §6.5 (per-agent transcript), §13.7 (recursive-detonation prevention via env vars), §1.2 row 11 (mock-agents).

**Acceptance.**
- `dispatchAgent` returns `AgentResult` for a successful canned subprocess (use a fake `pi.exec` in tests that returns a synthetic stdout stream).
- Parent-death wrapper: on Linux, `prctl(PR_SET_PDEATHSIG, SIGTERM)` is invoked before `execvp`. Test by smoke-killing the parent with SIGKILL and asserting child receives SIGTERM (manual / opt-in test under `tests/integration/orphan-cleanup.test.ts` — runs only when `RUN_ORPHAN_TEST=1`).
- macOS fallback polls `process.ppid` every 5s; tested with a fake parent.
- All 4 malformed-output detection paths from §5.5.2 produce `MalformedAgentOutputError` with the correct detail field.
- **Env-injection (PRD §13.7):** dispatcher injects `PI_DISABLE_WORKFLOWS=1` AND `PI_WORKFLOWS_RECURSIVE=1` into the env of every `pi --mode json -p` child it spawns. Pre-existing values for these vars in the parent env are **overwritten** (not preserved). Test: `dispatcher.envInjection.test.ts` asserts both vars present in the spawn options' `env` for at least 3 child invocations across different agent shapes (default model, custom model, mock-agents-disabled vs enabled). Test also asserts that when the parent env contains `PI_DISABLE_WORKFLOWS=0` or `PI_WORKFLOWS_RECURSIVE=0`, the dispatcher overwrites them to `1`.
- **Partial RunManifest write:** dispatcher writes only the fields it owns per the contracts table — `parentPid`, `parentStartTime` (epoch ms or `lstart` per platform), and `parentBootId` (Linux: `/proc/sys/kernel/random/boot_id`; macOS: `sysctl kern.boottime`; fallback: `null`). Slice 8a fills the rest of the manifest at run-start. Dispatcher does NOT touch any field not on its owned list.
- `--mock-agents` branch: when `run.options.mockAgents === true`, dispatcher reads `(agentId, promptHash)` from `<runId>/fixtures.jsonl` instead of spawning. Mock branch still writes parent-liveness fields (so resume/sweep code paths exercise consistently).
- Stderr capture: malformed bytes go to `<runId>/agents/<agentId>.stderr` regardless of cause.

**Verification.**
- `npm run test:unit -- dispatcher`
- `RUN_ORPHAN_TEST=1 npm run test:integration -- orphan-cleanup.test.ts` (manual, not in default CI per §12.7).

**Dependencies.** Slices 3 (cache key + paths), 4 (semaphore), 5 (json-stream), 7 (ledger — for `agent_start`/`agent_end`/`agent_cache_hit` records). **Note:** slice 7 must land before this slice's full integration; the dispatcher records ledger entries. To unblock parallel-build, slice 6 can land with a stub `LedgerWriter` interface that 7 fulfils — flagged in the critic checklist.

**Risks.**
- C wrapper portability: glibc vs musl. Mitigation: detect at install-time, fall back to no-op if compilation fails.
- macOS ppid-poll has 5s latency; documented as an accepted gap in §5.5.1.
- The dispatcher's interaction with the AbortSignal needs careful escalation timing (5s SIGTERM → 15s SIGKILL per pi.exec defaults). Verify pi.exec actually does this; if not, manage manually.

**Builder brief outline.**
1. Implement `dispatchAgent` per §5.5 pseudocode. Cache lookup → semaphore → spawn → parse → cache write.
2. Spawn wrapper: ship `pi-workflows-spawn.c` source + a postinstall script that compiles it via `cc`. On compilation failure, fall back to direct spawn (logged once at session_start).
3. Mock branch reads `fixtures.jsonl` keyed by `(agentId, promptHash)`. Missing fixture → reject with `"missing fixture for agent <id>"`.
4. Malformed-output handling per §5.5.2 table.
5. Env injection: spawn options' `env` is constructed as `{ ...process.env, PI_DISABLE_WORKFLOWS: '1', PI_WORKFLOWS_RECURSIVE: '1' }` — the order matters; later keys overwrite earlier per JS object spread semantics.
6. Partial manifest write: dispatcher creates `<runId>/manifest.json` if it doesn't exist (idempotent), writes/merges the parent-liveness fields, leaves the rest unset for slice 8a.

**Critic checklist.**
- Verify spawn wrapper compiles on the test box (`gcc --version` and `node --eval` actually compiles).
- Verify `pi.exec`'s SIGTERM→SIGKILL escalation actually fires (read pi-coding-agent docs/source; if the default is different, document and adjust).
- All 4 malformed paths hit the same forensics code path (stderr written).
- Mock fixture missing produces a clear error message that points the author to the fixture file.
- Per-agent semaphore release happens in `finally` regardless of error path.
- **Verify env-var injection by inspecting the test's spy on the spawn API; both `PI_DISABLE_WORKFLOWS=1` and `PI_WORKFLOWS_RECURSIVE=1` present in the spawn options' `env` and overwriting any parent values for those keys.** No silent inheritance: if either var is missing from a spawned child's env, the test fails.
- `RunManifest` partial write touches **only** the fields owned by slice 6 (`parentPid`, `parentStartTime`, `parentBootId`); slice-8a fields are untouched (test inspects the JSON written and asserts the unset fields are absent or null).

**Estimated complexity.** L (~300 LOC, ~10 files — two over the soft cap because the C wrapper + shell fallback + Node glue + env-injection test + tests are tightly coupled and splitting them would require re-stubbing the spawn interface across two slices). Could split into 6a (core dispatch + mock + env-injection) and 6b (parent-death wrapper + manifest fields) if it overflows; default plan is one slice, with the explicit "spike split if >300" waiver.

---

### Slice 7 — Ledger writer + state machine + corruption-tolerant reader

**Goal.** `LedgerWriter` and `LedgerReader` for `<runId>/ledger.jsonl` per §6.4, including state-machine transition validation, **explicit fsync** semantics, and torn-last-line robustness. Tier: v0.1.

**Files touched.**
- `src/runtime/ledger.ts` — `LedgerWriter` (mutex-serialized, fsync per write), `LedgerReader` (replay + state reconstruction), `Transition` validator.
- `src/types/internal.d.ts` (extend) — `RunState`, `LedgerEntry` (full union from §6.4 table).
- `tests/unit/ledger.test.ts`
- `tests/fixtures/ledger/torn.jsonl`, `tests/fixtures/ledger/invalid-transition.jsonl`, `tests/fixtures/ledger/full-run.jsonl`

**PRD references.** §5.2 (state machine), §6.4 (ledger format), §5.8 (resume reads ledger), §1.2 row 4 (resume across pi restarts).

**Acceptance.**
- `LedgerWriter.append(entry)` is async, returns when **fdatasync** has succeeded on the appended bytes. (No batching in v1 — correctness over throughput; document the tradeoff in JSDoc.)
- A torn last line (file ends mid-record) is **skipped with a warning** by `LedgerReader.read()`, and replay produces the latest **complete** transition. Test fixture `torn.jsonl` is hand-crafted: full ledger truncated at byte N where N is mid-record.
- An invalid transition (e.g. `done → running`) is rejected by the state machine validator; the reader logs a warning and uses the last valid transition. `invalid-transition.jsonl` tests this.
- A full run's ledger replay produces the expected final state for each terminal-state class (done, failed, stopped, cancelled-pre-run).
- Concurrent appends from multiple async callers serialize via internal mutex; ordering matches call order.
- The `init` entry mirrors `manifest.json`; the `result` entry truncates `result` to ≤4KB (matched against §6.4 table).

**Verification.**
- `npm run test:unit -- ledger.test.ts`

**Dependencies.** Slice 1.

**Risks.**
- **fsync per write is slow** (~5-15ms per fsync on typical SSD). v1 accepts this; if slice 8a's integration tests show >50ms phase overhead, slice 7 revisits with a documented `flushPolicy: 'per-write' | 'per-transition' | 'batch-ms'` setting. Default: `'per-transition'` (only fsync on `transition`/`pause`/`shutdown`/`error`/`result` records; cheap log lines batched).
- Cross-platform fsync: macOS `fdatasync` is `F_FULLFSYNC` for true durability. Default to `fsync()` (Node API); document that we are not asserting cross-power-failure durability — only crash-of-pi-process tolerance, which `fsync()` covers.

**Builder brief outline.**
1. Define `RunState` enum + transition table per §5.2. Validator function rejects illegal transitions.
2. `LedgerWriter`: open file once with `O_APPEND`, internal mutex serializes appends, `fdatasync` per `transition|pause|shutdown|error|result` entry; other entries (logs, agent_start/end) batched and flushed every 100ms or 32 entries.
3. `LedgerReader`: stream-read with line splitter, JSON-parse each, reject torn last line silently, validate transitions, return reconstructed state.
4. Tests as listed above plus a property-style test that drives the state machine through ≥20 transitions.

**Critic checklist.**
- **fsync is actually called** (mock `fs.fsync`, assert call count matches expected — 1 per transition + 1 per flushed batch).
- `torn.jsonl` fixture truncates a real complete ledger at byte N (rebuilt during test, not committed truncated — committed truncated would silently grow stale).
- State-machine validator rejects ALL illegal transitions in the §5.2 diagram (paused → done is illegal; running → done is legal).
- The mutex is genuinely async-safe (try with 100 concurrent appends and assert ordering matches enqueue order).
- The `result` entry's truncation marker (`truncated: true`) is set when result exceeds 4KB.

**Estimated complexity.** M (~250 LOC).

---

### Slice 8a — RunCtx + RunManager core + AggregateError preservation

**Goal.** Constructs the `ctx` object exposed to scripts (`agent`, `phase`, `cache`, `log`, `finishCallback`, `run`, `input`, `signal`); wires together sandbox + cache + dispatcher + ledger + semaphore; exposes `RunManager.start(workflow, args)` returning a `Run` handle. End-to-end: a fixture workflow runs to completion via mock-agents and writes a complete ledger. Tier: v0.1.

**Files touched.**
- `src/runtime/runCtx.ts` — `ctx` factory (no helpers yet — those are 8b).
- `src/runManager.ts` — active runs map; `start(workflow, args, opts)`; in-memory state (no resume yet — that's 11).
- `src/types/public.d.ts` — first cut of the author-facing types: `WorkflowMain`, `WorkflowContext`, `AgentHandle`, `AgentOpts`, `AgentResult`, `Phase`, `Cache`, `LogOpts`, `RunMeta`. **Frozen after this slice unless a parity-bug is found.**
- `src/types/internal.d.ts` (extend) — `Run`, `Workflow` (parsed), `RunOptions`.
- `tests/integration/runEndToEnd.test.ts`
- `tests/fixtures/workflows/basic.workflow.js` — 2-phase, 3-agent fixture.
- `tests/fixtures/workflows/basic.fixtures.jsonl` — canned responses.

**PRD references.** §4.2.1–4.2.5 + §4.2.7 (the part of `ctx` minus helpers), §4.3 (sandbox boundary respected), §4.5 (cache key flowed through), §5.1–5.3 (process model + lifecycle), §5.5 (dispatcher integration), §6.2 (manifest fields owned here — every field except the parent-liveness fields written by slice 6).

**Acceptance.**
- `RunManager.start(workflow, args)` returns a `Run` whose `.promise` resolves to the workflow's `main()` return value when `--mock-agents` mode is on.
- **`RunManifest` merge:** at run-start, RunManager reads the partial manifest (if any) written by slice 6's first dispatcher call — actually, since slice 8a runs **before** the first dispatcher call, RunManager creates the manifest with all 8a-owned fields (`runId`, `workflowName`, `workflowAbsPath`, `workflowSourceSha256`, `input`, `startedAt`, `cwd`, `piVersion`, `piWorkflowsVersion`, `options`, `trustedAtStart`) and the dispatcher (slice 6) merges its parent-liveness fields **on first agent dispatch**. Test: after run-start but before first phase, manifest contains all 8a fields and is missing parent-liveness fields; after first agent dispatched, parent-liveness fields appear without disturbing 8a-owned fields.
- `runEndToEnd.test.ts`: a 2-phase, 3-agent workflow runs; ledger contains `init → transition(pending→approved) → transition(approved→running) → phase_start(p1) → agent_start(a1) → agent_end(a1) → phase_end(p1) → phase_start(p2) → agent_start(a2) → agent_start(a3) → agent_end(a2) → agent_end(a3) → phase_end(p2) → result → transition(running→done)` in order. (Note: `pending→approved→running` is the start path; slice 9 inserts approval; here we plumb the transition skipping the dialog with a `runOpts.preApproved: true` flag.)
- **AggregateError preservation in phase rejection:** `tests/integration/aggregateErrorPropagation.test.ts` — a 3-agent phase where 2 agents reject; the script catches the AggregateError and asserts `errors.length === 2`, each preserves `name`, `message`, and the original `cause` chain (mocked into the fixtures). Other agent in the phase is aborted (its abort signal fires).
- Phase ordering: `await ctx.phase('a', ...); await ctx.phase('b', ...)` runs `b` only after `a` settles. Test asserts agent timestamps prove this.
- `ctx.cache.get/set/delete/has` work; persistence verified by reading the `cache.jsonl` directly at end of run.
- `ctx.log` writes to ledger.
- `ctx.finishCallback(prompt)` enqueues a pending callback; firing happens in slice 10. Here we assert the callback is recorded but **not yet fired**.
- vm.Context is disposed in `finally` regardless of outcome — testable via a counter on the sandbox factory.

**Verification.**
- `npm run test:integration -- runEndToEnd.test.ts aggregateErrorPropagation.test.ts`

**Dependencies.** Slices 2, 3, 6, 7. (Slice 4's semaphore is consumed by slice 6 already; doesn't need to be separately re-imported here.)

**Risks.**
- AggregateError reconstruction across the realm boundary: if slice 2's `wrapHostError()` is wrong, this slice's test fails. Slice 2's critic must have verified the contract; this slice's critic re-checks.
- The `Run` handle's lifecycle (when does `.promise` resolve relative to ledger flushing?) — must resolve **after** the `result`/`error` ledger entry is fsynced, otherwise the integration test races.

**Builder brief outline.**
1. Build `RunCtx` factory: pure construction of an object with all the API methods. Inside each method, call into the runtime services (sandbox, cache, dispatcher, ledger).
2. Build `RunManager.start`: generate runId; **write all 8a-owned manifest fields to `<runId>/manifest.json` (without parent-liveness fields — slice 6 merges those on first dispatch)**; init ledger; init cache; init sandbox; init RunCtx; invoke `runScript(source, ctx, signal)`; on success/failure, write the result/error entry, flush ledger, transition, dispose sandbox.
3. Implement `ctx.phase` with explicit AggregateError support — wrap `Promise.allSettled`, check `rejected[]`, and throw an AggregateError carrying the rejected reasons (each crossed back via `wrapHostError`).
4. Manifest merge contract: slice 6's dispatcher reads + merges + writes (atomic via temp+rename); slice 8a writes once at start. The dispatcher is the only writer **after** start; 8a never overwrites parent-liveness fields.
5. Tests as listed.

**Critic checklist.**
- vm.Context is disposed in a `finally` block that runs even on uncaught script errors (verify with a fixture that throws).
- AggregateError test explicitly checks `errors[i].cause` survives.
- `Run.promise` resolves AFTER ledger fsync of the terminal entry. Add a synthetic fsync delay in a test and assert ordering.
- `ctx.run.id` is the `wf-` + 12 hex chars format.
- `ctx.signal` is an AbortSignal, not a custom event emitter; verify `instanceof AbortSignal`.
- **Manifest write at start contains all 8a-owned fields and NO parent-liveness fields**; after first dispatch, parent-liveness fields appear (verified by reading the file at two checkpoints in the test).
- Manifest merge does not corrupt the file under concurrent writes (test: spawn slice-6 dispatcher write concurrently with a re-read of 8a's fields; both must remain coherent — atomic temp+rename guarantees this).

**Estimated complexity.** L (250 LOC; on the line). If it overflows, split off the AggregateError preservation test fixture into its own file but keep the slice intact.

---

### Slice 8b — stdlib helpers (vote, consensus, parallel, retry, sleep)

**Goal.** `ctx.vote`, `ctx.consensus`, `ctx.parallel`, `ctx.retry`, `ctx.sleep` per §4.2.6, layered on top of `ctx.agent`/`ctx.phase` from 8a. Tier: v0.1.

**Files touched.**
- `src/runtime/stdlib.ts`
- `src/runtime/runCtx.ts` (extend) — wire stdlib helpers into `ctx`.
- `src/types/public.d.ts` (extend) — helper signatures.
- `tests/integration/stdlib.test.ts`
- `tests/fixtures/workflows/vote.workflow.js`, `tests/fixtures/workflows/consensus.workflow.js`, `tests/fixtures/workflows/parallel.workflow.js`, `tests/fixtures/workflows/retry.workflow.js`

**PRD references.** §4.2.6 (helpers), §15.A (consensus = string Jaccard for v1).

**Acceptance.**
- `vote(agents, judge)`: spawns all agents in a single phase, calls `judge(responses[])` to pick a winner. Test fixture asserts winner matches the judge's output.
- `consensus(agents, opts?)`: runs agents, computes Jaccard similarity over tokenized responses; `agreed: true` when ≥`threshold` (default 0.6) of pairwise comparisons cross threshold. Documents the limitation per §4.2.6 in JSDoc.
- `parallel<T>(items, fn, opts?)`: maps items → AgentHandles (fn may return one or many), runs as a single phase under `opts.phaseName ?? 'parallel'`.
- `retry(fn, opts?)`: re-invokes `fn` on rejection up to `attempts` (default 3); `backoffMs` between attempts; honors AbortSignal.
- `sleep(ms)`: returns Promise resolving after `ms`; honors `ctx.signal` (rejects with AbortError on abort).

**Verification.**
- `npm run test:integration -- stdlib.test.ts`

**Dependencies.** Slice 8a.

**Risks.**
- Jaccard tokenization choice (whitespace-split? lowercase? strip punctuation?). Locked: lowercase + whitespace-split + strip ASCII punctuation. Documented inline.
- `retry` interacting with phase-level cancellation — `retry` should NOT swallow AbortError.

**Builder brief outline.**
1. Implement each helper as a thin wrapper around `ctx.phase` / `ctx.agent`.
2. Tokenizer for Jaccard: 5-line helper, deterministic.
3. Tests use the mock-agents path; canned responses set up specific similarity scenarios.

**Critic checklist.**
- `vote`'s judge can be either sync or async — both supported.
- `consensus` handles 1-agent case (always `agreed: true`).
- `retry` honors AbortSignal — abort during backoff sleep should reject the retry chain.
- `sleep`'s AbortSignal listener is removed on natural resolution (no leak).
- `parallel`'s `fn` returning an array is flattened into a single phase.

**Estimated complexity.** M (~150 LOC).

---

### Slice 9 — Approval flow + trust storage + bypass + announce banner

**Goal.** First-run approval dialog (4 outcomes), `trustedWorkflows` settings I/O, bypass-precedence checker, **loud bypass announcement** to the conversation when `--bypass-permissions` is active. Tier: v0.1.

**Files touched.**
- `src/ui/approvalDialog.tsx` — `ctx.ui.custom` with 4 outcomes (Y/A/V/N).
- `src/commands/workflowCmd.ts` (extend) — pre-handler checks bypass conditions; if not bypassed and not trusted, show dialog; on `[A]`, write to settings.
- `src/runtime/trustStore.ts` — sha256-keyed read/write; project-vs-personal scope detection by source path.
- `src/runtime/bypass.ts` — bypass-precedence reader (env-driven).
- `tests/integration/approval.test.ts`
- `tests/fixtures/workflows/trusted-workflow.js` (sample for testing trust)

**PRD references.** §3.4 (dialog UX), §3.5 (bypass conditions), §7.1–7.5 (approval and trust storage), §7.4.1 (`pi -p` strict mode rationale), §15.B (bypass-pass-through always-on for v1).

**Acceptance.**
- First invocation prompts the dialog; harness records the `ctx.ui.custom` call.
- `[A]` outcome writes `(absPath, name, sha256)` to `pi-workflows.trustedWorkflows`. **Scope detection:** file under `<cwd>/.pi/workflows/` → project settings; file under `~/.pi/agent/workflows/` → personal settings.
- Mutating the file invalidates trust (sha256 mismatch); next run re-prompts with the `"this workflow file has changed since you last trusted it"` warning.
- `[N]` cancels; ledger ends `cancelled-pre-run` with one `cancelled` entry then a terminal `transition`.
- `[V]` opens `$EDITOR`; harness mocks the spawn and asserts the dialog re-shows after exit.
- `--bypass-permissions` (env `PI_BYPASS_PERMISSIONS=1`) skips the dialog AND emits a one-line `pi.sendMessage` banner: `"⚠ pi-workflows: this run is bypassed by --bypass-permissions; sub-agents inherit bypass."` Tested explicitly per oracle flag #4.
- `pi -p` (env `PI_PROMPT_MODE=1`) bypasses **only** if `(absPath, sourceSha256)` is already trusted; otherwise errors with the §3.5 message and run state ends `cancelled-pre-run`.
- `--mock-agents` bypasses approval (test-only path).
- Bypass-pass-through to sub-agents: dispatcher (slice 6) is updated to forward `--bypass-permissions` to the spawned `pi -p` if the parent has it set. Tested via subprocess mock.

**Verification.**
- `npm run test:integration -- approval.test.ts`

**Dependencies.** Slice 8a (RunCtx and RunManager exist for approval to gate the start). Slice 6 is touched (pass-through wiring) — coordinate the dispatcher's env-merge update via the same diff.

**Risks.**
- The bypass-banner text is user-visible; oracle was explicit it must be "announced loudly." Critic must verify the exact-wording test exists.
- `pi -p` strict mode is a deliberate parity drift (see §14 row 16) — error message must include the recovery instruction ("run interactively first to grant trust").
- Trust write is atomic — use pi's settings-write API if available; otherwise read-modify-write with a temp file + rename.

**Builder brief outline.**
1. Build `trustStore.ts`: read/write `pi-workflows.trustedWorkflows` via `pi.settings`; scope detection by absPath prefix-match.
2. Build `bypass.ts`: read env vars; return `{ bypass: bool, banner?: string, reason: 'flag' | 'sdk' | 'mock' | 'pi-p-trusted' | 'pi-p-untrusted' }`.
3. Build `approvalDialog.tsx`: 4-outcome `ctx.ui.custom`. Y/A/V/N keystroke handlers.
4. Wire into `workflowCmd.ts`: pre-handler checks bypass → if bypassed, emit banner and proceed; else if trusted, proceed; else show dialog.
5. Update dispatcher (slice 6) to inherit `--bypass-permissions` env when parent has it.
6. Tests cover all bypass paths AND the new strict `pi -p` path.

**Critic checklist.**
- The bypass banner is **exactly** `"⚠ pi-workflows: this run is bypassed by --bypass-permissions; sub-agents inherit bypass."` — matches PRD §7.5 / oracle flag #4. Test asserts byte-for-byte.
- `pi -p` first-time error message contains the literal `"not yet trusted; run interactively first to grant trust"`.
- Trust write happens to the correct settings scope (project vs personal) based on absPath prefix.
- Sha256 mismatch warning text includes `"this workflow file has changed since you last trusted it"`.
- The dialog is dismissed on `[N]` with the run state ending `cancelled-pre-run` AND the ledger having exactly one `cancelled` entry.

**Estimated complexity.** M (~250 LOC).

---

### Slice 10 — Result delivery + finishCallback firing + index + full disable knobs

**Goal.** When `main()` resolves, deliver the result via `pi.sendMessage` summary card; if `ctx.finishCallback` was queued, fire `pi.sendUserMessage`. Write `<runId>/result.json`. Update active-runs `pi.appendEntry` index. Finalize the disable-knobs (env, setting, recursive guard `PI_WORKFLOWS_RECURSIVE`). **End of v0.1.** Tier: v0.1.

**Files touched.**
- `src/runManager.ts` (extend) — result/error path: write `result.json`, send summary, fire finishCallback, append to runs index.
- `src/index.ts` (extend) — full disable-knob check at extension load (env first, then setting, then recursive guard).
- `src/commands/workflowCmd.ts` (extend) — when `PI_WORKFLOWS_RECURSIVE=1` is set, `/<workflowName>` invocation errors with `"workflows are disabled in nested pi sessions"`.
- `tests/integration/resultDelivery.test.ts`
- `tests/integration/disableKnobs.test.ts`

**PRD references.** §3.6 (disable knobs), §3.8 (result delivery), §3.9 (finishCallback), §6.6 (active-runs index).

**Acceptance.**
- String result → sent verbatim via `pi.sendMessage` AND stored at `result.json`.
- Object result → JSON-stringified preview (first 400 chars) in summary card; full result at `result.json`.
- Reject → `❌` card with error message; ledger transitions to `failed`.
- `finishCallback` queued during `main()` fires AFTER `main()` resolves AND after ledger flush AND before extension control returns.
- Active-runs index gets `pi-workflows.run.started` and `pi-workflows.run.ended` entries via `pi.appendEntry`.
- `PI_WORKFLOWS_RECURSIVE=1` env → extension loads but `pi.registerCommand` is skipped for workflows; `/workflows` overlay also skipped; `/<workflowName>` (if somehow invokable) errors.
- `pi-workflows.disabled: true` setting → no commands registered, no overlay, single `ctx.log.info` line emitted.
- `PI_DISABLE_WORKFLOWS=1` env wins over the setting; the setting is not even read.

**Verification.**
- `npm run test:integration -- resultDelivery.test.ts disableKnobs.test.ts`
- Manual: in a real pi session, set `PI_DISABLE_WORKFLOWS=1` and confirm extension never registers commands.

**Dependencies.** Slice 9.

**Risks.**
- Ordering: `finishCallback` firing must happen AFTER `Run.promise` resolves but BEFORE the slash-command handler returns (otherwise the LLM doesn't see the follow-up). Confirm with an explicit ordering test.
- The `result.json` write must be atomic (temp + rename) so a partial write doesn't poison resume.

**Builder brief outline.**
1. Result delivery logic: format summary card, write `result.json`, call `pi.sendMessage`, then if finishCallback queued call `pi.sendUserMessage`.
2. Disable knobs: refactor slice-1 stub into a 3-tier check (env / setting / recursive). Recursive case still loads the extension (so `/workflows` is recognized as a slash command name) but errors on invocation.
3. Active-runs index hooks at run-start and run-end.
4. Tests cover string-result, object-result, reject, and all 3 disable knobs.

**Critic checklist.**
- `result.json` write is atomic (temp + rename verified by inspecting the code path).
- finishCallback fires AFTER `Run.promise` resolves (assert with a delayed-resolve fixture).
- `❌` card on reject contains `error.message`; long error messages are truncated to ≤400 chars in the preview but the full one is in `result.json`'s `error` field.
- `PI_DISABLE_WORKFLOWS=1` short-circuits BEFORE setting is read (verify by mocking `pi.settings.get` and asserting it's never called when env is set).
- `PI_WORKFLOWS_RECURSIVE=1` results in the documented user-visible message in the conversation, not a silent failure.

**Estimated complexity.** M (~200 LOC). End of v0.1 — internal dogfood-able after this slice.

---

### Slice 11 — Resume from disk + crash sweep on session_start

**Goal.** `/workflows resume <runId>` reconstructs run state from disk and continues execution; `session_start` sweeps `<runs>/` for orphaned manifests and transitions them to `failed: parent-crash`. Adds non-overlay sub-commands (`list`, `show`, `kill`). Tier: v0.5.

**Files touched.**
- `src/runManager.ts` (extend) — `resume(runId)`, ledger replay, cache replay.
- `src/runtime/crashSweep.ts` — scan logic + parentPid+lstart liveness check (Linux `/proc`, macOS `ps -o`).
- `src/commands/workflowsCmd.ts` — `/workflows resume`, `list`, `show`, `kill` handlers.
- `tests/integration/resumeAfterCrash.test.ts`
- `tests/integration/crashSweep.test.ts`

**PRD references.** §5.7 (pause boundary — informs resume entry path), §5.8–5.8.2 (resume from disk + `--latest` + crash sweep), §3.3 (slash commands list/show/kill).

**Acceptance.**
- `resumeAfterCrash.test.ts`: a 3-phase workflow runs to phase 2/3, the test forcibly aborts the run, then re-instantiates the harness and calls `/workflows resume <runId>`. The previously-completed agents are served from cache (asserted via `cached: true` in their AgentResult); only the remaining phase-3 agents are dispatched. Final result matches a non-crashed run.
- `crashSweep.test.ts`: drop a synthetic `<runId>/manifest.json` with a `parentPid` of a non-existent PID; on session_start the sweep transitions it to `failed: parent-crash` and emits a `pi-workflows.run.transitioned` event.
- `--latest` reload prints the warning per §5.8.1 verbatim.
- `/workflows list` prints active + recent runs as a table.
- `/workflows show <runId>` prints manifest + last 50 ledger entries.
- `/workflows kill <runId>` aborts the run.
- Concurrent crash sweep across two pi processes: only the dead-parent's runs are touched (verified by checking parentStartTime as well as PID).

**Verification.**
- `npm run test:integration -- resumeAfterCrash.test.ts crashSweep.test.ts`

**Dependencies.** Slice 10.

**Risks.**
- Resume reads the **frozen** `<runId>/script.js` (not the live file). Verify by editing the live file mid-test and asserting the resumed run uses the frozen copy.
- Crash sweep's `/proc/<pid>/stat` parsing is Linux-specific; macOS path uses `ps -o`. Cross-platform abstraction lives in `crashSweep.ts`.
- A race exists where two pi processes both decide to sweep the same orphan; both writes to the ledger are append-only so the worst case is duplicate `transition(...,parent-crash)` entries — reader skips duplicates (idempotent).

**Builder brief outline.**
1. `resume(runId)`: validate runId; load `script.js`, manifest, ledger, cache; construct fresh sandbox + RunCtx with `ctx.run.resumed = true`; re-execute. Cache hits cover already-completed agents.
2. Crash sweep: glob `<workflowsHome>/runs/*/manifest.json`; for each, read latest transition; if non-terminal, check parentPid liveness via `os.platform()`-dispatched check; if dead, append failed transition.
3. Non-overlay sub-commands: implement `list`, `show`, `kill` per §3.3 table.
4. Tests as listed.

**Critic checklist.**
- Resume uses frozen script.js, not the live file.
- `parentStartTime` check is correct on both platforms (PID alone is recyclable).
- `--latest` warning is byte-for-byte the message in §5.8.1.
- `/workflows list` output is parseable by humans (table with runId, name, state, age columns).
- The crash sweep is idempotent — running it twice produces no additional ledger entries.

**Estimated complexity.** L (~280 LOC). On the line; if it overflows, split off `crashSweep.ts` into slice 11b (defer the sweep to next slice).

---

### Slice 12 — Cooperative pause / resume

**Goal.** `pause(runId)` flips a `paused` flag; the semaphore-acquire wrapper waits on a resume event when paused. New agents do not start while paused; in-flight agents finish. Tier: v0.5.

**Files touched.**
- `src/runManager.ts` (extend) — `pause(runId)`, `resume(runId)`; `paused` flag on `Run`; resume event emitter.
- `src/runtime/dispatcher.ts` (extend) — semaphore-acquire wraps a `while (run.paused) await waitForResume()` loop.
- `tests/integration/pauseResume.test.ts`

**PRD references.** §5.7 (pause/resume cooperation).

**Acceptance.**
- `pauseResume.test.ts`: in a 2-phase, 4-agent workflow, pause is signaled mid-phase-2; no new agents start; in-flight agent finishes; state transitions to `paused`. Resume signal: state transitions back to `running`; remaining agents complete; final result matches non-paused run.
- Ledger has `pause` then `resume` entries between agent_start records.
- Pausing twice is idempotent (no second ledger entry); resuming an already-running run is a no-op.
- Pause + abort race: if abort is signaled while paused, the run transitions to `stopped`, NOT `paused`; the abort wins.

**Verification.**
- `npm run test:integration -- pauseResume.test.ts`

**Dependencies.** Slice 10.

**Risks.**
- Wait-for-resume loop must drop the semaphore acquire while waiting (otherwise pausing wedges other runs sharing the cap). Subtle: the acquire happens AFTER the pause check, not before.
- Listener cleanup on abort during pause.

**Builder brief outline.**
1. Add `paused: boolean`, `resumeSignal: AbortSignal-like` to `Run`.
2. Modify dispatcher's pre-spawn block: check `run.paused`; if true, await resume signal OR abort signal (race); on abort win, throw AbortError.
3. Implement `pauseRun` / `resumeRun` on RunManager; write ledger entries.
4. Tests as listed.

**Critic checklist.**
- Pause does NOT hold the semaphore (verify by pausing run A and confirming run B's agents still progress under cap).
- Pause+abort race: abort wins and transitions to `stopped`.
- Pause is idempotent on second call.
- Resume of a non-paused run is a no-op (no ledger entry, no error).
- The `paused → running` transition is recorded with a `resume` ledger entry in addition to the `transition` entry.

**Estimated complexity.** S (~150 LOC).

---

### Slice 13 — TUI overlay framework + runs list view

**Goal.** `/workflows` opens an overlay via `ctx.ui.custom`; runs-list view shows active + recent runs with hotkey navigation. Subscribes to `pi-workflows.run.*` events. Coexists with conductor's `Ctrl+G` overlay using the push/pop model decided in slice 0's spike (or close-other fallback). Tier: v0.5.

**Files touched.**
- `src/ui/overlay.tsx` — overlay framework: mount via `ctx.ui.custom`, push-pop state, event subscriptions.
- `src/ui/runsList.tsx` — runs list view; box drawing, navigation, hotkeys (↑↓ jk Enter Esc x g).
- `src/ui/tuiPrimitives.ts` — shared cursor/box helpers.
- `src/commands/workflowsCmd.ts` (extend) — `/workflows` no-arg opens overlay; with-args dispatches to slice-11 sub-commands.
- `tests/integration/overlay.smoke.ts` — manual smoke (per §12.5).
- `tests/unit/runsList.render.test.ts` — pure-function snapshot of the render output.

**PRD references.** §10.1–10.3 (activation + views + wireframes), §10.4–10.4.2 (hotkeys), §10.5–10.6 (event subscriptions + debounce), §10.8 (coexistence with conductor — feeds from slice 1 spike), §10.9 (no overlay in non-TTY mode).

**Acceptance.**
- Opening `/workflows` mounts the overlay; closing via Esc unmounts; `pi.events` subscriptions are cleaned up.
- Active runs render with state, phase progress, elapsed time; recent runs render with final state and total duration.
- Hotkeys: ↑↓ jk navigate; Enter goes to phase view (slice 14 stub for now — opens an empty phase view rendered as `[phase view not in this slice]`); Esc closes; x triggers `kill <runId>`; g opens GC dialog (slice 15 stub).
- In non-TTY (`pi -p`) mode, `/workflows` falls back to printing a runs table to the conversation.
- Coexistence with conductor: per slice-0 spike, either push/pop (preferred) or close-other (fallback). Slice loads `SPIKE-FINDINGS.md` answer at build-time. Test asserts the documented behavior.
- Re-opening `/workflows` while it's already open is a no-op.

**Verification.**
- `npm run test:unit -- runsList.render.test.ts`
- Manual: `npm run smoke:overlay` (script under `tests/integration/overlay.smoke.ts`) starts a fake pi with 3 fixture runs, opens overlay, exercise hotkeys.

**Dependencies.** Slices 0 (consumes `SPIKE-FINDINGS.md` for overlay-nesting decision) and 10.

**Risks.**
- Snapshot-test harness for `ctx.ui.custom` doesn't exist (per §12.5). The pure-function render unit test sidesteps this by separating render from mount.
- Push/pop coexistence depends on slice-0 spike; if push/pop doesn't work, fallback (close-other) emits a one-line warning per §15.D.

**Builder brief outline.**
1. Read `SPIKE-FINDINGS.md`; encode the chosen mode as a constant in `overlay.tsx`.
2. Build `overlay.tsx`: mount via `ctx.ui.custom`; on mount, subscribe to events; on unmount, unsubscribe; expose a view-stack (runs list, phase view, agent detail) with current-view pointer.
3. Build `runsList.tsx`: pure function `(state) => RenderedFrame`; bind hotkeys to handlers (handlers can be stubs for slice 14/15 actions).
4. Non-TTY fallback: `if (!process.stdout.isTTY) { print runs table; return; }`.
5. Tests: pure-function snapshot test for runsList; manual smoke harness.

**Critic checklist.**
- The overlay subscribes to ALL of `pi-workflows.run.started/transitioned/ended` (per §10.5 table).
- Subscriptions are removed on `done()` (memory-leak guard).
- Non-TTY fallback prints the SAME data as the runs list view (so SDK users get the same info).
- The render is debounced per §10.6 (50ms throttle on `tui.requestRender()`).
- Re-opening `/workflows` is a no-op (verify with a counter on the mount function).

**Estimated complexity.** L (~280 LOC). On the line; consider splitting overlay framework + runs list view if it overflows.

---

### Slice 14 — Overlay phase view + `s` save-script

**Goal.** Phase view shows phases and agents within a selected run; `p` pauses, `r` resumes/restarts, `x` stops, `s` saves the script.js to the project's `.pi/workflows/` with collision handling and git-add prompt. Tier: v1.0.

**Files touched.**
- `src/ui/phaseView.tsx`
- `src/ui/overlay.tsx` (extend) — phase view route from runs list Enter.
- `src/ui/saveScript.ts` — project-root walk per §15.C, collision UX, git-add helper.
- `tests/unit/phaseView.render.test.ts`
- `tests/unit/saveScript.test.ts`

**PRD references.** §10.3 (phase wireframe), §10.4 (hotkeys), §10.4.1 (`r` semantics), §10.7 (save-script detail), §15.C (project-root walk).

**Acceptance.**
- Enter on a runs-list row opens phase view; Esc returns to runs list.
- Phases render with progress (✓ done, ▸ active, · pending) and agent rows underneath active phase.
- `p` pauses the selected run if running; ledger entry written.
- `r` semantics per §10.4.1: paused → resume; terminal → restart with NEW runId, fresh cache, copied script.js. `running` and `pending`/`approved` are no-ops.
- `x` stops the run; transitions to `stopped`.
- `s` triggers save-script: walks up from `cwd` looking for `.git` or `.pi`; if neither found within 8 levels, errors `"no project root found"`. If found, copies `<runId>/script.js` to `<projectRoot>/.pi/workflows/<name>.js`. On filename collision, prompts overwrite/rename. Asks `"Add to git? (y/n)"`; on `y` runs `git add`. Warns if `.gitignore` ignores `.pi/`.
- `s` from a project-scoped workflow source is a no-op (already in `.pi/workflows/`); show a one-line message.

**Verification.**
- `npm run test:unit -- phaseView.render.test.ts saveScript.test.ts`

**Dependencies.** Slice 13.

**Risks.**
- The 8-level project-root walk depth: oracle locked at 8, tunable. If a user has nested workspaces, this may misbehave; documented in §15.C.
- The git-add helper must be safe in non-git directories (skip silently with a warning).

**Builder brief outline.**
1. Build `phaseView.tsx`: render per §10.3 wireframe; cursor over agents; live update on `pi-workflows.phase.*` and `pi-workflows.agent.*` events.
2. Build `saveScript.ts`: walk-up logic; collision handling; git-add wrapper.
3. Hotkey handlers: p/r/x/s.
4. Tests for render snapshot and save-script logic.

**Critic checklist.**
- `r` on a `done` run creates a NEW runId and the OLD runId's directory is NOT touched.
- `s` from a project-scoped source is correctly identified as no-op.
- Project-root walk depth is exactly 8 levels.
- Git-add is skipped silently when no `.git` is present.
- Collision UX has 3 outcomes: overwrite, rename, cancel.

**Estimated complexity.** L (~280 LOC). Boundary; if save-script logic balloons, split it into 14b.

---

### Slice 15 — Overlay agent detail + GC dialog + transcript open

**Goal.** Agent detail view with prompt + transcript live tail, `t` opens transcript in `$EDITOR`, `c` copies prompt via clipboard chain (`pbcopy`/`xclip`/`xsel`). GC dialog (`g` from runs list) lists candidate runs and confirms deletion. Tier: v1.0.

**Files touched.**
- `src/ui/agentDetail.tsx`
- `src/ui/gcDialog.tsx`
- `src/ui/overlay.tsx` (extend) — agent detail route, GC dialog route.
- `src/runtime/gc.ts` — terminal-state filter, age filter, deletion logic with `--dry-run` support.
- `tests/unit/agentDetail.render.test.ts`
- `tests/unit/gc.test.ts`
- `tests/integration/gcCommand.test.ts`

**PRD references.** §10.3 (agent detail wireframe), §10.4 (hotkeys), §6.7 (GC policy), §3.3 (`/workflows gc` command — already partially in slice 11 but the dialog is here).

**Acceptance.**
- Enter on a phase-view agent row opens agent detail.
- Live tail shows last N lines of `agents/<agentId>.jsonl`; updates on `pi-workflows.agent.log` events.
- `t` opens transcript in `$EDITOR`; falls back to a read-only ctx.ui.custom if `$EDITOR` is unset.
- `c` copies via clipboard chain: try `pbcopy` (macOS), then `xclip`, then `xsel`; if all fail, show a notification with the prompt instead.
- `g` from runs list opens GC dialog; lists deletable runs (terminal state AND `endedAt` > `gcAfterDays` ago); user confirms; `--dry-run` flag (also from `/workflows gc --dry-run`) skips deletion.
- `gcAfterDays` setting: default 30, 0 disables, ≥5475 (15yr) clamped to 5475.
- `gcCommand.test.ts` asserts the command-line and dialog paths produce identical filter results.

**Verification.**
- `npm run test:unit -- agentDetail.render.test.ts gc.test.ts`
- `npm run test:integration -- gcCommand.test.ts`

**Dependencies.** Slice 14.

**Risks.**
- `$EDITOR` may be a multi-word command (e.g. `code -w`); split on whitespace, not just first-word.
- Clipboard fallback chain order matters; `xsel` after `xclip` is the convention.
- GC deletion: ensure no concurrent run holds the runDir (verify ledger latest state is terminal AND no live `pi.appendEntry` index entry).

**Builder brief outline.**
1. Build `agentDetail.tsx`: render per §10.3 wireframe; subscribe to `pi-workflows.agent.log` only when this view is mounted.
2. Build `gcDialog.tsx` + `gc.ts`: filter logic, deletion logic, dry-run flag.
3. Implement clipboard helper; transcript-open helper.
4. Tests as listed.

**Critic checklist.**
- `t` on a system without `$EDITOR` opens a read-only TUI view, not crashes.
- `c` clipboard chain falls through correctly when none are available; user-visible message includes the prompt content.
- GC filter: a run whose latest transition is `running` is NEVER deleted (regardless of how old).
- GC dry-run path produces identical output to non-dry-run minus the actual deletion.
- `gcAfterDays: 0` does NOT delete anything (disables GC).

**Estimated complexity.** L (~280 LOC). Split if it overflows.

---

### Slice 16 — Hot-reload via chokidar

**Goal.** File-watcher rebuilds the registry on `add`/`change`/`unlink` in both workflow directories; in-flight runs unaffected. Tier: v1.0.

**Files touched.**
- `src/registry.ts` (extend) — chokidar watcher; debounced rebuild; diff against current slash-command set.
- `tests/integration/hotReload.test.ts`

**PRD references.** §3.1 (hot-reload), §12.3.4 (test).

**Acceptance.**
- Adding a new workflow file → slash command available within 200ms.
- Modifying a workflow file → new invocations use new script; in-flight run continues with old script (test-driven by checking `ctx.run.workflowSourceSha256` matches the original at run start).
- Deleting a file → slash command unregistered.
- Adding a `.ts` file → ignored with warning.
- Adding a reserved-name file → skipped with warning.
- Watcher tracks both `<cwd>/.pi/workflows/` and `~/.pi/agent/workflows/`.

**Verification.**
- `npm run test:integration -- hotReload.test.ts`

**Dependencies.** Slice 1 (registry; nothing else, this is a leaf).

**Risks.**
- chokidar event coalescing: an editor's atomic-save (write tempfile + rename) fires `unlink` + `add`; we should debounce 100ms before rebuilding to coalesce.
- Watching `~/.pi/agent/workflows/` from inside a sandboxed CI environment may fail if the dir doesn't exist; handle gracefully.

**Builder brief outline.**
1. Add chokidar dep.
2. On registry init, attach watchers to both dirs (create dirs if missing).
3. On event, schedule a rebuild via 100ms debounce.
4. Rebuild produces a diff `(added, removed, changed)`; calls `pi.registerCommand` / `pi.unregisterCommand` accordingly.
5. In-flight runs hold their own script reference (already true from slice 8a); confirm with a test that mutates the file mid-run.

**Critic checklist.**
- chokidar's `awaitWriteFinish: true` is used to avoid mid-write events.
- Atomic-save (rename) doesn't double-register (debounce works).
- In-flight run's `workflowSourceSha256` is unchanged after a file modification.
- Watcher is attached/detached on extension load/unload.
- Reserved-name file added at runtime is skipped with a warning, not registered.

**Estimated complexity.** S (~150 LOC).

---

### Slice 17 — Bundled `/codebase-audit` + install path + integration test

**Goal.** Ship `examples/codebase-audit/codebase-audit.js` per §9.2; install via `pi.workflows` manifest field (verified by slice 1 spike) OR fallback `installBundled` setting. Plus the two trivial example workflows. Bundled-workflow integration test passes. Tier: v1.0.

**Files touched.**
- `examples/codebase-audit/codebase-audit.js` (the §9.2 reference script)
- `examples/codebase-audit/README.md`
- `examples/hello/hello.js` (10-line trivial)
- `examples/hello/README.md`
- `examples/parallel-translation/translate.js` (showcases `vote`)
- `examples/parallel-translation/README.md`
- `package.json` (extend) — `pi.workflows` field.
- `src/index.ts` (extend) — if slice-0 spike showed `pi.workflows` unsupported, implement fallback `installBundled` setting that copies bundled files to `~/.pi/agent/workflows/` on first session_start.
- `tests/integration/bundledWorkflow.test.ts`
- `tests/fixtures/codebase-audit/repo/` — fixture repo for the audit to scan.
- `tests/fixtures/codebase-audit/fixtures.jsonl` — canned agent responses for recon, analyze, vote, summarize.

**PRD references.** §9.1–9.5 (bundled workflow), §15.9 (manifest field — feeds from slice 1).

**Acceptance.**
- `bundledWorkflow.test.ts` runs `/codebase-audit` in mock-agents mode against the fixture repo. Asserts final result has shape `{ runId, cwd, findingsConsidered: number, top10: array, report: string }`.
- Running twice asserts ≥1 cache hit on the second run.
- The Borda count produces the documented top 10.
- If slice-0 spike showed `pi.workflows` unsupported: extension's session_start hook copies `examples/codebase-audit/codebase-audit.js` to `~/.pi/agent/workflows/` if not already present; setting `pi-workflows.installBundled: false` opts out.
- All three example workflows have a `README.md` describing what they demonstrate.
- The bundled `codebase-audit.js` is byte-for-byte the §9.2 reference script (with optional formatting tweaks).

**Verification.**
- `npm run test:integration -- bundledWorkflow.test.ts`
- Manual: `pi install ./` (or `npm pack` + simulate) places `codebase-audit.js` in `~/.pi/agent/workflows/`.

**Dependencies.** Slices 0 (consumes `SPIKE-FINDINGS.md` for `pi.workflows` install-path decision), 8b (vote helper used by parallel-translation), 9 (approval flow — bundled workflow needs to flow through trust), 10 (full v0.1 done).

**Risks.**
- The §9.2 reference script's exact behavior depends on canned mock fixtures; designing the fixtures to produce a deterministic Borda count is a small puzzle.
- If `pi.workflows` is unsupported, the fallback `installBundled` setting must handle the project-scope case correctly (only personal scope, never project).

**Builder brief outline.**
1. Copy §9.2 script to `examples/codebase-audit/codebase-audit.js`.
2. Build the fixture repo: 4-5 trivial source files spanning multiple "areas" so the recon agent's mock can return a sensible area list.
3. Build `fixtures.jsonl` with canned responses keyed by `(agentId, promptHash)` for: 1 recon, N analyze, 3 vote, 1 summarize.
4. Implement `installBundled` fallback if needed.
5. `bundledWorkflow.test.ts` invokes `/codebase-audit` and asserts the result shape + cache-hit behavior.

**Critic checklist.**
- Test is deterministic (same Borda result on every run).
- Cache-hit test asserts the expected agents (recon, analyze-*) hit cache on second run; vote and summarize do NOT (the cache is keyed by prompt, and vote/summarize prompts include the run-specific findings JSON).
- `installBundled` fallback (if used) writes only to `~/.pi/agent/workflows/`, never to project.
- Example READMEs describe input/output contract.
- The bundled script is shape B (`export default async function main`) per §4.1 recommendation.

**Estimated complexity.** M (~250 LOC of code + fixtures + small READMEs; ~11 files — over the soft 8-file cap because each example workflow ships with its own README and the audit fixture repo has multiple files. Splitting into 17a (bundled audit) and 17b (other examples) is possible but adds churn without behavior gain. Default: keep as one slice; the file count is data-heavy, not implementation-heavy.).

---

### Slice 18 — Docs + skills + CHANGELOG + npm publish dry-run

**Goal.** Production-quality documentation, authoring skill, CHANGELOG, and a clean `npm publish --dry-run`. Final v1.0 release.

**Files touched.**
- `docs/authoring.md` — long-form author guide; how to write a workflow, common patterns.
- `docs/api-reference.md` — autogen-or-hand-written from `src/types/public.d.ts`.
- `docs/integration-testing.md` — how to use mock-agents + fixtures.
- `docs/parity-gaps.md` — mirrors §14 of PRD.
- `docs/threat-model.md` — mirrors §8.
- `README.md` — full polish; runnable quick-start; link to docs/.
- `CHANGELOG.md` — `0.1.0` (initial release) entry covering all v1.0 features.
- `LICENSE` (MIT, matching pi-conductor).
- `skills/pi-workflows-author/SKILL.md` — pi-skill teaching how to author workflows.
- `package.json` (extend) — `pi.skills` field references the skill.
- `.npmignore` — final cut (excludes tests/, fixtures/, scripts/, but includes dist/, examples/, skills/, docs/, README.md, PRD.md, LICENSE).

**PRD references.** §11.1 (directory tree — finalized), §11.6 (npm scope), §12.8 (manual smoke procedure).

**Acceptance.**
- `npm publish --dry-run` succeeds; output lists the expected files (no source TS, no test fixtures).
- All five docs files exist; `docs/parity-gaps.md` and `docs/threat-model.md` are byte-for-byte mirrors of §14 and §8 (or close enough that drift can be detected via a CI diff check).
- README has a 5-line quick-start that copy-pastes to `npm install @samfp/pi-workflows && /codebase-audit`.
- CHANGELOG covers every public-facing feature shipped in slices 1-17.
- The authoring SKILL.md is loaded by pi when `npm:@samfp/pi-workflows` is installed (per §11.2 `pi.skills` field).
- Manual smoke procedure §12.8 is documented in CONTRIBUTING.md (or README.md§Manual Smoke).
- All public types in `src/types/public.d.ts` are documented in `docs/api-reference.md`.

**Verification.**
- `npm publish --dry-run` (output captured for review).
- `npm pack && tar -tf @samfp-pi-workflows-*.tgz` lists exactly the expected files.
- Read-pass: `cat README.md docs/*.md skills/*/SKILL.md` and visually verify quality.

**Dependencies.** Slices 15, 16, 17 (full feature set landed).

**Risks.**
- Doc drift: `parity-gaps.md` and `threat-model.md` must stay in sync with PRD §14 and §8. CI check: a small script that diffs docs against PRD section excerpts and fails on drift.
- `npm publish --dry-run` may surface missing `bin` entries, missing `peerDependencies`, or wrong `files` — finalize before tagging.
- The skill must use the exact slash-command syntax pi expects.

**Builder brief outline.**
1. Write `docs/authoring.md`: 2-page guide; example walkthrough using the bundled `/codebase-audit`.
2. Write `docs/api-reference.md`: enumerate `WorkflowContext`, `AgentHandle`, `AgentResult`, `Cache`, `RunMeta`; one section each, with code examples.
3. Write `docs/integration-testing.md`: explain mock-agents path, how to build fixtures.jsonl, how to drive a workflow under `tests/`.
4. Mirror PRD §14 → `docs/parity-gaps.md`; PRD §8 → `docs/threat-model.md`.
5. Polish README: hero, install, quick-start, link to docs/.
6. CHANGELOG entry covering every shipped feature.
7. Authoring skill: SKILL.md teaching pi to write workflows on user request.
8. `npm publish --dry-run` clean; commit.

**Critic checklist.**
- README quick-start actually works end-to-end (copy-paste, run, see workflow execute).
- `docs/parity-gaps.md` lists ALL 19 entries from PRD §14 (no silent gaps).
- `docs/threat-model.md` enumerates all known escape vectors from §8.3.
- CHANGELOG mentions both v0.1 / v0.5 / v1.0 milestones for users following the cut.
- Authoring skill includes a section on `--mock-agents` for writing tests.
- `npm publish --dry-run` output excludes `tests/`, `scripts/`, `tsconfig*.json`.

**Estimated complexity.** M (~250 LOC, mostly docs).

---

## 5. Cross-cutting concerns

### 5.1 Type definitions

**Two type files**, separated by audience:

- `src/types/internal.d.ts` — types used inside the runtime: `Run`, `Workflow`, `Config`, `LedgerEntry`, `RunState`, `Transition`, `RunOptions`, `CacheRecord`, `MalformedAgentOutputError` shape, etc. Lands incrementally — slice 1 starts it; each subsequent slice extends it via additive changes.
- `src/types/public.d.ts` — author-facing types exposed via the `@samfp/pi-workflows/workflows` import: `WorkflowMain`, `WorkflowContext`, `AgentHandle`, `AgentOpts`, `AgentResult`, `Phase`, `Cache`, `LogOpts`, `RunMeta`. **First cut lands in slice 8a; frozen after that** unless a parity bug is found. The frozen-after-8a contract lets slice 18's `docs/api-reference.md` be drafted from the type file directly without chasing drift.

**Both files are checked into git from slice 1.** No "types live in slice 1, runtime in slice 2" horizontal split. Each slice extends the type file as it adds runtime that needs the types.

The `dist/workflows.d.ts` shipped to npm is built from `src/types/public.d.ts` via `tsc --emitDeclarationOnly`; the runtime stub `dist/workflows.js` is a hand-written 1-line `export {};`.

### 5.2 Test fixtures

**Workflow fixtures** live at `tests/fixtures/workflows/<name>.workflow.js` and `tests/fixtures/workflows/<name>.fixtures.jsonl`. They land per-slice as needed:

| Slice | Fixtures introduced |
|---|---|
| 2 | 9 hostile fixtures under `tests/security/*.workflow.js` |
| 5 | `tests/fixtures/json-stream/*.txt` — synthetic pi-mode-json transcripts |
| 6 | `tests/fixtures/dispatcher/fixtures.jsonl` — sample for mock-agents |
| 8a | `tests/fixtures/workflows/basic.workflow.js` + `.fixtures.jsonl` |
| 8b | `tests/fixtures/workflows/{vote,consensus,parallel,retry}.workflow.js` + matching jsonl |
| 9 | `tests/fixtures/workflows/trusted-workflow.js` |
| 11 | `tests/fixtures/workflows/three-phase.workflow.js` (used for resume-after-crash) |
| 14 | `tests/fixtures/save-script/` (project-root walk fixtures) |
| 17 | `tests/fixtures/codebase-audit/repo/` + `tests/fixtures/codebase-audit/fixtures.jsonl` |

The `fixtures.jsonl` schema is one record per `(agentId, promptHash)` pair: `{ "agentId": "...", "promptHash": "<sha256>", "result": { ...AgentResult... } }`. Documented inline in `tests/helpers/makeFakePi.ts` from slice 1 (even though only used from slice 6 onward — the schema is set early to avoid late-binding churn).

**Helpers:** `tests/helpers/makeFakePi.ts` (in-memory pi runtime stub) lands in slice 1 and is extended additively by later slices. `tests/helpers/makeRunDir.ts` (tmpdir setup/teardown) lands in slice 3 (when the first runtime touches disk).

### 5.3 esbuild bundling

`dist/index.js` is produced from slice 1 onward — every slice rebuilds it as part of `npm test` (the test suite runs the bundled extension under fake-pi, not the raw TS). `dist/` is gitignored. CI rebuilds before tests. The bundled output is what slice 18's `npm publish --dry-run` ships.

`dist/workflows.js` and `dist/workflows.d.ts` are added to the build pipeline in slice 8a (when `src/types/public.d.ts` first contains author-facing types worth shipping).

### 5.4 Versioning during build

| Slice | package.json version | Why |
|---|---|---|
| 1–10 | `0.1.0` | v0.1 cut develops at 0.1.0; not published. |
| 11–13 | `0.5.0` (bump when slice 13 lands and v0.5 is internally tagged) | v0.5 cut development. |
| 14–17 | `0.9.0` (bump when slice 14 lands; signals "approaching v1") | v1.0 development tier. |
| 18 | `1.0.0` (bump as part of slice 18; first `npm publish` happens here) | Release. |

No published artifacts before slice 18. Internal dogfood happens via `npm pack` + local `pi install /path/to/tarball`. CHANGELOG entries land in slice 18 covering the full v0.1 → v1.0 arc.

---

## 6. Verification & finalize plan

### 6.1 Critic loop expectations per slice

Every slice ends with the critic verifying these basics, then the slice-specific checklist from §4:

| Check | Command |
|---|---|
| TypeScript compiles | `npm run build:types` |
| Unit tests pass | `npm run test:unit` |
| Integration tests pass (where applicable) | `npm run test:integration` |
| Security tests pass (where applicable) | `npm run test:security` |
| Lint clean (if linter configured) | `npm run lint` |
| Bundle builds | `npm run build` |
| New tests cover the slice's acceptance criteria | (manual review of test names against slice doc) |
| LOC delta within target | `git diff --shortstat HEAD~1` (≤300 added; ≤8 files unless rationale documented) |

If any check fails, builder loops back; critic does not advance.

### 6.2 Finalizer's checklist for "is v1 done?"

When all 18 slices are landed and committed, the finalizer gates v1.0 release on:

| Gate | Verification |
|---|---|
| All unit tests pass | `npm run test:unit` (zero failures) |
| All integration tests pass | `npm run test:integration` (zero failures) |
| All security tests pass | `npm run test:security` (zero failures) |
| Coverage targets per §12.6 | `npm run coverage` (≥85% line on `src/runtime/` and `src/util/`) |
| Bundle size sanity | `du -h dist/index.js` (informational; v1 has no hard cap, but flagged for monitoring) |
| `npm publish --dry-run` clean | (output reviewed) |
| README quick-start runs end-to-end | manual smoke against a real repo (per §12.8) |
| `docs/` tree complete | 5 files present, link-check via `markdown-link-check` |
| CHANGELOG covers every slice | grep CHANGELOG for each slice's user-visible feature |
| CI integration with pi's CI | pi-coding-agent CI loads the extension and runs `/codebase-audit --mock-agents` against a fixture (per §12.7) |
| Manual smoke per §12.8 | run `/codebase-audit` against `~/scratch/pi-conductor` interactively, observe overlay, hit hotkeys, save script, GC |
| Authoring skill works | pi loads `@samfp/pi-workflows-author` skill; user-prompt "write a workflow that translates input to French" produces a runnable JS file |

A failure on any gate blocks the v1 tag. The finalizer can recommend a v0.5 ship if v1.0 gates fail but v0.5 gates pass.

### 6.3 When do docs land?

**Recommendation: end-of-build (slice 18), not interleaved.** Reasons:

1. The author-facing API is frozen after slice 8a but the **runtime** behaviors (e.g. `r` semantics, save-script collision UX, GC dialog) are still in flux through slice 15. Writing user-facing docs before behaviors stabilize forces rewrites.
2. The `parity-gaps.md` and `threat-model.md` files mirror PRD §14 and §8 — those are stable from now, but mirroring them at the end (not now) lets slice 18 do a single-pass diff check.
3. README's quick-start needs the bundled `/codebase-audit` workflow to exist (slice 17), so cannot ship before then.

**Exception:** the authoring skill (`skills/pi-workflows-author/SKILL.md`) is the one user-facing artifact that benefits from late-binding to the final API surface; slice 18 is correct.

If the conductor wants documentation visible to internal dogfood users at v0.1 (slice 10), a single-page `INTERNAL_DOGFOOD.md` can be added inline to slice 10 — small (≤80 lines), not part of the formal doc tree, no parity gap mirroring. Optional; planner does not mandate.

---

## 7. Risk register

| # | Risk | Trigger | Mitigation | Escalation |
|---|---|---|---|---|
| 1 | Slice 0's overlay-nesting spike returns "no push/pop" | `ctx.ui.custom` mounts the second overlay as a sibling, not a stack | Slice 13 implements close-other fallback per §15.D; emit one-line warning when conductor overlay is closed by `/workflows`. | If close-other is also unworkable, escalate to user: "slice 13 needs design change or skip overlay coexistence in v1." |
| 2 | Slice 0's `pi.workflows` manifest spike returns "unsupported" | `pi install` does not copy listed files | Slice 17 implements `installBundled` setting fallback that the extension self-runs at session_start. | If neither path works, escalate to user: bundled workflow ships as `examples/` only and `/codebase-audit` is documented as "copy this file to `~/.pi/agent/workflows/`". |
| 3 | AggregateError preservation contract is wrong (slice 2) | `wrapHostError()` corrupts `.errors[i].cause` | Slice 8a's `aggregateErrorPropagation.test.ts` will catch; rollback slice 2; redesign with explicit ErrorCloning helper. | Block slice 8a until 2 is fixed. |
| 4 | Ledger fsync blocks slice 8a's perf | per-write fsync is slow enough to make integration tests >50ms per phase | Per-transition fsync (default), batched logs (per-100ms or 32 entries). Documented in slice 7. | Revisit slice 7 if integration tests show wall-time issues; do NOT downgrade durability silently. |
| 5 | prctl wrapper compilation fails on macOS / musl | `cc` errors in postinstall | Postinstall compiles only on Linux + glibc; falls back to ppid-poll on others. Documented in slice 6. | If no orphan-prevention path works for a platform, document as a parity gap; no escalation needed. |
| 6 | `pi -p` strict mode confuses users | first invocation under `pi -p` errors | Error message includes recovery instruction (per §3.5). Documented in `parity-gaps.md` as deliberate hardening. | If user feedback shows this is too strict, configurability lands in v2 (PRD §15.B). |
| 7 | Slice 13's render snapshot tests are unreliable | `ctx.ui.custom` has no documented snapshot harness | Pure-function render unit tests sidestep mount; manual smoke covers integration. Per §12.5 documented gap. | Backfill at first opportunity; v1 ships with manual smoke only. |
| 8 | Bundled workflow's mock fixtures are non-deterministic | The Borda count test flakes | Fixture authors must include explicit response text in `fixtures.jsonl`; Borda inputs are deterministic by construction. Slice 17 critic verifies determinism with a 100-run loop. | If flake is observed in CI, freeze fixtures to bytes and explain why in test comments. |
| 9 | Conductor coexistence breaks when both extensions are loaded | Two semaphores, two overlays, two event subscriptions | Documented startup warning per §1.2 row 2. Push/pop overlay (or close-other fallback). No shared state. | If users report cross-extension confusion, design a shared-semaphore primitive in v2. |
| 10 | npm publish from slice 18 ships unexpected files | `.npmignore` misses something | `npm pack && tar -tf` review by critic; `npm publish --dry-run` output reviewed line by line. | If a leak ships, immediate `npm deprecate` and patch release. |

---

## 8. Open questions for designer

The PRD is sufficient. Two items I'd like the designer to **confirm or correct**, but neither blocks slicing:

1. **§7.5 bypass-pass-through wording in the user-visible banner.** PRD says "loud announcement"; I've pinned the exact text in slice 9 acceptance:

   `"⚠ pi-workflows: this run is bypassed by --bypass-permissions; sub-agents inherit bypass."`

   Confirm the wording or supply a replacement. Default: above text ships.

2. **Slice 6 splitting policy.** The dispatcher (slice 6) is on the LOC boundary at ~280. If the prctl wrapper + macOS fallback inflate to >300 LOC, I propose splitting into 6a (core dispatch + mock branch) and 6b (parent-death wrapper), shipping 6a for v0.1 (orphans documented as a known sharp edge until 6b lands in v0.5). Confirm or override. Default: keep as one slice; split only if 300 LOC hard cap is reached.

---

## 9. Open questions for the user (conductor escalates)

None. All slicing decisions are made with defaults. Specifically:

- **v0.1 cut: slim end-to-end** (slices 0–10; slice 0 is research-only, slices 1–10 are the code cut). Matches PRD §15.1 "slim" candidate.
- **Sandbox + dispatcher: split** (slices 2 + 6, distinct). Matches §15.2's "two slices" option with an additional gate (slice 6 needs slice 7's ledger interface defined; the type stubs from slice 1 cover the cross-slice contract).
- **Bundled workflow lands late** (slice 17). PRD §15.3 recommended "early-as-test-fixture, late-as-shipped-example" — I've gone late-only because the API is settled by slice 8a and an early dogfood doesn't pay for itself in this DAG (the bundled fixtures would need to be rewritten as the API stabilizes).
- **TUI overlay incremental** (slices 13/14/15, three slices). Matches §15.4's "incremental" option. Atomic would be a single >700 LOC slice — reject.
- **GC manual** (slice 15). Matches §15.8 default.

If the conductor wants any of these flipped, escalate now; otherwise ready for builders.
