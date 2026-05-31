/**
 * tests/unit/stdlib-memory.test.ts — ZONE_MEMORY follow-ups.
 *
 * Coverage matrix:
 *   - oversize warning (#2): one-shot per (run, name) — first read of an
 *     oversize MEMORY.md emits a `log: warn`, second read does NOT.
 *   - resume cross-check (#3): crossCheckAgentMemoryDirs returns the
 *     mismatched names + their live candidates when the recorded dir
 *     no longer matches any live scope; matched names are quiet.
 *   - stdlib helpers (#6): ctx.memory.read / append round-trip via the
 *     RunCtxHost bridge; bad inputs throw typed errors via {ok:false}.
 *   - compaction (#1): ctx.memory.compact() invokes the test-seam
 *     summarize hook, atomically rewrites the file, returns size deltas;
 *     a thrown summarizer leaves the original intact and surfaces a
 *     CompactionError.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "node:os";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

import {
  compactMemoryFile,
  CompactionError,
  crossCheckAgentMemoryDirs,
  MEMORY_FILE_NAME,
  MEMORY_READ_CAP_BYTES,
  resolveMemoryDir,
} from "../../src/runtime/agentMemory.ts";
import { createRunCtxHost } from "../../src/runtime/runCtx.ts";
import { LedgerWriter, LedgerReader } from "../../src/runtime/ledger.ts";
import { CacheStore } from "../../src/runtime/cache.ts";
import { makeSemaphore } from "../../src/runtime/semaphore.ts";
import type { AgentResult, DispatcherOptions } from "../../src/types/internal.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function noopDispatch(_opts: DispatcherOptions): Promise<AgentResult> {
  return Promise.reject(new Error("dispatch should not be called in this test"));
}

interface HarnessOpts {
  readonly runDir: string;
  readonly cwd?: string;
  readonly compactSummarize?: (name: string, original: string) => Promise<string>;
}

async function makeHarness(opts: HarnessOpts) {
  const ledger = new LedgerWriter({
    runId: "wf-mem",
    resolveLedgerPath: () => join(opts.runDir, "ledger.jsonl"),
  });
  const cache = await CacheStore.open({
    runId: "wf-mem",
    resolveCachePath: () => join(opts.runDir, "cache.jsonl"),
    log: () => {},
  });
  const ctrl = new AbortController();
  const cwd = opts.cwd ?? opts.runDir;
  const { host } = createRunCtxHost({
    runMeta: {
      id: "wf-mem",
      workflowName: "test",
      startedAt: new Date().toISOString(),
      cwd,
      resumed: false,
    },
    input: "",
    runDirAbs: opts.runDir,
    workflowSourceSha256: "deadbeef",
    cache,
    ledger,
    semaphore: makeSemaphore({ cap: 4 }),
    signal: ctrl.signal,
    perRunAgentCap: 8,
    tokenBudget: null,
    mockAgents: false,
    cwd,
    dispatch: noopDispatch,
    ...(opts.compactSummarize ? { compactSummarize: opts.compactSummarize } : {}),
  });
  return { host, ledger, cleanup: () => ctrl.abort() };
}

async function readLedgerEntries(runDir: string) {
  const reader = new LedgerReader({
    runId: "wf-mem",
    resolveLedgerPath: () => join(runDir, "ledger.jsonl"),
  });
  const { entries } = await reader.read();
  return entries;
}

// ─── #2 oversize warning ────────────────────────────────────────────

test("ctx.memory.read: oversize MEMORY.md warns once per (run, name)", async () => {
  const runDir = tmp("pi-mem-warn-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    // Write 30 KiB of memory — well past the 25 KiB read cap.
    const big = "x".repeat(30 * 1024);
    writeFileSync(join(dir, MEMORY_FILE_NAME), big, "utf8");

    const { host, cleanup } = await makeHarness({ runDir });
    try {
      const r1 = await host.memory_read!("scribe", "local");
      assert.ok(r1.ok, "first read ok");
      assert.equal(r1.value!.length, MEMORY_READ_CAP_BYTES);

      const r2 = await host.memory_read!("scribe", "local");
      assert.ok(r2.ok, "second read ok");
      assert.equal(r2.value!.length, MEMORY_READ_CAP_BYTES);

      // Give the fire-and-forget ledger appends a tick to flush.
      await new Promise((r) => setImmediate(r));
      const entries = await readLedgerEntries(runDir);
      const warnings = entries.filter(
        (e) =>
          e.type === "log" &&
          e.level === "warn" &&
          typeof e.message === "string" &&
          e.message.includes("agent-memory") &&
          e.message.includes("scribe") &&
          e.message.includes("read cap"),
      );
      assert.equal(
        warnings.length,
        1,
        `expected exactly one oversize warning, got ${warnings.length}`,
      );
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── #3 resume cross-check ──────────────────────────────────────────

test("crossCheckAgentMemoryDirs: stale recorded dir → mismatch entry", () => {
  const runDir = tmp("pi-mem-xcheck-");
  try {
    const liveCwd = "/tmp/new-cwd-here";
    const recordedDir = "/tmp/old-cwd-elsewhere/.pi/workflows/agent-memory/scribe";
    const result = crossCheckAgentMemoryDirs({
      recorded: { scribe: recordedDir },
      cwd: liveCwd,
      runDirAbs: runDir,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "scribe");
    assert.equal(result[0]!.recordedDir, recordedDir);
    // Three live candidates (user / project / local), none equal to recorded.
    assert.equal(result[0]!.liveCandidates.length, 3);
    const scopes = result[0]!.liveCandidates.map((c) => c.scope).sort();
    assert.deepEqual(scopes, ["local", "project", "user"]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("crossCheckAgentMemoryDirs: matched recorded dir → empty result", () => {
  const runDir = tmp("pi-mem-xcheck-ok-");
  try {
    const liveCwd = tmp("pi-mem-xcheck-okcwd-");
    const goodDir = resolveMemoryDir({
      scope: "project",
      name: "scribe",
      cwd: liveCwd,
      runDirAbs: runDir,
    });
    const result = crossCheckAgentMemoryDirs({
      recorded: { scribe: goodDir },
      cwd: liveCwd,
      runDirAbs: runDir,
    });
    assert.equal(result.length, 0);
    rmSync(liveCwd, { recursive: true, force: true });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("crossCheckAgentMemoryDirs: skips invalid recorded names silently", () => {
  const runDir = tmp("pi-mem-xcheck-bad-");
  try {
    // Hand-edited manifest with a path-traversal name — must not throw.
    const result = crossCheckAgentMemoryDirs({
      recorded: { "../escape": "/tmp/anywhere" },
      cwd: runDir,
      runDirAbs: runDir,
    });
    assert.equal(result.length, 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── #6 stdlib helpers ──────────────────────────────────────────────

test("ctx.memory.append + read: round-trip via the host bridge", async () => {
  const runDir = tmp("pi-mem-rw-");
  try {
    const { host, cleanup } = await makeHarness({ runDir });
    try {
      const a1 = await host.memory_append!(
        "scribe",
        "local",
        "first entry\n",
      );
      assert.ok(a1.ok, "append ok");

      const a2 = await host.memory_append!(
        "scribe",
        "local",
        "second entry",
      );
      assert.ok(a2.ok);

      const r = await host.memory_read!("scribe", "local");
      assert.ok(r.ok);
      assert.ok(typeof r.value === "string");
      assert.match(r.value!, /first entry/);
      assert.match(r.value!, /second entry/);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.memory.read: missing file → null", async () => {
  const runDir = tmp("pi-mem-missing-");
  try {
    const { host, cleanup } = await makeHarness({ runDir });
    try {
      const r = await host.memory_read!("nobody", "local");
      assert.ok(r.ok);
      assert.equal(r.value, null);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.memory.read: bad name → typed error envelope", async () => {
  const runDir = tmp("pi-mem-bad-");
  try {
    const { host, cleanup } = await makeHarness({ runDir });
    try {
      const r = await host.memory_read!("../escape", "local");
      assert.equal(r.ok, false);
      assert.match(
        (r as { error: { message: string } }).error.message,
        /path separator/,
      );
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.memory.append: bad scope → typed error envelope", async () => {
  const runDir = tmp("pi-mem-badscope-");
  try {
    const { host, cleanup } = await makeHarness({ runDir });
    try {
      const r = await host.memory_append!("scribe", "wat", "hi");
      assert.equal(r.ok, false);
      assert.match(
        (r as { error: { message: string } }).error.message,
        /scope must be/,
      );
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── #1 compaction ─────────────────────────────────────────────────

test("compactMemoryFile: atomic rewrite via summarize hook", async () => {
  const runDir = tmp("pi-mem-compact-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    const original = "old entry 1\nold entry 2\nold entry 3\n";
    writeFileSync(join(dir, MEMORY_FILE_NAME), original, "utf8");

    const result = await compactMemoryFile({
      dir,
      summarize: async (orig) => {
        assert.equal(orig, original);
        return "(summary): 3 old entries";
      },
    });
    assert.ok(result.beforeBytes > result.afterBytes);
    assert.ok(result.ratio < 1);
    const onDisk = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
    assert.equal(onDisk, "(summary): 3 old entries\n");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("compactMemoryFile: summarizer throws → original intact, CompactionError", async () => {
  const runDir = tmp("pi-mem-compact-fail-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    const original = "load-bearing content\n";
    writeFileSync(join(dir, MEMORY_FILE_NAME), original, "utf8");

    let threw: unknown = null;
    try {
      await compactMemoryFile({
        dir,
        summarize: async () => {
          throw new Error("upstream agent died");
        },
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof CompactionError, "CompactionError surfaced");
    assert.match(
      (threw as Error).message,
      /upstream agent died/,
      "wraps the upstream cause in the message",
    );
    const onDisk = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
    assert.equal(onDisk, original, "original file untouched");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("compactMemoryFile: missing source → CompactionError", async () => {
  const runDir = tmp("pi-mem-compact-missing-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    let threw: unknown = null;
    try {
      await compactMemoryFile({
        dir,
        summarize: async () => "should-never-run",
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof CompactionError);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.memory.compact: bridge invokes test-seam summarize + returns deltas", async () => {
  const runDir = tmp("pi-mem-compact-bridge-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    const original = "long\nold\nentries\nthat\nshould\ncondense\n";
    writeFileSync(join(dir, MEMORY_FILE_NAME), original, "utf8");

    let summarizeCalls = 0;
    const { host, cleanup } = await makeHarness({
      runDir,
      compactSummarize: async (name, content) => {
        summarizeCalls++;
        assert.equal(name, "scribe");
        assert.equal(content, original);
        return "compacted!";
      },
    });
    try {
      const r = await host.memory_compact!("scribe", "local");
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal(summarizeCalls, 1);
      assert.equal(
        (r as { value: { afterBytes: number } }).value.afterBytes,
        Buffer.byteLength("compacted!\n", "utf8"),
      );
      const onDisk = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
      assert.equal(onDisk, "compacted!\n");

      // Ledger captures an info-level compaction breadcrumb.
      await new Promise((r) => setImmediate(r));
      const entries = await readLedgerEntries(runDir);
      const breadcrumbs = entries.filter(
        (e) =>
          e.type === "log" &&
          e.level === "info" &&
          typeof e.message === "string" &&
          e.message.includes("agent-memory: compacted"),
      );
      assert.equal(breadcrumbs.length, 1);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("ctx.memory.compact: summarize failure → {ok:false} envelope; file intact", async () => {
  const runDir = tmp("pi-mem-compact-bridge-fail-");
  try {
    const dir = resolveMemoryDir({
      scope: "local",
      name: "scribe",
      cwd: runDir,
      runDirAbs: runDir,
    });
    mkdirSync(dir, { recursive: true });
    const original = "intact content\n";
    writeFileSync(join(dir, MEMORY_FILE_NAME), original, "utf8");

    const { host, cleanup } = await makeHarness({
      runDir,
      compactSummarize: async () => {
        throw new Error("agent failed");
      },
    });
    try {
      const r = await host.memory_compact!("scribe", "local");
      assert.equal(r.ok, false);
      assert.match(
        (r as { error: { message: string } }).error.message,
        /summarize hook threw/,
      );
      const onDisk = readFileSync(join(dir, MEMORY_FILE_NAME), "utf8");
      assert.equal(onDisk, original);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// Reference unused imports so tsc --noEmit stays clean even if a test
// is removed in a future edit.
void homedir;
void existsSync;
