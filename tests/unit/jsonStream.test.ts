/**
 * Slice 5 — JSON-stream parser tests.
 *
 * Drives the NDJSON parser against fixture files plus synthetic
 * `Readable.from(...)` cases for chunk-boundary / abort / tee-cap
 * coverage. Every async iteration test runs `for await` to completion
 * (or the iterator's `return()`) so a buggy parser cannot leak
 * pending iterators across tests — see `tests/unit/jsonStream.test.ts`
 * comment in CONTRIBUTING.md / project anti-stall guardrails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseJsonStream,
  JsonStreamError,
  DEFAULT_MAX_TEE_BYTES,
  TRUNCATED_REGION_MAX,
  TEE_TRUNCATED_MARKER_TYPE,
  type JsonStreamEvent,
} from "../../src/util/jsonStream.ts";

const FIX_DIR = resolve(import.meta.dirname, "../fixtures/json-stream");
const fixturePath = (name: string) => resolve(FIX_DIR, name);

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Drain a parser to completion, returning the events it yielded. */
async function drain(
  input: AsyncIterable<Buffer | Uint8Array | string> | Readable,
  opts?: Parameters<typeof parseJsonStream>[1],
): Promise<{
  events: JsonStreamEvent[];
  result: JsonStreamEvent | undefined;
  bytesRead: number;
  teeTruncated: boolean;
}> {
  const parser = parseJsonStream(input, opts);
  const events: JsonStreamEvent[] = [];
  for await (const evt of parser) events.push(evt);
  return {
    events,
    result: parser.getResult(),
    bytesRead: parser.bytesRead(),
    teeTruncated: parser.teeTruncated(),
  };
}

/** In-memory WritableStream that captures all bytes written. */
function memoryTee(): { stream: Writable; buffer: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, buffer: () => Buffer.concat(chunks) };
}

// ────────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────────

test("well-formed.jsonl: yields all events in order, latches result", async () => {
  const stream = createReadStream(fixturePath("well-formed.jsonl"));
  const { events, result } = await drain(stream);
  assert.equal(events.length, 6);
  assert.equal(events[0]?.type, "system_init");
  assert.equal(events[5]?.type, "result");
  assert.ok(result);
  assert.equal(result?.type, "result");
  assert.deepEqual(result?.output, { text: "Done." });
});

test("mixed-event-types.jsonl: every variant survives round-trip", async () => {
  const stream = createReadStream(fixturePath("mixed-event-types.jsonl"));
  const { events, result } = await drain(stream);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "system_init",
    "thinking",
    "assistant_message",
    "tool_call",
    "tool_result",
    "tool_call",
    "tool_result",
    "assistant_message",
    "result",
  ]);
  assert.equal(result?.success, true);
  // Tool-call arguments preserved structurally.
  assert.deepEqual(events[3]?.arguments, { path: "a.ts" });
});

test("embedded-newlines.jsonl: literal \\n inside JSON-encoded strings", async () => {
  const stream = createReadStream(fixturePath("embedded-newlines.jsonl"));
  const { events, result } = await drain(stream);
  assert.equal(events.length, 3);
  assert.equal(
    events[1]?.content,
    'Line 1\nLine 2\nLine 3 with quote "x" and tab\there',
  );
  assert.ok(result);
});

test("crlf.jsonl: CRLF line endings parse cleanly", async () => {
  const stream = createReadStream(fixturePath("crlf.jsonl"));
  const { events, result } = await drain(stream);
  assert.equal(events.length, 3);
  assert.equal(events[1]?.content, "windows-style");
  assert.ok(result);
});

test("schema-mismatch.jsonl: unknown types pass through, no result latch", async () => {
  const stream = createReadStream(fixturePath("schema-mismatch.jsonl"));
  const { events, result } = await drain(stream);
  assert.equal(events.length, 3);
  assert.equal(events[2]?.type, "unknown_event_type");
  assert.equal(result, undefined);
});

test("empty.jsonl: zero events, no result, no error", async () => {
  const stream = createReadStream(fixturePath("empty.jsonl"));
  const start = performance.now();
  const { events, result, bytesRead } = await drain(stream);
  const elapsed = performance.now() - start;
  assert.equal(events.length, 0);
  assert.equal(result, undefined);
  assert.equal(bytesRead, 0);
  // Stream-end determinism: must complete promptly.
  assert.ok(elapsed < 100, `empty stream took ${elapsed}ms (expected <100ms)`);
});

