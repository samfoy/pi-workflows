/**
 * tests/unit/visualize.test.ts — gap/viz Mermaid DAG renderer.
 *
 * Coverage:
 *   - renderMermaidFromData: pure transform on a manifest + entries
 *   - phases render as subgraphs with labels (durations, ok/err counts)
 *   - agents render with status + duration
 *   - missing manifest → renders with default Start label
 *   - missing/empty ledger → "no phases" diagram
 *   - phase that started but never ended → labelled "running"
 *   - agent_error → status=error
 *   - agent_cache_hit → status=cache-hit
 *   - control chars / quotes in labels are escaped
 *   - renderMermaid (async) reads off disk via tmpdir fixture
 *   - renderMermaidSync reads off disk synchronously
 *   - writeMermaidToTmp produces a `.mmd` file under tmpdir
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderMermaidFromData,
  renderMermaid,
  renderMermaidSync,
  writeMermaidToTmp,
} from "../../src/runtime/visualize.ts";
import type { LedgerEntry } from "../../src/types/internal.d.ts";

function makeRunDir(): { root: string; runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-viz-"));
  const runDir = join(root, "wf-fixturefull");
  mkdirSync(runDir, { recursive: true });
  return {
    root,
    runDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const SAMPLE_ENTRIES: LedgerEntry[] = [
  {
    type: "init",
    at: "2026-05-28T14:30:12.345Z",
    manifest: { runId: "wf-fixturefull", workflowName: "codebase-audit" },
  },
  {
    type: "transition",
    at: "2026-05-28T14:30:12.500Z",
    from: "pending",
    to: "approved",
  },
  {
    type: "transition",
    at: "2026-05-28T14:30:12.600Z",
    from: "approved",
    to: "running",
  },
  {
    type: "phase_start",
    at: "2026-05-28T14:30:13.000Z",
    phaseName: "discover",
    agentCount: 3,
  },
  {
    type: "agent_start",
    at: "2026-05-28T14:30:13.010Z",
    phaseName: "discover",
    agentId: "discover-1",
    promptHash: "abc",
  },
  {
    type: "agent_start",
    at: "2026-05-28T14:30:13.011Z",
    phaseName: "discover",
    agentId: "discover-2",
    promptHash: "def",
  },
  {
    type: "agent_start",
    at: "2026-05-28T14:30:13.012Z",
    phaseName: "discover",
    agentId: "discover-3",
    promptHash: "789",
  },
  {
    type: "agent_end",
    at: "2026-05-28T14:30:18.000Z",
    phaseName: "discover",
    agentId: "discover-1",
    durationMs: 4990,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cached: false,
  },
  {
    type: "agent_end",
    at: "2026-05-28T14:30:19.000Z",
    phaseName: "discover",
    agentId: "discover-2",
    durationMs: 5989,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cached: false,
  },
  {
    type: "agent_end",
    at: "2026-05-28T14:30:20.000Z",
    phaseName: "discover",
    agentId: "discover-3",
    durationMs: 6988,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cached: false,
  },
  {
    type: "phase_end",
    at: "2026-05-28T14:30:20.100Z",
    phaseName: "discover",
    durationMs: 7100,
    agentResults: { ok: 3, error: 0, cacheHit: 0 },
  },
  {
    type: "phase_start",
    at: "2026-05-28T14:30:20.200Z",
    phaseName: "audit",
    agentCount: 1,
  },
  {
    type: "agent_start",
    at: "2026-05-28T14:30:20.210Z",
    phaseName: "audit",
    agentId: "audit-1",
    promptHash: "deadbeef",
  },
  {
    type: "agent_end",
    at: "2026-05-28T14:30:30.000Z",
    phaseName: "audit",
    agentId: "audit-1",
    durationMs: 9790,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cached: false,
  },
  {
    type: "phase_end",
    at: "2026-05-28T14:30:30.100Z",
    phaseName: "audit",
    durationMs: 9900,
    agentResults: { ok: 1, error: 0, cacheHit: 0 },
  },
  {
    type: "transition",
    at: "2026-05-28T14:30:30.300Z",
    from: "running",
    to: "done",
  },
];

const SAMPLE_MANIFEST = {
  runId: "wf-fixturefull",
  workflowName: "codebase-audit",
  input: "audit auth",
};

test("renderMermaidFromData emits flowchart TD with subgraphs and edges", () => {
  const out = renderMermaidFromData({
    manifest: SAMPLE_MANIFEST,
    entries: SAMPLE_ENTRIES,
  });
  // Core syntax markers
  assert.match(out, /^flowchart TD\n/);
  // Header comment with run metadata
  assert.match(out, /run=wf-fixturefull/);
  assert.match(out, /workflow=codebase-audit/);
  // Start node and the first phase edge
  assert.match(out, /Start\(\[Start: codebase-audit\]\)/);
  assert.match(out, /Start --> P0/);
  // Both phases as subgraphs with phase names
  assert.match(out, /subgraph P0 \["discover · 7100ms · ok=3"\]/);
  assert.match(out, /subgraph P1 \["audit · 9900ms · ok=1"\]/);
  // Phase chain edge
  assert.match(out, /P0 --> P1/);
  // Three agents in phase 0
  assert.match(out, /P0_A0\["discover-1 · ok · 4990ms"\]/);
  assert.match(out, /P0_A1\["discover-2 · ok · 5989ms"\]/);
  assert.match(out, /P0_A2\["discover-3 · ok · 6988ms"\]/);
  // Agent in phase 1
  assert.match(out, /P1_A0\["audit-1 · ok · 9790ms"\]/);
  // End node carries final state
  assert.match(out, /P1 --> End/);
  assert.match(out, /End\(\[done\]\)/);
});

test("renderMermaidFromData: empty entries → 'no phases' diagram", () => {
  const out = renderMermaidFromData({ manifest: {}, entries: [] });
  assert.match(out, /^flowchart TD\n/);
  assert.match(out, /Start\(\[Start\]\)/);
  assert.match(out, /Start --> End/);
  assert.match(out, /End\(\[no phases\]\)/);
});

test("renderMermaidFromData: phase started but never ended → 'running'", () => {
  const entries: LedgerEntry[] = [
    {
      type: "phase_start",
      at: "2026-05-28T14:30:13.000Z",
      phaseName: "long",
      agentCount: 1,
    },
    {
      type: "agent_start",
      at: "2026-05-28T14:30:13.010Z",
      phaseName: "long",
      agentId: "long-1",
      promptHash: "x",
    },
  ];
  const out = renderMermaidFromData({ manifest: {}, entries });
  assert.match(out, /subgraph P0 \["long · running"\]/);
  // Agent that hasn't ended → status=running, no duration
  assert.match(out, /P0_A0\["long-1 · running"\]/);
  // Final state still unknown → "in-progress"
  assert.match(out, /End\(\[in-progress\]\)/);
});

test("renderMermaidFromData: agent_error and agent_cache_hit set distinct statuses", () => {
  const entries: LedgerEntry[] = [
    {
      type: "phase_start",
      at: "2026-05-28T14:30:13.000Z",
      phaseName: "mixed",
      agentCount: 2,
    },
    {
      type: "agent_start",
      at: "2026-05-28T14:30:13.010Z",
      phaseName: "mixed",
      agentId: "fail-1",
      promptHash: "x",
    },
    {
      type: "agent_error",
      at: "2026-05-28T14:30:14.000Z",
      phaseName: "mixed",
      agentId: "fail-1",
      error: { class: "Unknown", message: "boom" },
    },
    {
      type: "agent_cache_hit",
      at: "2026-05-28T14:30:14.500Z",
      phaseName: "mixed",
      agentId: "cached-1",
    },
    {
      type: "phase_end",
      at: "2026-05-28T14:30:15.000Z",
      phaseName: "mixed",
      durationMs: 2000,
      agentResults: { ok: 0, error: 1, cacheHit: 1 },
    },
  ];
  const out = renderMermaidFromData({ manifest: {}, entries });
  assert.match(out, /P0_A0\["fail-1 · error"\]/);
  assert.match(out, /P0_A1\["cached-1 · cache-hit"\]/);
  // Phase label aggregates both kinds
  assert.match(out, /subgraph P0 \["mixed · 2000ms · err=1 hit=1"\]/);
});

test("renderMermaidFromData: control chars and quotes in labels are escaped", () => {
  const entries: LedgerEntry[] = [
    {
      type: "phase_start",
      at: "2026-05-28T14:30:13.000Z",
      phaseName: 'evil"phase',
      agentCount: 1,
    },
    {
      type: "agent_start",
      at: "2026-05-28T14:30:13.010Z",
      phaseName: 'evil"phase',
      agentId: 'with\nnewline',
      promptHash: "x",
    },
  ];
  const out = renderMermaidFromData({ manifest: {}, entries });
  // Double quote → single quote substitution
  assert.match(out, /evil'phase/);
  assert.ok(!out.includes('evil"phase'));
  // Newline in agentId is replaced with space (not a literal newline
  // inside the label that would break the diagram).
  const labelLines = out.split("\n").filter((l) => l.includes("with"));
  for (const line of labelLines) {
    assert.ok(!line.includes("\nnewline"));
  }
});

test("renderMermaid (async): reads manifest + ledger off disk", async () => {
  const { runDir, cleanup } = makeRunDir();
  try {
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify(SAMPLE_MANIFEST, null, 2),
    );
    const ledger = SAMPLE_ENTRIES.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(runDir, "ledger.jsonl"), ledger);
    const out = await renderMermaid(runDir);
    assert.match(out, /run=wf-fixturefull/);
    assert.match(out, /subgraph P0 \["discover · 7100ms · ok=3"\]/);
    assert.match(out, /subgraph P1 \["audit · 9900ms · ok=1"\]/);
    assert.match(out, /End\(\[done\]\)/);
  } finally {
    cleanup();
  }
});

test("renderMermaid (async): missing manifest still produces a diagram", async () => {
  const { runDir, cleanup } = makeRunDir();
  try {
    // Only ledger; no manifest.json.
    const ledger = SAMPLE_ENTRIES.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(runDir, "ledger.jsonl"), ledger);
    const out = await renderMermaid(runDir);
    // Default Start label (no workflowName)
    assert.match(out, /Start\(\[Start\]\)/);
    assert.match(out, /subgraph P0 \["discover · 7100ms · ok=3"\]/);
  } finally {
    cleanup();
  }
});

test("renderMermaidSync: matches async output for same fixture", async () => {
  const { runDir, cleanup } = makeRunDir();
  try {
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify(SAMPLE_MANIFEST),
    );
    const ledger = SAMPLE_ENTRIES.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(runDir, "ledger.jsonl"), ledger);
    const sync = renderMermaidSync(runDir);
    const async_ = await renderMermaid(runDir);
    assert.equal(sync, async_);
  } finally {
    cleanup();
  }
});

test("renderMermaidSync: tolerates torn trailing line", () => {
  const { runDir, cleanup } = makeRunDir();
  try {
    const lines = SAMPLE_ENTRIES.map((e) => JSON.stringify(e));
    // Truncate the last entry mid-JSON: mimic a SIGKILL during write.
    const lastFull = lines.slice(0, -1).join("\n") + "\n";
    const tornLine = lines[lines.length - 1]!.slice(0, 20); // partial
    writeFileSync(join(runDir, "ledger.jsonl"), lastFull + tornLine);
    const out = renderMermaidSync(runDir);
    // We should still see both phases — the torn final transition is
    // dropped silently, so the End label will be "running" (the last
    // valid `to`), not "done".
    assert.match(out, /subgraph P0 /);
    assert.match(out, /subgraph P1 /);
    assert.match(out, /End\(\[running\]\)/);
  } finally {
    cleanup();
  }
});

test("writeMermaidToTmp writes a .mmd file with the rendered diagram", async () => {
  const { runDir, cleanup } = makeRunDir();
  const tmpRoot = mkdtempSync(join(tmpdir(), "pi-wf-viztmp-"));
  try {
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify(SAMPLE_MANIFEST),
    );
    const ledger = SAMPLE_ENTRIES.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(runDir, "ledger.jsonl"), ledger);
    const target = await writeMermaidToTmp(runDir, {
      tmpDir: tmpRoot,
      nowMs: () => 1700000000000,
    });
    assert.match(target, /pi-workflows-viz-wf-fixturefull-1700000000000\.mmd$/);
    const contents = readFileSync(target, "utf8");
    assert.match(contents, /^flowchart TD\n/);
    assert.match(contents, /run=wf-fixturefull/);
  } finally {
    cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
