/**
 * Unit tests for the `workflow` keyword trigger.
 *
 * Locks in the regex + notice + directive that close the
 * "No keyword-trigger workflow drafting" gap from
 * `docs/gap-analysis/2026-05-31-gap-analysis.md`.
 *
 * Pi's extension SDK has no `session_primer` hook (per
 * `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
 * event list); `src/index.ts` simulates one by chaining the `input`
 * + `before_agent_start` events. The pure helpers under test live in
 * `src/runtime/keywordTrigger.ts` so this test file doesn't depend on
 * the extension's full transitive import graph.
 *
 * The test file is named `writeWorkflowKeywordTrigger.test.ts` so it
 * matches the `tests/**\/writeWorkflow*.test.ts` glob the zone task
 * runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYWORD_NOTICE,
  WORKFLOW_DIRECTIVE,
  WORKFLOW_KEYWORD_REGEX,
  shouldArmKeywordTrigger,
} from "../../src/runtime/keywordTrigger.ts";

// ─── regex semantics ─────────────────────────────────────────────────────────

test("regex: matches singular 'workflow'", () => {
  assert.ok(WORKFLOW_KEYWORD_REGEX.test("draft a workflow for the audit"));
});

test("regex: matches plural 'workflows'", () => {
  assert.ok(WORKFLOW_KEYWORD_REGEX.test("show me my workflows"));
});

test("regex: case-insensitive ('WORKFLOW', 'WorkFlow')", () => {
  assert.ok(WORKFLOW_KEYWORD_REGEX.test("WORKFLOW please"));
  assert.ok(WORKFLOW_KEYWORD_REGEX.test("Build a WorkFlow that..."));
});

test("regex: word-bounded — does NOT match compound prefix/suffix", () => {
  // Must not fire on substring-style hits, otherwise users typing
  // "subworkflow" or "workflowy" get spurious triggers.
  for (const text of [
    "the subworkflow path",
    "a workflowy thing",
    "the workflowing process",
    "preworkflows",
  ]) {
    assert.ok(!WORKFLOW_KEYWORD_REGEX.test(text), `should NOT match: "${text}"`);
  }
});

test("regex: matches with surrounding punctuation", () => {
  for (const text of [
    "I want a workflow.",
    "(workflow)",
    "what about workflows?",
    'the "workflow" idea',
    "workflow!",
  ]) {
    assert.ok(WORKFLOW_KEYWORD_REGEX.test(text), `should match: "${text}"`);
  }
});

// ─── shouldArmKeywordTrigger — guard semantics ───────────────────────────────

test("shouldArm: fires for user-source events containing 'workflow'", () => {
  assert.ok(shouldArmKeywordTrigger({ text: "build a workflow", source: "user" }));
});

test("shouldArm: skips extension-source events (loop guard)", () => {
  // When pi-workflows itself sends an injected message via
  // pi.sendMessage, the input event re-fires with source='extension'.
  // Without this guard we'd loop on our own notice text.
  assert.ok(!shouldArmKeywordTrigger({ text: "create a workflow", source: "extension" }));
});

test("shouldArm: skips slash commands", () => {
  // Slash commands are handled before the input event reaches us
  // anyway; this guard prevents `/workflows list` from arming the
  // trigger if dispatch ordering ever changes.
  assert.ok(!shouldArmKeywordTrigger({ text: "/workflows list", source: "user" }));
  assert.ok(!shouldArmKeywordTrigger({ text: "  /workflows", source: "user" }));
});

test("shouldArm: returns false for prompts that don't mention 'workflow'", () => {
  assert.ok(!shouldArmKeywordTrigger({ text: "fix the bug in auth.ts", source: "user" }));
  assert.ok(!shouldArmKeywordTrigger({ text: "", source: "user" }));
});

// ─── notice + directive shape ────────────────────────────────────────────────

test("notice: ≤ 6 lines and mentions 'workflow keyword'", () => {
  const lines = KEYWORD_NOTICE.split("\n");
  assert.ok(lines.length <= 6, `notice should be ≤ 6 lines, got ${lines.length}`);
  assert.match(KEYWORD_NOTICE, /workflow keyword/i);
});

test("directive: includes the WORKFLOW TRIGGER header and write_workflow tool name", () => {
  assert.match(WORKFLOW_DIRECTIVE, /WORKFLOW TRIGGER/);
  assert.match(WORKFLOW_DIRECTIVE, /write_workflow/);
});

test("directive: starts with newline so it concatenates cleanly", () => {
  assert.equal(WORKFLOW_DIRECTIVE.charAt(0), "\n", "leading newline keeps the appended directive on its own line");
});

// ─── end-to-end wiring shape (handler simulation) ────────────────────────────

/**
 * Simulates the `input` + `before_agent_start` chain in `src/index.ts`
 * without booting the full extension. Confirms the one-shot semantics:
 * the input handler arms a flag, before_agent_start consumes it once.
 *
 * This mirrors the real handlers literally so a refactor of the chain
 * in `src/index.ts` will only break the tests if it also breaks the
 * intended behavior.
 */
function makeChain(): {
  input: (e: { text: string; source: string }) => boolean;
  beforeAgentStart: (e: { systemPrompt?: string }) => { systemPrompt?: string };
} {
  let pending = false;
  return {
    input: (event) => {
      if (shouldArmKeywordTrigger(event)) {
        pending = true;
        return true;
      }
      return false;
    },
    beforeAgentStart: (event) => {
      if (!pending) return {};
      pending = false;
      return { systemPrompt: (event.systemPrompt ?? "") + WORKFLOW_DIRECTIVE };
    },
  };
}

test("chain: input arms; before_agent_start injects directive once", () => {
  const c = makeChain();
  assert.ok(c.input({ text: "build a workflow", source: "user" }));

  const r1 = c.beforeAgentStart({ systemPrompt: "BASE" });
  assert.ok(typeof r1.systemPrompt === "string");
  assert.match(r1.systemPrompt!, /^BASE/, "should append, not replace");
  assert.match(r1.systemPrompt!, /WORKFLOW TRIGGER/);

  // Second turn without re-arming: directive must not re-inject.
  const r2 = c.beforeAgentStart({ systemPrompt: "BASE2" });
  assert.deepEqual(r2, {}, "directive must be one-shot per arm");
});

test("chain: input does NOT arm when prompt has no 'workflow' word", () => {
  const c = makeChain();
  assert.ok(!c.input({ text: "thanks!", source: "user" }));
  assert.deepEqual(c.beforeAgentStart({ systemPrompt: "BASE" }), {});
});

test("chain: missing systemPrompt — directive still appended", () => {
  const c = makeChain();
  c.input({ text: "draft workflows for me", source: "user" });
  const r = c.beforeAgentStart({});
  assert.ok(typeof r.systemPrompt === "string");
  assert.match(r.systemPrompt!, /WORKFLOW TRIGGER/);
});