test("Readable.from(\"\"): yields zero events, settles within 100ms", async () => {
  const start = performance.now();
  const { events, result } = await drain(Readable.from(""));
  const elapsed = performance.now() - start;
  assert.deepEqual(events, []);
  assert.equal(result, undefined);
  assert.ok(elapsed < 100, `empty stream took ${elapsed}ms`);
});

// ────────────────────────────────────────────────────────────────────
// Malformed paths
// ────────────────────────────────────────────────────────────────────

test("malformed-mid.jsonl: throws JsonStreamError with truncated region", async () => {
  const stream = createReadStream(fixturePath("malformed-mid.jsonl"));
  await assert.rejects(
    drain(stream),
    (err: unknown) => {
      assert.ok(err instanceof JsonStreamError, "expected JsonStreamError");
      const e = err as JsonStreamError;
      assert.equal(e.reason, "parse");
      // Line 3 is the malformed one (1-indexed; lines 1 and 2 parsed OK).
      assert.equal(e.lineNumber, 3);
      assert.ok(e.truncatedRegion.includes("not-valid-json"));
      assert.ok(e.byteOffset > 0);
      assert.ok(e.cause instanceof SyntaxError);
      return true;
    },
  );
});

test("truncated-tail.jsonl: throws with reason='trailing'", async () => {
  const stream = createReadStream(fixturePath("truncated-tail.jsonl"));
  await assert.rejects(
    drain(stream),
    (err: unknown) => {
      assert.ok(err instanceof JsonStreamError);
      const e = err as JsonStreamError;
      assert.equal(e.reason, "trailing");
      assert.ok(e.truncatedRegion.includes('"argum'));
      return true;
    },
  );
});

test("trailing line without newline that DOES parse is yielded", async () => {
  const src = '{"type":"a"}\n{"type":"b"}';
  const { events } = await drain(Readable.from(src));
  assert.deepEqual(
    events.map((e) => e.type),
    ["a", "b"],
  );
});

test("non-object JSON value throws with reason='non-object'", async () => {
  const src = '{"type":"a"}\n42\n';
  await assert.rejects(
    drain(Readable.from(src)),
    (err: unknown) => {
      assert.ok(err instanceof JsonStreamError);
      assert.equal((err as JsonStreamError).reason, "non-object");
      assert.equal((err as JsonStreamError).lineNumber, 2);
      return true;
    },
  );
});

test("array-valued line throws with reason='non-object'", async () => {
  const src = '{"type":"a"}\n[1,2,3]\n';
  await assert.rejects(
    drain(Readable.from(src)),
    (err: unknown) =>
      err instanceof JsonStreamError &&
      (err as JsonStreamError).reason === "non-object",
  );
});

test("truncated-region capped at 256 bytes", async () => {
  const big = "x".repeat(1000);
  const src = `{"type":"a"}\nNOT-JSON-${big}\n`;
  await assert.rejects(
    drain(Readable.from(src)),
    (err: unknown) => {
      const e = err as JsonStreamError;
      assert.equal(e.truncatedRegion.length, TRUNCATED_REGION_MAX);
      return true;
    },
  );
});

test("empty + whitespace-only lines are skipped", async () => {
  const src = '\n\n  \n{"type":"a"}\n   \n{"type":"b"}\n';
  const { events } = await drain(Readable.from(src));
  assert.deepEqual(
    events.map((e) => e.type),
    ["a", "b"],
  );
});

// ────────────────────────────────────────────────────────────────────
// Chunk-boundary correctness
// ────────────────────────────────────────────────────────────────────

test("split mid-line: parser reassembles across chunk boundaries", async () => {
  const fullLine = '{"type":"assistant_message","content":"hello"}';
  // Hand-yield each character as its own chunk.
  async function* charStream() {
    for (const c of fullLine + "\n") yield Buffer.from(c, "utf8");
  }
  const { events } = await drain(charStream());
  assert.equal(events.length, 1);
  assert.equal(events[0]?.content, "hello");
});

test("multi-byte UTF-8 char straddling chunk boundary survives", async () => {
  // U+1F600 ('😀') is 4 bytes in UTF-8: 0xF0 0x9F 0x98 0x80
  const event = { type: "msg", content: "smile: 😀" };
  const json = JSON.stringify(event) + "\n";
  const bytes = Buffer.from(json, "utf8");
  // Find a position that splits the emoji's UTF-8 bytes.
  const emojiStart = bytes.indexOf(0xf0);
  assert.ok(emojiStart > 0, "fixture: emoji byte 0xF0 found");
  const splitAt = emojiStart + 2; // mid-codepoint
  async function* boundaryStream() {
    yield bytes.subarray(0, splitAt);
    yield bytes.subarray(splitAt);
  }
  const { events } = await drain(boundaryStream());
  assert.equal(events.length, 1);
  assert.equal(events[0]?.content, "smile: 😀");
});

