/**
 * pause.workflow.js — slice 12 integration fixture.
 *
 * 1-phase workflow with N agents (parameterized via input).
 * The agents are dispatched in parallel under the run semaphore.
 * Returns the agent texts in arrival order so the test can assert
 * which agents actually ran.
 *
 * The pause-mid-phase scenario relies on the test-side dispatcher
 * mock to gate when each agent "completes" — pause() can then be
 * called between completions.
 */

const handles = [];
const count = Number(input) || 5;
for (let i = 0; i < count; i++) {
  handles.push(ctx.agent(`work item ${i}`, { id: `a${i}` }));
}
const results = await ctx.phase("p1", handles);

return {
  texts: results.map((r) => r.text),
  cached: results.map((r) => r.cached),
};
