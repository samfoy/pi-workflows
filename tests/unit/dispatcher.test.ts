/**
 * Slice 6 — dispatcher unit tests (mock + spawn-spy paths).
 *
 * Real-spawn tests live in `tests/integration/`. Anti-stall: every test
 * that spawns gets an explicit timeout; the dispatcher's own subprocess
 * timeout is overridden to a tight value where useful.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChildEnv,
  buildPiArgs,
  dispatchAgent,
  PI_FINAL_RESULT_EVENT_TYPE,
  PROPAGATED_BYPASS_ENV,
  RECURSION_GUARD_ENV,
  extractAssistantText,
  recoverFromTranscript,
} from "../../src/runtime/dispatcher.js";
import {
  AgentSubprocessError,
  MalformedAgentOutputError,
  MockFixtureMissingError,
} from "../../src/runtime/errors.js";
import { makeFakeSpawn } from "../helpers/fakeChild.js";
import { realPiStream } from "../helpers/realPiStream.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-disp-"));
}

// ─── pure helpers ────────────────────────────────────────────────────

test("buildPiArgs: minimal args", () => {
  assert.deepEqual(buildPiArgs({ prompt: "hi" }), [
    "--mode", "json", "-p", "hi",
  ]);
});

test("buildPiArgs: with model + thinking", () => {
  assert.deepEqual(
    buildPiArgs({ prompt: "x", model: "claude", thinking: "high" }),
    ["--mode", "json", "-p", "x", "--model", "claude", "--thinking", "high"],
  );
});

test("buildChildEnv: PI_DISABLE_WORKFLOWS + PI_WORKFLOWS_RECURSIVE always 1", () => {
  const env = buildChildEnv({ FOO: "bar" });
  assert.equal(env.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(env.PI_WORKFLOWS_RECURSIVE, "1");
  assert.equal(env.FOO, "bar");
});

test("buildChildEnv: parent env's PI_DISABLE_WORKFLOWS=0 is OVERWRITTEN to 1", () => {
  const env = buildChildEnv({ PI_DISABLE_WORKFLOWS: "0", PI_WORKFLOWS_RECURSIVE: "0" });
  assert.equal(env.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(env.PI_WORKFLOWS_RECURSIVE, "1");
});

test("RECURSION_GUARD_ENV is the canonical pair", () => {
  assert.deepEqual({ ...RECURSION_GUARD_ENV }, {
    PI_DISABLE_WORKFLOWS: "1",
    PI_WORKFLOWS_RECURSIVE: "1",
  });
});

// ─── Slice 10 W1 witnesses ─────────────────────────────────────

test("buildChildEnv W1: PROPAGATED_BYPASS_ENV is load-bearing — removing PI_BYPASS_PERMISSIONS strips it", () => {
  // Witness: the propagation list is the ONLY thing that keeps
  // PI_BYPASS_PERMISSIONS in the child env. The strip-then-allowlist
  // algorithm in buildChildEnv removes every PI_* var EXCEPT names
  // explicitly enumerated here. If a future refactor drops
  // "PI_BYPASS_PERMISSIONS" from the constant, the next assertion
  // ("propagated") fails.
  assert.ok(
    PROPAGATED_BYPASS_ENV.includes("PI_BYPASS_PERMISSIONS"),
    "PI_BYPASS_PERMISSIONS must be in PROPAGATED_BYPASS_ENV",
  );
  const env = buildChildEnv({
    PI_BYPASS_PERMISSIONS: "1",
    PI_FOO_OTHER: "y",  // arbitrary other PI_* var — must be stripped
    UNRELATED: "x",      // non-PI — must inherit
  });
  assert.equal(env.PI_BYPASS_PERMISSIONS, "1", "propagated");
  assert.equal(
    env.PI_FOO_OTHER,
    undefined,
    "non-allowlisted PI_* must be stripped",
  );
  assert.equal(env.UNRELATED, "x", "non-PI vars passthrough");
});

test("buildChildEnv W1: every PI_* not in allowlist is stripped", () => {
  // Comprehensive witness: a parent with several PI_* vars (none in
  // the allowlist except the recursion-guard-overwritten pair) sees
  // all stripped except the propagation list + the guard pair.
  const env = buildChildEnv({
    PI_BYPASS_PERMISSIONS: "1",
    PI_DISABLE_WORKFLOWS: "0",     // overwritten to "1" by guard
    PI_WORKFLOWS_RECURSIVE: "0",   // overwritten to "1" by guard
    PI_DEBUG: "on",                // stripped
    PI_FOO: "bar",                 // stripped
    PI_TELEMETRY_KEY: "xyz",       // stripped
    PATH: "/usr/bin",              // passthrough
    HOME: "/home/x",               // passthrough
  });
  assert.equal(env.PI_BYPASS_PERMISSIONS, "1");
  assert.equal(env.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(env.PI_WORKFLOWS_RECURSIVE, "1");
  assert.equal(env.PI_DEBUG, undefined);
  assert.equal(env.PI_FOO, undefined);
  assert.equal(env.PI_TELEMETRY_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
});

test("buildChildEnv W1: extra param overwrites parent and is then overwritten by recursion guard for the guard pair only", () => {
  const env = buildChildEnv(
    { PI_BYPASS_PERMISSIONS: "1", FOO: "old" },
    { FOO: "new", PI_DISABLE_WORKFLOWS: "0" /* still overwritten to 1 */ },
  );
  assert.equal(env.FOO, "new");
  assert.equal(env.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(env.PI_BYPASS_PERMISSIONS, "1");
});

