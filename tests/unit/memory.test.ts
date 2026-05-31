/**
 * tests/unit/memory.test.ts — ZONE_MEMORY: persistent per-agent memory.
 *
 * Coverage matrix:
 *   - resolveMemoryDir: three scopes (user/project/local) produce the
 *     documented paths; bad names rejected.
 *   - readMemoryFile: missing file → null; oversize file → trimmed at
 *     25 KiB exact.
 *   - parseMemoryScope: 'false' / undefined disable; recognized strings
 *     pass through; bad shapes throw TypeError.
 *   - buildPromptWithMemory: null memory leaves prompt verbatim;
 *     populated memory prepends the documented header.
 *   - appendMemoryUpdate: creates file + dir on first write; preserves
 *     a separator newline between consecutive updates.
 *   - dispatcher integration: prompt arg sent to the child carries the
 *     memory header; `memory_update` events flush to MEMORY.md after
 *     the stream settles.
 *   - manifest record: `recordAgentMemoryDir` populates
 *     `agentMemoryDirs` and is idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  promises as fs,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  appendMemoryUpdate,
  assertSafeMemoryName,
  buildPromptWithMemory,
  InvalidMemoryNameError,
  MEMORY_FILE_NAME,
  MEMORY_PROMPT_PREFIX,
  MEMORY_READ_CAP_BYTES,
  parseMemoryScope,
  readMemoryFile,
  resolveMemoryDir,
} from "../../src/runtime/agentMemory.ts";
import { recordAgentMemoryDir } from "../../src/runtime/manifestWriter.ts";
import { dispatchAgent } from "../../src/runtime/dispatcher.ts";
import { makeFakeSpawn } from "../helpers/fakeChild.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── parseMemoryScope ───────────────────────────────────────────────

test("parseMemoryScope: false / undefined / null → null", () => {
  assert.equal(parseMemoryScope(false), null);
  assert.equal(parseMemoryScope(undefined), null);
  assert.equal(parseMemoryScope(null), null);
});

test("parseMemoryScope: recognized strings pass through", () => {
  assert.equal(parseMemoryScope("user"), "user");
  assert.equal(parseMemoryScope("project"), "project");
  assert.equal(parseMemoryScope("local"), "local");
});

test("parseMemoryScope: unknown string throws TypeError", () => {
  assert.throws(() => parseMemoryScope("global"), TypeError);
  assert.throws(() => parseMemoryScope(""), TypeError);
});

test("parseMemoryScope: non-string truthy throws TypeError", () => {
  assert.throws(() => parseMemoryScope(true as unknown), TypeError);
  assert.throws(() => parseMemoryScope({} as unknown), TypeError);
  assert.throws(() => parseMemoryScope(42 as unknown), TypeError);
});

// ─── assertSafeMemoryName ────────────────────────────────────────────

test("assertSafeMemoryName: accepts plain identifiers", () => {
  assert.doesNotThrow(() => assertSafeMemoryName("auditor"));
  assert.doesNotThrow(() => assertSafeMemoryName("Code-Reviewer_v2"));
});

test("assertSafeMemoryName: rejects empty / non-string", () => {
  assert.throws(() => assertSafeMemoryName(""), InvalidMemoryNameError);
  assert.throws(() => assertSafeMemoryName(42 as unknown), InvalidMemoryNameError);
  assert.throws(() => assertSafeMemoryName(null as unknown), InvalidMemoryNameError);
});

test("assertSafeMemoryName: rejects path separators", () => {
  assert.throws(() => assertSafeMemoryName("a/b"), InvalidMemoryNameError);
  assert.throws(() => assertSafeMemoryName("a\\b"), InvalidMemoryNameError);
});

test("assertSafeMemoryName: rejects path-traversal", () => {
  assert.throws(() => assertSafeMemoryName(".."), InvalidMemoryNameError);
  assert.throws(() => assertSafeMemoryName("a..b"), InvalidMemoryNameError);
  assert.throws(() => assertSafeMemoryName("../../etc/passwd"), InvalidMemoryNameError);
});

test("assertSafeMemoryName: rejects hidden-file names", () => {
  assert.throws(() => assertSafeMemoryName(".hidden"), InvalidMemoryNameError);
});

test("assertSafeMemoryName: rejects NUL bytes", () => {
  assert.throws(() => assertSafeMemoryName("a\0b"), InvalidMemoryNameError);
});

// ─── resolveMemoryDir ────────────────────────────────────────────────

test("resolveMemoryDir: user scope under ~/.pi/agent/workflows/agent-memory/<name>", () => {
  const home = "/fake/home";
  const dir = resolveMemoryDir({
    scope: "user",
    name: "auditor",
    cwd: "/cwd",
    runDirAbs: "/run",
    homeDir: home,
  });
  assert.equal(
    dir,
    join(home, ".pi", "agent", "workflows", "agent-memory", "auditor"),
  );
});

test("resolveMemoryDir: user scope defaults homeDir to os.homedir()", () => {
  const dir = resolveMemoryDir({
    scope: "user",
    name: "auditor",
    cwd: "/cwd",
    runDirAbs: "/run",
  });
  assert.equal(
    dir,
    join(homedir(), ".pi", "agent", "workflows", "agent-memory", "auditor"),
  );
});

test("resolveMemoryDir: project scope under <cwd>/.pi/workflows/agent-memory/<name>", () => {
  const dir = resolveMemoryDir({
    scope: "project",
    name: "auditor",
    cwd: "/repo/proj",
    runDirAbs: "/run",
  });
  assert.equal(
    dir,
    join("/repo/proj", ".pi", "workflows", "agent-memory", "auditor"),
  );
});

test("resolveMemoryDir: local scope under <runDir>/agent-memory/<name>", () => {
  const dir = resolveMemoryDir({
    scope: "local",
    name: "auditor",
    cwd: "/cwd",
    runDirAbs: "/run/wf-abc",
  });
  assert.equal(dir, join("/run/wf-abc", "agent-memory", "auditor"));
});

test("resolveMemoryDir: rejects unsafe names", () => {
  assert.throws(
    () =>
      resolveMemoryDir({
        scope: "user",
        name: "../etc",
        cwd: "/cwd",
        runDirAbs: "/run",
      }),
    InvalidMemoryNameError,
  );
});

// ─── readMemoryFile ──────────────────────────────────────────────────

test("readMemoryFile: missing file → null (no injection)", async () => {
  const dir = tmp("pi-wf-mem-missing-");
  const content = await readMemoryFile(dir);
  assert.equal(content, null);
});

test("readMemoryFile: missing dir → null (silent)", async () => {
  const content = await readMemoryFile("/nonexistent/path/does/not/exist");
  assert.equal(content, null);
});

test("readMemoryFile: empty file → null", async () => {
  const dir = tmp("pi-wf-mem-empty-");
  writeFileSync(join(dir, MEMORY_FILE_NAME), "");
  const content = await readMemoryFile(dir);
  assert.equal(content, null);
});

test("readMemoryFile: small file returned verbatim", async () => {
  const dir = tmp("pi-wf-mem-small-");
  writeFileSync(join(dir, MEMORY_FILE_NAME), "hello\nworld\n");
  const content = await readMemoryFile(dir);
  assert.equal(content, "hello\nworld\n");
});

test("readMemoryFile: oversize file truncated at MEMORY_READ_CAP_BYTES", async () => {
  const dir = tmp("pi-wf-mem-big-");
  // 30 KiB of repeating ASCII so byte length === char length.
  const big = "a".repeat(30 * 1024);
  writeFileSync(join(dir, MEMORY_FILE_NAME), big);
  const content = await readMemoryFile(dir);
  assert.notEqual(content, null);
  assert.equal(Buffer.byteLength(content!, "utf8"), MEMORY_READ_CAP_BYTES);
  // First 25 KiB are the literal 'a' run; nothing else trailing.
  assert.equal(content!.length, MEMORY_READ_CAP_BYTES);
  for (let i = 0; i < content!.length; i++) {
    if (content![i] !== "a") {
      assert.fail(`unexpected byte at offset ${i}: ${content![i]}`);
    }
  }
});

// ─── buildPromptWithMemory ───────────────────────────────────────────

test("buildPromptWithMemory: null memory → original prompt verbatim", () => {
  const out = buildPromptWithMemory("hello", null);
  assert.equal(out, "hello");
});

test("buildPromptWithMemory: empty memory → original prompt verbatim", () => {
  const out = buildPromptWithMemory("hello", "");
  assert.equal(out, "hello");
});

test("buildPromptWithMemory: prepends `Persistent memory:` header + blank line", () => {
  const out = buildPromptWithMemory("do the task", "key=value");
  assert.equal(out, MEMORY_PROMPT_PREFIX + "key=value\n\ndo the task");
});

test("buildPromptWithMemory: trailing-newline memory uses single separator", () => {
  const out = buildPromptWithMemory("do the task", "key=value\n");
  assert.equal(out, MEMORY_PROMPT_PREFIX + "key=value\n\ndo the task");
});

// ─── appendMemoryUpdate ──────────────────────────────────────────────

test("appendMemoryUpdate: creates dir + file on first write", async () => {
  const root = tmp("pi-wf-mem-append-");
  const dir = join(root, "nested", "auditor");
  await appendMemoryUpdate(dir, "first observation");
  const path = join(dir, MEMORY_FILE_NAME);
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, "utf8"), "first observation\n");
});

test("appendMemoryUpdate: empty / non-string text is a no-op", async () => {
  const dir = tmp("pi-wf-mem-noop-");
  await appendMemoryUpdate(dir, "");
  await appendMemoryUpdate(dir, 42 as unknown);
  await appendMemoryUpdate(dir, null as unknown);
  assert.equal(existsSync(join(dir, MEMORY_FILE_NAME)), false);
});

test("appendMemoryUpdate: separates consecutive updates with a newline", async () => {
  const dir = tmp("pi-wf-mem-sep-");
  // Existing content lacks a trailing newline.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MEMORY_FILE_NAME), "prior");
  await appendMemoryUpdate(dir, "next");
  const out = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
  assert.equal(out, "prior\nnext\n");
});

test("appendMemoryUpdate: doesn't double-newline when existing tail is already \\n", async () => {
  const dir = tmp("pi-wf-mem-tail-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MEMORY_FILE_NAME), "prior\n");
  await appendMemoryUpdate(dir, "next");
  const out = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
  assert.equal(out, "prior\nnext\n");
});

// ─── recordAgentMemoryDir manifest merge ─────────────────────────────

test("recordAgentMemoryDir: writes agentMemoryDirs into a fresh manifest", async () => {
  const dir = tmp("pi-wf-mem-manifest-");
  await recordAgentMemoryDir(dir, "auditor", "/some/abs/dir");
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(json.agentMemoryDirs, { auditor: "/some/abs/dir" });
});

test("recordAgentMemoryDir: merges into existing manifest without clobbering other fields", async () => {
  const dir = tmp("pi-wf-mem-manifest-merge-");
  await fs.writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      runId: "wf-abc",
      workflowName: "audit",
      agentMemoryDirs: { reviewer: "/r/dir" },
    }),
  );
  await recordAgentMemoryDir(dir, "auditor", "/a/dir");
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(json.runId, "wf-abc");
  assert.equal(json.workflowName, "audit");
  assert.deepEqual(json.agentMemoryDirs, {
    reviewer: "/r/dir",
    auditor: "/a/dir",
  });
});

test("recordAgentMemoryDir: idempotent re-record of same (name, dir) is a no-op", async () => {
  const dir = tmp("pi-wf-mem-manifest-idem-");
  await recordAgentMemoryDir(dir, "auditor", "/a/dir");
  const before = readFileSync(join(dir, "manifest.json"), "utf8");
  await recordAgentMemoryDir(dir, "auditor", "/a/dir");
  const after = readFileSync(join(dir, "manifest.json"), "utf8");
  assert.equal(before, after);
});

test("recordAgentMemoryDir: serializes concurrent writers into the same manifest", async () => {
  const dir = tmp("pi-wf-mem-manifest-conc-");
  await Promise.all([
    recordAgentMemoryDir(dir, "a", "/dir/a"),
    recordAgentMemoryDir(dir, "b", "/dir/b"),
    recordAgentMemoryDir(dir, "c", "/dir/c"),
  ]);
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(json.agentMemoryDirs, {
    a: "/dir/a",
    b: "/dir/b",
    c: "/dir/c",
  });
});

// ─── dispatcher integration: prompt prefix + memory_update flush ─────

/**
 * Build a real `agent_end` event payload accepted by the dispatcher
 * schema validator. The dispatcher requires a top-level `messages`
 * array; we keep it minimal but well-formed.
 */
