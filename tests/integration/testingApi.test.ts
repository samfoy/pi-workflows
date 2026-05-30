/**
 * tests/integration/testingApi.test.ts
 *
 * Tests for the high-level `runWorkflow()` API in src/testing.ts.
 * Uses the bundled `hello` example + mock agents — no real pi spawned.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { runWorkflow } from "../../src/testing.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HELLO_WORKFLOW = join(PKG_ROOT, "examples/hello/hello.js");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Build fixtures for the hello workflow.
 * The workflow emits: ctx.agent(`Say hello to ${name} in one sentence.`, { id: "greeter" })
 */
function buildHelloFixtures(name: string): string {
  const prompt = `Say hello to ${name} in one sentence.`;
  return JSON.stringify({
    agentId: "greeter",
    promptHash: sha256(prompt),
    result: {
      text: `Hello, ${name}! Have a wonderful day.`,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("runWorkflow: hello example returns done + correct output", async () => {
  const result = await runWorkflow({
    workflowPath: HELLO_WORKFLOW,
    input: "Alice",
    mockAgents: true,
    seedFixturesJsonl: buildHelloFixtures("Alice"),
  });

  assert.equal(result.status, "done", `expected status=done, got ${result.status}`);
  assert.ok(result.output !== null, "expected non-null output");
  const out = result.output as Record<string, unknown>;
  assert.equal(out["greeting"], "Hello, Alice! Have a wonderful day.");
});

test("runWorkflow: phases array is non-empty and correctly named", async () => {
  const result = await runWorkflow({
    workflowPath: HELLO_WORKFLOW,
    input: "Bob",
    mockAgents: true,
    seedFixturesJsonl: buildHelloFixtures("Bob"),
  });

  assert.ok(result.phases.length > 0, "expected at least one phase");
  assert.equal(result.phases[0]!.name, "greet");
  assert.equal(result.phases[0]!.agentCount, 1);
});

test("runWorkflow: agentResults contains greeter agent", async () => {
  const result = await runWorkflow({
    workflowPath: HELLO_WORKFLOW,
    input: "Carol",
    mockAgents: true,
    seedFixturesJsonl: buildHelloFixtures("Carol"),
  });

  assert.ok(result.agentResults.length > 0, "expected at least one agent result");
  const greeter = result.agentResults.find(r => r.agentId === "greeter");
  assert.ok(greeter !== undefined, "expected greeter agent result");
  assert.equal(greeter.cached, false, "first run should not be cached");
});

test("runWorkflow: running twice with same input both succeed", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-dual-test-"));
  try {
    const fixtureLine = buildHelloFixtures("Dave");

    const run1 = await runWorkflow({
      workflowPath: HELLO_WORKFLOW,
      input: "Dave",
      mockAgents: true,
      seedFixturesJsonl: fixtureLine,
      runsRootOverride: runsRoot,
    });
    assert.equal(run1.status, "done", "run 1 should succeed");

    const run2 = await runWorkflow({
      workflowPath: HELLO_WORKFLOW,
      input: "Dave",
      mockAgents: true,
      seedFixturesJsonl: fixtureLine,
      runsRootOverride: runsRoot,
    });
    assert.equal(run2.status, "done", "run 2 should succeed");

    // Each run gets a distinct runId.
    assert.notEqual(run1.runId, run2.runId, "runs should have different IDs");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runWorkflow: runId and runDirAbs are populated", async () => {
  const result = await runWorkflow({
    workflowPath: HELLO_WORKFLOW,
    input: "Eve",
    mockAgents: true,
    seedFixturesJsonl: buildHelloFixtures("Eve"),
  });

  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId present");
  assert.ok(typeof result.runDirAbs === "string" && result.runDirAbs.length > 0, "runDirAbs present");
});

test("runWorkflow: durationMs is a positive number", async () => {
  const result = await runWorkflow({
    workflowPath: HELLO_WORKFLOW,
    input: "Frank",
    mockAgents: true,
    seedFixturesJsonl: buildHelloFixtures("Frank"),
  });

  assert.ok(result.durationMs >= 0, `expected durationMs >= 0, got ${result.durationMs}`);
});
