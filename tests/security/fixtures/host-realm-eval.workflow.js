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

// Slice 8a: ctx.* surface. Each method MUST be wrapped via
// wrapHostMethod so .constructor lands on Context Function. Without
// the wrap, `ctx.agent.constructor("return process")()` evaluates in
// the host realm and returns the host's process — the same exploit
// class slice 2 closed for Buffer/crypto/URL/etc.
//
// When this fixture is run from `tests/security/runner.test.ts`
// (no runCtxHost provided), `ctx.*` methods are slice-2 stubs
// (Context-realm functions that throw). Their `.constructor` is
// still Context Function — so the probe's exploit attempt evaluates
// inside the Context and gets the Context's process stub.
probe("ctx-agent",     () => ctx.agent.constructor);
probe("ctx-phase",     () => ctx.phase.constructor);
probe("ctx-cache-get", () => ctx.cache.get.constructor);
probe("ctx-log",       () => ctx.log.constructor);

// Slice 8b: stdlib helpers — same wrapper-identity / host-realm-eval
// invariants as the slice 8a ctx.* surface. The helpers are pure
// Context-realm closures (no host bridge), so .constructor must
// resolve to Context Function.
probe("ctx-vote",      () => ctx.vote.constructor);
probe("ctx-consensus", () => ctx.consensus.constructor);
probe("ctx-parallel",  () => ctx.parallel.constructor);
probe("ctx-retry",     () => ctx.retry.constructor);
probe("ctx-sleep",     () => ctx.sleep.constructor);

// Wrapper-identity invariant — these must equal the Context's Function.
tests["wrapper-identity"] = {
  bufferFromCtorIsContextFn: Buffer.from.constructor === Function,
  cryptoUUIDCtorIsContextFn: crypto.randomUUID.constructor === Function,
};

// Slice 8a: same invariant for ctx.* surface. If wrapHostMethod was
// dropped from any of these, the .constructor would be host-realm
// Function and === would be false.
tests["wrapper-identity-ctx"] = {
  agentCtorIsContextFn:    ctx.agent.constructor === Function,
  phaseCtorIsContextFn:    ctx.phase.constructor === Function,
  cacheGetCtorIsContextFn: ctx.cache.get.constructor === Function,
  cacheSetCtorIsContextFn: ctx.cache.set.constructor === Function,
  cacheHasCtorIsContextFn: ctx.cache.has.constructor === Function,
  cacheDelCtorIsContextFn: ctx.cache.delete.constructor === Function,
  logCtorIsContextFn:      ctx.log.constructor === Function,
};

// Slice 8b: stdlib helpers wrapper-identity oracle. If a future patch
// stops installing __helpers.{vote,...} or routes them through a
// host-realm shim, .constructor would no longer be Context Function
// and === fails.
tests["wrapper-identity-stdlib"] = {
  voteCtorIsContextFn:      ctx.vote.constructor === Function,
  consensusCtorIsContextFn: ctx.consensus.constructor === Function,
  parallelCtorIsContextFn:  ctx.parallel.constructor === Function,
  retryCtorIsContextFn:     ctx.retry.constructor === Function,
  sleepCtorIsContextFn:     ctx.sleep.constructor === Function,
};

// Slice 8b: __pi_install_stdlib must be hidden after init (deleted
// once __pi_build_ctx captures the helper closures). Mirrors the
// console-bridge-hidden invariant for __pi_console_log__.
tests["stdlib-factory-hidden"] = {
  visibleAsKey: Reflect.ownKeys(globalThis).includes("__pi_install_stdlib"),
  enumerable: Object.keys(globalThis).includes("__pi_install_stdlib"),
  fromGetOwnPropDescriptor:
    Object.getOwnPropertyDescriptor(globalThis, "__pi_install_stdlib") !==
    undefined,
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
