/**
 * pi-workflows — DAG / phase-graph visualization (gap/viz).
 *
 * Renders a Mermaid `flowchart TD` diagram for a single run, derived
 * from its on-disk artefacts:
 *
 *   - `<runDir>/manifest.json` — for the title (`workflowName`,
 *     `runId`, `input`).
 *   - `<runDir>/ledger.jsonl`  — for phases, agents, durations, and
 *     final state.
 *
 * The renderer is strictly a transform — it never spawns agents, never
 * dispatches anything, and never writes files. The TUI hotkey wrapper
 * in `workflowCmd.ts` is responsible for writing the result to a tmp
 * file and surfacing the path.
 *
 * Three entry points:
 *
 *   1. `renderMermaidFromData({ manifest, entries })` — pure transform,
 *      no IO. Used by tests and by the `ctx.report({format:'mermaid'})`
 *      accessor (which already has the live ledger writer's path
 *      available).
 *
 *   2. `renderMermaid(runDirAbs)` — async wrapper that reads the
 *      manifest + ledger off disk and forwards to the pure transform.
 *      Used by the TUI hotkey.
 *
 *   3. `writeMermaidToTmp(runDirAbs)` — writes the rendered diagram to
 *      `os.tmpdir()/pi-workflows-viz-<runId>-<ts>.mmd` and returns the
 *      absolute path. Wraps `renderMermaid`.
 *
 * Output shape (one phase per `subgraph`, one agent per node):
 *
 * ```mermaid
 * flowchart TD
 *   %% Run wf-abc — codebase-audit
 *   Start([Start])
 *   Start --> P0
 *   subgraph P0 [discover · 7100ms · ok=3]
 *     P0_A0[discover-1 · ok · 4990ms]
 *     P0_A1[discover-2 · ok · 5989ms]
 *     P0_A2[discover-3 · ok · 6988ms]
 *   end
 *   P0 --> P1
 *   subgraph P1 [audit · 9900ms · ok=1]
 *     P1_A0[audit-1 · ok · 9790ms]
 *   end
 *   P1 --> End
 *   End([Done])
 * ```
 *
 * Robustness: agent-ids and phase-names are sanitized for Mermaid
 * (only `[A-Za-z0-9_]` survive in node ids; the original strings are
 * always rendered as labels with quoting). Truncated/torn ledgers are
 * tolerated — `LedgerReader` already drops malformed lines and our
 * pass tolerates phases that started but never ended (rendered as
 * `· running`).
 *
 * Refs: gap/viz, plan.md §4 Slice 7 (ledger reader contract).
 */

import { promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LedgerEntry } from "../types/internal.js";
import { LedgerReader } from "./ledger.js";
import { ledgerPath } from "../util/paths.js";

/** Subset of `RunManifest` the renderer actually reads. */
export interface VizManifestLike {
  readonly runId?: string;
  readonly workflowName?: string;
  readonly input?: string;
}

export interface RenderMermaidInput {
  readonly manifest: VizManifestLike;
  readonly entries: ReadonlyArray<LedgerEntry>;
}

interface AgentRow {
  readonly agentId: string;
  status: "running" | "ok" | "error" | "cache-hit";
  startMs?: number | undefined;
  endMs?: number | undefined;
  durationMs?: number | undefined;
}

interface PhaseRow {
  readonly phaseName: string;
  agentCount: number;
  startMs?: number | undefined;
  endMs?: number | undefined;
  durationMs?: number | undefined;
  ok: number;
  error: number;
  cacheHit: number;
  ended: boolean;
  /** Insertion order matters — Mermaid renders subgraph children top-down. */
  agentsByOrder: AgentRow[];
  agentsById: Map<string, AgentRow>;
}

/**
 * Pure transform — no IO, no clock, deterministic given inputs.
 * Returns a Mermaid `flowchart TD` string with a trailing newline.
 */
