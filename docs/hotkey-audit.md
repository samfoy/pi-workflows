# pi-workflows Hotkey & Interaction Layer Audit

**Scope:** `src/runtime/hotkeys.ts`, `overlay.ts` (keystroke routing), `approval.ts`, `pauseGate.ts`  
**Test files reviewed:** `overlayPhaseView.test.ts`, `hitlOverlayInterrupt.test.ts`, `forkOverlayHotkey.test.ts`  
**Date:** 2026-06-02

---

## 1. Complete Hotkey Map

### runs-list (top-level view)

| Key | State Guard | Action |
|-----|------------|--------|
| ↑ / k | always | navigate-up |
| ↓ / j | always | navigate-down |
| Enter | run selected | open-phase-view |
| Esc | always | **close-overlay** (exits entirely) |
| p | running → pause; paused → resume | pause / resume |
| x | running or paused | stop |
| r | paused → **resume**; terminal → restart-requested | ⚠️ overloaded |
| v | run selected (any state) | visualize-requested (writes .mmd to /tmp) |
| i | pendingInterruptCount > 0 | interrupt-answer-requested |
| f | run selected | fork-requested (opens multi-step dialog) |
| g | always | open-gc-dialog |
| ? | always | toggle-help |
| s, t, c | — | noop (silently ignored) |

### phase-view (drilled into a run)

| Key | State Guard | Action |
|-----|------------|--------|
| ↑ / k | always | navigate-up (over agent rows) |
| ↓ / j | always | navigate-down |
| Enter | run selected | open-agent-detail |
| Esc | always | navigate-back → runs-list |
| p | running → pause; paused → resume | pause / resume |
| x | agent-running (cursor) → stop-agent; run running/paused → stop | ⚠️ overloaded |
| r | agent-running (cursor) → restart-agent; paused → **resume**; terminal → restart | ⚠️ triple-overloaded |
| s | terminal only, not remote | save-script-requested |
| v | run selected | visualize-requested |
| i | pendingInterruptCount > 0 | interrupt-answer-requested |
| ? | always | toggle-help |
| f | — | **noop** (fork unavailable here) |

### agent-detail (drilled into an agent)

| Key | Action |
|-----|--------|
| ↑ / k | scroll |
| ↓ / j | scroll |
| t | open-transcript (opens in $EDITOR) |
| c | copy-prompt (to clipboard) |
| Esc | navigate-back → phase-view |
| ? | toggle-help |
| All others | noop |

### GC dialog (overlay-level key interceptor)

| Key | Action |
|-----|--------|
| y / Enter / \r / \n | gc-apply |
| n / Esc | gc-cancel |
| any (after done screen) | gc-cancel (close done screen) |

> GC dialog intercepts keystream BEFORE the hotkey dispatcher. The `?` key is swallowed — you get no help while in the GC dialog.

### Gate prompt (approval during run)

| Key | Action |
|-----|--------|
| y / Enter | approve (run continues) |
| n / Esc | **deny** (run blocked/cancelled) |

---

## 2. Missing Hotkeys

| Missing Key | User Expectation | Current Behaviour |
|-------------|-----------------|-------------------|
| `/` or `Ctrl+F` | Filter/search runs by name or state | No filtering; cursor-only navigation regardless of list size |
| `y` / `Ctrl+Y` on runs-list | Yank/copy the selected run ID to clipboard | `y` is unmapped (noop); users must manually type run IDs for CLI commands |
| `t` on runs-list / phase-view | Open ledger.jsonl or run dir in editor | Only available in agent-detail; no entry point from higher views |
| `gg` / `G` | Jump to top / bottom of list (vim) | `g` opens GC dialog; `G` is an alias for `g`; no jump-to-end |
| `Ctrl+L` | Force redraw / refresh display | No manual refresh; relies on debounced subscription events |
| `f` in phase-view | Fork from the phase you're currently looking at | noop with `disabled-for-state`; must `Esc` back to runs-list first |
| Next/cycle interrupt (`I` capital?) | Cycle through multiple pending interrupts | `i` answers only the *oldest* one; no way to see or skip others |
| `d` / `D` | Expand/collapse a completed phase | No collapse; all phases always visible |
| `?` in GC dialog | Show GC-specific help | `?` is swallowed by the GC dialog interceptor; user sees nothing |

---

## 3. Approval / Interrupt Workflow

### Pre-run approval (`approval.ts` + `makeConfirmDialog`)

