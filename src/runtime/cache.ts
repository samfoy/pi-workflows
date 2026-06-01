/**
 * pi-workflows — per-run cache store (PRD §6.3, plan §4 Slice 3).
 *
 * On-disk format: append-only JSONL at `<runDir>/cache.jsonl`. Three
 * record types (`agent_result`, `author_cache`, `author_cache_delete`)
 * share one file. Replay rebuilds two in-memory maps, last-write-wins,
 * with `author_cache_delete` removing the key from the author map.
 *
 * Crash-consistency contract:
 *   - Append: build the full JSON line in memory → single `write` →
 *     `fsync` → only then return success. A SIGKILL during the write
 *     can leave a torn trailing line in the file; replay tolerates it.
 *   - Compaction: write the new snapshot to `cache.jsonl.tmp`, fsync
 *     the tmp file, **then** `rename` over `cache.jsonl`. POSIX rename
 *     is atomic on the same filesystem, so a crash between fsync and
 *     rename leaves the original `cache.jsonl` intact and the partial
 *     tmp file is reaped on next compaction. The plan's acceptance
 *     uses a panic hook (`__compactionPanicBeforeRename`) to assert
 *     this invariant; in production the hook is `undefined`.
 *
 * Concurrency:
 *   - All write paths serialize through `this.writeQueue` (a Promise
 *     chain). The runtime is single-threaded async per slice 8a's
 *     contract, but the queue makes the invariant explicit and
 *     defends against accidental fan-out from the dispatcher.
 *
 * v1 constraint (documented per plan critic checklist):
 *   - Compaction never triggers when there are zero writes since
 *     the last compaction. The counter resets on compact.
 *   - Compaction is *not* called from inside a write batch \u2014 slice
 *     8a's runtime keeps batches small. Calling `compact()` mid-batch
 *     is undefined behavior in v1.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  promises as fsp,
  renameSync,
  writeSync,
} from "node:fs";

import { dirname } from "node:path";
import {
  cachePath as defaultCachePath,
  cachePathTmp as defaultCachePathTmp,
  globalCachePath,
  globalCachePathTmp,
} from "../util/paths.ts";
import type {
  AgentResultLike,
  CacheLogSink,
  CacheRecord,
} from "../types/internal.d.ts";

/** Default compaction threshold per PRD §6.3 ("every 1000 entries"). */
export const DEFAULT_COMPACTION_THRESHOLD = 1000;

export interface CacheStoreOptions {
  /** Run id (a `wf-<12hex>` string). Used to derive cache.jsonl path. */
  readonly runId: string;
  /**
   * Override the path resolver — lets tests target a tmpdir without
   * touching the real `~/.pi/agent/workflows/` tree.
   */
  readonly resolveCachePath?: (runId: string) => string;
  readonly resolveCacheTmpPath?: (runId: string) => string;
  /** Sink for corrupt-line warnings during replay. Default: silent. */
  readonly log?: CacheLogSink;
  /** Override compaction threshold. Tests use 5; production uses 1000. */
  readonly compactionThreshold?: number;
  /**
   * Enable buffered write mode. When true, `appendRecord` accumulates
   * JSON lines in memory instead of fsyncing per-call. The buffer is
   * flushed to disk every 250 ms (via an unref'd setInterval) or
   * immediately when `flush()` is called. Default: false (every write
   * gets its own fsync, preserving the v1 durability contract).
   */
  readonly batchMode?: boolean;
  /**
   * Test-only seam: invoked synchronously inside `compact()` after
   * the tmp file is fully written + fsynced, **before** the rename.
   * Throwing simulates a crash mid-compaction; the original file
   * must remain intact.
   *
   * Production code MUST NOT pass this. Hidden behind `__` to make
   * misuse obvious in code review.
   */
  readonly __compactionPanicBeforeRename?: () => void;
  /**
   * Test seam: override the wall-clock used for the `at` field of
   * appended records. Default: `() => new Date().toISOString()`.
   * The `at` field is *not* part of any cache key; this exists so
   * tests can assert deterministic on-disk output.
   */
  readonly now?: () => string;
}

