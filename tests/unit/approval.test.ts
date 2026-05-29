/**
 * tests/unit/approval.test.ts — slice 9 approval gate orchestration.
 *
 * The gate composes bypass.ts + trustStore.ts + the dialog adapter.
 * These tests pin its decision flow per PRD §3.4 + §7.4.1.
 *
 * Coverage:
 *   - bypass paths short-circuit dialog (banner attached when applicable)
 *   - already-trusted (absPath, sha256) short-circuits dialog
 *   - dialog `run-once` → approve, no persist
 *   - dialog `always` → approve + persist row to trust store
 *   - dialog `view` → invokes viewer + re-prompts (loop bounded)
 *   - dialog `no` → deny + cancelCause='user-N'
 *   - hash mismatch warning text + re-prompt (slice-2 revision)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runApprovalGate } from "../../src/runtime/approval.ts";
import { isTrusted, loadTrust } from "../../src/runtime/trustStore.ts";
import { BYPASS_PERMISSIONS_BANNER } from "../../src/runtime/bypass.ts";
import type {
  ApprovalDialogOutcome,
  ApprovalDialogPrompt,
} from "../../src/types/internal.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-approval-"));
}

function scriptDialog(
  script: ApprovalDialogOutcome[],
  observer?: (p: ApprovalDialogPrompt) => void,
): ApprovalDialog {
  let i = 0;
  return async (p) => {
    observer?.(p);
    return script[i++] ?? "no";
  };
}
type ApprovalDialog = (
  p: ApprovalDialogPrompt,
) => Promise<ApprovalDialogOutcome>;

const COMMON = {
  workflowName: "x",
  absPath: "/abs/x.workflow.js",
  sha256: "abc",
};

test("bypass-permissions short-circuits dialog with banner attached", async () => {
  let dialogCalled = false;
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: { PI_BYPASS_PERMISSIONS: "1" },
    dialog: async () => {
      dialogCalled = true;
      return "no";
    },
    viewer: () => undefined,
    trustOverride: {},
  });
  assert.equal(r.approved, true);
  assert.equal(dialogCalled, false, "dialog must NOT run when bypass fires");
  if (r.approved) {
    assert.equal(r.reason, "bypass-permissions");
    assert.equal(r.banner, BYPASS_PERMISSIONS_BANNER);
  }
});

test("pi -p strict + untrusted → DENY without invoking dialog", async () => {
  let dialogCalled = false;
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: { PI_PROMPT_MODE: "1" },
    dialog: async () => {
      dialogCalled = true;
      return "no";
    },
    viewer: () => undefined,
    trustOverride: {},
  });
  assert.equal(r.approved, false);
  assert.equal(dialogCalled, false);
  if (!r.approved) {
    assert.equal(r.reason, "pi-p-untrusted");
    assert.equal(r.cancelCause, "user-N");
    assert.match(r.error!, /not yet trusted/);
  }
});

test("pre-existing (absPath, sha256) trust → APPROVE without dialog", async () => {
  let dialogCalled = false;
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog: async () => {
      dialogCalled = true;
      return "no";
    },
    viewer: () => undefined,
    trustOverride: { "/abs/x.workflow.js": [{ name: "x", sha256: "abc" }] },
  });
  assert.equal(r.approved, true);
  assert.equal(dialogCalled, false);
  if (r.approved) assert.equal(r.reason, "trusted");
});

test("dialog 'run-once' → approve, persisted=false", async () => {
  const cwd = tmp();
  const r = await runApprovalGate({
    ...COMMON,
    cwd,
    env: {},
    dialog: scriptDialog(["run-once"]),
    viewer: () => undefined,
    trustOverride: {},
    home: tmp(),
  });
  assert.equal(r.approved, true);
  if (r.approved) {
    assert.equal(r.reason, "user-once");
    assert.equal(r.persisted, false);
  }
  // No row written.
  const t = await loadTrust({ cwd, home: tmp() });
  assert.equal(t["/abs/x.workflow.js"], undefined);
});

test("dialog 'always' → approve + persists row to trust store", async () => {
  const cwd = tmp();
  const home = tmp();
  const r = await runApprovalGate({
    ...COMMON,
    cwd,
    home,
    env: {},
    dialog: scriptDialog(["always"]),
    viewer: () => undefined,
    // trustOverride NOT set: real disk write happens.
  });
  assert.equal(r.approved, true);
  if (r.approved) {
    assert.equal(r.reason, "user-always");
    assert.equal(r.persisted, true);
  }
  const trusted = await isTrusted({
    cwd,
    home,
    absPath: COMMON.absPath,
    sha256: COMMON.sha256,
  });
  assert.equal(trusted, true);
});

test("dialog 'view' → invokes viewer + re-prompts", async () => {
  let viewerCalls = 0;
  const dialog = scriptDialog(["view", "view", "run-once"]);
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog,
    viewer: () => {
      viewerCalls++;
    },
    trustOverride: {},
    home: tmp(),
  });
  assert.equal(viewerCalls, 2);
  assert.equal(r.approved, true);
});

test("dialog 'no' → deny with cancelCause='user-N'", async () => {
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog: scriptDialog(["no"]),
    viewer: () => undefined,
    trustOverride: {},
    home: tmp(),
  });
  assert.equal(r.approved, false);
  if (!r.approved) {
    assert.equal(r.reason, "user-N");
    assert.equal(r.cancelCause, "user-N");
  }
});

test("hash-mismatch produces dialog mismatchWarning text per critic checklist", async () => {
  let prompt: ApprovalDialogPrompt | null = null;
  await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog: scriptDialog(["no"], (p) => {
      prompt = p;
    }),
    viewer: () => undefined,
    // Prior trust row exists with DIFFERENT sha256 — must trigger warning.
    trustOverride: {
      "/abs/x.workflow.js": [{ name: "x", sha256: "OLD-DIFFERENT-HASH" }],
    },
    home: tmp(),
  });
  assert.ok(prompt, "dialog must be invoked when hash mismatches");
  assert.equal(
    (prompt as ApprovalDialogPrompt | null)!.mismatchWarning,
    "this workflow file has changed since you last trusted it",
  );
});

test("hash-match (existing absPath + sha256) does NOT show mismatch warning", async () => {
  let prompt: ApprovalDialogPrompt | null = null;
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog: scriptDialog(["run-once"], (p) => {
      prompt = p;
    }),
    viewer: () => undefined,
    trustOverride: { "/abs/x.workflow.js": [{ name: "x", sha256: "abc" }] },
    home: tmp(),
  });
  assert.equal(r.approved, true);
  // Pre-trust hit means dialog never runs.
  assert.equal(prompt, null);
});

// MUTATION-PROBE per slice_9_concerns: if isTrustedIn drops the hash
// check (only checks absPath presence), the gate still re-prompts.
test("MUTATION-PROBE: hash mismatch must re-prompt the user", async () => {
  let dialogCalled = false;
  const r = await runApprovalGate({
    ...COMMON,
    sha256: "BRAND-NEW-HASH",
    cwd: tmp(),
    env: {},
    dialog: async () => {
      dialogCalled = true;
      return "no";
    },
    viewer: () => undefined,
    trustOverride: {
      "/abs/x.workflow.js": [
        { name: "x", sha256: "OLD-HASH-FROM-LAST-WEEK" },
      ],
    },
    home: tmp(),
  });
  assert.equal(
    dialogCalled,
    true,
    "hash mismatch must invoke dialog per slice-2 revision",
  );
  assert.equal(r.approved, false);
});

test("view re-prompt loop bounded: adapter that always returns 'view' eventually denies", async () => {
  let viewerCalls = 0;
  const r = await runApprovalGate({
    ...COMMON,
    cwd: tmp(),
    env: {},
    dialog: async () => "view", // adversarial buggy adapter
    viewer: () => {
      viewerCalls++;
    },
    trustOverride: {},
    home: tmp(),
  });
  // Bound is 10 inside approval.ts.
  assert.ok(viewerCalls >= 9, `viewer ran ${viewerCalls} times — must hit bound`);
  assert.equal(r.approved, false);
});
