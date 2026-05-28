/**
 * Slice 5 — NDJSON stream parser for `pi --mode json` subprocess output.
 *
 * Consumed by slice 6's `dispatchAgent` (PRD §5.5). The parser is the
 * plumbing layer between a child's `stdout` Readable and the dispatcher's
 * book-keeping; it has zero opinion about pi-mode-json's event schema
 * beyond two assumptions:
 *
 *   1. Each line is a complete JSON object (NDJSON; tolerates `\n` and
 *      `\r\n`). Empty / whitespace-only lines are skipped.
 *   2. Exactly one event in the stream represents the final result and
 *      is identified by an `isResultEvent` predicate (default:
 *      `event.type === "result"`). The first match latches.
 *
 * Anything else — unknown `type`, missing fields, embedded newlines
 * inside JSON-encoded strings — is surfaced verbatim. The dispatcher
 * decides what to do.
 *
 * Failure model (plan.md §4 Slice 5 + PRD §5.5.2):
 *
 *   - Parse error at any line throws `JsonStreamError` carrying the
 *     line content (truncated to 256 bytes), the 1-indexed line
 *     number, and the byte offset where the line started.
 *   - The dispatcher (slice 6) catches and re-wraps as
 *     `MalformedAgentOutputError` with the agent's cwd + child exit
 *     code attached.
 *   - An end-of-stream remainder that is non-empty but isn't a
 *     terminating-newline-less complete JSON object is treated as
 *     malformed and throws.
 *   - An empty stream yields zero events and `getResult()` returns
 *     `undefined`. The caller distinguishes legitimately-empty from
 *     crashed-mid-flight via `child.exitCode`.
 *
 * Tee-to-file (plan.md §4 Slice 5 acceptance):
 *
 *   - The raw byte stream (pre-parse, exactly as received) is written
 *     to the `tee` WritableStream if provided.
 *   - The tee has a hard cap (default 16 MiB per plan). When the cap
 *     would be exceeded, the partial chunk is truncated, a single
 *     marker line `{"type":"__pi_workflows_tee_truncated__",...}` is
 *     written, and all subsequent tee writes are dropped silently.
 *     The marker line schema is the source of truth; slice 6 docs
 *     `<runId>/agents/<agentId>.jsonl` references it (PRD §5.5.2
 *     forensics).
 *
 * The parser does NOT close the tee — that's the caller's
 * responsibility. The tee receives raw bytes regardless of whether
 * those bytes parse; this is deliberate so a corruption witness
 * survives even when parsing throws.
 */

import type { Readable } from "node:stream";

// ───────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────

/** Default tee cap, in bytes, when `opts.maxTeeBytes` is not provided. */
export const DEFAULT_MAX_TEE_BYTES = 16 * 1024 * 1024;

/** Maximum truncated-region length carried on `JsonStreamError`. */
export const TRUNCATED_REGION_MAX = 256;

/**
 * Marker line written to the tee file when the cap is exceeded. The
 * trailing newline is part of the marker — readers detect it as a
 * complete NDJSON line.
 */
export const TEE_TRUNCATED_MARKER_TYPE = "__pi_workflows_tee_truncated__";

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

/**
 * A single parsed NDJSON event. Schema-agnostic: the parser yields any
 * object it can parse. Slice 6's dispatcher narrows + validates.
 */
export interface JsonStreamEvent {
  readonly type?: string;
  readonly [extra: string]: unknown;
}

export interface ParseJsonStreamOptions {
  /**
   * Optional tee target. Receives the raw byte stream up to the cap;
   * after the cap a single marker line is written and writes stop.
   * The parser never calls `.end()` — caller closes.
   */
  readonly tee?: NodeJS.WritableStream;

  /**
   * Hard cap on bytes written to `tee`. Default 16 MiB per plan.
   * Set to `0` to disable (no cap, no marker line).
   */
  readonly maxTeeBytes?: number;

  /**
   * Predicate identifying the final result event. The first event for
   * which this returns `true` is latched and surfaced via
   * `getResult()`. Default: `event.type === "result"`.
   */
  readonly isResultEvent?: (event: JsonStreamEvent) => boolean;

  /**
   * Aborts parsing. The generator throws the abort reason on the
   * next loop iteration after the signal fires. Already-yielded
   * events are not retracted.
   */
  readonly signal?: AbortSignal;
}

/**
 * Thrown when a complete NDJSON line cannot be parsed as a JSON
 * object. The dispatcher (slice 6) catches and re-wraps as
 * `MalformedAgentOutputError` with subprocess context attached.
 */
