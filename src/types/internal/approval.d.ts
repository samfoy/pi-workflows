/**
 * src/types/internal/approval.d.ts — split from src/types/internal.d.ts
 * post-2026-audit type-cluster refactor. The barrel at
 * src/types/internal.d.ts re-exports every symbol defined here, so
 * existing `import { ... } from "../types/internal.js"` paths
 * keep working without churn. New code can import directly from this
 * file when only the approval slice is needed.
 */

// ───────────────────────────────────────────────────────────────────────
// Slice 9 — Approval flow + trust storage + bypass + announce banner
// ───────────────────────────────────────────────────────────────────────

/** Single trust row per `(absPath, sha256)` per PRD §7.2 (slice-2 revision). */
export interface TrustEntry {
  readonly name: string;
  readonly sha256: string;
}

/** Project | personal scope per PRD §7. */
export type TrustScope = "project" | "personal";

/**
 * Merged-view trust store mapping `absPath → [TrustEntry, ...]`. Layered
 * project-then-personal (project wins on conflict) at load time. Pure
 * data; readers/lookups are sync helpers.
 */
export type TrustStore = Record<string, ReadonlyArray<TrustEntry>>;

/**
 * Result of `checkBypass`. `bypass=true` short-circuits the approval
 * dialog. `error` is set ONLY when `bypass=false` AND the bypass
 * detector decided to actively reject the run (currently only the
 * `pi -p` strict-mode untrusted case per PRD §7.4.1).
 */
export interface BypassResult {
  readonly bypass: boolean;
  /**
   * Why bypass triggered (or `null` when the detector punted to the
   * dialog). `pi-p-untrusted` is paired with `bypass=false + error`.
   */
  readonly reason:
    | "bypass-permissions"
    | "pi-p-trusted"
    | "pi-p-untrusted"
    | "sdk"
    | "mock-agents"
    | null;
  /** Loud banner text — only emitted for `--bypass-permissions`. */
  readonly banner?: string;
  /** When `bypass=false` AND the detector wants to deny the run loudly. */
  readonly error?: string;
}

/**
 * 4-button outcome per PRD §3.4. The `view` outcome causes the gate
 * to invoke `viewer(absPath)` and re-prompt; only the other three
 * are terminal.
 */
export type ApprovalDialogOutcome = "run-once" | "always" | "view" | "no";

/** Args to the approval dialog adapter (test seam + ctx.ui binding). */
export interface ApprovalDialogPrompt {
  readonly workflowName: string;
  readonly absPath: string;
  readonly sha256: string;
  /** Set when `absPath` had prior trust rows but none matched `sha256`. */
  readonly mismatchWarning?: string;
  /** Declared phases from `meta.phases` — shown in approval caution. */
  readonly phases?: ReadonlyArray<{ title: string }>;
}

export type ApprovalDialog = (
  prompt: ApprovalDialogPrompt,
) => Promise<ApprovalDialogOutcome>;

/**
 * Decision returned by `runApprovalGate`. `approved=true` paths carry
 * a `reason` indicating where the green light came from; the run
 * manager forwards this into the manifest's `trustedAtStart` and
 * (slice 10) into the result-card details.
 *
 * `approved=false` carries a `cancelCause` matching the `cancelled`
 * ledger entry's vocabulary (PRD §6.4).
 */
export type ApprovalDecision =
  | {
      readonly approved: true;
      /**
       * Where the approval came from. `trusted` = pre-existing
       * `(absPath, sha256)` row in trustStore. `user-always` /
       * `user-once` = dialog outcome. `bypass-permissions` / `sdk` /
       * `pi-p-trusted` / `mock-agents` = bypass paths.
       */
      readonly reason:
        | "trusted"
        | "user-always"
        | "user-once"
        | "bypass-permissions"
        | "sdk"
        | "pi-p-trusted"
        | "mock-agents";
      /** Set when `bypass-permissions` fires (PRD §7.5 mandates a banner). */
      readonly banner?: string;
      /** True iff `addTrust()` wrote a row this gate call. */
      readonly persisted: boolean;
      /** Where the row was written when `persisted=true`. */
      readonly scope?: TrustScope;
    }
  | {
      readonly approved: false;
      readonly reason: "user-N" | "pi-p-untrusted";
      readonly cancelCause: "user-N" | "disabled";
      /** Optional surface-able message — currently only pi-p strict mode. */
      readonly error?: string;
    };

export interface ApprovalGateOptions {
  readonly workflowName: string;
  readonly absPath: string;
  readonly sha256: string;
  readonly cwd: string;
  readonly home?: string;
  /** `--mock-agents` runtime flag forwarded to bypass detector. */
  readonly mockAgents?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Declared phases from `meta.phases` — forwarded to the dialog prompt. */
  readonly phases?: ReadonlyArray<{ title: string }>;

  /** Test seam: bypass disk read of trustStore. */
  readonly trustOverride?: TrustStore;
  /** Test seam: override settings paths. */
  readonly projectSettingsPathOverride?: string;
  readonly personalSettingsPathOverride?: string;

  /** Required adapter for the [Y/A/V/N] outcomes. */
  readonly dialog: ApprovalDialog;
  /** Invoked when the user picks `view`; awaits before re-prompting. */
  readonly viewer: (absPath: string) => Promise<void> | void;
  /** Surface persistence I/O failures (non-fatal). */
  readonly onPersistError?: (e: unknown) => void;
}

