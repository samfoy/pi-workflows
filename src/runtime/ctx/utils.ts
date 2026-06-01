/**
 * src/runtime/ctx/utils.ts — pure helpers shared across the per-method
 * ctx.* factory files.
 *
 * These were free functions inside src/runtime/runCtx.ts before the
 * audit-driven split. They have zero closure capture and zero runtime
 * dependencies on the host bridge, so they can live alongside the
 * per-method files without re-introducing coupling.
 */

/**
 * Returns true for objects with a numeric `.length` property — the
 * shape `ctx.phase` accepts as its agents argument so authors can
 * pass typed-array-like containers.
 */
export function isLikeArray(v: unknown): v is ArrayLike<unknown> {
  if (v === null || typeof v !== "object") return false;
  const len = (v as { length?: unknown }).length;
  return typeof len === "number" && Number.isFinite(len) && len >= 0 && Math.floor(len) === len;
}

/**
 * Throws a TypeError if `v` is not a string. Used by the shared
 * argument-validation prelude on ctx.cache.* and similar key-takers.
 */
export function requireString(v: unknown, label: string): void {
  if (typeof v !== "string") {
    throw new TypeError(`${label}: expected string, got ${typeof v}`);
  }
}
