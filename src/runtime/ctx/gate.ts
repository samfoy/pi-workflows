/**
 * src/runtime/ctx/gate.ts — ctx.gate (HITL approval prompt).
 *
 * Author calls `ctx.gate("Apply changes?")`; the host appends
 * gate_requested/gate_resolved entries to the ledger, emits overlay
 * events for the TUI prompt, awaits the wait-for-gate hook (or falls
 * back to opts.default), and returns the approved boolean.
 *
 * Stateless on the host beyond opts; extracted as a self-contained
 * factory.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { requireString } from "./utils.js";

export interface GateDeps {
  /** ISO-now factory; injected so deterministic tests can pin timestamps. */
  nowIso(): string;
}

export function createGateMethod(
  opts: RunCtxHostOptions,
  deps: GateDeps,
): (
  messageArg: unknown,
  optsArg?: unknown,
) => Promise<RunCtxBridgeResult<boolean>> {
  return async function gate(
    messageArg: unknown,
    optsArg?: unknown,
  ): Promise<RunCtxBridgeResult<boolean>> {
    try {
      requireString(messageArg, "ctx.gate: message");
      const message = messageArg as string;
      const gateOpts =
        optsArg !== null && typeof optsArg === "object"
          ? (optsArg as Record<string, unknown>)
          : {};
      const defaultAnswer =
        typeof gateOpts.default === "boolean" ? gateOpts.default : true;

      // 1. Log the gate request to the ledger.
      await opts.ledger.append({
        type: "gate_requested",
        at: deps.nowIso(),
        message,
      });

      // 2. Emit overlay event so the TUI can show the gate prompt.
      try {
        opts.emitOverlayEvent?.("pi-workflows.gate.requested", {
          runId: opts.runMeta.id,
          message,
          defaultAnswer,
        });
      } catch {
        /* overlay emission failures must not abort the gate */
      }

      // 3. Wait for a response (or fall back to the default if no mechanism
      //    is wired — e.g. running outside the TUI).
      let approved: boolean;
      if (opts.waitForGate !== undefined) {
        approved = await opts.waitForGate(message, opts.signal);
      } else {
        approved = defaultAnswer;
      }

      // 4. Log the gate resolution.
      await opts.ledger.append({
        type: "gate_resolved",
        at: deps.nowIso(),
        approved,
      });

      try {
        opts.emitOverlayEvent?.("pi-workflows.gate.resolved", {
          runId: opts.runMeta.id,
          approved,
        });
      } catch {
        /* swallow */
      }

      return { ok: true, value: approved };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  };
}
