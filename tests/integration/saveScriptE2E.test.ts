/**
 * tests/integration/saveScriptE2E.test.ts — end-to-end save-script.
 *
 * Drives the actual filesystem path: create a fake project root with
 * .git/.pi, write a script.js into a fake runDir, save with the
 * default IO + a scripted UI. Asserts the file landed at
 * `<projectRoot>/.pi/workflows/<name>.js` with mode 0o644.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSaveScriptIO,
  runSaveScript,
  type SaveScriptUI,
} from "../../src/runtime/saveScript.js";

function scripted(answers: ReadonlyArray<string>): SaveScriptUI {
  const queue = [...answers];
  return {
    async prompt(_msg, choices) {
      const next = queue.shift();
      if (next === undefined) throw new Error("unmocked prompt");
      if (!choices.includes(next))
        throw new Error(`mocked answer "${next}" not in choices ${choices}`);
      return next;
    },
  };
}

test("E2E save: writes to <projectRoot>/.pi/workflows/<name>.js with 0644", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-e2e-save-"));
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    const runDir = join(root, "runs", "wf-e2e01");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "script.js"), "// frozen content\n", "utf8");

    const outcome = await runSaveScript({
      runDirAbs: runDir,
      workflowName: "audit",
      workflowSourceAbsPath: "/home/me/.pi/agent/workflows/audit.js",
      cwd: root,
      io: defaultSaveScriptIO,
      ui: scripted([]), // .git absent → no git-add prompt; no collision
    });

    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") {
      const target = join(root, ".pi", "workflows", "audit.js");
      assert.equal(outcome.targetAbs, target);
      const contents = await readFile(target, "utf8");
      assert.equal(contents, "// frozen content\n");
      const st = await stat(target);
      // 0o644 (Linux). On macOS umask may flip group bits; assert at least 0644 user-readable.
      assert.equal(
        (st.mode & 0o777) & 0o644,
        0o644,
        `expected mode at least 0o644, got 0o${(st.mode & 0o777).toString(8)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
