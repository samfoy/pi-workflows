/**
 * tests/integration/approvalFlow.test.ts — slice 9 end-to-end approval
 * orchestration through `startWorkflowRun`.
 *
 * Verifies:
 *   - --bypass-permissions: banner emitted, run proceeds, ledger
 *     transitions pending → approved → running → done.
 *   - dialog 'no': run is denied, ledger gets cancelled + transition
 *     to cancelled-pre-run, no sandbox is constructed.
 *   - dialog 'always': trust row persisted; subsequent run with same
 *     hash skips dialog (`reason: 'trusted'`).
 *   - Hash mismatch: workflow file mutated post-trust → next run
 *     re-prompts (slice-2 revision adversarial-commit defense).
 *   - pi -p strict: env=PI_PROMPT_MODE=1 + untrusted → denied with
 *     PI_P_UNTRUSTED_ERROR.
 *   - dispatcher env propagation: PI_BYPASS_PERMISSIONS set on parent
 *     forwarded to child env.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import {
  RunCancelledError,
  startWorkflowRun,
} from "../../src/runManager.ts";
import { isTrusted } from "../../src/runtime/trustStore.ts";
import { BYPASS_PERMISSIONS_BANNER } from "../../src/runtime/bypass.ts";
import { buildChildEnv } from "../../src/runtime/dispatcher.ts";

function makeTmp(): {
  runsRoot: string;
  cwd: string;
  home: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-approve-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-wf-home-"));
  return {
    runsRoot,
    cwd,
    home,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "noop", absPath, scope: "personal" };
}

const NOOP_SOURCE = `return "ok";`;

test("--bypass-permissions: emits banner + runs to done", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "noop.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  let banner: string | null = null;
  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: { PI_BYPASS_PERMISSIONS: "1" },
      home,
      dialog: async () => "no", // must NOT be called
      viewer: () => undefined,
    },
    emitBanner: (b) => {
      banner = b;
    },
  });
  const out = await run.promise;
  assert.equal(out, "ok");
  assert.equal(banner, BYPASS_PERMISSIONS_BANNER);
  assert.ok(run.approvalDecision !== null);
  if (run.approvalDecision?.approved) {
    assert.equal(run.approvalDecision.reason, "bypass-permissions");
  }

  // Ledger has approved → running → done in order; NO `cancelled`.
  const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; from?: string; to?: string });
  const transitions = ledger.filter((e) => e.type === "transition");
  assert.deepEqual(
    transitions.map((t) => `${t.from}->${t.to}`),
    ["pending->approved", "approved->running", "running->done"],
  );
  assert.equal(
    ledger.some((e) => e.type === "cancelled"),
    false,
  );
});

test("dialog 'no' → run denied, ledger ends cancelled-pre-run with single cancelled entry", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "noop.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: async () => "no",
      viewer: () => undefined,
    },
  });
  await assert.rejects(run.promise, (e: unknown) => e instanceof RunCancelledError);

  const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; cause?: string; from?: string; to?: string });

  // Critic checklist: exactly one `cancelled` entry; final transition
  // is pending → cancelled-pre-run.
  const cancelled = ledger.filter((e) => e.type === "cancelled");
  assert.equal(cancelled.length, 1, "exactly one cancelled entry per critic checklist");
  assert.equal(cancelled[0]?.cause, "user-N");
  const transitions = ledger.filter((e) => e.type === "transition");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.from, "pending");
  assert.equal(transitions[0]?.to, "cancelled-pre-run");

  // No phase_start / sandbox construction.
  assert.equal(
    ledger.some((e) => e.type === "phase_start"),
    false,
  );
});

test("dialog 'always' persists trust → subsequent run skips dialog", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "trust-me.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  let dialogCalls = 0;
  const dialog1 = async (): Promise<"always"> => {
    dialogCalls++;
    return "always";
  };

  const run1 = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: dialog1,
      viewer: () => undefined,
    },
  });
  await run1.promise;
  assert.equal(dialogCalls, 1);
  assert.equal(run1.approvalDecision?.approved, true);
  if (run1.approvalDecision?.approved) {
    assert.equal(run1.approvalDecision.persisted, true);
  }

  // Verify trust persisted on disk.
  const trusted = await isTrusted({
    cwd,
    home,
    absPath: wfPath,
    sha256: run1.approvalDecision?.approved
      ? // Re-derive since we don't have direct access; instead verify
        // via the second run skipping dialog.
        ""
      : "",
  });
  void trusted;

  // Second run with the SAME workflow file should NOT call the dialog.
  const dialog2 = async (): Promise<"no"> => {
    dialogCalls++;
    return "no";
  };
  const run2 = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: dialog2,
      viewer: () => undefined,
    },
  });
  await run2.promise;
  assert.equal(dialogCalls, 1, "second run must skip dialog (already trusted)");
  assert.equal(run2.approvalDecision?.approved, true);
  if (run2.approvalDecision?.approved) {
    assert.equal(run2.approvalDecision.reason, "trusted");
  }
});

test("hash mismatch after trust → re-prompts (adversarial-commit defense)", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "shifty.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  // First run: user picks 'always', hash H1 persists.
  const run1 = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: async () => "always",
      viewer: () => undefined,
    },
  });
  await run1.promise;

  // Mutate the file (simulating an adversarial git pull).
  appendFileSync(wfPath, "\n// poison\nreturn 'pwned';", "utf8");

  // Second run: dialog MUST re-fire.
  let prompt: { mismatchWarning?: string } | null = null;
  const run2 = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: async (p) => {
        prompt = p;
        return "no";
      },
      viewer: () => undefined,
    },
  });
  await assert.rejects(run2.promise, (e: unknown) => e instanceof RunCancelledError);
  assert.ok(prompt, "dialog must re-fire on hash mismatch");
  assert.equal(
    (prompt as { mismatchWarning?: string }).mismatchWarning,
    "this workflow file has changed since you last trusted it",
  );
});

test("pi -p strict: env=PI_PROMPT_MODE=1 + untrusted → denied with PI_P_UNTRUSTED_ERROR", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "stranger.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: { PI_PROMPT_MODE: "1" },
      home,
      dialog: async () => {
        throw new Error("dialog must NOT run under pi -p strict + untrusted");
      },
      viewer: () => undefined,
    },
  });
  let err: unknown = null;
  try {
    await run.promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof RunCancelledError);
  assert.match((err as Error).message, /not yet trusted/);
  assert.match((err as Error).message, /run interactively first/);
});

test("dispatcher env propagation: parent's PI_BYPASS_PERMISSIONS forwarded to child", () => {
  const childEnv = buildChildEnv({
    PI_BYPASS_PERMISSIONS: "1",
    UNRELATED: "x",
  });
  // Recursion guard always wins.
  assert.equal(childEnv.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(childEnv.PI_WORKFLOWS_RECURSIVE, "1");
  // Bypass propagates so sub-agents inherit.
  assert.equal(childEnv.PI_BYPASS_PERMISSIONS, "1");
  assert.equal(childEnv.UNRELATED, "x");

  // When parent does NOT have it, child also doesn't.
  const noBypass = buildChildEnv({ UNRELATED: "x" });
  assert.equal(noBypass.PI_BYPASS_PERMISSIONS, undefined);
});

test("manifest two-checkpoint: trustedAtStart reflects approval at run-start AND end-of-run", async () => {
  const { runsRoot, cwd, home, resolveRunDir } = makeTmp();
  const wfPath = join(runsRoot, "checkpoint.workflow.js");
  writeFileSync(wfPath, NOOP_SOURCE, "utf8");

  const run = await startWorkflowRun(makeWorkflow(wfPath), "", {
    cwd,
    resolveRunDir,
    approval: {
      env: {},
      home,
      dialog: async () => "always",
      viewer: () => undefined,
    },
  });

  // Check manifest at run-start (after approval, before completion).
  const manifestAtStart = JSON.parse(
    readFileSync(join(run.runDirAbs, "manifest.json"), "utf8"),
  ) as { trustedAtStart?: boolean };
  assert.equal(
    manifestAtStart.trustedAtStart,
    true,
    "manifest at run-start must reflect 'always' approval",
  );

  await run.promise;

  // Check manifest after completion — must be unchanged (manifest is
  // frozen post-init per PRD §6.2).
  const manifestAtEnd = JSON.parse(
    readFileSync(join(run.runDirAbs, "manifest.json"), "utf8"),
  ) as { trustedAtStart?: boolean };
  assert.equal(manifestAtEnd.trustedAtStart, true);
});
