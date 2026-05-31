/**
 * pi-workflows — run-state ledger (PRD §5.2 + §6.4, plan §4 Slice 7).
 *
 * On-disk format: append-only JSONL at `<runDir>/ledger.jsonl`. Every
 * entry is one of `LedgerEntry` (see `src/types/internal.d.ts`). Slice
 * 7 owns the writer/reader/state-machine substrate; slice 8a wires
 * the runtime emissions; slice 11 reads the file to resume a run after
 * a pi crash.
 *
 * Crash-consistency contract (mirrors slice 3's `cache.jsonl`):
 *   - Append: build the full JSON line in memory → single `write` →
 *     `fsync` → only then return success. A SIGKILL during the write
 *     can leave a torn trailing line; replay tolerates it (silent drop
 *     iff the last line lacks a trailing `\n`).
 *   - No mid-file rewrite. Append-only is load-bearing for the
 *     resume-from-disk story (slice 11).
 *   - Mid-file corruption (a corrupt interior line) emits a warning
 *     and is skipped. Slice 11 inspects `warnings` to decide whether
 *     to refuse resume — that's a slice-11 policy call, not slice 7's.
 *
 * Concurrency:
 *   - All writes funnel through `this.writeQueue` (a Promise chain).
 *     Plan-acceptance demands FIFO ordering for concurrent appends
 *     (`100 concurrent appends produce monotonically-ordered records`).
 *
 * v1 fsync policy:
 *   - Plan §4 Slice 7 risk box pins the v1 default to "fsync per
 *     write" — the simpler invariant — and documents the per-record
 *     batching as a v2 follow-up if integration tests show >50ms
 *     overhead. Slice 7 ships the simple form. The `flushPolicy`
 *     option is forward-declared but unused (asserts at runtime if
 *     callers try to set it to anything but `"per-write"`).
 *
 * State machine:
 *   - `isValidTransition(from, to)` is the pure validator (no side
 *     effects, no I/O) — used by tests AND by `RunStateMachine.go()`
 *     to gate persistence. The validator is the single source of
 *     truth for PRD §5.2's diagram.
 *   - `RunStateMachine.go(to, opts?)` validates + appends a
 *     `transition` entry to the ledger on success. Throws
 *     `InvalidStateTransitionError` on failure (state stays put).
 *   - `RunStateMachine.replayState(entries)` is the pure-function
 *     replay used by `LedgerReader.read()` and by slice 11's
 *     resume-orchestration (which may bypass disk).
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  promises as fsp,
  writeSync,
} from "node:fs";

import { ledgerPath as defaultLedgerPath } from "../util/paths.ts";
import {
  AgentSubprocessError,
  MalformedAgentOutputError,
  MockFixtureMissingError,
} from "./errors.ts";
import type {
  LedgerAgentError,
  LedgerEntry,
  LedgerLogSink,
  LedgerReadResult,
  LedgerWarning,
  RunState,
} from "../types/internal.d.ts";

// ─── State machine ─────────────────────────────────────────────────────

/** All non-terminal states. Slice 11 uses this to identify resumable runs. */
export const NON_TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "pending",
  "approved",
  "running",
  "paused",
]);

/** Terminal states — no further transition is legal. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "done",
  "failed",
  "stopped",
  "cancelled-pre-run",
]);

/**
 * Resumable-after-pi-crash states (PRD §5.2). `running` is treated as
 * crashed-mid-run; resume re-enters `running` after replaying cached
 * agent results. Slice 11 owns the actual resume orchestration; this
 * set is a contract we publish for that consumer.
 */
export const RESUMABLE_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "paused",
  "running",
  "approved",
  "pending",
]);

/**
 * Static transition table. Every legal edge is enumerated here per
 * PRD §5.2 — anything not listed is illegal.
 *
 * Edge legend (user-initiated vs system-initiated):
 *   pending       → approved           USER (approval prompt accept)
 *   pending       → cancelled-pre-run  USER (rejected via [N], [Esc],
 *                                       or `disabled` mid-prompt)
 *   approved      → running            SYSTEM (RunManager.start)
 *   running       → paused             USER (`p` in TUI overlay)
 *   paused        → running            USER (`p` again to resume)
 *   running       → done               SYSTEM (main() resolved)
 *   running       → failed             SYSTEM (uncaught throw / timeout
 *                                       / sandbox violation)
 *   running       → stopped            USER (`x` in TUI / Ctrl+C / SIGTERM)
 *   paused        → stopped            USER (`x` while paused)
 *   paused        → failed             SYSTEM (only via crash sweep —
 *                                       a paused run can't legitimately
 *                                       fail without first transitioning
 *                                       back to `running`. Reserved for
 *                                       slice 11 sweep that may decide to
 *                                       fail-fast on resume conflict.)
 *   failed        → running            SYSTEM (slice 11 advisory
 *                                       resume-rollback per PRD §5.8.2;
 *                                       only emitted by `resumeRun` when
 *                                       the sweep flipped a run to
 *                                       `failed: parent-crash`. Other
 *                                       `failed` runs are non-resumable.)
 *
 * Resume-after-crash specifically does NOT cross any edge — slice 11
 * picks up at the last-seen state directly. Hence no `<terminal> → X`
 * edge exists; replay just sees the existing state and stops there.
 */
