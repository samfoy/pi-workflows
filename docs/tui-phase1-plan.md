# TUI Redesign — Phase 1 Build Plan

**Scope:** Critical bugs (B1–B3, B5–B6), visual quick wins (VQ-1 through VQ-9), interaction fixes (I1–I3).  
**Constraint:** No type signature breakage. No test rewrites. All changes are additive or in-place.  
**Spec:** `docs/tui-redesign.md`  
**Test run:** `node --import tsx --test tests/unit/runsList.test.ts tests/unit/hotkeys.test.ts tests/unit/activeRuns.test.ts tests/unit/agentDetail.test.ts` (fast path); full suite `npm test`.

---

## Slice order rationale

```
VQ-8 → VQ-5 → VQ-9 → I3           (standalone, no deps)
→ VQ-6                              (wires width into renderers — enables VQ-7)
→ VQ-7                              (clamps help bar — depends on VQ-6)
→ B6                                (stale PID — touches activeRuns.ts)
→ B1                                (disk hydration — reuses B6 isAlive, touches overlay.ts)
→ VQ-1                              (coloredLine — additive to RenderedRow)
→ VQ-1-tests
→ VQ-2+VQ-4                         (hotkey remaps — both touch hotkeys.ts)
→ VQ-2+VQ-4-tests
→ VQ-3                              (header polish — touches RenderedRunsList after VQ-1)
→ B2                                (stub leak — touches index.ts before_agent_start)
→ I1                                (Esc snooze — touches overlay.ts)
→ I2                                (interrupt dead state — touches workflowCmd.ts)
```

---

### Slice 1: Extract `fmtDuration` to shared util (VQ-8)

**Goal:** Remove the raw-milliseconds display bug in `visualize.ts`; establish a single source of truth for duration formatting.

**Files:**
- `src/util/time.ts` — new file; re-export `fmtDuration` and `fmtRelative` (moved from `runsList.ts`)
- `src/runtime/runsList.ts` — re-export from `util/time.ts` (keep named exports for back-compat)
- `src/runtime/visualize.ts` — replace raw `ms` string with `fmtDuration(ms)` at both call sites

**Acceptance:**
- `visualize.ts` emits `"4m 58s"` for a 298 000 ms agent, not `"298000ms"`
- `fmtDuration` and `fmtRelative` still importable from `runsList.ts` (no consumer breakage)
- `npm test` passes unchanged

**Dependencies:** None

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts` (existing tests cover fmtDuration)

**Risk:** Low. Pure refactor; no logic change. Only risk is a missed call site in `visualize.ts` — grep for `ms\`` or `durationMs}` before committing.

---

### Slice 2: Fix `padEnd` overflow in `phaseView.ts` (VQ-5 / B5)

**Goal:** Phase names and agent summaries that exceed their column widths no longer misalign all subsequent columns.

**Files:**
- `src/runtime/phaseView.ts` — replace `.padEnd(14)` with `pad(str, 14)` at lines ~165 and ~181; import `pad` from `runsList.ts` (it already exists there)

**Acceptance:**
- Phase name `"reconcile-outputs"` (17 chars) renders as `"reconcile-outpu…"` (14 chars + ellipsis) not 17 chars raw
- Agent summary cell is also capped at its column width
- All existing `tests/unit/agentDetail.test.ts` and `overlayPhaseView.test.ts` pass

**Dependencies:** None (Slice 1 is independent)

**Verification:** `node --import tsx --test tests/unit/agentDetail.test.ts tests/integration/overlayPhaseView.test.ts`

**Risk:** Low. `pad()` already has truncation logic; this is a 2-line change.

---

### Slice 3: Scroll position label in agent detail (VQ-9)

**Goal:** When the user has scrolled up in the agent log tail, the header shows their position instead of a misleading "last N lines" label.

**Files:**
- `src/runtime/agentDetail.ts` — change the `"Live tail (last N lines)"` label at ~line 138 to `scrollOffset > 0 ? \`Log  [${startIdx + 1}–${endIdx} of ${snap.logTail.length}]  ↑↓ scroll\` : \`Live tail (last ${logCount} lines)\``

