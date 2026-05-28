/**
 * tests/unit/registry.test.ts — workflow file discovery rules.
 *
 * Acceptance per `plan.md` §4 Slice 1:
 *   - project-wins-over-personal collision
 *   - reserved-name skip with warning
 *   - bad-filename skip
 *   - hidden-file silent skip
 *   - non-`.js` rejection
 *   - ≥6 named test cases
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RESERVED_NAMES,
  classifyFilename,
  discoverWorkflows,
} from "../../src/registry.ts";

function makeRoots(): { root: string; project: string; personal: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
  const project = join(root, "project", ".pi", "workflows");
  const personal = join(root, "personal", ".pi", "agent", "workflows");
  mkdirSync(project, { recursive: true });
  mkdirSync(personal, { recursive: true });
  return {
    root,
    project,
    personal,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("registry: discovers a single project workflow", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(project, "foo.js"), "export default async () => {};");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/anything", // overridden by projectDir
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 1);
    const foo = registry.get("foo");
    assert.ok(foo, "foo should be registered");
    assert.equal(foo!.name, "foo");
    assert.equal(foo!.scope, "project");
    assert.equal(foo!.absPath, join(project, "foo.js"));
    assert.deepEqual(errors, []);
  } finally {
    cleanup();
  }
});

test("registry: project workflow wins over personal on collision", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(personal, "shared.js"), "// personal version");
    writeFileSync(join(project, "shared.js"), "// project version");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });

    // Only one entry — the project one — wins.
    assert.equal(registry.size, 1);
    const shared = registry.get("shared")!;
    assert.equal(shared.scope, "project");
    assert.equal(shared.absPath, join(project, "shared.js"));

    // The personal copy is recorded as "shadowed" so the user can be
    // told via pi.notify that their personal workflow is hidden.
    const shadowErr = errors.find((e) => e.reason === "name-collision-shadowed");
    assert.ok(shadowErr, "expected a name-collision-shadowed error");
    assert.equal(shadowErr!.absPath, join(personal, "shared.js"));
  } finally {
    cleanup();
  }
});

test("registry: personal-only workflows are visible when no project shadow exists", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(personal, "mine.js"), "// personal");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 1);
    const mine = registry.get("mine")!;
    assert.equal(mine.scope, "personal");
    assert.deepEqual(errors, []);
  } finally {
    cleanup();
  }
});

test("registry: reserved name (workflows) is skipped with a warning", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    // The umbrella name is reserved. A user-authored "workflows.js"
    // must NOT shadow the built-in /workflows handler.
    writeFileSync(join(project, "workflows.js"), "// nope");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.reason, "reserved-name");
    assert.match(errors[0]!.message, /reserved name: workflows/);
  } finally {
    cleanup();
  }
});

test("registry: non-js extensions are rejected with non-js-extension reason", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(project, "foo.ts"), "// nope");
    writeFileSync(join(project, "foo.mjs"), "// nope");
    writeFileSync(join(project, "foo.txt"), "// nope");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 0);
    // We expect three skip records.
    assert.equal(errors.length, 3);
    for (const err of errors) {
      assert.equal(err.reason, "non-js-extension");
    }
  } finally {
    cleanup();
  }
});

test("registry: hidden files are skipped silently (no warning)", () => {
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(project, ".secret.js"), "// hidden");
    writeFileSync(join(project, ".DS_Store"), "");
    writeFileSync(join(project, "ok.js"), "// visible");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 1);
    assert.ok(registry.get("ok"), "ok.js should be registered");
    // No hidden-file error surfaces.
    assert.deepEqual(errors, []);
  } finally {
    cleanup();
  }
});

test("registry: bad filenames (whitespace, '..') are rejected", () => {
  // We can't actually create a filename containing '/' or '\\' on
  // typical filesystems, but `classifyFilename` runs as a pure
  // function — exercise it directly. For real-fs whitespace, we can
  // create that.
  const reserved = RESERVED_NAMES;

  // Pure tests
  assert.deepEqual(
    classifyFilename("with space.js", reserved),
    { reason: "bad-filename", message: "filename has illegal characters: with space.js" },
  );
  assert.deepEqual(
    classifyFilename("foo..bar.js", reserved),
    { reason: "bad-filename", message: "filename has illegal characters: foo..bar.js" },
  );
  assert.deepEqual(
    classifyFilename("foo$.js", reserved),
    { reason: "bad-filename", message: "unsupported character in name: foo$.js" },
  );
  assert.deepEqual(
    classifyFilename(".js", reserved),
    { reason: "bad-filename", message: "hidden file: .js" },
  );

  // Live-fs whitespace test
  const { project, personal, cleanup } = makeRoots();
  try {
    writeFileSync(join(project, "has space.js"), "// nope");
    writeFileSync(join(project, "ok.js"), "// good");
    const { registry, errors } = discoverWorkflows({
      cwd: "/tmp/x",
      projectDir: project,
      personalDir: personal,
    });
    assert.equal(registry.size, 1);
    assert.ok(registry.get("ok"));
    const err = errors.find((e) => e.absPath.endsWith("has space.js"));
    assert.ok(err, "expected a bad-filename error for the space file");
    assert.equal(err!.reason, "bad-filename");
  } finally {
    cleanup();
  }
});

test("registry: classifyFilename accepts a normal name", () => {
  const r = classifyFilename("codebase-audit.js", RESERVED_NAMES);
  assert.deepEqual(r, { name: "codebase-audit" });
});

test("registry: classifyFilename rejects every reserved name", () => {
  for (const name of RESERVED_NAMES) {
    const r = classifyFilename(`${name}.js`, RESERVED_NAMES);
    assert.ok(
      "reason" in r && r.reason === "reserved-name",
      `expected ${name} to be reserved, got ${JSON.stringify(r)}`,
    );
  }
});

test("registry: missing root directories return empty registry without error", () => {
  // Both dirs nonexistent — the discoverWorkflows must not crash.
  const { registry, errors } = discoverWorkflows({
    cwd: "/tmp/x",
    projectDir: "/nonexistent/project/.pi/workflows",
    personalDir: "/nonexistent/personal/.pi/agent/workflows",
  });
  assert.equal(registry.size, 0);
  assert.deepEqual(errors, []);
});
