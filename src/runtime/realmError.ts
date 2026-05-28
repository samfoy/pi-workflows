/**
 * pi-workflows — host↔Context realm error reconstruction.
 *
 * Implements PRD §8.3.4. Two halves:
 *
 *   - `captureError(value)` — host-side capture of any thrown value
 *     (Error or non-Error) into a serializable `RealmErrorRecord`.
 *   - `reconstructError(record, context)` — builds a fresh
 *     Context-realm `Error` (or `AggregateError`) from a record so the
 *     sandboxed script's `catch` clause sees a same-realm Error.
 *
 * The two are split so slice 7 can persist the record to the ledger
 * unchanged while slice 8a does the realm-side reconstruction inline.
 * Slice 2 only needs the round-trip to verify the contract.
 *
 * **Boundary table** (PRD §8.3.4 + builder brief, replicated as a unit
 * test in `tests/unit/realmError.test.ts`):
 *
 *   throw 42                    → message "42",   wrappedNonError=true,  originalType="number"
 *   throw "hi"                  → "hi",            true,                  "string"
 *   throw null                  → "null",          true,                  "object"   ← typeof null
 *   throw undefined             → "undefined",     true,                  "undefined"
 *   throw true                  → "true",          true,                  "boolean"
 *   throw Symbol("x")           → "Symbol(x)",     true,                  "symbol"
 *   throw {a:1}                 → "[object Object]", true,                "object"
 *   throw []                    → "",              true,                  "object"
 *   throw () => {}              → impl-defined,    true,                  "function"
 *   throw 123n                  → "123",           true,                  "bigint"
 *   throw new Error("oops")     → "oops",          (absent),              (absent)
 *   throw new TypeError("bad")  → "bad",           (absent),              (absent)
 *   throw new AggregateError([new Error("a")], "agg") → "agg" + .errors[0].message="a"
 *   throw new (class Foo extends Error{}) → name="Foo", absent, absent
 *
 * Reconstruction caveats:
 *   - Custom subclass identity does NOT survive (PRD §8.3.4 row 6) —
 *     reconstructed as Context-realm `Error` with `.name` preserved.
 *   - `.stack` is annotated with " (reconstructed across realm
 *     boundary)" so debuggers/log readers know the trace is original
 *     but the value is fresh.
 *   - `.cause` is recursively reconstructed.
 *   - AggregateError `.errors` is recursively reconstructed.
 *
 * Symbol stringification: `String(value)` on a Symbol throws under
 * implicit conversion ("Cannot convert a Symbol value to a string"),
 * so we explicitly call `Symbol.prototype.toString.call(value)`. Same
 * for bigint where `String(123n)` is fine but a defensive try/catch
 * wraps the whole thing for hostile cases (objects with a poisoned
 * `toString`).
 */

import vm from "node:vm";

import type {
  RealmErrorRecord,
  SandboxViolationError,
} from "../types/internal.js";

const RECON_STACK_TAG = " (reconstructed across realm boundary)";

/**
 * Best-effort string-ification that never throws.
 *
 * - `Symbol(x)` → `"Symbol(x)"` via `Symbol.prototype.toString`.
 * - `123n` → `"123"` via `String`.
 * - `[]` → `""` via `Array#toString` (the spec-defined behaviour).
 * - `{a:1}` → `"[object Object]"` via `Object#toString`.
 * - `null` → `"null"`. Note the table maps `originalType` to `"object"`
 *   (because `typeof null === "object"`) but the message is "null".
 * - `undefined` → `"undefined"`.
 * - Anything else: tries `String(v)`; if that throws (e.g. custom
 *   `Symbol.toPrimitive` that throws), falls back to the constructor
 *   name or `"<unprintable>"`.
 */
export function safeStringifyThrown(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "symbol") {
    try {
      return Symbol.prototype.toString.call(value);
    } catch {
      return "Symbol(<unprintable>)";
    }
  }
  try {
    // Explicit `String()` is total for everything except Symbols (handled
    // above). Even `{}` with a poisoned `toString` will call our explicit
    // fallback below.
    return String(value);
  } catch {
    try {
      // Last-ditch — try `Object.prototype.toString` directly to avoid
      // the value's own `toString` method.
      return Object.prototype.toString.call(value);
    } catch {
      return "<unprintable>";
    }
  }
}

/**
 * Normalised type tag for `RealmErrorRecord.originalType`. Mirrors the
 * boundary table; `null` is the only special case (typeof null is
 * "object" but we want "null" semantically — actually the table SAYS
 * "object" for null, matching `typeof`, so we just return `typeof`).
 */
function originalType(value: unknown): string {
  // `typeof null === "object"` is the JS spec — and the boundary table
  // explicitly preserves that. Don't special-case here.
  return typeof value;
}

/**
 * Capture any thrown value as a serialisable `RealmErrorRecord`.
 *
 * - Real `Error` instances → `wrappedNonError: false`, full preservation.
 * - Anything else → wrapped per the boundary table.
 *
 * Recurses into `.cause` and `AggregateError.errors`. Cycle-protection:
 * we maintain a `seen` WeakSet to break loops; cycle hits become a
 * record with `message: "<cycle>"` to prevent stack overflow on
 * pathological cause chains.
 */
export function captureError(value: unknown): RealmErrorRecord {
  return captureErrorInner(value, new WeakSet());
}

