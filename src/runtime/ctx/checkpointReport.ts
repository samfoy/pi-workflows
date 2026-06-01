/**
 * src/runtime/ctx/checkpointReport.ts — ctx.checkpoint + ctx.report.
 *
 * Two small bridge methods grouped because both write to opts.ledger
 * + emit overlay events but otherwise share nothing. ctx.checkpoint is
 * idempotent (returns false if already set on resume); ctx.report is
 * fire-and-forget event emission with a special-case `{format:'mermaid'}`
 * accessor that returns the run's DAG.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { renderMermaidSync } from "../visualize.js";

export interface CheckpointReportDeps {
  /** ISO-now factory; injected for deterministic tests. */
  nowIso(): string;
}

export function createCheckpointReportMethods(
  opts: RunCtxHostOptions,
  deps: CheckpointReportDeps,
): {
  checkpointFn: (
    label: unknown,
    data?: unknown,
  ) => Promise<RunCtxBridgeResult<boolean>>;
  reportFn: (
    eventTypeOrAccessor: unknown,
    data?: unknown,
  ) => RunCtxBridgeResult<null | string>;
} {
  async function checkpointFn(
    label: unknown,
    data?: unknown,
  ): Promise<RunCtxBridgeResult<boolean>> {
    try {
      if (typeof label !== "string" || label.length === 0) {
        throw new TypeError(
          "ctx.checkpoint: label must be a non-empty string",
        );
      }
      if (await opts.cache.hasCheckpoint(label)) {
        // Already set — checkpoint_hit (resumed run).
        void opts.ledger.append({
          type: "checkpoint_hit",
          at: deps.nowIso(),
          label,
        });
        return { ok: true, value: false };
      }
      // First write — persist and record.
      await opts.cache.setCheckpoint(label, data);
      void opts.ledger.append({
        type: "checkpoint_set",
        at: deps.nowIso(),
        label,
      });
      return { ok: true, value: true };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  function reportFn(
    eventTypeOrAccessor: unknown,
    data?: unknown,
  ): RunCtxBridgeResult<null | string> {
    try {
      // gap/viz: accessor form `ctx.report({format:'mermaid'})` returns
      // the run's DAG as a Mermaid string. Detected by the first
      // argument being an object with a `format` field; everything else
      // falls through to the existing event-emit semantics.
      if (
        eventTypeOrAccessor !== null &&
        typeof eventTypeOrAccessor === "object" &&
        !Array.isArray(eventTypeOrAccessor) &&
        "format" in (eventTypeOrAccessor as Record<string, unknown>)
      ) {
        const fmt = (eventTypeOrAccessor as Record<string, unknown>)["format"];
        if (fmt !== "mermaid") {
          throw new TypeError(
            `ctx.report: unsupported format ${JSON.stringify(fmt)} (only 'mermaid' is implemented)`,
          );
        }
        const mmd = renderMermaidSync(opts.runDirAbs);
        return { ok: true, value: mmd };
      }

      const eventType = eventTypeOrAccessor;
      if (typeof eventType !== "string" || eventType.length === 0) {
        throw new TypeError(
          "ctx.report: eventType must be a non-empty string",
        );
      }
      // JSON-serialize data to catch circular refs.
      let parsedData: unknown;
      if (data !== undefined) {
        try {
          parsedData = JSON.parse(JSON.stringify(data));
        } catch (cycErr) {
          throw new TypeError(
            `ctx.report: data is not JSON-serializable (${(cycErr as Error).message})`,
          );
        }
      }
      // Append to ledger (fire-and-forget).
      void opts.ledger.append({
        type: "report",
        at: deps.nowIso(),
        event: eventType,
        ...(parsedData !== undefined ? { data: parsedData } : {}),
      });
      // Emit to overlay.
      try {
        opts.emitOverlayEvent?.("pi-workflows.report", {
          runId: opts.runMeta.id,
          event: eventType,
          ...(parsedData !== undefined
            ? { data: parsedData as Record<string, unknown> }
            : {}),
        });
      } catch {
        /* swallow */
      }
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  return { checkpointFn, reportFn };
}
