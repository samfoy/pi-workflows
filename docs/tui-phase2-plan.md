# TUI Redesign — Phase 2 Build Plan

**Scope:** phaseMeta data flow, spinner animation, state grouping, card pipeline view, width-responsive columns, peek panel, filter mode, task panel.  
**Spec:** `docs/tui-redesign.md` Phase 2 sections (§2a–§2e, spinner, phaseMeta, task panel).  
**Test run (fast path):** `node --import tsx --test tests/unit/runsList.test.ts tests/unit/hotkeys.test.ts tests/unit/phaseView.test.ts tests/unit/activeRuns.test.ts`  
**Full suite:** `npm test`

---

## Architectural notes before slicing

### Task panel: `ctx.ui.setStatus` — no spike needed

`ExtensionContextLike.ui.setStatus?(key: string, text: string | undefined): void` is already declared in `src/types/internal/extension.d.ts`. This is the pi SDK footer-status hook. Call it with a stable key (`'pi-workflows'`) whenever run state changes; pass `undefined` to clear. No new SDK investigation needed — implement directly in Slice 11.

### `RunSummary.hasPendingInterrupt` — needed for grouping

State grouping requires distinguishing "running with pending interrupt" from plain "running". The `_pendingInterrupts` map added in Phase 1 (slice 15/16) lives in `overlay.ts`. For the renderer to group correctly, this signal must reach `RunSummary`. Add `hasPendingInterrupt?: boolean` and let the overlay patch the summary when an interrupt is requested/resolved.

### Card layout: keep `renderPhaseViewFlat` as a fallback

`renderPhaseView` becomes `renderPhaseViewCards` internally. The old flat renderer moves to unexported `_renderPhaseViewFlat`. `overlay.ts` always calls the card variant. Existing `overlayPhaseView.test.ts` snapshot assertions on `lines[]` are migrated to `cards[i].lines[j]`.

### `PhaseViewCard` is the unit test seam

Each card is independently testable: `renderPhaseViewCards(…).cards[0]` has a `.lines` array, a `.title`, a `.statusBadge`, and `.description?`. Tests assert on `cards[i]` directly, not on the composite `lines[]` (which includes DAG arrows and section padding).

### phaseMeta data flow

```
workflow meta.phases[].description
  → extractMetaPhases() in runManager.ts          (Slice 1)
  → PhaseFeedEntry.phases[].description           (Slice 1)
  → PhaseSnapshot.description                     (Slice 1)
  → manifest.json phaseMeta field                 (Slice 2)
  → renderPhaseViewCards() phase.description      (Slice 7)
```

Disk-hydrated runs (Phase 1 B1) load `phaseMeta` from `manifest.json` so descriptions are visible even for completed runs.

---

## Slice order

```
Slice 1 → Slice 2    (phaseMeta: extract → persist)
Slice 3              (spinner setInterval — independent)
Slice 4              (RunSummary.hasPendingInterrupt + state grouping)
Slice 5              (width-responsive columns — independent)
Slice 6              (peek panel — independent)
Slice 7              (filter mode — independent)
Slice 8 → Slice 9   (card layout renderer → integrate + test migration)
Slice 10             (task panel via setStatus — independent)
Slice 11             (public API + authoring docs — last)
```

Slices 3–7 are independent of each other and of 1–2. Slice 8 depends on Slices 1–2 (for `description`) and Slice 3 (for `spinnerFrame`). Slice 9 depends on Slice 8.

---

### Slice 1: phaseMeta extraction and PhaseSnapshot description (S)

**Goal:** `description?` flows from `meta.phases[{title, description}]` in the workflow script through to `PhaseSnapshot.description`. No card rendering yet — just the data pipeline.

**Files:**
- `src/runManager.ts` — extend `extractMetaPhases` to also extract `description?` from the same `phases: [{title, description}]` literal. Return type changes from `Array<{title: string}>` to `Array<{title: string; description?: string}>`. Same fail-silently contract.
- `src/runtime/phaseRegistry.ts` — extend `PhaseFeedEntry` for `pi-workflows.meta.phases`: `phases` array element gains `readonly description?: string`. Extend `PhaseSnapshot` with `readonly description?: string`. In `applyEntry` case `pi-workflows.meta.phases`, store `description` in `MutablePhase`. In `getSnapshot`, copy `description` to the returned `PhaseSnapshot`.