export class JsonStreamError extends Error {
  /** Up to TRUNCATED_REGION_MAX bytes of the offending line content. */
  readonly truncatedRegion: string;
  /** 1-indexed line number within the stream (counting non-empty + empty lines). */
  readonly lineNumber: number;
  /** Byte offset where the offending line began, within the raw input stream. */
  readonly byteOffset: number;
  /** Reason — "parse" (JSON.parse threw), "non-object" (parsed but not an object), or "trailing" (unterminated tail that didn't parse). */
  readonly reason: "parse" | "non-object" | "trailing";

  constructor(
    message: string,
    opts: {
      truncatedRegion: string;
      lineNumber: number;
      byteOffset: number;
      reason: "parse" | "non-object" | "trailing";
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JsonStreamError";
    this.truncatedRegion = opts.truncatedRegion;
    this.lineNumber = opts.lineNumber;
    this.byteOffset = opts.byteOffset;
    this.reason = opts.reason;
  }
}

/**
 * Iteration handle returned by `parseJsonStream`. Hosts both the async
 * iterator and a `getResult()` accessor that becomes non-undefined the
 * moment the result-event is yielded.
 */
export interface JsonStreamParse extends AsyncIterable<JsonStreamEvent> {
  /**
   * The latched result event, or `undefined` if the stream has not
   * yet emitted one. Stable across iterator advancement after latch.
   */
  getResult(): JsonStreamEvent | undefined;

  /**
   * Total bytes received from the input stream so far (pre-parse).
   * For accounting / tests; not part of any cache key.
   */
  bytesRead(): number;

  /** True once the cap has been hit and the marker line written. */
  teeTruncated(): boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Parser
// ───────────────────────────────────────────────────────────────────────

/**
 * Parse an NDJSON byte/string stream into `JsonStreamEvent` objects.
 *
 * Returns a `JsonStreamParse` — both an async iterable (for-await
 * yields events) and a handle exposing `getResult()`. Iteration must
 * be driven to completion (or the iterator's `return()` called) to
 * release the upstream Readable.
 */
export function parseJsonStream(
  input: AsyncIterable<Buffer | Uint8Array | string> | Readable,
  opts: ParseJsonStreamOptions = {},
): JsonStreamParse {
  const maxTeeBytes = opts.maxTeeBytes ?? DEFAULT_MAX_TEE_BYTES;
  const isResultEvent =
    opts.isResultEvent ?? ((event: JsonStreamEvent) => event.type === "result");
  const tee = opts.tee;
  const signal = opts.signal;

  let result: JsonStreamEvent | undefined;
  let totalBytesRead = 0;
  let teeBytesWritten = 0;
  let teeTruncated = false;

  // Use Buffer concat semantics on the byte side so multi-byte UTF-8
  // characters that straddle a chunk boundary don't get corrupted by
  // a premature `.toString("utf8")`. We hold pending bytes as a
  // Buffer until we see a `\n`, then decode the line as UTF-8.
  let pending: Buffer = Buffer.alloc(0);
  let lineNumber = 0;
  let lineStartByteOffset = 0;

  const writeTee = (bytes: Buffer): void => {
    if (!tee || teeTruncated) return;
    if (maxTeeBytes <= 0) {
      tee.write(bytes);
      teeBytesWritten += bytes.length;
      return;
    }
    const remaining = maxTeeBytes - teeBytesWritten;
    if (bytes.length <= remaining) {
      tee.write(bytes);
      teeBytesWritten += bytes.length;
      return;
    }
    // Drop path: partial write up to cap (may be 0 if a previous chunk
    // landed exactly on the boundary), then marker line, then latch
    // teeTruncated so all subsequent calls early-return.
    if (remaining > 0) {
      tee.write(bytes.subarray(0, remaining));
      teeBytesWritten += remaining;
    }
    const dropped = bytes.length - Math.max(remaining, 0);
    const marker =
      `{"type":"${TEE_TRUNCATED_MARKER_TYPE}","capBytes":${maxTeeBytes},"droppedBytes":${dropped}}\n`;
    tee.write(marker);
    teeTruncated = true;
  };

  const handleParseError = (
    line: string,
    cause: unknown,
    offsetForLine: number,
  ): never => {
    const truncated =
      line.length > TRUNCATED_REGION_MAX
        ? line.slice(0, TRUNCATED_REGION_MAX)
        : line;
    throw new JsonStreamError(
      `malformed JSON at line ${lineNumber} (offset ${offsetForLine})`,
      {
        truncatedRegion: truncated,
        lineNumber,
        byteOffset: offsetForLine,
        reason: "parse",
        cause,
      },
    );
  };

  async function* iterate(): AsyncGenerator<JsonStreamEvent, void, void> {
    for await (const chunk of input) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("aborted");
      }

      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      writeTee(buf);
      totalBytesRead += buf.length;

      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);

