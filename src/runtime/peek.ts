/**
 * pi-workflows — P2-S6 peek panel ledger tail reader.
 *
 * Synchronously reads the last few "meaningful" entries from a run's
 * `ledger.jsonl` and formats them as compact one-liners suitable for
 * inline display under a runs-list row.
 *
 * Meaningful entry types (PRD §6.4 / `LedgerEntry` discriminator):
 *   - `log`              → "[HH:MM] {message}"
 *   - `agent_start`      → "[HH:MM] {phase}/{agent} start"
 *   - `agent_end`        → "[HH:MM] {phase}/{agent} end ({durationMs}ms)"
 *   - `phase_start`      → "[HH:MM] phase {phase} start ({agentCount} agents)"
 *   - `phase_end`        → "[HH:MM] phase {phase} end ({durationMs}ms)"
 *
 * Other entry types (init, transition, result, etc.) are filtered out
 * — they're rare or already surfaced elsewhere in the overlay.
 *
 * Resilience:
 *   - Missing or unreadable ledger → returns `[]` (silent — peek shows
 *     "(no log entries yet)" placeholder).
 *   - Tail read is capped at 20KB so a pathological run with massive
 *     entries doesn't block the synchronous render path.
 *   - Malformed JSON lines are skipped silently.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Max bytes pulled from the tail of `ledger.jsonl` per peek read. */
const MAX_TAIL_BYTES = 20 * 1024;

/**
 * Read the last `n` meaningful ledger entries from `<runDir>/ledger.jsonl`
 * and format as short, single-line strings. Returns `[]` on any
 * failure (missing dir, missing file, IO error, all-malformed file).
 */
export function readPeekLines(runDir: string, n: number): string[] {
  if (n <= 0) return [];
  const path = join(runDir, "ledger.jsonl");
  let buf: string;
  try {
    const st = statSync(path);
    const size = st.size;
    if (size === 0) return [];
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    const fd = openSync(path, "r");
    try {
      const out = Buffer.alloc(length);
      readSync(fd, out, 0, length, start);
      buf = out.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  // If we read from a mid-file offset, drop the leading partial line so
  // we don't try to parse half a JSON object.
  let body = buf;
  if (body.length === MAX_TAIL_BYTES) {
    const firstNl = body.indexOf("\n");
    if (firstNl >= 0) body = body.slice(firstNl + 1);
  }
  const lines = body.split("\n").filter((l) => l.length > 0);
  const out: string[] = [];
  // Walk from the end — newest entries first — and pluck the last `n`
  // meaningful ones, then reverse so the rendered order is chronological.
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const formatted = formatEntry(lines[i]!);
    if (formatted !== null) out.push(formatted);
  }
  return out.reverse();
}

/**
 * Parse one JSONL line and format it as a peek-line string.
 * Returns `null` for malformed entries or non-meaningful types.
 */
function formatEntry(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const e = parsed as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const at = typeof e.at === "string" ? e.at : "";
  const ts = formatTime(at);
  switch (type) {
    case "log": {
      const msg = typeof e.message === "string" ? e.message : "";
      return `${ts} ${truncate(msg, 80)}`;
    }
    case "agent_start": {
      const phase = typeof e.phaseName === "string" ? e.phaseName : "?";
      const agent = typeof e.agentId === "string" ? e.agentId : "?";
      return `${ts} ${phase}/${agent} start`;
    }
    case "agent_end": {
      const phase = typeof e.phaseName === "string" ? e.phaseName : "?";
      const agent = typeof e.agentId === "string" ? e.agentId : "?";
      const dur =
        typeof e.durationMs === "number" ? `${e.durationMs}ms` : "?";
      return `${ts} ${phase}/${agent} end (${dur})`;
    }
    case "phase_start": {
      const phase = typeof e.phaseName === "string" ? e.phaseName : "?";
      const count =
        typeof e.agentCount === "number" ? `${e.agentCount}` : "?";
      return `${ts} phase ${phase} start (${count} agents)`;
    }
    case "phase_end": {
      const phase = typeof e.phaseName === "string" ? e.phaseName : "?";
      const dur =
        typeof e.durationMs === "number" ? `${e.durationMs}ms` : "?";
      return `${ts} phase ${phase} end (${dur})`;
    }
    default:
      return null;
  }
}

/** Extract `HH:MM` from an ISO-8601 timestamp; "[--:--]" on parse fail. */
function formatTime(at: string): string {
  // ISO format: 2026-05-29T12:34:56.789Z — slice the HH:MM segment.
  const m = /T(\d{2}):(\d{2})/.exec(at);
  if (m === null) return "[--:--]";
  return `[${m[1]}:${m[2]}]`;
}

/** Trim long lines so peek rows don't blow past terminal width. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}