function makeAgentEnd(
  text: string,
): Record<string, unknown> {
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

test("dispatchAgent: memory_update events appended to MEMORY.md after stream settles", async () => {
  const runDir = tmp("pi-wf-mem-disp-");
  const memoryRoot = tmp("pi-wf-mem-dir-");
  const memoryDir = join(memoryRoot, "auditor");

  // Single concatenated stdout chunk — fakeChild's `setImmediate`-paced
  // multi-chunk path races against the exit timer, surfacing as
  // ERR_STREAM_PREMATURE_CLOSE. The combined-chunk shape mirrors what
  // the other dispatcher.test.ts spawn-spy tests use.
  const stream =
    JSON.stringify({ type: "memory_update", text: "learned: X is good" }) + "\n" +
    JSON.stringify(makeAgentEnd("OK")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);

  const result = await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "do the thing",
    promptHash: "deadbeef",
    cwd: runDir,
    spawn: fake.spawn,
    memoryDir,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  // MEMORY.md was created with the appended text.
  const memPath = join(memoryDir, MEMORY_FILE_NAME);
  assert.ok(existsSync(memPath), "MEMORY.md should exist");
  assert.equal(
    readFileSync(memPath, "utf8"),
    "learned: X is good\n",
  );
});

test("dispatchAgent: multiple memory_update events flush in order", async () => {
  const runDir = tmp("pi-wf-mem-disp-multi-");
  const memoryDir = join(tmp("pi-wf-mem-multi-"), "auditor");

  const stream =
    JSON.stringify({ type: "memory_update", text: "first" }) + "\n" +
    JSON.stringify({ type: "memory_update", text: "second" }) + "\n" +
    JSON.stringify(makeAgentEnd("done")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);

  await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "x",
    promptHash: "h",
    cwd: runDir,
    spawn: fake.spawn,
    memoryDir,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  const out = readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8");
  assert.equal(out, "first\nsecond\n");
});

test("dispatchAgent: memory_update with non-string text is ignored", async () => {
  const runDir = tmp("pi-wf-mem-disp-bad-");
  const memoryDir = join(tmp("pi-wf-mem-bad-"), "auditor");

  const stream =
    JSON.stringify({ type: "memory_update", text: 42 }) + "\n" +
    JSON.stringify({ type: "memory_update" }) + "\n" +
    JSON.stringify({ type: "memory_update", text: "kept" }) + "\n" +
    JSON.stringify(makeAgentEnd("ok")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);

  await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "x",
    promptHash: "h",
    cwd: runDir,
    spawn: fake.spawn,
    memoryDir,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });

  assert.equal(readFileSync(join(memoryDir, MEMORY_FILE_NAME), "utf8"), "kept\n");
});

