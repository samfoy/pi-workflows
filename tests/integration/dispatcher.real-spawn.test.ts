/**
 * Slice 6 — real-spawn integration test.
 *
 * Spawns a single REAL `pi --mode json -p 'reply ok'` and asserts the
 * dispatcher round-trips an `AgentResult` from end to end. Skipped
 * unless `RUN_REAL_PI_TEST=1` so default CI doesn't depend on a pi
 * binary or Bedrock credentials.
 *
 * Wall-time hard cap: 60s. If pi is misbehaving we want the test to
 * fail fast, not wedge the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchAgent } from "../../src/runtime/dispatcher.js";

const RUN = process.env.RUN_REAL_PI_TEST === "1";

test(
  "real spawn: pi --mode json -p 'reply with single word ok' round-trips",
  { skip: !RUN, timeout: 60000 },
  async () => {
    const runDir = mkdtempSync(join(tmpdir(), "pi-wf-real-"));
    const result = await dispatchAgent({
      runDir,
      agentId: "real",
      prompt: "reply with the single word ok",
      promptHash: "real-h",
      cwd: runDir,
      timeoutMs: 50_000,
      // Skip the parent-death wrapper so the test doesn't depend on
      // /bin/sh wrapper materialization for the smoke path. Real
      // spawn is what we're verifying here, not the wrapper.
      skipParentDeathGuard: true,
    });
    assert.equal(result.ok, true);
    assert.ok(result.text.length > 0, "non-empty assistant text");
    assert.equal(typeof result.usage.totalTokens, "number");
    assert.ok(result.exitCode === 0);
  },
);
