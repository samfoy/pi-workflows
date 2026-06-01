/**
 * pi-workflows — WorkflowClient (IPC inspection surface).
 *
 * A thin, import-friendly class that a supervisor pi agent can use to:
 *
 *   1. Discover active/recent workflow runs from the active-runs index.
 *   2. Read the current state of a run by replaying its `ledger.jsonl`.
 *   3. Subscribe to events via an async generator that polls `ledger.jsonl`
 *      for new entries (poll-based file tail).
 *   4. Send control commands (pause/resume/stop) by appending to
 *      `<runDir>/ctrl.jsonl`.
 *
 * **No live pi process required.** `WorkflowClient` is pure file I/O —
 * it works from any process that has read/write access to
 * `~/.pi/agent/workflows/runs/`.
 *
 * ## File protocol overview
 *
 *   - `~/.pi/agent/workflows/runs/.active` — JSON `{ runs, updatedAt }`.
 *     Updated atomically (tmp+rename) whenever the registry changes.
 *   - `~/.pi/agent/workflows/runs/<runId>/ledger.jsonl` — append-only
 *     NDJSON run event log. All state transitions, phase/agent lifecycle,
 *     and overlay events (written as `type:"appendEntry"`) flow here.
 *   - `~/.pi/agent/workflows/runs/<runId>/ctrl.jsonl` — append-only
 *     NDJSON control command file. Write lines of `{ type, at?, reason? }`.
 *
 * @example
 * ```ts
 * import { WorkflowClient } from "@samfp/pi-workflows";
 *
 * const client = new WorkflowClient();
 * const active = client.listActiveRuns();
 * for (const runId of active) {
 *   const state = await client.getRunState(runId);
 *   console.log(runId, state.state);
 *   // Tail live events
 *   for await (const ev of client.tailEvents(runId)) {
 *     if (ev.type === "transition" && ev.to === "done") break;
 *   }
 * }
 * ```
 */

