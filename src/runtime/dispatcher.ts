/**
 * pi-workflows — sub-agent dispatcher (slice 6).
 *
 * `dispatchAgent(opts)` is the canonical way to run a single agent in
 * a workflow. It:
 *
 *   1. (mock branch) — if `opts.mockAgents === true` or the host env
 *      has `PI_WORKFLOWS_MOCK_AGENTS=1`, defer to `mockAgents.ts` and
 *      return synchronously after writing a transcript file.
 *
 *   2. (real branch)
 *      a. Build env per PRD §13.7 — `PI_DISABLE_WORKFLOWS=1` and
 *         `PI_WORKFLOWS_RECURSIVE=1` OVERWRITE any pre-existing
 *         values for these names.
 *      b. Build args: `--mode json -p <prompt>` + optional `--model`,
 *         `--thinking`, `--no-color`, `--no-loading`.
 *      c. Spawn (parent-death-wrapped on Linux/macOS — see
 *         `parentDeath.ts`).
 *      d. Pipe `stdout` through `parseJsonStream` (slice 5) tee'd to
 *         `<runDir>/agents/<agentId>.jsonl`.
 *      e. Capture `stderr` to `<runDir>/agents/<agentId>.stderr`.
 *      f. Latch on the FINAL `agent_end` event (verified against real
 *         pi 0.74.0 via spike — emitted last with full `messages`
 *         array).
 *      g. Aggregate: text from `agent_end.messages[last assistant].content`,
 *         usage from the last `turn_end`, toolCalls from `tool_call`
 *         events seen during the stream.
 *      h. On `JsonStreamError`: append the truncated bytes to
 *         `<agentId>.stderr` and reject with `MalformedAgentOutputError`
 *         per PRD §5.5.2.
 *      i. On non-zero exit without `agent_end`: `AgentSubprocessError`.
 *      j. On `AbortSignal`: SIGTERM child, await exit, cleanup.
 *
 *   3. (always) Slice 6 also writes the parent-liveness portion of
 *      `<runDir>/manifest.json` — slice 8a will merge in the rest at
 *      run-start. Mock branch does this too so resume code paths
 *      exercise consistently.
 *
 * Dispatcher does NOT acquire a semaphore slot itself — the caller
 * (slice 8a's `ctx.phase`) does. This keeps the dispatcher pure for
 * the unit-test harness and matches the boundary the PRD §5.5
 * pseudocode draws around `pi.exec`.
 *
 * Real-pi event-stream spike (captured 2026-05-28, pi v0.74.0):
 *
 *   session  → agent_start  → turn_start
 *   → message_start (user)  → message_end (user)
 *   → message_start (assistant) → message_update*  → message_end (assistant)
 *   → turn_end → session_info_changed
 *   → agent_end           ← TERMINAL
 *
 * `agent_end` is the canonical "stream is done" event; we latch on it.
 * NOT `result` (which the slice-5 default predicate uses) — that was
 * the slice-5 builder's invented vocabulary, corrected here.
 */

import { promises as fs, createWriteStream } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

import {
  AgentSubprocessError,
  MalformedAgentOutputError,
} from "./errors.js";
import { resolveMockAgent } from "./mockAgents.js";
import {
  captureParentLiveness,
  writeParentLivenessFields,
} from "./manifestWriter.js";
import {
  removeParentDeathWrapper,
  writeParentDeathWrapper,
} from "./parentDeath.js";
import {
  JsonStreamError,
  parseJsonStream,
} from "../util/jsonStream.js";
import {
  agentStderrPath as agentStderrPathBy,
  agentTranscriptPath as agentTranscriptPathBy,
  agentsDir as agentsDirBy,
} from "../util/paths.js";
import type {
  AgentResult,
  AgentUsage,
  DispatcherOptions,
  SpawnLike,
  SpawnedChildLike,
} from "../types/internal.js";

/**
 * Real `pi --mode json` final-result event type (verified 2026-05-28
 * against pi 0.74.0). The slice-5 default predicate `event.type ===
 * "result"` was based on invented vocabulary and is overridden here.
 */
export const PI_FINAL_RESULT_EVENT_TYPE = "agent_end";