**Acceptance:**
- `scrollOffset === 0` → header reads `"Live tail (last 12 lines)"` (existing behavior)
- `scrollOffset === 5, logTail.length === 20` → header reads `"Log  [4–15 of 20]  ↑↓ scroll"`
- No other output lines change

**Dependencies:** None

**Verification:** `node --import tsx --test tests/unit/agentDetail.test.ts`

**Risk:** Low. Single conditional expression.

---

### Slice 4: Fix SKILL.md command reference (I3)

**Goal:** `/workflows status` does not exist; the skill doc must say `/workflows show`.

**Files:**
- `skills/pi-workflows/SKILL.md` — replace every instance of `/workflows status` with `/workflows show`; add one-paragraph quickstart explaining result delivery (workflow finishes → chat card appears, no polling needed)

**Acceptance:**
- `grep "workflows status" skills/pi-workflows/SKILL.md` returns no matches
- Quickstart paragraph present: mentions `/workflows show <id>`, describes result delivery as a follow-up chat turn

**Dependencies:** None

**Verification:** Manual read; `grep -c "workflows status" skills/pi-workflows/SKILL.md` → `0`

**Risk:** None. Text-only change.

---

### Slice 5: Thread `width` through renderer opts (VQ-6)

**Goal:** Every renderer accepts a `width` parameter so downstream slices (help-bar clamp, Phase 2 responsive columns) have a clean injection point. No layout changes in this slice — just wire the plumbing.

**Files:**
- `src/runtime/runsList.ts` — add `readonly width?: number` to `RenderOpts`; pass to internal helpers (no layout logic yet — width is received, stored in local, not yet used)
- `src/runtime/phaseView.ts` — add `readonly width?: number` to `PhaseViewOpts`; forward to `renderPhaseView`
- `src/runtime/agentDetail.ts` — add `readonly width?: number` to `AgentDetailOpts`
- `src/runtime/overlay.ts` — pass `render(_width)` arg into `renderRunsList`/`renderPhaseView`/`renderAgentDetail` as `width: _width`

**Acceptance:**
- `renderRunsList(runs, { width: 80 })` does not throw; returns same output as without `width` (layout unchanged in this slice)
- `render(120)` in overlay calls renderers with `width: 120` (verifiable via unit test or debug log)
- All existing renderer tests pass unchanged

**Dependencies:** None (Slice 1–4 independent)

**Verification:** `npm test` — all existing tests pass; no new failures.

**Risk:** Low. Additive type widening. The one trap: TypeScript will error if `_width` was previously marked `_width: number` with underscore suppression — confirm the parameter name in `overlay.ts:1410` before changing.

---

### Slice 6: Clamp help bar to terminal width (VQ-7 / B3)

**Goal:** The hotkey hint line never overflows the terminal width. Overflow truncates at a word boundary with `…` rather than wrapping onto a second line.

**Files:**
- `src/runtime/runsList.ts` — in `renderRunsList`, after assembling the `help` string, add: if `opts.width` is set and `help.length > opts.width - 2`, truncate to `opts.width - 5` chars and append `"…"`
- `src/runtime/overlay.ts` — no change needed (width already passed via Slice 5)

**Acceptance:**
- `renderRunsList(runs, { width: 60, help: [...longBullets] })` — `help` string length ≤ 58
- `renderRunsList(runs, { width: 200 })` — full help string rendered (no truncation on wide terminal)
- Existing help-render tests pass

