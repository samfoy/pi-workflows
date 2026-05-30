/**
 * tests/integration/globalCache.test.ts
 *
 * Verifies that CacheStore.openGlobal enables cross-run agent result reuse.
 *
 * Strategy:
 *   1. Run hello.js with enableGlobalCache:true (run-1) — cold, dispatches mock agent.
 *   2. Run it again from a DIFFERENT runsRoot with enableGlobalCache:true (run-2).
 *      Same script → same global cache dir → global cache hit.
 *   3. Assert run-2's ledger has a log entry containing "[global cache hit]".
 *   4. Confirm that enableGlobalCache:false (run-3) skips global cache lookup.
 *   5. Confirm that a modified script (different sha256) misses the global cache.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startWorkflowRun } from "../../src/runManager.js";
import { sha256 } from "../../src/util/hash.js";
import { globalCachePath } from "../../src/util/paths.js";
import type { WorkflowFile } from "../../src/types/internal.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HELLO_SRC = join(PKG_ROOT, "examples/hello/hello.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "hello", absPath, scope: "personal" };
}

function buildFixtures(src: string, input: string): string {
  const prompt = `Say hello to ${input.trim() || "world"} in one sentence.`;
  return JSON.stringify({
    agentId: "greeter",
    promptHash: sha256(prompt),
    result: {
      text: "Hello, world!",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    },
  }) + "\n";
}

function makeRunsRoot() {
  return mkdtempSync(join(tmpdir(), "pi-wf-gctest-"));
}

/** Run hello.js with the given options; returns the Run handle (already settled). */
async function runHello(opts: {
  runsRoot: string;
  enableGlobalCache: boolean;
  src?: string;
}) {
  const src = opts.src ?? HELLO_SRC;
  const resolveRunDir = (id: string) => {
    const d = join(opts.runsRoot, id);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const run = await startWorkflowRun(makeWorkflow(src), "world", {
    preApproved: true,
    mockAgents: true,
    seedFixturesJsonl: buildFixtures(src, "world"),
    resolveRunDir,
    enableGlobalCache: opts.enableGlobalCache,
  });
  await run.promise;
  await run.terminated;
  return run;
}

/** Read all ledger entries for a run from its runDirAbs. */
function readLedger(runDirAbs: string): { type: string; level?: string; message?: string }[] {
  const path = join(runDirAbs, "ledger.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; level?: string; message?: string });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("globalCache: first run populates global cache, second run hits it", { timeout: 15_000 }, async () => {
  const root1 = makeRunsRoot();
  const root2 = makeRunsRoot();
  try {
    // Run 1 — cold start, warms global cache.
    const run1 = await runHello({ runsRoot: root1, enableGlobalCache: true });
    assert.equal(run1.runId.startsWith("wf-"), true, "run1 should have a valid id");

    // Verify global cache file was created.
    const scriptText = readFileSync(HELLO_SRC, "utf8");
    const scriptSha = sha256(scriptText);
    const gcPath = globalCachePath(scriptSha);
    assert.ok(existsSync(gcPath), `global cache file should exist at ${gcPath}`);

    // Run 2 — different runsRoot, same script → global cache hit.
    const run2 = await runHello({ runsRoot: root2, enableGlobalCache: true });

    // Run-2's ledger should contain at least one "[global cache hit]" log entry.
    const entries2 = readLedger(run2.runDirAbs);
    const globalHits = entries2.filter(
      (e) => e.type === "log" && typeof e.message === "string" && e.message.includes("[global cache hit]"),
    );
    assert.ok(
      globalHits.length >= 1,
      `expected >=1 global cache hit log in run-2 ledger; entries: ${JSON.stringify(entries2.map((e) => e.type + (e.message ? `:${e.message.slice(0, 40)}` : "")))}`,
    );
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("globalCache: disabled (enableGlobalCache=false) → no global cache hit", { timeout: 15_000 }, async () => {
  const root1 = makeRunsRoot();
  const root2 = makeRunsRoot();
  try {
    // Seed the global cache via run-1.
    await runHello({ runsRoot: root1, enableGlobalCache: true });

    // Run-2 with global cache OFF.
    const run2 = await runHello({ runsRoot: root2, enableGlobalCache: false });

    const entries2 = readLedger(run2.runDirAbs);
    const globalHits = entries2.filter(
      (e) => e.type === "log" && typeof e.message === "string" && e.message.includes("[global cache hit]"),
    );
    assert.equal(globalHits.length, 0, "no global cache hits when enableGlobalCache=false");
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("globalCache: modified script sha256 → cache miss (different directory)", { timeout: 15_000 }, async () => {
  const root1 = makeRunsRoot();
  const root2 = makeRunsRoot();
  const tmpWfDir = mkdtempSync(join(tmpdir(), "pi-wf-altscript-"));
  const altSrc = join(tmpWfDir, "hello-alt.js");
  try {
    // Write a slightly different workflow (different sha256).
    const original = readFileSync(HELLO_SRC, "utf8");
    // Append a unique marker so the sha256 is fresh on every test run —
    // ensures the global cache for this script is always cold at test start.
    const uniqueMarker = Math.random().toString(36).slice(2, 10);
    writeFileSync(altSrc, original + `\n// test-isolation-${uniqueMarker}\n`);

    // Seed global cache for ORIGINAL script.
    await runHello({ runsRoot: root1, enableGlobalCache: true });

    // Run MODIFIED script — different sha256, different global cache dir.
    const run2 = await runHello({ runsRoot: root2, enableGlobalCache: true, src: altSrc });

    const entries2 = readLedger(run2.runDirAbs);
    const globalHits = entries2.filter(
      (e) => e.type === "log" && typeof e.message === "string" && e.message.includes("[global cache hit]"),
    );
    assert.equal(
      globalHits.length,
      0,
      "changed script sha256 should not get global cache hits from prior version",
    );
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
    rmSync(tmpWfDir, { recursive: true, force: true });
  }
});