/**
 * The two env vars from PRD §13.7. Always set on every spawned child.
 * Order matters in the spread that follows — these come AFTER the
 * envBase spread so they overwrite any pre-existing parent values.
 */
export const RECURSION_GUARD_ENV = Object.freeze({
  PI_DISABLE_WORKFLOWS: "1",
  PI_WORKFLOWS_RECURSIVE: "1",
});

/**
 * Slice 9: env vars that propagate from parent to child unchanged.
 * Per PRD §7.5: when the parent run is bypassed via
 * `--bypass-permissions`, the spawned `pi -p` sub-agents inherit the
 * bypass (claude-code parity).
 *
 * Slice 10 W1 fix (option a / pragmatic): `buildChildEnv` now strips
 * EVERY `PI_*` env var from the parent inheritance EXCEPT the names
 * in this allowlist (plus the recursion-guard pair which is set
 * unconditionally below). This makes the allowlist load-bearing —
 * removing `PI_BYPASS_PERMISSIONS` here causes the test
 * `"buildChildEnv W1: PROPAGATED_BYPASS_ENV is load-bearing —
 * removing PI_BYPASS_PERMISSIONS strips it"` to fail by direct
 * inspection of the constant. Non-PI_ vars (PATH, HOME, AWS_*,
 * LANG, …) still pass through so real `pi` spawn works. Recursion
 * guard always wins.
 */
export const PROPAGATED_BYPASS_ENV: readonly string[] = Object.freeze([
  "PI_BYPASS_PERMISSIONS",
]);

/**
 * Build `process.env`-shaped object for the child.
 *
 * Algorithm (slice 10):
 *   1. Spread `envBase` so PATH / HOME / AWS_xxx / LANG / etc inherit
 *      naturally.
 *   2. Walk the inherited keys; strip any `PI_*` name not present in
 *      `PROPAGATED_BYPASS_ENV`. Recursion-guard vars are stripped here
 *      too, then re-added in step 4 so the same code path works
 *      whether the parent had them or not.
 *   3. Apply caller-supplied `extra` (tests / future hooks).
 *   4. Apply `RECURSION_GUARD_ENV` unconditionally — it OVERWRITES
 *      any value the parent or `extra` set per PRD §13.7.
 */
export function buildChildEnv(
  envBase: NodeJS.ProcessEnv = process.env,
  extra?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...envBase };
  const allow = new Set<string>(PROPAGATED_BYPASS_ENV);
  for (const key of Object.keys(child)) {
    if (key.startsWith("PI_") && !allow.has(key)) {
      delete child[key];
    }
  }
  if (extra) Object.assign(child, extra);
  Object.assign(child, RECURSION_GUARD_ENV);
  return child;
}

/**
 * Build pi arg-vector. Public for testability.
 *
 * Per pi 0.74.0 `--help`: there is no `--no-color` or `--no-loading`
 * flag (the PRD pseudocode §5.5 cited those, but they don't exist on
 * the current pi binary). `--mode json` already produces structured
 * output with no ANSI; we don't need a color flag.
 */
export function buildPiArgs(opts: {
  prompt: string;
  model?: string;
  thinking?: string;
}): string[] {
  const args = ["--mode", "json", "-p", opts.prompt];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  return args;
}

// ───────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ───────────────────────────────────────────────────────────────────────

interface Aggregator {
  toolCalls: number;
  usage: AgentUsage;
  agentEnd: Record<string, unknown> | null;
}

function newAggregator(): Aggregator {
  return {
    toolCalls: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    agentEnd: null,
  };
}

function ingest(agg: Aggregator, ev: Record<string, unknown>): void {
  const type = ev.type;
  if (type === "tool_call") {
    agg.toolCalls += 1;
    return;
  }
  if (type === "turn_end" || type === "message_end") {
    // Real pi emits `usage` nested inside `message`. Sometimes also
    // top-level. Latch the most-detailed reading.
    const msg = (ev.message ?? {}) as Record<string, unknown>;
    const usage = (msg.usage ?? ev.usage) as Record<string, number> | undefined;
    if (usage && typeof usage === "object") {
      agg.usage = {
        input: pickInt(usage, "input"),
        output: pickInt(usage, "output"),
        cacheRead: pickInt(usage, "cacheRead"),
        cacheWrite: pickInt(usage, "cacheWrite"),
        totalTokens: pickInt(usage, "totalTokens"),
      };
    }
    return;
  }
  if (type === PI_FINAL_RESULT_EVENT_TYPE) {
    agg.agentEnd = ev;
  }
}

