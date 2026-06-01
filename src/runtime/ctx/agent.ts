/**
 * src/runtime/ctx/agent.ts — ctx.agent (handle builder).
 *
 * Pure: builds a handle object, no I/O. Auto-generates an `id` if the
 * author didn't supply one (so cache-key derivation always has a stable
 * id). Per-run cap is enforced when the handle is actually run (inside
 * ctx.phase) — checking here would let authors construct N handles but
 * only run a few, surprising the cap behavior.
 *
 * The factory takes the host options + an `AgentDeps` carrying the
 * id-generator. The MAX_PROMPT_LENGTH check and JSON-cloning logic
 * stay inline since they're stateless.
 */

import type {
  AgentHandleData,
  RunCtxBridgeResult,
} from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import { MAX_PROMPT_LENGTH } from "../../util/limits.js";

export interface AgentDeps {
  /** Generates a fresh agent id when the caller didn't supply one. */
  newAgentId(): string;
}

export function createAgentMethod(
  // opts is unused here today, but kept in the signature for symmetry
  // with the other ctx/* factories (and so future fields like a
  // global prompt-length override can land without renaming the API).
  _opts: RunCtxHostOptions,
  deps: AgentDeps,
): (
  prompt: unknown,
  optsArg: unknown,
) => RunCtxBridgeResult<AgentHandleData> {
  return function agent(
    prompt: unknown,
    optsArg: unknown,
  ): RunCtxBridgeResult<AgentHandleData> {
    try {
      if (typeof prompt !== "string") {
        throw new TypeError(
          `ctx.agent: prompt must be a string (got ${typeof prompt})`,
        );
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new RangeError(
          `ctx.agent: prompt exceeds MAX_PROMPT_LENGTH (got ${prompt.length}, max ${MAX_PROMPT_LENGTH}). Chunk the input across multiple agents instead of relying on a single oversized call.`,
        );
      }
      const ao =
        optsArg === undefined || optsArg === null
          ? ({} as Record<string, unknown>)
          : (optsArg as Record<string, unknown>);
      if (typeof ao !== "object" || Array.isArray(ao)) {
        throw new TypeError(
          "ctx.agent: opts must be a plain object or omitted",
        );
      }
      // Plain JSON-clone to strip Context-realm prototypes — gives the
      // host a safe, mutation-immune snapshot.
      const optsClone: Record<string, unknown> = JSON.parse(
        JSON.stringify(ao),
      );
      const id =
        typeof optsClone.id === "string" && optsClone.id.length > 0
          ? optsClone.id
          : deps.newAgentId();
      // Hand the id back via opts.id so cache-key derivation has it
      // even if the author didn't supply one.
      optsClone.id = id;
      const handle: AgentHandleData = {
        kind: "agent",
        id,
        prompt,
        opts: Object.freeze(optsClone),
      };
      return { ok: true, value: handle };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  };
}
