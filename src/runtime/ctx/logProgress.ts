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
} {
  function logFn(
    message: unknown,
    levelArg: unknown,
  ): RunCtxBridgeResult<null> {
    try {
      const level: "info" | "warn" | "error" = (
        (typeof levelArg === "string"
          ? levelArg
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (levelArg as any)?.level) ?? "info"
      ) as "info" | "warn" | "error";
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
      void ledgerLog(opts.ledger, level, msg, deps.nowIso).catch(
        () => undefined,
      );
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
      if (typeof pct !== "number" || pct < 0 || pct > 100) {
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

  return { logFn, finishCallback, progressFn };
}
