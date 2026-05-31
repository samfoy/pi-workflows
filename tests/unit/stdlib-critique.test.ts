/**
 * tests/unit/stdlib-critique.test.ts — gap-fix coverage for the
 * ctx.critique({ producer, critic, maxRounds, accept }) primitive.
 *
 * Mirrors Anthropic's adversarial-refute pattern, AutoGen Magentic-One
 * ProgressLedger convergence, and DSPy MultiChainComparison. The
 * helper itself is realm-pure (no agent dispatch) — the producer and
 * critic functions are user-supplied and can wrap ctx.agent / ctx.phase
 * arbitrarily. Tests use plain async closures.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import type { RunCtxHost, AgentResultLike } from "../../src/types/internal.js";

function stubHost(): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-critique",
      workflowName: "critique",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: ".",
      resumed: false,
    },
    input: "",
    agent: () =>
      ok({
        kind: "agent" as const,
        id: "auto",
        prompt: "",
        opts: Object.freeze({ id: "auto" }),
      }),
    phase: async () => ok([] as AgentResultLike[]),
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
    interrupt: async () => ok({ key: "int-0", value: null }),
    memo_check: async () => ok({ hit: false as const }),
    memo_set: async () => ok(null),
  };
}

async function runWith(source: string): Promise<unknown> {
  const ctrl = new AbortController();
  const r = await runScript(source, {
    signal: ctrl.signal,
    runCtxHost: stubHost(),
  });
  return r.returnValue;
}

function j(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ─── basic loop convergence ───────────────────────────────────────

test("ctx.critique: accepts on round 0 when accept() returns true immediately", async () => {
  const out = await runWith(`
    return await ctx.critique({
      producer: async () => "draft v1",
      critic:   async () => "looks good",
      accept:   (cri) => cri === "looks good",
    });
  `);
  const r = j(out) as {
    accepted: boolean;
    output: string;
    critique: string;
    rounds: number;
  };
  assert.equal(r.accepted, true);
  assert.equal(r.output, "draft v1");
  assert.equal(r.critique, "looks good");
  assert.equal(r.rounds, 1);
});

test("ctx.critique: feeds critique back to producer on next round", async () => {
  const out = await runWith(`
    let lastCritiqueSeen = null;
    let producerCalls = 0;
    return await ctx.critique({
      producer: async (lastCritique, round) => {
        producerCalls++;
        lastCritiqueSeen = lastCritique;
        return "draft@" + round + "(saw:" + (lastCritique ?? "null") + ")";
      },
      critic: async (output) => {
        if (output.includes("(saw:fix it)")) return "ok";
        return "fix it";
      },
      accept: (c) => c === "ok",
      maxRounds: 5,
    });
  `);
  const r = j(out) as { accepted: boolean; rounds: number; output: string };
  assert.equal(r.accepted, true);
  // Round 0: producer sees null, output draft@0(saw:null) → critic returns "fix it"
  // Round 1: producer sees "fix it" → output draft@1(saw:fix it) → critic returns "ok" → accepted.
  assert.equal(r.rounds, 2);
  assert.match(r.output, /draft@1\(saw:fix it\)/);
});

test("ctx.critique: hits maxRounds budget when accept() never returns true", async () => {
  const out = await runWith(`
    let calls = 0;
    return await ctx.critique({
      producer: async () => { calls++; return "v" + calls; },
      critic:   async (o) => "needs work on " + o,
      accept:   () => false,
      maxRounds: 3,
    });
  `);
  const r = j(out) as {
    accepted: boolean;
    rounds: number;
    output: string;
    history: unknown[];
  };
  assert.equal(r.accepted, false);
  assert.equal(r.rounds, 3);
  assert.equal(r.output, "v3");
  assert.equal(r.history.length, 3);
});

test("ctx.critique: default accept (no accept option) hits maxRounds", async () => {
  const out = await runWith(`
    return await ctx.critique({
      producer: async () => "x",
      critic: async () => "y",
      maxRounds: 2,
    });
  `);
  const r = j(out) as { accepted: boolean; rounds: number };
  assert.equal(r.accepted, false);
  assert.equal(r.rounds, 2);
});

// ─── error paths ─────────────────────────────────────────────────

test("ctx.critique: rejects without producer", async () => {
  await assert.rejects(
    runWith(`return ctx.critique({ critic: async () => "x" });`),
    /opts\.producer must be a function/,
  );
});

test("ctx.critique: rejects without critic", async () => {
  await assert.rejects(
    runWith(`return ctx.critique({ producer: async () => "x" });`),
    /opts\.critic must be a function/,
  );
});

test("ctx.critique: rejects invalid maxRounds", async () => {
  await assert.rejects(
    runWith(`
      return ctx.critique({
        producer: async () => "x",
        critic:   async () => "y",
        maxRounds: 0,
      });
    `),
    /maxRounds must be a finite number/,
  );
});

test("ctx.critique: surfaces accept() exceptions verbatim", async () => {
  await assert.rejects(
    runWith(`
      return ctx.critique({
        producer: async () => "x",
        critic:   async () => "y",
        accept:   () => { throw new Error("accept-bug"); },
      });
    `),
    /accept-bug/,
  );
});

test("ctx.critique: surfaces producer exceptions verbatim", async () => {
  await assert.rejects(
    runWith(`
      return ctx.critique({
        producer: async () => { throw new Error("producer-bug"); },
        critic:   async () => "y",
      });
    `),
    /producer-bug/,
  );
});

test("ctx.critique: surfaces critic exceptions verbatim", async () => {
  await assert.rejects(
    runWith(`
      return ctx.critique({
        producer: async () => "x",
        critic:   async () => { throw new Error("critic-bug"); },
      });
    `),
    /critic-bug/,
  );
});

// ─── history ordering ────────────────────────────────────────────

test("ctx.critique: history preserves round order", async () => {
  const out = await runWith(`
    return await ctx.critique({
      producer: async (_, round) => "out" + round,
      critic:   async (_, round) => "crit" + round,
      accept:   () => false,
      maxRounds: 3,
    });
  `);
  const r = j(out) as {
    history: Array<{ output: string; critique: string }>;
  };
  assert.equal(r.history.length, 3);
  assert.equal(r.history[0]!.output, "out0");
  assert.equal(r.history[0]!.critique, "crit0");
  assert.equal(r.history[1]!.output, "out1");
  assert.equal(r.history[2]!.output, "out2");
});
