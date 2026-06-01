/**
 * tests/unit/transcriptOpen.test.ts
 *
 * Unit tests for slice-15 transcript-open helper and clipboard helper.
 * No real editor invocations — uses _spawnSync and _execFileSync seams.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openTranscriptInEditor,
  copyToClipboard,
  agentTranscriptPath,
} from "../../src/runtime/transcriptOpen.js";

// ─── agentTranscriptPath ────────────────────────────────────────────

test("agentTranscriptPath: joins runDir + agents/<agentId>.jsonl", () => {
  const p = agentTranscriptPath("/runs/wf-abc", "analyze-0");
  assert.equal(p, "/runs/wf-abc/agents/analyze-0.jsonl");
});

test("agentTranscriptPath: returns undefined when runDir is undefined", () => {
  assert.equal(agentTranscriptPath(undefined, "analyze-0"), undefined);
});

// ─── openTranscriptInEditor ─────────────────────────────────────────

test("returns no-editor when EDITOR is unset and no override", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-open-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, "{}");

  const result = openTranscriptInEditor({
    transcriptPath: path,
    editor: "", // explicitly empty — simulates unset EDITOR
    _spawnSync: () => null,
  });
  assert.equal(result.kind, "no-editor");
  assert.equal((result as { reason: string }).reason, "EDITOR-unset");
});

test("returns file-not-found when transcript path does not exist", () => {
  const result = openTranscriptInEditor({
    transcriptPath: "/tmp/does-not-exist-xyz.jsonl",
    editor: "nvim",
    _spawnSync: () => null,
  });
  assert.equal(result.kind, "no-editor");
  assert.equal((result as { reason: string }).reason, "file-not-found");
});

test("opens editor with transcript path as last arg", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-open-"));
  const transcriptPath = join(dir, "agent.jsonl");
  writeFileSync(transcriptPath, "{}");

  const calls: { cmd: string; args: string[] }[] = [];
  const result = openTranscriptInEditor({
    transcriptPath,
    editor: "nvim",
    _spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return null;
    },
  });
  assert.equal(result.kind, "opened-editor");
  assert.equal(calls[0]!.cmd, "nvim");
  assert.ok(calls[0]!.args.includes(transcriptPath), "transcript path should be in args");
});

test("splits multi-word editor (e.g. 'code -w') on whitespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-open-"));
  const transcriptPath = join(dir, "agent.jsonl");
  writeFileSync(transcriptPath, "{}");

  const calls: { cmd: string; args: string[] }[] = [];
  openTranscriptInEditor({
    transcriptPath,
    editor: "code -w",
    _spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return null;
    },
  });
  assert.equal(calls[0]!.cmd, "code");
  assert.ok(calls[0]!.args.includes("-w"), "editor flag missing from args");
  assert.ok(calls[0]!.args.includes(transcriptPath), "path missing from args");
});

test("returns error when spawnSync throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-open-"));
  const transcriptPath = join(dir, "agent.jsonl");
  writeFileSync(transcriptPath, "{}");

  const result = openTranscriptInEditor({
    transcriptPath,
    editor: "bad-editor",
    _spawnSync: () => {
      throw new Error("spawn ENOENT");
    },
  });
  assert.equal(result.kind, "error");
  assert.ok((result as { message: string }).message.includes("ENOENT"));
});

// ─── copyToClipboard ────────────────────────────────────────────────

test("copies via first available tool (pbcopy)", () => {
  let captured = "";
  const result = copyToClipboard({
    text: "hello clipboard",
    _execFileSync: (_bin, _args, opts) => {
      captured = (opts as { input?: string } | undefined)?.input ?? "";
      return Buffer.alloc(0);
    },
  });
  assert.equal(result.kind, "copied");
  assert.equal((result as { tool: string }).tool, "pbcopy");
  assert.equal(captured, "hello clipboard");
});

test("falls back through tools when pbcopy fails", () => {
  const tried: string[] = [];
  const result = copyToClipboard({
    text: "hello",
    _execFileSync: (bin) => {
      tried.push(bin);
      if (bin === "pbcopy" || bin === "xclip") throw new Error("not found");
      return Buffer.alloc(0);
    },
  });
  assert.equal(result.kind, "copied");
  assert.equal((result as { tool: string }).tool, "xsel");
  assert.deepEqual(tried, ["pbcopy", "xclip", "xsel"]);
});

test("returns no-tool when all tools fail", () => {
  const result = copyToClipboard({
    text: "hello",
    _execFileSync: () => {
      throw new Error("not available");
    },
  });
  assert.equal(result.kind, "no-tool");
  assert.ok(
    (result as { reason: string }).reason.includes("no clipboard tool"),
    `unexpected reason: ${(result as { reason: string }).reason}`,
  );
});

// ─── mixed-success fallback chain (counter-driven stub) ─────────────

test("copyToClipboard: pbcopy throws, xclip succeeds → tool='xclip'", () => {
  let calls = 0;
  const tried: string[] = [];
  const result = copyToClipboard({
    text: "payload",
    _execFileSync: (bin) => {
      calls += 1;
      tried.push(bin);
      // Counter-driven: first call (pbcopy) throws, second (xclip) succeeds.
      if (calls === 1) throw new Error("pbcopy: spawn ENOENT");
      return Buffer.alloc(0);
    },
  });
  assert.equal(result.kind, "copied");
  assert.equal((result as { tool: string }).tool, "xclip");
  assert.deepEqual(tried, ["pbcopy", "xclip"]);
  assert.equal(calls, 2, "xsel must NOT be tried after xclip succeeds");
});

test("copyToClipboard: pbcopy + xclip throw, xsel succeeds (counter)", () => {
  let calls = 0;
  const tried: string[] = [];
  const result = copyToClipboard({
    text: "payload",
    _execFileSync: (bin, args) => {
      calls += 1;
      tried.push(bin);
      if (calls < 3) throw new Error(`${bin}: not installed`);
      // xsel: assert it was invoked with the expected args
      assert.deepEqual(args, ["--clipboard", "--input"]);
      return Buffer.alloc(0);
    },
  });
  assert.equal(result.kind, "copied");
  assert.equal((result as { tool: string }).tool, "xsel");
  assert.deepEqual(tried, ["pbcopy", "xclip", "xsel"]);
  assert.equal(calls, 3);
});

test("copyToClipboard: all three throw → no-tool reason cites every tool", () => {
  const result = copyToClipboard({
    text: "payload",
    _execFileSync: (bin) => {
      throw new Error(`${bin} unavailable here`);
    },
  });
  assert.equal(result.kind, "no-tool");
  const { reason } = result as { reason: string };
  // Every tool name and its error message must appear in the reason.
  for (const bin of ["pbcopy", "xclip", "xsel"]) {
    assert.ok(
      reason.includes(`${bin}:`),
      `reason missing tool tag '${bin}:' — got: ${reason}`,
    );
    assert.ok(
      reason.includes(`${bin} unavailable here`),
      `reason missing error message for ${bin} — got: ${reason}`,
    );
  }
});

test("openTranscriptInEditor: EDITOR='code -w /opt/file' splits and forwards every token", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-open-"));
  const transcriptPath = join(dir, "agent.jsonl");
  writeFileSync(transcriptPath, "{}");

  const calls: { cmd: string; args: string[] }[] = [];
  const result = openTranscriptInEditor({
    transcriptPath,
    editor: "code -w /opt/file",
    _spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return null;
    },
  });
  assert.equal(result.kind, "opened-editor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "code");
  // -w and the literal /opt/file token must both be forwarded, in order,
  // before the transcript path which is appended last.
  assert.deepEqual(calls[0]!.args, ["-w", "/opt/file", transcriptPath]);
});