The dialog is implemented as a **sequential chain of binary confirms**, not a single 4-button UI:

```
"Approve once?" → YES → "Don't ask again?" → YES → always / NO → run-once
                → NO  → "View raw script?"  → YES → view, re-prompt / NO → deny
```

**Issues:**

1. **Options revealed progressively** — Users don't see all four choices at once. Someone who instinctively says "no" to the first prompt may not know viewing the script is an option.
2. **Mismatch warning buried** — The SHA-256 mismatch notice is concatenated into the first `confirm` text block. It's easy to miss in a long string.
3. **No cancel-without-denying** — Pressing Esc on a terminal confirm typically means "cancel the dialog" (i.e., decide later), but the waterfall treats it as the same as "no" then "no" (deny). Users can't defer approval.
4. **`VIEW_REPROMPT_LIMIT = 10`** — If the viewer fails, the user is silently looped up to 10 times with no error feedback, then denied automatically.

### HITL interrupt flow (`overlay.ts` + `i` key)

1. Workflow calls `ctx.interrupt(...)`, which emits `pi-workflows.interrupt.requested`.
2. The overlay observes the event and enables the `i` help bullet.
3. User presses `i` → `onInterruptAnswerRequested` callback → `ctx.ui.select` / `ctx.ui.input` prompt.
4. Answer is passed to `run.respondInterrupt(value, key)` → workflow resumes.

**Issues:**

1. **No visual call-to-action on the run row** — The pending interrupt is only visible in the help line at the bottom. There's no badge or indicator on the run's row in the list (e.g., "⚑ 2 pending").
2. **No UX feedback while waiting for answer** — After pressing `i`, `onInterruptAnswerRequested` is called async. The overlay continues rendering the run list with no spinner or "waiting for answer" indication. The overlay effectively freezes for the user during the `ctx.ui.select` call.
3. **Cancelled `ctx.ui.input` → run stuck** — If the user dismisses the `ctx.ui.input` prompt (returns `undefined`), the callback returns without calling `respondInterrupt`. The workflow remains blocked on `ctx.interrupt()` with no visible indication and no way to re-trigger except pressing `i` again — which requires the hint to still be enabled (it will be, since the interrupt isn't resolved).
4. **Multiple interrupts queue silently** — `i` answers only the oldest. If 3 interrupts are pending, the help shows `i: answer prompt` once; no count is visible. The user must press `i` three times with no feedback between presses.

---

## 4. Dead States

| Scenario | How You Get There | Way Out? |
|----------|------------------|----------|
| **`ctx.interrupt()` + `ui.input` cancelled** | User presses `i`, sees the select/input prompt, presses Esc to cancel | Stuck — workflow blocked forever on the interrupt. Must press `i` again, which works but isn't communicated. |
| **`makeConfirmDialog` viewer fails repeatedly** | Viewer (`$EDITOR`) errors on open; user keeps seeing the "view?" prompt | Silent re-loop up to 10 times, then auto-deny with no explanation. |
| **Fork dialog hangs** (`f` key, slow ledger read) | Large ledger; `f` opens "opening fork dialog for wf-xxx…" banner | No escape key during async callback. Banner says "opening…" until it resolves or errors. No cancel path. |
| **Gate prompt Esc = deny** | User habitually presses Esc to dismiss a dialog | Run is denied/cancelled. Esc is not reversible here — there's no "undo deny". |
| **GC dialog error during `loadGcCandidates`** | Storage failure; GC dialog state has `candidates=undefined` | The key interceptor is still active (gcDialogState !== null); y/Enter will call gc-apply on an empty candidate list. Unclear what that does downstream. |
| **`p` + `r` both resume on paused run** | User pauses a run, presses `r` expecting to restart later | Run resumes immediately. `r` on paused = resume, not restart. This is documented but not obvious; help shows both `p: resume` and `r: resume` when paused. |
| **Non-TTY fallback → singleton not reset** | `mountOverlay` takes the non-TTY chat path; `_overlayOpen` may stay `true` depending on cleanup path | Subsequent `/workflows` invocations return `already-open` until the flag is reset. |

---

## 5. Help Display (`?` key)

### What works

- **Context-sensitive**: different `HelpBullet[]` arrays per view.
- **Grayed-out disabled keys**: disabled bullets are included, so users see `r: restart (grayed)` rather than `r` disappearing from the list.
- **Agent-state-aware**: when cursor is on a running agent in phase-view, `r` label changes to "restart agent" and `x` to "stop agent".
- **Interrupt-count-aware**: `i` is only shown as enabled when `pendingInterruptCount > 0`.

### Problems

1. **`p` and `r` both show "resume" when run is paused** — The help line will render two enabled bullets with the same label. No disambiguation.

2. **No GC-dialog help** — `?` is swallowed by the GC dialog key interceptor. User presses `?` while in the dialog → nothing happens. The dialog should show its own `[y] apply / [n] cancel / [Esc] cancel` footer.

3. **Multi-step actions have no hint** — `f: fork` and `i: answer prompt` both trigger multi-step flows (select + input prompts), but the help says only the key + one-word label. There's no `→` indicator or `(multi-step)` suffix.

4. **`v: viz` — no path to the output** — The help says `v: viz`. The action writes a Mermaid `.mmd` file to `/tmp`. The help (and the action toast) should surface the file path so the user knows where to look.

5. **`s: save script` only in phase-view** — The help on runs-list doesn't mention `s` at all (it's absent from `helpForState` for runs-list). Users drilling into phase-view to find `s` don't get a prior hint that it's there.