const TRANSITIONS: ReadonlyMap<RunState, ReadonlySet<RunState>> = new Map([
  ["pending", new Set<RunState>(["approved", "cancelled-pre-run"])],
  ["approved", new Set<RunState>(["running"])],
  ["running", new Set<RunState>(["paused", "done", "failed", "stopped"])],
  ["paused", new Set<RunState>(["running", "stopped", "failed"])],
  // Slice 11: `failed` has a single advisory outgoing edge for the
  // resume-rollback case. `done`, `stopped`, `cancelled-pre-run`
  // remain truly terminal (no outgoing edges).
  ["failed", new Set<RunState>(["running"])],
  ["done", new Set<RunState>()],
  ["stopped", new Set<RunState>()],
  ["cancelled-pre-run", new Set<RunState>()],
]);

/**
 * Pure validator. Returns `true` iff `from → to` is a legal
 * transition per the PRD §5.2 diagram. No I/O, no side effects,
 * no construction of new objects per call (the inner `Set.has` is
 * the only allocation-free hot path).
 *
 * Tests rely on this purity — see `tests/unit/ledger.test.ts` "state
 * machine: every illegal transition is rejected".
 */
export function isValidTransition(from: RunState, to: RunState): boolean {
  const allowed = TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/** Raised by `RunStateMachine.go` (and only there). */
export class InvalidStateTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;
  constructor(from: RunState, to: RunState) {
    super(`invalid state transition: ${from} → ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Mutable state machine that emits ledger entries on each transition.
 *
 * Construction starts at `pending`. `go(to)` validates + appends a
 * `transition` entry through the supplied writer. Throws
 * `InvalidStateTransitionError` (and leaves the state untouched) on
 * any illegal edge.
 *
 * Slice 8a's `RunCtx` owns one of these per run; `replayState()`
 * (the pure-function version) is what slice 11 uses to derive state
 * from `LedgerReader.read().entries`.
 */
export class RunStateMachine {
  private currentState: RunState;
  private readonly writer: LedgerWriter;
  private readonly now: () => string;
  /**
   * Serialization queue for `go()` calls. Concurrent callers chain
   * onto this promise so that validate+append+advance is atomic with
   * respect to other callers (BUG-027). The queue tail is kept as a
   * settled promise (`.catch(() => undefined)`) so a failed step does
   * not block subsequent valid transitions — mirrors the pattern used
   * by `LedgerWriter.writeQueue`.
   */
  private goQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    readonly writer: LedgerWriter;
    readonly initialState?: RunState;
    readonly now?: () => string;
  }) {
    this.writer = opts.writer;
    this.currentState = opts.initialState ?? "pending";
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Current state. Reads are O(1). */
  get state(): RunState {
    return this.currentState;
  }

  /**
   * Validate + emit the transition. On success, the in-memory
   * `currentState` advances and a `transition` entry is appended to
   * the ledger (fsync'd before this method resolves). On failure,
   * throws `InvalidStateTransitionError` and state stays put.
   *
   * `reason` is intended for involuntary transitions (e.g. crash
   * sweep emits `"parent-crash"` per PRD §5.8.2). Slice 7 doesn't
   * enforce a vocabulary — that's downstream.
   *
   * Concurrency: calls are serialized through `goQueue` so that the
   * validate+append+advance sequence is atomic w.r.t. concurrent
   * callers. Each `step` promise still rejects to its individual
   * caller; the queue tail is kept settled so a failed step does not
   * block future transitions.
   */
  async go(to: RunState, opts?: { readonly reason?: string }): Promise<void> {
    const step = this.goQueue.then(async () => {
      const from = this.currentState;
      if (!isValidTransition(from, to)) {
        throw new InvalidStateTransitionError(from, to);
      }
      const entry: LedgerEntry =
        opts?.reason !== undefined
          ? { type: "transition", at: this.now(), from, to, reason: opts.reason }
          : { type: "transition", at: this.now(), from, to };
      await this.writer.append(entry);
      this.currentState = to;
    });
    // Keep the queue alive even when this step rejects, so future
    // go() calls are not blocked by an earlier invalid-transition error.
    this.goQueue = step.catch(() => undefined);
    return step;
  }
}

/**
 * Pure-function replay over a sequence of entries. Returns the final
 * derived state plus the warnings accumulated during replay (illegal
 * transitions skipped + reported).
 *
 * Slice 11 calls this on `LedgerReader.read().entries`. It's also
 * what `LedgerReader.read()` itself uses to populate `finalState`.
 */
export function replayState(
  entries: ReadonlyArray<LedgerEntry>,
  warningsSink?: (w: LedgerWarning) => void,
): RunState {
  let state: RunState = "pending";
  // Track entry index in the original array so warnings can carry a
  // useful `lineIndex`. The reader passes the same index space (the
  // `init` entry is index 0, etc.) — even though the ledger reader
  // might filter junk lines, this is "best-effort lineIndex" and not
  // load-bearing for correctness.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "transition") continue;
    if (!isValidTransition(state, entry.to)) {
      warningsSink?.({
        kind: "invalid-transition",
        lineIndex: i,
        from: state,
        to: entry.to,
      });
      continue;
    }
    state = entry.to;
  }
  return state;
}

// ─── Writer ────────────────────────────────────────────────────────────

export interface LedgerWriterOptions {
  /** Run id (`wf-<12hex>`). Used to derive `<runDir>/ledger.jsonl`. */
  readonly runId: string;
  /** Override path resolver — tests target a tmpdir. */
  readonly resolveLedgerPath?: (runId: string) => string;
  /** Sink for reader-side warnings. Default: silent. */
  readonly log?: LedgerLogSink;
  /**
   * v1 only accepts `"per-write"`. Plan §4 Slice 7 risk box pins this
   * as the v1 default; the field is retained so v2 can introduce
   * batching without breaking the constructor signature.
   */
  readonly flushPolicy?: "per-write";
}

/**
 * Append-only ledger writer. One instance per run.
 *
 * Lifecycle:
 *   1. `new LedgerWriter({ runId })` — instance ready, no I/O yet.
 *   2. `await append(entry)` — serializes through `writeQueue`, opens
 *      the file with `O_APPEND | O_CREAT`, writes one line, fsync's,
 *      closes. Resolves once durable.
 *   3. `flush()` — awaits the queue tail (test convenience).
 *
 * The class is intentionally NOT `EventEmitter`-based; slice 13's
 * TUI overlay tails the file via `LedgerReader` rather than
 * subscribing to writer events.
 */
export class LedgerWriter {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: LedgerWriterOptions) {
    if (opts.flushPolicy && opts.flushPolicy !== "per-write") {
      throw new Error(
        `LedgerWriter: v1 only supports flushPolicy="per-write" (got "${opts.flushPolicy}")`,
      );
    }
    const resolve = opts.resolveLedgerPath ?? defaultLedgerPath;
    this.path = resolve(opts.runId);
  }

  /** Read-only path accessor — slice 13 needs this for the tail follow. */
  get ledgerFilePath(): string {
    return this.path;
  }

  /**
   * Append one entry. Resolves when fsync has succeeded on the
   * appended bytes. Throws on disk error (caller decides whether to
   * abort the run).
   */
  append(entry: LedgerEntry): Promise<void> {
    // Build the full JSON line outside the queue tail to keep the
    // critical section short. JSON.stringify on a fresh discriminated
    // union value is safe (no cycles by construction).
    const line = JSON.stringify(entry) + "\n";
    const next = this.writeQueue.then(() => this.appendLineSync(line));
    // Silence unhandled rejection if a later step doesn't await; the
    // queue itself swallows by overwriting its tail with `.catch`.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /** Awaitable barrier for the write queue. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Synchronous open-write-fsync-close. Same pattern as
   * `CacheStore.appendLineSync` (slice 3): a single `appendRecord`
   * call behaves as one durability unit (no other microtasks
   * interleave between write and fsync).
   */
  private async appendLineSync(line: string): Promise<void> {
    let fd: number | undefined;
    try {
      // O_WRONLY | O_CREAT | O_APPEND, mode 0644.
      fd = openSync(this.path, "a", 0o644);
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

// ─── Reader ────────────────────────────────────────────────────────────

export interface LedgerReaderOptions {
  readonly runId: string;
  readonly resolveLedgerPath?: (runId: string) => string;
  readonly log?: LedgerLogSink;
}

/**
 * Corruption-tolerant reader. Returns the full entry list plus the
 * derived final state. Slice 11 (resume) is the primary consumer.
 *
 * Tolerances:
 *   - Missing file → `{ entries: [], finalState: "pending", warnings: [] }`.
 *   - Empty file → same.
 *   - Trailing torn line (no final `\n`) → silent drop.
 *   - Mid-file corrupt JSON → warn + skip.
 *   - Non-object record → warn + skip.
 *   - Unknown discriminator → warn + skip.
 *   - Illegal transition → warn (kind: "invalid-transition") + skip
 *     (state replay does NOT advance through it).
 *
 * Hard errors (re-thrown):
 *   - File exists but `readFile` throws something other than ENOENT
 *     (permission denied, EISDIR, etc).
 */
export class LedgerReader {
  private readonly path: string;
  private readonly log: LedgerLogSink;

  constructor(opts: LedgerReaderOptions) {
    const resolve = opts.resolveLedgerPath ?? defaultLedgerPath;
    this.path = resolve(opts.runId);
    this.log = opts.log ?? (() => {});
  }

  async read(): Promise<LedgerReadResult> {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.path);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        return { entries: [], finalState: "pending", warnings: [] };
      }
      throw err;
    }
    if (buf.length === 0) {
      return { entries: [], finalState: "pending", warnings: [] };
    }

    const text = buf.toString("utf8");
    const endsWithNewline = text.endsWith("\n");
    const parts = text.split("\n");
    if (endsWithNewline) parts.pop(); // drop the empty tail after final \n

    const lastIdx = parts.length - 1;
    const entries: LedgerEntry[] = [];
    const warnings: LedgerWarning[] = [];

    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] ?? "";
      if (line.length === 0) {
        // Empty interior line — corruption-light. Skip silently per
        // the cache.ts precedent.
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err: unknown) {
        // Torn-trailing-line escape: only when there was no trailing
        // newline AND we're on the very last line. Silent drop.
        if (i === lastIdx && !endsWithNewline) {
          warnings.push({ kind: "torn-tail", lineIndex: i });
          this.log("warn", "ledger: dropped torn trailing line", {
            path: this.path,
            lineIndex: i,
          });
          continue;
        }
        const msg = (err as Error)?.message ?? String(err);
        warnings.push({ kind: "corrupt-line", lineIndex: i, error: msg });
        this.log("warn", "ledger: skipping corrupt line", {
          path: this.path,
          lineIndex: i,
          error: msg,
        });
        continue;
      }
      const entry = this.classifyRecord(parsed, i, warnings);
      if (entry !== null) entries.push(entry);
    }

    // Replay state with warnings flowing into the same array. The
    // pure-function replay's `lineIndex` is the index into `entries`
    // (NOT the original line index in the file) — close-enough for
    // diagnostics; precise mid-file corruption indices are already
    // captured above.
    const finalState = replayState(entries, (w) => warnings.push(w));

    return { entries, finalState, warnings };
  }

  /**
   * Validate that a parsed JSON value matches the LedgerEntry shape.
   * Returns the entry on success, `null` on rejection (and pushes a
   * warning to `warnings`).
   */
  private classifyRecord(
    parsed: unknown,
    lineIndex: number,
    warnings: LedgerWarning[],
  ): LedgerEntry | null {
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      warnings.push({ kind: "non-object", lineIndex });
      this.log("warn", "ledger: non-object record", {
        path: this.path,
        lineIndex,
      });
      return null;
    }
    const r = parsed as Record<string, unknown>;
    const t = r["type"];
    // Single-shot dispatch. We don't deep-validate every field — a
    // too-strict reader would refuse to replay a future-version
    // ledger with new fields. Only the discriminator + the fields
    // load-bearing for replay are verified.
    switch (t) {
      case "init":
      case "transition":
      case "cancelled":
      case "phase_start":
      case "phase_end":
      case "agent_start":
      case "agent_end":
      case "agent_error":
      case "agent_cache_hit":
      case "agent_log":
      case "log":
      case "pause":
      case "resume":
      case "shutdown":
      case "result":
      case "error":
      case "gate_requested":
      case "gate_resolved":
      case "interrupt_requested":
      case "interrupt_resolved":
      case "appendEntry":
        // Trust upstream — fields are emitted by writer in this
        // package; downstream readers shouldn't refuse a record
        // because of a single missing optional field.
        return r as unknown as LedgerEntry;
      default:
        warnings.push({
          kind: "unknown-type",
          lineIndex,
          recordType: String(t),
        });
        this.log("warn", "ledger: unknown record type", {
          path: this.path,
          lineIndex,
          recordType: String(t),
        });
        return null;
    }
  }
}

// ─── log() helper ──────────────────────────────────────────────────────

/**
 * Workflow author's `log()` API substrate (plan §4 Slice 7 + brief
 * section E).
 *
 * Slice 7 ships the host-side function. Slice 8a's `ctx.log` wraps
 * this via the closure-capture-and-delete pattern (per
 * `slice_8a_concerns` note: every Context-realm-callable must wrap
 * via `wrapHostMethod` to avoid the `Function.constructor("return
 * process")()` realm-pierce). Slice 7 itself does NOT install
 * anything on the sandbox Context.
 */
export async function log(
  writer: LedgerWriter,
  level: "info" | "warn" | "error",
  message: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await writer.append({ type: "log", at: now(), level, message });
}

// ─── Error → ledger helper ─────────────────────────────────────────────

const MAX_AGENT_ERROR_BYTES = 256;

/**
 * Byte-aware truncation. Slice 8a fix per `slice_8a_concerns#H9`:
 * the previous implementation sliced UTF-16 code units, which under-
 * counts cap when the input contains multi-byte characters. Switch to
 * Buffer-based slicing so the cap is exact in bytes (matching
 * `buildResultEntry` below).
 */
function truncBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  return buf.subarray(0, max).toString("utf8");
}

/**
 * Convert a thrown exception into a `LedgerAgentError` payload.
 * Preserves the slice-6 error-class discriminators per critic-ndpq's
 * concern: the ledger MUST persist `MalformedAgentOutputError` and
 * `AgentSubprocessError` distinctly, with their distinct forensic
 * fields. `MockFixtureMissingError` round-trips with its key fields.
 * Anything else falls through to `class: "Unknown"` with a
 * best-effort message + name.
 */
export function agentErrorFromException(err: unknown): LedgerAgentError {
  if (err instanceof MalformedAgentOutputError) {
    return {
      class: "MalformedAgentOutput",
      reason: err.reason,
      lineNumber: err.lineNumber,
      bytes: truncBytes(err.bytes ?? "", MAX_AGENT_ERROR_BYTES),
      exitCode: err.exitCode,
      cwd: err.cwd,
    };
  }
  if (err instanceof AgentSubprocessError) {
    return {
      class: "AgentSubprocess",
      exitCode: err.exitCode,
      signal: err.signal,
      message: err.message,
    };
  }
  if (err instanceof MockFixtureMissingError) {
    return {
      class: "MockFixtureMissing",
      promptHash: err.promptHash,
      runDir: err.runDir,
    };
  }
  const e = err as { message?: unknown; name?: unknown };
  const name = typeof e?.name === "string" ? e.name : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  return name === undefined
    ? { class: "Unknown", message }
    : { class: "Unknown", message, name };
}

// ─── result truncation helper ──────────────────────────────────────────

/** PRD §6.4: result entries truncate to ≤4KB stringified. */
export const LEDGER_RESULT_MAX_BYTES = 4096;

/**
 * Stringify-and-truncate a `main()` resolution for a `result` entry.
 * Returns `{ result, truncated }` matching the LedgerEntry shape.
 *
 * Truncation works on byte length (UTF-8) — multi-byte characters at
 * the boundary may be split. The slice-7 contract is "≤4KB", not
 * "valid UTF-8 at the boundary" (slice 13's overlay re-decodes as
 * UTF-8 with replacement chars, so this is fine).
 */
export function buildResultEntry(
  value: unknown,
  now: () => string = () => new Date().toISOString(),
): Extract<LedgerEntry, { type: "result" }> {
  let s: string;
  try {
    // JSON.stringify(undefined) returns JS undefined (not a string), so normalise
    // undefined → null before serialising so the ledger never stores the literal
    // string "undefined" (which is not valid JSON and misleads readers).
    const normalised = value === undefined ? null : value;
    s = typeof normalised === "string" ? normalised : JSON.stringify(normalised);
  } catch {
    s = String(value);
  }
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= LEDGER_RESULT_MAX_BYTES) {
    return { type: "result", at: now(), truncated: false, result: s };
  }
  // Truncate by byte length. We slice on the byte buffer to keep the
  // 4KB cap exact even with multi-byte chars in s.
  const buf = Buffer.from(s, "utf8");
  const truncated = buf.subarray(0, LEDGER_RESULT_MAX_BYTES).toString("utf8");
  return { type: "result", at: now(), truncated: true, result: truncated };
}
