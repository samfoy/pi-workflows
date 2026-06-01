/**
 * tests/unit/bundledWorkflows.test.ts — slice 17 unit suite.
 *
 * Coverage of the install/upgrade matrix that the integration test
 * doesn't exercise cheaply:
 *
 *   - first install: file written + ledger updated
 *   - already-current: no-op (no rewrite, file mtime preserved)
 *   - upgrade: existing matches prior managed sha → rewrite
 *   - skip user-modified: existing matches NOTHING in ledger
 *   - skip user-modified: existing matches a different prior sha
 *   - mkdir failure short-circuits with an <mkdir> error entry
 *   - read-source failure surfaces per-workflow error
 *   - corrupt managed ledger JSON is treated as empty
 *   - empty workflows array short-circuits before mkdir
 *
 * The integration test (tests/integration/bundledWorkflow.test.ts)
 * exercises end-to-end startWorkflowRun + ledger replay — these unit
 * tests probe the installer's branching directly so failures are
 * localized.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  installBundledWorkflows,
  MANAGED_LEDGER_NAME,
  type BundledWorkflow,
} from "../../src/runtime/bundledWorkflows.js";

function tmpRoot(prefix = "pi-wf-bundled-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeSrc(root: string, name: string, contents: string): string {
  const p = join(root, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

function readLedger(workflowsDir: string): Record<string, string> {
  const p = join(workflowsDir, MANAGED_LEDGER_NAME);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
}

// ─── 1. First install ────────────────────────────────────────────────

test("installBundledWorkflows: first install writes file + records sha in ledger", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  const src = makeSrc(srcRoot, "codebase-audit.js", `// hello\n`);
  const wfs: BundledWorkflow[] = [{ destName: "codebase-audit.js", srcPath: src }];
  const result = installBundledWorkflows(wfs, dstRoot);
  assert.deepEqual(result.installed, ["codebase-audit.js"]);
  assert.deepEqual(result.upgraded, []);
  assert.deepEqual(result.errors, []);
  assert.equal(
    readFileSync(join(dstRoot, "codebase-audit.js"), "utf8"),
    "// hello\n",
  );
  const ledger = readLedger(dstRoot);
  assert.equal(ledger["codebase-audit.js"], sha256("// hello\n"));
});

// ─── 2. Already-current ──────────────────────────────────────────────

test("installBundledWorkflows: identical source is a no-op (already current)", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  const src = makeSrc(srcRoot, "deep-research.js", `// v1\n`);
  const wfs: BundledWorkflow[] = [{ destName: "deep-research.js", srcPath: src }];
  installBundledWorkflows(wfs, dstRoot);
  const dst = join(dstRoot, "deep-research.js");
  const mtimeBefore = statSync(dst).mtimeMs;
  // Run again — should fall in alreadyCurrent path, no rewrite.
  const result2 = installBundledWorkflows(wfs, dstRoot);
  assert.deepEqual(result2.alreadyCurrent, ["deep-research.js"]);
  assert.deepEqual(result2.installed, []);
  assert.deepEqual(result2.upgraded, []);
  // mtime unchanged → confirms no rewrite happened.
  // (filesystems may have low-res mtime; we use >=, but no rewrite means equal)
  assert.equal(statSync(dst).mtimeMs, mtimeBefore);
});

// ─── 3. Upgrade (managed + not user-modified) ────────────────────────

test("installBundledWorkflows: upgrade overwrites when existing sha matches prior managed sha", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  // First, install v1.
  const src = makeSrc(srcRoot, "x.js", `// v1\n`);
  installBundledWorkflows([{ destName: "x.js", srcPath: src }], dstRoot);
  // Now point the source at v2 — same destName.
  writeFileSync(src, `// v2-upgraded\n`, "utf8");
  const result = installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
  );
  assert.deepEqual(result.upgraded, ["x.js"]);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skippedUserModified, []);
  assert.equal(readFileSync(join(dstRoot, "x.js"), "utf8"), "// v2-upgraded\n");
  // Ledger now reflects the new sha.
  assert.equal(readLedger(dstRoot)["x.js"], sha256("// v2-upgraded\n"));
});

// ─── 4. Skip user-modified (no ledger entry) ─────────────────────────

test("installBundledWorkflows: skips file with no ledger entry (user-authored, never managed)", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  // The user already has the file from somewhere else — no ledger entry.
  writeFileSync(join(dstRoot, "x.js"), `// user-authored\n`, "utf8");
  const src = makeSrc(srcRoot, "x.js", `// bundled\n`);
  const result = installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
  );
  assert.deepEqual(result.skippedUserModified, ["x.js"]);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.upgraded, []);
  // File NOT overwritten.
  assert.equal(readFileSync(join(dstRoot, "x.js"), "utf8"), "// user-authored\n");
});

// ─── 5. Skip user-modified (ledger entry but sha mismatch) ───────────

test("installBundledWorkflows: skips when existing sha differs from BOTH new + ledger entry", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  // Install v1.
  const src = makeSrc(srcRoot, "x.js", `// v1\n`);
  installBundledWorkflows([{ destName: "x.js", srcPath: src }], dstRoot);
  // User edits the file (now its sha differs from the ledger entry).
  writeFileSync(join(dstRoot, "x.js"), `// user-edited\n`, "utf8");
  // New bundle ships v2.
  writeFileSync(src, `// v2\n`, "utf8");
  const result = installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
  );
  assert.deepEqual(result.skippedUserModified, ["x.js"]);
  assert.deepEqual(result.upgraded, []);
  // User edit preserved.
  assert.equal(readFileSync(join(dstRoot, "x.js"), "utf8"), "// user-edited\n");
});

// ─── 6. mkdir failure short-circuits ─────────────────────────────────

test("installBundledWorkflows: mkdir failure surfaces as <mkdir> error and short-circuits", () => {
  const dstRoot = tmpRoot("bundled-dst-");
  // Make the parent unwritable so mkdir of a nested path fails.
  chmodSync(dstRoot, 0o400);
  try {
    const result = installBundledWorkflows(
      [{ destName: "x.js", srcPath: "/nonexistent.js" }],
      join(dstRoot, "child"),
    );
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.name, "<mkdir>");
    assert.deepEqual(result.installed, []);
  } finally {
    chmodSync(dstRoot, 0o700);
  }
});

// ─── 7. Read-source failure → per-workflow error ─────────────────────

test("installBundledWorkflows: missing src file surfaces a per-workflow error, others continue", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  // First workflow: source missing. Second: present.
  const goodSrc = makeSrc(srcRoot, "good.js", `// good\n`);
  const result = installBundledWorkflows(
    [
      { destName: "missing.js", srcPath: join(srcRoot, "doesnotexist.js") },
      { destName: "good.js", srcPath: goodSrc },
    ],
    dstRoot,
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.name, "missing.js");
  // The good one still installed.
  assert.deepEqual(result.installed, ["good.js"]);
});

// ─── 8. Corrupt ledger treated as empty ──────────────────────────────

test("installBundledWorkflows: corrupt managed ledger JSON is tolerated (treated as empty)", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  // Plant a corrupt ledger.
  writeFileSync(join(dstRoot, MANAGED_LEDGER_NAME), `{ not valid json,,,`, "utf8");
  const src = makeSrc(srcRoot, "x.js", `// fresh\n`);
  const result = installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
  );
  // Treats corrupt-ledger-as-empty → first install path.
  assert.deepEqual(result.installed, ["x.js"]);
  assert.deepEqual(result.errors, []);
  // Ledger now overwritten with valid content.
  const ledger = readLedger(dstRoot);
  assert.equal(ledger["x.js"], sha256("// fresh\n"));
});

// ─── 9. Empty workflows array short-circuits ─────────────────────────

test("installBundledWorkflows: empty workflows array returns no-op result without mkdir", () => {
  const dstRoot = tmpRoot("bundled-dst-");
  // dstRoot doesn't exist as a workflows dir yet — tracking that mkdir is skipped.
  // Use a non-existent subpath so we'd ENOENT if mkdir+write actually ran.
  const nonexistent = join(dstRoot, "definitely-not-here");
  const result = installBundledWorkflows([], nonexistent);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.upgraded, []);
  assert.deepEqual(result.skippedUserModified, []);
  assert.deepEqual(result.alreadyCurrent, []);
  assert.deepEqual(result.errors, []);
  // mkdir was skipped (the audit's specific concern).
  assert.equal(existsSync(nonexistent), false);
});

// ─── 10. log callback fires on writes (not on alreadyCurrent) ───────

test("installBundledWorkflows: opts.log fires for installs/upgrades, NOT for already-current", () => {
  const srcRoot = tmpRoot("bundled-src-");
  const dstRoot = tmpRoot("bundled-dst-");
  const src = makeSrc(srcRoot, "x.js", `// v1\n`);
  const logs: string[] = [];
  // First call: install + log.
  installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
    { log: (m) => logs.push(m) },
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /installed.*x\.js/);
  // Second call (same source): alreadyCurrent → no log.
  logs.length = 0;
  installBundledWorkflows(
    [{ destName: "x.js", srcPath: src }],
    dstRoot,
    { log: (m) => logs.push(m) },
  );
  assert.deepEqual(logs, []);
});
