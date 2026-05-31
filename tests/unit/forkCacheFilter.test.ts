/**
 * tests/unit/forkCacheFilter.test.ts — ZONE_TIMETRAVEL strict cache filtering.
 *
 * Covers `_classifyParentCacheLine` from `src/runtime/forkRun.ts`. The
 * helper decides whether a single `cache.jsonl` line from the parent
 * run should be inherited by a fork. The strict rule: `agent_result`
 * records with `at >= cutAt` (the parent's `phase_start` for the fork's
 * atPhase) are dropped; everything else is kept.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { _classifyParentCacheLine } from "../../src/runtime/forkRun.js";

const ISO_BEFORE = "2026-05-31T12:00:00.000Z";
const ISO_CUT = "2026-05-31T12:30:00.000Z";
const ISO_AFTER = "2026-05-31T13:00:00.000Z";

test("strict-cache-filter: agent_result before cutAt is kept", () => {
  const line = JSON.stringify({
    type: "agent_result",
    key: "abc123",
    at: ISO_BEFORE,
    value: { agentId: "a1", text: "x" },
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "keep");
});

test("strict-cache-filter: agent_result at exact cutAt boundary is dropped (>=)", () => {
  // Lexicographic equal → not less than → drop. This guards against
  // a parent agent_end that wrote its cache record at the same ISO
  // millisecond as the cut phase_start (rare but possible).
  const line = JSON.stringify({
    type: "agent_result",
    key: "abc123",
    at: ISO_CUT,
    value: { agentId: "a1", text: "x" },
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "drop");
});

test("strict-cache-filter: agent_result after cutAt is dropped", () => {
  const line = JSON.stringify({
    type: "agent_result",
    key: "abc123",
    at: ISO_AFTER,
    value: { agentId: "a2", text: "y" },
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "drop");
});

test("strict-cache-filter: author_cache records are always kept (regardless of timestamp)", () => {
  // Author-controlled cache (ctx.cache.set) is not auto-derived from
  // agent execution and may legitimately encode pre-run state. We do
  // not filter it by phase boundary.
  const before = JSON.stringify({
    type: "author_cache",
    key: "user-flag",
    at: ISO_BEFORE,
    value: 42,
  });
  const after = JSON.stringify({
    type: "author_cache",
    key: "user-flag",
    at: ISO_AFTER,
    value: 99,
  });
  assert.equal(_classifyParentCacheLine(before, ISO_CUT), "keep");
  assert.equal(_classifyParentCacheLine(after, ISO_CUT), "keep");
});

test("strict-cache-filter: author_cache_delete records are kept", () => {
  const line = JSON.stringify({
    type: "author_cache_delete",
    key: "stale",
    at: ISO_AFTER,
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "keep");
});

test("strict-cache-filter: unknown record types are kept (forward-compat)", () => {
  const line = JSON.stringify({
    type: "future_record_type_v3",
    at: ISO_AFTER,
    payload: { anything: 1 },
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "keep");
});

test("strict-cache-filter: malformed JSON line is dropped", () => {
  assert.equal(_classifyParentCacheLine("{not json", ISO_CUT), "drop");
  assert.equal(_classifyParentCacheLine("", ISO_CUT), "drop");
});

test("strict-cache-filter: agent_result missing `at` field is dropped (defensive)", () => {
  const line = JSON.stringify({
    type: "agent_result",
    key: "abc",
    value: { agentId: "a1", text: "x" },
  });
  assert.equal(_classifyParentCacheLine(line, ISO_CUT), "drop");
});

test("strict-cache-filter: empty cutAt disables filtering (back-compat)", () => {
  // Used when the cut-point ledger entry is missing/malformed —
  // we fall back to the legacy permissive behavior rather than
  // accidentally dropping every agent_result record.
  const line = JSON.stringify({
    type: "agent_result",
    key: "abc",
    at: ISO_AFTER,
    value: { agentId: "a1", text: "x" },
  });
  assert.equal(_classifyParentCacheLine(line, ""), "keep");
});

test("strict-cache-filter: non-object JSON literal is dropped", () => {
  assert.equal(_classifyParentCacheLine("null", ISO_CUT), "drop");
  assert.equal(_classifyParentCacheLine("42", ISO_CUT), "drop");
  assert.equal(_classifyParentCacheLine("\"string\"", ISO_CUT), "drop");
  assert.equal(_classifyParentCacheLine("[]", ISO_CUT), "drop");
});
