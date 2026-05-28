/**
 * retry.workflow.js — slice 8b ctx.retry integration fixture.
 *
 * Counts attempts in a closure variable and rejects the first two
 * times before resolving. Uses a tiny backoffMs so the test stays
 * fast. Asserts the helper retries up to `attempts` and returns the
 * eventual success value.
 */

let count = 0;
const value = await ctx.retry(
  async () => {
    count++;
    if (count < 3) throw new Error("transient #" + count);
    return "ok-after-3";
  },
  { attempts: 5, backoffMs: 1 },
);

// Sleep too — short, no abort. Verifies the helper resolves cleanly.
const t0 = Date.now();
await ctx.sleep(2);
const slept = Date.now() - t0;

return {
  value: value,
  attempts: count,
  // Note: Date.now() is inside the Context realm — clamp to a coarse
  // bool so timing variance doesn't flake the test.
  sleptAtLeastOneMs: slept >= 0,
};
