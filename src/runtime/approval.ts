/**
 * pi-workflows — slice 9 approval gate.
 *
 * Glues bypass detection (`bypass.ts`) and trust storage
 * (`trustStore.ts`) into a single `runApprovalGate(opts)` entry point
 * the RunManager calls before transitioning `pending → approved` (or
 * `pending → cancelled-pre-run`).
 *
 * Decision flow:
 *
 *   1. checkBypass() — `--bypass-permissions`, `pi -p`, SDK, mock-agents.
 *      a. bypass=true → APPROVE (with optional banner).
 *      b. bypass=false + error (e.g. `pi -p` untrusted) → DENY.
 *      c. bypass=false + no error → fall through.
 *   2. Hash-aware trust check — if the file's `(absPath, sha256)` is
 *      already trusted → APPROVE silently. PRD §7.2: hash mismatch
 *      always re-prompts (slice-2 revision adversarial-commit defense).
 *   3. Show the 4-button dialog via the supplied `dialog` adapter.
 *      Outcomes: `run-once` | `always` | `view` | `no`.
 *      a. `run-once`            → APPROVE (no persistence).
 *      b. `always`              → persist via addTrust() then APPROVE.
 *      c. `view`                → invoke `viewer(absPath)`, then re-prompt.
 *      d. `no`                  → DENY.
 *
 * The dialog adapter is intentionally a `(prompt) => Promise<outcome>`
 * function so:
 *   - real pi can wire it to `ctx.ui.custom`-driven 4-button overlay
 *     (slice 13 owns the rich custom component);
 *   - tests can substitute a script `({ choices }) => choices[0]`.
 *
 * Banner emission is the CALLER's job. `runApprovalGate` returns the
 * banner text (when bypass=true and a banner applies) so `runManager`
 * + `workflowCmd` can render it via `pi.sendMessage` at the right
 * moment (must be visible BEFORE the run starts, per PRD §7.5).
 */

import { sha256 as hashOf } from "../util/hash.js";
import { addTrust, isTrustedIn, loadTrust } from "./trustStore.js";
import { checkBypass } from "./bypass.js";

import type {
  ApprovalDecision,
  ApprovalDialog,
  ApprovalDialogOutcome,
  ApprovalDialogPrompt,
  ApprovalGateOptions,
  TrustScope,
  TrustStore,
} from "../types/internal.js";

// ─── Public surface ──────────────────────────────────────────────

/**
 * Hard cap on how many `view` re-prompt cycles we'll tolerate before
 * bailing out with `no`. PRD doesn't pin this; the cap exists to
 * ensure the test suite can never hang on a buggy adapter that always
 * returns `view`. 10 is generous for a human; an adapter returning
 * `view` 10× in a row is a programming error.
 */
const VIEW_REPROMPT_LIMIT = 10;

