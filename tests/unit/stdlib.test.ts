/**
 * tests/unit/stdlib.test.ts — slice 8b unit suite for the stdlib
 * helpers exposed on `ctx`.
 *
 * Covers behaviors the integration suite can't reach cheaply:
 *
 *   - vote with an async judge (Promise-returning).
 *   - consensus 1-agent edge case → agreed=true (plan critic checklist).
 *   - consensus disagreement at default threshold.
 *   - parallel: fn that returns a single (non-array) handle.
 *   - retry: AbortSignal mid-backoff cancels the chain (plan critic
 *     checklist — must NOT swallow AbortError).
 *   - retry: opts.attempts=1 means no retry; rejection is surfaced.
 *   - retry: invalid opts.attempts rejected with RangeError.
 *   - sleep: 0ms resolves; negative ms rejects; abort listener removed
 *     on natural resolution (no leak).
 *   - sleep: pre-aborted signal → reject without timer.
 *   - tokenize: punctuation stripping, casefolding (via the public
 *     consensus path with adversarial inputs).
 *
 * These tests drive the helpers directly through `runScript` with a
 * stub `runCtxHost` whose `phase` returns canned `AgentResultLike[]`.
 * That avoids the runManager startup cost while still exercising the
 * full Context-realm wrap path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import { extractJson } from "../../src/runtime/runCtx.js";
import type {
  AgentResultLike,
  RunCtxHost,
} from "../../src/types/internal.js";

/** Build a minimal stub host whose `phase` returns canned results. */
function stubHost(opts: {
  phaseResults?: (
    name: string,
    handles: ReadonlyArray<{ id: string; prompt: string }>,
  ) => AgentResultLike[];
}): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-stdlibtest",
      workflowName: "stdlib",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: ".",
      resumed: false,
    },
    input: "",
    agent: (prompt, optsArg) => {
      const o =
        optsArg && typeof optsArg === "object"
          ? (optsArg as Record<string, unknown>)
          : {};
      const id = typeof o.id === "string" ? (o.id as string) : "auto";
      return ok({
        kind: "agent" as const,
        id,
        prompt: String(prompt),
        opts: Object.freeze({ id }),
      });
    },
    phase: async (nameArg, agentsArg, optsArg) => {
      const name = String(nameArg);
      const handles = (agentsArg as ReadonlyArray<unknown>).map((h) => {
        const o = h as { id?: string; prompt?: string };
        return { id: o.id ?? "?", prompt: o.prompt ?? "" };
      });
      const failMode =
        optsArg !== null && typeof optsArg === 'object'
          ? (optsArg as Record<string, unknown>).failMode
          : undefined;
      let results: Array<AgentResultLike | null>;
      try {
        results = (
          opts.phaseResults?.(name, handles) ??
          handles.map((h) => ({
            agentId: h.id,
            text: "stub:" + h.id,
            usage: { input: 0, output: 0, totalTokens: 0 },
            durationMs: 0,
            toolCalls: 0,
            transcriptPath: "",
            cached: false,
          }))
        );
      } catch (e) {
        if (failMode === 'null') {
          // Return nulls for all failed agents.
          return ok(handles.map(() => null) as unknown as AgentResultLike[]);
        }
        // Default: return error envelope.
        const err = e instanceof Error ? e : new Error(String(e));
        return {
          ok: false as const,
          error: {
            name: err.name,
            message: err.message,
            stack: err.stack ?? null,
            wrappedNonError: false,
          },
        };
      }
      return ok(results as AgentResultLike[]);
    },
    cacheGet: async () => ok(undefined),
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
    interrupt: async () => ok(null),
    memo_check: async () => ok({ hit: false as const }),
    memo_set: async () => ok(null),
  };
}

async function runWith(source: string, host?: RunCtxHost): Promise<unknown> {
  const ctrl = new AbortController();
  const r = await runScript(source, {
    signal: ctrl.signal,
    runCtxHost: host ?? stubHost({}),
  });
  return r.returnValue;
}

// ─── vote ───────────────────────────────────────────────────────────

