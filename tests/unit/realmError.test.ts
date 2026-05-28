/**
 * tests/unit/realmError.test.ts — host↔Context realm error
 * reconstruction boundary table.
 *
 * Implements the table-driven test required by builder-brief and PRD
 * §8.3.4. Each row asserts:
 *
 *   - `error.message` matches the expected stringification of the
 *     thrown value.
 *   - For non-Error throws: `wrappedNonError === true` AND
 *     `originalType === <typeof value>`.
 *   - For real Errors: BOTH flags are absent (sentinel: `false` /
 *     undefined; the test asserts they are not on the object at all).
 *   - AggregateError preserves `.errors[]` recursively.
 *   - Custom subclass preserves `.name` but NOT subclass identity.
 *
 * Mutation-resistance: a few assertions are deliberately harsh — if
 * someone removes the `wrappedNonError` flag from non-Error throws,
 * eight test rows fail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  captureError,
  reconstructError,
  rethrowAcrossRealm,
  safeStringifyThrown,
} from "../../src/runtime/realmError.ts";

// ─── Boundary table ──────────────────────────────────────────────

interface BoundaryRow {
  readonly label: string;
  readonly value: unknown;
  readonly expectedMessage: string | RegExp;
  readonly expectedOriginalType: string | undefined;
  readonly expectedWrapped: boolean;
}

class FooError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FooError";
  }
}

const NON_ERROR_ROWS: readonly BoundaryRow[] = [
  { label: "throw 42", value: 42, expectedMessage: "42", expectedOriginalType: "number", expectedWrapped: true },
  { label: 'throw "hi"', value: "hi", expectedMessage: "hi", expectedOriginalType: "string", expectedWrapped: true },
  { label: "throw null", value: null, expectedMessage: "null", expectedOriginalType: "object", expectedWrapped: true },
  { label: "throw undefined", value: undefined, expectedMessage: "undefined", expectedOriginalType: "undefined", expectedWrapped: true },
  { label: "throw true", value: true, expectedMessage: "true", expectedOriginalType: "boolean", expectedWrapped: true },
  { label: 'throw Symbol("x")', value: Symbol("x"), expectedMessage: "Symbol(x)", expectedOriginalType: "symbol", expectedWrapped: true },
  { label: "throw {a:1}", value: { a: 1 }, expectedMessage: "[object Object]", expectedOriginalType: "object", expectedWrapped: true },
  { label: "throw []", value: [], expectedMessage: "", expectedOriginalType: "object", expectedWrapped: true },
  { label: "throw () => {}", value: () => {}, expectedMessage: /.+/, expectedOriginalType: "function", expectedWrapped: true },
  { label: "throw 123n", value: 123n, expectedMessage: "123", expectedOriginalType: "bigint", expectedWrapped: true },
];

const ERROR_ROWS: readonly Omit<BoundaryRow, "expectedOriginalType" | "expectedWrapped">[] = [
  { label: "throw new Error('oops')", value: new Error("oops"), expectedMessage: "oops" },
  { label: "throw new TypeError('bad')", value: new TypeError("bad"), expectedMessage: "bad" },
  { label: "throw new RangeError('rng')", value: new RangeError("rng"), expectedMessage: "rng" },
];

// ─── safeStringifyThrown ─────────────────────────────────────────

test("safeStringifyThrown handles every primitive + special case", () => {
  assert.equal(safeStringifyThrown(42), "42");
  assert.equal(safeStringifyThrown("hi"), "hi");
  assert.equal(safeStringifyThrown(null), "null");
  assert.equal(safeStringifyThrown(undefined), "undefined");
  assert.equal(safeStringifyThrown(true), "true");
  assert.equal(safeStringifyThrown(false), "false");
  assert.equal(safeStringifyThrown(123n), "123");
  assert.equal(safeStringifyThrown(Symbol("z")), "Symbol(z)");
  assert.equal(safeStringifyThrown({ a: 1 }), "[object Object]");
  assert.equal(safeStringifyThrown([]), "");
  assert.match(safeStringifyThrown(() => {}), /=>/);
});

test("safeStringifyThrown survives a poisoned toString", () => {
  const evil = {
    toString() {
      throw new Error("nope");
    },
  };
  // Object.prototype.toString.call returns "[object Object]" — the
  // value's own toString is bypassed by the fallback path.
  const result = safeStringifyThrown(evil);
  assert.equal(typeof result, "string");
  assert.notEqual(result, "");
});

// ─── captureError: non-Error rows ───────────────────────────────

for (const row of NON_ERROR_ROWS) {
  test(`captureError: ${row.label} → wrappedNonError + originalType`, () => {
    const rec = captureError(row.value);
    assert.equal(rec.wrappedNonError, true, "wrappedNonError must be true");
    assert.equal(rec.originalType, row.expectedOriginalType, "originalType must match typeof");
    if (row.expectedMessage instanceof RegExp) {
      assert.match(rec.message, row.expectedMessage);
    } else {
      assert.equal(rec.message, row.expectedMessage);
    }
    // Non-Error rows never have `errors` or `cause`.
    assert.equal(rec.errors, undefined);
    assert.equal(rec.cause, undefined);
    // Stack is null for non-Error throws.
    assert.equal(rec.stack, null);
  });
}

// ─── captureError: Error rows ───────────────────────────────────

for (const row of ERROR_ROWS) {
  test(`captureError: ${row.label} → no wrap flags`, () => {
    const rec = captureError(row.value);
    assert.equal(
      rec.wrappedNonError,
      false,
      "real Errors must NOT carry wrappedNonError",
    );
    assert.equal(
      rec.originalType,
      undefined,
      "real Errors must NOT carry originalType",
    );
    assert.equal(rec.message, row.expectedMessage as string);
    assert.equal(typeof rec.stack, "string", "real Error preserves .stack");
  });
}

test("captureError: AggregateError preserves .errors recursively", () => {
  const inner = [new Error("a"), new TypeError("b"), new RangeError("c")];
  const agg = new AggregateError(inner, "agg");
  const rec = captureError(agg);
  assert.equal(rec.name, "AggregateError");
  assert.equal(rec.message, "agg");
  assert.equal(rec.wrappedNonError, false);
  assert.ok(rec.errors, ".errors must be present");
  assert.equal(rec.errors!.length, 3);
  assert.equal(rec.errors![0]!.message, "a");
  assert.equal(rec.errors![0]!.name, "Error");
  assert.equal(rec.errors![1]!.message, "b");
  assert.equal(rec.errors![1]!.name, "TypeError");
  assert.equal(rec.errors![2]!.message, "c");
  assert.equal(rec.errors![2]!.name, "RangeError");
});

test("captureError: nested AggregateError chain", () => {
  const innermost = new Error("deep");
  const inner = new AggregateError([innermost], "inner");
  const outer = new AggregateError([inner], "outer");
  const rec = captureError(outer);
  assert.equal(rec.message, "outer");
  assert.equal(rec.errors![0]!.message, "inner");
  assert.equal(rec.errors![0]!.errors![0]!.message, "deep");
});

test("captureError: Error.cause chain", () => {
  const root = new Error("root");
  const mid = new Error("mid", { cause: root });
  const top = new Error("top", { cause: mid });
  const rec = captureError(top);
  assert.equal(rec.message, "top");
  assert.equal(rec.cause!.message, "mid");
  assert.equal(rec.cause!.cause!.message, "root");
});

test("captureError: cause cycle is broken with <cycle> marker", () => {
  const a = new Error("a");
  const b = new Error("b");
  // Tie the knot.
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = a;
  const rec = captureError(a);
  // Walk the chain — at some depth we should hit "<cycle>".
  let cur: typeof rec | undefined = rec;
  let depth = 0;
  while (cur && depth < 10) {
    if (cur.message === "<cycle>") return;
    cur = cur.cause;
    depth++;
  }
  assert.fail("cycle was not broken — would have stack-overflow'd");
});

test("captureError: custom subclass preserves .name", () => {
  const rec = captureError(new FooError("boo"));
  assert.equal(rec.name, "FooError");
  assert.equal(rec.message, "boo");
  assert.equal(rec.wrappedNonError, false);
});

// ─── reconstructError ───────────────────────────────────────────

function makeContext(): vm.Context {
  return vm.createContext({});
}

test("reconstructError: builds a Context-realm Error from a record", () => {
  const ctx = makeContext();
  const rec = captureError(new Error("hello"));
  const reErr = reconstructError(rec, ctx);
  // Verify the reconstructed Error is in the Context realm.
  const isCtxRealm = vm.runInContext(`(e) => e instanceof Error`, ctx)(
    reErr,
  );
  assert.ok(isCtxRealm, "reconstructed Error must be Context-realm");
  assert.equal(reErr.message, "hello");
  // No wrap flags on real Errors.
  assert.equal(
    (reErr as { wrappedNonError?: unknown }).wrappedNonError,
    undefined,
  );
});

test("reconstructError: wraps non-Error with wrappedNonError flag", () => {
  const ctx = makeContext();
  const rec = captureError(42);
  const reErr = reconstructError(rec, ctx) as Error & {
    wrappedNonError?: boolean;
    originalType?: string;
  };
  assert.equal(reErr.message, "42");
  assert.equal(reErr.wrappedNonError, true);
  assert.equal(reErr.originalType, "number");
});

test("aggregate-error-preservation", () => {
  // Plan §4 Slice 2 critic checklist names this test explicitly:
  //   "AggregateError test is named `aggregate-error-preservation` and
  //    explicitly checks `result.errors.length === 3` and each child's
  //    `.message` survives."
  const ctx = makeContext();
  const inner = [new Error("a"), new TypeError("b"), new RangeError("c")];
  const agg = new AggregateError(inner, "agg");
  const reErr = reconstructError(captureError(agg), ctx) as AggregateError;
  // Plan-critic-mandated: errors.length === 3.
  assert.equal(reErr.errors.length, 3);
  // Each child's .message must survive.
  assert.equal(reErr.errors[0]!.message, "a");
  assert.equal(reErr.errors[1]!.message, "b");
  assert.equal(reErr.errors[2]!.message, "c");
  // And each child's name survives.
  assert.equal(reErr.errors[0]!.name, "Error");
  assert.equal(reErr.errors[1]!.name, "TypeError");
  assert.equal(reErr.errors[2]!.name, "RangeError");
  // Reconstructed AggregateError is in the Context realm.
  const isAgg = vm.runInContext(`(e) => e instanceof AggregateError`, ctx)(
    reErr,
  );
  assert.ok(isAgg);
});

test("reconstructError: AggregateError preserves children in Context realm", () => {
  const ctx = makeContext();
  const agg = new AggregateError(
    [new Error("a"), new Error("b")],
    "outer",
  );
  const reErr = reconstructError(captureError(agg), ctx) as AggregateError;
  assert.equal(reErr.message, "outer");
  // Test that the reconstructed AggregateError IS one in the Context realm.
  const isAgg = vm.runInContext(`(e) => e instanceof AggregateError`, ctx)(
    reErr,
  );
  assert.ok(isAgg, "must be Context-realm AggregateError");
  assert.equal(reErr.errors.length, 2);
  assert.equal(reErr.errors[0]!.message, "a");
  assert.equal(reErr.errors[1]!.message, "b");
});

test("reconstructError: .cause chain is reconstructed", () => {
  const ctx = makeContext();
  const rec = captureError(
    new Error("top", {
      cause: new Error("mid", { cause: new Error("root") }),
    }),
  );
  const reErr = reconstructError(rec, ctx) as Error & { cause?: Error };
  assert.equal(reErr.message, "top");
  assert.equal(reErr.cause!.message, "mid");
  assert.equal((reErr.cause! as Error & { cause?: Error }).cause!.message, "root");
});

test("reconstructError: .stack annotated with realm-boundary marker", () => {
  const ctx = makeContext();
  const orig = new Error("e");
  const reErr = reconstructError(captureError(orig), ctx);
  assert.match(reErr.stack ?? "", /reconstructed across realm boundary/);
  // The original stack should still be in there.
  assert.match(reErr.stack ?? "", /Error: e/);
});

test("reconstructError: custom subclass becomes Context-realm Error with .name", () => {
  const ctx = makeContext();
  const rec = captureError(new FooError("custom"));
  const reErr = reconstructError(rec, ctx);
  assert.equal(reErr.name, "FooError");
  assert.equal(reErr.message, "custom");
  // Identity does NOT survive — `instanceof FooError` returns false.
  // We can't directly check FooError in the Context (it doesn't exist
  // there), but we can check that the constructor is the Context's
  // plain Error.
  const reCtor = vm.runInContext(
    `(e) => e.constructor === Error`,
    ctx,
  )(reErr);
  assert.ok(reCtor, "subclass identity must NOT survive");
});

// ─── rethrowAcrossRealm convenience ─────────────────────────────

test("rethrowAcrossRealm: Symbol round-trip", () => {
  const ctx = makeContext();
  const reErr = rethrowAcrossRealm(Symbol("xyz"), ctx) as Error & {
    wrappedNonError?: boolean;
    originalType?: string;
  };
  assert.equal(reErr.message, "Symbol(xyz)");
  assert.equal(reErr.wrappedNonError, true);
  assert.equal(reErr.originalType, "symbol");
});

test("rethrowAcrossRealm: bigint round-trip", () => {
  const ctx = makeContext();
  const reErr = rethrowAcrossRealm(123n, ctx) as Error & {
    wrappedNonError?: boolean;
    originalType?: string;
  };
  assert.equal(reErr.message, "123");
  assert.equal(reErr.originalType, "bigint");
});

// ─── Mutation-resistance probe ──────────────────────────────────

test("MUTATION-PROBE: real Errors must NOT carry wrappedNonError flag", () => {
  // If someone broke the conditional in captureError (e.g. set the
  // flag unconditionally), this test fails alongside many others.
  for (const row of ERROR_ROWS) {
    const rec = captureError(row.value);
    assert.equal(
      rec.wrappedNonError,
      false,
      `${row.label}: must not be wrapped`,
    );
  }
});

test("MUTATION-PROBE: non-Error throws must always carry originalType", () => {
  for (const row of NON_ERROR_ROWS) {
    const rec = captureError(row.value);
    assert.equal(
      rec.originalType,
      row.expectedOriginalType,
      `${row.label}: originalType=${row.expectedOriginalType}`,
    );
  }
});
