/// <reference types="@samfp/pi-workflows" />

/**
 * parallel-translation — translate text into multiple languages in parallel,
 * then use ctx.vote() to pick the best English back-translation as a
 * quality check.
 *
 * Demonstrates: parallel agents, ctx.vote() stdlib helper, ctx.log.
 *
 * Usage: /parallel-translation "text to translate"
 */

const LANGUAGES = ["French", "German", "Spanish", "Japanese"];

export default async function main(ctx, input) {
  if (!input?.trim()) {
    throw new Error("Usage: /parallel-translation <text>");
  }

  ctx.log(`Translating into ${LANGUAGES.length} languages in parallel`);

  // Phase 1: translate into all target languages in parallel.
  const translators = LANGUAGES.map((lang, i) =>
    ctx.agent(
      `Translate the following text into ${lang}. Return only the translation, no commentary.\n\n${input}`,
      { id: `translate-${i}`, cacheKeyExtra: { lang, input } },
    ),
  );
  const translations = await ctx.phase("translate", translators);

  // Phase 2: back-translate each result to English for quality check.
  const backTranslators = translations.map((t, i) =>
    ctx.agent(
      `Translate the following ${LANGUAGES[i]} text back into English. Return only the translation.\n\n${t.text}`,
      { id: `back-${i}` },
    ),
  );
  const backTranslations = await ctx.phase("back-translate", backTranslators);

  // Phase 3: use ctx.vote() to pick the back-translation closest to the original.
  // This is the canonical ctx.vote() usage: single-winner selection from N candidates.
  const winner = await ctx.vote(
    backTranslations.map((b, i) => ({
      id: `back-${i}`,
      text: b.text,
    })),
    {
      prompt: `Original text: "${input}"\n\nWhich back-translation best preserves the original meaning and tone?`,
      judgeId: "quality-judge",
    },
  );

  const winnerIdx = translations.findIndex((_, i) => `back-${i}` === winner.id);

  return {
    input,
    translations: Object.fromEntries(
      LANGUAGES.map((lang, i) => [lang, translations[i].text]),
    ),
    bestLanguage: LANGUAGES[winnerIdx] ?? "unknown",
    backTranslation: winner.text,
  };
}