test("string-typed chunks accepted alongside Buffer chunks", async () => {
  async function* mixed() {
    yield '{"type":"a"}\n{"type":';
    yield Buffer.from('"b"}\n', "utf8");
  }
  const { events } = await drain(mixed());
  assert.deepEqual(
    events.map((e) => e.type),
    ["a", "b"],
  );
});

// ────────────────────────────────────────────────────────────────────
// Tee + cap
// ────────────────────────────────────────────────────────────────────

test("tee receives every byte of the input stream", async () => {
  const src = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';
  const { stream, buffer } = memoryTee();
  await drain(Readable.from(src), { tee: stream });
  assert.equal(buffer().toString("utf8"), src);
});

test("tee cap: large stream truncates at cap and emits marker", async () => {
  // Build a stream where each line is ~1KiB and there are 17000 lines.
  // Chunk it in 256KiB pieces so the cap is hit mid-chunk.
  const filler = "x".repeat(1500);
  const lines: string[] = [];
  for (let i = 0; i < 12000; i++) {
    lines.push(`{"type":"chunk","i":${i},"f":"${filler}"}`);
  }
  // last event is the result
  lines.push('{"type":"result","output":{},"success":true}');
  const fullSrc = lines.join("\n") + "\n";
  const fullBytes = Buffer.from(fullSrc, "utf8");
  assert.ok(
    fullBytes.length > DEFAULT_MAX_TEE_BYTES,
    `fixture must exceed cap: ${fullBytes.length}`,
  );

  async function* chunked() {
    const CHUNK = 256 * 1024;
    for (let off = 0; off < fullBytes.length; off += CHUNK) {
      yield fullBytes.subarray(off, Math.min(off + CHUNK, fullBytes.length));
    }
  }

  const { stream: tee, buffer } = memoryTee();
  const { events, result, bytesRead, teeTruncated } = await drain(chunked(), {
    tee,
  });

  // Parser must keep parsing past the cap — events count and result still latch.
  assert.equal(events.length, 12001);
  assert.ok(result);
  assert.equal(result?.type, "result");
  assert.equal(bytesRead, fullBytes.length);
  assert.equal(teeTruncated, true);

  const teed = buffer();
  // Tee must have written ≤ cap of raw bytes + the marker line.
  const markerNeedle = Buffer.from(`{"type":"${TEE_TRUNCATED_MARKER_TYPE}"`);
  const markerIdx = teed.indexOf(markerNeedle);
  assert.ok(markerIdx >= 0, "marker line missing from tee");
  // Bytes BEFORE the marker must equal the cap.
  assert.equal(
    markerIdx,
    DEFAULT_MAX_TEE_BYTES,
    `pre-marker bytes ${markerIdx} != cap ${DEFAULT_MAX_TEE_BYTES}`,
  );
  // Marker line must be a complete NDJSON line (newline-terminated).
  assert.equal(teed[teed.length - 1], 0x0a);
});

test("tee cap = 0 disables cap, marker never written", async () => {
  const src = "x".repeat(100_000);
  const event = `{"type":"big","content":"${src}"}\n`;
  const { stream, buffer } = memoryTee();
  const { teeTruncated } = await drain(Readable.from(event), {
    tee: stream,
    maxTeeBytes: 0,
  });
  assert.equal(teeTruncated, false);
  assert.equal(buffer().length, event.length);
});

test("REGRESSION: previous chunk lands exactly on cap, next chunk triggers marker", async () => {
  // First chunk: two valid NDJSON lines totalling exactly `cap` bytes.
  // Second chunk: another valid line. The second chunk should be 100%
  // dropped (remaining=0) and trigger the marker. Witnesses the
  // early-return-on-remaining=0 bug fixed in this slice.
  const cap = 1024;
  // Build line of exactly 512 bytes including trailing \n.
  const fixedOverhead = '{"type":"a","f":""}\n'.length; // 20
  const filler = "a".repeat(512 - fixedOverhead);
  const lineA = `{"type":"a","f":"${filler}"}\n`;
  const lineB = `{"type":"b","f":"${filler}"}\n`;
  assert.equal(Buffer.byteLength(lineA + lineB, "utf8"), cap);

  async function* twoChunks() {
    yield Buffer.from(lineA + lineB, "utf8");
    yield Buffer.from('{"type":"c"}\n', "utf8");
  }
  const { stream, buffer } = memoryTee();
  const { teeTruncated, events } = await drain(twoChunks(), {
    tee: stream,
    maxTeeBytes: cap,
  });
  assert.equal(teeTruncated, true);
  assert.equal(events.length, 3); // parser keeps parsing past the cap
  const teed = buffer();
  const markerNeedle = Buffer.from(`{"type":"${TEE_TRUNCATED_MARKER_TYPE}"`);
  const markerIdx = teed.indexOf(markerNeedle);
  assert.ok(markerIdx > 0);
  // Pre-marker bytes equal the cap (the first chunk's full payload).
  assert.equal(markerIdx, cap);
});

