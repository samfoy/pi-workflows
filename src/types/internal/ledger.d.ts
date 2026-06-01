/**
 * src/types/internal/ledger.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the ledger slice is needed.
 */

import type { AgentUsage } from "./dispatcher.js";

// ───────────────────────────────────────────────────────────────────────
// Slice 7 — Ledger writer + state machine + corruption-tolerant reader
// ───────────────────────────────────────────────────────────────────────

/**
 * Run state machine states (PRD §5.2). Terminal states are
 * `done | failed | stopped | cancelled-pre-run`. Resumable from disk
 * after a pi crash: `paused`, `running` (the latter treated as
 * crashed-mid-run by slice 11's resume). All other states are either
 * pre-start or terminal.
 */
export type RunState =
  | "pending"
  | "approved"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "cancelled-pre-run";

/**
 * A ledger entry's `agent_error.error` payload preserves slice 6's
 * three error classes (per critic-ndpq's slice-6 concern: ledger MUST
 * not collapse `MalformedAgentOutputError` and `AgentSubprocessError`
 * into one shape — both carry distinct forensic fields).
 *
 * Slice 8a's `runCtx` hands a thrown `Error` to the ledger; the
 * `agentErrorFromException()` helper in `runtime/ledger.ts` does the
 * concrete conversion.
 */
export type LedgerAgentError =
  | {
      readonly class: "MalformedAgentOutput";
      readonly reason: string;
      readonly lineNumber: number | null;
      /** Up to 256 bytes of the offending region (pre-truncated upstream). */
      readonly bytes: string;
      readonly exitCode: number | null;
      readonly cwd: string;
    }
  | {
      readonly class: "AgentSubprocess";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly message: string;
    }
  | {
      readonly class: "MockFixtureMissing";
      readonly promptHash: string;
      readonly runDir: string;
    }
  | {
      readonly class: "Unknown";
      readonly message: string;
      readonly name?: string;
    };

/**
 * Append-only `ledger.jsonl` entry (PRD §6.4). Discriminated by `type`.
 * Slice 7 emits `init`, `transition`, `cancelled`, `phase_*`,
 * `agent_*`, `log`, `pause`, `resume`, `shutdown`, `result`, `error`.
 *
 * Field-shape rule: every entry carries `at` (ISO timestamp) at the
 * top level. `transition.reason` is set on involuntary transitions
 * (e.g. crash sweep emits `reason: "parent-crash"` per PRD §5.8.2).
 * `result.result` is the pre-truncated stringified value (≤4KB);
 * `truncated: true` flags the trim — see PRD §6.4 row "result".
 */
