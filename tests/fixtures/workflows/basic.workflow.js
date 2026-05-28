/**
 * basic.workflow.js — slice 8a integration fixture.
 *
 * 2-phase workflow:
 *   - phase "p1": one agent (a1)
 *   - phase "p2": two agents (a2 + a3) parallel
 *
 * Returns an array of agent texts so the integration test can assert
 * order matches input.
 */

const a1 = ctx.agent("audit phase 1", { id: "a1" });
const phase1 = await ctx.phase("p1", [a1]);

const a2 = ctx.agent("scout module x", { id: "a2" });
const a3 = ctx.agent("scout module y", { id: "a3" });
const phase2 = await ctx.phase("p2", [a2, a3]);

ctx.log("workflow basic.workflow.js completed", { level: "info" });

return {
  phase1: phase1.map((r) => r.text),
  phase2: phase2.map((r) => r.text),
  cached: phase2.map((r) => r.cached),
};
