/**
 * src/runtime/ctx/memory.ts — ctx.memory.{read,append,compact} +
 * ctx.promote.
 *
 * The four bridge methods that touch agent-memory MEMORY.md files
 * (and the per-agent worktree promote path). They share two pieces
 * of run-scoped state:
 *
 *   - `memoryOversizeWarned` — Set<name>, dedupes the one-shot
 *     "MEMORY.md exceeds the 25 KiB read cap" warning per memory
 *     name within a run. Cleared on a successful compaction.
 *   - `readOnlyMemoryKeys` — Set<scope:name>, populated by ctx.agent
 *     when an author mounts memory with `readOnly: true`. Once a
 *     key lands here, ctx.memory.append rejects further writes for
 *     the lifetime of the run.
 *
 * Both Sets are owned by the runCtx orchestrator; this factory takes
 * them by reference (Sets are mutable on both ends, no setter helper
 * needed).
 *
 * The `defaultCompactSummarize` helper used to live in runCtx.ts as
 * a private function — it spawns a tiny synthetic sub-agent via the
 * dispatcher to LLM-summarize the MEMORY.md when the author hasn't
 * supplied a custom `compactSummarize`.
 */

import type { RunCtxBridgeResult } from "../../types/internal.js";
import type { RunCtxHostOptions } from "../runCtx.js";
import { captureError } from "../realmError.js";
import {
  appendMemoryUpdate,
  compactMemoryFile,
  MEMORY_READ_CAP_BYTES,
  memoryReadOnlyKey,
  ReadOnlyMemoryError,
  readMemoryFileWithMeta,
  resolveMemoryDir,
  type MemoryScope,
} from "../agentMemory.js";
import { promoteAgentWorktree } from "../worktree.js";
import { sha256 } from "../../util/hash.js";
import { dispatchAgent } from "../dispatcher.js";
import type { DispatcherOptions, AgentResult } from "../../types/internal.js";

export interface MemoryDeps {
  /** Run-scoped Set deduping the one-shot oversize-warn per memory name. */
  memoryOversizeWarned: Set<string>;
  /** Run-scoped Set of (scope:name) tuples that any agent mounted as readOnly. */
  readOnlyMemoryKeys: Set<string>;
  /** Resolved dispatcher (opts.dispatch ?? dispatchAgent at orchestrator level). */
  dispatch: (opts: DispatcherOptions) => Promise<AgentResult>;
  /** ISO-now factory; injected for deterministic tests. */
  nowIso(): string;
}

