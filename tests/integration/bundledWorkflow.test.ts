/**
 * tests/integration/bundledWorkflow.test.ts — slice 17
 *
 * Runs the bundled `codebase-audit.js` workflow in mock-agents mode
 * against a fixture repo. Asserts:
 *
 *  - Run completes with status "done".
 *  - Final result has shape { runId, cwd, findingsConsidered, top10, report }.
 *  - Ledger has phase_start x4 + phase_end x4 + agent_start x7 + agent_end x7.
 *  - Cache holds "areas" + "findings" entries (set by workflow).
 *  - Running twice yields >=1 cache hit on analyze-* agents (second run).
 *  - User-modified codebase-audit.js is NOT overwritten by installBundledWorkflows.
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
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { startWorkflowRun } from "../../src/runManager.js";
import { sha256 } from "../../src/util/hash.js";
import {
  installBundledWorkflows,
  MANAGED_LEDGER_NAME,
} from "../../src/runtime/bundledWorkflows.js";
import type { WorkflowFile } from "../../src/types/internal.js";
import { LedgerReader } from "../../src/runtime/ledger.js";
import { CacheStore } from "../../src/runtime/cache.js";

// Absolute path to the bundled codebase-audit.js.
const PKG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CODEBASE_AUDIT_SRC = join(
  PKG_ROOT,
  "examples/codebase-audit/codebase-audit.js",
);
const FIXTURE_REPO = join(
  PKG_ROOT,
  "tests/fixtures/codebase-audit/repo",
);

// ─── Fixture data ─────────────────────────────────────────────────────────────

/** The areas the recon fixture will report. Must match prompts below. */
const AREAS = [
  { area: "auth", paths: ["src/auth.ts"], why: "auth boundary — MD5 + missing expiry" },
  { area: "data", paths: ["src/data.ts"], why: "data layer — unbounded in-memory cache" },
];

/** The findings the analyze fixtures will report, one per area. */
const FINDINGS_BY_AREA: Record<string, object[]> = {
  auth: [
    { title: "MD5 password hashing", severity: "high", path: "src/auth.ts", detail: "Line 8: createHash('md5') is not safe for passwords" },
    { title: "Token expiry not validated", severity: "high", path: "src/auth.ts", detail: "Line 3: verifyToken only checks token.length > 0" },
  ],
  data: [
    { title: "Unbounded cache growth", severity: "med", path: "src/data.ts", detail: "Line 3: in-memory Record grows without TTL or eviction" },
  ],
};

const ALL_FINDINGS = [
  ...FINDINGS_BY_AREA["auth"]!,
  ...FINDINGS_BY_AREA["data"]!,
];

/** Build the exact prompts the workflow will emit, so we can sha256 them. */
function buildPrompts(cwd: string) {
  const INPUT = "integration test";

  const reconPrompt =
    `Survey the repo at ${cwd}. Identify the 5\u20138 most important\n` +
    `      module/area boundaries. Output as a JSON array:\n` +
    `      [{"area": "...", "paths": ["..."], "why": "..."}].\n` +
    `      Focus on auth, data, IO boundaries, and anything mutating shared state.\n` +
    `      User context: "${INPUT}"`;

  const analyzePrompts = AREAS.map((area) => ({
    prompt:
      `Audit area "${area.area}" (paths: ${area.paths.join(", ")}). Look for:\n` +
      `      bugs, dead code, tech debt, missing tests, security smells, perf issues.\n` +
      `      Output 3\u20138 findings as JSON:\n` +
      `      [{"title": "...", "severity": "high|med|low", "path": "...", "detail": "..."}].\n` +
      `      Be specific; cite line numbers.`,
  }));

  const findingsJson = JSON.stringify(ALL_FINDINGS, null, 2);
  const votePrompt =
    `Below are ${ALL_FINDINGS.length} audit findings. Rank-order the TOP 10\n` +
    `      most critical for a code review. Consider severity, blast radius, fix\n` +
    `      difficulty. Return JSON:\n` +
    `      [{"rank": 1, "title": "...", "justification": "..."}, ...].\n` +
    `      Findings:\n${findingsJson}`;

  // For summarize: the workflow takes top10Detail — after Borda count the
  // top findings will be ALL_FINDINGS (scores: MD5=28+27+26, Expiry=27+26+25,
  // Unbounded=26+25+24 → top 3 ordered by score). We keep all 3 for simplicity.
  const top10 = ALL_FINDINGS;
  const summarizePrompt =
    `Write a 1-page audit report. Group these top findings by severity and\n` +
    `      area. Include actionable next steps. Be specific and reference paths.\n` +
    `      Top findings:\n${JSON.stringify(top10, null, 2)}`;

  return { reconPrompt, analyzePrompts, votePrompt, summarizePrompt };
}

