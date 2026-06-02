/**
 * Shared time-formatting utilities.
 *
 * Extracted from `src/runtime/runsList.ts` (VQ-8) so visualize.ts and
 * any future consumers can import without pulling in the full runs-list
 * render module.
 */

/**
 * Format an elapsed duration `ms` as a 2-segment human label:
 * `4m 12s`, `1h  4m`, `12s`. Always exactly 7 chars or fewer.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, " ")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Format a relative-time delta (since `startedAt`) into a compact
 * label. `nowMs` is taken from the caller so tests are deterministic.
 */
export function fmtRelative(startedAt: string, nowMs: number): string {
  if (startedAt.length === 0) return "—";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const delta = nowMs - start;
  if (delta < 0) return "future";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
