/**
 * tests/unit/sandbox.test.ts — vm.Context sandbox surface tests.
 *
 * Covers PRD §4.3 globals table row-by-row + the §8 escape-vector
 * smoke checks. Per-vector deeper attacks live in
 * `tests/security/runner.test.ts`.
 *
 * Acceptance per plan.md §4 Slice 2:
 *   - §4.3 globals table enumerated row-by-row.
 *   - `Object.freeze(Object.prototype)` verified post-init.
 *   - Realm-error reconstruction round-trips an Error.
 *   - AggregateError preservation contract verified.
 *   - Timer wrappers clear on AbortSignal.
 *   - `Buffer` is present (regression guard against over-locking).
 *   - `process.env` is `{}` — not undefined, not host's env.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  Sandbox,
  runScript,
  detectShape,
  ALLOWED_NATIVE_GLOBALS,
  BLOCKED_GLOBALS,
  STUBBED_GLOBALS,
  INSTALLED_WEB_APIS,
} from "../../src/runtime/sandbox.ts";
import type { RunCtxHost } from "../../src/types/internal.js";

function fresh(): { ctrl: AbortController; signal: AbortSignal } {
  const ctrl = new AbortController();
  return { ctrl, signal: ctrl.signal };
}

// ─── Shape detection ─────────────────────────────────────────────

test("detectShape: bare top-level → A", () => {
  const r = detectShape(`return 42;`);
  assert.equal(r.shape, "A");
  assert.equal(r.body, "return 42;");
});

test("detectShape: `export default async function (ctx, input) { ... }` → B", () => {
  const r = detectShape(
    `export default async function (ctx, input) { return 'b'; }`,
  );
  assert.equal(r.shape, "B");
  assert.match(r.body, /return 'b';/);
});

test("detectShape: `export default function (ctx, input) { ... }` → B", () => {
  const r = detectShape(
    `export default function (ctx, input) { return 1; }`,
  );
  assert.equal(r.shape, "B");
});

test("detectShape: comment containing 'export default' must not trigger B", () => {
  // Single-line comments are stripped before detection.
  const r = detectShape(`// export default someExample\nreturn 1;`);
  assert.equal(r.shape, "A");
});

// ─── Basic runScript ─────────────────────────────────────────────

test("runScript: returns top-level return value", async () => {
  const { signal } = fresh();
  const r = await runScript(`return 1 + 2;`, { signal });
  assert.equal(r.returnValue, 3);
});

test("runScript: shape B is unwrapped and run", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `export default async function (ctx, input) { return 'shape-b'; }`,
    { signal },
  );
  assert.equal(r.returnValue, "shape-b");
});

test("runScript: input is exposed via globalThis.input (slice-2 binding)", async () => {
  const { signal } = fresh();
  const r = await runScript(`return input;`, { signal, input: "hello" });
  assert.equal(r.returnValue, "hello");
});

// ─── PRD §4.3 globals table ───────────────────────────────────────

for (const name of ALLOWED_NATIVE_GLOBALS) {
  test(`§4.3 ALLOWED native: ${name} is defined`, async () => {
    const { signal } = fresh();
    const r = await runScript(
      `return typeof globalThis[${JSON.stringify(name)}];`,
      { signal },
    );
    assert.notEqual(
      r.returnValue,
      "undefined",
      `${name} must be defined inside the sandbox`,
    );
  });
}

for (const name of INSTALLED_WEB_APIS) {
  test(`§4.3 ALLOWED web API: ${name} is defined`, async () => {
    const { signal } = fresh();
    const r = await runScript(
      `return typeof globalThis[${JSON.stringify(name)}];`,
      { signal },
    );
    assert.notEqual(r.returnValue, "undefined", `${name} should be installed`);
  });
}

for (const name of BLOCKED_GLOBALS) {
  test(`§4.3 BLOCKED: ${name} is undefined`, async () => {
    const { signal } = fresh();
    const r = await runScript(
      `return typeof globalThis[${JSON.stringify(name)}];`,
      { signal },
    );
    assert.equal(
      r.returnValue,
      "undefined",
      `${name} must NOT be installed in the sandbox`,
    );
  });
}

for (const name of STUBBED_GLOBALS) {
  test(`§4.3 STUBBED: ${name} is present (not host's)`, async () => {
    const { signal } = fresh();
    const r = await runScript(
      `return typeof globalThis[${JSON.stringify(name)}];`,
      { signal },
    );
    assert.equal(r.returnValue, "object", `${name} must be a stub object`);
  });
}

test("§8.3.9 process.env is empty (NOT host's env)", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `return { keys: Object.keys(process.env).length, pathType: typeof process.env.PATH };`,
    { signal },
  );
  // Cross-realm objects don't pass deepStrictEqual prototype checks.
  // Compare field-by-field.
  const v = r.returnValue as { keys: number; pathType: string };
  assert.equal(v.keys, 0);
  assert.equal(v.pathType, "undefined");
});

test("§4.3 process stub exposes platform/arch/versions.node", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `return { platform: process.platform, arch: process.arch, nodeType: typeof process.versions.node };`,
    { signal },
  );
  const v = r.returnValue as { platform: unknown; arch: unknown; nodeType: unknown };
  assert.equal(typeof v.platform, "string");
  assert.equal(typeof v.arch, "string");
  assert.equal(v.nodeType, "string");
});

test("§4.3 Buffer is present (PRD critic guard)", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `const b = Buffer.from('AB'); return b.toString('hex');`,
    { signal },
  );
  assert.equal(r.returnValue, "4142");
});

test("eval / Function are present (PRD ⚠ row) — but escape only into the Context", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `
      const evalOk  = typeof eval === 'function';
      const funcOk  = typeof Function === 'function';
      const escape  = (Function('return process'))();
      const escapeReq = (Function('try { return require } catch (e) { return undefined; }'))();
      return { evalOk, funcOk, escapeType: typeof escape, escapeReqType: typeof escapeReq };
    `,
    { signal },
  );
  // process is a stub (object), not the host's. require is undefined.
  const v = r.returnValue as {
    evalOk: boolean;
    funcOk: boolean;
    escapeType: string;
    escapeReqType: string;
  };
  assert.equal(v.evalOk, true);
  assert.equal(v.funcOk, true);
  assert.equal(v.escapeType, "object");
  assert.equal(v.escapeReqType, "undefined");
});

test("dynamic import is unavailable (throws)", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `
      try {
        await import('node:fs');
        return 'leaked';
      } catch (e) {
        return 'threw:' + e.name;
      }
    `,
    { signal },
  );
  assert.match(String(r.returnValue), /threw:/);
});

// ─── Freezing (PRD §8.3.2) ────────────────────────────────────────

test("§8.3.2 Object.prototype is frozen", async () => {
  const { signal } = fresh();
  const r = await runScript(`return Object.isFrozen(Object.prototype);`, {
    signal,
  });
  assert.equal(r.returnValue, true);
});

test("§8.3.2 Array.prototype + Function.prototype are frozen", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `return { arr: Object.isFrozen(Array.prototype), fn: Object.isFrozen(Function.prototype) };`,
    { signal },
  );
  const v = r.returnValue as { arr: boolean; fn: boolean };
  assert.equal(v.arr, true);
  assert.equal(v.fn, true);
});

test("§8.3.2 prototype-pollution attempt throws TypeError under strict mode", async () => {
  const { signal } = fresh();
  await assert.rejects(
    runScript(`Object.prototype.poisoned = 'pwn'; return 'no-throw';`, {
      signal,
    }),
    /not extensible|Cannot/i,
  );
});

test("§8.3.2 prototype-pollution defended via assignment chain too", async () => {
  // [].constructor.prototype = Array.prototype (frozen).
  const { signal } = fresh();
  await assert.rejects(
    runScript(`[].constructor.prototype.evil = 1; return 'no-throw';`, {
      signal,
    }),
    /Cannot/i,
  );
});

test("MUTATION-PROBE: if Object.prototype is NOT frozen, this test fails", async () => {
  // Critical: deleting `Object.freeze(Object.prototype)` from sandbox.ts's
  // init script must surface here.
  const { signal } = fresh();
  const r = await runScript(`return Object.isFrozen(Object.prototype);`, {
    signal,
  });
  assert.equal(
    r.returnValue,
    true,
    "Object.prototype MUST be frozen — this is the load-bearing pollution defense",
  );
});

// ─── Realm error reconstruction round-trip via timer error path ───

test("timer callback throwing Error: surfaces in log", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `
      // Schedule a timer that throws and let it fire before we return.
      setTimeout(() => { throw new Error('timer-boom'); }, 5);
      await new Promise(r => setTimeout(r, 50));
      return 'done';
    `,
    { signal },
  );
  assert.equal(r.returnValue, "done");
  // The timer error gets logged as level=error via the default sink.
  const errLine = r.log.find((l) => l.level === "error");
  assert.ok(errLine, "expected an error log entry from the timer throw");
  assert.match(errLine!.args.join(" "), /timer-boom/);
});

// ─── AbortSignal ────────────────────────────────────────────────

test("AbortSignal: aborting mid-await rejects the run", async () => {
  const { ctrl, signal } = fresh();
  const p = runScript(
    `await new Promise(r => setTimeout(r, 1000)); return 'finished';`,
    { signal },
  );
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, /aborted/);
});

test("AbortSignal: aborting before run rejects immediately", async () => {
  const { ctrl, signal } = fresh();
  ctrl.abort();
  await assert.rejects(runScript(`return 1;`, { signal }), /aborted/);
});

// ─── console capture ────────────────────────────────────────────

test("console.log is wired to the sandbox log capture", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `console.log('hi', 42, { a: 1 }); return 0;`,
    { signal },
  );
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0]!.level, "log");
  // Args are stringified host-side. Compare element-by-element
  // (deepStrictEqual fails on cross-realm arrays).
  const args = r.log[0]!.args;
  assert.equal(args.length, 3);
  assert.equal(args[0], "hi");
  assert.equal(args[1], "42");
  assert.equal(args[2], "[object Object]");
});

test("console.error / warn / info / debug are routed correctly", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `console.info('i'); console.warn('w'); console.error('e'); console.debug('d'); return 0;`,
    { signal },
  );
  const levels = r.log.map((l) => l.level);
  assert.equal(levels.length, 4);
  assert.equal(levels[0], "info");
  assert.equal(levels[1], "warn");
  assert.equal(levels[2], "error");
  assert.equal(levels[3], "debug");
});

test("DI'd log sink is used when SandboxOptions.log is provided", async () => {
  const { signal } = fresh();
  const captured: string[] = [];
  const r = await runScript(`console.log('DI'); return 0;`, {
    signal,
    log: (e) => captured.push(e.args.join(" ")),
  });
  assert.deepEqual(captured, ["DI"]);
  // The default in-memory log is empty since DI took over.
  assert.equal(r.log.length, 0);
});

// ─── Sandbox class API ──────────────────────────────────────────

test("Sandbox class: dispose is idempotent", async () => {
  const { signal } = fresh();
  const sb = new Sandbox({ signal });
  sb.dispose();
  sb.dispose();
  // Running on a disposed sandbox must reject.
  await assert.rejects(sb.runScript(`return 1`), /already disposed|dispose/);
});

test("Sandbox: disallowed code generation when allowCodegen=false", async () => {
  const { signal } = fresh();
  await assert.rejects(
    runScript(`Function('return 1')(); return 0;`, {
      signal,
      allowCodegen: false,
    }),
    /Code generation/i,
  );
});

// ─── Realm leak smoke check ─────────────────────────────────────

test("§8.3.1 Function-constructor escape returns Context's globalThis only", async () => {
  // The PRD claims this works but only escapes to the Context's
  // globalThis. Verify by checking that `process.env` (the Context's
  // stub) is reached, not the host's env.
  const { signal } = fresh();
  const r = await runScript(
    `
      const F = (() => {}).constructor;
      const escapeFn = new F('return globalThis');
      const escapedGlobal = escapeFn();
      // We expect escapedGlobal to be the Context's globalThis.
      // Verify by looking at process.env (sandbox's stub is empty).
      return Object.keys(escapedGlobal.process.env).length;
    `,
    { signal },
  );
  assert.equal(r.returnValue, 0, "escape resolved to Context's stubbed env");
});

// ─── BUG-109: __pi_clone_into_ctx undefined preservation + circular ref ────
// After BUG-023 (IIFE helpers), __pi_clone_into_ctx is closure-local and NOT
// accessible as a globalThis property. Tests exercise it indirectly via the
// ctx.cache.get() host-roundtrip path (wrapHostAsync → __pi_unwrap → __pi_clone_into_ctx).

/** Build a minimal RunCtxHost where cacheGet returns a fixed value. */
function hostReturning(value: unknown): RunCtxHost {
  const ok = <T>(v: T) => ({ ok: true as const, value: v });
  return {
    runMeta: { id: 'bug109', workflowName: 'test', startedAt: '1970-01-01T00:00:00Z', cwd: '.', resumed: false },
    input: '',
    agent: () => ok({ kind: 'agent' as const, id: 'a', prompt: '', opts: Object.freeze({}) }),
    phase: async () => ok([]),
    cacheGet: async () => ok(value),
    cacheSet: async () => ok(null),
    cacheHas: async () => ok(false),
    cacheDelete: async () => ok(null),
    log: () => ok(null),
    finishCallback: () => ok(null),
    getBudgetSpent: () => 0,
    tokenBudget: null,
    progress: () => ok(null),
    checkpoint: async () => ok(false),
    report: () => ok(null),
    gate: async () => ok(true),
    memo_check: async () => ok({ hit: false as const }),
    memo_set: async () => ok(null),
  };
}