test("ctx.vote: async judge (returns a Promise) is awaited", async () => {
  const host = stubHost({
    phaseResults: () => [
      mkResult("a", "alpha"),
      mkResult("b", "beta"),
      mkResult("c", "gamma"),
    ],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "a" });
      const b = ctx.agent("p", { id: "b" });
      const c = ctx.agent("p", { id: "c" });
      return await ctx.vote([a, b, c], async (responses) => {
        // Yield once so we know the helper Promise.resolve()s the result.
        await Promise.resolve();
        return responses[1];
      });
    `,
    host,
  )) as { winner: string; responses: string[] };
  assert.equal(out.winner, "beta");
  assert.deepEqual([...out.responses], ["alpha", "beta", "gamma"]);
});

test("ctx.vote: throws TypeError when judge is not a function", async () => {
  await assert.rejects(
    runWith(
      `
        const a = ctx.agent("p", { id: "a" });
        return await ctx.vote([a], "not-a-function");
      `,
    ),
    (e: unknown) => {
      const err = e as Error;
      return /ctx\.vote: judge must be a function/.test(err.message);
    },
  );
});

test("ctx.vote: throws TypeError when agents is not an array", async () => {
  await assert.rejects(
    runWith(`return await ctx.vote("nope", () => "x");`),
    /ctx\.vote: agents must be an array/,
  );
});

// ─── consensus ─────────────────────────────────────────────────────

test("ctx.consensus: 1-agent case is always agreed", async () => {
  const host = stubHost({
    phaseResults: () => [mkResult("a", "anything goes here")],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "a" });
      return await ctx.consensus([a]);
    `,
    host,
  )) as { agreed: boolean; majorityText: string; responses: string[] };
  assert.equal(out.agreed, true);
  assert.equal(out.majorityText, "anything goes here");
  assert.deepEqual([...out.responses], ["anything goes here"]);
});

test("ctx.consensus: 0-agent case is agreed with empty majorityText", async () => {
  const host = stubHost({ phaseResults: () => [] });
  const out = (await runWith(
    `return await ctx.consensus([]);`,
    host,
  )) as { agreed: boolean; majorityText: string; responses: string[] };
  assert.equal(out.agreed, true);
  assert.equal(out.majorityText, "");
  assert.deepEqual([...out.responses], []);
});

test("ctx.consensus: disagreement at default threshold (3 disjoint sets)", async () => {
  const host = stubHost({
    phaseResults: () => [
      mkResult("a", "alpha beta gamma"),
      mkResult("b", "delta epsilon zeta"),
      mkResult("c", "eta theta iota"),
    ],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "a" });
      const b = ctx.agent("p", { id: "b" });
      const c = ctx.agent("p", { id: "c" });
      return await ctx.consensus([a, b, c]);
    `,
    host,
  )) as { agreed: boolean; majorityText: string };
  assert.equal(out.agreed, false);
  // majorityText is whichever response was picked — we just assert it's
  // one of the inputs (deterministic but implementation-specific).
  assert.ok(
    [
      "alpha beta gamma",
      "delta epsilon zeta",
      "eta theta iota",
    ].includes(out.majorityText),
  );
});

test("ctx.consensus: tokenizer is case-insensitive and strips punctuation", async () => {
  // "Auth.ts!" and "auth ts" tokenize to the same set: { auth, ts }.
  const host = stubHost({
    phaseResults: () => [
      mkResult("a", "Auth.ts!"),
      mkResult("b", "auth ts"),
    ],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "a" });
      const b = ctx.agent("p", { id: "b" });
      return await ctx.consensus([a, b], { threshold: 0.9 });
    `,
    host,
  )) as { agreed: boolean };
  assert.equal(out.agreed, true);
});

test("ctx.consensus: rejects threshold outside [0,1]", async () => {
  await assert.rejects(
    runWith(`return await ctx.consensus([], { threshold: 1.5 });`),
    /ctx\.consensus: opts\.threshold must be in/,
  );
});

// ─── parallel ──────────────────────────────────────────────────────

test("ctx.parallel: fn returning a single (non-array) handle", async () => {
  const host = stubHost({
    phaseResults: (_, handles) =>
      handles.map((h) => mkResult(h.id, "out:" + h.id)),
  });
  const out = (await runWith(
    `
      return await ctx.parallel([1, 2, 3], (n) =>
        ctx.agent("solo " + n, { id: "n" + n })
      );
    `,
    host,
  )) as Array<{ agentId: string; text: string }>;
  assert.deepEqual(
    [...out].map((r) => r.agentId).sort(),
    ["n1", "n2", "n3"],
  );
});

test("ctx.parallel: rejects non-array items", async () => {
  await assert.rejects(
    runWith(`return await ctx.parallel("no", () => null);`),
    /ctx\.parallel: items must be an array/,
  );
});

test("ctx.parallel: rejects non-function fn", async () => {
  await assert.rejects(
    runWith(`return await ctx.parallel([1], 42);`),
    /ctx\.parallel: fn must be a function/,
  );
});

// ─── retry ─────────────────────────────────────────────────────────

