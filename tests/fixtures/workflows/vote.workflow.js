/**
 * vote.workflow.js — slice 8b ctx.vote integration fixture.
 *
 * Runs three candidate agents under a single phase and uses a sync
 * judge to pick the longest response. Returns the helper's
 * `{ winner, responses }` shape.
 */

const a = ctx.agent("draft A", { id: "a" });
const b = ctx.agent("draft B", { id: "b" });
const c = ctx.agent("draft C", { id: "c" });

// Synchronous judge — picks the longest response (deterministic).
function judge(responses) {
  let best = responses[0];
  for (let i = 1; i < responses.length; i++) {
    if (responses[i].length > best.length) best = responses[i];
  }
  return best;
}

const result = await ctx.vote([a, b, c], judge);
return result;