**Acceptance:**
- `extractMetaPhases('export const meta = { phases: [{title: "A", description: "Do B"}] }')` returns `[{title: "A", description: "Do B"}]`
- `extractMetaPhases('export const meta = { phases: [{title: "A"}] }')` returns `[{title: "A", description: undefined}]` — no regression
- After a `pi-workflows.meta.phases` feed entry with `description`, `PhaseRegistry.getSnapshot(runId).phases[0].description === "Do B"`

**Dependencies:** None

**Verification:** `node --import tsx --test tests/unit/phaseRegistry.test.ts tests/unit/runManager.test.ts` (add new cases; no existing test should break)

**Risk:** Low. `extractMetaPhases` uses a regex/bracket-walker approach — test that `description` with embedded quotes or commas is handled gracefully (treat as `undefined` on parse error, same as title).

---

### Slice 2: phaseMeta manifest persistence (S)

**Goal:** `phaseMeta` is written to `manifest.json` at run-start and loaded back during disk hydration, so card descriptions are visible for completed runs.

**Files:**
- `src/types/internal/extension.d.ts` — add to `RunManifest`:
  ```typescript
  readonly phaseMeta?: ReadonlyArray<{ readonly title: string; readonly description?: string }>;
  ```
- `src/runtime/manifestWriter.ts` — add `writePhaseMeta(runDir, phaseMeta)` following the existing write-queue pattern. Merges `phaseMeta` into the manifest JSON (same tmp+rename+fsync flow).
- `src/runManager.ts` — in `RunManager.startRun`, after the `pi-workflows.meta.phases` appendEntry is emitted (line ~479), call `manifestWriter.writePhaseMeta(runDir, extractedPhases)`.
- `src/runtime/activeRuns.ts` — in `hydrateRegistryFromDisk` (Phase 1 B1), after reading `manifest.json`, attach `phaseMeta` to the synthetic `PhaseRegistry` seed so completed runs show descriptions in the phase view.

**Acceptance:**
- After a workflow run starts, `manifest.json` contains `"phaseMeta": [{"title":"recon","description":"Fan-out reads"}]`
- `manifest.json` without `phaseMeta` field (old runs) does not throw during hydration — `phaseMeta` is optional throughout

**Dependencies:** Slice 1

**Verification:** `node --import tsx --test tests/unit/manifestWriter.test.ts tests/integration/runEndToEnd.test.ts`

**Risk:** Low. `manifestWriter.ts` already has the write-queue pattern; this is a new field using the same infrastructure.

---

### Slice 3: Spinner `setInterval` in overlay (S)

**Goal:** The overlay updates every 120ms while any run is active, animating the braille spinner in the runs list and (later) in phase cards. The interval is started when the overlay mounts and stopped when it unmounts.

**Files:**
- `src/runtime/overlay.ts` — add module-level `SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`. In the render-loop object, add `spinnerFrame: number` (starts at 0). In `mountOverlay`, after the registry subscription (`unsub`), start a `setInterval(120)` that increments `spinnerFrame` and calls `debouncedRender()`. Store the timer handle. Clear it in the overlay's `dispose()` / close path alongside `clearTimeout(renderTimer)`.
- Pass `spinnerFrame: renderState.spinnerFrame` into `renderRunsList(…, opts)` and `renderPhaseView(…, opts)` call sites.

**Acceptance:**
- With one running run, the state glyph in `renderRunsList` cycles through braille frames across successive renders
- Interval is cleared on overlay close (no leak: verify with `process._getActiveHandles()` in test)
- When no runs are active (all terminal), spinner still advances harmlessly (glyphs for terminal states are static regardless of frame)

**Dependencies:** None (independent)

**Verification:** `node --import tsx --test tests/integration/overlayPhaseView.test.ts` (add timer-teardown assertion)

**Risk:** Low–Medium. Ensure `debouncedRender` called from the interval doesn't re-enter or stack timers. The existing debounce guard (`if (renderTimer !== null) return`) already coalesces rapid calls — the 120ms interval fires at most once per frame.

