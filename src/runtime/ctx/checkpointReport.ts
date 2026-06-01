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
  // Per-label async mutex: serializes concurrent checkpointFn calls for
  // the same label so that hasCheckpoint + setCheckpoint is atomic
  // (eliminates the TOCTOU window where two parallel agents both observe
  // false and both proceed to setCheckpoint).
  const cpLocks = new Map<string, Promise<void>>();

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
      // Acquire per-label lock: wait for any in-flight call with the same
      // label to complete before proceeding. Makes hasCheckpoint +
      // setCheckpoint effectively atomic for concurrent callers.
      const previous = cpLocks.get(label) ?? Promise.resolve();
      let release!: () => void;
      const ticket = new Promise<void>((r) => {
        release = r;
      });
      cpLocks.set(label, ticket);
      await previous;
      try {
        if (await opts.cache.hasCheckpoint(label)) {
          // Already set — checkpoint_hit (resumed run).
          void opts.ledger.append({
            type: "checkpoint_hit",
            at: deps.nowIso(),
            label,
          });
          return { ok: true, value: false };
        }
        // First write — validate serializability, then persist and record.
        let safeData: unknown = data;
        if (data !== undefined) {
          try {
            safeData = JSON.parse(JSON.stringify(data));
          } catch (cycErr) {
            throw new TypeError(
              `ctx.checkpoint: data is not JSON-serializable (${(cycErr as Error).message})`,
            );
          }
        }
        await opts.cache.setCheckpoint(label, safeData);
        void opts.ledger.append({
          type: "checkpoint_set",
          at: deps.nowIso(),
          label,
        });
        return { ok: true, value: true };
      } finally {
        release();
        if (cpLocks.get(label) === ticket) cpLocks.delete(label);
      }
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
      // Only include `data` when parsedData is a plain object: the overlay
      // type requires Record<string,unknown>, and spreading a string or array
      // into the cast would give consumers garbage keys.
      const overlayData: Record<string, unknown> | undefined =
        parsedData !== undefined &&
        typeof parsedData === "object" &&
        parsedData !== null &&
        !Array.isArray(parsedData)
          ? (parsedData as Record<string, unknown>)
          : undefined;
      try {
        opts.emitOverlayEvent?.("pi-workflows.report", {
          runId: opts.runMeta.id,
          event: eventType,
          ...(overlayData !== undefined ? { data: overlayData } : {}),
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
