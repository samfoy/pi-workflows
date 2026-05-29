/**
 * pi-workflows — slice 9 bypass detector.
 *
 * Resolves the four orthogonal "skip the approval prompt" signals
 * documented in PRD §7.4 + §7.4.1, and returns a tagged decision the
 * RunManager / approval gate consume.
 *
 * Inputs (all driven by env vars; no global mutation):
 *   - `PI_BYPASS_PERMISSIONS=1` → user opted in to claude-code-style
 *     auto-allow. Run proceeds; sub-agents inherit. PRD §7.5
 *     mandates a loud banner.
 *   - `PI_PROMPT_MODE=1` → pi running with `-p` / non-TTY prompt mode.
 *     PRD §7.4.1 (slice-2 revision) made this STRICT: if the
 *     workflow isn't already trusted, error loudly. If it IS trusted,
 *     bypass silently (no banner — `-p` runs are typically scripted).
 *   - `PI_WORKFLOWS_SDK=1` → SDK callers manage their own policy. We
 *     bypass without a banner; the SDK consumer is responsible.
 *   - `mockAgents=true` (or `PI_WORKFLOWS_MOCK_AGENTS=1`) →
 *     `--mock-agents` test path. Bypass without banner so tests
 *     don't spam stdout.
 *
 * Output `BypassResult.bypass` is `true` when the run should skip the
 * dialog. When `bypass=false`, `error` MAY be set (currently only the
 * `pi -p` strict-mode untrusted case) — RunManager surfaces this as a
 * `cancelled-pre-run` and refuses to start the run.
 *
 * Mock mode is checked LAST so a developer who set `PI_BYPASS_PERMISSIONS`
 * for a mock-agents run still gets the banner — explicit bypass intent
 * trumps the silent-mock path.
 */

import type {
  BypassResult,
  TrustStore,
} from "../types/internal.js";
import { isTrustedIn } from "./trustStore.js";

export const ENV_BYPASS_PERMISSIONS = "PI_BYPASS_PERMISSIONS";
export const ENV_PROMPT_MODE = "PI_PROMPT_MODE";
export const ENV_SDK_MODE = "PI_WORKFLOWS_SDK";
export const ENV_MOCK_AGENTS = "PI_WORKFLOWS_MOCK_AGENTS";

/**
 * Exact byte-for-byte banner per PRD §7.5 + plan critic checklist.
 * Tested against this constant — DO NOT mutate without bumping the
 * critic checklist test in `tests/unit/approval.test.ts`.
 */
export const BYPASS_PERMISSIONS_BANNER =
  "\u26a0 pi-workflows: this run is bypassed by --bypass-permissions; " +
  "sub-agents inherit bypass.";

/**
 * `pi -p` strict-mode error message. PRD §7.4.1 (slice-2 revision)
 * pinned the recovery instruction so users running scripted pi
 * sessions get a clear next-step.
 */
export const PI_P_UNTRUSTED_ERROR =
  "workflow not yet trusted; run interactively first to grant trust";

export interface CheckBypassOpts {
  readonly env?: NodeJS.ProcessEnv;
  /** Pre-loaded trust store (avoids redundant disk reads). */
  readonly trust: TrustStore;
  readonly absPath: string;
  readonly sha256: string;
  /** `--mock-agents` runtime flag; OR'd with `PI_WORKFLOWS_MOCK_AGENTS=1`. */
  readonly mockAgents?: boolean;
}

export function checkBypass(opts: CheckBypassOpts): BypassResult {
  const env = opts.env ?? process.env;

  // --bypass-permissions wins over everything (the user explicitly
  // asked for the loud auto-approve mode). Fires before mock-mode so
  // a bypass run under mock-agents still emits the banner.
  if (truthy(env[ENV_BYPASS_PERMISSIONS])) {
    return {
      bypass: true,
      reason: "bypass-permissions",
      banner: BYPASS_PERMISSIONS_BANNER,
    };
  }

  // pi -p: STRICT trust check per PRD §7.4.1.
  if (truthy(env[ENV_PROMPT_MODE])) {
    if (isTrustedIn(opts.trust, opts.absPath, opts.sha256)) {
      return { bypass: true, reason: "pi-p-trusted" };
    }
    return {
      bypass: false,
      reason: "pi-p-untrusted",
      error: PI_P_UNTRUSTED_ERROR,
    };
  }

  // SDK callers manage their own policy.
  if (truthy(env[ENV_SDK_MODE])) {
    return { bypass: true, reason: "sdk" };
  }

  // --mock-agents (env or arg). Test-only path.
  if (opts.mockAgents === true || truthy(env[ENV_MOCK_AGENTS])) {
    return { bypass: true, reason: "mock-agents" };
  }

  return { bypass: false, reason: null };
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
