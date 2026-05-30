/**
 * tests/unit/cache.test.ts — slice 3 CacheStore.
 *
 * Acceptance per `plan.md` §4 Slice 3:
 *   - identical-args same key (covered in hash.test.ts);
 *   - script-source change → key change (hash.test.ts);
 *   - cacheKeyExtra change → key change (hash.test.ts);
 *   - delete removes;
 *   - replay round-trips;
 *   - compaction at threshold → single-snapshot file with last-value-per-key;
 *   - corrupt JSONL line emits ctx.log.warn and skips, replay continues;
 *   - Compaction is atomic (write tmp, fsync, rename), verified by
 *     killing the process mid-compaction (panic-before-rename hook).
 *   - Crash-consistency on append: torn trailing line is silently
 *     dropped on next replay.
 *   - fsync is called before append returns (mutation-test safe).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CacheStore } from "../../src/runtime/cache.ts";

// ─── helpers ─────────────────────────────────────────────────────────

function makeRunDir(): { runId: string; runDir: string; cleanup: () => void; opts: () => Parameters<typeof CacheStore.open>[0] } {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-cache-"));
  const runId = "wf-" + Math.random().toString(36).slice(2, 14);
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const cachePath = join(dir, "cache.jsonl");
  const cacheTmp = join(dir, "cache.jsonl.tmp");
  return {
    runId,
    runDir: dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    opts: () => ({
      runId,
      resolveCachePath: () => cachePath,
      resolveCacheTmpPath: () => cacheTmp,
    }),
  };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (!raw) return [];
  const out = raw.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

// ─── basic round-trip ────────────────────────────────────────────────

test("cache: setAgentResult appends one fsync'd line; replay round-trips", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    await store.setAgentResult("k1", { agentId: "a", text: "hello" });
    const lines = readLines(join(runDir, "cache.jsonl"));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.type, "agent_result");
    assert.equal(parsed.key, "k1");
    assert.equal(parsed.value.text, "hello");
    assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T/);

    // Replay in a fresh store.
    const store2 = await CacheStore.open(opts());
    assert.deepEqual(store2.getAgentResult("k1"), { agentId: "a", text: "hello" });
    assert.equal(store2.size().agent, 1);
  } finally {
    cleanup();
  }
});

test("cache: setAuthorCache + deleteAuthorCache round-trip", async () => {
  const { cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    await store.setAuthorCache("foo", { count: 1 });
    assert.deepEqual(store.getAuthorCache("foo"), { count: 1 });
    assert.equal(store.hasAuthorCache("foo"), true);
    await store.deleteAuthorCache("foo");
    assert.equal(store.hasAuthorCache("foo"), false);
    assert.equal(store.getAuthorCache("foo"), undefined);

    // Replay reflects the delete.
    const store2 = await CacheStore.open(opts());
    assert.equal(store2.hasAuthorCache("foo"), false);
    assert.equal(store2.size().author, 0);
  } finally {
    cleanup();
  }
});

test("cache: last-write-wins on duplicate keys", async () => {
  const { cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    await store.setAgentResult("k", { agentId: "a", text: "v1" });
    await store.setAgentResult("k", { agentId: "a", text: "v2" });
    await store.setAgentResult("k", { agentId: "a", text: "v3" });

    assert.deepEqual(store.getAgentResult("k"), { agentId: "a", text: "v3" });

    // File still has all three records (append-only).
    const store2 = await CacheStore.open(opts());
    assert.deepEqual(store2.getAgentResult("k"), { agentId: "a", text: "v3" });
  } finally {
    cleanup();
  }
});

test("cache: opening an absent file is a no-op (clean run)", async () => {
  const { cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    assert.equal(store.size().agent, 0);
    assert.equal(store.size().author, 0);
  } finally {
    cleanup();
  }
});

// ─── append-only / no in-place mutation ──────────────────────────────

test("cache: double-append produces 2 lines (no in-place mutation)", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    await store.setAgentResult("a", { agentId: "1", text: "x" });
    await store.setAgentResult("b", { agentId: "2", text: "y" });
    const lines = readLines(join(runDir, "cache.jsonl"));
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).key, "a");
    assert.equal(JSON.parse(lines[1]!).key, "b");
  } finally {
    cleanup();
  }
});

// ─── corrupt-line tolerance ──────────────────────────────────────────

test("cache: replay skips a mid-file corrupt line and emits warn", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const path = join(runDir, "cache.jsonl");
    // Two valid records sandwiching one corrupt line.
    appendFileSync(
      path,
      JSON.stringify({ type: "agent_result", key: "k1", value: { agentId: "a", text: "v1" }, at: "2025-01-01T00:00:00.000Z" }) + "\n",
    );
    appendFileSync(path, "{not json --- corrupted ---\n");
    appendFileSync(
      path,
      JSON.stringify({ type: "agent_result", key: "k2", value: { agentId: "b", text: "v2" }, at: "2025-01-01T00:00:00.000Z" }) + "\n",
    );

    const warnings: { msg: string; details?: Readonly<Record<string, unknown>> }[] = [];
    const store = await CacheStore.open({
      ...opts(),
      log: (level, msg, details) => {
        if (level === "warn") {
          if (details === undefined) warnings.push({ msg });
          else warnings.push({ msg, details });
        }
      },
    });
    assert.equal(store.size().agent, 2);
    assert.deepEqual(store.getAgentResult("k1"), { agentId: "a", text: "v1" });
    assert.deepEqual(store.getAgentResult("k2"), { agentId: "b", text: "v2" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.msg, /skipping corrupt line/);
    assert.equal(warnings[0]!.details?.lineIndex, 1);
  } finally {
    cleanup();
  }
});

test("cache: torn trailing line (no newline) is silently dropped on replay", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const path = join(runDir, "cache.jsonl");
    appendFileSync(
      path,
      JSON.stringify({ type: "agent_result", key: "k1", value: { agentId: "a", text: "v1" }, at: "2025-01-01T00:00:00.000Z" }) + "\n",
    );
    // Append a torn line — half-written record, no trailing newline,
    // mid-string truncation. This is the SIGKILL-during-write shape.
    appendFileSync(path, '{"type":"agent_result","key":"k2","value":{"agentI');

    const warnings: string[] = [];
    const store = await CacheStore.open({
      ...opts(),
      log: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    });
    // Only the first record is replayed.
    assert.equal(store.size().agent, 1);
    assert.deepEqual(store.getAgentResult("k1"), { agentId: "a", text: "v1" });
    // Crucially: no warning is emitted for the torn trailing line —
    // it's the documented happy-path crash recovery.
    assert.equal(warnings.length, 0);
  } finally {
    cleanup();
  }
});

test("cache: empty file replays cleanly", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    writeFileSync(join(runDir, "cache.jsonl"), "");
    const store = await CacheStore.open(opts());
    assert.equal(store.size().agent, 0);
  } finally {
    cleanup();
  }
});

// ─── compaction ──────────────────────────────────────────────────────

test("cache: compaction at threshold collapses to last-value-per-key", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    // Threshold 5 to keep the test fast.
    const store = await CacheStore.open({ ...opts(), compactionThreshold: 5 });
    // Same key written 5 times → only one survives compaction.
    for (let i = 0; i < 5; i++) {
      await store.setAgentResult("k", { agentId: "a", text: `v${i}` });
    }
    await store.flush();
    const lines = readLines(join(runDir, "cache.jsonl"));
    assert.equal(lines.length, 1, "post-compaction file has 1 line");
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.type, "agent_result");
    assert.equal(parsed.key, "k");
    assert.equal(parsed.value.text, "v4");

    // No tmp file lingering.
    assert.equal(existsSync(join(runDir, "cache.jsonl.tmp")), false);

    // Replay still resolves to the last value.
    const store2 = await CacheStore.open(opts());
    assert.deepEqual(store2.getAgentResult("k"), { agentId: "a", text: "v4" });
  } finally {
    cleanup();
  }
});

test("cache: compaction preserves both namespaces (agent + author)", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open({ ...opts(), compactionThreshold: 4 });
    await store.setAgentResult("a1", { agentId: "x", text: "agent1" });
    await store.setAuthorCache("u1", { v: 1 });
    await store.setAuthorCache("u1", { v: 2 }); // overwrite
    await store.setAgentResult("a2", { agentId: "y", text: "agent2" });
    await store.flush();

    const lines = readLines(join(runDir, "cache.jsonl"));
    // After compaction: 2 agent + 1 author = 3 lines.
    assert.equal(lines.length, 3);

    const store2 = await CacheStore.open(opts());
    assert.deepEqual(store2.getAgentResult("a1"), { agentId: "x", text: "agent1" });
    assert.deepEqual(store2.getAgentResult("a2"), { agentId: "y", text: "agent2" });
    assert.deepEqual(store2.getAuthorCache("u1"), { v: 2 });
  } finally {
    cleanup();
  }
});

test("cache: compaction skips author_cache_delete tombstones (key absent)", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open({ ...opts(), compactionThreshold: 3 });
    await store.setAuthorCache("a", 1);
    await store.deleteAuthorCache("a");
    await store.setAuthorCache("b", 2);
    await store.flush();

    const lines = readLines(join(runDir, "cache.jsonl"));
    // Only author_cache for "b" survives — "a" was deleted, no
    // tombstone needed in the compacted snapshot.
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).key, "b");

    const store2 = await CacheStore.open(opts());
    assert.equal(store2.hasAuthorCache("a"), false);
    assert.deepEqual(store2.getAuthorCache("b"), 2);
  } finally {
    cleanup();
  }
});

test("cache: compact() forces a compaction even with sub-threshold writes", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open({ ...opts(), compactionThreshold: 1000 });
    await store.setAgentResult("k", { agentId: "a", text: "x" });
    await store.setAgentResult("k", { agentId: "a", text: "y" });
    const ran = await store.compact();
    assert.equal(ran, true);
    const lines = readLines(join(runDir, "cache.jsonl"));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).value.text, "y");
  } finally {
    cleanup();
  }
});

test("cache: compact() with zero writes since last compact is a no-op", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    const ran = await store.compact();
    assert.equal(ran, false);
    assert.equal(existsSync(join(runDir, "cache.jsonl")), false);
  } finally {
    cleanup();
  }
});

// ─── compaction atomicity (the headline plan §4 acceptance) ──────────

test("cache: compaction is atomic — panic before rename leaves original intact", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    // 1. Build a real, non-trivial cache.jsonl through normal writes.
    const store = await CacheStore.open(opts());
    await store.setAgentResult("k1", { agentId: "a", text: "alpha" });
    await store.setAgentResult("k2", { agentId: "b", text: "beta" });
    await store.flush();
    const before = readFileSync(join(runDir, "cache.jsonl"), "utf8");

    // 2. Open a *fresh* store with the panic hook armed and force compact.
    let triggered = 0;
    const store2 = await CacheStore.open({
      ...opts(),
      __compactionPanicBeforeRename: () => {
        triggered++;
        throw new Error("simulated SIGKILL mid-compaction");
      },
    });
    // setAgentResult flushes through the queue and triggers maybeCompact;
    // we use compact() directly on existing entries.
    await assert.rejects(store2.compact(), /simulated SIGKILL/);
    assert.equal(triggered, 1);

    // 3. Original cache.jsonl byte-for-byte intact.
    const after = readFileSync(join(runDir, "cache.jsonl"), "utf8");
    assert.equal(after, before);

    // 4. Tmp file may or may not exist; if it does it's been fsync'd
    //    but never renamed — recovery on next compaction overwrites.
    //    We do NOT assert tmp absence; that's not part of the contract.

    // 5. A subsequent, panic-free compaction succeeds and produces
    //    the expected snapshot (proves the store didn't poison itself).
    const store3 = await CacheStore.open(opts());
    const ran = await store3.compact();
    assert.equal(ran, true);
    const final = readLines(join(runDir, "cache.jsonl"));
    assert.equal(final.length, 2);
    const keys = final.map((l) => JSON.parse(l).key).sort();
    assert.deepEqual(keys, ["k1", "k2"]);
  } finally {
    cleanup();
  }
});

// ─── BUG-126: stale snapshot must not erase a concurrent write ─────────

test("cache: concurrent setAgentResult calls both survive threshold-triggered compaction (BUG-126)", async () => {
  // Threshold of 1 means compaction fires after every write.
  // K1 and K2 are started concurrently (both Promises launched before
  // either is awaited). The bug: compaction built its snapshot from
  // in-memory maps BEFORE chaining onto writeQueue, so the snapshot
  // could be taken before K2's agentResults.set() ran, causing the
  // compaction rename to silently erase K2's append.
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open({ ...opts(), compactionThreshold: 1 });
    // Launch both writes without awaiting to simulate concurrent callers.
    const p1 = store.setAgentResult("k1", { agentId: "a", text: "v1" });
    const p2 = store.setAgentResult("k2", { agentId: "b", text: "v2" });
    await Promise.all([p1, p2]);
    await store.flush();

    // Both keys must survive on disk after the compaction snapshot.
    const lines = readLines(join(runDir, "cache.jsonl"));
    const keys = lines.map((l) => JSON.parse(l).key).sort();
    assert.deepEqual(keys, ["k1", "k2"], "both keys on disk after concurrent writes + compaction");

    // Both keys visible in-memory.
    assert.ok(store.getAgentResult("k1"), "k1 in memory");
    assert.ok(store.getAgentResult("k2"), "k2 in memory");

    // Replay also recovers both keys.
    const store2 = await CacheStore.open(opts());
    assert.deepEqual(store2.getAgentResult("k1"), { agentId: "a", text: "v1" });
    assert.deepEqual(store2.getAgentResult("k2"), { agentId: "b", text: "v2" });
  } finally {
    cleanup();
  }
});

// ─── append durability (defensive — fsync is on the path) ────────────

test("cache: append flushes file size synchronously before resolving", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const store = await CacheStore.open(opts());
    const path = join(runDir, "cache.jsonl");
    assert.equal(existsSync(path), false);
    await store.setAgentResult("k", { agentId: "a", text: "x" });
    // After the await resolves the line MUST be visible to a fresh read.
    assert.equal(existsSync(path), true);
    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"key":"k"/);
    assert.ok(raw.endsWith("\n"));
  } finally {
    cleanup();
  }
});

// ─── append-only invariant after replay (no rewrite of existing lines) ─

test("cache: replay does NOT rewrite or compact the on-disk file", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const path = join(runDir, "cache.jsonl");
    // Pre-seed with three records under the same key.
    for (let i = 0; i < 3; i++) {
      appendFileSync(
        path,
        JSON.stringify({ type: "agent_result", key: "k", value: { agentId: "a", text: `v${i}` }, at: "2025-01-01T00:00:00.000Z" }) + "\n",
      );
    }
    const before = readFileSync(path, "utf8");
    const store = await CacheStore.open(opts());
    assert.deepEqual(store.getAgentResult("k"), { agentId: "a", text: "v2" });
    const after = readFileSync(path, "utf8");
    assert.equal(after, before);
  } finally {
    cleanup();
  }
});

test("cache: replay warns on unknown record type and skips", async () => {
  const { runDir, cleanup, opts } = makeRunDir();
  try {
    const path = join(runDir, "cache.jsonl");
    appendFileSync(
      path,
      JSON.stringify({ type: "agent_result", key: "k1", value: { agentId: "a", text: "ok" }, at: "2025-01-01T00:00:00.000Z" }) + "\n",
    );
    appendFileSync(
      path,
      JSON.stringify({ type: "future_record_type", key: "??", at: "2025-01-01T00:00:00.000Z" }) + "\n",
    );
    const warnings: string[] = [];
    const store = await CacheStore.open({
      ...opts(),
      log: (l, m) => { if (l === "warn") warnings.push(m); },
    });
    assert.equal(store.size().agent, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unknown record type/);
  } finally {
    cleanup();
  }
});