test("BUG-109: __pi_clone_into_ctx preserves undefined object values (not dropped)", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `
      const cloned = await ctx.cache.get('key');
      return JSON.stringify({
        hasA: Object.prototype.hasOwnProperty.call(cloned, 'a'),
        aIsUndefined: cloned.a === undefined,
        b: cloned.b,
      });
    `,
    { signal, runCtxHost: hostReturning({ a: undefined, b: 1 }) },
  );
  const result = JSON.parse(r.returnValue as string);
  assert.equal(result.hasA, true, "key 'a' with undefined value must be preserved");
  assert.equal(result.aIsUndefined, true, "cloned.a must be undefined");
  assert.equal(result.b, 1, "cloned.b must be 1");
});

test("BUG-109: __pi_clone_into_ctx preserves undefined array elements (not coerced to null)", async () => {
  const { signal } = fresh();
  const r = await runScript(
    `
      const cloned = await ctx.cache.get('key');
      return JSON.stringify({
        length: cloned.length,
        e0IsUndefined: cloned[0] === undefined,
        e1: cloned[1],
        e2IsUndefined: cloned[2] === undefined,
      });
    `,
    { signal, runCtxHost: hostReturning([undefined, 1, undefined]) },
  );
  const result = JSON.parse(r.returnValue as string);
  assert.equal(result.length, 3, "cloned array length must be 3");
  assert.equal(result.e0IsUndefined, true, "cloned[0] must be undefined, not null");
  assert.equal(result.e1, 1, "cloned[1] must be 1");
  assert.equal(result.e2IsUndefined, true, "cloned[2] must be undefined, not null");
});

