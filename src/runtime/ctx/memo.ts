/**
 * src/runtime/ctx/memo.ts — ctx.memo cross-run memoization.
 *
 * `ctx.memo.check(key)` reads from a global or project-scoped JSONL
 * store; `ctx.memo.set(key, value)` writes. The key is sha256'd before
 * disk I/O so author keys never leak into filenames; values must be
 * JSON-cloneable (eagerly checked for a friendlier error site than
 * disk).
 *
 * The host-side surface is the two underscore-prefixed bridge methods
 * (memo_check / memo_set) that the sandbox installs as ctx.memo.{check,set}.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { getMemoStore } from "../memoStore.js";
import { sha256 } from "../../util/hash.js";
import { requireString } from "./utils.js";

const DEFAULT_MEMO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse `ctx.memo.{check,set}` opts: scope ("global" | "project") and
 * ttl (positive number; defaults to 24h). Tolerates missing/undefined
 * opts and missing/undefined scope (both default to "global"), but
 * throws TypeError for any explicit scope value that is neither
 * "global" nor "project".
 */
function parseMemoOpts(
  optsArg: unknown,
): { scope: "global" | "project"; ttlMs: number } {
  let scope: "global" | "project" = "global";
  if (optsArg !== null && typeof optsArg === "object") {
    const rawScope = (optsArg as Record<string, unknown>).scope;
    if (rawScope !== undefined) {
      if (rawScope !== "global" && rawScope !== "project") {
        throw new TypeError(
          `ctx.memo: invalid scope "${String(rawScope)}" — must be "global" or "project"`,
        );
      }
      scope = rawScope;
    }
  }
  let ttlMs = DEFAULT_MEMO_TTL_MS;
  if (
    optsArg !== null &&
    typeof optsArg === "object" &&
    typeof (optsArg as Record<string, unknown>).ttl === "number"
  ) {
    const raw = (optsArg as Record<string, unknown>).ttl as number;
    if (raw > 0) ttlMs = raw;
  }
  return { scope, ttlMs };
}

export function createMemoMethods(opts: RunCtxHostOptions): {
  memo_check: (
    key: unknown,
    optsArg?: unknown,
  ) => Promise<RunCtxBridgeResult<{ hit: boolean; value?: unknown }>>;
  memo_set: (
    key: unknown,
    value: unknown,
    optsArg?: unknown,
  ) => Promise<RunCtxBridgeResult<null>>;
} {
  async function memo_check(
    key: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<{ hit: boolean; value?: unknown }>> {
    try {
      requireString(key, "ctx.memo: key");
      const { scope, ttlMs } = parseMemoOpts(optsArg);
      const store = await getMemoStore(
        scope,
        scope === "project" ? opts.cwd : undefined,
      );
      const keyHash = sha256(key as string);
      if (!store.has(keyHash)) {
        return { ok: true, value: { hit: false } };
      }
      const entry = store.get(keyHash);
      if (entry === null) {
        return { ok: true, value: { hit: false } };
      }
      // Apply caller-supplied TTL as a maximum-age gate at check-time.
      // This allows stricter freshness requirements than the TTL baked in
      // at set-time (e.g. set with default 24h but checked with ttl: 3600000).
      if (Date.now() - entry.writtenAt > ttlMs) {
        return { ok: true, value: { hit: false } };
      }
      return { ok: true, value: { hit: true, value: entry.value } };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memo_set(
    key: unknown,
    value: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.memo: key");
      // Eagerly check JSON-cloneability — better error site than disk.
      try {
        JSON.stringify(value);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.memo: value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const { scope, ttlMs } = parseMemoOpts(optsArg);
      const store = await getMemoStore(
        scope,
        scope === "project" ? opts.cwd : undefined,
      );
      const keyHash = sha256(key as string);
      const cloned: unknown = JSON.parse(JSON.stringify(value));
      await store.set(keyHash, cloned, ttlMs);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  return { memo_check, memo_set };
}