/** Build a fixtures.jsonl string for the mock-agents branch. */
function buildFixtures(cwd: string): string {
  const { reconPrompt, analyzePrompts, votePrompt, summarizePrompt } =
    buildPrompts(cwd);

  const lines: string[] = [];

  // recon → returns the 2 areas as JSON
  lines.push(
    JSON.stringify({
      agentId: "recon",
      promptHash: sha256(reconPrompt),
      result: {
        text: JSON.stringify(AREAS),
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
      },
    }),
  );

  // analyze-0, analyze-1 → return findings per area
  AREAS.forEach((area, i) => {
    lines.push(
      JSON.stringify({
        agentId: `analyze-${i}`,
        promptHash: sha256(analyzePrompts[i]!.prompt),
        result: {
          text: JSON.stringify(FINDINGS_BY_AREA[area.area] ?? []),
          usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280 },
        },
      }),
    );
  });

  // voter-0, voter-1, voter-2 → each returns a Borda ranking
  // Rankings: rank 1=MD5(score 10+10+10=30), rank 2=Expiry(9+9+9=27), rank 3=Unbounded(8+8+8=24)
  const bordaRanking = JSON.stringify([
    { rank: 1, title: "MD5 password hashing", justification: "Critical security flaw" },
    { rank: 2, title: "Token expiry not validated", justification: "Auth bypass risk" },
    { rank: 3, title: "Unbounded cache growth", justification: "Memory leak in production" },
  ]);
  for (let i = 0; i < 3; i++) {
    lines.push(
      JSON.stringify({
        agentId: `voter-${i}`,
        promptHash: sha256(votePrompt),
        result: {
          text: bordaRanking,
          usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 400 },
        },
      }),
    );
  }

  // summarize → returns the final report
  lines.push(
    JSON.stringify({
      agentId: "summarize",
      promptHash: sha256(summarizePrompt),
      result: {
        text: "## Audit Report\n\n### High Severity\n- MD5 password hashing (src/auth.ts:8)\n- Token expiry not validated (src/auth.ts:3)\n\n### Medium Severity\n- Unbounded cache growth (src/data.ts:3)\n\n### Next Steps\n1. Replace MD5 with bcrypt\n2. Add JWT expiry validation\n3. Add TTL to cache entries",
        usage: { input: 400, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 600 },
      },
    }),
  );

  return lines.join("\n") + "\n";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpRun() {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-audit-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function makeWorkflow(): WorkflowFile {
  return { name: "codebase-audit", absPath: CODEBASE_AUDIT_SRC, scope: "personal" };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("bundled codebase-audit: runs end-to-end in mock-agents mode", async () => {
  const { runsRoot, resolveRunDir } = makeTmpRun();
  const cwd = FIXTURE_REPO;
  const fixtures = buildFixtures(cwd);

  const run = await startWorkflowRun(makeWorkflow(), "integration test", {
    mockAgents: true,
    preApproved: true,
    cwd,
    resolveRunDir,
    seedFixturesJsonl: fixtures,
    perRunAgentCap: 50,
  });

  // Wait for the workflow main() to resolve.
  const result = await run.promise as Record<string, unknown>;

  // Result shape
  assert.ok(result, "run should return a result");
  assert.equal(result.runId, run.runId);
  assert.equal(result.cwd, cwd);
  assert.equal(typeof result.findingsConsidered, "number");
  assert.ok((result.findingsConsidered as number) > 0, "findingsConsidered > 0");
  assert.ok(Array.isArray(result.top10), "top10 should be an array");
  assert.ok((result.top10 as unknown[]).length > 0, "top10 should be non-empty");
  assert.equal(typeof result.report, "string", "report should be a string");
  assert.ok((result.report as string).length > 0, "report should be non-empty");

  // Ledger entries: 4 phases × (start+end) + 7 agents × (start+end)
  const runDirAbs = run.runDirAbs;
  const reader = new LedgerReader({
    runId: result.runId as string,
    resolveLedgerPath: () => join(runDirAbs, "ledger.jsonl"),
  });
  const { entries } = await reader.read();

  const phaseStarts = entries.filter((e) => e.type === "phase_start");
  const phaseEnds   = entries.filter((e) => e.type === "phase_end");
  const agentStarts = entries.filter((e) => e.type === "agent_start");
  const agentEnds   = entries.filter((e) => e.type === "agent_end");

  assert.equal(phaseStarts.length, 4, `expected 4 phase_start, got ${phaseStarts.length}`);
  assert.equal(phaseEnds.length,   4, `expected 4 phase_end, got ${phaseEnds.length}`);
  // 1 recon + 2 analyze + 3 voters + 1 summarize = 7
  assert.equal(agentStarts.length, 7, `expected 7 agent_start, got ${agentStarts.length}`);
  assert.equal(agentEnds.length,   7, `expected 7 agent_end, got ${agentEnds.length}`);

  // Phase names
  const phaseNames = phaseStarts.map((e) => (e as Record<string, unknown>)["phaseName"]);
  assert.deepEqual(phaseNames, ["recon", "analyze", "vote", "summarize"]);

  // Cache entries set by workflow
  const cacheStore = await CacheStore.open({
    runId: run.runId,
    resolveCachePath: () => join(runDirAbs, "cache.jsonl"),
    resolveCacheTmpPath: () => join(runDirAbs, "cache.jsonl.tmp"),
  });
  const areas = cacheStore.getAuthorCache("areas");
  assert.ok(Array.isArray(areas), "cache 'areas' should be an array");
  const findings = cacheStore.getAuthorCache("findings");
  assert.ok(Array.isArray(findings), "cache 'findings' should be an array");
  assert.ok((findings as unknown[]).length > 0, "cache findings should be non-empty");
});

test("bundled codebase-audit: second run gets cache hits on analyze agents", async () => {
  const { resolveRunDir } = makeTmpRun();
  const cwd = FIXTURE_REPO;
  const fixtures = buildFixtures(cwd);
  const fixedRunId = "wf-cachemock0001";

  // First run — seeds the cache
  const run1 = await startWorkflowRun(makeWorkflow(), "integration test", {
    mockAgents: true,
    preApproved: true,
    cwd,
    resolveRunDir,
    seedFixturesJsonl: fixtures,
    perRunAgentCap: 50,
    newRunIdFactory: () => fixedRunId,
  });
  await run1.promise;
  assert.ok(run1, "first run should complete");

  // First run should have 0 cache hits.
  const reader1 = new LedgerReader({
    runId: fixedRunId,
    resolveLedgerPath: () => join(run1.runDirAbs, "ledger.jsonl"),
  });
  const { entries: entries1 } = await reader1.read();
  const cacheHits1 = entries1.filter((e) => e.type === "agent_cache_hit");
  assert.equal(cacheHits1.length, 0, "first run should have 0 cache hits");

  // Second run: reuse the SAME runDir (which has cache.jsonl from first run).
  // Force same runId via newRunIdFactory. CacheStore replays the existing
  // cache.jsonl and the analyze agents hit cache on the second pass.
  const run2 = await startWorkflowRun(makeWorkflow(), "integration test", {
    mockAgents: true,
    preApproved: true,
    cwd,
    resolveRunDir,  // same resolver → same dir → same cache.jsonl
    seedFixturesJsonl: fixtures,
    perRunAgentCap: 50,
    newRunIdFactory: () => fixedRunId,
  });
  await run2.promise;
  const reader2 = new LedgerReader({
    runId: fixedRunId,
    resolveLedgerPath: () => join(run2.runDirAbs, "ledger.jsonl"),
  });
  const { entries: entries2 } = await reader2.read();
  // The second run's ledger includes both runs' entries (same file, appended).
  // Count cache hits only from entries after the first run's terminal transition.
  const transitions = entries2.filter((e) => e.type === "transition");
  const firstRunEndIdx = entries2.indexOf(transitions[transitions.length - 2] ?? transitions[transitions.length - 1]!);
  const run2Entries = firstRunEndIdx >= 0 ? entries2.slice(firstRunEndIdx) : entries2;
  const cacheHits2 = run2Entries.filter((e) => e.type === "agent_cache_hit");
  assert.ok(cacheHits2.length >= 1, `second run should have >=1 cache hits, got ${cacheHits2.length} (run2 entries: ${run2Entries.length})`);
});

test("installBundledWorkflows: does NOT overwrite user-modified file", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-bundled-"));

  // Write a "user-modified" version of codebase-audit.js
  const destPath = join(tmpDir, "codebase-audit.js");
  const userContent = "// MY CUSTOM VERSION\nexport default async function main(ctx) { return 'custom'; }\n";
  writeFileSync(destPath, userContent, "utf8");

  // Do NOT write a managed-ledger entry — file is unknown provenance.
  const result = installBundledWorkflows(
    [{ destName: "codebase-audit.js", srcPath: CODEBASE_AUDIT_SRC }],
    tmpDir,
  );

  assert.equal(result.skippedUserModified.length, 1, "should skip user-modified file");
  assert.equal(result.installed.length, 0, "should NOT install over user-modified");
  assert.equal(result.upgraded.length, 0, "should NOT upgrade user-modified");

  // File content unchanged
  assert.equal(readFileSync(destPath, "utf8"), userContent);
});

test("installBundledWorkflows: installs when file absent", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-bundled-new-"));
  const destPath = join(tmpDir, "codebase-audit.js");

  assert.ok(!existsSync(destPath), "dest should not exist yet");

  const result = installBundledWorkflows(
    [{ destName: "codebase-audit.js", srcPath: CODEBASE_AUDIT_SRC }],
    tmpDir,
  );

  assert.equal(result.installed.length, 1, "should report as installed");
  assert.ok(existsSync(destPath), "dest file should now exist");
  assert.equal(result.skippedUserModified.length, 0);
  assert.equal(result.upgraded.length, 0);
  assert.equal(result.errors.length, 0);

  // Managed ledger should record the sha
  const ledger = join(tmpDir, MANAGED_LEDGER_NAME);
  assert.ok(existsSync(ledger), "managed ledger should be written");
});