test("PI_FINAL_RESULT_EVENT_TYPE is agent_end (real pi 0.74.0)", () => {
  assert.equal(PI_FINAL_RESULT_EVENT_TYPE, "agent_end");
});

test("extractAssistantText: joins text parts of last assistant message", () => {
  const t = extractAssistantText({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "ignored" }] },
      { role: "assistant", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    ],
  });
  assert.equal(t, "hello world");
});

test("extractAssistantText: empty when no assistant message", () => {
  assert.equal(extractAssistantText({ messages: [{ role: "user", content: [] }] }), "");
});

// ─── mock-mode branch ────────────────────────────────────────────────

test("mock-mode: returns canned AgentResult, writes transcript", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  const { promises: fs } = await import("node:fs");
  const fixture = {
    agentId: "scout",
    promptHash: "promptH",
    result: { text: "scouted", usage: { input: 10, output: 5, totalTokens: 15 }, toolCalls: 2 },
    events: [{ type: "session" }, { type: "agent_end", messages: [] }],
  };
  await fs.writeFile(join(runDir, "fixtures.jsonl"), JSON.stringify(fixture) + "\n");

  const result = await dispatchAgent({
    runDir,
    agentId: "scout",
    prompt: "go scout",
    promptHash: "promptH",
    cwd: runDir,
    mockAgents: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "scouted");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.toolCalls, 2);
  assert.ok(result.transcriptPath.endsWith("/agents/scout.jsonl"));
  assert.ok(existsSync(result.transcriptPath));
  // manifest.json should have parent-liveness fields
  const mf = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  assert.equal(typeof mf.parentPid, "number");
  assert.equal(typeof mf.parentStartTime, "string");
  assert.equal(typeof mf.parentBootId, "string");
});

test("mock-mode: missing fixture rejects with MockFixtureMissingError", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "ghost",
        prompt: "haunt",
        promptHash: "missing-h",
        cwd: runDir,
        mockAgents: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MockFixtureMissingError);
      assert.equal((err as MockFixtureMissingError).agentId, "ghost");
      assert.equal((err as MockFixtureMissingError).promptHash, "missing-h");
      return true;
    },
  );
});

test("mock-mode: env PI_WORKFLOWS_MOCK_AGENTS=1 also activates mock path", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(
    join(runDir, "fixtures.jsonl"),
    JSON.stringify({ agentId: "a", promptHash: "h", result: { text: "via-env" } }) + "\n",
  );
  const r = await dispatchAgent({
    runDir,
    agentId: "a",
    prompt: "p",
    promptHash: "h",
    cwd: runDir,
    envBase: { PI_WORKFLOWS_MOCK_AGENTS: "1" },
  });
  assert.equal(r.text, "via-env");
});

// ─── spawn-spy: real spawn replaced with a fake ──────────────────────

test("spawn-spy: parses real-pi event stream + extracts text/usage/toolCalls", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  const stream = realPiStream({ text: "hi-back", toolCalls: 2, usage: { input: 12, output: 3, totalTokens: 15 } });
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);
  const result = await dispatchAgent({
    runDir,
    agentId: "writer",
    prompt: "say hi-back",
    promptHash: "ph1",
    cwd: runDir,
    spawn: fake.spawn,
    skipParentDeathGuard: true,
    timeoutMs: 1500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hi-back");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.toolCalls, 2);
  // Transcript should have all the bytes.
  const teed = readFileSync(result.transcriptPath, "utf8");
  assert.ok(teed.includes('"agent_end"'));
});

