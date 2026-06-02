# Design: pi-workflows TUI Redesign

**Status:** Phase 1 ✅ complete · Phase 2 ✅ complete (shipped 2026-06-02).  
**Phase 1 plan:** `docs/tui-phase1-plan.md`  
**Phase 2 plan:** `docs/tui-phase2-plan.md`  
**Last updated:** 2026-06-02  
**Scope:** `overlay.ts`, `runsList.ts`, `phaseView.ts`, `agentDetail.ts`, `hotkeys.ts`, `activeRuns.ts`, `phaseRegistry.ts`, `manifestWriter.ts`

---

## Overview

The current TUI renders a functional but visually inert status table. The primary symptoms:

- `0 total` on first open (in-memory registry, 252 runs on disk)
- No ANSI color — running and failed rows look identical
- No animation — the view feels frozen even during active runs
- `phaseView` is a flat indented list; Claude Code renders a **vertical card pipeline**
- Fixed column widths that silently wrap on narrow terminals
- Three critical hotkey conflicts (`g` for GC collides with vim, `r` triple-overloaded, `Esc` means deny)
- `[pi-workflows.stub]` events leak into AI context

The goal is to close the visual quality gap with Claude Code's phase-detail view, fix critical bugs, and add state grouping + animation — while keeping all pure renderer functions (`renderRunsList`, `renderPhaseView`, `renderAgentDetail`) stable enough that existing tests pass or migrate cleanly.

**Out of scope (both phases):**
- AI-generated per-agent summaries (requires B2 injection fix first; spike separately)
- Daemon/persistent process (no OS daemon, no standalone agent dashboard)
- Cross-terminal run sharing beyond what `[remote]` badge already covers
- **Task panel (Phase 3):** Claude Code shows a one-line live progress summary below the chat input box while a workflow runs, without needing to open `/workflows`. This is a known gap and a high-priority Phase 3 item. It requires a different pi SDK integration point (persistent widget, not the full-screen overlay). Deferred from Phase 2 to keep Phase 2 scope manageable.

---

## What Claude Code's phase view actually looks like

From a real screenshot of Claude Code's level-2 drill-down (phase view):

```
workflow › Deep research harness — fan-out web searches...   [cyan header, bold]
22s · 7 agents · 135.3k tok · 6 running · 1 done            [live stats, dim]

…/workflows/scripts/deep-research-wf_a17bf02c-c03.js        [script path, dim]

┌──────────────────────────────────────────────────────────┐
│ Scope                                                    │  ✓ 1/1
│ Decompose question (from args) into 5 search angles      │
│ 1/1 · Opus 4.7 (1M context) · 19k tok · 15s             │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│ Search                                                   │  ○ 0/6  ← animates
│ 5 parallel WebSearch agents, one per angle               │
│ 0/6 · Opus 4.7 (1M context) · 116.3k tok · 6s           │
└──────────────────────────────────────────────────────────┘
                          ↓
  Fetch         ○ not started
  Verify        ○ not started
  Synthesize    ○ not started

↑/↓ to navigate · Enter/→ to zoom in · ← to go back · Esc/Space to close · x to stop · p to pause · s to save
```

Key observations:
1. **Card-per-phase** with `┌─┐│└─┘` box borders. Selected card = bold border + `▸` margin prefix.
2. **Phase description inside card** — from `meta.phases[i].description` in the workflow script.
3. **Stats line inside card**: `N/M · model · tokens · elapsed`
4. **Status badge right-aligned**: `✓ 1/1` (green bold), `○ 0/6` (cyan, `○` animates as spinner), `○ not started` (dim)
5. **DAG flow arrows (`↓`)** between cards.
6. **Not-started phases collapsed** to a single unstyled line — no card, no border.
7. **Three-level navigation preserved**: run list → card pipeline (this view) → agent detail (Enter/→).

Our current `renderPhaseView` produces a flat text list with glyph prefixes. This is the primary visual change in Phase 2.

---

## Phase 1: Critical bugs + visual polish (non-breaking)

All changes are additive or in-place. No type signature breakage. No test rewrites.

~~B4 (GC count mismatch) — resolved by B1: disk hydration closes the count gap between GC (252) and overlay (0). No separate fix needed.~~

### B1 — `0 total` on first open (async disk hydration)

**Root cause:** `ActiveRunsRegistry` is in-memory only. `applyEntry()` drives it from live appendEntry events in the current session. Historical runs from prior sessions are never loaded.

**Fix:**

In `overlay.ts::mountOverlay`, after constructing the registry, call:

