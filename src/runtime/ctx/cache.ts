/**
 * src/runtime/ctx/cache.ts — author-facing cache surface (ctx.cache.*).
 *
 * Four methods, all stateless on the host side: they delegate directly
 * to `opts.cache.{getAuthorCache, setAuthorCache, hasAuthorCache,
 * deleteAuthorCache}`. The factory takes the host options object so it
 * can capture `opts.cache` once, and returns the four bridge methods
 * the sandbox installs on `ctx.cache`.
 *
 * Each method returns the standard `RunCtxBridgeResult<T>` envelope
 * because the realm boundary expects `{ ok: true, value }` / `{ ok:
 * false, error: captureError(e) }` shape — same convention every other
 * runCtx method uses.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { requireString } from "./utils.js";

/**
 * Factory: returns the four `ctx.cache.*` methods bound to the supplied
 * host options. Side-effect free until any method is invoked; the
 * factory itself just closes over `opts.cache`.
 */
export function createCacheMethods(opts: RunCtxHostOptions): {
  cacheGet: (key: unknown) => Promise<RunCtxBridgeResult<unknown>>;
  cacheSet: (key: unknown, value: unknown) => Promise<RunCtxBridgeResult<null>>;
  cacheHas: (key: unknown) => Promise<RunCtxBridgeResult<boolean>>;
  cacheDelete: (key: unknown) => Promise<RunCtxBridgeResult<null>>;
} {
  async function cacheGet(
    key: unknown,
  ): Promise<RunCtxBridgeResult<unknown>> {
    try {
      requireString(key, "ctx.cache.get: key");
      return { ok: true, value: opts.cache.getAuthorCache(key as string) };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function cacheSet(
    key: unknown,
    value: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.cache.set: key");
      // Eagerly check JSON-cloneability — better error site than disk.
      try {
        JSON.stringify(value);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.cache.set: value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const cloned: unknown =
        value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      await opts.cache.setAuthorCache(key as string, cloned);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function cacheHas(
    key: unknown,
  ): Promise<RunCtxBridgeResult<boolean>> {
    try {
      requireString(key, "ctx.cache.has: key");
      return { ok: true, value: opts.cache.hasAuthorCache(key as string) };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function cacheDelete(
    key: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      requireString(key, "ctx.cache.delete: key");
      await opts.cache.deleteAuthorCache(key as string);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  return { cacheGet, cacheSet, cacheHas, cacheDelete };
}