test("spawn-spy: malformed JSON mid-stream → MalformedAgentOutputError + bytes appended to stderr", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // First line good, second line malformed.
  const malformed = '{"type":"session"}\n{this-is-not-json\n';
  const fake = makeFakeSpawn([{ stdout: [malformed], stderr: ["earlier-err\n"], exitCode: 1 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "buggy",
        prompt: "p",
        promptHash: "h",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MalformedAgentOutputError);
      const e = err as MalformedAgentOutputError;
      assert.equal(e.agentId, "buggy");
      assert.equal(e.reason, "parse");
      assert.equal(e.lineNumber, 2);
      assert.ok(e.bytes.includes("this-is-not-json"));
      return true;
    },
  );
  const stderrPath = join(runDir, "agents", "buggy.stderr");
  const stderr = readFileSync(stderrPath, "utf8");
  // Both the original stderr AND the appended malformed-bytes line.
  assert.ok(stderr.includes("earlier-err"));
  assert.ok(stderr.includes("this-is-not-json"));
});

test("spawn-spy: empty stdout + non-zero exit → AgentSubprocessError", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  const fake = makeFakeSpawn([{ stdout: [], stderr: ["boom\n"], exitCode: 2 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "crash",
        prompt: "p",
        promptHash: "h",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof AgentSubprocessError);
      assert.equal((err as AgentSubprocessError).exitCode, 2);
      return true;
    },
  );
});

test("spawn-spy: empty stdout + zero exit → MalformedAgentOutputError reason=empty-stdout-success", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  const fake = makeFakeSpawn([{ stdout: [], stderr: [], exitCode: 0 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "silent",
        prompt: "p",
        promptHash: "h",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MalformedAgentOutputError);
      assert.equal((err as MalformedAgentOutputError).reason, "empty-stdout-success");
      return true;
    },
  );
});

test("spawn-spy: AbortSignal aborts mid-stream", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // A stream that never finishes (no agent_end + chunks dribble out).
  const fake = makeFakeSpawn([{
    stdout: ['{"type":"session"}\n', '{"type":"agent_start"}\n'],
    exitDelayMs: 1000,
    exitCode: 0,
  }]);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "abortme",
        prompt: "p",
        promptHash: "h",
        cwd: runDir,
        spawn: fake.spawn,
        signal: ctrl.signal,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
  );
});

// ─── ENV-INJECTION acceptance: PRD §13.7 ─────────────────────────────

test("env-injection: 3 different agent shapes all see PI_DISABLE_WORKFLOWS=1 + PI_WORKFLOWS_RECURSIVE=1", { timeout: 5000 }, async () => {
  const runDir1 = tmpRunDir();
  const runDir2 = tmpRunDir();
  const runDir3 = tmpRunDir();
  const stream = realPiStream();
  const fake = makeFakeSpawn([
    { stdout: [stream], exitCode: 0 },
    { stdout: [stream], exitCode: 0 },
    { stdout: [stream], exitCode: 0 },
  ]);
  // Shape 1: default model.
  await dispatchAgent({
    runDir: runDir1, agentId: "a", prompt: "p1", promptHash: "h1", cwd: runDir1,
    spawn: fake.spawn, skipParentDeathGuard: true, timeoutMs: 1500,
  });
  // Shape 2: custom model + thinking.
  await dispatchAgent({
    runDir: runDir2, agentId: "b", prompt: "p2", promptHash: "h2", cwd: runDir2,
    model: "claude", thinking: "high",
    spawn: fake.spawn, skipParentDeathGuard: true, timeoutMs: 1500,
  });
  // Shape 3: parent env tries to set the guards to 0 — must be overwritten.
  await dispatchAgent({
    runDir: runDir3, agentId: "c", prompt: "p3", promptHash: "h3", cwd: runDir3,
    envBase: { PI_DISABLE_WORKFLOWS: "0", PI_WORKFLOWS_RECURSIVE: "0", FOO: "preserved" },
    spawn: fake.spawn, skipParentDeathGuard: true, timeoutMs: 1500,
  });

  assert.equal(fake.calls.length, 3);
  for (const call of fake.calls) {
    const env = call.options.env ?? {};
    assert.equal(env.PI_DISABLE_WORKFLOWS, "1", "PI_DISABLE_WORKFLOWS=1 must be present");
    assert.equal(env.PI_WORKFLOWS_RECURSIVE, "1", "PI_WORKFLOWS_RECURSIVE=1 must be present");
  }
  // Shape 3 specifically: parent's FOO=preserved survives, and the
  // adversarial 0 values were overwritten to 1.
  const env3 = fake.calls[2]!.options.env ?? {};
  assert.equal(env3.FOO, "preserved");
  assert.equal(env3.PI_DISABLE_WORKFLOWS, "1");
  assert.equal(env3.PI_WORKFLOWS_RECURSIVE, "1");
});