---

### Slice 4: `RunSummary.hasPendingInterrupt` + state grouping (M)

**Goal:** The runs list renders in four state sections (⚠ Needs input → ▶ Working → ⏸ Paused → ✓ Completed) instead of a flat time-sorted list. Running runs with a pending interrupt appear under ⚠ automatically.

**Files:**
- `src/runtime/activeRuns.ts` — add `readonly hasPendingInterrupt?: boolean` to `RunSummary`. Add `patchSummary(runId, patch: Partial<RunSummary>)` method (or extend `applyEntry` with a new `pi-workflows.run.interrupt-state` feed type) so the overlay can flip the flag without going through a full state transition.
- `src/runtime/overlay.ts` — when `interrupt_requested` ledger event fires for a run, call `registry.patchSummary(runId, { hasPendingInterrupt: true })`. When `interrupt_resolved` fires, call `registry.patchSummary(runId, { hasPendingInterrupt: false })`. Wire these in `bindRegistryToFeed`.
- `src/runtime/runsList.ts` — implement `groupBy: 'state'` in `renderRunsList`:
  - When `opts.groupBy === 'state'` (new default), partition runs into four buckets before rendering rows.
  - Group headers are non-selectable lines: `⚠  Needs input  (N)`, `▶  Working  (N)`, `⏸  Paused  (N)`, `✓  Completed  (N)` — each bold + dim count. Empty groups are omitted entirely.
  - Completed group: cap display at 5 rows; append `   … N more (use [G] gc to clean up)` when truncated.
  - `opts.groupBy === 'time'` (or undefined) → existing flat sort behavior (backward compat).
  - `stateGlyph(state, spinnerFrame, hasPendingInterrupt)` helper (from spec §2b) replaces the current `colorHint`-based approach in row rendering. ANSI color applied inline (not via `colorHint` advisory).

**Acceptance:**
- `renderRunsList([runningRun], { groupBy: 'state' })` → `lines` contains `▶  Working  (1)` header
- `renderRunsList([runningRun], { groupBy: 'state' })` with `hasPendingInterrupt: true` → header is `⚠  Needs input  (1)` not `▶  Working  (1)`
- `renderRunsList([…6 completed runs…], { groupBy: 'state' })` → shows 5 rows + `… 1 more` truncation line
- Empty group (e.g. no paused runs) → `⏸  Paused` header absent from `lines`
- `renderRunsList(runs, { groupBy: 'time' })` → same flat output as Phase 1 (no regression on existing tests)
- `registry.patchSummary(runId, { hasPendingInterrupt: true })` → subsequent `listSummaries()` shows the flag set

**Dependencies:** None for groupBy logic; overlay wiring depends on Phase 1 interrupt work (already on main)

**Verification:**
```
node --import tsx --test \
  tests/unit/runsList.test.ts \
  tests/unit/activeRuns.test.ts
```
Add: grouping tests, hasPendingInterrupt patch tests, truncation test.

**Risk:** Medium. Two changes in one slice (RunSummary field + groupBy render logic). The `patchSummary` method must be safe to call from the overlay's feed handler (synchronous, same event loop tick as `applyEntry`). If the registry's subscriber notification fires during `patchSummary`, ensure no re-entrancy with the overlay render path.

---

### Slice 5: Width-responsive column budget (S)

**Goal:** `renderRunsList` uses `opts.width` (threaded in Phase 1) to compute which columns are visible. Narrow terminals show only essentials; wide terminals show cost and approval.

**Files:**
- `src/runtime/runsList.ts` — replace static `const COL_RUN_ID = 12` etc. with a `computeColumnBudget(width: number)` function:
  ```
  width < 80:   { runId: 10, name: 20, age: 8 }  — glyph(2) + these
  80 ≤ w < 120: + { duration: 9, tokens: 9 }
  w ≥ 120:      + { cost: 9, approval: 14 }
  ```
  Header and row cells conditionally include/exclude columns based on returned budget. The `pad()` + `fmtDuration` etc. calls remain; just gated by budget.