export function createMemoryMethods(
  opts: RunCtxHostOptions,
  deps: MemoryDeps,
): {
  memoryRead: (
    name: unknown,
    scope: unknown,
  ) => Promise<RunCtxBridgeResult<string | null>>;
  memoryAppend: (
    name: unknown,
    scope: unknown,
    text: unknown,
  ) => Promise<RunCtxBridgeResult<null>>;
  memoryCompact: (
    name: unknown,
    scope: unknown,
  ) => Promise<
    RunCtxBridgeResult<{
      beforeBytes: number;
      afterBytes: number;
      ratio: number;
    }>
  >;
  promote: (
    agentId: unknown,
    promoteOpts?: unknown,
  ) => Promise<
    RunCtxBridgeResult<{
      strategy: "apply" | "rebase";
      applied: boolean;
      files: readonly string[];
    }>
  >;
} {
  /**
   * Default `summarize` hook for `ctx.memory.compact`. Spawns a
   * single short `pi --mode json -p` agent (no transcript persisted,
   * no cache write) tasked with returning a compacted MEMORY.md body.
   *
   * Authors override via `RunCtxHostOptions.compactSummarize` for
   * deterministic tests.
   *
   * Failures bubble up as `CompactionError` from `compactMemoryFile`
   * so authors see a typed error and the original file stays intact.
   */
  async function defaultCompactSummarize(
    name: string,
    original: string,
  ): Promise<string> {
    // Tiny synthetic agent id for the dispatcher — prefixed so it's
    // easy to spot in transcripts. `assertSafeAgentId` accepts this
    // shape (no `..`, no `/`, no leading `.`).
    const compactAgentId = `memory-compact-${name}-${Date.now().toString(
      36,
    )}`;
    const prompt = [
      `You are compacting a long-running agent's persistent memory file.`,
      `Agent name: ${name}`,
      ``,
      `Goal: produce a shorter version that preserves the MOST RECENT`,
      `~25% of entries verbatim and condenses older entries into terse`,
      `bullet summaries grouped by theme. Keep dates / identifiers.`,
      `Drop redundant restatements. Output ONLY the new MEMORY.md body`,
      `— no preamble, no fences, no commentary.`,
      ``,
      `--- begin original MEMORY.md ---`,
      original,
      `--- end original MEMORY.md ---`,
    ].join("\n");
    const result = await deps.dispatch({
      runDir: opts.runDirAbs,
      agentId: compactAgentId,
      prompt,
      promptHash: sha256(prompt),
      cwd: opts.cwd,
      mockAgents: opts.mockAgents,
    });
    if (typeof result.text !== "string" || result.text.length === 0) {
      throw new Error(
        `ctx.memory.compact: agent returned empty text for "${name}"`,
      );
    }
    return result.text;
  }

  function resolveMemoryArgs(
    name: unknown,
    scope: unknown,
    fnName: string,
  ): { dir: string; scope: MemoryScope; name: string } {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`${fnName}: name must be a non-empty string`);
    }
    if (scope !== "user" && scope !== "project" && scope !== "local") {
      throw new TypeError(
        `${fnName}: scope must be 'user' | 'project' | 'local' (got ${JSON.stringify(scope)})`,
      );
    }
    const parsed = scope as MemoryScope;
    const dir = resolveMemoryDir({
      scope: parsed,
      name,
      cwd: opts.cwd,
      runDirAbs: opts.runDirAbs,
    });
    return { dir, scope: parsed, name };
  }

  async function memoryRead(
    name: unknown,
    scope: unknown,
  ): Promise<RunCtxBridgeResult<string | null>> {
    try {
      const { dir, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.read",
      );
      const r = await readMemoryFileWithMeta(dir);
      if (r === null) return { ok: true, value: null };
      // Re-use the same one-shot oversize-warn dedup as auto-injection.
      if (r.truncated && !deps.memoryOversizeWarned.has(safeName)) {
        deps.memoryOversizeWarned.add(safeName);
        void opts.ledger
          .append({
            type: "log",
            at: deps.nowIso(),
            level: "warn",
            message: `agent-memory: MEMORY.md for "${safeName}" (${r.totalBytes} bytes) exceeds the ${MEMORY_READ_CAP_BYTES}-byte read cap.`,
          })
          .catch(() => undefined);
      }
      return { ok: true, value: r.content };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memoryAppend(
    name: unknown,
    scope: unknown,
    text: unknown,
  ): Promise<RunCtxBridgeResult<null>> {
    try {
      const { dir, scope: parsedScope, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.append",
      );
      // gap follow-up #5: refuse to write to a (scope, name) tuple
      // that any prior ctx.agent() call mounted with readOnly:true.
      if (
        deps.readOnlyMemoryKeys.has(memoryReadOnlyKey(parsedScope, safeName))
      ) {
        throw new ReadOnlyMemoryError(safeName, parsedScope);
      }
      if (typeof text !== "string") {
        throw new TypeError(
          `ctx.memory.append: text must be a string (got ${typeof text})`,
        );
      }
      await appendMemoryUpdate(dir, text);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function memoryCompact(
    name: unknown,
    scope: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      beforeBytes: number;
      afterBytes: number;
      ratio: number;
    }>
  > {
    try {
      const { dir, name: safeName } = resolveMemoryArgs(
        name,
        scope,
        "ctx.memory.compact",
      );
      const summarize = opts.compactSummarize ?? defaultCompactSummarize;
      const result = await compactMemoryFile({
        dir,
        summarize: (original) => summarize(safeName, original),
      });
      void opts.ledger
        .append({
          type: "log",
          at: deps.nowIso(),
          level: "info",
          message: `agent-memory: compacted MEMORY.md for "${safeName}" (${result.beforeBytes} → ${result.afterBytes} bytes, ratio=${result.ratio.toFixed(3)})`,
        })
        .catch(() => undefined);
      deps.memoryOversizeWarned.delete(safeName);
      return { ok: true, value: result };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  async function promote(
    agentId: unknown,
    promoteOpts?: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      strategy: "apply" | "rebase";
      applied: boolean;
      files: readonly string[];
    }>
  > {
    try {
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new TypeError(
          `ctx.promote: agentId must be a non-empty string (got ${typeof agentId})`,
        );
      }
      // Tolerate undefined/null — default opts apply with strategy:'apply'.
      const parsed: { strategy?: "apply" | "rebase"; target?: string } = {};
      if (promoteOpts !== undefined && promoteOpts !== null) {
        if (typeof promoteOpts !== "object" || Array.isArray(promoteOpts)) {
          throw new TypeError(
            `ctx.promote: opts must be an object (got ${typeof promoteOpts})`,
          );
        }
        const o = promoteOpts as Record<string, unknown>;
        if (o.strategy !== undefined) {
          if (o.strategy !== "apply" && o.strategy !== "rebase") {
            throw new TypeError(
              `ctx.promote: opts.strategy must be 'apply' | 'rebase' (got ${JSON.stringify(o.strategy)})`,
            );
          }
          parsed.strategy = o.strategy;
        }
        if (o.target !== undefined) {
          if (typeof o.target !== "string" || o.target.length === 0) {
            throw new TypeError(
              `ctx.promote: opts.target must be a non-empty string (got ${typeof o.target})`,
            );
          }
          parsed.target = o.target;
        }
      }
      const result = await promoteAgentWorktree({
        runDirAbs: opts.runDirAbs,
        agentId,
        sourceCwd: opts.cwd,
        opts: parsed,
      });
      void opts.ledger
        .append({
          type: "log",
          at: deps.nowIso(),
          level: "info",
          message: `agent-worktree: promoted "${agentId}" (${result.strategy}, applied=${result.applied}, files=${result.files.length})`,
        })
        .catch(() => undefined);
      return { ok: true, value: result };
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }

  // Re-export dispatchAgent so consumers needing the same default can
  // resolve via `deps.dispatch ?? dispatchAgent`. (Currently unused
  // here but keeps the symbol importable from this module.)
  void dispatchAgent;

  return { memoryRead, memoryAppend, memoryCompact, promote };
}