// ─── partial manifest write ───────────────────────────────────────────

test("partial manifest write: only parentPid/parentStartTime/parentBootId are touched; slice-8a fields untouched", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // Pre-seed a manifest from a hypothetical slice-8a write.
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify({
      runId: "wf-FAKE",
      workflowName: "audit",
      startedAt: "2026-05-28T00:00:00Z",
      input: "preserved",
    }) + "\n",
  );
  await fs.writeFile(
    join(runDir, "fixtures.jsonl"),
    JSON.stringify({ agentId: "a", promptHash: "h", result: { text: "x" } }) + "\n",
  );
  await dispatchAgent({
    runDir,
    agentId: "a",
    prompt: "p",
    promptHash: "h",
    cwd: runDir,
    mockAgents: true,
  });
  const mf = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  assert.equal(mf.runId, "wf-FAKE", "slice-8a's runId must be preserved");
  assert.equal(mf.workflowName, "audit");
  assert.equal(mf.input, "preserved");
  assert.equal(typeof mf.parentPid, "number");
  assert.equal(typeof mf.parentStartTime, "string");
  assert.equal(typeof mf.parentBootId, "string");
});

// ─── CRLF stronger witness for the JSON-stream parser (slice 5 carryover) ─

test("CRLF: malformed CRLF line — truncatedRegion does NOT include trailing \\r", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // Note CRLF line ending on the malformed line.
  const stream = '{"type":"session"}\r\n{"broken\r\n';
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 1 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "crlf",
        prompt: "p",
        promptHash: "h",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MalformedAgentOutputError);
      const bytes = (err as MalformedAgentOutputError).bytes;
      assert.ok(!bytes.includes("\r"), `truncatedRegion must not contain CR: ${JSON.stringify(bytes)}`);
      assert.ok(bytes.includes("broken"));
      return true;
    },
  );
});

// ─── FIFO at cap > 1 (slice 4 carryover, slice 6 verifies via dispatcher gating) ─

