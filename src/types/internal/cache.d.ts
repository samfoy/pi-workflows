/**
 * src/types/internal/cache.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the cache slice is needed.
 */

// ─────────────────────────────────────────────────────────────────────
// Slice 3 — Cache (cache.jsonl) types
//
// PRD §6.3 defines three on-disk record shapes; the consumer split
// is two namespaces: agent-result (sha256 keys, written by slice 5
// dispatcher) and author-cache (string keys, written by slice 8a's
// `ctx.cache.set/delete`).
//
// Field-ownership:
//   - `at` is an ISO-8601 host timestamp at write-time. The on-disk
//     timestamp is *not* part of any cache key (PRD §4.5 inputs
//     don't include `at`); cache keys remain deterministic.
// ─────────────────────────────────────────────────────────────────────

/**
 * Slice-3 forward declaration of the slice-5 `AgentResult` shape. We
 * don't import slice 5's full type — that would invert the dependency.
 * Slice 5 narrows this with a structurally-compatible richer type;
 * slice 8a's `ctx.cache` is allowed to store *any* JSON-cloneable
 * value under the `author_cache` namespace, so values are typed
 * `unknown` on the way out of the cache.
 *
 * The fields here are the minimum slice 3's tests need to round-trip;
 * extra fields on the on-disk record survive replay untouched.
 */
export interface AgentResultLike {
  readonly agentId: string;
  readonly text: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly transcriptPath?: string;
  // Permit forward-compat fields without breaking slice-3 readers.
  readonly [extra: string]: unknown;
}

export interface AgentResultRecord {
  readonly type: "agent_result";
  /** sha256 hex from `cacheKey(...)`. */
  readonly key: string;
  readonly value: AgentResultLike;
  readonly at: string;
}

export interface AuthorCacheRecord {
  readonly type: "author_cache";
  /** Author-supplied string key. Not hashed. */
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

export interface AuthorCacheDeleteRecord {
  readonly type: "author_cache_delete";
  readonly key: string;
  readonly at: string;
}

/** Discriminated union of every record type written to `cache.jsonl`. */
export type CacheRecord =
  | AgentResultRecord
  | AuthorCacheRecord
  | AuthorCacheDeleteRecord;

/**
 * Sink the `CacheStore` calls when it skips a corrupt JSONL line during
 * replay (plan §4 Slice 3 acceptance: `corrupt JSONL line emits
 * ctx.log.warn and skips`). Slice 8a wires this to `ctx.log.warn`;
 * tests pass an in-memory collector.
 *
 * `level` is fixed to `"warn"` in slice 3 — corruption is the only
 * thing the cache reports. The wider sink shape is kept for forward
 * compatibility with slice 7's ledger-backed log.
 */
export type CacheLogSink = (
  level: "warn",
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

