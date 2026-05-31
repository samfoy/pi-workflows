/// <reference types="@samfp/pi-workflows" />

/**
 * sample workflow for the OTel smoke test recipe.
 *
 * Two phases × two agents = four mock-agent dispatches. Designed to
 * produce a recognizable trace tree in Jaeger:
 *
 *   invoke_workflow otel-smoke
 *   ├── phase greet
 *   │   ├── invoke_agent greet-en
 *   │   └── invoke_agent greet-fr
 *   └── phase summarize
 *       ├── invoke_agent summarize-1
 *       └── invoke_agent summarize-2
 *
 * Run with mock fixtures (no API tokens) — see the README in this
 * directory for full setup. The agent prompts here are static so the
 * SHA-256 prompt hashes baked into `fixtures.jsonl` match.
 */

export const meta = {
  name: "otel-smoke",
  description: "OTel smoke test — emits a recognizable trace tree",
  version: "1.0.0",
};

export default async function main(ctx) {
  ctx.log("starting otel-smoke workflow");

  const greetings = await ctx.phase("greet", [
    ctx.agent("Say hello in English.", { id: "greet-en" }),
    ctx.agent("Say hello in French.", { id: "greet-fr" }),
  ]);

  ctx.log(`got ${greetings.length} greetings`);

  const summaries = await ctx.phase("summarize", [
    ctx.agent("Summarize: hello world.", { id: "summarize-1" }),
    ctx.agent("Summarize: bonjour monde.", { id: "summarize-2" }),
  ]);

  ctx.log("workflow done");

  return {
    greetings: greetings.map((g) => g.text),
    summaries: summaries.map((s) => s.text),
  };
}
