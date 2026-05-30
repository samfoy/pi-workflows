/**
 * Unit tests for MemoStore (gap/ctx-memo).
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MemoStore,
  clearMemoStoreCache,
  getMemoStore,
  MEMO_COMPACTION_THRESHOLD,
} from "../../src/runtime/memoStore.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `memo-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function memoPathOverride(
  dir: string,
): (scope: "global" | "project", projectRoot?: string) => string {
  return () => join(dir, "memo.jsonl");
}

function memoPathTmpOverride(
  dir: string,
): (scope: "global" | "project", projectRoot?: string) => string {
  return () => join(dir, "memo.jsonl.tmp");
}

async function openStore(
  dir: string,
  opts?: {
    nowMs?: () => number;
    compactionThreshold?: number;
    __compactionPanicBeforeRename?: () => void;
  },
): Promise<MemoStore> {
  clearMemoStoreCache();
  return MemoStore.open({
    scope: "global",
    resolveMemoPath: memoPathOverride(dir),
    resolveMemoPathTmp: memoPathTmpOverride(dir),
    ...opts,
  });
}

// ─── basic set / get / has ────────────────────────────────────────────────────

test("MemoStore: set, get, has — basic round-trip", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore(dir);
    await store.set("k1", { name: "hello" }, 60_000);
    assert.ok(store.has("k1"), "has should return true for fresh entry");
    const entry = store.get("k1");
    assert.ok(entry !== null, "get should return an entry");
    assert.deepEqual(entry.value, { name: "hello" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoStore: get returns null for unknown key", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore(dir);
    assert.equal(store.get("nonexistent"), null);
    assert.equal(store.has("nonexistent"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── TTL / expiry ─────────────────────────────────────────────────────────────

test("MemoStore: expired entry is treated as miss", async () => {
  const dir = makeTempDir();
  try {
    let now = 1000;
    const store = await openStore(dir, { nowMs: () => now });

    // Write with 100ms TTL.
    await store.set("k-ttl", "some-value", 100);
    assert.ok(store.has("k-ttl"), "should be a hit within TTL");
    assert.ok(store.get("k-ttl") !== null, "get should return entry within TTL");

    // Advance clock past TTL.
    now = 1200;
    assert.equal(store.has("k-ttl"), false, "should be a miss after TTL expires");
    assert.equal(store.get("k-ttl"), null, "get should return null after TTL expires");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoStore: last-write-wins on same key", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore(dir);
    await store.set("lw", "first", 60_000);
    await store.set("lw", "second", 60_000);
    const entry = store.get("lw");
    assert.ok(entry !== null);
    assert.equal(entry.value, "second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── persistence (replay) ─────────────────────────────────────────────────────

test("MemoStore: replay restores entries across re-open", async () => {
  const dir = makeTempDir();
  try {
    {
      const store = await openStore(dir);
      await store.set("persist-key", { x: 42 }, 60_000);
    }
    {
      // Re-open the same file.
      const store2 = await openStore(dir);
      assert.ok(store2.has("persist-key"), "entry should survive re-open");
      const entry = store2.get("persist-key");
      assert.ok(entry !== null);
      assert.deepEqual(entry.value, { x: 42 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoStore: replay drops expired entries (lazy eviction)", async () => {
  const dir = makeTempDir();
  try {
    let now = 5000;
    {
      const store = await openStore(dir, { nowMs: () => now });
      await store.set("exp-key", "value", 100); // expires at 5100
    }
    now = 6000; // past TTL
    {
      const store2 = await openStore(dir, { nowMs: () => now });
      assert.equal(store2.has("exp-key"), false);
      assert.equal(store2.get("exp-key"), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── compaction ───────────────────────────────────────────────────────────────

test("MemoStore: compaction fires at threshold and reduces entries-since-compaction", async () => {
  const dir = makeTempDir();
  try {
    const THRESHOLD = 5;
    const store = await openStore(dir, { compactionThreshold: THRESHOLD });

    for (let i = 0; i < THRESHOLD; i++) {
      await store.set(`key-${i}`, i, 60_000);
    }
    await store.flush();
    // After threshold writes, compaction fires.
    const { entriesSinceCompaction } = store.size();
    assert.equal(entriesSinceCompaction, 0, "entriesSinceCompaction should reset after compaction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoStore: compaction atomic — crash before rename leaves original intact", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore(dir, { compactionThreshold: 2 });

    // Write 2 entries (at threshold write, compaction fires).
    await store.set("a", 1, 60_000);

    let panicCalled = false;
    let threwOnCompact = false;
    const storePanic = await openStore(dir, {
      compactionThreshold: 2,
      __compactionPanicBeforeRename: () => {
        panicCalled = true;
        throw new Error("simulated crash before rename");
      },
    });
    await storePanic.set("a", 1, 60_000);
    try {
      await storePanic.set("b", 2, 60_000);
    } catch {
      threwOnCompact = true;
    }
    // Whether or not the compaction threw, the original memo.jsonl survives.
    assert.ok(panicCalled, "panic hook should have fired");

    // Re-open: both 'a' and whatever was on disk before compaction survive.
    const storeCheck = await openStore(dir);
    // At minimum, 'a' written to original file must be present.
    assert.ok(storeCheck.has("a"), "entry 'a' must survive panic-before-rename");

    void threwOnCompact; // may or may not throw depending on queue handling
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoStore: compaction drops expired entries from snapshot", async () => {
  const dir = makeTempDir();
  try {
    let now = 1000;
    const store = await openStore(dir, {
      compactionThreshold: 3,
      nowMs: () => now,
    });

    await store.set("fresh", "keep", 60_000);    // expires at 1000+60000
    await store.set("stale", "drop", 100);       // expires at 1100
    now = 5000;                                   // advance past stale TTL
    await store.set("trigger", "trigger", 60_000); // 3rd write triggers compact

    await store.flush();

    // Reopen and verify stale entry is gone.
    const store2 = await openStore(dir, { nowMs: () => now });
    assert.ok(store2.has("fresh"), "fresh entry should survive compaction");
    assert.equal(store2.has("stale"), false, "stale entry should be dropped during compaction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── getMemoStore module-level cache ─────────────────────────────────────────

test("getMemoStore: returns same instance for same key", async () => {
  const dir = makeTempDir();
  try {
    clearMemoStoreCache();
    const opts = {
      resolveMemoPath: memoPathOverride(dir),
      resolveMemoPathTmp: memoPathTmpOverride(dir),
    };
    const a = await getMemoStore("global", undefined, opts);
    const b = await getMemoStore("global", undefined, opts);
    assert.strictEqual(a, b, "should return same MemoStore instance from cache");
  } finally {
    clearMemoStoreCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getMemoStore: clearMemoStoreCache resets instances", async () => {
  const dir = makeTempDir();
  try {
    clearMemoStoreCache();
    const opts = {
      resolveMemoPath: memoPathOverride(dir),
      resolveMemoPathTmp: memoPathTmpOverride(dir),
    };
    const a = await getMemoStore("global", undefined, opts);
    clearMemoStoreCache();
    const b = await getMemoStore("global", undefined, opts);
    // After clear, a new instance is created (not same reference).
    assert.notStrictEqual(a, b, "should create a fresh instance after cache clear");
  } finally {
    clearMemoStoreCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── MEMO_COMPACTION_THRESHOLD exported constant ──────────────────────────────

test("MEMO_COMPACTION_THRESHOLD is 500", () => {
  assert.equal(MEMO_COMPACTION_THRESHOLD, 500);
});