/**
 * Per-run cache store.
 *
 * Lifecycle:
 *   1. `await CacheStore.open(opts)` — creates instance, replays the
 *      file (if any), returns ready-to-use store.
 *   2. `setAgentResult` / `setAuthorCache` / `deleteAuthorCache` —
 *      append + fsync, then update in-memory map. **Never** updates
 *      memory before disk; if the disk write fails we throw and
 *      memory stays consistent with the persisted file.
 *   3. `compactIfNeeded()` — slice 8a's runtime calls this between
 *      phases. Atomic via tmp + rename.
 *
 * The class is intentionally not `EventEmitter`-based; slice 7's
 * ledger captures cache events separately.
 */
export class CacheStore {
  private readonly cachePath: string;
  private readonly cacheTmpPath: string;
  private readonly log: CacheLogSink;
  private readonly compactionThreshold: number;
  private readonly compactionPanicBeforeRename?: () => void;
  private readonly now: () => string;

  private agentResults: Map<string, AgentResultLike> = new Map();
  private authorCache: Map<string, unknown> = new Map();

  /** Records written since the last compaction (or since open). */
  private entriesSinceCompaction = 0;
  /** Promise chain serializing every write. */
  private writeQueue: Promise<void> = Promise.resolve();

  // ─── batch-write state ────────────────────────────────────────────
  private readonly isBatchMode: boolean;
  /** Accumulates JSON lines when batchMode is enabled. */
  private batchBuffer: string[] = [];
  /** Periodic flush interval (unref'd so it won't block process exit). */
  private batchInterval: ReturnType<typeof setInterval> | undefined;

  private constructor(opts: CacheStoreOptions) {
    const resolve = opts.resolveCachePath ?? defaultCachePath;
    const resolveTmp = opts.resolveCacheTmpPath ?? defaultCachePathTmp;
    this.cachePath = resolve(opts.runId);
    this.cacheTmpPath = resolveTmp(opts.runId);
    this.log = opts.log ?? (() => {});
    this.compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    if (opts.__compactionPanicBeforeRename) {
      this.compactionPanicBeforeRename = opts.__compactionPanicBeforeRename;
    }
    this.now = opts.now ?? (() => new Date().toISOString());
    this.isBatchMode = opts.batchMode ?? false;
    if (this.isBatchMode) {
      const interval = setInterval(() => this.drainBatchSync(), 250);
      interval.unref();
      this.batchInterval = interval;
    }
  }

  /**
   * Construct + replay. The cache directory is *not* created here —
   * slice 7's `RunManager` owns the per-run mkdir. If the file is
   * absent, replay is a no-op and the store starts empty.
   */
  static async open(opts: CacheStoreOptions): Promise<CacheStore> {
    const store = new CacheStore(opts);
    await store.replay();
    return store;
  }

  /**
   * Open the cross-run global cache for a specific workflow version.
   *
   * The store lives at `~/.pi/agent/workflows/global-cache/<sha16>/cache.jsonl`.
   * Using the first 16 chars of the script sha256 as a directory name gives
   * natural cache invalidation: any change to the workflow source produces a
   * different directory, so stale entries are never reused.
   *
   * The directory is created if absent. Cache misses are a no-op (replay
   * starts empty); the caller may call `setAgentResult` to populate.
   */
  static async openGlobal(scriptSha256: string): Promise<CacheStore> {
    const cachePth = globalCachePath(scriptSha256);
    const cacheTmpPth = globalCachePathTmp(scriptSha256);
    await fsp.mkdir(dirname(cachePth), { recursive: true });
    return CacheStore.open({
      runId: scriptSha256.slice(0, 16),
      resolveCachePath: () => cachePth,
      resolveCacheTmpPath: () => cacheTmpPth,
    });
  }

  // ─── reads ────────────────────────────────────────────────────────

  /** Returns the cached `AgentResult`, or `undefined` if no hit. */
  getAgentResult(key: string): AgentResultLike | undefined {
    return this.agentResults.get(key);
  }

  hasAgentResult(key: string): boolean {
    return this.agentResults.has(key);
  }

  /** Returns the author-set value, or `undefined` if no hit. */
  getAuthorCache(key: string): unknown {
    return this.authorCache.get(key);
  }

  hasAuthorCache(key: string): boolean {
    return this.authorCache.has(key);
  }

