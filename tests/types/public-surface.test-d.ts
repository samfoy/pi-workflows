/**
 * tests/types/public-surface.test-d.ts
 *
 * Type-level fixture exercising every declaration synced into
 * `src/types/public.d.ts` so a type-only commit is verifiable. This
 * file is type-checked by `npm run typecheck` (tsconfig.json includes
 * `tests/**\/*`) but is NOT picked up by the runtime test runner —
 * `package.json scripts.test` globs `tests/unit/*.test.ts`,
 * `tests/integration/*.test.ts`, `tests/security/*.test.ts`. The
 * `.test-d.ts` suffix is the standard "type-test fixture" convention
 * (used by tsd, expect-type, etc.).
 *
 * If any declaration in `public.d.ts` is missing or wrong-shaped,
 * `tsc --noEmit` will fail in CI.
 *
 * Coverage map (each row corresponds to a sub-task in the slice):
 *
 *   ctx.extractJSON(text)                    → expectType<unknown>
 *   ctx.aggregate(method, ballots, opts?)    → AggregateResult shape
 *   ctx.critique({...})                      → CritiqueResult shape
 *   ctx.memory.read / append / compact       → MemoryCompactResult shape
 *   ctx.interrupt({...} | string)            → InterruptResult shape
 *   ctx.promote(agentId, {strategy, target?}) → PromoteResult shape
 *   ctx.report({format:'mermaid'})           → string overload
 *   ctx.report(eventType, data?)             → void overload
 *   AgentOpts.memory                         → 4 valid shapes + invalid
 *   AgentOpts.isolation                      → 'worktree' | 'none'
 *   AgentOpts.bindToWorkflowVersion          → boolean
 *   Top-level: WorkflowClient,
 *              forkFromCheckpoint,
 *              ForkRunNotFoundError,
 *              ForkPhaseNotFoundError,
 *              FORK_OVERRIDES_KEY            → import-and-use round-trip
 */

import type {
  AgentOpts,
  AggregateMethod,
  AggregateResult,
  CritiqueOpts,
  CritiqueResult,
  InterruptOpts,
  InterruptResult,
  IsolationMode,
  MemoryCompactResult,
  MemoryScope,
  PromoteOpts,
  PromoteResult,
  WorkflowMain,
} from "../../src/types/public.js";

// Top-level value imports — round-trip the runtime exports the task
// contract requires. If any of these is missing from src/index.ts the
// import line itself fails to type-check.
import {
  FORK_OVERRIDES_KEY,
  ForkPhaseNotFoundError,
  ForkRunNotFoundError,
  WorkflowClient,
  forkFromCheckpoint,
} from "../../src/index.js";

// ─── helpers ──────────────────────────────────────────────────────

/** Identity that constrains its argument to `T`. Cheap structural assert. */
function expectType<T>(_value: T): void {}

/** Strictly checks that two types are structurally identical. */
type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;

/** Compile-time `true` assertion. */
type AssertTrue<T extends true> = T;

// ─── Indexed-access shape asserts ─────────────────────────────────
//
// AgentOpts has a `[extra: string]: unknown` index signature so that
// authors can pass arbitrary fields. That index signature ALSO
// silently absorbs typos at use-sites (`memory: 'globl'` would be
// accepted as the index signature `unknown`). To actually verify the
// named-field types, we extract them by indexed access — the named
// property type takes precedence over the index signature for known
// keys — and pin them with `IsExact`.

type _MemoryFieldExact = AssertTrue<
  IsExact<
    AgentOpts["memory"],
    | MemoryScope
    | false
    | { readonly scope: MemoryScope; readonly readOnly?: boolean }
    | undefined
  >
>;
const _memoryFieldExact: _MemoryFieldExact = true;
void _memoryFieldExact;

type _IsolationFieldExact = AssertTrue<
  IsExact<AgentOpts["isolation"], IsolationMode | undefined>
>;
const _isolationFieldExact: _IsolationFieldExact = true;
void _isolationFieldExact;

type _BtvFieldExact = AssertTrue<
  IsExact<AgentOpts["bindToWorkflowVersion"], boolean | undefined>
>;
const _btvFieldExact: _BtvFieldExact = true;
void _btvFieldExact;