```typescript
hydrateRegistryFromDisk(registry, runsDir).catch(() => {/* silent */});
```

Where `hydrateRegistryFromDisk` (new function in `activeRuns.ts`):
1. Scans `~/.pi/agent/workflows/runs/` for subdirectories containing `manifest.json`.
2. For each, reads `manifest.json` + last line of `ledger.jsonl` to extract `state`.
3. Calls `registry.applyEntry(narrowedEntry)` with synthetic `run.started` / `run.transitioned` entries to populate the summary map — no Run handle, display-only.
4. Skips runs already in the registry (live runs take precedence).
5. Fires one `registry.notifySubscribers()` after the batch.
6. Capped at 200 disk runs (scan newest-first by mtime).

The overlay renders empty first, then repaints when hydration resolves. No blocking.

**Acceptance:** open `w` in a fresh session with ≥1 prior run on disk → list shows at least that run immediately after the repaint (< 500ms).

---

### B2 — `[pi-workflows.stub]` leaks into AI context

**Root cause:** `/workflows list` and `/workflows show` are slash subcommands that return their output as a `sendMessage` call, which lands in the assistant message stream and becomes AI-visible context. The `[pi-workflows.stub]` suppression hook in `workflowCmd.ts` is not wired end-to-end for these paths.

**Fix:** Locate the `sendMessage` call(s) for list/show output in `workflowCmd.ts`. Replace with `pi.ui.custom` component render OR wrap the message in a `pi.sendMessage({ role: 'system', customType: 'pi-workflows.display-only' })` that the extension's `before_agent_start` hook strips from context before forwarding to the model.

The exact wiring depends on the pi SDK's `sendMessage` surface — the fix must ensure the string never appears in `messages[]` forwarded to the model.

**Acceptance:** type `/workflows list`, then send "hello" → model turn does NOT reference workflow history.

---

### B3 — Hotkey bar truncates at narrow terminal widths

**Root cause:** help string is assembled in `renderRunsList` / `renderPhaseView` without a width cap. At 80-col terminals the hint bleeds off the right edge.

**Fix:** In `renderRunsList` and `renderPhaseView`, accept `width: number` in opts (new field, see render contract changes below). When composing the help line:

```typescript
const help = assembled.length > (width - 2) ? assembled.slice(0, width - 5) + "…" : assembled;
```

**Acceptance:** `renderRunsList([...], { width: 80 })` → help line ≤ 78 chars.

---

### B5 — `?` hide leaves no hint

**Root cause:** `?` toggle sets `showHelp = false` and re-renders with an empty help line. No residual affordance.

**Fix:** When `showHelp === false`, append a single stub bullet `[?] help` to the lines output (always, regardless of run state). This gives the user a way back.

**Acceptance:** render with help hidden → last line is `[?] help`.

---

### B6 — Orphaned run shows `running` after parent crash

**Root cause:** `ActiveRunsRegistry` hydrates from appendEntry events, which correctly reflect the final ledger state for ended runs. But runs that were mid-flight when the parent crashed have `transition → running` as their last ledger event — the `failed` transition written by `sweepCrashedRuns` only happens on the next session start. A run visible in the overlay between crash and next session shows stale `running`.

**Fix:** In `hydrateRegistryFromDisk` (same new function as B1), after reading the last ledger entry, also read `manifest.json::parentPid` and check liveness:

```typescript
const alive = isAlive({ parentPid: manifest.parentPid, parentBootId: manifest.parentBootId ?? '' });
if (!alive && state === 'running') state = 'failed'; // display-only, no ledger write
```

Reuse `isAlive` from `crashSweep.ts` — it is synchronous and takes `{ parentPid, parentBootId }`. The display-only override does not write to the ledger — sweep on next session start handles the authoritative transition.

**Acceptance:** kill a running workflow's parent process, re-open overlay in same session → run shows `failed` (not `running`).

---

### Visual quick wins

All are additive. None break existing tests.

**VQ-1 — ANSI color on state labels**

Add to `runsList.ts`:

```typescript
const ANSI_STATE: Record<RenderedRow['colorHint'], string> = {
  running:  '\x1b[1;36m',   // bold cyan
  paused:   '\x1b[1;33m',   // bold yellow
  done:     '\x1b[1;32m',   // bold green
  failed:   '\x1b[1;31m',   // bold red
  stopped:  '\x1b[2m',      // dim
  cancelled:'\x1b[2m',      // dim
  neutral:  '',
};
const ANSI_RESET = '\x1b[0m';
```

