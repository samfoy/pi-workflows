/**
 * src/runtime/ctx/interrupt.ts — ctx.interrupt (mid-phase pause-and-route HITL).
 *
 * Each call to `ctx.interrupt({question, choices?, default?, schema?})`
 * gets a deterministic key `int-N` from a per-run monotonic counter.
 * The resolved value is JSON-cloned, optionally schema-validated, and
 * recorded in the ledger via `interrupt_resolved`. A subsequent resume
 * of THIS run replays prior resolutions via
 * `opts.replayResolvedInterrupts` (Map<key, value>).
 *
 * The factory takes the host options plus a getter/setter for the
 * monotonic counter so the runCtx orchestrator owns the variable; this
 * module just reads + bumps it.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import {
  validateAgainstSchema,
  SchemaValidationError,
  InterruptValueValidationError,
} from "../schema.js";

export interface InterruptDeps {
  /** Returns the next available interrupt counter, then increments. */
  nextInterruptIdx(): number;
  /** ISO-now factory; injected for deterministic tests. */
  nowIso(): string;
}

/**
 * Normalize `ctx.interrupt(opts)` argument shape.
 *
 * Accepts a plain string (treated as `{ question }`) or
 * `{ question, choices?, default?, schema? }`. Throws on any other
 * shape so the caller's error envelope carries a descriptive message.
 * JSON-clones `choices` and `default` so realm leaks / cycles fail at
 * the host boundary. `schema` is NOT JSON-cloned (schema objects
 * commonly hold shared references).
 */
function parseInterruptOpts(optsArg: unknown): {
  question: string;
  choices?: ReadonlyArray<string>;
  hasDefault: boolean;
  defaultValue: unknown;
  schema?: Record<string, unknown>;
} {
  if (typeof optsArg === "string") {
    return {
      question: optsArg,
      hasDefault: false,
      defaultValue: undefined,
    };
  }
  if (
    optsArg === null ||
    typeof optsArg !== "object" ||
    Array.isArray(optsArg)
  ) {
    throw new TypeError(
      "ctx.interrupt: opts must be a string question or { question, choices?, default?, schema? } object",
    );
  }
  const o = optsArg as Record<string, unknown>;
  if (typeof o.question !== "string" || o.question.length === 0) {
    throw new TypeError(
      "ctx.interrupt: opts.question must be a non-empty string",
    );
  }
  let choices: ReadonlyArray<string> | undefined;
  if (o.choices !== undefined) {
    if (!Array.isArray(o.choices)) {
      throw new TypeError(
        "ctx.interrupt: opts.choices must be an array of strings",
      );
    }
    const arr = o.choices as unknown[];
    const cleaned: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (typeof c !== "string") {
        throw new TypeError(
          `ctx.interrupt: opts.choices[${i}] must be a string (got ${typeof c})`,
        );
      }
      cleaned.push(c);
    }
    choices = Object.freeze(cleaned.slice());
  }
  const hasDefault = Object.prototype.hasOwnProperty.call(o, "default");
  let defaultValue: unknown = undefined;
  if (hasDefault) {
    try {
      defaultValue = JSON.parse(JSON.stringify(o.default));
    } catch (cycErr) {
      throw new TypeError(
        `ctx.interrupt: opts.default is not JSON-serializable (${(cycErr as Error).message})`,
      );
    }
  }
  let schema: Record<string, unknown> | undefined;
  if (o.schema !== undefined && o.schema !== null) {
    if (typeof o.schema !== "object" || Array.isArray(o.schema)) {
      throw new TypeError(
        "ctx.interrupt: opts.schema must be a plain object (JSON-Schema-shaped)",
      );
    }
    schema = o.schema as Record<string, unknown>;
  }
  const out: {
    question: string;
    choices?: ReadonlyArray<string>;
    hasDefault: boolean;
    defaultValue: unknown;
    schema?: Record<string, unknown>;
  } = { question: o.question, hasDefault, defaultValue };
  if (choices !== undefined) out.choices = choices;
  if (schema !== undefined) out.schema = schema;
  return out;
}

