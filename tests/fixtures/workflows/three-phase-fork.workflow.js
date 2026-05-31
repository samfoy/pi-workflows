/**
 * three-phase-fork.workflow.js — ZONE_TIMETRAVEL fixture.
 *
 * Three sequential phases (p1 → p2 → p3). Phase 2's prompt is
 * read from `ctx.cache.get('__fork_overrides__')` when present so
 * a forked run can vary its post-fork behavior without editing the
 * workflow source.
 *
 * Returns each phase's text + cached flag so the test can assert
 * (a) phase-1 cache reuse and (b) phase-2 sees the override prompt.
 */

const overrides = await ctx.cache.get('__fork_overrides__');

const a1 = ctx.agent("phase 1 default prompt", { id: "a1" });
const phase1 = await ctx.phase("p1", [a1]);

const phase2Prompt =
  overrides && typeof overrides === 'object' && typeof overrides.phase2Prompt === 'string'
    ? overrides.phase2Prompt
    : "phase 2 default prompt";
const a2 = ctx.agent(phase2Prompt, { id: "a2" });
const phase2 = await ctx.phase("p2", [a2]);

const a3 = ctx.agent("phase 3 default prompt", { id: "a3" });
const phase3 = await ctx.phase("p3", [a3]);

return {
  phase1: phase1.map((r) => ({ text: r.text, cached: r.cached === true })),
  phase2: phase2.map((r) => ({ text: r.text, cached: r.cached === true })),
  phase3: phase3.map((r) => ({ text: r.text, cached: r.cached === true })),
  phase2Prompt,
};
