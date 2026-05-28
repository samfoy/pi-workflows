/**
 * pi-workflows — dispatcher error contract (slice 6).
 *
 * Three error classes the dispatcher can reject with. They are
 * intentionally narrow — slice 8a's `ctx.phase` aggregates these into
 * an `AggregateError` per PRD §5.5.2.
 *
 * Field-shape rules:
 *   - All three carry an `agentId` so the run/phase can route the
 *     failure into the ledger (slice 7) without re-parsing messages.
 *   - `MalformedAgentOutputError` is the parse-failure / empty-stdout
 *     / unexpected-schema family per PRD §5.5.2's table; the bytes
 *     captured for forensics are bounded by `JsonStreamError`'s 256-
 *     byte cap before construction.
 *   - `AgentSubprocessError` is the orthogonal "child died with no
 *     `agent_end` event" path. Distinguishable via `instanceof`.
 *   - `MockFixtureMissingError` is the mock-mode no-fixture path.
 *     Constructive message that points the author at the missing key.
 */

export class MalformedAgentOutputError extends Error {
  /** Agent id (so the ledger can attribute the failure). */
  readonly agentId: string;
  /** Working dir of the failed child — useful for repro. */
  readonly cwd: string;
  /** Child exit code, or `null` if it never spawned / hadn't exited. */
  readonly exitCode: number | null;
  /** Up to 256 bytes of the offending region. */
  readonly bytes: string;
  /** 1-indexed line number from the parser, or `null` for empty-stdout. */
  readonly lineNumber: number | null;
  /** Why the dispatcher classified the output as malformed. */
  readonly reason:
    | "parse"
    | "non-object"
    | "trailing"
    | "empty-stdout-success"
    | "empty-stdout-failure"
    | "no-agent-end-event"
    | "unexpected-schema";

  constructor(opts: {
    agentId: string;
    cwd: string;
    exitCode: number | null;
    bytes: string;
    lineNumber: number | null;
    reason: MalformedAgentOutputError["reason"];
    cause?: unknown;
  }) {
    super(
      `malformed agent output (agent=${opts.agentId} reason=${opts.reason} exit=${opts.exitCode ?? "null"})`,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "MalformedAgentOutputError";
    this.agentId = opts.agentId;
    this.cwd = opts.cwd;
    this.exitCode = opts.exitCode;
    this.bytes = opts.bytes;
    this.lineNumber = opts.lineNumber;
    this.reason = opts.reason;
  }
}

export class AgentSubprocessError extends Error {
  readonly agentId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(opts: {
    agentId: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    cause?: unknown;
  }) {
    super(
      `agent subprocess failed (agent=${opts.agentId} exit=${opts.exitCode ?? "null"} signal=${opts.signal ?? "null"})`,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "AgentSubprocessError";
    this.agentId = opts.agentId;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal;
  }
}

export class MockFixtureMissingError extends Error {
  readonly agentId: string;
  readonly promptHash: string;
  readonly runDir: string;

  constructor(opts: { agentId: string; promptHash: string; runDir: string }) {
    super(
      `mock-agents fixture missing for agent="${opts.agentId}" promptHash=${opts.promptHash.slice(0, 12)}… in ${opts.runDir}/fixtures.jsonl`,
    );
    this.name = "MockFixtureMissingError";
    this.agentId = opts.agentId;
    this.promptHash = opts.promptHash;
    this.runDir = opts.runDir;
  }
}