import { closeSync, fsyncSync, openSync, promises as fsp, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { LedgerReader, replayState } from "./runtime/ledger.js";
import {
  forkFromCheckpoint,
  type ForkFromCheckpointOptions,
} from "./runtime/forkRun.js";
import type { Run } from "./runManager.js";
import { activeIndexPath, assertSafeRunId, runDir as runDirFor } from "./util/paths.js";
import type { CtrlCommand, LedgerEntry, RunState } from "./types/internal.js";

/** Shape of the `~/.pi/agent/workflows/runs/.active` file. */
export interface ActiveRunsIndex {
  readonly runs: readonly string[];
  readonly updatedAt: string;
}

/** Summary derived from replaying a run's `ledger.jsonl`. */
export interface RunStateSummary {
  readonly runId: string;
  /** Final state derived from replaying all `transition` entries. */
  readonly state: RunState;
  /** All well-formed ledger entries in file order. */
  readonly entries: ReadonlyArray<LedgerEntry>;
  /**
   * Phase names encountered (in start order). Derived from
   * `phase_start` entries.
   */
  readonly phases: ReadonlyArray<string>;
  /**
   * Per-phase agent counts from `phase_end` entries. Keyed by
   * phase name; may be absent if `phase_end` hasn't been written yet.
   */
  readonly agentCounts: Readonly<Record<string, { ok: number; error: number; cacheHit: number }>>;
}

export interface WorkflowClientOptions {
  /**
   * Override the runs home directory (default: `~/.pi/agent/workflows/runs/`).
   * Useful for tests targeting a tmpdir.
   */
  readonly runsHome?: string;
  /**
   * Poll interval in milliseconds for `tailEvents()` (default 200ms).
   * Lower values reduce latency at the cost of more syscalls.
   */
  readonly pollIntervalMs?: number;
}

/**
 * File-based IPC client for pi-workflows supervisor agents.
 *
 * All methods are safe to call from any process; no live pi session is
 * required.
 */
export class WorkflowClient {
  readonly #runsHomeOverride: string | undefined;
  readonly #pollIntervalMs: number;

  constructor(opts?: WorkflowClientOptions) {
    this.#runsHomeOverride = opts?.runsHome;
    this.#pollIntervalMs = opts?.pollIntervalMs ?? 200;
  }

  // ──────────────────────────────────────────────────────────────────
  //  1. Discovery
  // ──────────────────────────────────────────────────────────────────

  /**
   * Read the active-runs index file and return the list of in-flight
   * run IDs. Returns `[]` if the index file doesn't exist yet.
   *
   * The index is maintained by `ActiveRunsRegistry.writeActiveIndex`
   * in the live pi process; it's updated atomically on every registry
   * change. Reads are best-effort — a torn write (in-progress rename)
   * surfaces as an empty list.
   */
  listActiveRuns(): string[] {
    const path = this.#resolveActiveIndexPath();
    try {
      const buf = readFileSync(path, "utf8");
      const parsed = JSON.parse(buf.trim()) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as ActiveRunsIndex).runs)
      ) {
        return (parsed as ActiveRunsIndex).runs.filter(
          (r): r is string => typeof r === "string",
        );
      }
    } catch { /* ENOENT or parse error */ }
    return [];
  }

  /**
   * Read the raw active-runs index, including `updatedAt`. Returns
   * `null` if the file doesn't exist or is malformed.
   */
  readActiveIndex(): ActiveRunsIndex | null {
    const path = this.#resolveActiveIndexPath();
    try {
      const buf = readFileSync(path, "utf8");
      const parsed = JSON.parse(buf.trim()) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as ActiveRunsIndex).runs) &&
        typeof (parsed as ActiveRunsIndex).updatedAt === "string"
      ) {
        return parsed as ActiveRunsIndex;
      }
    } catch { /* ENOENT */ }
    return null;
  }

  // ──────────────────────────────────────────────────────────────────
  //  2. Run state
  // ──────────────────────────────────────────────────────────────────

  /**
   * Read and replay `<runDir>/ledger.jsonl` to derive the current run
   * state, phase list, and agent counts.
   *
   * Returns `null` if the run directory or ledger doesn't exist.
   */
  async getRunState(runId: string): Promise<RunStateSummary | null> {
    const dir = this.#runDir(runId);
    const reader = new LedgerReader({
      runId,
      resolveLedgerPath: () => join(dir, "ledger.jsonl"),
    });
    let result: Awaited<ReturnType<LedgerReader["read"]>>;
    try {
      result = await reader.read();
    } catch {
      return null;
    }
    if (result.entries.length === 0 && result.finalState === "pending") {
      // Distinguish "ledger exists but empty" from "ledger missing"
      // by trying to stat the directory.
      try {
        await fsp.access(dir);
      } catch {
        return null;
      }
    }

    const phases: string[] = [];
    const agentCounts: Record<string, { ok: number; error: number; cacheHit: number }> = {};
    const seenPhases = new Set<string>();

    for (const entry of result.entries) {
      if (entry.type === "phase_start") {
        if (!seenPhases.has(entry.phaseName)) {
          seenPhases.add(entry.phaseName);
          phases.push(entry.phaseName);
        }
      } else if (entry.type === "phase_end") {
        agentCounts[entry.phaseName] = { ...entry.agentResults };
      }
    }

    return {
      runId,
      state: result.finalState,
      entries: result.entries,
      phases,
      agentCounts,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  3. Event tailing
  // ──────────────────────────────────────────────────────────────────

  /**
   * Async generator that yields new `LedgerEntry` values as they are
   * appended to `<runDir>/ledger.jsonl`. Polls the file every
   * `pollIntervalMs` (default 200ms).
   *
   * The generator terminates automatically when a terminal-state
   * `transition` entry (`done`, `failed`, `stopped`, `cancelled-pre-run`)
   * is yielded, unless `opts.follow` is set to `true` (in which case
   * the generator runs until the caller breaks or the process exits).
   *
   * @param opts.since
   *   ISO-8601 timestamp. Only entries whose `at` field is >= this
   *   value are yielded. Useful for resuming a tail after a gap.
   *
   * @param opts.follow
   *   If `true`, continue polling even after a terminal state entry.
   *   Default `false`.
   *
   * @example
   * ```ts
   * for await (const event of client.tailEvents("wf-abc123")) {
   *   if (event.type === "transition") {
   *     console.log(`state: ${event.from} → ${event.to}`);
   *   }
   * }
   * ```
   */
  async *tailEvents(
    runId: string,
    opts?: { since?: string; follow?: boolean },
  ): AsyncGenerator<LedgerEntry, void, unknown> {
    const ledgerFile = join(this.#runDir(runId), "ledger.jsonl");
    const since = opts?.since;
    const follow = opts?.follow ?? false;
    const TERMINAL_STATES = new Set<string>([
      "done", "failed", "stopped", "cancelled-pre-run",
    ]);
    const NON_TERMINAL_STATES = new Set<string>([
      "pending", "approved", "running", "paused",
    ]);

    let bytesRead = 0;
    // Track whether we've already seen a terminal transition so we
    // can break after yielding it (unless follow=true).
    let terminated = false;
    // Cache the byte offset at which we last ran getRunState+replayState.
    // If no new bytes have arrived since the last check that came back
    // non-terminal, the state hasn't changed — skip the redundant replay.
    let lastTerminalCheckAt = -1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let buf: Buffer | null = null;
      try {
        buf = await fsp.readFile(ledgerFile);
      } catch {
        // File doesn't exist yet — wait and retry.
        await sleep(this.#pollIntervalMs);
        continue;
      }

      if (buf.length > bytesRead) {
        const newData = buf.slice(bytesRead).toString("utf8");
        bytesRead = buf.length;

        const lines = newData.split("\n");
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch { continue; }
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) continue;
          const entry = parsed as LedgerEntry;

          // `since` filter: skip entries older than the requested timestamp.
          if (since !== undefined && "at" in entry) {
            if ((entry as { at: string }).at < since) continue;
          }

          yield entry;

          // Check for terminal state — auto-stop unless follow=true.
          if (!follow && entry.type === "transition") {
            const trans = entry as Extract<LedgerEntry, { type: "transition" }>;
            if (TERMINAL_STATES.has(trans.to)) {
              terminated = true;
              break;
            }
          }
        }
      }

      if (terminated && !follow) break;

      // If the run is terminal AND we've consumed all data, stop
      // polling (avoids spinning forever on a completed run).
      //
      // Re-read the ledger before consulting getRunState so the length
      // guard is meaningful.  After the inner loop, bytesRead is always
      // set to buf.length, so `buf.length === bytesRead` was always true
      // and provided no real protection.  With a fresh read, the guard
      // `freshBuf.length === bytesRead` is a real check: if new bytes
      // have appeared since buf was read (e.g. a terminal transition
      // landed after the readFile at the top of this iteration), we skip
      // the break and let the next iteration yield those bytes normally.
      if (!follow) {
        const freshBuf = await fsp.readFile(ledgerFile).catch(() => null);
        if (freshBuf !== null && freshBuf.length === bytesRead) {
          // Only recompute state when new bytes have arrived since the
          // last check.  If bytesRead hasn't changed the ledger is
          // identical, so the replay result would be the same.
          if (lastTerminalCheckAt === bytesRead) {
            await sleep(this.#pollIntervalMs);
            continue;
          }
          lastTerminalCheckAt = bytesRead;
          const currentState = replayState(
            (await this.getRunState(runId))?.entries ?? [],
          );
          if (TERMINAL_STATES.has(currentState)) {
            // Drain any bytes written between the freshBuf snapshot and
            // getRunState's internal readFile — the terminal transition
            // may have landed in that window and would never be yielded
            // without this pass.
            const drainBuf = await fsp.readFile(ledgerFile).catch(() => null);
            if (drainBuf !== null && drainBuf.length > bytesRead) {
              const newData = drainBuf.slice(bytesRead).toString("utf8");
              bytesRead = drainBuf.length;
              for (const rawLine of newData.split("\n")) {
                const line = rawLine.trim();
                if (!line) continue;
                let parsed: unknown;
                try { parsed = JSON.parse(line); } catch { continue; }
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
                const entry = parsed as LedgerEntry;
                if (since !== undefined && "at" in entry &&
                    (entry as { at: string }).at < since) continue;
                yield entry;
              }
            }
            break;
          }
        }
      }

      await sleep(this.#pollIntervalMs);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  4. Control
  // ──────────────────────────────────────────────────────────────────

  /**
   * Send a control command to a running workflow by appending to
   * `<runDir>/ctrl.jsonl`. The run's ctrl-file watcher will pick it
   * up and dispatch to `run.pause()`, `run.resumePaused()`, or
   * `run.stop()`.
   *
   * The write is synchronous + fsynced so the command is durable
   * before this method resolves.
   *
   * @throws if the run directory doesn't exist, the run is already in a
   *   terminal state, or the write fails.
   */
  async sendControl(
    runId: string,
    cmd: Pick<CtrlCommand, "type"> & Partial<CtrlCommand>,
  ): Promise<void> {
    const dir = this.#runDir(runId);
    // Ensure the run directory exists.
    await fsp.mkdir(dir, { recursive: true });
    const line =
      JSON.stringify({
        type: cmd.type,
        at: new Date().toISOString(),
        ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}),
        ...(cmd.value !== undefined ? { value: cmd.value } : {}),
        ...(cmd.key !== undefined ? { key: cmd.key } : {}),
      } satisfies CtrlCommand) + "\n";
    const ctrlFile = join(dir, "ctrl.jsonl");
    const fd = openSync(ctrlFile, "a", 0o644);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * ZONE_HITL: deliver an answer to a pending `ctx.interrupt(...)`
   * call running in the target workflow. Equivalent to
   * `sendControl(runId, { type: "resume-interrupt", value, key })`
   * but with a friendlier signature.
   *
   * `value` must be JSON-cloneable — it is serialised verbatim into
   * `<runDir>/ctrl.jsonl` and rehydrated on the run side.
   *
   * `opts.key` is optional; when omitted the run resolves its
   * FIFO-oldest pending interrupt (the typical "answer the current
   * question" workflow). Pass an explicit key when targeting a
   * specific call site (e.g. multiple concurrent interrupts).
   *
   * The write is synchronous + fsynced so the answer is durable
   * before this method resolves.
   *
   * @throws if the run directory doesn't exist or the write fails.
   */
  async resume(
    runId: string,
    value: unknown,
    opts?: { readonly key?: string },
  ): Promise<void> {
    // JSON-clone defense — catches cycles/realm-leaks at the supervisor
    // boundary so the failure surfaces here, not on the run side.
    try {
      JSON.stringify(value === undefined ? null : value);
    } catch (cycErr) {
      throw new TypeError(
        `WorkflowClient.resume: value is not JSON-serializable (${(cycErr as Error).message})`,
      );
    }
    const cmd: Pick<CtrlCommand, "type"> & Partial<CtrlCommand> = {
      type: "resume-interrupt",
      value: value === undefined ? null : value,
    };
    if (opts?.key !== undefined) (cmd as { key?: string }).key = opts.key;
    await this.sendControl(runId, cmd);
  }

  // ──────────────────────────────────────────────────────────────────
  //  5. Time travel — fork-from-checkpoint (ZONE_TIMETRAVEL)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Fork a new workflow run from `parentRunId` at the named phase.
   *
   * The new run inherits the parent's ledger + cache state up to (but
   * not including) the `phase_start` for `opts.atPhase`. Phase-1
   * agents replay from cache; phases at or after the fork point are
   * re-dispatched, optionally with `opts.overrides` exposed via
   * `await ctx.cache.get('__fork_overrides__')`.
   *
   * The parent run is left intact — its ledger / cache / manifest are
   * not touched. The new run's manifest carries `parentRunId` +
   * `forkAtPhase` for lineage.
   *
   * Note: `WorkflowClient` is otherwise pure file-IO; this method is
   * the one exception — it spawns a real run via the runtime
   * substrate (sandbox, dispatcher, ledger). Callers that don't need
   * to actually start a run should call the lower-level
   * `forkFromCheckpoint` runtime export and inspect the seeded
   * runDir directly.
   *
   * @example
   * ```ts
   * const client = new WorkflowClient();
   * const fork = await client.forkFromCheckpoint("wf-abc123", {
   *   atPhase: "plan",
   *   overrides: { strategy: "alt-B" },
   *   preApproved: true,
   * });
   * await fork.terminated;
   * ```
   */
  async forkFromCheckpoint(
    parentRunId: string,
    opts: ForkFromCheckpointOptions,
  ): Promise<Run> {
    const merged: ForkFromCheckpointOptions =
      this.#runsHomeOverride !== undefined && opts.resolveRunDir === undefined
        ? { ...opts, resolveRunDir: (id: string) => { assertSafeRunId(id); return join(this.#runsHomeOverride!, id); } }
        : opts;
    return forkFromCheckpoint(parentRunId, merged);
  }

  // ──────────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────────

  #runDir(runId: string): string {
    assertSafeRunId(runId);
    if (this.#runsHomeOverride !== undefined) {
      return join(this.#runsHomeOverride, runId);
    }
    return runDirFor(runId);
  }

  #resolveActiveIndexPath(): string {
    if (this.#runsHomeOverride !== undefined) {
      return join(this.#runsHomeOverride, ".active");
    }
    return activeIndexPath();
  }
}

// ─── Helper ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
