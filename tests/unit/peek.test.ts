/**
 * tests/unit/peek.test.ts — P2-S6 ledger-tail reader.
 *
 * Pure file-system harness: write a synthetic `ledger.jsonl` to a
 * tmp dir and assert `readPeekLines` returns the last N meaningful
 * entries in chronological order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPeekLines } from "../../src/runtime/peek.js";

function makeRunDir(jsonl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "peek-test-"));
  writeFileSync(join(dir, "ledger.jsonl"), jsonl, "utf8");
  return dir;
}

test("readPeekLines: missing dir returns []", () => {
  assert.deepEqual(readPeekLines("/nonexistent/path/xyz", 5), []);
});

test("readPeekLines: empty file returns []", () => {
  const dir = makeRunDir("");
  try {
    assert.deepEqual(readPeekLines(dir, 5), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPeekLines: returns last N meaningful entries in chronological order", () => {
  const lines = [
    JSON.stringify({ type: "init", at: "2026-05-29T12:00:00.000Z", manifest: {} }),
    JSON.stringify({
      type: "phase_start",
      at: "2026-05-29T12:00:01.000Z",
      phaseName: "recon",
      agentCount: 3,
    }),
    JSON.stringify({
      type: "agent_start",
      at: "2026-05-29T12:00:02.000Z",
      phaseName: "recon",
      agentId: "a1",
      promptHash: "x",
    }),
    JSON.stringify({
      type: "log",
      at: "2026-05-29T12:00:03.000Z",
      level: "info",
      message: "hello world",
    }),
    JSON.stringify({
      type: "agent_end",
      at: "2026-05-29T12:00:04.000Z",
      phaseName: "recon",
      agentId: "a1",
      durationMs: 1234,
      usage: {},
      cached: false,
    }),
  ].join("\n") + "\n";
  const dir = makeRunDir(lines);
  try {
    const out = readPeekLines(dir, 3);
    // Last 3 meaningful: agent_start, log, agent_end (init skipped).
    assert.equal(out.length, 3);
    assert.equal(out[0], "[12:00] recon/a1 start");
    assert.equal(out[1], "[12:00] hello world");
    assert.equal(out[2], "[12:00] recon/a1 end (1234ms)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPeekLines: filters out non-meaningful entries (init, transition, result)", () => {
  const lines = [
    JSON.stringify({ type: "init", at: "2026-05-29T12:00:00.000Z", manifest: {} }),
    JSON.stringify({
      type: "transition",
      at: "2026-05-29T12:00:01.000Z",
      from: "approved",
      to: "running",
    }),
    JSON.stringify({
      type: "result",
      at: "2026-05-29T12:00:02.000Z",
      truncated: false,
      result: "ok",
    }),
  ].join("\n") + "\n";
  const dir = makeRunDir(lines);
  try {
    assert.deepEqual(readPeekLines(dir, 5), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPeekLines: malformed JSON lines are skipped", () => {
  const lines = [
    "{ this is not json",
    JSON.stringify({
      type: "log",
      at: "2026-05-29T12:00:03.000Z",
      level: "info",
      message: "after the bad line",
    }),
  ].join("\n") + "\n";
  const dir = makeRunDir(lines);
  try {
    const out = readPeekLines(dir, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0], "[12:00] after the bad line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPeekLines: phase_start / phase_end formatted with counts and durations", () => {
  const lines = [
    JSON.stringify({
      type: "phase_start",
      at: "2026-05-29T09:15:00.000Z",
      phaseName: "build",
      agentCount: 7,
    }),
    JSON.stringify({
      type: "phase_end",
      at: "2026-05-29T09:18:00.000Z",
      phaseName: "build",
      durationMs: 180000,
      agentResults: { ok: 7, error: 0, cacheHit: 0 },
    }),
  ].join("\n") + "\n";
  const dir = makeRunDir(lines);
  try {
    const out = readPeekLines(dir, 5);
    assert.equal(out.length, 2);
    assert.equal(out[0], "[09:15] phase build start (7 agents)");
    assert.equal(out[1], "[09:18] phase build end (180000ms)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
