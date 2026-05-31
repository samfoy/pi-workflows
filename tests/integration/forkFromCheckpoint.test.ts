/**
 * tests/integration/forkFromCheckpoint.test.ts — ZONE_TIMETRAVEL.
 *
 * Acceptance (per zone task spec):
 *   - 3-phase parent run completes successfully.
 *   - `forkFromCheckpoint(parentRunId, { atPhase: "p2", overrides })`
 *     mints a NEW run.
 *   (a) Original parent run is intact: ledger.jsonl + manifest.json
 *       unchanged after fork.
 *   (b) Phase-1 cache reused — the forked run's a1 has cached=true
 *       AND the forked ledger contains an `agent_cache_hit` for a1
 *       (NOT a fresh dispatch).
 *   (c) Phase-2 input is the override — the forked run's a2 dispatched
 *       against the override prompt, not the default.
 *   (d) Manifest of the forked run carries `parentRunId` + `forkAtPhase`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.js";
import {
  forkFromCheckpoint,
  FORK_OVERRIDES_KEY,
  ForkPhaseNotFoundError,
  ForkRunNotFoundError,
} from "../../src/runtime/forkRun.js";
import { sha256 } from "../../src/util/hash.js";

const FIXTURE_REL = "../fixtures/workflows/three-phase-fork.workflow.js";

function makeTmpRun(): { runsRoot: string; resolveRunDir: (id: string) => string } {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-fork-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function fixturesFor(prompts: { agentId: string; prompt: string; text: string }[]): string {
  return (
    prompts
      .map((p) =>
        JSON.stringify({
          agentId: p.agentId,
          promptHash: sha256(p.prompt),
          result: { text: p.text, usage: { input: 1, output: 1, totalTokens: 2 } },
        }),
      )
      .join("\n") + "\n"
  );
}

function makeWorkflow(absPath: string): WorkflowFile {
  return { name: "three-phase-fork", absPath, scope: "personal" };
}

function copyFixture(dstAbs: string): void {
  const src = new URL(FIXTURE_REL, import.meta.url).pathname;
  writeFileSync(dstAbs, readFileSync(src, "utf8"));
}

function readLedger(runDirAbs: string): Array<Record<string, unknown>> {
  const path = join(runDirAbs, "ledger.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test(
  "forkFromCheckpoint: 3-phase fork at p2 reuses phase-1 cache + applies override at phase-2",
  { timeout: 30_000 },
  async () => {
    const { runsRoot, resolveRunDir } = makeTmpRun();
    const wfPath = join(runsRoot, "three-phase-fork.workflow.js");
    copyFixture(wfPath);

    // ── Parent run ───────────────────────────────────────────────
    const parentSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1-DEFAULT-OUTPUT" },
      { agentId: "a2", prompt: "phase 2 default prompt", text: "P2-DEFAULT-OUTPUT" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3-DEFAULT-OUTPUT" },
    ]);

    const parent = await startWorkflowRun(makeWorkflow(wfPath), "go", {
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: parentSeed,
    });
    const parentResult = (await parent.promise) as {
      phase1: Array<{ text: string; cached: boolean }>;
      phase2: Array<{ text: string; cached: boolean }>;
      phase3: Array<{ text: string; cached: boolean }>;
      phase2Prompt: string;
    };
    await parent.terminated;

    assert.equal(parentResult.phase1[0]?.text, "P1-DEFAULT-OUTPUT");
    assert.equal(parentResult.phase2[0]?.text, "P2-DEFAULT-OUTPUT");
    assert.equal(parentResult.phase3[0]?.text, "P3-DEFAULT-OUTPUT");
    assert.equal(parentResult.phase2Prompt, "phase 2 default prompt");
    assert.equal(parentResult.phase1[0]?.cached, false);

    // Snapshot the parent's ledger + manifest BEFORE the fork so we
    // can assert later that the parent is intact.
    const parentLedgerBefore = readFileSync(
      join(parent.runDirAbs, "ledger.jsonl"),
      "utf8",
    );
    const parentManifestBefore = readFileSync(
      join(parent.runDirAbs, "manifest.json"),
      "utf8",
    );

    // ── Fork ──────────────────────────────────────────────────────
    const overridePrompt = "phase 2 OVERRIDE prompt from fork";
    // Fixtures the FORK needs:
    //   - a1 default: hits cache (already in parent's cache.jsonl) — no
    //     fresh dispatch, but we provide the fixture anyway as belt-and-
    //     braces for the (would-be wrong) miss path.
    //   - a2 OVERRIDE prompt: cache miss → dispatch.
    //   - a3 default: hits cache (already in parent's cache.jsonl).
    const forkSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1-FRESH-NEVER-USED" },
      { agentId: "a2", prompt: overridePrompt, text: "P2-OVERRIDE-OUTPUT" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3-FRESH-NEVER-USED" },
    ]);

    const fork = await forkFromCheckpoint(parent.runId, {
      atPhase: "p2",
      overrides: { phase2Prompt: overridePrompt },
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: forkSeed,
    });
    const forkResult = (await fork.promise) as typeof parentResult;
    await fork.terminated;

    assert.notEqual(fork.runId, parent.runId, "fork must mint a new runId");
    assert.equal(
      forkResult.phase2Prompt,
      overridePrompt,
      "(c) phase-2 prompt must be the override value",
    );
    assert.equal(
      forkResult.phase2[0]?.text,
      "P2-OVERRIDE-OUTPUT",
      "(c) phase-2 dispatched against the override prompt and got the override fixture",
    );

    // (b) phase-1 cache reused.
    assert.equal(
      forkResult.phase1[0]?.cached,
      true,
      "(b) phase-1 result in fork must be cached=true (cache hit from parent)",
    );
    assert.equal(
      forkResult.phase1[0]?.text,
      "P1-DEFAULT-OUTPUT",
      "(b) phase-1 cached text must be the parent's output, not the fresh fixture",
    );

    const forkLedger = readLedger(fork.runDirAbs);
    const a1CacheHit = forkLedger.some(
      (e) =>
        e.type === "agent_cache_hit" &&
        e.phaseName === "p1" &&
        e.agentId === "a1",
    );
    assert.ok(
      a1CacheHit,
      `(b) fork ledger must contain agent_cache_hit for a1 in p1; got types: ${forkLedger.map((e) => e.type).join(",")}`,
    );

    // (a) parent intact.
    const parentLedgerAfter = readFileSync(
      join(parent.runDirAbs, "ledger.jsonl"),
      "utf8",
    );
    const parentManifestAfter = readFileSync(
      join(parent.runDirAbs, "manifest.json"),
      "utf8",
    );
    assert.equal(
      parentLedgerAfter,
      parentLedgerBefore,
      "(a) parent ledger.jsonl must be byte-identical after fork",
    );
    assert.equal(
      parentManifestAfter,
      parentManifestBefore,
      "(a) parent manifest.json must be byte-identical after fork",
    );

    // (d) fork manifest carries lineage.
    const forkManifest = JSON.parse(
      readFileSync(join(fork.runDirAbs, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(
      forkManifest.parentRunId,
      parent.runId,
      "(d) fork manifest.parentRunId must point at the parent",
    );
    assert.equal(
      forkManifest.forkAtPhase,
      "p2",
      "(d) fork manifest.forkAtPhase must be 'p2'",
    );

    // Sanity: the forked run dir is distinct from the parent.
    assert.notEqual(
      fork.runDirAbs,
      parent.runDirAbs,
      "fork runDir must differ from parent runDir",
    );
    // Both ledgers should exist on disk.
    assert.ok(existsSync(join(fork.runDirAbs, "ledger.jsonl")));
    assert.ok(existsSync(join(parent.runDirAbs, "ledger.jsonl")));
  },
);

test("forkFromCheckpoint: rejects unknown parentRunId", async () => {
  await assert.rejects(
    () =>
      forkFromCheckpoint("wf-doesnotexist000", {
        atPhase: "p1",
        preApproved: true,
        mockAgents: true,
        resolveRunDir: (id) => join(tmpdir(), "nonexistent", id),
      }),
    (err: unknown) => err instanceof ForkRunNotFoundError,
  );
});

test("forkFromCheckpoint: rejects unknown atPhase", { timeout: 30_000 }, async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const wfPath = join(runsRoot, "three-phase-fork.workflow.js");
  copyFixture(wfPath);

  const seed = fixturesFor([
    { agentId: "a1", prompt: "phase 1 default prompt", text: "X" },
    { agentId: "a2", prompt: "phase 2 default prompt", text: "Y" },
    { agentId: "a3", prompt: "phase 3 default prompt", text: "Z" },
  ]);
  const parent = await startWorkflowRun(makeWorkflow(wfPath), "go", {
    preApproved: true,
    mockAgents: true,
    cwd: runsRoot,
    resolveRunDir,
    seedFixturesJsonl: seed,
  });
  await parent.promise;
  await parent.terminated;

  await assert.rejects(
    () =>
      forkFromCheckpoint(parent.runId, {
        atPhase: "no-such-phase",
        preApproved: true,
        mockAgents: true,
        cwd: runsRoot,
        resolveRunDir,
      }),
    (err: unknown) => {
      if (!(err instanceof ForkPhaseNotFoundError)) return false;
      // Ensure the available-phases list is informative.
      assert.deepEqual([...err.availablePhases].sort(), ["p1", "p2", "p3"]);
      return true;
    },
  );
});

test(
  "forkFromCheckpoint: overrides record stored under reserved cache key",
  { timeout: 30_000 },
  async () => {
    const { runsRoot, resolveRunDir } = makeTmpRun();
    const wfPath = join(runsRoot, "three-phase-fork.workflow.js");
    copyFixture(wfPath);

    const seed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "X" },
      { agentId: "a2", prompt: "phase 2 default prompt", text: "Y" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "Z" },
    ]);
    const parent = await startWorkflowRun(makeWorkflow(wfPath), "go", {
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: seed,
    });
    await parent.promise;
    await parent.terminated;

    const overrides = { phase2Prompt: "X", anyJsonShape: { nested: [1, 2, 3] } };
    const forkSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "X-FRESH" },
      { agentId: "a2", prompt: "X", text: "OVERRIDE-A2" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "Z-FRESH" },
    ]);

    const fork = await forkFromCheckpoint(parent.runId, {
      atPhase: "p2",
      overrides,
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: forkSeed,
    });
    await fork.promise;
    await fork.terminated;

    // Inspect the fork's cache.jsonl directly: it must contain an
    // author_cache record with key === FORK_OVERRIDES_KEY.
    const cacheRaw = readFileSync(
      join(fork.runDirAbs, "cache.jsonl"),
      "utf8",
    );
    const records = cacheRaw
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const overrideRecord = records.find(
      (r) => r.type === "author_cache" && r.key === FORK_OVERRIDES_KEY,
    );
    assert.ok(
      overrideRecord,
      `fork cache.jsonl must contain author_cache record under ${FORK_OVERRIDES_KEY}; got: ${JSON.stringify(records.map((r) => ({ type: r.type, key: r.key })))}`,
    );
    assert.deepEqual(
      overrideRecord!.value,
      overrides,
      "stored overrides must match what was passed",
    );
  },
);

test(
  "forkFromCheckpoint: strict cache filtering — post-fork phases re-dispatch (no silent parent cache hit)",
  { timeout: 30_000 },
  async () => {
    // ZONE_TIMETRAVEL strict filtering acceptance: when a post-fork
    // phase's prompt does NOT depend on `overrides`, it must re-
    // dispatch in the fork (not silently cache-hit the parent's
    // result). Without strict filtering, p3 in the fork would replay
    // the parent's output verbatim.
    const { runsRoot, resolveRunDir } = makeTmpRun();
    const wfPath = join(runsRoot, "three-phase-fork.workflow.js");
    copyFixture(wfPath);

    const parentSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1-PARENT" },
      { agentId: "a2", prompt: "phase 2 default prompt", text: "P2-PARENT" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3-PARENT" },
    ]);
    const parent = await startWorkflowRun(makeWorkflow(wfPath), "go", {
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: parentSeed,
    });
    await parent.promise;
    await parent.terminated;

    // Fork at p2 with NO overrides for p3's prompt. p3's prompt is
    // identical between parent and fork — same cacheKey — so without
    // strict filtering it would cache-hit and return P3-PARENT. With
    // strict filtering, the parent's p3 agent_result is excluded
    // from the fork's seeded cache, p3.a3 cache-misses, and the fork
    // dispatches against the FORK fixture (P3-FORK-FRESH).
    const forkSeed = fixturesFor([
      // p1.a1 — still expected to cache-hit (pre-fork phase).
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1-FORK-NEVER-USED" },
      // p2.a2 — cache miss either way (we don't pass overrides so
      // prompt is unchanged, but the parent's p2 result is filtered).
      { agentId: "a2", prompt: "phase 2 default prompt", text: "P2-FORK-FRESH" },
      // p3.a3 — the load-bearing assertion: must dispatch this fixture.
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3-FORK-FRESH" },
    ]);
    const fork = await forkFromCheckpoint(parent.runId, {
      atPhase: "p2",
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: forkSeed,
    });
    const forkResult = (await fork.promise) as {
      phase1: Array<{ text: string; cached: boolean }>;
      phase2: Array<{ text: string; cached: boolean }>;
      phase3: Array<{ text: string; cached: boolean }>;
    };
    await fork.terminated;

    // p1 still cache-hits.
    assert.equal(
      forkResult.phase1[0]?.text,
      "P1-PARENT",
      "p1 must cache-hit (parent's text)",
    );
    assert.equal(forkResult.phase1[0]?.cached, true, "p1 cached=true");

    // p2 re-dispatches (post-fork phase).
    assert.equal(
      forkResult.phase2[0]?.text,
      "P2-FORK-FRESH",
      "p2 must re-dispatch (post-fork phase) — not parent's P2-PARENT",
    );
    assert.equal(forkResult.phase2[0]?.cached, false, "p2 cached=false");

    // p3 re-dispatches — the strict-filtering assertion. Without it,
    // p3.cached would be true and p3.text would be P3-PARENT.
    assert.equal(
      forkResult.phase3[0]?.text,
      "P3-FORK-FRESH",
      "strict-filter: p3 must re-dispatch even though prompt is unchanged",
    );
    assert.equal(forkResult.phase3[0]?.cached, false, "strict-filter: p3 cached=false");

    // Read the fork's cache.jsonl pre-execution by checking that the
    // post-execution cache contains FRESH timestamps for p2 and p3,
    // i.e. the parent-era agent_result records were NOT inherited.
    // We can't read pre-execution; instead we verify by ledger: the
    // fork's ledger contains agent_start (i.e. real dispatch) for
    // a2@p2 and a3@p3, NOT agent_cache_hit.
    const forkLedger = readLedger(fork.runDirAbs);
    const startedA2P2 = forkLedger.some(
      (e) =>
        e.type === "agent_start" && e.phaseName === "p2" && e.agentId === "a2",
    );
    const startedA3P3 = forkLedger.some(
      (e) =>
        e.type === "agent_start" && e.phaseName === "p3" && e.agentId === "a3",
    );
    const cachedA3P3 = forkLedger.some(
      (e) =>
        e.type === "agent_cache_hit" &&
        e.phaseName === "p3" &&
        e.agentId === "a3",
    );
    assert.ok(startedA2P2, "fork ledger must show agent_start for p2.a2");
    assert.ok(startedA3P3, "fork ledger must show agent_start for p3.a3");
    assert.equal(cachedA3P3, false, "fork ledger must NOT show agent_cache_hit for p3.a3 (strict filter)");

    // Sanity: parent's p3 agent_result IS still on disk (parent intact).
    const parentCache = readFileSync(join(parent.runDirAbs, "cache.jsonl"), "utf8");
    assert.ok(
      parentCache.includes("P3-PARENT"),
      "parent's cache.jsonl must still contain P3-PARENT (parent intact)",
    );
  },
);
