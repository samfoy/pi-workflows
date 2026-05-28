/**
 * parallel.workflow.js — slice 8b ctx.parallel integration fixture.
 *
 * Maps two items into a SINGLE phase. The mapping fn returns a
 * one-or-many handle (item "M" returns an array of two handles to
 * exercise the flattening branch). Phase name override via
 * opts.phaseName.
 */

const items = ["S", "M"];
const results = await ctx.parallel(
  items,
  (item) => {
    if (item === "M") {
      return [
        ctx.agent("scout module x", { id: "mx" }),
        ctx.agent("scout module y", { id: "my" }),
      ];
    }
    return ctx.agent("solo " + item, { id: "solo-" + item.toLowerCase() });
  },
  { phaseName: "fanout" },
);

return {
  count: results.length,
  texts: results.map((r) => r.text),
  ids: results.map((r) => r.agentId),
};