`RenderedRow` gains a new `coloredLine: string` field alongside `line` (uncolored, for tests) and `colorHint` (kept for backward compat). The overlay renders `coloredLine` to TTY, `line` to non-TTY.

**Important:** `lines[]` in `RenderedRunsList` is composed from `row.line` (plain text), NOT `row.coloredLine`. The overlay's TTY render loop reads `row.coloredLine` directly for display; `lines[]` stays plain for non-TTY output and test compatibility.

Apply the same mapping in `phaseGlyph()` and `agentGlyph()` in `phaseView.ts`.

**VQ-2 — Remap GC: `g` → `G`, add `gg` jump navigation**

In `hotkeys.ts::dispatchHotkey`:
- `case 'G':` → `open-gc-dialog`
- `case 'g':` with a 300ms chord window → first `g` sets a pending state; second `g` within window → `navigate-first`; timeout → `noop`

Update all help bar references from `[g] gc` → `[G] gc`.

**VQ-3 — Fix `phaseView` column overflow**

In `renderPhaseView`, replace:

```typescript
`${glyph} ${phase.phaseName.padEnd(14)} ${summaryStr}`
```

with:

```typescript
`${glyph} ${pad(phase.phaseName, 14)} ${summaryStr}`
```

Import `pad` from `runsList.ts` (or extract to `util/format.ts` — see VQ-8).

Apply same fix to `agent.agentId.padEnd(14)` in the agent row section.

**VQ-4 — `u` = unpause, `r` = restart terminal only**

In `hotkeys.ts`:
- Add `case 'u':` → `{ kind: 'resume', runId }` (only when `state === 'paused'`)
- Restrict `case 'r':` → `{ kind: 'restart-requested', runId }` only when `isTerminalState(state)`. Previously `r` also covered resume.
- Remove the `paused → resume` branch from `case 'p':`. After this change `p` means pause-only; pressing `p` on a paused run returns `{ kind: 'noop', reason: 'disabled-for-state' }`.
- Update help bar: paused runs show `[u] resume  [r] restart` only after termination.

**VQ-5 — Scroll position label in agent detail**

In `renderAgentDetail`, replace:

```typescript
lines.push(`Live tail (last ${logCount > 0 ? logCount : 0} lines)`);
```

with:

```typescript
const scrollOffset = opts.scrollOffset ?? 0;
const label = scrollOffset > 0
  ? `Log  [lines ${startIdx + 1}–${Math.min(endIdx, snap.logTail.length)} of ${snap.logTail.length}]  ↑↓ scroll`
  : `Live tail (last ${logCount} lines)`;
lines.push(label);
```

**VQ-6 — Cap `approval` column to 20 chars**

In `runsList.ts`, add `const COL_APPROVAL = 20;` and wrap:

```typescript
pad(approvalCell, COL_APPROVAL) + remoteBadge
```

**VQ-7 — Bold header + `─` separator**

In `renderRunsList`, after `lines.push(header)`:

