/**
 * pi-workflows — cross-run memo store (gap/ctx-memo).
 *
 * Persists arbitrary JSON values keyed by sha256(key), with a TTL.
 * Backed by append-only JSONL at `~/.pi/agent/memos/<scope>/memo.jsonl`.
 * Same atomic-write + compaction contract as `cache.ts`.
 *
 * Differences from CacheStore:
 *   - Cross-run: file is NOT scoped to a single run directory.
 *   - TTL: entries expire lazily at get-time.
 *   - Value is opaque JSON (not an AgentResultLike).
 *   - Compaction threshold: 500 (lower because the file is shared).
 *
 * Crash-consistency:
 *   - Append: full JSON line in memory → single `write` → `fsync` → return.
 *   - Compaction: write snapshot to `memo.jsonl.tmp`, fsync, rename over
 *     `memo.jsonl`. POSIX rename is atomic on the same filesystem.
 *
 * Concurrency: all writes serialize through `this.writeQueue`.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises as fsp,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  memoPath as defaultMemoPath,
  memoPathTmp as defaultMemoPathTmp,
} from "../util/paths.js";

/** Default compaction threshold for the memo store. */
export const MEMO_COMPACTION_THRESHOLD = 500;

/** On-disk record shape. */
export interface MemoEntry {
  /** sha256(key) — the hash passed to get/set/has. */
  readonly key: string;
  /** The stored value (JSON-serializable). */
  readonly value: unknown;
  /** Date.now() at write time (ms since epoch). */
  readonly writtenAt: number;
  /** TTL in milliseconds. Entry is stale when Date.now() > writtenAt + ttlMs. */
  readonly ttlMs: number;
}

export interface MemoStoreOptions {
  readonly scope: "global" | "project";
  /** Required when scope is 'project'. */
  readonly projectRoot?: string;
  /**
   * Override path resolver — lets tests target a tmpdir.
   * Receives `(scope, projectRoot?)`.
   */
  readonly resolveMemoPath?: (
    scope: "global" | "project",
    projectRoot?: string,
  ) => string;
  readonly resolveMemoPathTmp?: (
    scope: "global" | "project",
    projectRoot?: string,
  ) => string;
  /** Override compaction threshold (default: 500). */
  readonly compactionThreshold?: number;
  /** Test seam: override wall-clock for TTL checking and writtenAt. */
  readonly nowMs?: () => number;
  /**
   * Test seam: called inside compact() AFTER fsync but BEFORE rename.
   * Throwing simulates a crash mid-compaction; original file must stay intact.
   */
  readonly __compactionPanicBeforeRename?: () => void;
}

/**
 * Cross-run persistent memo store.
 *
 * Lifecycle:
 *   1. `await MemoStore.open(opts)` — creates instance, replays the file.
 *   2. `has(keyHash)` — returns true if a non-expired entry exists.
 *   3. `get(keyHash)` — returns the MemoEntry or null (expired = null).
 *   4. `set(keyHash, value, ttlMs)` — appends a new entry.
 */
export class MemoStore {
  private readonly memoPath: string;
  private readonly memoPathTmp: string;
  private readonly compactionThreshold: number;
  private readonly nowMs: () => number;
  private readonly compactionPanicBeforeRename?: () => void;

  /** In-memory map: keyHash → latest MemoEntry (may be expired). */
  private entries: Map<string, MemoEntry> = new Map();
  /** Records written since the last compaction (or since open). */
  private entriesSinceCompaction = 0;
  /** Serializing write queue. */
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(opts: MemoStoreOptions) {
    const resolve = opts.resolveMemoPath ?? defaultMemoPath;
    const resolveTmp = opts.resolveMemoPathTmp ?? defaultMemoPathTmp;
    this.memoPath = resolve(opts.scope, opts.projectRoot);
    this.memoPathTmp = resolveTmp(opts.scope, opts.projectRoot);
    this.compactionThreshold = opts.compactionThreshold ?? MEMO_COMPACTION_THRESHOLD;
    this.nowMs = opts.nowMs ?? Date.now;
    if (opts.__compactionPanicBeforeRename) {
      this.compactionPanicBeforeRename = opts.__compactionPanicBeforeRename;
    }
  }

  /**
   * Construct + replay. Creates the parent directory if needed.
   */
  static async open(opts: MemoStoreOptions): Promise<MemoStore> {
    const store = new MemoStore(opts);
    // Ensure the parent directory exists before replay / first write.
    mkdirSync(dirname(store.memoPath), { recursive: true });
    await store.replay();
    return store;
  }

  // ─── reads ────────────────────────────────────────────────────────