**Dependencies:** Slice 5 (width in `RenderOpts`)

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts`

**Risk:** Low. One conditional in `renderRunsList`. Edge case: `width` of 0 or 1 — add `Math.max(10, opts.width)` guard.

---

### Slice 7: Stale PID detection (B6)

**Goal:** Runs whose parent pi process has exited no longer show as `running` in a fresh overlay session.

**Files:**
- `src/runtime/activeRuns.ts` — add synchronous `isAlive(parentPid: number, parentBootId: string): boolean` function; uses `/proc/<pid>/stat` on Linux and `process.kill(pid, 0)` + boot-time cross-check on macOS; returns `false` when pid is absent or boot time mismatches
- `src/runtime/activeRuns.ts` — in `applyEntry()` for `run.transitioned` events where the new state is `"running"`: if the entry carries `parentPid`/`parentBootId` and `isAlive(...)` returns `false`, coerce the synthetic state to `"failed"` in the summary (do NOT mutate the ledger — display-layer only)

**Acceptance:**
- `isAlive(99999999, "")` returns `false` (no such PID)
- A hydrated summary whose ledger shows `running` but whose parent PID is dead displays `failed` in the runs list
- Live in-process runs (whose PID is the current process) remain `running`
- No `await` in `isAlive` — synchronous throughout

**Dependencies:** None (standalone activeRuns.ts change, does not require B1)

**Verification:** `node --import tsx --test tests/unit/activeRuns.test.ts`

**Risk:** Medium. PID recycling edge case: a new unrelated process may reuse the old PID. The `parentBootId` cross-check mitigates this on Linux (read from `/proc/stat` `btime`). On macOS, `sysctl kern.boottime` parsing is needed — if unavailable, fall back to PID-only check with a comment. The `isAlive` function must never throw — wrap in try/catch, return `true` on error (prefer false-negative over false-positive for live runs).

---

### Slice 8: Disk hydration on overlay mount (B1)

**Goal:** Opening `w` in a fresh session shows historical runs from disk immediately, not `(no runs)`.

**Files:**
- `src/runtime/activeRuns.ts` — add `hydrateRegistryFromDisk(registry: ActiveRunsRegistry, runsDir: string): Promise<void>`:
  - Scans `runsDir` for directories containing `manifest.json`; sorted newest-first by mtime; capped at 200
  - For each, reads `manifest.json` (runId, workflowName, startedAt, state) + last 2 lines of `ledger.jsonl` for final state
  - Calls `registry.applyEntry(...)` with synthetic entries; skips runIds already in registry (live runs take precedence)
  - Calls `registry.notifySubscribers()` once after the batch (not per-run)
  - Errors on individual runs are silently swallowed (log via `registry.debug` if available)
- `src/runtime/overlay.ts` — add `runsDir?: string` to `MountOverlayOpts` (defaults to `path.join(os.homedir(), '.pi/agent/workflows/runs')`); call `hydrateRegistryFromDisk(registry, runsDir).catch(() => {})` immediately after registry construction, before mounting the component

**Acceptance:**
- Fresh session with ≥1 prior run on disk: overlay shows ≥1 run within 500 ms of opening (repaint after async hydration)
- Live in-process runs are NOT overwritten by disk hydration (live handle takes precedence)
- Hydration of 200 disk runs completes in < 2 s on a standard laptop (no full ledger reads — only last 2 lines)
- `MountOverlayOpts.runsDir` is injectable for tests (pass a tmpdir)

**Dependencies:** Slice 7 (B6 stale-PID check — `hydrateRegistryFromDisk` calls `isAlive` to avoid marking live runs as stale)

**Verification:** `node --import tsx --test tests/unit/activeRuns.test.ts tests/integration/overlayPhaseView.test.ts`

**Risk:** High (most complex slice). The main risk is `manifest.json` schema divergence between run versions — parse defensively, skip malformed entries. Second risk: `notifySubscribers()` on a large batch triggers rapid re-renders; confirm the 30–50 ms debounce in `overlay.ts` absorbs the burst.

---

### Slice 9: ANSI color on state labels (VQ-1)

**Goal:** `running` rows are bold cyan, `failed` bold red, `done` bold green, `paused` bold yellow, `stopped` dim — at a glance, no eye-scanning needed.

**Files:**
- `src/runtime/runsList.ts` — add `readonly coloredLine: string` to `RenderedRow` (alongside existing `line: string` — both always present); implement `ansiState(state)` map → ANSI prefix+reset; `coloredLine = ansiPrefix + row.line + RESET`; `lines[]` in `RenderedRunsList` remains composed from `row.line` (plain), not `coloredLine`
- `src/runtime/overlay.ts` — in TTY render path, replace `r.line` with `r.coloredLine` when assembling the component's `render()` output; non-TTY path (`view.lines.join("\n")`) unchanged (already uses plain `line`)

**Acceptance:**
- `renderRunsList([runningRun]).rows[0].coloredLine` contains `\x1b[1;36m` (bold cyan)
- `renderRunsList([failedRun]).rows[0].coloredLine` contains `\x1b[1;31m` (bold red)
- `renderRunsList(runs).rows[0].line` is unchanged (no ANSI escapes)
- `lines[]` in `RenderedRunsList` contains plain text only
- Strip-ANSI invariant: `row.coloredLine.replace(/\x1b\[[0-9;]*m/g, '') === row.line`

**Dependencies:** Slices 1–8 logically independent; placed here so VQ-3 (header color) can follow cleanly.

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts`

**Risk:** Low. Additive field; no existing field changed. One edge case: `colorHint === "neutral"` → no color prefix (plain line copied as-is to `coloredLine`).

---

### Slice 10: Tests for ANSI color (VQ-1 tests)

**Goal:** Explicit unit assertions for the color-state mapping and the strip-ANSI invariant; prevent regressions when color map changes.

**Files:**
- `tests/unit/runsList.test.ts` — add test group `"coloredLine"`:
  - Assert each `colorHint` value maps to expected ANSI code in `coloredLine`
  - Assert `row.line` never contains ANSI escapes
  - Assert strip-ANSI invariant: `coloredLine.replace(ANSI_RE, '') === line` for all states
  - Assert `lines[]` in `RenderedRunsList` contains only plain-text entries

**Acceptance:**
- All new assertions pass
- No existing tests broken

**Dependencies:** Slice 9

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts`

**Risk:** None.

---

### Slice 11: Remap `G` for GC; add `u` for unpause; make `r` terminal-only (VQ-2 + VQ-4)

**Goal:** Eliminate the three critical hotkey conflicts in one slice (both touch `hotkeys.ts`; splitting would leave the map in an inconsistent in-between state).

**Changes:**
1. **`G` → GC, `gg` chord → jump-first:** In `NORM_KEY`, change `["G", "g"]` to `["G", "G"]`. Add `"navigate-first"` and `"navigate-last"` to `HotkeyActionKind`. In `dispatchHotkey`, `case 'G':` → `{ kind: "open-gc-dialog" }`; `case 'g':` with chord state `pendingG && Date.now() - pendingGAt < 300` → `{ kind: "navigate-first" }`, else set `pendingG = true, pendingGAt = now` and return `{ kind: "noop", reason: "pending-chord" }`. Chord state (`pendingG`, `pendingGAt`) added to `DispatchInput` (per spec Q6 resolution — option a).
2. **`u` → unpause:** Add `["u", "u"]` / `["U", "u"]` to `NORM_KEY`. In `dispatchHotkey`, `case 'u':` → `{ kind: "resume" }` when `runState === "paused"`, else noop.
3. **`r` → terminal restart only:** Remove the `runState === "paused" → resume` branch from `case 'r':` in both `isHotkeyEnabled` and `dispatchHotkey`. `r` now only fires `restart-requested` (terminal states) and `restart-agent` (phase-view running agent). Update `helpForState` to reflect the new labels.
4. **`p` → pause only:** Remove the `runState === "paused" → resume` branch from `case 'p':`. `p` now only fires `pause` when `running`. Update `isHotkeyEnabled` accordingly.

**Files:**
- `src/runtime/hotkeys.ts` — all four changes above + `pendingG`/`pendingGAt` added to `DispatchInput`
- `src/runtime/overlay.ts` — pass `pendingG`/`pendingGAt` from overlay state into `dispatchHotkey`; handle `navigate-first` / `navigate-last` actions (jump cursor to 0 / last index); handle `resume` from `u` key (same callback as existing resume path)

**Acceptance:**
- `dispatchHotkey({ key: 'G', view: 'runs-list', runState: 'done', pendingG: false, pendingGAt: 0 })` → `{ kind: 'open-gc-dialog' }`
- `dispatchHotkey({ key: 'g', ..., pendingG: true, pendingGAt: Date.now() - 100 })` → `{ kind: 'navigate-first' }`
- `dispatchHotkey({ key: 'u', ..., runState: 'paused' })` → `{ kind: 'resume' }`
- `dispatchHotkey({ key: 'p', ..., runState: 'paused' })` → `{ kind: 'noop', reason: 'disabled-for-state' }`
- `dispatchHotkey({ key: 'r', ..., runState: 'paused' })` → `{ kind: 'noop', reason: 'disabled-for-state' }`
- `dispatchHotkey({ key: 'r', ..., runState: 'done' })` → `{ kind: 'restart-requested' }`

**Dependencies:** None (hotkeys.ts is self-contained; overlay.ts changes follow naturally)

**Verification:** `node --import tsx --test tests/unit/hotkeys.test.ts`

**Risk:** Medium. `r`-for-resume removal is a behavior change — users who muscle-memoried `r` to unpause will need to learn `u`. Risk of breaking existing hotkey tests that assert `r` resumes a paused run — those must be updated to assert `u` instead (this is a test update, not a rewrite). The chord timer in overlay.ts needs cleanup on overlay close to avoid stale `pendingG` state.

---

### Slice 12: Tests for hotkey remaps (VQ-2 + VQ-4 tests)

**Goal:** Comprehensive matrix coverage of the new `G`/`gg`/`u`/`r`/`p` behavior; pin against regression.

**Files:**
- `tests/unit/hotkeys.test.ts` — add/update assertions:
  - `G` → `open-gc-dialog` in runs-list (was `g`)
  - `g` with `pendingG: false` → `noop` (reason: `pending-chord`)
  - `g` with `pendingG: true, pendingGAt: now - 100` → `navigate-first`
  - `g` with `pendingG: true, pendingGAt: now - 400` (expired) → `noop` (chord timed out)
  - `u` on paused run → `resume`
  - `u` on running run → `noop`
  - `p` on paused run → `noop` (disabled-for-state)
  - `p` on running run → `pause` (unchanged)
  - `r` on paused run → `noop` (disabled-for-state)
  - `r` on done run → `restart-requested` (unchanged)

**Acceptance:**
- All new and updated assertions pass
- `npm test` passes

**Dependencies:** Slice 11

**Verification:** `node --import tsx --test tests/unit/hotkeys.test.ts`

**Risk:** None.

---

### Slice 13: Bold header + separator line (VQ-3)

**Goal:** The column header row stands out from data rows; a `─` separator makes the table easier to scan.

**Files:**
- `src/runtime/runsList.ts` — add `readonly coloredHeader: string` to `RenderedRunsList` (bold ANSI-wrapped version of `header`); insert a `separator` line (`"─".repeat(Math.min(headerCols.join(" ").length, opts.width ?? 999))`) into `lines[]` immediately after `header`; `header` field unchanged (plain text)
- `src/runtime/overlay.ts` — TTY render path uses `coloredHeader` instead of `header` when building the component's line list

**Acceptance:**
- `renderRunsList(runs).coloredHeader` starts with `\x1b[1m` (bold) and ends with `\x1b[0m` (reset)
- `renderRunsList(runs).lines[3]` is a `─` separator (index 0=title, 1=subtitle, 2=blank, 3=header, 4=separator)
- `renderRunsList(runs).header` is unchanged plain text
- Existing tests that assert `lines` indices may need index offset update (+1 for separator) — update, don't skip

**Dependencies:** Slice 9 (VQ-1 established the `coloredLine` pattern this follows)

**Verification:** `node --import tsx --test tests/unit/runsList.test.ts`

**Risk:** Low. Adding a line to `lines[]` shifts all subsequent line indices — any existing test asserting `lines[4]` will need `lines[5]`. Audit `runsList.test.ts` for index-based assertions before committing.

---

### Slice 14: Fix stub leak into AI context (B2)

**Goal:** `/workflows list` output no longer appears in the model's context window on the next turn.

**Root cause:** `STUB_CUSTOM_TYPE` messages use `triggerTurn: false, deliverAs: "nextTurn"` — they land in the message history and become visible to the model on the subsequent turn.

**Fix:** In `src/index.ts`, extend the `before_agent_start` handler to filter stub messages from the messages array before the model sees them:

```typescript
pi.on("before_agent_start", async (rawEvent) => {
  const event = rawEvent as { messages?: Array<{ customType?: string }> };
  if (event.messages) {
    event.messages = event.messages.filter(
      (m) => m.customType !== STUB_CUSTOM_TYPE
    );
  }
  // existing keyword-trigger logic unchanged below
  ...
});
```

If the pi SDK `before_agent_start` event does not expose a mutable `messages` array, use the fallback: change all `deliverAs: "nextTurn"` to `deliverAs: "none"` in `workflowCmd.ts` for the list/show/status paths (these are display-only; they do not need to land in history at all).

**Files:**
- `src/index.ts` — add message filtering in `before_agent_start` (primary fix)
- `src/commands/workflowCmd.ts` — fallback only: change `deliverAs: "nextTurn"` → `deliverAs: "none"` for list/show output if SDK filtering is unavailable

**Acceptance:**
- `/workflows list` followed immediately by "hello" → model turn does NOT reference workflow history or run IDs
- `/workflows show <id>` followed by a question → model treats it as a fresh question with no workflow context injected
- Result delivery cards (end-of-run) are unaffected (they use a different customType)

**Dependencies:** None (logically independent; placed late because it requires SDK behavior investigation before implementing)

**Verification:** Manual smoke test: run `/workflows list`, send "what was that?", confirm model response does not describe the list output.

**Risk:** Medium. The fix depends on whether `before_agent_start` exposes a mutable messages array — this varies by pi SDK version. If not exposed, `deliverAs: "none"` is the safe fallback but means list/show output is truly ephemeral (doesn't persist across scrollback either). Confirm SDK surface before implementing primary fix; ship fallback if blocked.

---

### Slice 15: `Esc` in gate prompt means snooze, not deny (I1)

**Goal:** Pressing `Esc` on an interrupt/gate prompt defers the decision rather than silently denying it.

**Files:**
- `src/runtime/overlay.ts` — in the interrupt-answer flow (HITL overlay input handler): change `Esc` from resolving the interrupt with `"deny"` to displaying a banner `"interrupt deferred — press [i] again or [x] to stop"` and leaving the interrupt promise unresolved
- `src/runtime/hotkeys.ts` — update `helpForState` for interrupt-active state: `[Enter] approve  [n] deny  [Esc] defer`

**Acceptance:**
- `Esc` during an interrupt prompt: interrupt promise remains pending; banner appears; run continues waiting
- `n` during an interrupt prompt: interrupt resolves as deny (explicit refusal)
- `[Enter]` during an interrupt prompt: interrupt resolves as approve (unchanged)
- Help line shows `[Esc] defer` not `[Esc] close`

**Dependencies:** None (overlay.ts change is localized to the HITL input branch)

**Verification:** `node --import tsx --test tests/unit/overlayHitlFork.test.ts tests/integration/hitlOverlayInterrupt.test.ts`

**Risk:** Low–Medium. The promise must remain genuinely unresolved (not timed out). Confirm that leaving the interrupt pending does not block the run's phase from progressing — the run waits on interrupt resolution, so deferring is a valid "hold" state. Ensure the banner clears when `i` is pressed again (don't accumulate banners).

---

### Slice 16: Fix cancelled interrupt dead state (I2)

**Goal:** If the user opens the interrupt prompt and then closes the overlay without answering, the run is not permanently stuck.

**Files:**
- `src/commands/workflowCmd.ts` — in the `pi.ui.input` / `pi.ui.confirm` call for interrupt answers (around line 674 TODO): catch prompt cancellation (rejected promise or empty input) and either (a) resolve the interrupt with the interrupt's `default` value if one is set, or (b) show the overlay banner `"interrupt prompt closed — press [i] to re-open or [x] to stop"` and leave the promise pending (same snooze behavior as I1's `Esc`)
- `src/runtime/overlay.ts` — ensure the interrupt-active banner persists across overlay close/reopen so the user knows a pending interrupt exists even after dismissing

**Acceptance:**
- Close overlay while interrupt is pending → run does NOT permanently wedge
- Re-opening `w` shows the interrupt banner
- If interrupt has a `default` value, closing the prompt resolves it with that value and run proceeds
- `[x]` stop still works regardless of pending interrupt state

**Dependencies:** Slice 15 (I1 established the snooze/defer pattern this extends)

**Verification:** `node --import tsx --test tests/integration/hitlOverlayInterrupt.test.ts tests/unit/overlayHitlFork.test.ts`

**Risk:** Medium. The core risk is that `pi.ui.input` may not have a clean cancellation signal (depends on SDK). If cancellation throws, wrap in try/catch and apply the `default`-or-snooze logic in the catch branch. The "persist banner across close" requirement touches the overlay teardown path — ensure `_overlayOpen` reset does not also reset pending interrupt state.

---

## Summary table

| # | Slice | Size | Files touched | Depends on |
|---|-------|------|---------------|------------|
| 1 | Extract `fmtDuration` to util (VQ-8) | S | `util/time.ts` (new), `runsList.ts`, `visualize.ts` | — |
| 2 | Fix `padEnd` overflow in phaseView (VQ-5/B5) | S | `phaseView.ts` | — |
| 3 | Scroll position label in agentDetail (VQ-9) | S | `agentDetail.ts` | — |
| 4 | Fix SKILL.md command reference (I3) | S | `skills/pi-workflows/SKILL.md` | — |
| 5 | Thread `width` through renderer opts (VQ-6) | S | `runsList.ts`, `phaseView.ts`, `agentDetail.ts`, `overlay.ts` | — |
| 6 | Clamp help bar to terminal width (VQ-7/B3) | S | `runsList.ts` | 5 |
| 7 | Stale PID detection (B6) | S | `activeRuns.ts` | — |
| 8 | Disk hydration on overlay mount (B1) | M | `activeRuns.ts`, `overlay.ts` | 7 |
| 9 | ANSI color on state labels (VQ-1) | S | `runsList.ts`, `overlay.ts` | — |
| 10 | Tests for ANSI color (VQ-1 tests) | S | `tests/unit/runsList.test.ts` | 9 |
| 11 | Hotkey remaps: G/gg/u/r/p (VQ-2+VQ-4) | M | `hotkeys.ts`, `overlay.ts` | — |
| 12 | Tests for hotkey remaps | S | `tests/unit/hotkeys.test.ts` | 11 |
| 13 | Bold header + separator (VQ-3) | S | `runsList.ts`, `overlay.ts` | 9 |
| 14 | Fix stub leak into AI context (B2) | M | `index.ts`, `workflowCmd.ts` | — |
| 15 | Esc in gate prompt = snooze (I1) | S | `overlay.ts`, `hotkeys.ts` | — |
| 16 | Fix cancelled interrupt dead state (I2) | M | `workflowCmd.ts`, `overlay.ts` | 15 |

**Total: 16 slices — 10 S, 6 M. Estimated wall clock: 8–12 hours for a focused builder.**

Slices 1–7 can be built in any order (all standalone). Slices 5→6 and 7→8 and 9→10 and 11→12 and 15→16 are the only hard ordering constraints.