  /** Diagnostic: in-memory size after replay. Tests assert against this. */
  size(): { readonly agent: number; readonly author: number; readonly entriesSinceCompaction: number } {
    return {
      agent: this.agentResults.size,
      author: this.authorCache.size,
      entriesSinceCompaction: this.entriesSinceCompaction,
    };
  }

  // ─── writes ───────────────────────────────────────────────────────

  /**
   * Append an `agent_result` record. Slice 5 (dispatcher) calls this
   * the first time a sub-agent's result lands; replays read it back.
   *
   * Triggers compaction when `entriesSinceCompaction` crosses the
   * threshold (post-write). Compaction is awaited so callers don't
   * race a half-compacted file.
   */
  async setAgentResult(key: string, value: AgentResultLike): Promise<void> {
    const record: CacheRecord = {
      type: "agent_result",
      key,
      value,
      at: this.now(),
    };
    await this.appendRecord(record);
    this.agentResults.set(key, value);
    await this.maybeCompact();
  }

  /** Append an `author_cache` record. Slice 8a's `ctx.cache.set`. */
  async setAuthorCache(key: string, value: unknown): Promise<void> {
    const record: CacheRecord = {
      type: "author_cache",
      key,
      value,
      at: this.now(),
    };
    await this.appendRecord(record);
    this.authorCache.set(key, value);
    await this.maybeCompact();
  }

  /**
   * Append an `author_cache_delete` record. Slice 8a's `ctx.cache.delete`.
   * Persisting the delete (rather than just clearing memory) is the
   * v1 plan-acceptance requirement: resume of the run reflects the
   * delete on next replay.
   */
  async deleteAuthorCache(key: string): Promise<void> {
    const record: CacheRecord = {
      type: "author_cache_delete",
      key,
      at: this.now(),
    };
    await this.appendRecord(record);
    this.authorCache.delete(key);
    await this.maybeCompact();
  }

  // ─── checkpoint helpers (ctx.checkpoint DSL primitive) ─────────────
  // Checkpoints are stored as regular author-cache entries under a
  // reserved key prefix `__chk__`. This piggybacks on the existing
  // serialisation / replay / compaction path at zero extra complexity.
  // All three methods are async so callers can uniformly await them.

  /**
   * Force a compaction regardless of the threshold. Test-only and
   * forward-compat for slice 7's GC. Returns `true` if compaction ran,
   * `false` if there was nothing to compact (no in-memory entries AND
   * no writes since the last compaction — the plan critic checklist's
   * defensive no-op rule).
   */
  async compact(): Promise<boolean> {
    const haveData =
      this.agentResults.size + this.authorCache.size > 0 ||
      this.entriesSinceCompaction > 0;
    if (!haveData) return false;
    return this.runCompaction();
  }

  /**
   * Awaitable barrier: in batch mode, drains the in-memory buffer to
   * disk (one combined writeFileSync + fsyncSync), then waits for any
   * queued compaction or non-batched writes to complete. In non-batch
   * mode, simply awaits the write queue (original behaviour).
   */
  async flush(): Promise<void> {
    if (this.isBatchMode) {
      this.drainBatchSync();
    }
    await this.writeQueue;
  }

  // ─── checkpoint helpers (ctx.checkpoint DSL primitive) ────────────

  /**
   * Persist a named checkpoint to the author cache. Idempotent —
   * calling twice with the same label replaces the earlier entry.
   * Stored under key `__chk__<label>` to avoid collisions with
   * user-defined `ctx.cache` keys.
   */
  async setCheckpoint(label: string, data?: unknown): Promise<void> {
    await this.setAuthorCache(`__chk__${label}`, data ?? null);
  }

  /** Returns true if the checkpoint was previously set (and not deleted). */
  async hasCheckpoint(label: string): Promise<boolean> {
    return this.hasAuthorCache(`__chk__${label}`);
  }

  /**
   * Returns the data stored with the checkpoint, or `undefined` if
   * the checkpoint has not been set.
   */
  async getCheckpoint(label: string): Promise<unknown | undefined> {
    return this.getAuthorCache(`__chk__${label}`);
  }

  // ─── internals ────────────────────────────────────────────────────