// ─── ctx surface — exercised through a WorkflowMain ───────────────

const _wf: WorkflowMain = async (ctx, input) => {
  expectType<string>(input);

  // 1. ctx.extractJSON ------------------------------------------------
  const parsed: unknown = ctx.extractJSON("```json\n[1, 2, 3]\n```");
  expectType<unknown>(parsed);

  // 2. ctx.aggregate --------------------------------------------------
  // Default candidate type is `string`.
  const aggBorda: AggregateResult<string> = ctx.aggregate("borda", [
    ["a", "b", "c"],
    ["b", "c", "a"],
  ]);
  expectType<string>(aggBorda.winner);
  expectType<ReadonlyArray<string>>(aggBorda.ranking);
  // scores is OPTIONAL — narrow before use.
  if (aggBorda.scores !== undefined) {
    expectType<Readonly<Record<string, number>>>(aggBorda.scores);
  }
  // Custom candidate type — generic argument forwards.
  const aggNum = ctx.aggregate<number>("score", [{ 1: 0.9, 2: 0.1 }]);
  expectType<number>(aggNum.winner);
  expectType<ReadonlyArray<number>>(aggNum.ranking);

  // Method enum is exhaustive.
  const _methods: AggregateMethod[] = [
    "borda",
    "schulze",
    "ranked_pairs",
    "kemeny_young",
    "instant_runoff",
    "coombs",
    "score",
    "approval",
  ];
  void _methods;

  // 3. ctx.critique ---------------------------------------------------
  const critOpts: CritiqueOpts<string, { issue: string }> = {
    producer: async (last, round) => {
      expectType<{ issue: string } | null>(last);
      expectType<number>(round);
      return "draft v" + round;
    },
    critic: async (output, round) => {
      expectType<string>(output);
      expectType<number>(round);
      return { issue: "needs more depth" };
    },
    accept: (cri, out) => {
      expectType<{ issue: string }>(cri);
      expectType<string>(out);
      return false;
    },
    maxRounds: 3,
  };
  const critRes: CritiqueResult<string, { issue: string }> = await ctx.critique(critOpts);
  expectType<boolean>(critRes.accepted);
  expectType<string | null>(critRes.output);
  expectType<{ issue: string } | null>(critRes.critique);
  expectType<number>(critRes.rounds);
  expectType<
    ReadonlyArray<{ readonly output: string; readonly critique: { issue: string } }>
  >(critRes.history);

  // 4. ctx.memory.{read, append, compact} -----------------------------
  const memContent = await ctx.memory.read("planner", "user");
  expectType<string | null>(memContent);
  await ctx.memory.append("planner", "user", "- new note\n");
  const memStats: MemoryCompactResult = await ctx.memory.compact("planner", "project");
  expectType<number>(memStats.beforeBytes);
  expectType<number>(memStats.afterBytes);
  expectType<number>(memStats.ratio);

  // MemoryScope enum is exhaustive.
  const _scopes: MemoryScope[] = ["user", "project", "local"];
  void _scopes;

  // 5. ctx.interrupt --------------------------------------------------
  // Object form — every field optional except `question`.
  const intRes1: InterruptResult = await ctx.interrupt({
    question: "Pick a region",
    choices: ["us-east", "us-west"],
    default: "us-east",
    schema: { type: "string" },
  });
  expectType<string>(intRes1.key);
  expectType<unknown>(intRes1.value);
  // String shorthand form.
  const intRes2 = await ctx.interrupt("Add a release note?");
  expectType<string>(intRes2.key);
  expectType<unknown>(intRes2.value);
  // Generic typed value (typed cast at use-site is the documented pattern).
  const intRes3 = await ctx.interrupt<{ ok: boolean }>({
    question: "Settings?",
    schema: { type: "object" },
  });
  expectType<{ ok: boolean }>(intRes3.value);

  // Bare InterruptOpts type-check.
  const _intOpts: InterruptOpts = { question: "ok?" };
  void _intOpts;

  // 6. ctx.promote ----------------------------------------------------
  const promoApply: PromoteResult = await ctx.promote("recon-1");
  expectType<"apply" | "rebase">(promoApply.strategy);
  expectType<boolean>(promoApply.applied);
  expectType<ReadonlyArray<string>>(promoApply.files);
  await ctx.promote("recon-1", { strategy: "apply" });
  await ctx.promote("recon-1", { strategy: "rebase", target: "origin/main" });
  const _promoOpts: PromoteOpts = { strategy: "rebase", target: "HEAD" };
  void _promoOpts;

  // 7. ctx.report — overloaded ---------------------------------------
  // Format-accessor form returns string.
  const mmd: string = ctx.report({ format: "mermaid" });
  expectType<string>(mmd);
  // Event-emit form returns void.
  const reportVoid: void = ctx.report("milestone", { phase: "x" });
  expectType<void>(reportVoid);
  ctx.report("milestone-no-data");

  // 8. AgentOpts.memory -----------------------------------------------
  const optsMemUser: AgentOpts = { memory: "user" };
  const optsMemProj: AgentOpts = { memory: "project" };
  const optsMemLocal: AgentOpts = { memory: "local" };
  const optsMemFalse: AgentOpts = { memory: false };
  const optsMemRO: AgentOpts = { memory: { scope: "user", readOnly: true } };
  const optsMemBare: AgentOpts = { memory: { scope: "local" } };
  void [optsMemUser, optsMemProj, optsMemLocal, optsMemFalse, optsMemRO, optsMemBare];

  // 9. AgentOpts.isolation -------------------------------------------
  const optsIsoWt: AgentOpts = { isolation: "worktree" };
  const optsIsoNone: AgentOpts = { isolation: "none" };
  const _isoMode: IsolationMode = "worktree";
  void [optsIsoWt, optsIsoNone, _isoMode];

  // 10. AgentOpts.bindToWorkflowVersion ------------------------------
  const optsBtv: AgentOpts = { bindToWorkflowVersion: false };
  void optsBtv;

  // 11. Construct an agent handle exercising every new opt at once ---
  ctx.agent("recon", {
    id: "recon-1",
    memory: { scope: "user", readOnly: true },
    isolation: "worktree",
    bindToWorkflowVersion: false,
  });

  return { ok: true };
};
void _wf;

