/**
 * tests/unit/replayStateMutationKill.test.ts — slice 11 [C1].
 *
 * Pins the exact contract that `replayState` *skips* invalid
 * transitions instead of advancing through them. Slice 7's existing
 * "invalid-transition fixture" test only asserts the warning surfaces
 * — under critic-t1c3's mutation probe (M3, removing `continue;` after
 * the warning), all 39 ledger tests still passed. That meant the skip
 * vs advance distinction was un-witnessed, which slice 11's resume
 * derivation depends on.
 *
 * Witness construction: a sequence whose final state DIFFERS by
 * skip-vs-advance:
 *
 *   approved → running     (legal)
 *   running  → done        (legal — final legal state is `done`)
 *   done     → running     (illegal — terminal has no outgoing edges)
 *   running  → failed      (illegal IF advanced through prior — `done`
 *                            has no outgoing — but legal IF skip kept
 *                            us at `done`. Wait: from `running`. But if
 *                            replay correctly stays at `done` because
 *                            done→running is illegal, then THIS line is
 *                            also illegal because `from`-field claim is
 *                            ignored — replay re-validates from current
 *                            state. So replay sees done→failed which is
 *                            illegal too, leaving final=`done`.)
 *
 * Different witness needed: build a case where skip vs advance give
 * different final states.
 *
 *   pending  → approved     (legal)
 *   approved → running      (legal)
 *   running  → paused       (legal)
 *   paused   → done         (illegal — paused has no done edge)
 *   paused   → running      (legal — replay stays at paused, applies)
 *   running  → done         (legal)
 *
 *   Skip-correct final: done.
 *   Advance-broken final: ALSO done — that's the existing test.
 *
 * So we need a sequence where after the illegal transition's `to`
 * state, the next transition's `from` matches `to` of the illegal but
 * NOT the actual current state. Replay validates against the actual
 * state, so:
 *
 *   running → done          (legal, current=done after)
 *   done    → failed        (illegal — terminal; current=done after both
 *                            skip and advance interpretations because
 *                            advance would set to failed but replay
 *                            uses the to field directly... )
 *
 * Cleanest distinguishing witness:
 *
 *   approved → running      (legal; current=running)
 *   running  → done         (legal; current=done)
 *   done     → running      (illegal — terminal has no outgoing)
 *
 *   If skip:    current stays at `done`.  finalState=done.
 *   If advance: current becomes `running` (replay set state=to even
 *               though invalid). finalState=running.
 *
 *   Following entry:
 *   running  → failed       (legal from running; illegal from done)
 *
 *   Skip-keeps-done:  next is invalid (done→failed), stays done.
 *                     finalState = "done".
 *   Advance-broken:   current=running, next is legal, advance to
 *                     "failed". finalState = "failed".
 *
 * That is the witness this test pins.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { replayState } from "../../src/runtime/ledger.ts";
import type { LedgerEntry, LedgerWarning } from "../../src/types/internal.d.ts";

test("[C1] replayState SKIPS invalid transitions instead of advancing through them", () => {
  // Construction per the file header:
  const entries: ReadonlyArray<LedgerEntry> = [
    { type: "transition", at: "1", from: "pending", to: "approved" },
    { type: "transition", at: "2", from: "approved", to: "running" },
    { type: "transition", at: "3", from: "running", to: "done" },
    // Invalid: terminal `done` has no outgoing edges.
    { type: "transition", at: "4", from: "done", to: "running" },
    // Legal IF current is "running"; illegal IF current is "done".
    // Skip-correct: current stays at done, this is illegal too →
    //   final = done.
    // Advance-broken: current advanced to running, this becomes legal
    //   → final = failed.
    { type: "transition", at: "5", from: "running", to: "failed" },
  ];

  const warnings: LedgerWarning[] = [];
  const final = replayState(entries, (w) => warnings.push(w));

  // The contract slice 11 requires: skip-correct.
  assert.equal(
    final,
    "done",
    "replayState must SKIP invalid transitions (final state must be `done`, not `failed`)",
  );

  // Both invalid lines must surface as warnings (the second one is
  // invalid only under the skip-correct interpretation, which is
  // the one we want).
  const invalidWarnings = warnings.filter((w) => w.kind === "invalid-transition");
  assert.equal(
    invalidWarnings.length,
    2,
    "expected 2 invalid-transition warnings (lines 4 and 5 from `done`)",
  );

  // Spot-check the first warning's payload.
  const first = invalidWarnings[0];
  assert.ok(first && first.kind === "invalid-transition");
  if (first && first.kind === "invalid-transition") {
    assert.equal(first.from, "done");
    assert.equal(first.to, "running");
  }
});

test("[C1] replayState: a SHORTER skip-vs-advance witness (PRD-§5.2 simplest)", () => {
  // Even tighter probe: just `done → running, running → failed`.
  const entries: ReadonlyArray<LedgerEntry> = [
    { type: "transition", at: "0", from: "pending", to: "approved" },
    { type: "transition", at: "1", from: "approved", to: "running" },
    { type: "transition", at: "2", from: "running", to: "done" },
    { type: "transition", at: "3", from: "done", to: "failed" }, // illegal
    // If above advanced (broken), state=failed and we're stuck in terminal.
    // If above skipped (correct), state=done and the next entry's
    //   `from=failed` is irrelevant — replay validates current→to.
  ];
  const warnings: LedgerWarning[] = [];
  const final = replayState(entries, (w) => warnings.push(w));
  assert.equal(final, "done", "skip-correct must keep state at `done`");
  assert.equal(warnings.length, 1);
  if (warnings[0]?.kind === "invalid-transition") {
    assert.equal(warnings[0].from, "done");
    assert.equal(warnings[0].to, "failed");
  }
});