test("installBundledWorkflows: upgrades managed file when content changes", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-bundled-upg-"));
  const destPath = join(tmpDir, "codebase-audit.js");

  // Simulate a previously-installed managed version with stale content.
  const oldContent = "// OLD MANAGED VERSION\n";
  const oldSha = sha256(oldContent);
  writeFileSync(destPath, oldContent, "utf8");
  // Write managed ledger recording the old sha.
  writeFileSync(
    join(tmpDir, MANAGED_LEDGER_NAME),
    JSON.stringify({ "codebase-audit.js": oldSha }, null, 2),
    "utf8",
  );

  const result = installBundledWorkflows(
    [{ destName: "codebase-audit.js", srcPath: CODEBASE_AUDIT_SRC }],
    tmpDir,
  );

  assert.equal(result.upgraded.length, 1, "should report as upgraded");
  assert.equal(result.installed.length, 0);
  assert.equal(result.skippedUserModified.length, 0);
  assert.equal(result.errors.length, 0);

  // Content should now match the bundled source.
  const installedContent = readFileSync(destPath, "utf8");
  const srcContent = readFileSync(CODEBASE_AUDIT_SRC, "utf8");
  assert.equal(installedContent, srcContent, "upgraded file should match bundled source");
});

test("installBundledWorkflows: idempotent on already-current file", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-bundled-idem-"));
  const destPath = join(tmpDir, "codebase-audit.js");
  const srcContent = readFileSync(CODEBASE_AUDIT_SRC, "utf8");

  // First install
  installBundledWorkflows(
    [{ destName: "codebase-audit.js", srcPath: CODEBASE_AUDIT_SRC }],
    tmpDir,
  );

  // Second install — same content
  const result2 = installBundledWorkflows(
    [{ destName: "codebase-audit.js", srcPath: CODEBASE_AUDIT_SRC }],
    tmpDir,
  );

  assert.equal(result2.alreadyCurrent.length, 1, "second install should be alreadyCurrent");
  assert.equal(result2.installed.length, 0);
  assert.equal(result2.upgraded.length, 0);
  assert.equal(result2.skippedUserModified.length, 0);
  // File content unchanged
  assert.equal(readFileSync(destPath, "utf8"), srcContent);
});
