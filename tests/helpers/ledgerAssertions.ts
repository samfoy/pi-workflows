/**
 * tests/helpers/ledgerAssertions.ts — reusable ledger/event-stream
 * assertion helpers for integration tests.
 *
 * All helpers operate on a `LedgerEntry[]` array, which can be obtained
 * from `readLedgerEntries()` or directly from `LedgerReader.read().entries`.
 *
 * Prompt-matching note
 * --------------------
 * The `agent_start` ledger entry stores only `promptHash` (sha256 of the
 * prompt string), NOT the prompt text itself. `assertAgentCalledWith`
 * therefore accepts a full prompt string and hashes it for comparison.
 * The hash stored is `sha256(handle.prompt)` — i.e. the raw author prompt
 * BEFORE any schema instruction is appended. For agents with `opts.schema`,
 * pass the raw prompt (without the schema instruction suffix).
 *
 * RegExp patterns cannot be matched against a hash — passing a RegExp
 * throws immediately with a descriptive message pointing to this note.
 */

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { sha256 } from "../../src/util/hash.js";
import type { LedgerEntry } from "../../src/types/internal.js";

// ─── Finders ────────────────────────────────────────────────────────────────

/**
 * Returns all entries of type `phase_start` whose `phaseName` matches.
 */
export function findPhaseStart(
  entries: ReadonlyArray<LedgerEntry>,
  phaseName: string,
): LedgerEntry[] {
  return entries.filter(
    (e): e is Extract<LedgerEntry, { type: "phase_start" }> =>
      e.type === "phase_start" && e.phaseName === phaseName,
  );
}

/**
 * Returns all `agent_start` entries for the given `agentId`.
 */
export function findAgentEntries(
  entries: ReadonlyArray<LedgerEntry>,
  agentId: string,
): LedgerEntry[] {
  return entries.filter(
    (e): e is Extract<LedgerEntry, { type: "agent_start" }> =>
      e.type === "agent_start" && e.agentId === agentId,
  );
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/**
 * Asserts that at least one `phase_start` + `phase_end` pair exists for
 * `phaseName`, and that `phase_end` appears after `phase_start` in the
 * entry list.
 */
export function assertPhaseCompleted(
  entries: ReadonlyArray<LedgerEntry>,
  phaseName: string,
): void {
  const starts = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "phase_start" && (e as Extract<LedgerEntry, { type: "phase_start" }>).phaseName === phaseName);
  assert.ok(
    starts.length > 0,
    `assertPhaseCompleted: no phase_start entry found for phase "${phaseName}"`,
  );

  const ends = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "phase_end" && (e as Extract<LedgerEntry, { type: "phase_end" }>).phaseName === phaseName);
  assert.ok(
    ends.length > 0,
    `assertPhaseCompleted: no phase_end entry found for phase "${phaseName}"`,
  );

  const firstStartIdx = starts[0]!.i;
  const firstEndIdx = ends[0]!.i;
  assert.ok(
    firstEndIdx > firstStartIdx,
    `assertPhaseCompleted: phase_end (index ${firstEndIdx}) appears before phase_start (index ${firstStartIdx}) for phase "${phaseName}"`,
  );
}

/**
 * Asserts an `agent_start` entry exists for `agentId`, and that its
 * `promptHash` matches the sha256 of the given prompt string.
 *
 * Pass the raw author prompt (before any schema-instruction suffix).
 * Passing a RegExp throws — the ledger only stores hashes.
 */
export function assertAgentCalledWith(
  entries: ReadonlyArray<LedgerEntry>,
  agentId: string,
  promptPattern: string | RegExp,
): void {
  if (promptPattern instanceof RegExp) {
    throw new TypeError(
      `assertAgentCalledWith: RegExp patterns cannot be matched against ledger prompt hashes. ` +
      `Pass the exact prompt string instead (it will be sha256'd for comparison). ` +
      `See tests/helpers/ledgerAssertions.ts for details.`,
    );
  }

  const agentStarts = findAgentEntries(entries, agentId);
  assert.ok(
    agentStarts.length > 0,
    `assertAgentCalledWith: no agent_start entry found for agentId "${agentId}"`,
  );

  const expectedHash = sha256(promptPattern);
  const firstEntry = agentStarts[0]! as Extract<LedgerEntry, { type: "agent_start" }>;
  assert.equal(
    firstEntry.promptHash,
    expectedHash,
    `assertAgentCalledWith: agent "${agentId}" promptHash mismatch.\n` +
    `  expected hash of prompt: ${expectedHash}\n` +
    `  actual promptHash:       ${firstEntry.promptHash}`,
  );
}

/**
 * Asserts that the phase names in the ledger appear in the given order
 * (subsequence check — intervening phases are allowed).
 */
export function assertPhasesOrdered(
  entries: ReadonlyArray<LedgerEntry>,
  phaseNames: string[],
): void {
  const starts = entries
    .filter((e): e is Extract<LedgerEntry, { type: "phase_start" }> => e.type === "phase_start")
    .map((e) => e.phaseName);

  let cursor = 0;
  for (const name of phaseNames) {
    const idx = starts.indexOf(name, cursor);
    assert.ok(
      idx >= 0,
      `assertPhasesOrdered: phase "${name}" not found after position ${cursor} in phase sequence [${starts.join(", ")}]`,
    );
    cursor = idx + 1;
  }
}

// ─── File reader ─────────────────────────────────────────────────────────────

/**
 * Reads and parses a `ledger.jsonl` file, returning all well-formed entries.
 * Torn trailing lines and corrupt lines are silently dropped (same tolerances
 * as `LedgerReader`).
 */
export async function readLedgerEntries(ledgerPath: string): Promise<LedgerEntry[]> {
  let text: string;
  try {
    text = await fsp.readFile(ledgerPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return [];
    throw err;
  }

  if (text.length === 0) return [];

  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) lines.pop();

  const entries: LedgerEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (parsed && typeof (parsed as Record<string, unknown>).type === "string") {
        entries.push(parsed);
      }
    } catch {
      // Torn or corrupt — skip silently
    }
  }
  return entries;
}