export async function runApprovalGate(
  opts: ApprovalGateOptions,
): Promise<ApprovalDecision> {
  const env = opts.env ?? process.env;

  // Step 1: load trust (once per gate call) — bypass needs it for
  // pi-p strict mode, dialog needs it for hash-mismatch warning.
  const trust: TrustStore = opts.trustOverride
    ? opts.trustOverride
    : await loadTrust({
        cwd: opts.cwd,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.projectSettingsPathOverride !== undefined
          ? { projectSettingsPathOverride: opts.projectSettingsPathOverride }
          : {}),
        ...(opts.personalSettingsPathOverride !== undefined
          ? {
              personalSettingsPathOverride: opts.personalSettingsPathOverride,
            }
          : {}),
      });

  // Step 2: bypass.
  const bypass = checkBypass({
    env,
    trust,
    absPath: opts.absPath,
    sha256: opts.sha256,
    ...(opts.mockAgents !== undefined ? { mockAgents: opts.mockAgents } : {}),
  });

  if (bypass.bypass) {
    // bypass.reason narrowed: anything bypass=true sets is one of
    // bypass-permissions | pi-p-trusted | sdk | mock-agents.
    const r = bypass.reason as
      | "bypass-permissions"
      | "pi-p-trusted"
      | "sdk"
      | "mock-agents";
    return {
      approved: true,
      reason: r,
      ...(bypass.banner !== undefined ? { banner: bypass.banner } : {}),
      persisted: false,
    };
  }

  if (bypass.error !== undefined) {
    return {
      approved: false,
      reason: "pi-p-untrusted",
      cancelCause: "user-N",
      error: bypass.error,
    };
  }

  // Step 3: hash-aware trust check.
  if (isTrustedIn(trust, opts.absPath, opts.sha256)) {
    return {
      approved: true,
      reason: "trusted",
      persisted: false,
    };
  }

  // Step 4: prior-trust mismatch warning. If the file's absPath has
  // ANY rows but none match this sha256, the user trusted a different
  // version. Surface the documented mismatch hint to the dialog so
  // the renderer can show the warning string.
  const priorRows = trust[opts.absPath] ?? [];
  const mismatchWarning =
    priorRows.length > 0
      ? "this workflow file has changed since you last trusted it"
      : null;

  // Step 5: show the dialog. Loop on `view`.
  const dialog = opts.dialog;
  let attempts = 0;
  let outcome: ApprovalDialogOutcome = "no";
  while (attempts < VIEW_REPROMPT_LIMIT) {
    attempts++;
    outcome = await dialog({
      workflowName: opts.workflowName,
      absPath: opts.absPath,
      sha256: opts.sha256,
      ...(mismatchWarning !== null ? { mismatchWarning } : {}),
    });
    if (outcome === "view") {
      try {
        await opts.viewer(opts.absPath);
      } catch {
        // viewer failure is non-fatal — fall through to re-prompt.
      }
      continue;
    }
    break;
  }

  if (outcome === "always") {
    let scopeUsed: TrustScope = "project";
    let persisted = false;
    try {
      const written = await addTrust({
        cwd: opts.cwd,
        absPath: opts.absPath,
        name: opts.workflowName,
        sha256: opts.sha256,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.projectSettingsPathOverride !== undefined
          ? { projectSettingsPathOverride: opts.projectSettingsPathOverride }
          : {}),
        ...(opts.personalSettingsPathOverride !== undefined
          ? {
              personalSettingsPathOverride: opts.personalSettingsPathOverride,
            }
          : {}),
      });
      scopeUsed = written.scope;
      persisted = true;
    } catch (e) {
      // Persistence failure must not block the user — still approve
      // this run (they pressed [A]). Surface via warning only.
      opts.onPersistError?.(e);
    }
    return {
      approved: true,
      reason: "user-always",
      persisted,
      scope: scopeUsed,
    };
  }
  if (outcome === "run-once") {
    return {
      approved: true,
      reason: "user-once",
      persisted: false,
    };
  }
  // outcome === 'no' (also: VIEW_REPROMPT_LIMIT exhausted defaults to 'no')
  return {
    approved: false,
    reason: "user-N",
    cancelCause: "user-N",
  };
}

// ─── Adapters / helpers ──────────────────────────────────────────

/**
 * Adapter that bridges `runApprovalGate`'s `dialog` callback to
 * pi-coding-agent's `ctx.ui.confirm` API. Keeps the four logical
 * outcomes by serializing them as separate confirm() calls. Slice 13
 * will replace this with a single 4-button `ctx.ui.custom` overlay;
 * for slice 9 we ship the simple version so the flow works against
 * any pi version that exposes `ctx.ui.confirm`.
 *
 * Tests substitute a script-mode adapter directly — they don't need
 * this wrapper.
 */
export function makeConfirmDialog(opts: {
  readonly confirm: (
    message: string,
    options?: { defaultYes?: boolean },
  ) => Promise<boolean>;
}): ApprovalDialog {
  return async (prompt: ApprovalDialogPrompt) => {
    const intro =
      `Workflow "${prompt.workflowName}" wants to run.\n` +
      `Path: ${prompt.absPath}\n` +
      `SHA-256: ${prompt.sha256.slice(0, 16)}…\n` +
      (prompt.mismatchWarning !== undefined
        ? `\u26a0 ${prompt.mismatchWarning}\n`
        : "") +
      `Approve once?`;
    const yes = await opts.confirm(intro);
    if (!yes) {
      const view = await opts.confirm(
        `View raw script for "${prompt.workflowName}"?`,
      );
      if (view) return "view";
      return "no";
    }
    const always = await opts.confirm(
      `Don't ask again for "${prompt.workflowName}" in ${prompt.absPath}?`,
    );
    return always ? "always" : "run-once";
  };
}

/** Convenience hash helper for callers that already have the source. */
export function hashSource(source: string): string {
  return hashOf(source);
}
