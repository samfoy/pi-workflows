/**
 * tests/unit/trustStore.race.test.ts — slice 11 [C2].
 *
 * Carry-forward concern from slice 9 critic: atomic-rename guarantees
 * no torn write of `settings.json`, but two parallel `addTrust()` calls
 * have an unprotected read-modify-write window. Last writer wins; the
 * earlier row gets silently dropped.
 *
 * Witness:
 *
 *   Promise.all([addTrust({...A}), addTrust({...B})])
 *
 * Both must settle. After both settle, the file must contain BOTH rows
 * (under their respective absPath keys). Pre-fix this fails reliably
 * because A reads {} → A merges → writes {A}; B reads {} (or {A} if
 * lucky) → B merges → writes {B}. Final: only {B} is durable.
 *
 * Slice 11 fix: per-settings-file mutex (in-memory `Promise.resolve`
 * chain keyed on absolute path). The mutex is sufficient for the
 * single-process case, which is what slice 9's tests cover. Multi-
 * process file-locking is documented as a deferred concern (PRD §7
 * pin: "trust storage is single-process; cross-process is v2").
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTrust,
  loadTrust,
  projectSettingsPath,
} from "../../src/runtime/trustStore.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-wf-trust-race-"));
}

test("[C2] concurrent addTrust(): both rows persist after both promises settle", async () => {
  const cwd = tmp();
  const home = tmp();

  // Run 8 concurrent writers to the same file but distinct absPath
  // keys. Pre-fix, the read-modify-write race causes only the last
  // writer's row to land. Post-fix (mutex), every row is present.
  const N = 8;
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < N; i++) {
    ops.push(
      addTrust({
        cwd,
        home,
        absPath: `/abs/work-${i}.workflow.js`,
        name: `work-${i}`,
        sha256: `${i}`.padStart(64, "0"),
      }),
    );
  }
  const settled = await Promise.allSettled(ops);
  for (const r of settled) {
    assert.equal(r.status, "fulfilled", "every writer must settle without error");
  }

  // Reload and verify every row is present.
  const trust = await loadTrust({ cwd, home });
  for (let i = 0; i < N; i++) {
    const rows = trust[`/abs/work-${i}.workflow.js`];
    assert.ok(rows, `[C2] expected row for work-${i} to persist; got undefined`);
    assert.equal(rows!.length, 1);
    assert.equal(rows![0]!.name, `work-${i}`);
  }
});

test("[C2] concurrent addTrust to SAME absPath: both sha256 entries persist", async () => {
  const cwd = tmp();
  const home = tmp();
  const absPath = "/abs/same.workflow.js";

  // Two competing writers to the same absPath — the merge must
  // accumulate both `(name, sha256)` rows under the key. Pre-fix:
  // last-writer-wins drops the earlier row.
  const [r1, r2] = await Promise.all([
    addTrust({ cwd, home, absPath, name: "same", sha256: "a".repeat(64) }),
    addTrust({ cwd, home, absPath, name: "same", sha256: "b".repeat(64) }),
  ]);
  assert.equal(r1.scope, "project");
  assert.equal(r2.scope, "project");

  const trust = await loadTrust({ cwd, home });
  const rows = trust[absPath] ?? [];
  const shas = new Set(rows.map((r) => r.sha256));
  assert.ok(
    shas.has("a".repeat(64)),
    "[C2] expected sha=aaa... row to survive concurrent addTrust",
  );
  assert.ok(
    shas.has("b".repeat(64)),
    "[C2] expected sha=bbb... row to survive concurrent addTrust",
  );
  assert.equal(rows.length, 2, "expected exactly 2 rows for the shared absPath");
});

test("[C2] mutex serializes per-file: a settings.json file is never half-written across writers", async () => {
  // Validate the file is a parseable JSON document at every settle
  // point — atomic rename guarantees this PER-WRITER, but the mutex
  // must keep the file structurally sound between concurrent writers
  // (i.e. no overwrite hides earlier rows).
  const cwd = tmp();
  const home = tmp();
  const N = 12;
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < N; i++) {
    ops.push(
      addTrust({
        cwd,
        home,
        absPath: `/abs/x${i}.js`,
        name: `x${i}`,
        sha256: `${i}`.padStart(64, "f"),
      }),
    );
  }
  await Promise.all(ops);
  const raw = readFileSync(projectSettingsPath(cwd), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const trustKey = parsed["pi-workflows.trustedWorkflows"] as Record<string, unknown>;
  assert.equal(Object.keys(trustKey).length, N, "expected all N rows persisted");
});
