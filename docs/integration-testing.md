# pi-workflows — Integration Testing Guide

This guide explains how to test your workflow scripts without spending tokens
on real pi subprocesses.

---

## Mock-agents mode

Every `ctx.phase` call can be intercepted by a mock branch that replays
pre-recorded fixtures instead of spawning real `pi --mode json` processes.

**How to enable in tests:**

```ts
import { runWorkflow } from "@samfp/pi-workflows/testing";

const result = await runWorkflow({
  workflowPath: "./my-workflow.js",
  input: "src/auth/",
  mockAgents: true,
  seedFixturesJsonl: buildFixtures(),
});
```

The `mockAgents: true` flag routes all `ctx.phase` dispatches to the
fixture branch. The dispatcher looks up each agent by `(agentId, promptHash)`
in `seedFixturesJsonl` and returns the stored result immediately.

---

## `fixtures.jsonl` format

Each line is a JSON object:

```jsonc
{
  "agentId": "recon",
  "promptHash": "<sha256 of the prompt string>",
  "result": {
    "text": "<the agent's text response>",
    "usage": { "input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 150 }
  }
}
```

**agentId** must match the `id` passed to `ctx.agent(..., { id: "..." })`.
If omitted in the workflow, the runtime auto-generates a stable id from the
prompt hash — use the same derivation in your fixture builder.

**promptHash** is `sha256(promptString)`. Use Node's `crypto.createHash`:

```ts
import { createHash } from "node:crypto";
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
```

---

## Writing a test

```ts
// tests/integration/my-workflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runWorkflow } from "@samfp/pi-workflows/testing";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function buildFixtures(input: string): string {
  const prompt = `Answer this question: ${input}`;
  return JSON.stringify({
    agentId: "main",
    promptHash: sha256(prompt),
    result: {
      text: "42 is the answer.",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    },
  });
}

test("my-workflow returns an answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-run-"));
  try {
    const result = await runWorkflow({
      workflowPath: new URL("../../examples/my-workflow.js", import.meta.url).pathname,
      input: "What is 6 × 7?",
      mockAgents: true,
      seedFixturesJsonl: buildFixtures("What is 6 × 7?"),
      runsRootOverride: dir,
    });
    assert.equal(result.output, "42 is the answer.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

---

## Testing cache behaviour

To verify that a second run hits cache, run the workflow twice against the
same `runsRootOverride` dir:

```ts
test("second run is fully cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-test-"));
  try {
    const fixtures = buildFixtures("test input");
    const opts = { workflowPath: "./my-workflow.js", input: "test input",
                   mockAgents: true, seedFixturesJsonl: fixtures, runsRootOverride: dir };

    const run1 = await runWorkflow(opts);
    const run2 = await runWorkflow(opts);

    // All agents on run 2 should report cached: true
    const uncached = run2.agentResults.filter(r => !r.cached);
    assert.equal(uncached.length, 0, "expected all agents cached on run 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

---

## Asserting phase structure

The `runWorkflow` result includes `phases` for structural assertions:

```ts
assert.deepEqual(result.phases.map(p => p.name), ["recon", "analyse", "vote", "summarise"]);
assert.equal(result.phases[1]!.agentCount, 2); // two analyse agents
```

---

## Running the test suite

```bash
npm test                            # all tests (unit + integration + security)
npm run test:integration            # integration tests only
npm run test:unit                   # unit tests only
npm run test:security               # sandbox escape-vector tests
```

Tests use Node's built-in `node:test` runner with `tsx` for TypeScript.
No Jest, no Vitest, no extra toolchain.
