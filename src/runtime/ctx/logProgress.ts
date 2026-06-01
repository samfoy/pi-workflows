/**
 * src/runtime/ctx/logProgress.ts — ctx.log, ctx.finishCallback,
 * ctx.progress.
 *
 * Three small bridge methods that share opts.ledger / opts.emitOverlayEvent
 * but don't share state with the rest of the host beyond the mutable
 * `finishPrompt`. The factory takes a setter so the closure capture is
 * explicit; the parent runCtx.ts file owns the variable.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { log as ledgerLog } from "../ledger.js";

const VALID_LOG_LEVELS = new Set<string>(["info", "warn", "error"]);

function coerceLevel(raw: unknown): "info" | "warn" | "error" {
  const candidate =
    typeof raw === "string"
      ? raw
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((raw as any)?.level ?? "info");
  return VALID_LOG_LEVELS.has(candidate)
    ? (candidate as "info" | "warn" | "error")
    : "info";
}

export interface LogProgressDeps {
  /** Sandbox-side callback that sets the host-realm `finishPrompt`. */
  setFinishPrompt(prompt: string): void;
  /** ISO-now factory; injected for deterministic tests. */
  nowIso(): string;
}

export function createLogProgressMethods(
  opts: RunCtxHostOptions,
  deps: LogProgressDeps,
): {
  logFn: (message: unknown, levelArg: unknown) => RunCtxBridgeResult<null>;
  finishCallback: (prompt: unknown) => RunCtxBridgeResult<null>;
  progressFn: (pct: unknown, message?: unknown) => RunCtxBridgeResult<null>;
  /** Await all in-flight ledger writes queued by `logFn` calls. */
  drainPendingLog: () => Promise<void>;
} {
  // Serialises in-flight ledger writes; awaited by `drainPendingLog`.
  let pendingWrite: Promise<void> = Promise.resolve();

  function logFn(
    message: unknown,
    levelArg: unknown,
  ): RunCtxBridgeResult<null> {
    try {
      const level = coerceLevel(levelArg);
      const msg =
        typeof message === "string"
          ? message
          : (() => {
              try {
                return JSON.stringify(message);
              } catch {
                return String(message);
              }
            })();
      // Single ledger entry per ctx.log call (the `log` shape).
      // The previous implementation also appended an `agent_log`
      // entry here, producing two ledger lines per ctx.log — that
      // duplicated the OTel exporter's output and made `tail -f`
      // confusing. The `log` entry is the canonical one; readers that
      // want agent attribution can correlate via the surrounding
      // `agent_start`/`agent_end` events.
      // Writes are serialised through `pendingWrite` to give callers a
      // drain point (`drainPendingLog`). Errors are surfaced via
      // console.error so they are never silently discarded, and also
      // forwarded to the overlay when it is wired.
      const write = ledgerLog(opts.ledger, level, msg, deps.nowIso);
      pendingWrite = pendingWrite.then(() => write).catch((err: unknown) => {
        console.error("[pi-workflows] ctx.log ledger write failed:", err);
      });
      // Overlay event: lets the TUI agent-detail view show ctx.log lines.
      try {
        opts.emitOverlayEvent?.("pi-workflows.agent.log", {
          line: msg,
          runId: opts.runMeta.id,
          agentId: "",
          level,
        });
      } catch {
        /* swallow — overlay failures must not block the run */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  function finishCallback(prompt: unknown): RunCtxBridgeResult<null> {
    try {
      if (typeof prompt !== "string") {
        throw new TypeError("ctx.finishCallback: prompt must be a string");
      }
      deps.setFinishPrompt(prompt);
      // slice 10 will hook actual delivery; slice 8a only records.
      opts.onFinishCallback?.(prompt);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  function progressFn(
    pct: unknown,
    message?: unknown,
  ): RunCtxBridgeResult<null> {
    try {
      if (typeof pct !== "number" || !isFinite(pct) || pct < 0 || pct > 100) {
        throw new TypeError(
          `ctx.progress: pct must be a number in [0, 100], got ${JSON.stringify(pct)}`,
        );
      }
      const msg = message === undefined ? undefined : String(message);
      // Overlay-only — no ledger write (ephemeral per spec).
      try {
        opts.emitOverlayEvent?.("pi-workflows.progress", {
          runId: opts.runMeta.id,
          pct,
          ...(msg !== undefined ? { message: msg } : {}),
        });
      } catch {
        /* emission failures must not abort the run */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  function drainPendingLog(): Promise<void> {
    return pendingWrite;
  }

  return { logFn, finishCallback, progressFn, drainPendingLog };
}