export function renderMermaidFromData(input: RenderMermaidInput): string {
  const { manifest, entries } = input;
  const phases: PhaseRow[] = [];
  const phaseByName = new Map<string, PhaseRow>();
  let finalState: string | null = null;

  const ensurePhase = (name: string): PhaseRow => {
    let p = phaseByName.get(name);
    if (!p) {
      p = {
        phaseName: name,
        agentCount: 0,
        ok: 0,
        error: 0,
        cacheHit: 0,
        ended: false,
        agentsByOrder: [],
        agentsById: new Map<string, AgentRow>(),
      };
      phases.push(p);
      phaseByName.set(name, p);
    }
    return p;
  };

  const ensureAgent = (phase: PhaseRow, agentId: string): AgentRow => {
    let a = phase.agentsById.get(agentId);
    if (!a) {
      a = { agentId, status: "running" };
      phase.agentsById.set(agentId, a);
      phase.agentsByOrder.push(a);
    }
    return a;
  };

  const tsToMs = (iso: string | undefined): number | undefined => {
    if (typeof iso !== "string") return undefined;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : undefined;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "phase_start": {
        const p = ensurePhase(entry.phaseName);
        p.startMs = tsToMs(entry.at);
        p.agentCount = Math.max(p.agentCount, entry.agentCount);
        break;
      }
      case "phase_end": {
        const p = ensurePhase(entry.phaseName);
        p.endMs = tsToMs(entry.at);
        p.durationMs = entry.durationMs;
        p.ok = entry.agentResults.ok;
        p.error = entry.agentResults.error;
        p.cacheHit = entry.agentResults.cacheHit;
        p.ended = true;
        break;
      }
      case "agent_start": {
        const p = ensurePhase(entry.phaseName);
        const a = ensureAgent(p, entry.agentId);
        a.startMs = tsToMs(entry.at);
        break;
      }
      case "agent_end": {
        const p = ensurePhase(entry.phaseName);
        const a = ensureAgent(p, entry.agentId);
        a.endMs = tsToMs(entry.at);
        a.durationMs = entry.durationMs;
        // Don't downgrade an existing error/cache-hit to ok.
        if (a.status === "running") a.status = "ok";
        break;
      }
      case "agent_error": {
        const p = ensurePhase(entry.phaseName);
        const a = ensureAgent(p, entry.agentId);
        a.endMs = tsToMs(entry.at);
        a.status = "error";
        break;
      }
      case "agent_cache_hit": {
        const p = ensurePhase(entry.phaseName);
        const a = ensureAgent(p, entry.agentId);
        if (a.status !== "error") a.status = "cache-hit";
        break;
      }
      case "transition": {
        // Track the last transition's `to` so the End node can label
        // the final state. Replay-tolerant: even illegal transitions
        // still update finalState (the LedgerReader filters those).
        finalState = entry.to;
        break;
      }
      default:
        break;
    }
  }

  return emitMermaid({ manifest, phases, finalState });
}

/**
 * Read `<runDir>/manifest.json` + `<runDir>/ledger.jsonl` and return
 * the rendered diagram. Tolerates a missing manifest (renders with
 * the runDir basename as a fallback title). Throws if the runDir
 * itself can't be stat'd.
 */
export async function renderMermaid(runDirAbs: string): Promise<string> {
  if (typeof runDirAbs !== "string" || runDirAbs.length === 0) {
    throw new TypeError("renderMermaid: runDirAbs must be a non-empty string");
  }
  const manifestPath = join(runDirAbs, "manifest.json");
  let manifest: VizManifestLike = {};
  try {
    const buf = await fs.readFile(manifestPath, "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifest = parsed as VizManifestLike;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // Corrupt manifest is non-fatal for visualization — we still
      // have the ledger. Fall through with the empty manifest.
    }
  }
  // The reader resolves via the helper if we don't override; runDirAbs
  // is the canonical source so we point at `<runDir>/ledger.jsonl`
  // directly.
  const reader = new LedgerReader({
    runId: "viz-runner",
    resolveLedgerPath: () => ledgerPath(runDirAbs, true),
  });
  const { entries } = await reader.read();
  return renderMermaidFromData({ manifest, entries });
}

/**
 * Render the diagram for `runDirAbs` and write it to a tmp file.
 * Returns the absolute path of the file. The caller is expected to
 * surface the path to the user (e.g. via `pi.notify` or a card) and
 * the OS / user is responsible for cleanup.
 *
 * Filename shape: `pi-workflows-viz-<runIdOrBasename>-<unixMs>.mmd`.
 */
