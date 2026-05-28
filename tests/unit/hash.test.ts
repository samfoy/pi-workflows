/**
 * tests/unit/hash.test.ts — slice 3 cache-key + canonical-JSON.
 *
 * Acceptance per `plan.md` §4 Slice 3:
 *   - sha256 is hex, deterministic, length 64.
 *   - Cache key formula matches PRD §4.5 byte-for-byte (an explicit
 *     test recomputes the expected hash from the formula).
 *   - cacheKey is order-independent on opts (sorted-keys requirement).
 *   - Determinism contract: no time/env/random/hostname/pid in hash —
 *     same inputs in two processes produce same hash. (Asserted via
 *     a child_process spawn + fixture script.)
 *   - 1-bit change in any input changes the hash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sha256,
  canonicalJson,
  cacheKey,
  type CacheKeyInput,
} from "../../src/util/hash.ts";

// ─── sha256 ──────────────────────────────────────────────────────────

test("sha256: returns lowercase hex of length 64", () => {
  const out = sha256("hello");
  assert.equal(out.length, 64);
  assert.match(out, /^[0-9a-f]{64}$/);
});

test("sha256: deterministic for same input across calls", () => {
  assert.equal(sha256("workflow-source"), sha256("workflow-source"));
});

test("sha256: matches Node crypto reference for known input", () => {
  const ref = createHash("sha256").update("abc").digest("hex");
  assert.equal(sha256("abc"), ref);
  // Spot-check a published vector ("abc" → known sha256).
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256: handles Uint8Array input identically to string", () => {
  const fromStr = sha256("hello");
  const fromBuf = sha256(new TextEncoder().encode("hello"));
  assert.equal(fromStr, fromBuf);
});

// ─── canonicalJson ──────────────────────────────────────────────────

test("canonicalJson: sorts object keys lexicographically", () => {
  const a = canonicalJson({ b: 1, a: 2, c: 3 });
  const b = canonicalJson({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test("canonicalJson: nested objects are sorted recursively", () => {
  const a = canonicalJson({ outer: { z: 1, a: 2 }, alpha: 1 });
  const b = canonicalJson({ alpha: 1, outer: { a: 2, z: 1 } });
  assert.equal(a, b);
  assert.equal(a, '{"alpha":1,"outer":{"a":2,"z":1}}');
});

test("canonicalJson: arrays preserve order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test("canonicalJson: undefined fields are dropped (matches JSON.stringify)", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("canonicalJson: top-level null and undefined both serialize as 'null'", () => {
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
});

test("canonicalJson: cycles throw TypeError", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  assert.throws(() => canonicalJson(o), /cycle detected/);
});

test("canonicalJson: bigint stringified (stable, not native JSON)", () => {
  assert.equal(canonicalJson({ n: 42n }), '{"n":"42"}');
});

// ─── cacheKey: PRD §4.5 ──────────────────────────────────────────────

const baseInput: CacheKeyInput = {
  workflowSourceSha256: "a".repeat(64),
  phaseName: "audit",
  agentId: "scout-1",
  prompt: "scout the README",
  opts: { model: "sonnet", cacheKeyExtra: "v1" },
};

test("cacheKey: matches the PRD §4.5 byte-for-byte formula", () => {
  // Recompute by hand from the formula and assert equal.
  const promptHash = sha256(baseInput.prompt);
  const optsHash = sha256(canonicalJson(baseInput.opts));
  const extraHash = sha256(canonicalJson("v1"));
  const composed =
    baseInput.workflowSourceSha256 +
    "|" + baseInput.phaseName +
    "|" + baseInput.agentId +
    "|" + promptHash +
    "|" + optsHash +
    "|" + extraHash;
  const expected = sha256(composed);
  assert.equal(cacheKey(baseInput), expected);
});

test("cacheKey: identical args produce identical key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({ ...baseInput, opts: { ...baseInput.opts! } });
  assert.equal(k1, k2);
});

test("cacheKey: order-independent on opts (sorted-keys requirement)", () => {
  const k1 = cacheKey({ ...baseInput, opts: { a: 1, b: 2, c: 3 } });
  const k2 = cacheKey({ ...baseInput, opts: { c: 3, a: 1, b: 2 } });
  assert.equal(k1, k2);
});

test("cacheKey: 1-byte change in workflowSourceSha256 → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({
    ...baseInput,
    workflowSourceSha256: "b" + baseInput.workflowSourceSha256.slice(1),
  });
  assert.notEqual(k1, k2);
});

test("cacheKey: 1-byte change in phaseName → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({ ...baseInput, phaseName: "audit2" });
  assert.notEqual(k1, k2);
});

test("cacheKey: 1-byte change in agentId → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({ ...baseInput, agentId: "scout-2" });
  assert.notEqual(k1, k2);
});

test("cacheKey: 1-byte change in prompt → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({ ...baseInput, prompt: baseInput.prompt + "." });
  assert.notEqual(k1, k2);
});

test("cacheKey: changing opts (other than cacheKeyExtra) → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({ ...baseInput, opts: { ...baseInput.opts!, model: "opus" } });
  assert.notEqual(k1, k2);
});

test("cacheKey: changing cacheKeyExtra → different key", () => {
  const k1 = cacheKey(baseInput);
  const k2 = cacheKey({
    ...baseInput,
    opts: { ...baseInput.opts!, cacheKeyExtra: "v2" },
  });
  assert.notEqual(k1, k2);
});

test("cacheKey: opts undefined and opts {} produce identical key", () => {
  const k1 = cacheKey({ ...baseInput, opts: undefined });
  const k2 = cacheKey({ ...baseInput, opts: {} });
  assert.equal(k1, k2);
});

test("cacheKey: cacheKeyExtra undefined and absent produce identical key", () => {
  const k1 = cacheKey({ ...baseInput, opts: { model: "x" } });
  const k2 = cacheKey({ ...baseInput, opts: { model: "x", cacheKeyExtra: undefined } });
  assert.equal(k1, k2);
});

// ─── determinism across processes (no env/time/random/pid in hash) ───

test("cacheKey: same hash from a fresh subprocess (no env/time/random)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-wf-hash-det-"));
  try {
    const repoRoot = new URL("../../", import.meta.url).pathname;
    const script = `
      import { cacheKey } from ${JSON.stringify(join(repoRoot, "src/util/hash.ts"))};
      const k = cacheKey({
        workflowSourceSha256: "${baseInput.workflowSourceSha256}",
        phaseName: ${JSON.stringify(baseInput.phaseName)},
        agentId: ${JSON.stringify(baseInput.agentId)},
        prompt: ${JSON.stringify(baseInput.prompt)},
        opts: ${JSON.stringify(baseInput.opts)},
      });
      process.stdout.write(k);
    `;
    const scriptPath = join(tmp, "child.mjs");
    writeFileSync(scriptPath, script);
    // Run in a fresh process with cleared env. If the implementation
    // were leaking env/time/pid into the hash, this would diverge.
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath],
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      },
    );
    assert.equal(out, cacheKey(baseInput));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
