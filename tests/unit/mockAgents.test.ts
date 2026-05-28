/**
 * Slice 6 — `mockAgents.ts` direct unit tests. Covers fixture-load
 * tolerance and the lookup-key contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureKey, loadFixtures, resolveMockAgent } from "../../src/runtime/mockAgents.js";
import { MockFixtureMissingError } from "../../src/runtime/errors.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-mock-"));
}

test("fixtureKey: composite of agentId+promptHash, separator-safe", () => {
  // The separator (NUL) is illegal in agentId/promptHash inputs, so
  // (agentId="a", promptHash="b") and (agentId="a\0b", promptHash="")
  // can't collide via concatenation.
  assert.equal(fixtureKey("a", "b"), "a\u0000b");
  assert.notEqual(fixtureKey("a", "b"), fixtureKey("ab", ""));
});

test("loadFixtures: missing file returns empty index, no throw", async () => {
  const dir = tmpRunDir();
  const { index, skipped } = await loadFixtures(dir);
  assert.equal(index.size, 0);
  assert.equal(skipped, 0);
});

test("loadFixtures: malformed lines skipped, valid ones loaded, count tracked", async () => {
  const dir = tmpRunDir();
  await fs.writeFile(
    join(dir, "fixtures.jsonl"),
    [
      JSON.stringify({ agentId: "ok", promptHash: "h1", result: { text: "x" } }),
      "{not-json",
      "",
      JSON.stringify({ agentId: "ok2", promptHash: "h2", result: { text: "y" } }),
      JSON.stringify({ missing: "fields" }),
    ].join("\n"),
  );
  const { index, skipped } = await loadFixtures(dir);
  assert.equal(index.size, 2);
  assert.equal(skipped, 2);
  assert.ok(index.has(fixtureKey("ok", "h1")));
  assert.ok(index.has(fixtureKey("ok2", "h2")));
});

test("resolveMockAgent: writes transcript file with events", async () => {
  const dir = tmpRunDir();
  await fs.writeFile(
    join(dir, "fixtures.jsonl"),
    JSON.stringify({
      agentId: "a",
      promptHash: "h",
      result: { text: "hi" },
      events: [{ type: "session" }, { type: "agent_end", messages: [] }],
    }) + "\n",
  );
  const r = await resolveMockAgent({ runDirAbs: dir, agentId: "a", promptHash: "h" });
  assert.equal(r.text, "hi");
  assert.ok(existsSync(r.transcriptPath));
  const lines = readFileSync(r.transcriptPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).type, "session");
});

test("resolveMockAgent: missing fixture rejects with constructive error", async () => {
  const dir = tmpRunDir();
  await fs.writeFile(join(dir, "fixtures.jsonl"), "");
  await assert.rejects(
    () => resolveMockAgent({ runDirAbs: dir, agentId: "g", promptHash: "p" }),
    (err: unknown) => {
      assert.ok(err instanceof MockFixtureMissingError);
      const msg = (err as Error).message;
      assert.ok(msg.includes("fixtures.jsonl"));
      assert.ok(msg.includes("g"));
      return true;
    },
  );
});