```typescript
lines[lines.indexOf(header)] = `\x1b[1m${header}\x1b[0m`;
lines.push('─'.repeat(Math.min(width, header.length)));
```

(When `width` is not set, fall back to `header.length`.)

**VQ-8 — Extract `fmtDuration` to `util/format.ts`**

Create `src/util/format.ts` exporting `fmtDuration`, `fmtRelative`, `fmtTokens`, `fmtTokensShort`. Import in `runsList.ts`, `phaseView.ts`, `agentDetail.ts`, `visualize.ts`. Fix `visualize.ts`'s raw millisecond output at the two call sites.

**VQ-9 — Fix SKILL.md**

In `skills/pi-workflows/SKILL.md`: s/`/workflows status`/`/workflows show`/ and add a one-paragraph quickstart explaining that results arrive as a chat card, not inline.

---

### Interaction fixes

**IF-1 — `Esc` in gate/interrupt = snooze, NOT deny**

In `overlay.ts` at `workflowCmd.ts:674` (HITL wiring), the `Esc`/cancel path from `pi.ui.input` or `pi.ui.select` currently resolves the interrupt promise with `null` or rejects it, which routes to deny.

**Fix:** Distinguish cancel (Esc) from deny (explicit `n`). On cancel: do NOT call `run.respondInterrupt()`; instead display banner `"interrupt snoozed — [i] again or [x] to stop"` and leave `pendingInterrupts` queue intact. On explicit deny: call `run.respondInterrupt('__denied__', key)` and let the workflow handle it.

The interrupt overlay prompt must offer three explicit paths: `[Enter] approve  [n] deny  [Esc] snooze`.

**IF-2 — Cancelled interrupt resolves cleanly**

If the user opens the interrupt prompt and closes the overlay entirely (not snooze, but `Esc` on the overlay level), the interrupt promise must not dangle. Resolve with `null` + banner `"interrupt cancelled — run may stall, [i] to retry or [x] to stop"`. The workflow receives `null` and should handle it; workflows that don't will stall (documented behavior).

**IF-3 — Thread `width` through all renderer opts**

Add `width: number` to `RenderOpts`, `PhaseViewOpts`, `AgentDetailOpts`. Default to `process.stdout.columns ?? 120` in the overlay's render call. Renderers use `width` for help-line clamping (B3), column budget (Phase 2), and bold separator (VQ-7). No existing tests need updating — `width` is optional.

---

## Phase 2: Card pipeline + state grouping + animation + peek + filter

Phase 2 is gated on Phase 1 passing all tests. It is a visual redesign of two renderers and three new features. The pure-function contract is preserved; existing tests assert on `lines[]` and will need updating for the new card layout.

### 2a. Phase view redesign — card pipeline

**Replace `renderPhaseView`'s flat indented list with a vertical card pipeline.**

Target output:

```
workflow › tui-audit  ────────────── running  2m 14s  69k tok ──────
…/scratch/pi-workflows/.pi/workflows/tui-audit.js

┌──────────────────────────────────────────────────────────────┐
│ recon                                                        │  ✓ 4/4
│ Parallel audit of TUI code, Claude comparison, docs          │
│ 4/4 · 53k tok · 3m 32s                                      │
└──────────────────────────────────────────────────────────────┘
                          ↓
▸ ┌──────────────────────────────────────────────────────────────┐
  │ live-tui-probe                                               │  ○ 0/1
  │ Live TUI test via tmux                                       │
  │ 0/1 · 69k tok · 9m 06s                                      │
  └──────────────────────────────────────────────────────────────┘
                          ↓
  synthesis       ○ not started

↑/↓ navigate  Enter/→ zoom in  ← back  p pause  x stop  s save  ? help
```

**Card layout rules:**

- Card width: `cardWidth = Math.min(opts.width - 4, 70)`. Minimum 40.
- Left margin: 2 spaces (4 when selected: `▸ ` replaces leading `  `).
- Status badge: right-aligned to `opts.width - 2`, printed on the same line as the top border.
- Selected card: top/bottom border rendered with `\x1b[1m` (bold), cursor `▸` on left margin.
- Not-started phases: single line `  {phaseName.padEnd(20)}  ○ not started` — no box.
- Stats line inside card: `{done}/{total} · {tokens} tok · {elapsed}`. Omit tokens if 0. Omit elapsed if < 1s.
- Phase description line: only if `phaseDescription` is defined and non-empty. Truncate to `cardWidth - 4` chars.
- DAG arrow: `'↓'.padStart(cardWidth / 2 + 2)` between each consecutive pair of phases (except after the last).

**New return type:**

```typescript
interface PhaseViewCard {
  readonly phaseName: string;
  readonly phaseDescription?: string;   // from manifest meta — may be undefined
  readonly agentsDone: number;
  readonly agentsTotal: number;
  readonly state: PhaseStatus;
  readonly tokensTotal?: number;
  readonly elapsedMs?: number;
  readonly isCursor: boolean;
  readonly lines: string[];             // this card's lines only (for unit tests)
}

interface PhaseViewRender {              // extends existing shape, additive
  readonly cards: readonly PhaseViewCard[];
  readonly lines: string[];             // full composed output with arrows
  readonly title: string;
  readonly subtitle: string;
  // agentRows retained for backward compat (cursor navigation to agent detail)
  readonly agentRows: ReadonlyArray<{ phaseName: string; agentId: string; lineIndex: number; }>;
}
```

The existing `agentRows` field is retained. In the card layout, the cursor navigates *cards* (phases), not agent rows. `agentRows` continues to be used when the user is in phase-cursor mode and presses Enter to drill into agent detail.

---

### 2b. Run list — state grouping

**Replace flat time-sorted list with sectioned groups.**

Target output (80-col example):

```
pi-workflows  ─────────────────────  2 active · 8 total  ────  [?] help

⚠  Needs input  (1)
▸  wf-4c14  tui-audit        ✽ running   2m  69k tok

▶  Working  (1)
   wf-1234  deep-research    ✽ running   5m  142k tok

✓  Completed  (6)
   wf-f1ac  foo              ✓ done     8m    4k tok
   wf-92a4  hunt-bugs-deep   ✓ done    12m   31k tok
   wf-6080  bug-hunt         ✗ failed   3m    8k tok
   … 3 more (use [G] gc to clean up)
```

**Group order and headers:**

| Group | Header | Condition |
|---|---|---|
| ⚠ Needs input | `⚠  Needs input  (N)` | `state === 'running'` AND run has pending interrupt |
| ▶ Working | `▶  Working  (N)` | `state === 'running' \| 'approved'` and no pending interrupt |
| ⏸ Paused | `⏸  Paused  (N)` | `state === 'paused'` |
| ✓ Completed | `✓  Completed  (N)` | terminal states, newest first |

Empty groups are omitted.

`RenderOpts` gains `groupBy: 'state' | 'time'` (default `'state'` in Phase 2). `'time'` restores Phase 1 flat behavior for backward compat / non-TTY.

**State glyphs + animation:**

State glyphs are supplied via `opts.spinnerFrame?: number` (0-based braille frame index, updated by the 120ms interval in `overlay.ts`). The glyph function:

```typescript
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function stateGlyph(state: RunSummaryState, spinnerFrame: number, hasPendingInterrupt: boolean): string {
  if (hasPendingInterrupt) return '\x1b[1;33m⚠\x1b[0m';
  switch (state) {
    case 'running':   return `\x1b[1;36m${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}\x1b[0m`;
    case 'paused':    return '\x1b[1;33m⏸\x1b[0m';
    case 'done':      return '\x1b[1;32m✓\x1b[0m';
    case 'failed':    return '\x1b[1;31m✗\x1b[0m';
    case 'stopped':
    case 'cancelled-pre-run': return '\x1b[2m⊘\x1b[0m';
    default:          return '\x1b[2m·\x1b[0m';
  }
}
```

The overlay increments a `spinnerFrame` counter in its 120ms interval and passes it through `RenderOpts.spinnerFrame`.

---

### 2c. Peek panel (`Space`)

**On the run list, `Space` on the selected run inserts an inline log tail below that row.**

```
▸  wf-4c14  tui-audit  ✽ running   2m  69k tok
   │ [17:48] phase recon started (4 agents)
   │ [17:51] agent render-audit done (3m 32s, 53k tok)
   │ [17:51] agent interaction-audit done (3m 36s)
   │ [17:50] phase live-tui-probe started
   └ [17:50] agent live-probe started
```

`Space` again collapses it.

`RenderOpts` gains:
- `peekRunId?: string` — the runId whose peek is open (if any)
- `peekLines?: readonly string[]` — pre-loaded log lines from the caller

The overlay owns reading `ledger.jsonl` for the peek content (not the renderer). On `Space`, `overlay.ts` reads the last 5 `log`/`agent_start`/`agent_end`/`phase_start` entries from `<runDir>/ledger.jsonl` synchronously (small file, sequential reads tolerable) and passes them as `peekLines`. On second `Space`, clears `peekRunId`.

The renderer inserts `│ {line}` rows (last one `└`) after the selected row's `line` in `rows[]`.

---

### 2d. Filter mode (`/`)

`/` enters filter mode. The title bar shows `/ {filterText}▌` while active. Typed characters filter displayed runs by `workflowName.startsWith(filterText)` or `runId.includes(filterText)`. `Esc` clears.

`RenderOpts` gains `filterText?: string`. When non-empty, `renderRunsList` pre-filters the input `runs[]` before sorting/grouping, and adds `  / {filterText}` to the subtitle.

`hotkeys.ts` gains a new view state `'filter'` with its own dispatch table:
- Printable chars → `{ kind: 'filter-append', char }`
- Backspace → `{ kind: 'filter-backspace' }`
- `Esc` → `{ kind: 'filter-clear' }`
- Other keys pass through normally

---

### 2e. Width-responsive column budget

`renderRunsList` computes visible columns from `opts.width`:

| Width | Visible columns |
|---|---|
| < 80 | glyph(2) · runId(10) · name(20) · age(8) |
| 80–119 | + duration(9) · tokens(9) |
| ≥ 120 | + cost(9) · approval(14) |

`COL_*` constants become computed values, not module-level consts.

---

## Data flow

### Phase descriptions: `meta.phases[].description` → `renderPhaseView`

Currently, `meta.phases` in the workflow script only carries `title`. The `pi-workflows.meta.phases` appendEntry event seeds `PhaseRegistry` with titles but no descriptions.

**Step 0 — Extract descriptions in `runManager.ts`:**

Extend `extractMetaPhases` in `runManager.ts` to also extract `description?` from the `phases: [{title, description}]` literal array shape. Same regex/AST approach used for `title`, same fail-silently contract. Returns `Array<{ title: string; description?: string }>`. This is the source of the description data before it enters the appendEntry pipeline.

**Step 1 — Extend the meta event payload:**

In `phaseRegistry.ts`, extend `PhaseFeedEntry` for `pi-workflows.meta.phases`:

```typescript
readonly phases: ReadonlyArray<{ readonly title: string; readonly description?: string; }>;
```

**Step 2 — Extend `PhaseSnapshot`:**

```typescript
export interface PhaseSnapshot {
  // ... existing fields ...
  readonly description?: string;   // from meta declaration; undefined if not provided
}
```

**Step 3 — Extend `RunManifest`:**

```typescript
// In extension.d.ts RunManifest:
readonly phaseMeta?: ReadonlyArray<{ readonly title: string; readonly description?: string; }>;
```

The field is `phaseMeta` (not `phases` — that name is reserved for agent-count tracking). It is written in the same `manifestWriter.writeManifest` call that writes the existing run metadata today.

**Step 4 — Write `phaseMeta` to manifest at run-start:**

In `runCtx.ts`, where the `pi-workflows.meta.phases` appendEntry is emitted (line ~194), also write `phaseMeta` to `manifest.json` via `manifestWriter`. This allows disk-hydrated runs to carry descriptions.

**Step 5 — Flow through overlay:**

`overlay.ts::bindRegistryToFeed` already routes `pi-workflows.meta.phases` → `phaseRegistry.applyEntry()`. No change needed there. `PhaseRegistry.getSnapshot(runId)` returns `phases[i].description` in each `PhaseSnapshot`. `renderPhaseView` reads it from `phase.description`.

**Step 6 — Public author API (no change):**

The `meta.phases` shape already accepts `{ title, description }` per the SKILL.md authoring guide. Workflows already written with only `{ title }` continue to work — `description` is optional throughout.

---

### Disk hydration: `hydrateRegistryFromDisk` → `ActiveRunsRegistry`

```
overlay.ts::mountOverlay()
  └─ hydrateRegistryFromDisk(registry, runsDir)   [async, fire-and-forget]
       ├─ readdir(runsDir) → sorted by mtime desc, capped at 200
       ├─ for each runDir:
       │    ├─ read manifest.json → { runId, workflowName, startedAt, ... }
       │    ├─ tail ledger.jsonl → last transition entry → state
       │    ├─ isPidAlive(parentPid, ...) → if dead + state=running → state='failed'
       │    └─ registry.applyEntry({ customType: 'pi-workflows.run.started', ... })
       │       registry.applyEntry({ customType: 'pi-workflows.run.transitioned', ... })
```

The hydrated entries are synthetic — they have `source: 'disk-hydration'` to distinguish them from live entries. `ActiveRunsRegistry.applyEntry` skips entries for runIds already present (live runs take precedence over hydrated ones). Because `#notify()` fires on each `applyEntry` call, progressive repaints occur throughout hydration — no explicit batch-flush call is needed.

---

## Render contract changes

### Phase 1 additions (non-breaking — all new fields optional)

**`RenderOpts` additions:**
```typescript
readonly width?: number;               // B3, VQ-3, VQ-7 — terminal width, default 120
readonly spinnerFrame?: number;        // Phase 2 spinner (safe to add in P1 as ignored)
readonly groupBy?: 'state' | 'time';  // Phase 2 grouping (ignored in P1)
readonly filterText?: string;          // Phase 2 filter (ignored in P1)
readonly peekRunId?: string;           // Phase 2 peek (ignored in P1)
readonly peekLines?: readonly string[];// Phase 2 peek (ignored in P1)
```

**`RenderedRow` additions:**
```typescript
readonly coloredLine: string;          // ANSI-escaped version of `line`
```
`line` (uncolored) and `colorHint` are kept. Tests that assert on `row.line` continue to pass unchanged.

**`PhaseViewOpts` additions:**
```typescript
readonly width?: number;               // B3 help clamping; Phase 2 card layout
readonly spinnerFrame?: number;        // Phase 2 card spinner
```

**`AgentDetailOpts` additions:**
```typescript
readonly width?: number;               // B3 help clamping
```

### Phase 2 changes (breaking — test migration required)

**`PhaseViewRender`** gains `cards: readonly PhaseViewCard[]`. `lines[]` changes shape (card boxes instead of flat list). Existing snapshot-style tests that assert on `lines[i]` must be rewritten to assert on `cards[i].lines[j]`.

**`RenderOpts.groupBy`** defaults to `'state'`. Tests that rely on run order in `lines[]` must switch to `groupBy: 'time'` or update expected order.

**`renderPhaseView` migration plan:**

Keep the existing flat renderer as `renderPhaseViewFlat` (unexported). In Phase 2, `renderPhaseView` delegates to a new `renderPhaseViewCards`. Tests in `overlayPhaseView.test.ts` are updated to assert on `cards[i].lines` instead of `lines[]`. The migration is surgical — no other callers exist outside `overlay.ts`.

---

## Full hotkey reference

| Key | Action | View | State guard |
|---|---|---|---|
| `j` / `↓` | navigate down | any | — |
| `k` / `↑` | navigate up | any | — |
| `Enter` / `→` | open phase view (from runs); open agent detail (from phase) | any | — |
| `Space` | toggle peek panel | runs list | — |
| `Esc` / `←` | back / close overlay | contextual | — |
| `p` | pause run | runs list, phase view | running |
| `u` | unpause / resume | runs list, phase view | paused |
| `x` | stop run | runs list, phase view | running or paused |
| `r` | restart run | runs list | terminal |
| `f` | fork from checkpoint | runs list | terminal |
| `t` | open transcript | phase view, agent detail | any |
| `s` | save script to project | any | any |
| `v` | DAG visualize | runs list | any |
| `i` | answer pending interrupt | runs list, phase view | running with pending interrupt |
| `G` | GC dialog | runs list | — |
| `gg` (300ms chord) | jump to first row | any | — |
| `/` | enter filter mode | runs list | — |
| `?` | toggle help | any | — |
| `[printable]` | append to filter | filter mode | — |
| `Backspace` | delete from filter | filter mode | — |
| `Esc` (in filter) | clear filter | filter mode | — |
| `n` (in interrupt prompt) | explicit deny | interrupt prompt | — |
| `Esc` (in interrupt prompt) | snooze (leave unresolved) | interrupt prompt | — |

**Conflicts resolved vs current:**
- `g` → `G` (was vim `gg` conflict)
- `r` no longer means resume (was triple-overloaded; `u` = unpause)
- `Esc` in interrupt = snooze (was incorrectly deny)

---

## Test strategy

### Phase 1 tests (all new, no existing test changes required)

**Unit — `runsList.ts`:**
- `renderRunsList` with `opts.width = 80` → help line ≤ 78 chars
- `renderRunsList` with zero runs → last line is `[?] help` (B5)
- `rows[0].coloredLine` contains ANSI escape for `running` state (VQ-1)
- `rows[0].line` is still uncolored (backward compat)
- `renderRunsList` with `opts.cursor = 0` on a paused run → help shows `[u] resume` not `[r] resume`

**Unit — `phaseView.ts`:**
- `renderPhaseView` with a phase named `"reconcile-outputs-long"` → phase name column does not overflow 14 chars

**Unit — `agentDetail.ts`:**
- `renderAgentDetail` with `scrollOffset = 3` → label includes `↑↓ scroll` (VQ-5)

**Unit — `hotkeys.ts`:**
- `dispatchHotkey('g', state='running', view='runs-list')` → `{ kind: 'noop' }` (not GC)
- `dispatchHotkey('G', state='running', view='runs-list')` → `{ kind: 'open-gc-dialog' }`
- `dispatchHotkey('u', state='paused', ...)` → `{ kind: 'resume' }`
- `dispatchHotkey('r', state='paused', ...)` → `{ kind: 'noop', reason: 'disabled-for-state' }`
- `dispatchHotkey('p', state='paused', ...)` → `{ kind: 'noop', reason: 'disabled-for-state' }`

**Integration — `activeRuns.ts::hydrateRegistryFromDisk`:**
- Given a fake `runsDir` with 3 manifest+ledger pairs → registry has 3 summaries after hydration
- A run with `state='running'` and dead parent PID → hydrated as `state='failed'`
- At least one repaint occurs after hydration completes (progressive — `#notify()` fires per `applyEntry`)

**Integration — B2 stub leak:**
- `/workflows list` output does NOT appear in `messages[]` passed to the model

### Phase 2 tests (new + migration)

**Unit — `phaseView.ts` (card layout):**
- `cards[0].lines` contains `┌` and `└` box characters (box drawn)
- `cards[0].lines` contains the phase description when `phaseDescription` is set
- `cards[0].lines` does NOT contain a description line when `phaseDescription` is undefined
- A not-started phase → `cards[2].lines.length === 1` (collapsed)
- Selected card (`isCursor: true`) → first line of `cards[1].lines` starts with `▸`
- `lines` array contains `↓` DAG arrow between card N and card N+1
- Cards render within `opts.width` — no line in `cards[i].lines` exceeds `opts.width`

**Unit — `runsList.ts` (grouping):**
- `groupBy: 'state'` → `lines` contains `▶  Working` header before running runs
- `groupBy: 'time'` → flat list (existing test behavior, add as opt)
- Run with pending interrupt → appears under `⚠  Needs input` section
- Empty group → group header omitted from `lines`

**Unit — `runsList.ts` (peek):**
- `peekRunId = runs[0].runId, peekLines = ['a','b']` → `│ a` and `└ b` appear after the cursor row

**Unit — `runsList.ts` (filter):**
- `filterText = 'tui'` with runs `['tui-audit', 'foo']` → only `tui-audit` row in `rows`
- `filterText = 'wf-4c14'` → matches by runId prefix

**Unit — `runsList.ts` (width budget):**
- `width = 60` → no `duration`/`tokens` columns in header
- `width = 90` → duration + tokens visible
- `width = 130` → cost + approval visible

**Unit — `hotkeys.ts` (filter mode):**
- `dispatchHotkey('a', ..., view='filter')` → `{ kind: 'filter-append', char: 'a' }`
- `dispatchHotkey('Escape', ..., view='filter')` → `{ kind: 'filter-clear' }`

**How to test ANSI output without parsing escapes:**
- Assert on `row.colorHint` (unchanged, always uncolored)
- Assert on `row.coloredLine.includes('\x1b[1;36m')` for running state
- Strip ANSI: `line.replace(/\x1b\[[0-9;]*m/g, '')` === `row.line` (invariant)

**How to test spinner animation:**
- Pass `spinnerFrame: 0` and `spinnerFrame: 5` → state glyph differs (spinner advances)
- `spinnerFrame: 10` → same glyph as `spinnerFrame: 0` (modulo wrap)

**How to test phase cards independently:**
- `PhaseViewCard.lines` is independently renderable; assert without parsing `PhaseViewRender.lines`
- Card box invariant: `lines[0].startsWith('┌')`, `lines[lines.length-1].startsWith('└')`
- Description invariant: when provided, `lines[1]` contains the description text

---

## Open design questions

> **All resolved — Phase 2 shipped 2026-06-02.** Kept here as the
> historical record of how each call was decided. See
> `docs/tui-phase1-plan.md` and `docs/tui-phase2-plan.md` for the
> commits that landed each answer.

1. **Resolved (Phase 2 Slice 11).** `meta.phases[].description?` is now
   declared in `src/types/public.d.ts` as part of the public
   `WorkflowMeta` / `WorkflowMetaPhase` types and re-exported from the
   package root. Backward-compatible additive field. SKILL.md and
   `docs/authoring.md` were updated in the same commit.

2. **Resolved (Phase 1).** In the non-TTY fallback branch of
   `mountOverlay`, ANSI is stripped from any `coloredLine` before
   joining into the `sendMessage` payload
   (`line.replace(/\x1b\[[0-9;]*m/g, '')`). Renderers stay unchanged —
   they always emit both `line` (plain) and `coloredLine` (ANSI). The
   non-TTY branch explicitly uses `line`, not `coloredLine`.

3. **Resolved (Phase 1).** `runsDir` is injected via
   `MountOverlayOpts.runsDir?: string`, defaulting to
   `path.join(os.homedir(), '.pi/agent/workflows/runs')`.
   `hydrateRegistryFromDisk` reads it from there.

4. **Resolved (Phase 2 Slice 6).** Peek panel uses a synchronous tail
   read with a 20 KB cap. Acceptable for typical ledger sizes; the cap
   guarantees the event loop can't be stalled by a pathological run.

5. **Resolved (Phase 2).** `Enter` on a phase card with multiple agents
   drills to agent detail for the first *running* agent (or the first
   agent if none are running). No picker UI in Phase 2; deferred to a
   future phase if demand surfaces.

6. **Resolved (Phase 2 Slice 4).** `gg` chord state lives in
   `overlayState.ts` (post-overlay-split) as `pendingG: boolean` and
   `pendingGAt: number`. Both are passed as explicit inputs to
   `dispatchHotkey`, which remains a pure function. The 300 ms chord
   window timer fires in the overlay action layer; if `pendingG` is
   true and `Date.now() - pendingGAt < 300`, the second `g` returns
   `{ kind: 'navigate-first' }`. Otherwise `pendingG` resets to false.
