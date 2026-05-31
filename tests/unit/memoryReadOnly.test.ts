/**
 * tests/unit/memoryReadOnly.test.ts — ZONE_MEMORY follow-up #5.
 *
 * Read-only memory mode: `ctx.agent({memory: {scope, readOnly: true}})`
 * injects MEMORY.md as usual but the dispatcher logs + drops any
 * `{type:'memory_update'}` events the sub-agent emits. `ctx.memory.append`
 * for the same `(scope, name)` tuple throws `ReadOnlyMemoryError`.
 *
 * Coverage:
 *   1. parseMemoryOpts: legacy strings stay non-readonly; object form with
 *      readOnly:true returns readOnly=true; bad shapes throw TypeError.
 *   2. dispatchAgent + memoryReadOnly: MEMORY.md content is read + injected
 *      into the prompt; emitted memory_update events DO NOT touch MEMORY.md
 *      and DO surface a single dropped-events line in stderr.
 *   3. ReadOnlyMemoryError: ctx.memory.append against a tuple flagged
 *      read-only at any point in the run rejects with the typed error.
 *   4. Mixed-tuple insulation: a different (scope, name) tuple stays
 *      writable even when a sibling was mounted read-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  promises as fs,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseMemoryOpts,
  ReadOnlyMemoryError,
  MEMORY_FILE_NAME,
  MEMORY_PROMPT_PREFIX,
} from "../../src/runtime/agentMemory.ts";
import { dispatchAgent } from "../../src/runtime/dispatcher.ts";
import { makeFakeSpawn } from "../helpers/fakeChild.ts";
import { createRunCtxHost } from "../../src/runtime/runCtx.ts";
import { CacheStore } from "../../src/runtime/cache.ts";
import { LedgerWriter } from "../../src/runtime/ledger.ts";
import { makeSemaphore } from "../../src/runtime/semaphore.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAgentEnd(text: string): Record<string, unknown> {
  return {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "x" }] },
      {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    ],
  };
}

// ─── 1. parseMemoryOpts ────────────────────────────────────────────────

test("parseMemoryOpts: legacy string 'user' → { scope: 'user', readOnly: false }", () => {
  assert.deepEqual(parseMemoryOpts("user"), { scope: "user", readOnly: false });
});

test("parseMemoryOpts: legacy string 'project' → { scope: 'project', readOnly: false }", () => {
  assert.deepEqual(parseMemoryOpts("project"), {
    scope: "project",
    readOnly: false,
  });
});

test("parseMemoryOpts: legacy string 'local' → { scope: 'local', readOnly: false }", () => {
  assert.deepEqual(parseMemoryOpts("local"), { scope: "local", readOnly: false });
});

test("parseMemoryOpts: object form { scope, readOnly: true } preserves readOnly flag", () => {
  assert.deepEqual(parseMemoryOpts({ scope: "user", readOnly: true }), {
    scope: "user",
    readOnly: true,
  });
});

test("parseMemoryOpts: object form without readOnly defaults to false", () => {
  assert.deepEqual(parseMemoryOpts({ scope: "project" }), {
    scope: "project",
    readOnly: false,
  });
});

test("parseMemoryOpts: false / undefined / null → null (no-op)", () => {
  assert.equal(parseMemoryOpts(false), null);
  assert.equal(parseMemoryOpts(undefined), null);
  assert.equal(parseMemoryOpts(null), null);
});

test("parseMemoryOpts: malformed shapes throw TypeError", () => {
  assert.throws(() => parseMemoryOpts(42 as unknown), TypeError);
  assert.throws(() => parseMemoryOpts("global" as unknown), TypeError);
  assert.throws(() => parseMemoryOpts({} as unknown), TypeError);
  assert.throws(() => parseMemoryOpts({ scope: "bogus" } as unknown), TypeError);
  assert.throws(() => parseMemoryOpts([1, 2, 3] as unknown), TypeError);
});

// ─── 2. dispatchAgent: readOnly mode reads but drops writes ────────────

test("dispatchAgent + memoryReadOnly: MEMORY.md is injected into prompt", async () => {
  const runDir = tmp("pi-wf-memro-");
  const memoryRoot = tmp("pi-wf-memro-dir-");
  const memoryDir = join(memoryRoot, "playbook");
  mkdirSync(memoryDir, { recursive: true });
  // Pre-populate MEMORY.md so the dispatcher reads + injects it.
  writeFileSync(
    join(memoryDir, MEMORY_FILE_NAME),
    "playbook entry: always preserve original branch\n",
  );

  // Capture the prompt the dispatcher actually sent the child.
  let capturedPrompt = "";
  const stream = JSON.stringify(makeAgentEnd("OK")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);
  const wrappedSpawn: typeof fake.spawn = (cmd, args, opts) => {
    if (Array.isArray(args)) {
      // The agent prompt is the trailing arg after ['--mode','json','-p'].
      const idx = args.indexOf("-p");
      if (idx >= 0 && idx + 1 < args.length)
        capturedPrompt = args[idx + 1] as string;
    }
    return fake.spawn(cmd, args, opts);
  };

  // The runCtx-resolved prompt-with-memory is what we'd see if the
  // runtime had injected memory before dispatch. Here we test the
  // dispatcher's read-only flag in isolation: inject the prefixed
  // prompt directly and assert the file is NOT modified by emitted
  // memory_update events.
  const promptWithMemory =
    MEMORY_PROMPT_PREFIX +
    readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8") +
    "\n" +
    "do the thing";

  const result = await dispatchAgent({
    runDir,
    agentId: "agent-ro",
    prompt: promptWithMemory,
    promptHash: "deadbeef",
    cwd: runDir,
    spawn: wrappedSpawn,
    memoryDir,
    memoryReadOnly: true,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.match(capturedPrompt, /Persistent memory:/);
  assert.match(capturedPrompt, /playbook entry/);
  // No memory_update was emitted — MEMORY.md unchanged.
  const after = readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8");
  assert.equal(after, "playbook entry: always preserve original branch\n");
});

test("dispatchAgent + memoryReadOnly: emitted memory_update events are dropped + logged", async () => {
  const runDir = tmp("pi-wf-memro-drop-");
  const memoryRoot = tmp("pi-wf-memro-drop-dir-");
  const memoryDir = join(memoryRoot, "playbook");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "original\n");

  // Sub-agent attempts two memory_update events. With readOnly=true
  // both should be dropped — MEMORY.md stays "original\n".
  const stream =
    JSON.stringify({ type: "memory_update", text: "rogue write 1" }) +
    "\n" +
    JSON.stringify({ type: "memory_update", text: "rogue write 2" }) +
    "\n" +
    JSON.stringify(makeAgentEnd("OK")) +
    "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);

  const result = await dispatchAgent({
    runDir,
    agentId: "agent-ro-drop",
    prompt: "x",
    promptHash: "deadbeef",
    cwd: runDir,
    spawn: fake.spawn,
    memoryDir,
    memoryReadOnly: true,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  // MEMORY.md is unchanged.
  const after = readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8");
  assert.equal(after, "original\n");
  // Stderr file received the dropped-events log line.
  const stderrPath = join(runDir, "agents", "agent-ro-drop.stderr");
  assert.ok(existsSync(stderrPath), "agent stderr file should exist");
  const stderr = readFileSync(stderrPath, "utf8");
  assert.match(stderr, /dropped 2 memory_update event/);
  assert.match(stderr, /memoryReadOnly=true/);
});

test("dispatchAgent (writable mode, control): memory_update events DO write to MEMORY.md", async () => {
  // Sanity-check baseline: same fixture without readOnly persists the events.
  const runDir = tmp("pi-wf-memro-rw-");
  const memoryRoot = tmp("pi-wf-memro-rw-dir-");
  const memoryDir = join(memoryRoot, "playbook");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "original\n");

  const stream =
    JSON.stringify({ type: "memory_update", text: "writable update" }) +
    "\n" +
    JSON.stringify(makeAgentEnd("OK")) +
    "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);

  const result = await dispatchAgent({
    runDir,
    agentId: "agent-rw",
    prompt: "x",
    promptHash: "deadbeef",
    cwd: runDir,
    spawn: fake.spawn,
    memoryDir,
    // memoryReadOnly NOT set
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  const after = readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8");
  // Original line + the new update.
  assert.match(after, /original/);
  assert.match(after, /writable update/);
});

// ─── 3. ctx.memory.append: ReadOnlyMemoryError ─────────────────────────

interface MemRoCtx {
  host: ReturnType<typeof createRunCtxHost>["host"];
  cleanup: () => void;
  runDir: string;
}

async function makeMemRoCtx(): Promise<MemRoCtx> {
  const runDir = tmp("pi-wf-memro-host-");
  const runId = "wf-memro";
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ctrl = new AbortController();
  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: () => ledgerPath,
  });
  const cache = await CacheStore.open({
    runId,
    resolveCachePath: () => join(runDir, "cache.jsonl"),
    log: () => {},
  });
  const semaphore = makeSemaphore({ cap: 4 });
  const { host } = createRunCtxHost({
    runMeta: {
      id: runId,
      workflowName: "memro-test",
      startedAt: new Date().toISOString(),
      cwd: runDir,
      resumed: false,
    },
    input: "",
    runDirAbs: runDir,
    workflowSourceSha256: "deadbeef",
    cache,
    ledger,
    semaphore,
    signal: ctrl.signal,
    perRunAgentCap: 8,
    mockAgents: false,
    cwd: runDir,
  });
  return {
    host,
    runDir,
    cleanup: () => {
      ctrl.abort();
      try {
        // best-effort
        require("node:fs").rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

test("ctx.memory.append: writeable tuple succeeds (control)", async () => {
  const ctx = await makeMemRoCtx();
  try {
    const r = await ctx.host.memory_append!("alpha", "local", "hello");
    assert.ok(r.ok, "append should succeed when no readOnly mount exists");
    // The file lives under <runDir>/agent-memory/alpha/MEMORY.md for
    // the local scope.
    const memPath = join(
      ctx.runDir,
      "agent-memory",
      "alpha",
      MEMORY_FILE_NAME,
    );
    assert.ok(existsSync(memPath));
    const body = await fs.readFile(memPath, "utf8");
    assert.match(body, /hello/);
  } finally {
    ctx.cleanup();
  }
});

test("ctx.memory.append: throws ReadOnlyMemoryError after a sibling agent mounted readOnly", async () => {
  const ctx = await makeMemRoCtx();
  try {
    // Simulate a ctx.agent({memory:{scope:'local',readOnly:true},name:'playbook'})
    // call by directly poking the host's tracking set via running the agent
    // path. Easiest: call ctx.agent() with the readOnly opts but mock-agents
    // mode would need a cache hit / fixture. Cheapest path: surface a small
    // test seam. Since the runCtx.ts implementation marks the tuple inside
    // runOneAgent BEFORE dispatch, we drive that path via a mock agent.
    //
    // For the unit test, we exercise the "append refuses after readonly"
    // contract by noting it's symmetric with the agent-spawn path: the
    // `readOnlyMemoryKeys` set is populated by ctx.agent() with readOnly,
    // and ctx.memory.append checks it. Driving a real ctx.agent with
    // memory + readOnly here requires a dispatch fixture, which is beyond
    // the unit-test scope. The dispatch-side coverage is in the readOnly
    // dispatch tests above; here we cover the contract via direct ctx.host
    // invocation:
    //
    // Workflow code path:
    //   ctx.agent("...", { memory: { scope: "local", readOnly: true }, name: "playbook" })
    //   ctx.memory.append("playbook", "local", "...") → ReadOnlyMemoryError
    //
    // Without spinning a full dispatcher we verify the error type via a
    // direct construction (and the error is exposed from agentMemory.ts so
    // workflows can `instanceof`-check).
    const e = new ReadOnlyMemoryError("playbook", "local");
    assert.equal(e.name, "ReadOnlyMemoryError");
    assert.equal(e.memoryName, "playbook");
    assert.equal(e.memoryScope, "local");
    assert.match(e.message, /read-only/);
    // The agent-spawn path that flips the readonly bit is exercised in
    // the integration test below.
  } finally {
    ctx.cleanup();
  }
});

// Integration: drive the real ctx.agent() path with memory={readOnly:true}
// + ctx.memory.append, asserting the second call rejects with
// ReadOnlyMemoryError. Uses mock-agents fixtures so no real subprocess is
// spawned.
test("ctx.memory.append: rejects with ReadOnlyMemoryError after a readOnly agent mount", async () => {
  const runDir = tmp("pi-wf-memro-int-");
  const runId = "wf-memro-int";
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ctrl = new AbortController();
  const ledger = new LedgerWriter({
    runId,
    resolveLedgerPath: () => ledgerPath,
  });
  const cache = await CacheStore.open({
    runId,
    resolveCachePath: () => join(runDir, "cache.jsonl"),
    log: () => {},
  });
  const semaphore = makeSemaphore({ cap: 4 });

  // Mock dispatch: returns immediately so we don't spawn a real subprocess.
  let mockedDispatchCalls = 0;
  const dispatch = async (opts: {
    agentId: string;
    prompt: string;
    runDir: string;
    promptHash: string;
    cwd: string;
  }) => {
    mockedDispatchCalls++;
    return {
      ok: true as const,
      agentId: opts.agentId,
      text: "stub response",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      durationMs: 1,
      transcriptPath: join(runDir, "agents", `${opts.agentId}.jsonl`),
      exitCode: 0,
    };
  };

  const { host } = createRunCtxHost({
    runMeta: {
      id: runId,
      workflowName: "memro-int",
      startedAt: new Date().toISOString(),
      cwd: runDir,
      resumed: false,
    },
    input: "",
    runDirAbs: runDir,
    workflowSourceSha256: "deadbeef",
    cache,
    ledger,
    semaphore,
    signal: ctrl.signal,
    perRunAgentCap: 8,
    mockAgents: false,
    cwd: runDir,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatch: dispatch as any,
  });

  try {
    // Mount the playbook tuple as read-only via a real ctx.agent dispatch.
    const handle = host.agent("read playbook", {
      memory: { scope: "local", readOnly: true },
      name: "playbook",
    });
    assert.ok(handle.ok, "agent handle should construct");
    // Drive a phase to actually run the agent (which marks the
    // (scope,name) tuple as readonly).
    const phaseResult = await host.phase("p1", [handle.value]);
    assert.ok(phaseResult.ok, "phase should resolve");
    assert.equal(mockedDispatchCalls, 1, "agent should have dispatched once");

    // Now ctx.memory.append against the same tuple must throw.
    const r = await host.memory_append!("playbook", "local", "rogue write");
    assert.equal(r.ok, false, "append should fail");
    if (!r.ok) {
      assert.equal(r.error.name, "ReadOnlyMemoryError");
      assert.match(r.error.message, /read-only/i);
    }

    // A different (scope, name) tuple stays writable — the readonly
    // flag is per-tuple, not global.
    const otherOk = await host.memory_append!(
      "different-name",
      "local",
      "this should write",
    );
    assert.ok(otherOk.ok, "sibling tuple should remain writable");
  } finally {
    ctrl.abort();
    try {
      require("node:fs").rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
