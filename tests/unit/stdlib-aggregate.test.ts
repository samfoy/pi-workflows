/**
 * tests/unit/stdlib-aggregate.test.ts — gap-fix coverage for the
 * ranked-aggregation primitives ported from DSPy issue #8898 (MIT):
 *
 *   - ctx.aggregate(method, ballots, opts)
 *   - ctx.consensus(agents, { method: 'borda' | 'schulze' | ... })
 *
 * Each algorithm is exercised against canonical test cases (Wikipedia
 * examples + classic election-theory scenarios). Tests run inside the
 * sandbox so the wrapper-identity oracle is exercised transitively.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import type {
  AgentResultLike,
  RunCtxHost,
} from "../../src/types/internal.js";

function stubHost(opts: {
  phaseResults?: (
    name: string,
    handles: ReadonlyArray<{ id: string; prompt: string }>,
  ) => AgentResultLike[];
}): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-agg",
      workflowName: "agg",
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
    phase: async (nameArg, agentsArg) => {
      const name = String(nameArg);
      const handles = (agentsArg as ReadonlyArray<unknown>).map((h) => {
        const o = h as { id?: string; prompt?: string };
        return { id: o.id ?? "?", prompt: o.prompt ?? "" };
      });
      return ok(
        opts.phaseResults?.(name, handles) ??
          handles.map((h) => ({
            agentId: h.id,
            text: "stub:" + h.id,
            usage: { input: 0, output: 0, totalTokens: 0 },
            durationMs: 0,
            toolCalls: 0,
            transcriptPath: "",
            cached: false,
          })),
      );
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

function j(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

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

// ─── ctx.aggregate: borda ──────────────────────────────────────────

test("ctx.aggregate borda: single-winner from ranked ballots", async () => {
  // 3 ballots: A>B>C, A>C>B, B>A>C → A=4, B=3, C=2 → A wins.
  const out = await runWith(`
    return ctx.aggregate('borda', [
      ['A','B','C'],
      ['A','C','B'],
      ['B','A','C'],
    ]);
  `);
  const r = j(out) as { winner: string; ranking: string[] };
  assert.equal(r.winner, "A");
  assert.deepEqual(r.ranking, ["A", "B", "C"]);
});

test("ctx.aggregate borda: tie broken deterministically by candidate id", async () => {
  // Two-way tie: A and B both score 1.
  const out = await runWith(`
    return ctx.aggregate('borda', [['A','B'], ['B','A']]);
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A"); // 'A' < 'B' deterministically.
});

// ─── ctx.aggregate: schulze ────────────────────────────────────────

test("ctx.aggregate schulze: classic Wikipedia example", async () => {
  // From en.wikipedia.org/wiki/Schulze_method ranking example.
  // 5 candidates, varied ballot multiplicities expressed as repeats.
  const ballots: string[][] = [];
  // 5x: A,C,B,E,D
  for (let i = 0; i < 5; i++) ballots.push(["A", "C", "B", "E", "D"]);
  // 5x: A,D,E,C,B
  for (let i = 0; i < 5; i++) ballots.push(["A", "D", "E", "C", "B"]);
  // 8x: B,E,D,A,C
  for (let i = 0; i < 8; i++) ballots.push(["B", "E", "D", "A", "C"]);
  // 3x: C,A,B,E,D
  for (let i = 0; i < 3; i++) ballots.push(["C", "A", "B", "E", "D"]);
  // 7x: C,A,E,B,D
  for (let i = 0; i < 7; i++) ballots.push(["C", "A", "E", "B", "D"]);
  // 2x: C,B,A,D,E
  for (let i = 0; i < 2; i++) ballots.push(["C", "B", "A", "D", "E"]);
  // 7x: D,C,E,B,A
  for (let i = 0; i < 7; i++) ballots.push(["D", "C", "E", "B", "A"]);
  // 8x: E,B,A,D,C
  for (let i = 0; i < 8; i++) ballots.push(["E", "B", "A", "D", "C"]);
  const out = await runWith(`
    return ctx.aggregate('schulze', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string; ranking: string[] };
  // Wikipedia: Schulze winner of this scenario is E.
  assert.equal(r.winner, "E");
  // Ranking should be: E > A > C > B > D
  assert.deepEqual(r.ranking, ["E", "A", "C", "B", "D"]);
});

test("ctx.aggregate schulze: Condorcet winner wins outright", async () => {
  // A beats B and C head-to-head → A is Condorcet winner.
  const ballots = [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
  ];
  const out = await runWith(`
    return ctx.aggregate('schulze', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

// ─── ctx.aggregate: ranked_pairs ──────────────────────────────────

test("ctx.aggregate ranked_pairs: Tideman picks Condorcet winner", async () => {
  const ballots = [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
  ];
  const out = await runWith(`
    return ctx.aggregate('ranked_pairs', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

test("ctx.aggregate ranked_pairs: resolves Condorcet cycle by margin", async () => {
  // Classic rock-paper-scissors: A>B, B>C, C>A. Margins decide.
  // 3 voters: A>B>C; 3 voters: B>C>A; 2 voters: C>A>B.
  // Pairwise: A vs B = 5-3 (margin 2); B vs C = 6-2 (margin 4); C vs A = 5-3 (margin 2).
  // Lock B>C first (largest margin), then A>B (smaller margin, no cycle yet),
  // then C>A would create a cycle → drop. Order: A > B > C.
  const ballots: string[][] = [];
  for (let i = 0; i < 3; i++) ballots.push(["A", "B", "C"]);
  for (let i = 0; i < 3; i++) ballots.push(["B", "C", "A"]);
  for (let i = 0; i < 2; i++) ballots.push(["C", "A", "B"]);
  const out = await runWith(`
    return ctx.aggregate('ranked_pairs', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

// ─── ctx.aggregate: kemeny_young ──────────────────────────────────

test("ctx.aggregate kemeny_young: minimizes Kendall tau distance", async () => {
  const ballots = [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
  ];
  const out = await runWith(`
    return ctx.aggregate('kemeny_young', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string; ranking: string[] };
  assert.equal(r.winner, "A");
  // Expected order: A, B, C (highest pairwise agreement)
  assert.deepEqual(r.ranking, ["A", "B", "C"]);
});

test("ctx.aggregate kemeny_young: rejects too many candidates", async () => {
  // 9 candidates is over the 8 max.
  const ballots = [
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
  ];
  await assert.rejects(
    runWith(`
      return ctx.aggregate('kemeny_young', ${JSON.stringify(ballots)});
    `),
    /too many candidates/,
  );
});

// ─── ctx.aggregate: instant_runoff ────────────────────────────────

test("ctx.aggregate instant_runoff: eliminates lowest-first-choice", async () => {
  // 5 ballots: 3x A>B>C, 1x B>A>C, 1x C>B>A.
  // Round 1: A=3, B=1, C=1. B and C tied for last. Tiebreak alphabetical → B eliminated.
  // Wait — alphabetical tiebreak: 'B' < 'C', so 'B' is eliminated first.
  // Round 2: A=3, C=2 (B's voter went to A: A=4, C's voter to B which is gone, then to A: A=4? Let me redo)
  // Ballot 1-3: A>B>C → A
  // Ballot 4: B>A>C → B
  // Ballot 5: C>B>A → C
  // R1: A=3, B=1, C=1. Eliminate B (alphabetical).
  // R2: ballot4 (B>A>C) → A. ballot5 (C>B>A) → C. So A=4, C=1. A wins.
  const ballots: string[][] = [];
  for (let i = 0; i < 3; i++) ballots.push(["A", "B", "C"]);
  ballots.push(["B", "A", "C"]);
  ballots.push(["C", "B", "A"]);
  const out = await runWith(`
    return ctx.aggregate('instant_runoff', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

// ─── ctx.aggregate: coombs ────────────────────────────────────────

test("ctx.aggregate coombs: eliminates highest-last-place", async () => {
  // Same ballots — but Coombs eliminates the candidate with the most
  // last-place rankings, not first-place least.
  // R1 last-place counts: ballot 1-3 last=C (3), ballot 4 last=C (1), ballot 5 last=A (1).
  // C has 4 last-place → eliminate C.
  // R2: ballot 1-3 → A=3 (A>B). ballot 4 → B=1 (B>A). ballot 5 → B=1 (B>A).
  // A=3, B=2 → A wins.
  const ballots: string[][] = [];
  for (let i = 0; i < 3; i++) ballots.push(["A", "B", "C"]);
  ballots.push(["B", "A", "C"]);
  ballots.push(["C", "B", "A"]);
  const out = await runWith(`
    return ctx.aggregate('coombs', ${JSON.stringify(ballots)});
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

// ─── ctx.aggregate: score ─────────────────────────────────────────

test("ctx.aggregate score: highest-summed-score wins", async () => {
  const out = await runWith(`
    return ctx.aggregate('score', [
      { A: 9, B: 1, C: 5 },
      { A: 8, B: 2, C: 4 },
      { A: 7, B: 9, C: 3 },
    ]);
  `);
  const r = j(out) as { winner: string };
  assert.equal(r.winner, "A");
});

// ─── ctx.aggregate: approval ──────────────────────────────────────

test("ctx.aggregate approval: most-approved wins", async () => {
  const out = await runWith(`
    return ctx.aggregate('approval', [
      ['A','B'],
      ['A','C'],
      ['A'],
      ['B','C'],
    ]);
  `);
  const r = j(out) as { winner: string; ranking: string[] };
  // A=3, B=2, C=2. A wins. B and C tie → alphabetical: B, C.
  assert.equal(r.winner, "A");
  assert.deepEqual(r.ranking, ["A", "B", "C"]);
});

// ─── ctx.aggregate: error paths ───────────────────────────────────

test("ctx.aggregate: unknown method rejects", async () => {
  await assert.rejects(
    runWith(`return ctx.aggregate('majority', [['A','B']]);`),
    /unknown method/,
  );
});

test("ctx.aggregate: empty ballots returns null winner", async () => {
  const out = await runWith(`return ctx.aggregate('borda', []);`);
  const r = j(out) as { winner: unknown; ranking: unknown[] };
  assert.equal(r.winner, null);
  assert.deepEqual(r.ranking, []);
});

test("ctx.aggregate: rejects non-array ballots", async () => {
  await assert.rejects(
    runWith(`return ctx.aggregate('borda', 'nope');`),
    /ballots must be an array/,
  );
});

test("ctx.aggregate: rejects non-string method", async () => {
  await assert.rejects(
    runWith(`return ctx.aggregate(42, []);`),
    /method must be a string/,
  );
});

// ─── ctx.consensus(method: 'borda') integration ───────────────────

test("ctx.consensus method:borda parses ranked-list responses", async () => {
  const host = stubHost({
    phaseResults: () => [
      mkResult("v1", "Top picks: ```json\n[\"A\",\"B\",\"C\"]\n```"),
      mkResult("v2", '```json\n["A","C","B"]\n```'),
      mkResult("v3", '```json\n["B","A","C"]\n```'),
    ],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "v1" });
      const b = ctx.agent("p", { id: "v2" });
      const c = ctx.agent("p", { id: "v3" });
      return await ctx.consensus([a, b, c], { method: 'borda', threshold: 0.5 });
    `,
    host,
  )) as {
    agreed: boolean;
    majorityText: string;
    ranking: readonly string[];
  };
  // A is top of 2 of 3 ballots → ratio 2/3 ≥ 0.5 → agreed true.
  assert.equal(out.agreed, true);
  assert.equal(out.majorityText, "A");
  assert.deepEqual([...(out.ranking as string[])], ["A", "B", "C"]);
});

test("ctx.consensus method:schulze with malformed responses skips them", async () => {
  const host = stubHost({
    phaseResults: () => [
      mkResult("v1", '```json\n["A","B","C"]\n```'),
      mkResult("v2", "no json here, just prose"),
      mkResult("v3", '```json\n["A","C","B"]\n```'),
    ],
  });
  const out = (await runWith(
    `
      const a = ctx.agent("p", { id: "v1" });
      const b = ctx.agent("p", { id: "v2" });
      const c = ctx.agent("p", { id: "v3" });
      return await ctx.consensus([a, b, c], { method: 'schulze' });
    `,
    host,
  )) as { majorityText: string };
  assert.equal(out.majorityText, "A");
});