test("dispatchAgent: no memoryDir → memory_update events are accepted but never flushed", async () => {
  const runDir = tmp("pi-wf-mem-disp-none-");
  const stream =
    JSON.stringify({ type: "memory_update", text: "X" }) + "\n" +
    JSON.stringify(makeAgentEnd("ok")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);
  // No memoryDir: the dispatcher accepts the event but performs no
  // disk write. We assert nothing crashed and the result is OK.
  const result = await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "x",
    promptHash: "h",
    cwd: runDir,
    spawn: fake.spawn,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true);
});

test("dispatchAgent: child crash before agent_end skips memory flush", async () => {
  const runDir = tmp("pi-wf-mem-disp-crash-");
  const memoryDir = join(tmp("pi-wf-mem-crash-"), "auditor");
  const stream = JSON.stringify({ type: "memory_update", text: "X" }) + "\n";
    // No agent_end; child exits non-zero.
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 1 }]);
  await assert.rejects(
    dispatchAgent({
      runDir,
      agentId: "agent-1",
      prompt: "x",
      promptHash: "h",
      cwd: runDir,
      spawn: fake.spawn,
      memoryDir,
      skipParentDeathGuard: true,
      timeoutMs: 5_000,
    }),
  );
  // Memory not flushed because agent_end never arrived.
  assert.equal(existsSync(join(memoryDir, MEMORY_FILE_NAME)), false);
});

