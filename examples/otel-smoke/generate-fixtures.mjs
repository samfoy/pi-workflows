#!/usr/bin/env node
/**
 * Regenerate fixtures.jsonl from the prompts in sample.workflow.js.
 *
 * Run after editing the sample workflow's agent prompts:
 *
 *   node generate-fixtures.mjs > fixtures.jsonl
 *
 * The dispatcher's mock branch keys on (agentId, sha256(prompt)) — so
 * every static prompt change requires a new hash.
 */
import { createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Keep this in sync with sample.workflow.js. Each tuple is
// [agentId, prompt, mockResultText].
const fixtures = [
  ["greet-en", "Say hello in English.", "Hello!"],
  ["greet-fr", "Say hello in French.", "Bonjour!"],
  ["summarize-1", "Summarize: hello world.", "A two-word English greeting."],
  ["summarize-2", "Summarize: bonjour monde.", "A two-word French greeting."],
];

for (const [id, prompt, text] of fixtures) {
  const usage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16 };
  const fixture = {
    agentId: id,
    promptHash: sha256(prompt),
    result: { text, usage, durationMs: 150 },
  };
  process.stdout.write(JSON.stringify(fixture) + "\n");
}
