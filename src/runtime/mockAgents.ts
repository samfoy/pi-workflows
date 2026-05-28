/**
 * pi-workflows — `--mock-agents` fixture loader (slice 6).
 *
 * Reads `<runDir>/fixtures.jsonl`. Each line is a `MockFixture`:
 *
 *   {"agentId":"audit","promptHash":"abc…","result":{"text":"…"}}
 *
 * The dispatcher's mock branch looks up `(agentId, promptHash)` and:
 *   - returns a synthesized `AgentResult` if found (still through the
 *     semaphore, still tee'd to `<runDir>/agents/<agentId>.jsonl` so
 *     downstream consumers like slice 13's transcript view see
 *     byte-equivalent output between mock + real runs).
 *   - rejects with `MockFixtureMissingError` if not — fail loud, not
 *     silent hang.
 *
 * Why no caching of the parsed file: a workflow's mock fixtures fit
 * in a few KB; re-reading per dispatch keeps the implementation
 * stateless across resume.
 *
 * Malformed lines are SKIPPED (with a single warning to the optional
 * log sink) rather than fatal — we want author-friendly behavior here,
 * not the ledger-grade strictness of `cache.jsonl`. A typo in one
 * fixture shouldn't take down the whole mock run.
 */

import { promises as fs } from "node:fs";

import type { AgentResult, AgentUsage, MockFixture } from "../types/internal.js";
import { MockFixtureMissingError } from "./errors.js";
import {
  agentTranscriptPath as agentTranscriptPathBy,
  agentsDir as agentsDirBy,
  fixturesPath as fixturesPathBy,
} from "../util/paths.js";

/** Default usage block for fixtures that don't specify any. */
export const ZERO_USAGE: AgentUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

/**
 * Read every fixture line into memory. Returns the keyed index plus the
 * count of skipped (malformed) lines for logging.
 */
export async function loadFixtures(
  runDirAbs: string,
): Promise<{ index: ReadonlyMap<string, MockFixture>; skipped: number; raw: ReadonlyArray<string> }> {
  const path = fixturesPathBy(runDirAbs, true);
  let buf: string;
  try {
    buf = await fs.readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { index: new Map(), skipped: 0, raw: [] };
    }
    throw err;
  }
  const lines = buf.split(/\r?\n/);
  const out = new Map<string, MockFixture>();
  const raw: string[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).agentId !== "string" ||
      typeof (parsed as Record<string, unknown>).promptHash !== "string"
    ) {
      skipped += 1;
      continue;
    }
    const fixture = parsed as MockFixture;
    out.set(fixtureKey(fixture.agentId, fixture.promptHash), fixture);
    raw.push(line);
  }
  return { index: out, skipped, raw };
}

/** Composite key used to look up fixtures. Stable; tests rely on it. */
export function fixtureKey(agentId: string, promptHash: string): string {
  return `${agentId}\u0000${promptHash}`;
}

/**
 * Look up a single fixture and synthesize an `AgentResult`. Tees the
 * fixture's `events` (if any) to `<runDir>/agents/<agentId>.jsonl` so
 * downstream callers can read the transcript identically to a real run.
 *
 * Throws `MockFixtureMissingError` if no matching fixture exists.
 */
export async function resolveMockAgent(opts: {
  runDirAbs: string;
  agentId: string;
  promptHash: string;
}): Promise<AgentResult> {
  const { index } = await loadFixtures(opts.runDirAbs);
  const hit = index.get(fixtureKey(opts.agentId, opts.promptHash));
  if (!hit) {
    throw new MockFixtureMissingError({
      agentId: opts.agentId,
      promptHash: opts.promptHash,
      runDir: opts.runDirAbs,
    });
  }
  const transcriptPath = agentTranscriptPathBy(opts.runDirAbs, opts.agentId);
  await fs.mkdir(agentsDirBy(opts.runDirAbs, true), { recursive: true });
  if (hit.events && hit.events.length > 0) {
    const lines = hit.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(transcriptPath, lines, "utf8");
  } else {
    // Empty transcript — still create the file so callers can stat it.
    await fs.writeFile(transcriptPath, "", "utf8");
  }
  const usage: AgentUsage = {
    input: hit.result.usage?.input ?? 0,
    output: hit.result.usage?.output ?? 0,
    cacheRead: hit.result.usage?.cacheRead ?? 0,
    cacheWrite: hit.result.usage?.cacheWrite ?? 0,
    totalTokens: hit.result.usage?.totalTokens ?? 0,
  };
  return {
    ok: true,
    agentId: hit.agentId,
    text: hit.result.text,
    usage,
    toolCalls: hit.result.toolCalls ?? 0,
    durationMs: hit.result.durationMs ?? 0,
    transcriptPath,
    exitCode: hit.result.exitCode ?? null,
  };
}
