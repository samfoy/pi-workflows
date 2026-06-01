/**
 * tests/integration/parallelTranslationExample.test.ts
 *
 * Roundtrip test for the bundled `examples/parallel-translation/translate.js`
 * example using `runWorkflow({ mockAgents: true })`. Locks in the corrected
 * `ctx.vote(agents, judge)` shape so future edits don't regress to the
 * pre-fix `ctx.vote(plainObjects, opts)` form that threw at runtime.
 *
 * The example fans out 4 translators in parallel, runs the back-translators
 * inside `ctx.vote` (the vote phase), and the judge function delegates to a
 * fifth `quality-judge` agent that picks an index. We seed deterministic
 * fixtures for all 9 agent calls and assert the output shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { runWorkflow } from "../../src/testing.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TRANSLATE_WORKFLOW = join(
  PKG_ROOT,
  "examples/parallel-translation/translate.js",
);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const LANGUAGES = ["French", "German", "Spanish", "Japanese"];
const INPUT = "Hello world";

// Translation outputs the fixtures will return per language.
const TRANSLATIONS: Record<string, string> = {
  French: "Bonjour le monde",
  German: "Hallo Welt",
  Spanish: "Hola mundo",
  Japanese: "konnichiwa sekai",
};

// Back-translation outputs (all the same — judge picks by index).
const BACK_TRANSLATIONS = [
  "Hello world",
  "Hello, world.",
  "Hi world",
  "Hello, world!",
];

// Judge picks index 1 → German wins.
const WINNER_INDEX = 1;

function fixture(
  agentId: string,
  promptHash: string,
  text: string,
): string {
  return JSON.stringify({
    agentId,
    promptHash,
    result: {
      text,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      },
    },
  });
}

function buildFixtures(): string {
  const lines: string[] = [];

  // Translator agents (4).
  LANGUAGES.forEach((lang, i) => {
    const prompt =
      `Translate the following text into ${lang}. ` +
      `Return only the translation, no commentary.\n\n${INPUT}`;
    lines.push(fixture(`translate-${i}`, sha256(prompt), TRANSLATIONS[lang]!));
  });

  // Back-translator agents (4) — run inside ctx.vote's vote phase.
  LANGUAGES.forEach((lang, i) => {
    const prompt =
      `Translate the following ${lang} text back into English. ` +
      `Return only the translation, no commentary.\n\n${TRANSLATIONS[lang]}`;
    lines.push(fixture(`back-${i}`, sha256(prompt), BACK_TRANSLATIONS[i]!));
  });

  // Judge agent (1) — delegated from inside the ctx.vote callback.
  const numbered = BACK_TRANSLATIONS.map((r, i) => `[${i}] ${r}`).join("\n\n");
  const judgePrompt =
    `Original text:\n"${INPUT}"\n\n` +
    `Candidate back-translations:\n${numbered}\n\n` +
    `Which candidate best preserves the original meaning and tone? ` +
    `Reply with ONLY the integer index (0-${BACK_TRANSLATIONS.length - 1}) ` +
    `— no other text.`;
  lines.push(fixture("quality-judge", sha256(judgePrompt), String(WINNER_INDEX)));

  return lines.join("\n") + "\n";
}

test(
  "examples/parallel-translation: roundtrip with mock agents (locks in ctx.vote API shape)",
  { timeout: 60_000 },
  async () => {
    const result = await runWorkflow({
      workflowPath: TRANSLATE_WORKFLOW,
      input: INPUT,
      mockAgents: true,
      seedFixturesJsonl: buildFixtures(),
    });

    assert.equal(
      result.status,
      "done",
      `expected status=done, got ${result.status}: ${JSON.stringify(result.error)}`,
    );
    assert.ok(result.output !== null, "expected non-null output");

    const out = result.output as {
      input: string;
      translations: Record<string, string>;
      bestLanguage: string;
      backTranslation: string;
    };

    assert.equal(out.input, INPUT);
    assert.deepEqual(out.translations, TRANSLATIONS);
    assert.equal(
      out.bestLanguage,
      LANGUAGES[WINNER_INDEX],
      "judge picked index 1 → German wins",
    );
    assert.equal(out.backTranslation, BACK_TRANSLATIONS[WINNER_INDEX]);
  },
);