function pickInt(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract the final assistant text from an `agent_end` event's
 * `messages` array. The structure (verified 0.74.0):
 *
 *   { type: "agent_end", messages: [
 *       { role: "user", content: [{type:"text",text:"…"}] },
 *       { role: "assistant", content: [{type:"text",text:"…"}, …] }
 *   ] }
 *
 * Returns the joined `text` parts of the LAST assistant message, or
 * the empty string if the schema doesn't match.
 */
export function extractAssistantText(agentEnd: Record<string, unknown>): string {
  const messages = agentEnd.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || m.role !== "assistant") continue;
    const content = m.content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const c of content) {
      const cr = c as Record<string, unknown> | null;
      if (cr && cr.type === "text" && typeof cr.text === "string") {
        parts.push(cr.text);
      }
    }
    return parts.join("");
  }
  return "";
}

// ───────────────────────────────────────────────────────────────────────
// Main dispatcher
// ───────────────────────────────────────────────────────────────────────

/**
 * Dispatch a single agent. See file-level doc for full contract.
 *
 * Throws (rejects) with `MalformedAgentOutputError`, `AgentSubprocessError`,
 * `MockFixtureMissingError`, or any abort/system error. Always cleans up
 * tee fd and parent-death wrapper.
 */
export async function dispatchAgent(opts: DispatcherOptions): Promise<AgentResult> {
  const now = opts.nowMs ?? Date.now;
  const t0 = now();

  // Always write parent-liveness so resume sweep sees something even
  // for mock runs.
  await writeParentLivenessFields(opts.runDir, captureParentLiveness());
  await fs.mkdir(agentsDirBy(opts.runDir, true), { recursive: true });

  const envBase = opts.envBase ?? process.env;
  const mockMode =
    opts.mockAgents === true || envBase.PI_WORKFLOWS_MOCK_AGENTS === "1";

  if (mockMode) {
    return resolveMockAgent({
      runDirAbs: opts.runDir,
      agentId: opts.agentId,
      promptHash: opts.promptHash,
    });
  }

  // ── Real spawn branch ─────────────────────────────────────────────
  const transcriptPath = agentTranscriptPathBy(opts.runDir, opts.agentId);
  const stderrPath = agentStderrPathBy(opts.runDir, opts.agentId);
  const childEnv = buildChildEnv(envBase);
  const args = buildPiArgs({
    prompt: opts.prompt,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
  });

  let command = "pi";
  let finalArgs: string[] = args;
  let wrapperPath: string | null = null;
  if (!opts.skipParentDeathGuard) {
    wrapperPath = await writeParentDeathWrapper({
      runDirAbs: opts.runDir,
      agentId: opts.agentId,
      originalParentPid: process.pid,
    });
    command = "/bin/sh";
    finalArgs = [wrapperPath, "pi", ...args];
  }

  const spawnFn: SpawnLike = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const child = spawnFn(command, finalArgs, {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });

  // Tee streams.
  const tee = createWriteStream(transcriptPath, { flags: "w" });
  const stderrTee = createWriteStream(stderrPath, { flags: "w" });

  // Pipe stderr → file. Don't await; closes naturally with child exit.
  if (child.stderr) {
    (child.stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
      stderrTee.write(chunk);
    });
    (child.stderr as NodeJS.ReadableStream).on("end", () => {
      stderrTee.end();
    });
  } else {
    stderrTee.end();
  }

  // Honor caller AbortSignal.
  const onAbort = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Subprocess timeout.
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const timeoutHandle = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Escalate to SIGKILL after a 5 s grace period if SIGTERM is ignored.
    const killHandle = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5_000);
    if (typeof (killHandle as { unref?: () => void }).unref === "function") {
      (killHandle as unknown as { unref: () => void }).unref();
    }
  }, timeoutMs);
  if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
    (timeoutHandle as unknown as { unref: () => void }).unref();
  }

  // Track exit eagerly so we can synthesize errors after stream end.
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
    child.once("error", () => {
      // child failed to spawn — mark as exit so the awaits clear
      resolve();
    });
  });

  // Parse the JSON stream. The stream throws JsonStreamError on the
  // FIRST malformed line; we capture it for re-wrapping.
  if (!child.stdout) {
    clearTimeout(timeoutHandle);
    await exitPromise;
    await new Promise<void>((resolve) => {
      tee.once("close", resolve);
      tee.once("finish", resolve);
      tee.end();
    });
    if (wrapperPath) await removeParentDeathWrapper(wrapperPath);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    throw new AgentSubprocessError({
      agentId: opts.agentId,
      exitCode,
      signal: exitSignal,
    });
  }

  const parser = parseJsonStream(child.stdout as NodeJS.ReadableStream, {
    tee,
    isResultEvent: (e) => e.type === PI_FINAL_RESULT_EVENT_TYPE,
  });
  const agg = newAggregator();
  let parseError: JsonStreamError | null = null;
  try {
    for await (const ev of parser) {
      ingest(agg, ev as Record<string, unknown>);
    }
  } catch (e) {
    if (e instanceof JsonStreamError) {
      parseError = e;
    } else {
      // Unexpected — clean up + rethrow.
      clearTimeout(timeoutHandle);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      await exitPromise;
      await new Promise<void>((resolve) => {
        tee.once("close", resolve);
        tee.once("finish", resolve);
        tee.end();
      });
      if (wrapperPath) await removeParentDeathWrapper(wrapperPath);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      throw e;
    }
  }

  clearTimeout(timeoutHandle);
  await exitPromise;
  // Await tee close so the transcript file is fully flushed before
  // any caller reads `result.transcriptPath`.
  await new Promise<void>((resolve) => {
    tee.once("close", resolve);
    tee.once("finish", resolve);
    tee.end();
  });
  if (wrapperPath) await removeParentDeathWrapper(wrapperPath);
  if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

  // Drain stderrTee — its writes happen on `data` events which may
  // outlive the `exit` event, so wait for stderr's `end` before
  // declaring the agent done.
  await new Promise<void>((resolve) => {
    if (stderrTee.writableEnded) {
      resolve();
      return;
    }
    stderrTee.once("close", resolve);
    stderrTee.once("finish", resolve);
  }).catch(() => {
    // ignore — stderr capture is best-effort
  });

  // ─── Failure classification ─────────────────────────────────────
  if (parseError) {
    // Append the truncated bytes to stderr for forensics (PRD §5.5.2).
    await fs.appendFile(stderrPath, parseError.truncatedRegion + "\n", "utf8");
    throw new MalformedAgentOutputError({
      agentId: opts.agentId,
      cwd: opts.cwd,
      exitCode,
      bytes: parseError.truncatedRegion,
      lineNumber: parseError.lineNumber,
      reason: parseError.reason,
      cause: parseError,
    });
  }

  if (!agg.agentEnd) {
    // Empty stdout / no agent_end. Differentiate by exit code.
    const reason =
      exitCode === 0 ? "empty-stdout-success" : "empty-stdout-failure";
    let stderrTail = "";
    try {
      const all = await fs.readFile(stderrPath, "utf8");
      stderrTail = all.slice(-256);
    } catch {
      // ignore
    }
    if (exitSignal !== null || (exitCode !== 0 && exitCode !== null)) {
      throw new AgentSubprocessError({
        agentId: opts.agentId,
        exitCode,
        signal: exitSignal,
      });
    }
    throw new MalformedAgentOutputError({
      agentId: opts.agentId,
      cwd: opts.cwd,
      exitCode,
      bytes: stderrTail,
      lineNumber: null,
      reason,
    });
  }

  return {
    ok: true,
    agentId: opts.agentId,
    text: extractAssistantText(agg.agentEnd),
    usage: agg.usage,
    toolCalls: agg.toolCalls,
    durationMs: now() - t0,
    transcriptPath,
    exitCode,
  };
}