test("FIFO at cap=4: 20 dispatches, random-ordered release, resolution monotonic", { timeout: 10000 }, async () => {
  // Slice 4 only proved cap=1 FIFO; cap>1 ordering is dispatcher's
  // responsibility to verify since it's the first real consumer of the
  // semaphore at cap>1. We exercise the same primitive the dispatcher's
  // caller will use — slice 8a's `ctx.phase` will gate via this.
  const { makeSemaphore } = await import("../../src/runtime/semaphore.js");
  const sem = makeSemaphore({ cap: 4 });

  const resolutionOrder: number[] = [];
  const tokens: { release(): void }[] = [];
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    const idx = i;
    tasks.push((async () => {
      const tok = await sem.acquire();
      resolutionOrder.push(idx);
      tokens.push(tok);
    })());
  }
  // Wait for the first 4 to land.
  while (resolutionOrder.length < 4) {
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(resolutionOrder, [0, 1, 2, 3]);

  // Release the 4 active tokens in a random order. The next 4 to
  // resolve must still be 4..7 because FIFO is by acquire-order.
  const seed = [3, 0, 2, 1];
  for (const j of seed) tokens[j]!.release();
  while (resolutionOrder.length < 8) {
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(resolutionOrder.slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 7]);

  // Drain the rest. Release any remaining held tokens; FIFO ordering
  // must be preserved through the random release sequence.
  while (tokens.length < 8) await new Promise((r) => setImmediate(r));
  // Release tokens in arbitrary order until all 20 acquires resolve.
  let next = 4;
  while (resolutionOrder.length < 20) {
    if (tokens[next]) {
      tokens[next]!.release();
      next++;
    }
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(tasks);
  assert.deepEqual(resolutionOrder, Array.from({ length: 20 }, (_, i) => i));
});

// ─── recoverFromTranscript ──────────────────────────────────────────

test("recoverFromTranscript: returns null when file does not exist", async () => {
  const result = await recoverFromTranscript("/nonexistent/path/agent.jsonl", "a1");
  assert.equal(result, null);
});

test("recoverFromTranscript: returns null when transcript has no agent_end", async () => {
  const { promises: fs } = await import("node:fs");
  const runDir = tmpRunDir();
  const agentsDir = join(runDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  // Partial stream: no agent_end (subprocess was killed mid-run).
  const partial = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
  ].join("\n") + "\n";
  const transcriptPath = join(agentsDir, "a1.jsonl");
  await fs.writeFile(transcriptPath, partial);

  const result = await recoverFromTranscript(transcriptPath, "a1");
  assert.equal(result, null);
});

test("recoverFromTranscript: synthesizes AgentResult from complete transcript", async () => {
  const { promises: fs } = await import("node:fs");
  const runDir = tmpRunDir();
  const agentsDir = join(runDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const transcriptPath = join(agentsDir, "writer.jsonl");

  // Use realPiStream to produce a realistic complete transcript.
  const content = realPiStream({ text: "recovered text", toolCalls: 2, usage: { input: 10, output: 5, totalTokens: 15 } });
  await fs.writeFile(transcriptPath, content);

  const result = await recoverFromTranscript(transcriptPath, "writer");
  assert.notEqual(result, null);
  assert.equal(result!.ok, true);
  assert.equal(result!.agentId, "writer");
  assert.equal(result!.text, "recovered text");
  assert.equal(result!.toolCalls, 2);
  assert.equal(result!.usage.totalTokens, 15);
  assert.equal(result!.usage.input, 10);
  assert.equal(result!.usage.output, 5);
  assert.equal(result!.durationMs, 0);
  assert.equal(result!.exitCode, null);
  assert.equal(result!.transcriptPath, transcriptPath);
});

test("recoverFromTranscript: tolerates torn tail (no trailing newline, last line corrupt)", async () => {
  const { promises: fs } = await import("node:fs");
  const runDir = tmpRunDir();
  const agentsDir = join(runDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const transcriptPath = join(agentsDir, "torn.jsonl");

  // Complete transcript but with a torn last line (crash mid-write).
  const complete = realPiStream({ text: "done" });
  const torn = complete + "{this-is-torn-and-never-closes";  // no newline at end
  await fs.writeFile(transcriptPath, torn);

  const result = await recoverFromTranscript(transcriptPath, "torn");
  assert.notEqual(result, null, "should recover despite torn tail");
  assert.equal(result!.text, "done");
});

test("recoverFromTranscript: returns null when entire file is unparseable", async () => {
  const { promises: fs } = await import("node:fs");
  const runDir = tmpRunDir();
  const agentsDir = join(runDir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const transcriptPath = join(agentsDir, "corrupt.jsonl");
  await fs.writeFile(transcriptPath, "not-json\nalso-not-json\n");

  const result = await recoverFromTranscript(transcriptPath, "corrupt");
  assert.equal(result, null);
});

// ─── unexpected-schema validation (parity gap fix) ───────────────────────────

test("spawn-spy: agent_end missing 'messages' field → MalformedAgentOutputError reason=unexpected-schema", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // Stream ends with an agent_end that has no 'messages' field — valid JSON, wrong shape.
  const badStream =
    '{"type":"session"}\n' +
    '{"type":"agent_start"}\n' +
    '{"type":"agent_end"}\n'; // missing required 'messages' field

  const fake = makeFakeSpawn([{ stdout: [badStream], exitCode: 0 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "schema-bad",
        prompt: "p",
        promptHash: "ph",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MalformedAgentOutputError);
      assert.equal((err as MalformedAgentOutputError).reason, "unexpected-schema");
      assert.equal((err as MalformedAgentOutputError).agentId, "schema-bad");
      return true;
    },
  );
});

test("spawn-spy: agent_end missing messages on line 2 → correct lineNumber in error", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // agent_end is the second non-empty line → lineNumber should be 2
  const badStream =
    '{"type":"session"}\n' +
    '{"type":"agent_end"}\n'; // line 2, missing "messages"

  const fake = makeFakeSpawn([{ stdout: [badStream], exitCode: 0 }]);
  await assert.rejects(
    () =>
      dispatchAgent({
        runDir,
        agentId: "line-num-check",
        prompt: "p",
        promptHash: "ph",
        cwd: runDir,
        spawn: fake.spawn,
        skipParentDeathGuard: true,
        timeoutMs: 1500,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MalformedAgentOutputError);
      assert.equal((err as MalformedAgentOutputError).reason, "unexpected-schema");
      assert.equal((err as MalformedAgentOutputError).lineNumber, 2);
      return true;
    },
  );
});

test("spawn-spy: unknown event types pass through without schema error", { timeout: 5000 }, async () => {
  const runDir = tmpRunDir();
  // A new pi event type we don't know — should be forward-compat, not an error.
  const stream =
    '{"type":"future_event","someNewField":"data"}\n' +
    '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"ok"}]}]}\n';

  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);
  const result = await dispatchAgent({
    runDir,
    agentId: "future",
    prompt: "p",
    promptHash: "ph",
    cwd: runDir,
    spawn: fake.spawn,
    skipParentDeathGuard: true,
    timeoutMs: 1500,
  });
  assert.equal(result.ok, true);
});