6. **Toggle behavior is invisible** — `?` toggles help. There's no visual indicator of whether help is currently on or off (i.e., the `?` bullet itself doesn't say "toggle" — it says "help"). If help is already showing, pressing `?` again should close it, but there's no visual affordance for this.

---

## 6. Key Conflicts and Non-Intuitive Bindings

| Key | pi-workflows meaning | Common TUI convention | Conflict severity |
|-----|---------------------|----------------------|-------------------|
| `g` | open-gc-dialog | `gg` = jump to top (vim) | **High** — most vim users will hit `g` expecting top-of-list and trigger GC |
| `G` | alias for `g` (gc-dialog) | `G` = jump to bottom (vim) | **High** — same problem |
| `r` on paused | resume | `r` = restart/reload | **High** — breaks the mental model; users will press `r` expecting restart and resume instead |
| `r` on running+agent | restart-agent | — | **Medium** — triple-overload of `r` (resume / restart-run / restart-agent) |
| `x` | stop/kill | `d` = delete/kill (lazygit); `Ctrl+C` = interrupt | **Low** — `x` for delete is used in lazygit; acceptable but not universal |
| `Esc` in gate prompt | **deny** | cancel/dismiss (no action) | **Medium** — in nearly every other modal, Esc = "I didn't decide"; here it = "no" |
| `c` on runs-list | noop (unknown-key) | copy/yank | **Low** — silent noop is better than wrong action, but frustrating |
| `y`/`n` in GC dialog | confirm/cancel | copy (vim `y`) | **Low** — y/n are appropriate for a dedicated dialog; issue is they're not in the normalizer for other views |
| `p`+`r` both resume | both resume on paused | single toggle key | **Medium** — redundancy creates confusion about which key "owns" the operation |
| `s` restricted to phase-view | save-script | `s` = save (universal) | **Low** — restriction is correct (frozen script only exists at terminal) but the view-restriction is surprising |
| `f` unavailable in phase-view | noop | fork from current context | **Medium** — the natural UX is: drill into a run's phases, then fork from the phase you can see |

### Summary of critical conflicts

1. **`g` / `G` = gc-dialog** — direct collision with vim's universal navigation idiom. Rename GC to a less-common key (e.g., `Ctrl+G`, `!`, or a two-key sequence like `gc`).
2. **`r` = resume when paused** — should be `p`-only. `r` should mean restart in all states it's enabled, with `p` owning the pause/resume toggle exclusively. Current behavior where both `p` and `r` resume a paused run is an undocumented footgun.
3. **Esc = deny in gate prompt** — should be "cancel without deciding" (re-show the prompt), not "deny". Align with the `VIEW_REPROMPT_LIMIT` cancel-on-exhaustion pattern rather than treating Esc as a negative choice.

---

## Quick-Reference Gap Summary

| Category | Count | Top Issues |
|----------|-------|-----------|
| Missing keys | 9 | No search, no copy-runId, no jump-to-top/bottom, no GC help |
| Dead states | 6 | Cancelled interrupt hangs run, Esc=deny in gate, fork hang |
| Approval UX | 4 | Sequential confirms, buried mismatch, no defer |
| Help gaps | 6 | GC dialog swallows `?`, multi-step not indicated, `v` no path |
| Key conflicts | 4 critical | `g`=gc (vs vim top), `r` overloaded, Esc=deny |
