/**
 * pi-workflows — slice 15 agent detail view (pure render).
 *
 * Third-level drilldown: runs-list → phase-view → agent-detail.
 * Per PRD §10.3 wireframe and §10.5 event subscriptions.
 *
 * Pure render function — no IO, no singletons, no side effects.
 * Consumes a `AgentDetailOpts.phaseRegistry` (DI, not singleton) per
 * slice 15 carry-forward F3.
 *
 * Refs: PRD §10.3, §10.4, §10.5, §10.6, plan.md §4 Slice 15.
 */

import type { AgentSnapshot } from "./phaseRegistry.js";
import type { HelpBullet } from "./hotkeys.js";

export interface AgentDetailSnapshot {
  readonly runId: string;
  readonly phaseName: string;
  readonly agent: AgentSnapshot;
  /**
   * Live tail lines from `pi-workflows.agent.log` events.
   * Max 20 rendered. Debounced at 100 ms per PRD §10.6.
   */
  readonly logTail: ReadonlyArray<string>;
  /** Absolute path to the JSONL transcript file (if known). */
  readonly transcriptPath?: string;
}

export interface AgentDetailRender {
  readonly lines: string[];
}

export interface AgentDetailOpts {
  readonly nowMs?: number;
  readonly help?: ReadonlyArray<HelpBullet>;
  readonly banner?: string;
}

const MAX_LOG_LINES = 12;
const MAX_PROMPT_CHARS = 200;

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function agentElapsed(
  agent: AgentSnapshot,
  nowMs: number,
): string {
  if (agent.durationMs !== undefined) return fmtDurationMs(agent.durationMs);
  if (!agent.startedAt) return "—";
  const start = Date.parse(agent.startedAt);
  if (!Number.isFinite(start)) return "—";
  if (agent.endedAt) {
    const end = Date.parse(agent.endedAt);
    if (Number.isFinite(end)) return fmtDurationMs(end - start);
  }
  return fmtDurationMs(nowMs - start);
}

/**
 * Render the agent detail view to an array of text lines.
 *
 * The caller is responsible for wrapping these in box-drawing chrome
 * (the overlay does this, same as phase-view and runs-list).
 */
export function renderAgentDetail(
  snap: AgentDetailSnapshot,
  opts: AgentDetailOpts = {},
): AgentDetailRender {
  const nowMs = opts.nowMs ?? Date.now();
  const agent = snap.agent;

  const elapsed = agentElapsed(agent, nowMs);
  const stateStr = agent.state;

  // Title: runId · phaseName · agentId  state  elapsed
  const title = `${snap.runId}  ·  ${snap.phaseName}  ·  ${agent.agentId}  ${stateStr}  ${elapsed}`;

  const lines: string[] = [title];

  if (opts.banner !== undefined && opts.banner.length > 0) {
    lines.push("");
    lines.push(opts.banner);
  }

  // Prompt (first 200 chars)
  lines.push("");
  lines.push("Prompt:");
  if (agent.summary && agent.summary.length > 0) {
    const prompt = agent.summary.length > MAX_PROMPT_CHARS
      ? agent.summary.slice(0, MAX_PROMPT_CHARS) + "…"
      : agent.summary;
    // Wrap at ~72 chars per line
    let remaining = prompt;
    while (remaining.length > 0) {
      lines.push(`  ${remaining.slice(0, 72)}`);
      remaining = remaining.slice(72);
    }
  } else {
    lines.push("  (no prompt summary)");
  }

  // Transcript path
  if (snap.transcriptPath) {
    lines.push("");
    lines.push(`Transcript: ${snap.transcriptPath}`);
  }

  // Started / timing info
  lines.push("");
  if (agent.startedAt) {
    lines.push(`Started: ${agent.startedAt}   Duration: ${elapsed}`);
  }
  if (agent.cached) {
    lines.push("Cache: hit");
  }

  // Live tail
  lines.push("");
  const logCount = Math.min(MAX_LOG_LINES, snap.logTail.length);
  lines.push(`Live tail (last ${logCount > 0 ? logCount : 0} lines)`);
  if (snap.logTail.length === 0) {
    lines.push("  (no output yet)");
  } else {
    for (const l of snap.logTail.slice(-MAX_LOG_LINES)) {
      lines.push(`  ${l}`);
    }
  }

  // Help bullets
  const helpBullets = opts.help ?? [];
  if (helpBullets.length > 0) {
    lines.push("");
    const help = helpBullets
      .map((b) => (b.disabled ? `(${b.key} ${b.label})` : `[${b.key}] ${b.label}`))
      .join("  ");
    lines.push(help);
  }

  return { lines };
}
