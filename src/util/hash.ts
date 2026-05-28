/**
 * pi-workflows — sha256 + canonical-JSON + cache-key derivation.
 *
 * Slice 3 owns:
 *   - `sha256(buf | string) → hex`           (deterministic, length 64)
 *   - `canonicalJson(value) → string`        (sorted-keys, no env/time)
 *   - `cacheKey(input)`                      (PRD §4.5 formula)
 *
 * **No clock, env, random, hostname, or pid** — every input must be
 * reachable from the workflow author's perspective. Tests assert this.
 *
 * The formula (§4.5) is:
 *
 *   sha256(
 *     workflow_version
 *     + "|" + phase_name
 *     + "|" + agent.id
 *     + "|" + sha256(agent.prompt)
 *     + "|" + sha256(JSON.stringify(agent.opts,        sorted-keys))
 *     + "|" + sha256(JSON.stringify(opts.cacheKeyExtra,sorted-keys))
 *   )
 *
 * `workflow_version` is the SHA-256 of the workflow file's bytes at
 * run-start (same value the slice-6 dispatcher will write into
 * `RunManifest.workflowSourceSha256`).
 *
 * `cacheKeyExtra` is consulted from `opts` even though it's already
 * inside the previous hash; this lets authors hash the prompt + a
 * model version *without* the entire opts object (per §4.5: "stable
 * cache across script edits"). Two `sha256` calls — one of full
 * `opts`, one of `cacheKeyExtra` alone — are intentional, not a bug.
 */

import { createHash } from "node:crypto";

/** SHA-256 → lowercase hex. Length 64. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted lexicographically; arrays
 * preserve order. Primitives use `JSON.stringify`. Undefined fields
 * are dropped from objects (matching `JSON.stringify`); `undefined`
 * inside arrays serializes as `null` (also matching). Top-level
 * `undefined` and `null` both serialize as `"null"`.
 *
 * BigInts are stringified — not native JSON, but stable and round-
 * trippable enough for cache-key purposes (we never re-parse).
 *
 * Cycles throw `TypeError` (matching native `JSON.stringify` semantics).
 *
 * Functions / symbols → `"null"` (they would not survive structured
 * cloning into the sandbox anyway, so this is benign for cache keys).
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === undefined || v === null) return "null";
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") {
      // JSON.stringify handles NaN/Infinity → "null" already.
      const s = JSON.stringify(v);
      return s === undefined ? "null" : s;
    }
    if (t === "bigint") {
      return JSON.stringify((v as bigint).toString());
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new TypeError("canonicalJson: cycle detected");
      seen.add(v);
      const parts = v.map(walk);
      seen.delete(v);
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new TypeError("canonicalJson: cycle detected");
      seen.add(obj);
      // Sort keys; drop entries whose value is undefined (mirrors
      // JSON.stringify) so `{a:1, b:undefined}` and `{a:1}` collide.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      const parts = keys.map((k) => JSON.stringify(k) + ":" + walk(obj[k]));
      seen.delete(obj);
      return "{" + parts.join(",") + "}";
    }
    // function, symbol — non-serializable. canonicalJson elides them
    // by returning "null"; the consumer (cacheKey) hashes the result,
    // so the elision is observed but stable.
    return "null";
  };
  return walk(value);
}

/** Inputs to `cacheKey()` — see PRD §4.5. */
export interface CacheKeyInput {
  /** SHA-256 of the workflow file's bytes (slice-6's manifest field). */
  readonly workflowSourceSha256: string;
  /** Phase name from `ctx.phase(...)`. Empty string if outside any phase. */
  readonly phaseName: string;
  /** Agent id (author-supplied or auto-generated). */
  readonly agentId: string;
  /** Sub-agent prompt. */
  readonly prompt: string;
  /**
   * Author-supplied `agent.opts` object. May contain `cacheKeyExtra`
   * which is *also* hashed independently per §4.5. Pass `undefined`
   * if the author didn't supply opts; we treat it as `{}`.
   */
  readonly opts: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Derive the cache key for an `AgentHandle` per PRD §4.5.
 *
 * Determinism contract:
 *   - same inputs in two processes → same hash (sha256 only, no clock,
 *     env, random, hostname, or pid).
 *   - sorted-key opts canonicalization → key-order independence.
 *   - any 1-bit change in *any* input → different hash (sha256 inverse).
 */
export function cacheKey(input: CacheKeyInput): string {
  const opts = input.opts ?? {};
  // §4.5 calls out cacheKeyExtra explicitly. Pull it out of opts for
  // its own hash slot; `null` if the author didn't set it.
  const extra =
    Object.prototype.hasOwnProperty.call(opts, "cacheKeyExtra")
      ? (opts as Record<string, unknown>).cacheKeyExtra
      : null;
  const promptHash = sha256(input.prompt);
  const optsHash = sha256(canonicalJson(opts));
  const extraHash = sha256(canonicalJson(extra));
  const composed =
    input.workflowSourceSha256 +
    "|" + input.phaseName +
    "|" + input.agentId +
    "|" + promptHash +
    "|" + optsHash +
    "|" + extraHash;
  return sha256(composed);
}
