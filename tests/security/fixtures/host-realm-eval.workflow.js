/**
 * host-realm-eval.workflow.js — defends against PRD §8.3.4 host-realm
 * constructor-walk eval.
 *
 * The exploit: a curated global installed by reference into the
 * Context (e.g. `Buffer`, `crypto`, `URL`, `TextEncoder`, the
 * `__pi_console_log__` host bridge) is a host-realm value. Its
 * `.constructor.constructor` walk lands on host's `Function`, which
 * evaluates inside the host realm and returns host's `process` —
 * full env, fs binding, exit, etc.
 *
 * Defense: each curated global is a Context-realm wrapper whose
 * `.constructor` resolves to the Context's `Function`. Eval still
 * "works" but stays inside the Context realm and gets the Context's
 * frozen process stub.
 *
 * The wrapper-identity rows are the oracle: if `Buffer.from.constructor
 * === Function` (Context Function), the wrap is correct.
 *
 * The console-bridge-hidden rows assert `__pi_console_log__` was
 * captured-and-deleted via the same closure pattern as the timer
 * bridge nonce.
 */
const tests = {};

function probe(label, getter) {
  try {
    const ctor = getter();
    const fn = ctor("return process");
    const proc = fn();
    tests[label] = {
      escaped: true,
      envKeys: proc && proc.env ? Object.keys(proc.env).length : -1,
      hasExit: typeof (proc && proc.exit) === "function",
      hasBinding: typeof (proc && proc.binding) === "function",
    };
  } catch (e) {
    tests[label] = { escaped: false, threw: e.name + ": " + e.message };
  }
}

probe("buffer-from", () => Buffer.from.constructor);
probe("buffer-static", () => Buffer.constructor);
probe("crypto-method", () => crypto.randomUUID.constructor);
probe("url-static", () => URL.constructor);
probe("textenc-instance", () => new TextEncoder().encode.constructor.constructor);

// Wrapper-identity invariant — these must equal the Context's Function.
tests["wrapper-identity"] = {
  bufferFromCtorIsContextFn: Buffer.from.constructor === Function,
  cryptoUUIDCtorIsContextFn: crypto.randomUUID.constructor === Function,
};

// Bridge-hidden invariant — `__pi_console_log__` must NOT be visible.
tests["console-bridge-hidden"] = {
  visibleAsKey: Reflect.ownKeys(globalThis).includes("__pi_console_log__"),
  enumerable: Object.keys(globalThis).includes("__pi_console_log__"),
  fromGetOwnPropDescriptor:
    Object.getOwnPropertyDescriptor(globalThis, "__pi_console_log__") !==
    undefined,
};

return tests;