export function createInterruptMethod(
  opts: RunCtxHostOptions,
  deps: InterruptDeps,
): (
  optsArg: unknown,
) => Promise<RunCtxBridgeResult<{ key: string; value: unknown }>> {
  return async function interruptFn(
    optsArg: unknown,
  ): Promise<RunCtxBridgeResult<{ key: string; value: unknown }>> {
    try {
      const cfg = parseInterruptOpts(optsArg);
      const idx = deps.nextInterruptIdx();
      const key = `int-${idx}`;

      // Helper: validate the resolved value against opts.schema if
      // present. Throws InterruptValueValidationError on mismatch —
      // the workflow's awaiter sees the typed error in its catch
      // block (or in the agent's rejected promise). On success: no-op.
      const validateValue = (val: unknown): void => {
        if (cfg.schema === undefined) return;
        try {
          validateAgainstSchema(val, cfg.schema);
        } catch (e) {
          if (e instanceof SchemaValidationError) {
            throw new InterruptValueValidationError(
              key,
              e.path,
              e.expected,
              e.actual,
            );
          }
          throw e;
        }
      };

      // 1. Replay-perfect short-circuit. If a prior run resolved this
      //    interrupt and the result was replayed in via opts, return it
      //    immediately. We still emit a single `interrupt_resolved` entry
      //    with `source:"replay"` so the new ledger captures the answer
      //    even though no IPC round-trip happened (a downstream resume
      //    of THIS run finds it without re-walking the prior ledger).
      //    Schema validation re-runs here — the schema may have changed
      //    between runs, and cached "good" values from a stricter past
      //    schema must still pass the current one.
      if (
        opts.replayResolvedInterrupts !== undefined &&
        opts.replayResolvedInterrupts.has(key)
      ) {
        const replayed = opts.replayResolvedInterrupts.get(key);
        const normalized = replayed === undefined ? null : replayed;
        validateValue(normalized);
        await opts.ledger.append({
          type: "interrupt_resolved",
          at: deps.nowIso(),
          key,
          value: normalized,
          source: "replay",
        });
        return { ok: true, value: { key, value: normalized } };
      }

      // 2. Write the request entry. Choices/default are optional;
      //    only include when present so JSON output stays minimal.
      const requestEntry: {
        type: "interrupt_requested";
        at: string;
        key: string;
        question: string;
        choices?: ReadonlyArray<string>;
        default?: unknown;
      } = {
        type: "interrupt_requested",
        at: deps.nowIso(),
        key,
        question: cfg.question,
      };
      if (cfg.choices !== undefined) requestEntry.choices = cfg.choices;
      if (cfg.hasDefault) requestEntry.default = cfg.defaultValue;
      await opts.ledger.append(requestEntry);

      // 3. Overlay event (best-effort).
      try {
        opts.emitOverlayEvent?.("pi-workflows.interrupt.requested", {
          runId: opts.runMeta.id,
          key,
          question: cfg.question,
          ...(cfg.choices !== undefined ? { choices: cfg.choices } : {}),
          ...(cfg.hasDefault ? { default: cfg.defaultValue } : {}),
        });
      } catch {
        /* swallow — overlay failures must not abort the interrupt */
      }

      // 4. Block. waitForInterrupt is wired by RunManager and resolves
      //    when a `resume-interrupt` ctrl command arrives. When absent
      //    (unit test / running outside the TUI) fall back to default.
      let value: unknown;
      let source: "ipc" | "default";
      if (opts.waitForInterrupt !== undefined) {
        value = await opts.waitForInterrupt(key, opts.signal);
        source = "ipc";
      } else {
        value = cfg.hasDefault ? cfg.defaultValue : null;
        source = "default";
      }

      // 5. Normalize undefined → null so the ledger never stores
      //    `undefined` (not valid JSON; matches buildResultEntry).
      const normalized = value === undefined ? null : value;

      // 6. JSON-clone defense — catches realm-leaks and circular refs
      //    at the host boundary, mirroring memo_set / report.
      try {
        JSON.stringify(normalized);
      } catch (cycErr) {
        throw new TypeError(
          `ctx.interrupt: resolved value is not JSON-serializable (${(cycErr as Error).message})`,
        );
      }
      const cloned: unknown = JSON.parse(JSON.stringify(normalized));

      // 6b. Schema validation (gap follow-up #3). Runs AFTER the
      //     JSON-clone so the validated value is the one we'd actually
      //     store. On mismatch, the resolution still gets ledgered
      //     (so a future replay sees what was injected) but the
      //     workflow's await throws InterruptValueValidationError.
      let schemaError: InterruptValueValidationError | null = null;
      try {
        validateValue(cloned);
      } catch (e) {
        if (e instanceof InterruptValueValidationError) {
          schemaError = e;
        } else {
          throw e;
        }
      }

      // 7. Write the resolution entry.
      await opts.ledger.append({
        type: "interrupt_resolved",
        at: deps.nowIso(),
        key,
        value: cloned,
        source,
      });

      try {
        opts.emitOverlayEvent?.("pi-workflows.interrupt.resolved", {
          runId: opts.runMeta.id,
          key,
          value: cloned as Record<string, unknown> | unknown,
          source,
        });
      } catch {
        /* swallow */
      }

      if (schemaError !== null) throw schemaError;
      return { ok: true, value: { key, value: cloned } };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  };
}