function captureErrorInner(
  value: unknown,
  seen: WeakSet<object>,
): RealmErrorRecord {
  if (isErrorLike(value)) {
    const err = value as Error & {
      cause?: unknown;
      errors?: unknown[];
    };
    if (seen.has(err)) {
      return {
        name: err.name ?? "Error",
        message: "<cycle>",
        stack: null,
        wrappedNonError: false,
      };
    }
    seen.add(err);

    const record: {
      name: string;
      message: string;
      stack: string | null;
      wrappedNonError: false;
      errors?: RealmErrorRecord[];
      cause?: RealmErrorRecord;
    } = {
      name: typeof err.name === "string" ? err.name : "Error",
      message: typeof err.message === "string" ? err.message : "",
      stack: typeof err.stack === "string" ? err.stack : null,
      wrappedNonError: false,
    };

    // AggregateError.errors — recursively capture.
    if (Array.isArray((err as { errors?: unknown }).errors)) {
      record.errors = (err.errors as unknown[]).map((child) =>
        captureErrorInner(child, seen),
      );
    }

    // .cause — recursively capture.
    if ("cause" in err && err.cause !== undefined) {
      record.cause = captureErrorInner(err.cause, seen);
    }

    return record;
  }

  // Non-Error throw. Build a wrapped record.
  return {
    name: "Error",
    message: safeStringifyThrown(value),
    stack: null,
    wrappedNonError: true,
    originalType: originalType(value),
  };
}

/**
 * `instanceof Error` would only match host-realm Errors. We need to
 * also accept Errors from another realm — in particular, errors that
 * came from inside the Context. Heuristic: it's a non-null object with
 * a string `message` property and a constructor whose name ends in
 * `"Error"`. Tightened by also accepting anything for which
 * `Object.prototype.toString.call(v) === "[object Error]"` (the brand
 * is realm-agnostic).
 */
function isErrorLike(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  // Realm-agnostic brand check first — fastest path.
  if (Object.prototype.toString.call(v) === "[object Error]") return true;
  // AggregateError isn't always tagged "[object Error]" depending on
  // engine version; check for `errors` array explicitly with a name
  // that ends in "Error".
  const ctorName = (v as { constructor?: { name?: unknown } }).constructor
    ?.name;
  if (
    typeof ctorName === "string" &&
    ctorName.endsWith("Error") &&
    "message" in (v as object)
  ) {
    return true;
  }
  return false;
}

/**
 * Reconstruct a `RealmErrorRecord` as a Context-realm Error. The
 * returned object is owned by the Context — its prototype chain runs
 * through the Context's `Error.prototype`.
 *
 * For `AggregateError` (`record.errors` present), the result is a
 * Context-realm `AggregateError` with each child reconstructed.
 *
 * Throws `SandboxViolationError("realm-error-reconstruct-failed")` if
 * the Context's intrinsics are missing (e.g. someone deleted
 * `globalThis.Error` from inside the sandbox).
 */
export function reconstructError(
  record: RealmErrorRecord,
  context: vm.Context,
): Error {
  try {
    return reconstructErrorInner(record, context);
  } catch (e) {
    const violation: SandboxViolationError = Object.assign(
      new Error(
        `realm error reconstruction failed: ${(e as Error).message ?? String(e)}`,
      ) as Error & {
        name: "SandboxViolationError";
        violation: "realm-error-reconstruct-failed";
        hostCause?: unknown;
      },
      {
        name: "SandboxViolationError" as const,
        violation: "realm-error-reconstruct-failed" as const,
        hostCause: e,
      },
    );
    throw violation;
  }
}

function reconstructErrorInner(
  record: RealmErrorRecord,
  context: vm.Context,
): Error {
  // Get Context-realm Error / AggregateError constructors. These run
  // EVERY call (cheap — vm.runInContext caches under the hood) so a
  // workflow that re-froze its globals between calls still gets fresh
  // refs.
  const ContextError = vm.runInContext("Error", context) as ErrorConstructor;
  const ContextAggregateError = vm.runInContext(
    "AggregateError",
    context,
  ) as AggregateErrorConstructor;

  let result: Error;
  if (record.errors !== undefined) {
    // AggregateError. The constructor takes (errors, message) — and
    // errors must be iterable.
    const children = record.errors.map((c) =>
      reconstructErrorInner(c, context),
    );
    result = new ContextAggregateError(children, record.message);
    // Override .name so user code doing `e.name === "AggregateError"`
    // sees the right thing even if record.name was something else.
    Object.defineProperty(result, "name", {
      value: record.name,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } else {
    result = new ContextError(record.message);
    if (record.name !== "Error") {
      Object.defineProperty(result, "name", {
        value: record.name,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
  }

  // Annotate stack — preserve original where possible, append the
  // realm-boundary marker so log readers know it's a reconstruction.
  if (record.stack !== null) {
    Object.defineProperty(result, "stack", {
      value: record.stack + "\n" + RECON_STACK_TAG.trimStart(),
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } else {
    // No original stack (non-Error throw). Annotate the auto-generated
    // stack so debuggers see we're a reconstruction.
    const synthetic = (result.stack ?? "") + "\n" + RECON_STACK_TAG.trimStart();
    Object.defineProperty(result, "stack", {
      value: synthetic,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }

  // Audit flags for non-Error throws.
  if (record.wrappedNonError) {
    Object.defineProperty(result, "wrappedNonError", {
      value: true,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    if (record.originalType !== undefined) {
      Object.defineProperty(result, "originalType", {
        value: record.originalType,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    }
  }

  // .cause chain.
  if (record.cause !== undefined) {
    const causeReconstructed = reconstructErrorInner(record.cause, context);
    Object.defineProperty(result, "cause", {
      value: causeReconstructed,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }

  return result;
}

/**
 * Convenience: capture `value` and reconstruct it in `context` in one
 * step. Used by host-side method wrappers (slice 8a) and the timer
 * trampoline error path (slice 2).
 */
export function rethrowAcrossRealm(
  value: unknown,
  context: vm.Context,
): Error {
  return reconstructError(captureError(value), context);
}