export async function writeMermaidToTmp(
  runDirAbs: string,
  opts?: { readonly tmpDir?: string; readonly nowMs?: () => number },
): Promise<string> {
  const dir = opts?.tmpDir ?? tmpdir();
  const now = opts?.nowMs ?? Date.now;
  const text = await renderMermaid(runDirAbs);
  // Try to read runId from the manifest for a nice filename; fall
  // back to runDir basename if unavailable. Any failure is non-fatal
  // — the diagram has already rendered.
  let runId = "";
  try {
    const buf = await fs.readFile(join(runDirAbs, "manifest.json"), "utf8");
    const parsed = JSON.parse(buf) as { runId?: unknown };
    if (typeof parsed.runId === "string") runId = parsed.runId;
  } catch {
    /* fall through */
  }
  if (runId.length === 0) {
    const parts = runDirAbs.split(/[\\/]/);
    runId = parts[parts.length - 1] || "run";
  }
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "_");
  const target = join(dir, `pi-workflows-viz-${safe}-${now()}.mmd`);
  await fs.writeFile(target, text, { encoding: "utf8", mode: 0o644 });
  return target;
}

/**
 * Synchronous variant of {@link renderMermaid}. Reads the manifest
 * and ledger with `readFileSync`, then forwards to the pure transform.
 *
 * Intended for the sandbox-side `ctx.report({format:'mermaid'})`
 * accessor where the bridge expects a sync return value. Both files
 * are small (manifest ≤ ~2KB, ledger ≤ a few MB) so the cost is
 * negligible.
 *
 * Tolerances mirror the async path: missing manifest is non-fatal,
 * missing/empty ledger renders an "empty run" diagram.
 */
export function renderMermaidSync(runDirAbs: string): string {
  if (typeof runDirAbs !== "string" || runDirAbs.length === 0) {
    throw new TypeError(
      "renderMermaidSync: runDirAbs must be a non-empty string",
    );
  }
  let manifest: VizManifestLike = {};
  try {
    const buf = readFileSync(join(runDirAbs, "manifest.json"), "utf8");
    if (buf.trim().length > 0) {
      const parsed = JSON.parse(buf) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifest = parsed as VizManifestLike;
      }
    }
  } catch {
    /* fall through with empty manifest */
  }
  /** 32 MiB guard — prevents event-loop block and unbounded allocation on large ledgers. */
  const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
  const entries: LedgerEntry[] = [];
  try {
    const lPath = ledgerPath(runDirAbs, true);
    let fileSize = 0;
    try {
      fileSize = statSync(lPath).size;
    } catch {
      /* file absent — fall through to empty entries */
    }
    if (fileSize > MAX_LEDGER_BYTES) {
      // Ledger too large to read synchronously; return a stub diagram.
      return [
        "flowchart TD",
        `  warn["⚠️ ledger too large to render (${(fileSize / 1024 / 1024).toFixed(1)} MiB > 32 MiB limit)"]`,
      ].join("\n");
    }
    const text = readFileSync(lPath, "utf8");
    if (text.length > 0) {
      const endsWithNewline = text.endsWith("\n");
      const parts = text.split("\n");
      if (endsWithNewline) parts.pop();
      for (const raw of parts) {
        const line = raw ?? "";
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            typeof (parsed as { type?: unknown }).type === "string"
          ) {
            entries.push(parsed as LedgerEntry);
          }
        } catch {
          // Best-effort: a torn or corrupt line just means a few
          // missing nodes — the diagram is forensic, not load-bearing.
        }
      }
    }
  } catch {
    /* fall through with empty entries */
  }
  return renderMermaidFromData({ manifest, entries });
}

// ─── Mermaid emission ──────────────────────────────────────────────────

/** Hard cap on rendered phases to prevent O(P×A) blowup. */
const MAX_PHASES = 100;
/** Hard cap on rendered agents per phase to prevent O(P×A) blowup. */
const MAX_AGENTS_PER_PHASE = 50;

interface EmitInput {
  readonly manifest: VizManifestLike;
  readonly phases: ReadonlyArray<PhaseRow>;
  readonly finalState: string | null;
}