// ─── Top-level export round-trip ──────────────────────────────────

// Constant value matches the documented sentinel.
type AssertForkOverridesKey = AssertTrue<
  IsExact<typeof FORK_OVERRIDES_KEY, "__fork_overrides__">
>;
const _forkKey: AssertForkOverridesKey = true;
void _forkKey;
expectType<"__fork_overrides__">(FORK_OVERRIDES_KEY);

// Class constructor + instance type.
const _client: WorkflowClient = new WorkflowClient();
void _client;

// Error classes — must extend Error.
type AssertForkRunIsError = AssertTrue<
  ForkRunNotFoundError extends Error ? true : false
>;
type AssertForkPhaseIsError = AssertTrue<
  ForkPhaseNotFoundError extends Error ? true : false
>;
const _ferr1: AssertForkRunIsError = true;
const _ferr2: AssertForkPhaseIsError = true;
void [_ferr1, _ferr2];

// `forkFromCheckpoint` is a function value.
expectType<(...args: never[]) => unknown>(
  forkFromCheckpoint as unknown as (...args: never[]) => unknown,
);

// Negative checks — these MUST fail to type-check; the
// `@ts-expect-error` directive flips the assertion so a regression
// (i.e. types accidentally widen to `any`) is caught.

// AgentOpts.memory rejects unknown scope strings.
// @ts-expect-error — 'global' is not a MemoryScope.
const _badMem: AgentOpts = { memory: "global" };
void _badMem;

// AgentOpts.isolation rejects unknown modes.
// @ts-expect-error — 'docker' is not an IsolationMode.
const _badIso: AgentOpts = { isolation: "docker" };
void _badIso;

// ctx.report({format:'mermaid'}) returns string, NOT void.
async function _reportOverloadCheck(
  ctx: Parameters<WorkflowMain>[0],
): Promise<void> {
  // @ts-expect-error — string is not assignable to void here.
  const _v: void = ctx.report({ format: "mermaid" });
  void _v;
}
void _reportOverloadCheck;