test("tee cap exactly at chunk boundary: no marker if equal", async () => {
  // Edge case: input is exactly cap bytes — no truncation, no marker.
  const cap = 1024;
  // Total line: '{"type":"x","f":"' + filler + '"}\n' = 17 + filler + 3 chars
  // = filler + 20 bytes. For cap=1024: filler = 1004.
  const fixedOverhead = '{"type":"x","f":""}\n'.length; // 20
  const filler = "a".repeat(cap - fixedOverhead);
  const event = `{"type":"x","f":"${filler}"}\n`;
  // Adjust so total bytes == cap.
  assert.equal(Buffer.byteLength(event, "utf8"), cap);
  const { stream, buffer } = memoryTee();
  const { teeTruncated } = await drain(Readable.from(event), {
    tee: stream,
    maxTeeBytes: cap,
  });
  assert.equal(teeTruncated, false);
  assert.equal(buffer().length, cap);
});

// ────────────────────────────────────────────────────────────────────
// Result latching
// ────────────────────────────────────────────────────────────────────

test("custom isResultEvent predicate latches first match only", async () => {
  const src =
    '{"type":"final","tag":"first"}\n{"type":"final","tag":"second"}\n';
  const { result } = await drain(Readable.from(src), {
    isResultEvent: (e) => e.type === "final",
  });
  assert.equal(result?.tag, "first");
});

test("getResult() is undefined until result event is yielded", async () => {
  const src = '{"type":"a"}\n{"type":"b"}\n{"type":"result","x":1}\n';
  const parser = parseJsonStream(Readable.from(src));
  const seen: Array<JsonStreamEvent | undefined> = [];
  for await (const evt of parser) {
    seen.push(parser.getResult());
    void evt;
  }
  // Snapshots taken AFTER each yield: undefined, undefined, latched.
  assert.equal(seen[0], undefined);
  assert.equal(seen[1], undefined);
  assert.ok(seen[2]);
  assert.equal(seen[2]?.type, "result");
});

// ────────────────────────────────────────────────────────────────────
// AbortSignal
// ────────────────────────────────────────────────────────────────────

test("pre-aborted signal: parser throws on first iteration", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("user-cancel"));
  await assert.rejects(
    drain(Readable.from('{"type":"a"}\n'), { signal: ctrl.signal }),
    (err: unknown) => err instanceof Error && err.message === "user-cancel",
  );
});

test("mid-stream abort: stops yielding, throws abort reason", async () => {
  const ctrl = new AbortController();
  async function* slow() {
    yield '{"type":"a"}\n';
    // Give the abort a chance to fire.
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort(new Error("mid-stream-cancel"));
    yield '{"type":"b"}\n';
  }
  const events: JsonStreamEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const evt of parseJsonStream(slow(), { signal: ctrl.signal })) {
        events.push(evt);
      }
    })(),
    (err: unknown) =>
      err instanceof Error && err.message === "mid-stream-cancel",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "a");
});

// ────────────────────────────────────────────────────────────────────
// Mutation probes — confirm the catch / cap / latch are load-bearing
// ────────────────────────────────────────────────────────────────────

test("MUTATION-PROBE: well-formed fixture yields exactly the canonical event count", async () => {
  // If a future refactor accidentally double-yields or skips, this trips.
  const stream = createReadStream(fixturePath("well-formed.jsonl"));
  const { events } = await drain(stream);
  // This count is the source of truth — derived from the fixture file.
  const lines = readFileSync(fixturePath("well-formed.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  assert.equal(events.length, lines.length);
});

test("MUTATION-PROBE: result-latch fires on FIRST result event, never overwritten", async () => {
  const src =
    '{"type":"result","tag":1}\n{"type":"result","tag":2}\n{"type":"result","tag":3}\n';
  const { result } = await drain(Readable.from(src));
  assert.equal(result?.tag, 1);
});