function emitMermaid(input: EmitInput): string {
  const { manifest, phases, finalState } = input;
  const lines: string[] = [];
  lines.push("flowchart TD");

  // Header comment carries non-graph metadata so consumers can grep
  // for it without parsing the diagram.
  const headerBits: string[] = [];
  if (manifest.runId) headerBits.push(`run=${escapeLabel(String(manifest.runId))}`);
  if (manifest.workflowName) headerBits.push(`workflow=${escapeLabel(String(manifest.workflowName))}`);
  if (manifest.input) headerBits.push(`input=${escapeLabel(truncate(String(manifest.input), 60))}`);
  if (headerBits.length > 0) {
    lines.push(`  %% ${headerBits.join(" · ")}`);
  }

  // Start node — always.
  const startLabel = manifest.workflowName
    ? `Start: ${escapeStadiumLabel(manifest.workflowName)}`
    : "Start";
  lines.push(`  Start([${startLabel}])`);

  if (phases.length === 0) {
    // No phases recorded. Edge straight to End so the diagram still
    // renders. Useful for runs that errored before phase 1.
    const endLabel = finalState ?? "no phases";
    lines.push(`  Start --> End`);
    lines.push(`  End([${escapeStadiumLabel(endLabel)}])`);
    return lines.join("\n") + "\n";
  }

  // Edges + subgraphs — capped to prevent O(P×A) blowup.
  const renderedPhaseCount = Math.min(phases.length, MAX_PHASES);
  const phasesTruncated = phases.length > MAX_PHASES;

  lines.push(`  Start --> P0`);
  for (let i = 0; i < renderedPhaseCount; i++) {
    const p = phases[i]!;
    const phaseLabel = phaseLabelFor(p);
    lines.push(`  subgraph P${i} ["${escapeLabel(phaseLabel)}"]`);
    const renderedAgentCount = Math.min(p.agentsByOrder.length, MAX_AGENTS_PER_PHASE);
    const agentsTruncated = p.agentsByOrder.length > MAX_AGENTS_PER_PHASE;
    if (p.agentsByOrder.length === 0) {
      // Empty phase — emit a single placeholder so the subgraph isn't
      // syntactically empty (some Mermaid renderers reject empty
      // subgraphs).
      lines.push(`    P${i}_empty[" "]`);
    } else {
      for (let j = 0; j < renderedAgentCount; j++) {
        const a = p.agentsByOrder[j]!;
        lines.push(`    P${i}_A${j}["${escapeLabel(agentLabelFor(a))}"]`);
      }
      if (agentsTruncated) {
        lines.push(
          `    P${i}_trunc["… ${p.agentsByOrder.length - MAX_AGENTS_PER_PHASE} more agents (truncated)"]`,
        );
      }
    }
    lines.push(`  end`);
    if (i + 1 < renderedPhaseCount) {
      lines.push(`  P${i} --> P${i + 1}`);
    }
  }

  // Final edge to End — route through truncation node when phases were capped.
  const endIdx = renderedPhaseCount - 1;
  const endLabel = finalState ?? "in-progress";
  if (phasesTruncated) {
    lines.push(`  P${endIdx} --> PTrunc`);
    lines.push(
      `  PTrunc["… ${phases.length - MAX_PHASES} more phases (truncated)"]`,
    );
    lines.push(`  PTrunc --> End`);
  } else {
    lines.push(`  P${endIdx} --> End`);
  }
  lines.push(`  End([${escapeStadiumLabel(endLabel)}])`);

  return lines.join("\n") + "\n";
}

function phaseLabelFor(p: PhaseRow): string {
  const bits: string[] = [p.phaseName];
  if (p.ended) {
    if (typeof p.durationMs === "number") bits.push(`${p.durationMs}ms`);
    const counts: string[] = [];
    if (p.ok > 0) counts.push(`ok=${p.ok}`);
    if (p.error > 0) counts.push(`err=${p.error}`);
    if (p.cacheHit > 0) counts.push(`hit=${p.cacheHit}`);
    if (counts.length > 0) bits.push(counts.join(" "));
  } else {
    bits.push("running");
  }
  return bits.join(" · ");
}

function agentLabelFor(a: AgentRow): string {
  const bits: string[] = [a.agentId, a.status];
  if (typeof a.durationMs === "number") bits.push(`${a.durationMs}ms`);
  return bits.join(" · ");
}

/**
 * Mermaid label escaping. Inside a quoted-bracket label `["..."]`,
 * the only character we MUST escape is `"`. We also strip control
 * chars (anything < 0x20 except space) so a malformed agentId can't
 * inject newlines into the diagram.
 */
function escapeLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F]/g, " ").replace(/"/g, "'");
}

/**
 * Escape a label for use inside a Mermaid stadium-shape node `([...])`.
 * The closing delimiter is `])`, so `]` must be escaped to prevent
 * premature node termination. Also strips control chars.
 */
function escapeStadiumLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F]/g, " ").replace(/\]/g, "&#93;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
