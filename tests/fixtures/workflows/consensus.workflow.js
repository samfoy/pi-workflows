/**
 * consensus.workflow.js — slice 8b ctx.consensus integration fixture.
 *
 * Three agents return text where two of three responses share a high
 * Jaccard token overlap. Default threshold (0.6) → agreed: true with
 * the high-overlap response selected as majorityText.
 */

const a = ctx.agent("describe", { id: "a" });
const b = ctx.agent("describe", { id: "b" });
const c = ctx.agent("describe", { id: "c" });

const result = await ctx.consensus([a, b, c]);
return {
  agreed: result.agreed,
  majorityText: result.majorityText,
  responses: result.responses,
};