export type LedgerEntry =
  | {
      readonly type: "init";
      readonly at: string;
      /** Mirrors `manifest.json`. Plan §4 Slice 7 acceptance criterion. */
      readonly manifest: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "transition";
      readonly at: string;
      readonly from: RunState;
      readonly to: RunState;
      readonly reason?: string;
    }
  | {
      readonly type: "cancelled";
      readonly at: string;
      /** "user-N" = user pressed [N] in approval; "disabled" = mid-prompt disable. */
      readonly cause: "user-N" | "disabled";
    }
  | {
      readonly type: "phase_start";
      readonly at: string;
      readonly phaseName: string;
      readonly agentCount: number;
    }
  | {
      readonly type: "phase_end";
      readonly at: string;
      readonly phaseName: string;
      readonly durationMs: number;
      /** Counts only — never raw text per PRD §6.4. */
      readonly agentResults: { readonly ok: number; readonly error: number; readonly cacheHit: number };
    }
  | {
      readonly type: "agent_start";
      readonly at: string;
      readonly phaseName: string;
      readonly agentId: string;
      readonly promptHash: string;
    }
  | {
      readonly type: "agent_end";
      readonly at: string;
      readonly phaseName: string;
      readonly agentId: string;
      readonly durationMs: number;
      readonly usage: AgentUsage;
      readonly cached: boolean;
    }
  | {
      readonly type: "agent_error";
      readonly at: string;
      readonly phaseName: string;
      readonly agentId: string;
      readonly error: LedgerAgentError;
    }
  | {
      readonly type: "agent_cache_hit";
      readonly at: string;
      readonly phaseName: string;
      readonly agentId: string;
    }
  | {
      readonly type: "log";
      readonly at: string;
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    }
  | { readonly type: "pause"; readonly at: string; readonly reason?: string }
  | { readonly type: "resume"; readonly at: string; readonly reason?: string }
  | { readonly type: "shutdown"; readonly at: string; readonly graceful: boolean }
  | {
      readonly type: "result";
      readonly at: string;
      readonly truncated: boolean;
      /** Stringified `main()` resolution; ≤4KB after upstream truncate. */
      readonly result: string;
    }
  | {
      readonly type: "error";
      readonly at: string;
      readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
    }
  | {
      readonly type: "checkpoint_set";
      readonly at: string;
      readonly label: string;
    }
  | {
      readonly type: "checkpoint_hit";
      readonly at: string;
      readonly label: string;
    }
  | {
      readonly type: "report";
      readonly at: string;
      readonly event: string;
      readonly data?: unknown;
    }
  | {
      readonly type: "agent_log";
      readonly at: string;
      readonly agentId: string;
      readonly phaseName: string;
      readonly level: string;
      readonly message: string;
    }
  | { readonly type: "gate_requested"; readonly at: string; readonly message: string }
  | { readonly type: "gate_resolved"; readonly at: string; readonly approved: boolean }
  | {
      /**
       * ZONE_HITL — `ctx.interrupt(...)` request. Written when a workflow
       * suspends mid-phase asking a supervisor for an answer. `key` is a
       * deterministic, run-scoped sequence id (`int-0`, `int-1`, ...) so
       * a resumed run can match prior `interrupt_resolved` entries to
       * the same call site (replay-perfect HITL).
       */
      readonly type: "interrupt_requested";
      readonly at: string;
      readonly key: string;
      readonly question: string;
      readonly choices?: ReadonlyArray<string>;
      readonly default?: unknown;
    }
  | {
      /**
       * ZONE_HITL — supervisor answered (or default applied). `value`
       * is the JSON-cloneable answer returned to the workflow. `source`
       * distinguishes how the answer was produced — useful for the TUI
       * and for diagnosing replays:
       *   - `"ipc"`     — supervisor injected via `ctrl.jsonl`.
       *   - `"default"` — no supervisor wired; `opts.default` was used.
       *   - `"replay"`  — resumed run found a prior `interrupt_resolved`
       *                   for this `key` and skipped the prompt.
       */
      readonly type: "interrupt_resolved";
      readonly at: string;
      readonly key: string;
      readonly value: unknown;
      readonly source: "ipc" | "default" | "replay";
    }
  | {
      /**
       * IPC inspection surface (gap/ipc-inspection): a verbatim copy of a
       * `pi.appendEntry` event written into the run ledger so that a
       * supervisor process can observe all overlay events by tailing
       * `ledger.jsonl` alone. Only events whose payload contains a `runId`
       * field are routed here.
       */
      readonly type: "appendEntry";
      readonly at: string;
      readonly customType: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      /**
       * ZONE_TIMETRAVEL polish — emitted on resume start when the run
       * was created via `forkFromCheckpoint`. Carries the lineage so
       * observability tools (overlay, OTel exporter, third-party tail
       * readers) can render "fork of <parentRunId> at <forkAtPhase>"
       * without having to re-read the manifest. Written exactly once
       * per resume — directly after the `resume` entry.
       */
      readonly type: "fork_lineage";
      readonly at: string;
      readonly parentRunId: string;
      readonly forkAtPhase: string;
    };

/**
 * Reader output from `LedgerReader.read()`. Shape designed for slice 11
 * (resume-from-disk) and slice 13 (TUI overlay tail) consumers.
 */
export interface LedgerReadResult {
  /**
   * Every well-formed entry, in file order. Torn trailing lines are
   * silently dropped (matches `cache.jsonl` invariant). Mid-file
   * corruption is surfaced as a warning + skipped — slice 11 may opt
   * to refuse resume on `warnings.length > 0`; slice 7 stays
   * tolerant per plan.md §4 Slice 7's reader acceptance.
   */
  readonly entries: ReadonlyArray<LedgerEntry>;
  /**
   * Final state derived by replaying every `transition` entry from
   * the implicit `pending` start. If no transitions are present, the
   * state stays `pending`. Invalid transitions (per `RunStateMachine`
   * validator) are SKIPPED with a warning — `finalState` reflects the
   * last *valid* transition. This is plan §4 Slice 7 acceptance #3.
   */
  readonly finalState: RunState;
  /** Diagnostic warnings: torn-tail, corrupt JSON, illegal transition. */
  readonly warnings: ReadonlyArray<LedgerWarning>;
}

export type LedgerWarning =
  | { readonly kind: "torn-tail"; readonly lineIndex: number }
  | { readonly kind: "corrupt-line"; readonly lineIndex: number; readonly error: string }
  | { readonly kind: "non-object"; readonly lineIndex: number }
  | { readonly kind: "unknown-type"; readonly lineIndex: number; readonly recordType: string }
  | { readonly kind: "invalid-transition"; readonly lineIndex: number; readonly from: RunState; readonly to: string };

/**
 * Optional sink for ledger-emitted warnings. Mirrors `CacheLogSink`
 * (slice 3) so slice 8a's `runCtx.log` plumbing wires both with the
 * same callable shape.
 */
export type LedgerLogSink = (
  level: "info" | "warn" | "error",
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