  private appendRecord(record: CacheRecord): Promise<void> {
    // Build the full JSON line *outside* the queue tail to keep the
    // critical section short. JSON.stringify on a fresh object is
    // safe (no cycles by construction).
    const line = JSON.stringify(record) + "\n";

    if (this.isBatchMode) {
      // Accumulate in the buffer; the periodic interval (or an explicit
      // flush() call) will write everything as a single append + fsync.
      // We count optimistically so that maybeCompact() fires at the
      // same threshold cadence as non-batch mode. In-memory map updates
      // happen after this returns (in the set*() callers), which is
      // correct: if compaction fires between appendRecord and the
      // set() call, the snapshot is still accurate because both the
      // queued compaction and the set() share the same microtask queue.
      this.batchBuffer.push(line);
      this.entriesSinceCompaction += 1;
      return Promise.resolve();
    }

    const next = this.writeQueue.then(() => this.appendLineSync(line));
    // Silence unhandled rejection if a later step doesn't await; the
    // queue itself swallows by overwriting.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Synchronously write all buffered lines as one combined append +
   * single fsyncSync. Called by the 250 ms interval and by flush().
   * No-ops when the buffer is empty.
   */
  private drainBatchSync(): void {
    if (this.batchBuffer.length === 0) return;
    // Splice the entire buffer atomically (JS single-threaded: safe).
    const lines = this.batchBuffer.splice(0);
    const combined = lines.join(""); // each line already ends with \n
    let fd: number | undefined;
    try {
      fd = openSync(this.cachePath, "a", 0o644);
      writeSync(fd, combined);
      fsyncSync(fd);
    } catch (err) {
      // Restore records to the front of the buffer so the next drain
      // can retry — without this, a transient fs error silently drops data.
      this.batchBuffer.unshift(...lines);
      throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    // entriesSinceCompaction was already incremented in appendRecord;
    // do NOT increment again here to avoid double-counting.
  }

  /**
   * Synchronous open-write-fsync-close. We use the sync calls so a
   * single `appendRecord` invocation behaves as one durability unit
   * (no other microtasks interleave between write and fsync). The
   * call is wrapped in a Promise via the writeQueue — concurrent
   * callers serialize cleanly without spawning a host thread.
   */
  private async appendLineSync(line: string): Promise<void> {
    let fd: number | undefined;
    try {
      // O_WRONLY | O_CREAT | O_APPEND
      fd = openSync(this.cachePath, "a", 0o644);
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

  /**
   * Atomic compaction. Returns `true` if a compaction actually ran.
   * Caller is responsible for the threshold/force decision (see
   * `maybeCompact` and `compact`). The plan-acceptance criterion for
   * atomicity is asserted by a test that injects
   * `__compactionPanicBeforeRename`: when that throws, the original
   * `cache.jsonl` must remain intact.
   *
   * BUG-126: the snapshot MUST be built inside the queued callback,
   * not before chaining. If built outside, a concurrent `setAgentResult`
   * caller may have already enqueued its disk-write (so it appears in
   * cache.jsonl) but not yet called `agentResults.set()` (so it is
   * absent from the in-memory map). That stale snapshot then renames
   * over cache.jsonl, permanently erasing the concurrent write.
   * Building inside the callback ensures the snapshot is taken only
   * after all previously-queued writes — and their in-memory
   * `agentResults.set()` / `authorCache.set()` calls — have completed.
   */
  private async runCompaction(): Promise<boolean> {
    // Funnel through the write queue so an in-flight append doesn't
    // interleave with the rename.  Build the snapshot INSIDE the
    // callback so it captures in-memory state only after all
    // previously-queued writes have completed (fixes BUG-126).
    //
    // Capture the counter *before* the async work so that batch-mode
    // appends that race during the compaction's async gap are not
    // wiped by the reset.  We subtract the pre-compaction count
    // rather than zeroing, preserving any increments that arrived
    // concurrently.
    const countAtStart = this.entriesSinceCompaction;
    const next = this.writeQueue.then(async () => {
      const snapshot = this.buildSnapshotString();
      await this.writeSnapshotAndRename(snapshot);
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
    this.entriesSinceCompaction = Math.max(0, this.entriesSinceCompaction - countAtStart);
    return true;
  }

  /**
   * Build the full JSONL snapshot string from the current in-memory
   * maps. Author-cache deletes are dropped — the in-memory map already
   * reflects them; replaying without the tombstone is correct because
   * the delete is no longer needed once we've collapsed.
   *
   * Called exclusively from inside the `writeQueue` callback in
   * `runCompaction()` so that in-memory state is consistent with
   * what is on disk.
   */
  private buildSnapshotString(): string {
    const snapshotAt = this.now();
    const lines: string[] = [];
    for (const [key, value] of this.agentResults) {
      const r: CacheRecord = { type: "agent_result", key, value, at: snapshotAt };
      lines.push(JSON.stringify(r));
    }
    for (const [key, value] of this.authorCache) {
      const r: CacheRecord = { type: "author_cache", key, value, at: snapshotAt };
      lines.push(JSON.stringify(r));
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  private async writeSnapshotAndRename(snapshot: string): Promise<void> {
    let fd: number | undefined;
    try {
      // Truncate-write the tmp file (overwrite any stale tmp from a
      // prior crashed compaction).
      fd = openSync(this.cacheTmpPath, "w", 0o644);
      if (snapshot.length > 0) writeSync(fd, snapshot);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    // Test-only crash injection: throws here → original file intact.
    if (this.compactionPanicBeforeRename) {
      this.compactionPanicBeforeRename();
    }
    renameSync(this.cacheTmpPath, this.cachePath);
  }

  /**
   * Replay `cache.jsonl`. Tolerates:
   *   - missing file (clean run, no-op);
   *   - empty file;
   *   - truncated trailing line (torn write at SIGKILL) — silently dropped;
   *   - mid-file corrupt JSON line — emits warn via `log` and skips.
   *
   * Returns once the in-memory maps reflect the full replay.
   */
  private async replay(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.cachePath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") return;
      throw err;
    }
    if (buf.length === 0) return;

    const text = buf.toString("utf8");
    const endsWithNewline = text.endsWith("\n");
    // Split *and* drop the trailing empty element when text ends with
    // a newline (so we don't mis-classify it as a torn line).
    const parts = text.split("\n");
    if (endsWithNewline) parts.pop(); // empty tail after final \n
    // Walk every line. The last index gets the torn-line escape clause.
    const lastIdx = parts.length - 1;
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] ?? "";
      if (line.length === 0) {
        // Empty interior line is corruption-light; skip silently.
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err: unknown) {
        // Torn-trailing-line escape: only when there was no trailing
        // newline AND we're on the very last line. Anything else is
        // mid-file corruption — warn + skip per plan §4 Slice 3.
        if (i === lastIdx && !endsWithNewline) {
          // Silent drop. The next append-and-fsync writes a clean
          // line *after* the torn fragment; replay handles that on
          // the *next* startup. (We do not rewrite the file here —
          // doing so would break the plan's "append-only" rule.)
          continue;
        }
        this.log("warn", "cache: skipping corrupt line", {
          path: this.cachePath,
          lineIndex: i,
          error: (err as Error)?.message ?? String(err),
        });
        continue;
      }
      this.applyRecord(parsed, i);
    }
  }

  private applyRecord(parsed: unknown, lineIndex: number): void {
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.log("warn", "cache: skipping non-object record", {
        path: this.cachePath,
        lineIndex,
      });
      return;
    }
    const r = parsed as Partial<CacheRecord> & Record<string, unknown>;
    switch (r.type) {
      case "agent_result": {
        if (typeof r.key !== "string" || typeof r.value !== "object" || r.value === null) {
          this.log("warn", "cache: malformed agent_result", { path: this.cachePath, lineIndex });
          return;
        }
        this.agentResults.set(r.key, r.value as AgentResultLike);
        return;
      }
      case "author_cache": {
        if (typeof r.key !== "string") {
          this.log("warn", "cache: malformed author_cache", { path: this.cachePath, lineIndex });
          return;
        }
        this.authorCache.set(r.key, r.value);
        return;
      }
      case "author_cache_delete": {
        if (typeof r.key !== "string") {
          this.log("warn", "cache: malformed author_cache_delete", { path: this.cachePath, lineIndex });
          return;
        }
        this.authorCache.delete(r.key);
        return;
      }
      default: {
        this.log("warn", "cache: unknown record type", {
          path: this.cachePath,
          lineIndex,
          recordType: String(r.type),
        });
      }
    }
  }
}

// Re-exports kept narrow: tests prefer importing CacheStore + the
// constants. Don't re-export internal types from this module — they
// belong to `src/types/internal.d.ts`.