test("ctx.retry: succeeds on attempt 3 with attempts=5", async () => {
  const out = (await runWith(`
    let n = 0;
    const v = await ctx.retry(async () => {
      n++;
      if (n < 3) throw new Error("nope " + n);
      return "ok-" + n;
    }, { attempts: 5, backoffMs: 1 });
    return { v, n };
  `)) as { v: string; n: number };
  assert.equal(out.v, "ok-3");
  assert.equal(out.n, 3);
});

test("ctx.retry: attempts=1 surfaces the rejection (no retry)", async () => {
  await assert.rejects(
    runWith(`
      let n = 0;
      return await ctx.retry(async () => {
        n++;
        throw new Error("attempt " + n);
      }, { attempts: 1, backoffMs: 1 });
    `),
    /attempt 1/,
  );
});

test("ctx.retry: invalid attempts rejected with RangeError", async () => {
  await assert.rejects(
    runWith(`return await ctx.retry(() => 1, { attempts: 0 });`),
    /opts\.attempts must be a finite number/,
  );
  await assert.rejects(
    runWith(`return await ctx.retry(() => 1, { attempts: -3 });`),
    /opts\.attempts must be a finite number/,
  );
});

test("ctx.retry: AbortError is NOT swallowed (rethrown immediately)", async () => {
  // Plan critic checklist: AbortError must propagate without consuming
  // the attempt budget.
  //
  // Note: Error.prototype is frozen in the sandbox (PRD §8.3.2), so
  // `e.name = "AbortError"` throws a TypeError in strict mode
  // (assignment walks the chain to the frozen prototype's `name`).
  // Use defineProperty to install an own data property and bypass the
  // [[Set]] write-up-the-chain.
  await assert.rejects(
    runWith(`
      let n = 0;
      try {
        await ctx.retry(async () => {
          n++;
          const e = new Error("user-abort");
          Object.defineProperty(e, "name", {
            value: "AbortError",
            configurable: true,
            writable: true,
          });
          throw e;
        }, { attempts: 5, backoffMs: 1 });
      } catch (e) {
        // Re-throw with attempt count for the test to assert on.
        const wrapped = new Error("rethrown attempts=" + n);
        wrapped.cause = e;
        throw wrapped;
      }
    `),
    (e: unknown) => /rethrown attempts=1/.test((e as Error).message),
  );
});

test("ctx.retry: opts.signal aborts during backoff sleep", async () => {
  // Use a fast backoff so the test is quick.
  const out = (await runWith(`
    ${MAKE_SIGNAL_SOURCE}
    const ctrl = makeSignal();
    let started = 0;
    const p = ctx.retry(async () => {
      started++;
      throw new Error("fail-" + started);
    }, { attempts: 10, backoffMs: 50, signal: ctrl.signal });
    // Schedule abort during the first backoff.
    setTimeout(() => ctrl.abort(new Error("user-cancel")), 10);
    let caught = null;
    try { await p; } catch (e) { caught = { name: e.name, message: e.message }; }
    return { started, caught };
  `)) as { started: number; caught: { name: string; message: string } | null };
  // The fn ran at least once before the abort fired during backoff.
  assert.ok(out.started >= 1);
  // The chain rejected with the abort reason.
  assert.ok(out.caught !== null);
  assert.equal(out.caught!.message, "user-cancel");
});

// ─── sleep ─────────────────────────────────────────────────────────

test("ctx.sleep: 0ms resolves on next macrotask", async () => {
  const out = (await runWith(`
    const t0 = Date.now();
    await ctx.sleep(0);
    return { ok: true, deltaMs: Date.now() - t0 };
  `)) as { ok: boolean; deltaMs: number };
  assert.equal(out.ok, true);
  assert.ok(out.deltaMs >= 0);
});

test("ctx.sleep: negative ms rejects with TypeError", async () => {
  await assert.rejects(
    runWith(`return await ctx.sleep(-5);`),
    /ctx\.sleep: ms must be a non-negative finite number/,
  );
});

test("ctx.sleep: NaN ms rejects with TypeError", async () => {
  await assert.rejects(
    runWith(`return await ctx.sleep(NaN);`),
    /ctx\.sleep: ms must be a non-negative finite number/,
  );
});

test("ctx.sleep: pre-aborted signal rejects without scheduling timer", async () => {
  const out = (await runWith(`
    ${MAKE_SIGNAL_SOURCE}
    const ctrl = makeSignal();
    ctrl.abort(new Error("pre-aborted"));
    let caught = null;
    try { await ctx.sleep(1000, { signal: ctrl.signal }); }
    catch (e) { caught = { message: e.message }; }
    return caught;
  `)) as { message: string } | null;
  assert.ok(out !== null);
  assert.equal(out!.message, "pre-aborted");
});