**Acceptance:**
- `renderRunsList(runs, { width: 60 }).header` does NOT contain `"duration"` or `"tokens"`
- `renderRunsList(runs, { width: 90 }).header` contains `"duration"` and `"tokens"`, not `"approval"`
- `renderRunsList(runs, { width: 130 }).header` contains `"approval"`
- No `rows[i].line` exceeds `opts.width` chars (strip ANSI before measuring)
- Without `opts.width`, defaults to existing column set (backward compat)

**Dependencies:** None (independent; `opts.width` already threaded)

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts` (add width-budget cases)

**Risk:** Low. Column conditionals are additive; the core sort/group/render pipeline is unchanged.

---

### Slice 6: Peek panel (S)

**Goal:** `Space` on the selected run inserts a 5-line ledger tail inline below that row. `Space` again collapses it.

**Files:**
- `src/runtime/hotkeys.ts` — add `{ kind: 'peek-toggle' }` action: `Space` key in `runs-list` view dispatches `peek-toggle` (regardless of run state).
- `src/runtime/overlay.ts` — maintain `peekRunId: string | undefined` in render state. On `peek-toggle`:
  - If `peekRunId === selectedRunId` → clear (close).
  - Else → read last 5 meaningful entries (`log`, `agent_start`, `agent_end`, `phase_start`, `phase_end`) from `<runDir>/ledger.jsonl` synchronously (cap at 20KB tail read), format as `[HH:MM] {summary}` strings, store in `peekLines`, set `peekRunId`.
  - Pass `peekRunId` and `peekLines` into `renderRunsList` opts.
- `src/runtime/runsList.ts` — in `renderRunsList`, after emitting the row for `peekRunId`, inject `│ {line}` rows (last one `└`) into `lines[]`. These injected lines do NOT appear in `rows[]` (cursor navigation skips them).

**Acceptance:**
- `renderRunsList(runs, { peekRunId: runs[0].runId, peekLines: ['a','b'] })` → `│ a` and `└ b` appear in `lines[]` immediately after the cursor row
- `peekRunId` for a run that's not in the visible list → silently no-ops (no crash)
- Second `Space` clears peek: `peekRunId` becomes undefined, peek lines disappear
- Peek lines do not affect cursor row index (`rows[]` unchanged)

**Dependencies:** None (independent; `peekRunId`/`peekLines` opts were declared in Phase 1 as no-ops)

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts tests/unit/hotkeys.test.ts` (add peek-toggle + rendering cases)

**Risk:** Low. Synchronous ledger tail read is acceptable for small files (ledger entries are compact). Add 20KB cap in case of pathological runs.

---

### Slice 7: Filter mode (S)

**Goal:** `/` enters filter mode; typed characters narrow the list by workflow name or runId prefix. `Esc` clears.

**Files:**
- `src/runtime/hotkeys.ts` — add `'filter'` to `OverlayView` type. New dispatch table for filter view:
  - Printable chars (char code 32–126) → `{ kind: 'filter-append', char: string }`
  - Backspace → `{ kind: 'filter-backspace' }`
  - `Escape` → `{ kind: 'filter-clear' }`
  - Other keys pass through to the runs-list table unchanged.
  - In `runs-list` view: `/` → `{ kind: 'filter-enter' }`.
- Add to `HotkeyActionKind`: `'filter-enter' | 'filter-append' | 'filter-backspace' | 'filter-clear'`.
- `src/runtime/overlay.ts` — maintain `filterText: string` and `view: OverlayView` in render state. Handle new action kinds:
  - `filter-enter` → set `view = 'filter'`, `filterText = ''`
  - `filter-append` → `filterText += char`, re-render
  - `filter-backspace` → `filterText = filterText.slice(0, -1)`, re-render
  - `filter-clear` → `filterText = ''`, `view = 'runs-list'`, re-render
  - Pass `filterText` into `renderRunsList` opts.
- `src/runtime/runsList.ts` — when `opts.filterText` is non-empty, pre-filter `runs[]` before sort/group: keep runs where `workflowName.toLowerCase().startsWith(filterText.toLowerCase())` OR `runId.includes(filterText)`. Append `  / ${filterText}` to the subtitle. Title bar gains `▌` cursor suffix when in filter mode (pass via opts).