// ─── prompt prefix is what the child receives ────────────────────────

test("dispatchAgent: prompt arg contains the verbatim opts.prompt (memory injection happens upstream of dispatcher)", async () => {
  // The dispatcher itself does NOT know about memory injection — it
  // sends `opts.prompt` verbatim to pi. The runtime layer
  // (runCtx.runOneAgent) is responsible for prepending the
  // `Persistent memory:` header before calling dispatchAgent. This
  // test pins the dispatcher's contract: it does not mutate the
  // prompt.
  const runDir = tmp("pi-wf-mem-prompt-");
  const stream = JSON.stringify(makeAgentEnd("ok")) + "\n";
  const fake = makeFakeSpawn([{ stdout: [stream], exitCode: 0 }]);
  await dispatchAgent({
    runDir,
    agentId: "agent-1",
    prompt: "Persistent memory:\nkey=v\n\ndo work",
    promptHash: "h",
    cwd: runDir,
    spawn: fake.spawn,
    skipParentDeathGuard: true,
    timeoutMs: 5_000,
  });
  assert.equal(fake.calls.length, 1);
  const args = fake.calls[0]!.args;
  // pi argv: --mode json -p <prompt>
  const promptIndex = args.indexOf("-p");
  assert.ok(promptIndex >= 0, "expected -p in argv");
  assert.equal(args[promptIndex + 1], "Persistent memory:\nkey=v\n\ndo work");
});
