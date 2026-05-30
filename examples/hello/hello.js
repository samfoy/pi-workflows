/// <reference types="@samfp/pi-workflows" />

export const meta = { name: 'hello', description: 'Hello world workflow example', version: '1.0.0' };

/**
 * hello — minimal "hello world" pi workflow.
 *
 * Spawns a single agent that says hello, returns the text.
 * Good starting point for authors building their first workflow.
 */

export default async function main(ctx, input) {
  const name = input?.trim() || "world";
  const [result] = await ctx.phase("greet", [
    ctx.agent(`Say hello to ${name} in one sentence.`, { id: "greeter" }),
  ]);
  return { greeting: result.text };
}
