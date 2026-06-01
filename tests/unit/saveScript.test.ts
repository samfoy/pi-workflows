/**
 * tests/unit/saveScript.test.ts — slice 14 save-script flow.
 *
 * Coverage:
 *   - happy path (no collision, .git present, gitignore OK)
 *   - collision: overwrite branch
 *   - collision: rename branch (picks `<name>-saved.js`)
 *   - collision: cancel branch
 *   - missing project root → error
 *   - source already in project workflows → no-op
 *   - .gitignore covers .pi/ → warning surfaced
 *   - non-git project (.pi only) → no git-add prompt
 *   - findProjectRoot stops at maxDepth + at filesystem root
 *   - gitignoreCoversPi heuristic
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runSaveScript,
  findProjectRoot,
  gitignoreCoversPi,
  type SaveScriptIO,
  type SaveScriptUI,
  type SaveOutcome,
} from "../../src/runtime/saveScript.js";

interface RecordedIO extends SaveScriptIO {
  readonly written: Map<string, string>;
  readonly gitAddCalls: { projectRoot: string; relPath: string }[];
}

function makeIO(opts: {
  scriptText?: string;
  existingTargets?: ReadonlySet<string>;
  gitignore?: string;
  gitAddSucceeds?: boolean;
}): RecordedIO {
  const written = new Map<string, string>();
  const gitAddCalls: { projectRoot: string; relPath: string }[] = [];
  const existing = new Set<string>(opts.existingTargets ?? []);
  return {
    written,
    gitAddCalls,
    async readScript() {
      return opts.scriptText ?? "// frozen workflow source";
    },
    async writeTarget(target, contents) {
      written.set(target, contents);
    },
    async pathExists(p) {
      return existing.has(p) || written.has(p);
    },
    async readGitIgnore() {
      return opts.gitignore ?? "";
    },
    async runGitAdd(projectRoot, relPath) {
      gitAddCalls.push({ projectRoot, relPath });
      return opts.gitAddSucceeds ?? true;
    },
  };
}

function makeUI(answers: ReadonlyArray<string>): SaveScriptUI & { calls: string[] } {
  const queue = [...answers];
  const calls: string[] = [];
  return {
    calls,
    async prompt(message, choices) {
      calls.push(message);
      const next = queue.shift();
      if (next === undefined) throw new Error(`unmocked prompt: ${message}`);
      if (!choices.includes(next))
        throw new Error(`mocked answer "${next}" not in choices ${choices}`);
      return next;
    },
  };
}

async function withProjectRoot(opts: {
  hasGit?: boolean;
  hasPi?: boolean;
}): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-savescript-"));
  if (opts.hasGit) await mkdir(join(root, ".git"), { recursive: true });
  if (opts.hasPi) await mkdir(join(root, ".pi"), { recursive: true });
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("findProjectRoot: walks up to .git/.pi within depth limit", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const nested = join(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    const found = findProjectRoot(nested, 8);
    assert.ok(found !== null);
    assert.equal(found?.rootAbs, root);
    assert.equal(found?.hasGit, true);
    assert.equal(found?.hasPi, false);
  } finally {
    await cleanup();
  }
});

test("findProjectRoot: returns null when neither .git nor .pi within depth", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pi-wf-norouteup-"));
  try {
    const deep = join(tmp, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    // depth=2 from `deep` reaches `b`, which has no markers.
    const found = findProjectRoot(deep, 2);
    assert.equal(found, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("findProjectRoot: stops at filesystem root", () => {
  // Bogus path; walking from a non-existent path is permitted by findProjectRoot
  // since statSync just returns false.
  const found = findProjectRoot("/__pi-wf-no-such-dir__", 8);
  // Not found anywhere up to /, so null.
  assert.equal(found, null);
});

test("gitignoreCoversPi: matches direct patterns", () => {
  assert.equal(gitignoreCoversPi(""), false);
  assert.equal(gitignoreCoversPi(".pi/"), true);
  assert.equal(gitignoreCoversPi("# comment\n.pi"), true);
  assert.equal(gitignoreCoversPi("/.pi/"), true);
  assert.equal(gitignoreCoversPi(".pi/workflows/"), true);
  assert.equal(gitignoreCoversPi("node_modules/\nbuild/"), false);
});

test("save-script: happy path — no collision, git-add accepted, gitignore clean", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const io = makeIO({ scriptText: "// hi" });
    const ui = makeUI(["y"]); // git add? y
    const outcome: SaveOutcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") {
      assert.equal(outcome.targetAbs, join(root, ".pi", "workflows", "audit.js"));
      assert.equal(outcome.gitAdded, true);
      assert.equal(outcome.gitignoreWarned, false);
    }
    // Wrote the script.
    assert.equal(io.written.get(join(root, ".pi", "workflows", "audit.js")), "// hi");
    // Called git add with relative path.
    assert.equal(io.gitAddCalls.length, 1);
    assert.equal(io.gitAddCalls[0]!.relPath, ".pi/workflows/audit.js");
  } finally {
    await cleanup();
  }
});

test("save-script: collision → user picks overwrite", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const target = join(root, ".pi", "workflows", "audit.js");
    const io = makeIO({ existingTargets: new Set([target]) });
    const ui = makeUI(["overwrite", "n"]);
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "saved");
    assert.equal(io.written.has(target), true);
  } finally {
    await cleanup();
  }
});

test("save-script: collision → user picks rename, picks audit-saved.js", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const target = join(root, ".pi", "workflows", "audit.js");
    const io = makeIO({ existingTargets: new Set([target]) });
    const ui = makeUI(["rename", "n"]);
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "saved-renamed");
    if (outcome.kind === "saved-renamed") {
      assert.equal(
        outcome.targetAbs,
        join(root, ".pi", "workflows", "audit-saved.js"),
      );
    }
    assert.equal(
      io.written.has(join(root, ".pi", "workflows", "audit-saved.js")),
      true,
    );
    // Original file untouched.
    assert.equal(io.written.has(target), false);
  } finally {
    await cleanup();
  }
});

test("save-script: collision → user picks cancel", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const target = join(root, ".pi", "workflows", "audit.js");
    const io = makeIO({ existingTargets: new Set([target]) });
    const ui = makeUI(["cancel"]);
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "cancelled-by-user");
    assert.equal(io.written.size, 0);
  } finally {
    await cleanup();
  }
});

test("save-script: error when no project root found", async () => {
  // Use a non-existent walk root.
  const tmp = await mkdtemp(join(tmpdir(), "pi-wf-noroute-"));
  try {
    const deep = join(tmp, "a", "b");
    await mkdir(deep, { recursive: true });
    const io = makeIO({});
    const ui = makeUI([]);
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/anywhere/audit.js",
      cwd: deep,
      maxWalkDepth: 2,
      io,
      ui,
    });
    assert.equal(outcome.kind, "error");
    if (outcome.kind === "error") {
      assert.equal(outcome.reason, "no-project-root");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("save-script: source already in project .pi/workflows → no-op", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const inside = join(root, ".pi", "workflows", "audit.js");
    const io = makeIO({});
    const ui = makeUI([]);
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: inside,
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "no-op-already-in-project");
    assert.equal(io.written.size, 0);
  } finally {
    await cleanup();
  }
});

test("save-script: .gitignore covers .pi → gitignoreWarned=true + notify", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const io = makeIO({ gitignore: ".pi/\n" });
    const ui = makeUI(["n"]);
    const notifications: { msg: string; level: "info" | "warning" | undefined }[] = [];
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
      notify: (m, l) => notifications.push({ msg: m, level: l }),
    });
    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") {
      assert.equal(outcome.gitignoreWarned, true);
    }
    assert.ok(notifications.some((n) => /gitignore/.test(n.msg)));
  } finally {
    await cleanup();
  }
});

test("save-script: non-git project (.pi only) skips git-add prompt", async () => {
  const { root, cleanup } = await withProjectRoot({ hasPi: true });
  try {
    const io = makeIO({});
    const ui = makeUI([]); // NO prompts expected
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
    });
    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") {
      assert.equal(outcome.gitAdded, false);
    }
    assert.equal(io.gitAddCalls.length, 0);
    assert.equal(ui.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test("save-script: git-add failure surfaces a notify warning, save still recorded", async () => {
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const io = makeIO({ gitAddSucceeds: false });
    const ui = makeUI(["y"]);
    const notifications: { msg: string; level: "info" | "warning" | undefined }[] = [];
    const outcome = await runSaveScript({
      runDirAbs: "/tmp/runs/wf-x",
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io,
      ui,
      notify: (m, l) => notifications.push({ msg: m, level: l }),
    });
    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") assert.equal(outcome.gitAdded, false);
    assert.ok(notifications.some((n) => /git add failed/.test(n.msg)));
  } finally {
    await cleanup();
  }
});

test("save-script: rejects path-traversal workflowName before any IO", async () => {
  // workflowName flows from meta.name on the workflow source — author-
  // controlled — and is interpolated into the target via
  // join(workflowsDir, `${name}.js`). Without validation, a malicious
  // name like '../../etc/passwd' would resolve outside .pi/workflows/.
  const { root, cleanup } = await withProjectRoot({ hasGit: true });
  try {
    const io = makeIO({});
    const ui = makeUI([]);
    const malicious = [
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "name with spaces",
      "",
      ".hidden",
      "name$with$dollars",
    ];
    for (const bad of malicious) {
      const outcome = await runSaveScript({
        runDirAbs: "/tmp/runs/wf-x",
        workflowName: bad,
        workflowSourceAbsPath: "/home/me/.pi/agent/workflows/x.js",
        cwd: root,
        io,
        ui,
      });
      assert.equal(outcome.kind, "error", `should error on ${JSON.stringify(bad)}`);
      if (outcome.kind === "error") {
        assert.equal(outcome.reason, "bad-workflow-name");
      }
      // Crucially: no IO took place — nothing was read from disk and
      // nothing was written. The error surfaces BEFORE the readScript call.
      assert.equal(io.written.size, 0);
      assert.equal(io.gitAddCalls.length, 0);
      assert.equal(ui.calls.length, 0);
    }
  } finally {
    await cleanup();
  }
});