**Acceptance:**
- `renderRunsList([{workflowName:'tui-audit'},{workflowName:'foo'}], { filterText: 'tui' }).rows.length === 1`
- `renderRunsList(runs, { filterText: 'wf-4c14' })` → matches by runId substring
- `filterText = ''` → no filtering (all runs shown, no subtitle suffix)
- `dispatchHotkey('/', state='running', view='runs-list')` → `{ kind: 'filter-enter' }`
- `dispatchHotkey('a', ..., view='filter')` → `{ kind: 'filter-append', char: 'a' }`
- `dispatchHotkey('Escape', ..., view='filter')` → `{ kind: 'filter-clear' }`

**Dependencies:** None (independent)

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts tests/unit/hotkeys.test.ts`

**Risk:** Low. Filter is purely additive to the pre-existing render path.

---

### Slice 8: Phase view card pipeline renderer (M)

**Goal:** Replace `renderPhaseView`'s flat text list with the Claude Code-style bordered card-per-phase layout. This is the primary visual change of Phase 2.

**Files:**
- `src/runtime/phaseView.ts` — major changes:
  - Add `PhaseViewCard` interface:
    ```typescript
    export interface PhaseViewCard {
      readonly phaseName: string;
      readonly lines: string[];         // full card including border; or single line if collapsed
      readonly title: string;           // phase name
      readonly statusBadge: string;     // e.g. "✓ 1/1", "⠙ 0/6", "○ not started"
      readonly description?: string;
      readonly isCollapsed: boolean;    // true for not-started phases
      readonly isCursor: boolean;
    }
    ```
  - Add `renderPhaseViewCards(summary, snapshot, opts): PhaseViewRender` (new function):
    - For each phase in `snapshot.phases`:
      - **Running/done phase** → full card:
        ```
        ┌──────────────────────────────────────────────┐
        │ Phase Name                              ○ 0/6 │
        │ Description text (if present)                │
        │ 0/6 agents · 116.3k tok · 6s                 │
        └──────────────────────────────────────────────┘
        ```
        - Box width = `opts.width - 4` (leave 2-char margin each side), min 40.
        - Status badge right-aligned in the title line: `runId ··· ○ 0/6`.
        - Spinner glyph for running phases uses `opts.spinnerFrame`.
        - Selected card: first line starts with `▸ ┌` (cursor prefix).
        - Unselected: `  ┌`.
        - Description line omitted when `phase.description` is undefined.
        - Stats line: `${agentsDone}/${agentsTotal} agents · ${fmtTokens(tok)} · ${fmtDuration(elapsed)}`.
      - **Not-started phase** → collapsed single line:
        ```
           Fetch         ○ not started
        ```
        Two-space indent, phase name left-pad to 14, status right-aligned.
    - DAG `↓` arrows: emit a centered `↓` line between every adjacent pair of cards.
    - `PhaseViewRender.cards` = array of `PhaseViewCard` objects.
    - `PhaseViewRender.lines` = composite of all card `.lines` + DAG arrows + title/subtitle/log-tail/help (same overall structure as before, different body).
  - Move existing flat logic to `_renderPhaseViewFlat` (unexported, kept for test reference).
  - `renderPhaseView` now delegates to `renderPhaseViewCards`.

**Acceptance:**
- `renderPhaseViewCards(…).cards[0].lines[0]` starts with `┌` or `▸ ┌` (box top)
- `renderPhaseViewCards(…).cards[0].lines[last]` starts with `└` (box bottom)
- When `phase.description` is set, `cards[0].lines[1]` contains the description text
- When `phase.description` is undefined, card has no description line (3 lines total: top border, stats, bottom border — plus title inside)
- Not-started phase → `cards[2].isCollapsed === true` and `cards[2].lines.length === 1`
- `lines[]` contains `↓` between each adjacent card
- No line in any `cards[i].lines[j]` exceeds `opts.width` (ANSI-stripped)
- `spinnerFrame: 0` and `spinnerFrame: 5` produce different glyph in a running card's status badge

**Dependencies:** Slices 1–2 (for `description`), Slice 3 (for `spinnerFrame`)

**Verification:**
```
node --import tsx --test \
  tests/unit/phaseView.test.ts \
  tests/integration/overlayPhaseView.test.ts
