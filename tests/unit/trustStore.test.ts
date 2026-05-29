/**
 * tests/unit/trustStore.test.ts — slice 9 trust-store I/O.
 *
 * Covers:
 *   - read of project-only / personal-only / merged trust stores
 *   - addTrust() atomic write to the right scope
 *   - scope detection (cwd/.pi/workflows vs ~/.pi/agent/workflows)
 *   - hash mismatch returns false (slice-2 revision adversarial-commit)
 *   - malformed JSON refused (no overwrite)
 *   - existing settings keys unrelated to ours preserved
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTrust,
  detectScope,
  isTrustedIn,
  loadTrust,
  TrustWriteError,
  projectSettingsPath,
  personalSettingsPath,
} from "../../src/runtime/trustStore.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-trust-"));
}

test("loadTrust: empty when no settings files exist", async () => {
  const cwd = tmp();
  const home = tmp();
  const trust = await loadTrust({ cwd, home });
  assert.deepEqual(trust, {});
});

test("loadTrust: reads project settings", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    projectSettingsPath(cwd),
    JSON.stringify({
      "pi-workflows.trustedWorkflows": {
        "/abs/foo.workflow.js": [{ name: "foo", sha256: "abc" }],
      },
    }),
  );
  const trust = await loadTrust({ cwd, home });
  assert.deepEqual(trust["/abs/foo.workflow.js"], [
    { name: "foo", sha256: "abc" },
  ]);
});

test("loadTrust: project rows win over personal on shared absPath", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    projectSettingsPath(cwd),
    JSON.stringify({
      "pi-workflows.trustedWorkflows": {
        "/abs/x": [{ name: "x", sha256: "PROJECT-HASH" }],
      },
    }),
  );
  writeFileSync(
    personalSettingsPath(home),
    JSON.stringify({
      "pi-workflows.trustedWorkflows": {
        "/abs/x": [{ name: "x", sha256: "PERSONAL-HASH" }],
      },
    }),
  );
  const trust = await loadTrust({ cwd, home });
  assert.equal(trust["/abs/x"]?.[0]?.sha256, "PROJECT-HASH");
});

test("loadTrust: malformed JSON returns empty (no crash)", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath(cwd), "not json {{{");
  const trust = await loadTrust({ cwd, home });
  assert.deepEqual(trust, {});
});

test("isTrustedIn: hash match returns true; mismatch returns false", () => {
  const trust = {
    "/abs/x": [{ name: "x", sha256: "abc" }],
  };
  assert.equal(isTrustedIn(trust, "/abs/x", "abc"), true);
  assert.equal(isTrustedIn(trust, "/abs/x", "DIFFERENT-HASH"), false);
  assert.equal(isTrustedIn(trust, "/abs/missing", "abc"), false);
});

test("addTrust: writes to project settings + atomic", async () => {
  const cwd = tmp();
  const home = tmp();
  const r = await addTrust({
    cwd,
    home,
    absPath: "/abs/x",
    name: "x",
    sha256: "h1",
    scope: "project",
  });
  assert.equal(r.scope, "project");
  const settings = JSON.parse(readFileSync(r.path, "utf-8"));
  assert.deepEqual(settings["pi-workflows.trustedWorkflows"], {
    "/abs/x": [{ name: "x", sha256: "h1" }],
  });
});

test("addTrust: appends row to existing absPath without losing prior hash", async () => {
  const cwd = tmp();
  const home = tmp();
  await addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h1", scope: "project" });
  await addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h2", scope: "project" });
  const trust = await loadTrust({ cwd, home });
  const rows = trust["/abs/x"];
  assert.ok(rows && rows.some((r) => r.sha256 === "h1"));
  assert.ok(rows && rows.some((r) => r.sha256 === "h2"));
});

test("addTrust: dedupes (name, sha256) pair", async () => {
  const cwd = tmp();
  const home = tmp();
  await addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h1", scope: "project" });
  await addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h1", scope: "project" });
  const trust = await loadTrust({ cwd, home });
  assert.equal(trust["/abs/x"]?.length, 1);
});

test("addTrust: preserves unrelated settings keys", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    projectSettingsPath(cwd),
    JSON.stringify({ "some.other.key": { value: 42 } }),
  );
  await addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h", scope: "project" });
  const settings = JSON.parse(readFileSync(projectSettingsPath(cwd), "utf-8"));
  assert.deepEqual(settings["some.other.key"], { value: 42 });
  assert.ok(settings["pi-workflows.trustedWorkflows"]["/abs/x"]);
});

test("addTrust: refuses to write malformed settings file", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath(cwd), "not json {{{");
  await assert.rejects(
    addTrust({ cwd, home, absPath: "/abs/x", name: "x", sha256: "h", scope: "project" }),
    (e: unknown) => e instanceof TrustWriteError && e.kind === "malformed",
  );
});

test("detectScope: matches personal when path is under ~/.pi/agent/workflows", () => {
  const home = "/home/test-user";
  const cwd = "/proj";
  assert.equal(
    detectScope({
      absPath: "/home/test-user/.pi/agent/workflows/foo.workflow.js",
      cwd,
      home,
    }),
    "personal",
  );
});

test("detectScope: defaults to project for tmp / unrelated paths", () => {
  const home = "/home/test-user";
  const cwd = "/proj";
  assert.equal(
    detectScope({ absPath: "/proj/.pi/workflows/foo.workflow.js", cwd, home }),
    "project",
  );
  assert.equal(
    detectScope({ absPath: "/tmp/abc/foo.workflow.js", cwd, home }),
    "project",
  );
});

test("addTrust: scope='personal' writes to ~/.pi/agent/settings.json", async () => {
  const cwd = tmp();
  const home = tmp();
  const r = await addTrust({
    cwd,
    home,
    absPath: join(home, ".pi", "agent", "workflows", "x.workflow.js"),
    name: "x",
    sha256: "h",
    scope: "personal",
  });
  assert.equal(r.scope, "personal");
  assert.ok(r.path.endsWith(join(".pi", "agent", "settings.json")));
});

// MUTATION-PROBE: this test fails if isTrustedIn drops the hash check
// and only verifies absPath presence. Slice 2 revision pinned that
// hash mismatch must always re-prompt (adversarial-commit defense).
test("MUTATION-PROBE: hash-mismatch must NOT trust (adversarial commit)", () => {
  const trust = {
    "/abs/x": [{ name: "x", sha256: "ORIGINAL-USER-APPROVED-HASH" }],
  };
  // Attacker pushed a `git commit` that mutated the file's bytes.
  // Trust store still has the OLD hash; the file is now serving a
  // NEW hash. isTrustedIn MUST refuse the new hash so the dialog re-fires.
  assert.equal(
    isTrustedIn(trust, "/abs/x", "POISONED-DIFFERENT-HASH"),
    false,
    "hash-mismatch must re-prompt or the adversarial-commit defense is broken",
  );
});