test("BUG-109: __pi_clone_into_ctx throws descriptive error on circular reference", async () => {
  const { signal } = fresh();
  // Inject a circular object through the host bridge — __pi_clone_into_ctx
  // traverses it and must detect the cycle.
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const r = await runScript(
    `
      let threw = null;
      try {
        await ctx.cache.get('key');
      } catch (e) {
        threw = e.message;
      }
      return threw;
    `,
    { signal, runCtxHost: hostReturning(circular) },
  );
  assert.ok(
    typeof r.returnValue === "string" &&
      r.returnValue.includes("circular reference detected"),
    `expected circular reference error, got: ${r.returnValue}`,
  );
});

test("BUG-109: __pi_clone_into_ctx circular array detection throws", async () => {
  const { signal } = fresh();
  const arr: unknown[] = [1, 2];
  arr.push(arr);
  const r = await runScript(
    `
      let threw = null;
      try {
        await ctx.cache.get('key');
      } catch (e) {
        threw = e.message;
      }
      return threw;
    `,
    { signal, runCtxHost: hostReturning(arr) },
  );
  assert.ok(
    typeof r.returnValue === "string" &&
      r.returnValue.includes("circular reference detected"),
    `expected circular reference error, got: ${r.returnValue}`,
  );
});

test("BUG-109: __pi_clone_into_ctx handles nested objects correctly (sibling re-use allowed)", async () => {
  // Same object appearing as two separate siblings must NOT throw.
  const { signal } = fresh();
  const inner = { v: 42 };
  const outer = { x: inner, y: inner };
  const r = await runScript(
    `
      const cloned = await ctx.cache.get('key');
      return JSON.stringify({ xv: cloned.x.v, yv: cloned.y.v });
    `,
    { signal, runCtxHost: hostReturning(outer) },
  );
  const result = JSON.parse(r.returnValue as string);
  assert.equal(result.xv, 42, "cloned.x.v must be 42");
  assert.equal(result.yv, 42, "cloned.y.v must be 42");
});