```
Add new card-invariant test cases. Existing flat-list assertions will fail and need migration (Slice 9).

**Risk:** High. Most complex renderer change. Key risks:
1. Box width calculation must account for ANSI escape lengths (strip escapes before measuring, pad plain text, then re-inject color).
2. The `▸` cursor prefix on the box border must not break the box-drawing char alignment — use `▸ ` (2 chars) as the prefix, indent non-selected cards with `  ` (2 spaces) to match.
3. Multi-agent phases don't drill down from cards in this slice — that's the existing Enter→agent-detail path (unchanged).

---

### Slice 9: Card layout integration + test migration (M)

**Goal:** Wire `renderPhaseViewCards` into `overlay.ts`. Migrate `overlayPhaseView.test.ts` assertions from flat `lines[]` to `cards[i].lines[j]`. Confirm full test suite passes.

**Files:**
- `src/runtime/overlay.ts` — the `renderPhaseView` call site already receives `PhaseViewRender`. No call-site change needed since `renderPhaseView` delegates to cards internally. But: the overlay's cursor model currently tracks `agentRows` (agent-row index). Switch to `phaseCards` cursor (phase index, 0-based). `Enter`/`→` from a phase card opens agent detail for the first agent in that phase (or the running one if multiple). Update the cursor navigation logic accordingly.
- `tests/integration/overlayPhaseView.test.ts` — migrate assertions:
  - Replace `render.lines[i] === '...'` with `render.cards[j].lines[k].includes('...')`
  - Update any test that checks exact `lines[]` indices for phase rows
  - Add: card-box invariant checks, description presence/absence, collapsed phase checks

**Acceptance:**
- `npm test` passes at ≥ 114/115 (same baseline as Phase 1 end-state)
- Pressing `↑`/`↓` in the overlay navigates between phase cards (not agent rows)
- Pressing `Enter` on a phase card with agents opens agent detail for the first agent
- The card view looks correct in a 120-col tmux session (manual smoke)

**Dependencies:** Slice 8

**Verification:** `npm test`

**Risk:** Medium. Cursor model change (phase cards vs agent rows) is the main risk. The existing `agentRows` field is retained on `PhaseViewRender` for the Enter→agent-detail path; only the overlay's `cursor` semantics change from "which agent row" to "which phase card".

---

### Slice 10: Task panel via `ctx.ui.setStatus` (S)

**Goal:** While any workflow run is active, a one-line status appears in the pi footer automatically — no `w` press required. Clears when all runs finish.

**Files:**
- `src/index.ts` — in the `session_start` handler (or in `workflowCmd.ts` where the registry is wired), subscribe to `ActiveRunsRegistry` notifications. On each notification:
  ```typescript
  const actives = registry.listSummaries().filter(s => !isTerminalState(s.state));
  if (actives.length === 0) {
    ctx.ui.setStatus?.('pi-workflows', undefined);
  } else {
    const parts = actives.map(s => {
      const snap = phaseRegistry.getSnapshot(s.runId);
      const running = snap?.phases.filter(p => p.status === 'running').length ?? 0;
      const total = snap?.phases.length ?? 0;
      const elapsed = fmtDuration(Date.now() - Date.parse(s.startedAt));
      const glyph = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      return `${glyph} ${s.workflowName}  ${running}/${total} phases  ${elapsed}`;
    });
    ctx.ui.setStatus?.('pi-workflows', parts.join('  ·  '));
  }
  ```
- Export `SPINNER_FRAMES` from `overlay.ts` (or `util/time.ts`) so `index.ts` can reference them.
- The `spinnerFrame` for the status line is driven by the same `setInterval(120ms)` wired in overlay.ts. Since the overlay may not be open, wire a **separate** lightweight interval in `index.ts` that only runs while `actives.length > 0`. Use a module-level `statusSpinnerFrame` counter. Start the interval on first active run; clear it when all runs terminal.

**Acceptance:**
- Start a workflow → `ctx.ui.setStatus` called with `'pi-workflows'` key and non-empty text
- Text contains workflow name, phase progress, elapsed time
- All runs reach terminal state → `setStatus?.('pi-workflows', undefined)` called
- `ctx.ui.setStatus` is called through `?.` — safe on older pi builds that don't expose it (no throw)
- Opening `/workflows` (`w`) still works alongside the status line (they're independent)

**Dependencies:** None (independent; uses registry already initialized in index.ts)

**Verification:**
- `node --import tsx --test tests/integration/runEndToEnd.test.ts` (add setStatus call spy)
- Manual: start a workflow, observe footer status line updates in real-time without pressing `w`

**Risk:** Low. `setStatus` is already declared optional in the type. The spinner interval is a fresh one — no coupling to the overlay's interval. One gotcha: ensure the status-spinner interval is cleared if the extension unloads (add to `session_shutdown` handler).

---

### Slice 11: Public API + authoring docs (S)

**Goal:** `meta.phases[].description` is documented and typed in the public author API. SKILL.md and authoring.md reflect Phase 2 features.

**Files:**
- `src/types/public.d.ts` — update `WorkflowMeta.phases` element type from `{ title: string }` to `{ title: string; description?: string }`. This is backward-compatible (additive optional field).
- `skills/pi-workflows/SKILL.md` — add `description` to the `meta.phases` example. Add a "Task panel" note: status appears automatically in the footer; `/workflows` (`w`) for the full overlay.
- `docs/authoring.md` — update the `meta.phases` section with `description?` field and a note that descriptions appear in the card pipeline view. Add a "What users see" callout explaining the footer status line.
- `docs/tui-redesign.md` — mark Phase 2 as complete; close open design questions that were resolved (Q1 confirmed, Q2 resolved as strip-ANSI in non-TTY, Q3 confirmed `runsDir` injection, Q4 resolved as 20KB cap synchronous, Q5 resolved as first-agent default, Q6 resolved as overlay-owned chord state).

**Acceptance:**
- TypeScript compiles cleanly with `phases: [{title: 'A', description: 'B'}]` in a workflow's `meta`
- `grep "description" skills/pi-workflows/SKILL.md` returns at least one match in the phases section
- `npm test` still passes (no runtime change)

**Dependencies:** All previous slices (confirm before closing design questions)

**Verification:** `npx tsc --noEmit && npm test`

**Risk:** None. Documentation and type change only.

---

## Summary table

| # | Slice | Size | Files touched | Depends on |
|---|-------|------|---------------|------------|
| 1 | phaseMeta extraction + PhaseSnapshot.description | S | `runManager.ts`, `phaseRegistry.ts` | — |
| 2 | phaseMeta manifest persistence | S | `extension.d.ts`, `manifestWriter.ts`, `runManager.ts`, `activeRuns.ts` | 1 |
| 3 | Spinner `setInterval` in overlay | S | `overlay.ts` | — |
| 4 | `RunSummary.hasPendingInterrupt` + state grouping | M | `activeRuns.ts`, `overlay.ts`, `runsList.ts` | — |
| 5 | Width-responsive column budget | S | `runsList.ts` | — |
| 6 | Peek panel | S | `hotkeys.ts`, `overlay.ts`, `runsList.ts` | — |
| 7 | Filter mode | S | `hotkeys.ts`, `overlay.ts`, `runsList.ts` | — |
| 8 | Phase view card pipeline renderer | M | `phaseView.ts` | 1, 2, 3 |
| 9 | Card layout integration + test migration | M | `overlay.ts`, `overlayPhaseView.test.ts` | 8 |
| 10 | Task panel via `ctx.ui.setStatus` | S | `index.ts`, `overlay.ts` | — |
| 11 | Public API + authoring docs | S | `public.d.ts`, `SKILL.md`, `authoring.md`, `tui-redesign.md` | all |

**Total: 11 slices — 7 S, 3 M, 1 S-final. Estimated wall clock: 10–16 hours for a focused builder.**

Slices 1–7 and 10 can be built in any order relative to each other (all are independent of the card pipeline). The hard chain is: 1 → 2 → (precondition for) 8 → 9. Slice 3 should land before 8 starts so card spinner frames are available for testing.