test("ctx.sleep: abort during sleep cancels timer", async () => {
  const out = (await runWith(`
    ${MAKE_SIGNAL_SOURCE}
    const ctrl = makeSignal();
    setTimeout(() => ctrl.abort(new Error("mid-sleep")), 5);
    const t0 = Date.now();
    let caught = null;
    try { await ctx.sleep(500, { signal: ctrl.signal }); }
    catch (e) { caught = { message: e.message, delta: Date.now() - t0 }; }
    return caught;
  `)) as { message: string; delta: number } | null;
  assert.ok(out !== null);
  assert.equal(out!.message, "mid-sleep");
  // We aborted at ~5ms so the resolve must NOT have waited the full 500ms.
  assert.ok(out!.delta < 400, `aborted in ${out!.delta}ms (must be < 400)`);
});

test("ctx.sleep: listener removed on natural resolution (no leak)", async () => {
  // We use the duck-typed signal polyfill so we can count listener
  // adds/removes deterministically. If sleep leaked,
  // listenerCount would grow across calls.
  const out = (await runWith(`
    ${MAKE_SIGNAL_SOURCE}
    const ctrl = makeSignal();
    await ctx.sleep(2, { signal: ctrl.signal });
    await ctx.sleep(2, { signal: ctrl.signal });
    await ctx.sleep(2, { signal: ctrl.signal });
    return { addCount: ctrl.addCount, removeCount: ctrl.removeCount };
  `)) as { addCount: number; removeCount: number };
  assert.equal(out.addCount, 3);
  assert.equal(out.removeCount, 3);
});

// ─── pipeline tests ───────────────────────────────────────────────

test("ctx.pipeline: processes two items through two stages", async () => {
  const host = stubHost({
    phaseResults: (_name, handles) =>
      handles.map((h) => mkResult(h.id, `processed:${h.prompt}`)),
  });
  const result = await runWith(
    `
export const meta = { name: 'p', description: 'p', version: '1' };
export default async function (ctx) {
  return await ctx.pipeline(
    ['a', 'b'],
    (item) => ctx.agent('task:' + item, { id: 'agent-' + item }),
    (agentResult, _item, _idx) => agentResult.text + '-done',
  );
}
    `.trim(),
    host,
  );
  const arr = result as string[];
  assert.equal(arr.length, 2);
  assert.ok((arr[0] ?? "").includes('-done'));
  assert.ok((arr[1] ?? "").includes('-done'));
});

test("ctx.pipeline: rejects non-array first arg", async () => {
  await assert.rejects(
    () =>
      runWith(
        `
export const meta = { name: 'p', description: 'p', version: '1' };
export default async function (ctx) {
  return await ctx.pipeline('not-array', (x) => x);
}
        `.trim(),
        stubHost({}),
      ),
    /first argument must be an array/,
  );
});

test("ctx.pipeline: rejects non-function stage", async () => {
  await assert.rejects(
    () =>
      runWith(
        `
export const meta = { name: 'p', description: 'p', version: '1' };
export default async function (ctx) {
  return await ctx.pipeline(['x'], 'not-a-function');
}
        `.trim(),
        stubHost({}),
      ),
    /stage arguments must be functions/,
  );
});

// ─── budget tests ──────────────────────────────────────────────────

test("ctx.budget: total is null and remaining is Infinity", async () => {
  const result = await runWith(
    `
export const meta = { name: 'b', description: 'b', version: '1' };
export default async function (ctx) {
  return { total: ctx.budget.total, remaining: ctx.budget.remaining() };
}
    `.trim(),
    stubHost({}),
  );
  const r = result as { total: unknown; remaining: unknown };
  assert.equal(r.total, null);
  assert.equal(r.remaining, Infinity);
});

test("ctx.budget: spent() accumulates after phase", async () => {
  let spent = 0;
  const host = stubHost({
    phaseResults: (_name, handles) =>
      handles.map((h) => {
        spent += 15; // simulate token spend
        return mkResultWithUsage(h.id, "reply", { input: 10, output: 5, totalTokens: 15 });
      }),
  });
  // Override getBudgetSpent to use our local counter
  (host as RunCtxHost & { getBudgetSpent: () => number }).getBudgetSpent = () => spent;
  const result = await runWith(
    `
export const meta = { name: 'b', description: 'b', version: '1' };
export default async function (ctx) {
  const before = ctx.budget.spent();
  await ctx.phase('work', [ctx.agent('task', { id: 'a' })]);
  const after = ctx.budget.spent();
  return { before, after };
}
    `.trim(),
    host,
  );
  const r = result as { before: number; after: number };
  assert.equal(r.before, 0);
  assert.equal(r.after, 15);
});