      // Process every complete line in `pending`. We scan for `\n` byte
      // (0x0A) directly to avoid premature UTF-8 decoding on a partial
      // tail.
      let searchFrom = 0;
      while (true) {
        const nlIdx = pending.indexOf(0x0a, searchFrom);
        if (nlIdx === -1) {
          // No more complete lines — drop everything we've already
          // processed and keep the tail.
          if (searchFrom > 0) {
            pending = pending.subarray(searchFrom);
          }
          break;
        }
        let lineEnd = nlIdx;
        // Strip a single trailing `\r` for CRLF line endings.
        if (lineEnd > searchFrom && pending[lineEnd - 1] === 0x0d) {
          lineEnd = lineEnd - 1;
        }
        const lineBytes = pending.subarray(searchFrom, lineEnd);
        const lineStr = lineBytes.toString("utf8");
        const lineByteOffset = lineStartByteOffset;
        // Advance counters for the line PLUS its terminator (1 byte for
        // \n; 2 if CRLF was stripped).
        const terminatorBytes = pending[nlIdx - 1] === 0x0d && nlIdx - 1 >= searchFrom ? 2 : 1;
        lineStartByteOffset += lineBytes.length + terminatorBytes;
        lineNumber += 1;
        searchFrom = nlIdx + 1;

        // Skip whitespace-only / empty lines.
        if (lineStr.trim() === "") continue;

        let event: unknown;
        try {
          event = JSON.parse(lineStr);
        } catch (cause) {
          handleParseError(lineStr, cause, lineByteOffset);
        }
        if (typeof event !== "object" || event === null || Array.isArray(event)) {
          const truncated =
            lineStr.length > TRUNCATED_REGION_MAX
              ? lineStr.slice(0, TRUNCATED_REGION_MAX)
              : lineStr;
          throw new JsonStreamError(
            `non-object JSON value at line ${lineNumber}`,
            {
              truncatedRegion: truncated,
              lineNumber,
              byteOffset: lineByteOffset,
              reason: "non-object",
            },
          );
        }
        const evt = event as JsonStreamEvent;
        if (result === undefined && isResultEvent(evt)) {
          result = evt;
        }
        yield evt;
      }
    }

    // End of stream. If `pending` has bytes left, treat as a trailing
    // partial: try a permissive parse (some upstream writers omit the
    // final newline). If that fails, throw.
    if (pending.length > 0) {
      const tailStr = pending.toString("utf8");
      pending = Buffer.alloc(0);
      lineNumber += 1;
      const tailOffset = lineStartByteOffset;
      lineStartByteOffset += Buffer.byteLength(tailStr, "utf8");
      if (tailStr.trim() === "") return;
      let event: unknown;
      try {
        event = JSON.parse(tailStr);
      } catch (cause) {
        const truncated =
          tailStr.length > TRUNCATED_REGION_MAX
            ? tailStr.slice(0, TRUNCATED_REGION_MAX)
            : tailStr;
        throw new JsonStreamError(
          `malformed JSON in trailing partial line ${lineNumber} (no terminator)`,
          {
            truncatedRegion: truncated,
            lineNumber,
            byteOffset: tailOffset,
            reason: "trailing",
            cause,
          },
        );
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        const truncated =
          tailStr.length > TRUNCATED_REGION_MAX
            ? tailStr.slice(0, TRUNCATED_REGION_MAX)
            : tailStr;
        throw new JsonStreamError(
          `non-object JSON value in trailing partial line ${lineNumber}`,
          {
            truncatedRegion: truncated,
            lineNumber,
            byteOffset: tailOffset,
            reason: "non-object",
          },
        );
      }
      const evt = event as JsonStreamEvent;
      if (result === undefined && isResultEvent(evt)) {
        result = evt;
      }
      yield evt;
    }
  }

  const generator = iterate();
  return {
    [Symbol.asyncIterator]: () => generator,
    getResult: () => result,
    bytesRead: () => totalBytesRead,
    teeTruncated: () => teeTruncated,
  };
}