  /**
   * Returns true if there is a non-expired entry for `keyHash`.
   * Expired entries are treated as misses (lazy eviction).
   */
  has(keyHash: string): boolean {
    const entry = this.entries.get(keyHash);
    if (entry === undefined) return false;
    return this.nowMs() <= entry.writtenAt + entry.ttlMs;
  }

  /**
   * Returns the MemoEntry if present and not expired, otherwise null.
   */
  get(keyHash: string): MemoEntry | null {
    const entry = this.entries.get(keyHash);
    if (entry === undefined) return null;
    if (this.nowMs() > entry.writtenAt + entry.ttlMs) return null;
    return entry;
  }

  /** Diagnostic: in-memory size. */
  size(): { entries: number; entriesSinceCompaction: number } {
    return {
      entries: this.entries.size,
      entriesSinceCompaction: this.entriesSinceCompaction,
    };
  }

  // ─── writes ───────────────────────────────────────────────────────

  /**
   * Append a new entry. Triggers compaction when the threshold is crossed.
   */
  async set(keyHash: string, value: unknown, ttlMs: number): Promise<void> {
    const entry: MemoEntry = {
      key: keyHash,
      value,
      writtenAt: this.nowMs(),
      ttlMs,
    };
    const line = JSON.stringify(entry) + "\n";
    const next = this.writeQueue.then(() => this.appendLineSync(line));
    this.writeQueue = next.catch(() => undefined);
    await next;
    this.entries.set(keyHash, entry);
    await this.maybeCompact();
  }

  /** Awaitable flush barrier. Tests use this. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // ─── internals ────────────────────────────────────────────────────

  private async appendLineSync(line: string): Promise<void> {
    let fd: number | undefined;
    try {
      fd = openSync(this.memoPath, "a", 0o644);
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.entriesSinceCompaction += 1;
  }

  private async maybeCompact(): Promise<void> {
    if (this.entriesSinceCompaction < this.compactionThreshold) return;
    await this.runCompaction();
  }

  private async runCompaction(): Promise<boolean> {
    const countAtStart = this.entriesSinceCompaction;
    const next = this.writeQueue.then(async () => {
      const snapshot = this.buildSnapshotString();
      await this.writeSnapshotAndRename(snapshot);
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
    this.entriesSinceCompaction -= countAtStart;
    return true;
  }

  private buildSnapshotString(): string {
    const now = this.nowMs();
    const lines: string[] = [];
    for (const [, entry] of this.entries) {
      // Drop already-expired entries from the compacted snapshot.
      if (now > entry.writtenAt + entry.ttlMs) continue;
      lines.push(JSON.stringify(entry));
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  private async writeSnapshotAndRename(snapshot: string): Promise<void> {
    let fd: number | undefined;
    try {
      fd = openSync(this.memoPathTmp, "w", 0o644);
      if (snapshot.length > 0) writeSync(fd, snapshot);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (this.compactionPanicBeforeRename) {
      this.compactionPanicBeforeRename();
    }
    renameSync(this.memoPathTmp, this.memoPath);
  }

  private async replay(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.memoPath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") return;
      throw err;
    }
    if (buf.length === 0) return;

    const text = buf.toString("utf8");
    const endsWithNewline = text.endsWith("\n");
    const parts = text.split("\n");
    if (endsWithNewline) parts.pop();
    const lastIdx = parts.length - 1;

    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] ?? "";
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Torn trailing line — silently drop.
        if (i === lastIdx && !endsWithNewline) continue;
        // Mid-file corruption — skip silently (memo is advisory).
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const r = parsed as Partial<MemoEntry>;
      if (
        typeof r.key !== "string" ||
        typeof r.writtenAt !== "number" ||
        typeof r.ttlMs !== "number"
      ) {
        continue;
      }
      // Last-write-wins per key.
      this.entries.set(r.key, parsed as MemoEntry);
    }
  }
}

/**
 * Module-level cache of open MemoStore instances, keyed by file path.
 * Avoids opening the same file multiple times per process lifetime.
 * Cleared by `clearMemoStoreCache()` (test-only seam).
 */
const _openStores = new Map<string, Promise<MemoStore>>();

export function getMemoStore(
  scope: "global" | "project",
  projectRoot?: string,
  opts?: Omit<MemoStoreOptions, "scope" | "projectRoot">,
): Promise<MemoStore> {
  const resolve = opts?.resolveMemoPath ?? defaultMemoPath;
  const key = resolve(scope, projectRoot);
  const existing = _openStores.get(key);
  if (existing !== undefined) return existing;
  const p = MemoStore.open({
    scope,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...opts,
  });
  _openStores.set(key, p);
  return p;
}

/** Test-only: clear the module-level store cache. */
export function clearMemoStoreCache(): void {
  _openStores.clear();
}