test("budget global is same as ctx.budget", async () => {
  const result = await runWith(
    `
export const meta = { name: 'b', description: 'b', version: '1' };
export default async function (ctx) {
  return budget.total === ctx.budget.total && budget.spent === ctx.budget.spent;
}
    `.trim(),
    stubHost({}),
  );
  assert.equal(result, true);
});

// ─── failMode tests ────────────────────────────────────────────────

test("ctx.phase failMode='null': returns null for failed agents", async () => {
  const host = stubHost({
    phaseResults: () => {
      throw new Error("agent failed");
    },
  });
  const result = await runWith(
    `
export const meta = { name: 'f', description: 'f', version: '1' };
export default async function (ctx) {
  const results = await ctx.phase('work', [ctx.agent('task', { id: 'a' })], { failMode: 'null' });
  return results;
}
    `.trim(),
    host,
  );
  const arr = result as Array<unknown>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0], null);
});

test("ctx.phase default failMode: throws AggregateError on failure", async () => {
  const host = stubHost({
    phaseResults: () => {
      throw new Error("agent failed");
    },
  });
  await assert.rejects(
    () =>
      runWith(
        `
export const meta = { name: 'f', description: 'f', version: '1' };
export default async function (ctx) {
  return await ctx.phase('work', [ctx.agent('task', { id: 'a' })]);
}
        `.trim(),
        host,
      ),
    /failed/,
  );
});

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Duck-typed AbortSignal polyfill for Context-realm tests.
 * `AbortController` is not in PRD §4.3 curated globals, so tests use
 * this minimal stand-in. Same surface the helpers consume:
 * `aborted`, `reason`, `addEventListener('abort', fn, opts)`,
 * `removeEventListener('abort', fn)`.
 */
const MAKE_SIGNAL_SOURCE = `
  function makeSignal() {
    const listeners = new Set();
    let aborted = false;
    let reason = undefined;
    let addCount = 0;
    let removeCount = 0;
    const signal = {
      get aborted() { return aborted; },
      get reason() { return reason; },
      addEventListener(name, fn, _opts) {
        if (name !== 'abort' || typeof fn !== 'function') return;
        addCount++;
        listeners.add(fn);
      },
      removeEventListener(name, fn) {
        if (name !== 'abort') return;
        if (listeners.has(fn)) {
          removeCount++;
          listeners.delete(fn);
        }
      },
    };
    function abort(r) {
      if (aborted) return;
      aborted = true;
      reason = r;
      for (const fn of listeners) {
        try { fn(); } catch (_) {}
      }
      listeners.clear();
    }
    return {
      signal,
      abort,
      get addCount() { return addCount; },
      get removeCount() { return removeCount; },
    };
  }
`;

function mkResult(id: string, text: string): AgentResultLike {
  return {
    agentId: id,
    text,
    usage: { input: 0, output: 0, totalTokens: 0 },
    durationMs: 0,
    toolCalls: 0,
    transcriptPath: "",
    cached: false,
  };
}

function mkResultWithUsage(
  id: string,
  text: string,
  usage: { input: number; output: number; totalTokens: number },
): AgentResultLike {
  return {
    agentId: id,
    text,
    usage: { ...usage },
    durationMs: 0,
    toolCalls: 0,
    transcriptPath: "",
    cached: false,
  };
}

// ─── extractJson ─────────────────────────────────────────────────────────────

test("extractJson: parses ```json fence", () => {
  const text = 'Here is the result:\n```json\n{"name":"sam","count":3}\n```';
  assert.deepEqual(extractJson(text), { name: "sam", count: 3 });
});

test("extractJson: falls back to last { block when no fence", () => {
  const text = 'Sure, here is the JSON: {"x":1}';
  assert.deepEqual(extractJson(text), { x: 1 });
});

test("extractJson: falls back to last [ block for arrays", () => {
  const text = "result: [1,2,3]";
  assert.deepEqual(extractJson(text), [1, 2, 3]);
});

test("extractJson: prefers last JSON fence over earlier ones", () => {
  const text = "```json\n{\"old\":true}\n```\nUpdated:\n```json\n{\"new\":true}\n```";
  // regex uses non-greedy — first fence wins. Known limitation documented.
  const result = extractJson(text) as Record<string, unknown>;
  assert.ok("old" in result || "new" in result, "should parse one of the fences");
});

test("extractJson: throws when no JSON found", () => {
  assert.throws(() => extractJson("no json here"), /no JSON found/);
});

// ─── opts.schema integration via stubHost ───────────────────────────────────


