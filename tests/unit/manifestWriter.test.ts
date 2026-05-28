/**
 * Slice 6 — manifestWriter unit tests. Covers partial-write merge and
 * the parent-liveness capture pipeline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureParentLiveness,
  writeParentLivenessFields,
} from "../../src/runtime/manifestWriter.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-mfw-"));
}

test("captureParentLiveness: returns a sane snapshot", () => {
  const snap = captureParentLiveness();
  assert.equal(snap.parentPid, process.pid);
  assert.match(snap.parentStartTime, /^\d+$/, "decimal stringified bigint");
  // boot_id is hex with hyphens (UUID-ish) on Linux; empty otherwise.
  if (process.platform === "linux" && snap.parentBootId.length > 0) {
    assert.match(snap.parentBootId, /^[0-9a-f-]+$/);
  }
});

test("captureParentLiveness: pid override threads through", () => {
  const snap = captureParentLiveness({ pid: 99999, hrtimeBigint: () => 12345n });
  assert.equal(snap.parentPid, 99999);
  assert.equal(snap.parentStartTime, "12345");
});

test("writeParentLivenessFields: creates a fresh manifest with only our fields", async () => {
  const dir = tmpRunDir();
  await writeParentLivenessFields(dir, {
    parentPid: 1234,
    parentStartTime: "9999",
    parentBootId: "boot-abc",
  });
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(json, {
    parentPid: 1234,
    parentStartTime: "9999",
    parentBootId: "boot-abc",
  });
});

test("writeParentLivenessFields: merges over a slice-8a-written manifest, leaves their fields untouched", async () => {
  const dir = tmpRunDir();
  // Slice 8a writes first.
  await fs.writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      runId: "wf-abc",
      workflowName: "audit",
      input: "preserved",
    }),
  );
  // Slice 6 fills in parent-liveness.
  await writeParentLivenessFields(dir, {
    parentPid: 222,
    parentStartTime: "555",
    parentBootId: "",
  });
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(json.runId, "wf-abc");
  assert.equal(json.workflowName, "audit");
  assert.equal(json.input, "preserved");
  assert.equal(json.parentPid, 222);
  assert.equal(json.parentStartTime, "555");
  assert.equal(json.parentBootId, "");
});

test("writeParentLivenessFields: tolerates corrupt existing manifest by overwriting our fields only", async () => {
  const dir = tmpRunDir();
  await fs.writeFile(join(dir, "manifest.json"), "{not-valid-json");
  await writeParentLivenessFields(dir, {
    parentPid: 1,
    parentStartTime: "2",
    parentBootId: "3",
  });
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(json.parentPid, 1);
  assert.equal(json.parentStartTime, "2");
  assert.equal(json.parentBootId, "3");
});

test("writeParentLivenessFields: idempotent (call twice, second overwrites first)", async () => {
  const dir = tmpRunDir();
  await writeParentLivenessFields(dir, { parentPid: 1, parentStartTime: "1", parentBootId: "a" });
  await writeParentLivenessFields(dir, { parentPid: 2, parentStartTime: "2", parentBootId: "b" });
  const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(json.parentPid, 2);
  assert.equal(json.parentStartTime, "2");
  assert.equal(json.parentBootId, "b");
});
