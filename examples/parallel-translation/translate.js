/// <reference types="@samfp/pi-workflows" />

export const meta = {
  name: "parallel-translation",
  description:
    "Translate text into multiple languages in parallel and use ctx.vote() to pick the best back-translation as a quality check.",
  version: "1.0.0",
  whenToUse:
    "Use as a worked example of ctx.vote(agents, judge) with an LLM-delegated judge. Run `/parallel-translation \"text to translate\"`.",
  phases: [
    { title: "Translate" },
    { title: "Vote (back-translate + judge)" },
  ],
};

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

export async function main(ctx) {
  const input = ctx.input;
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

  // Phase 2 + 3 — back-translate AND judge in a single ctx.vote call.
  //
  // ctx.vote(agents, judge):
  //   - runs the agents in one internal phase (named "vote")
  //   - hands the array of response strings to the judge
  //   - returns { winner: <judge's chosen string>, responses: <ordered strings> }
  //
  // The judge is a Context-realm function. To delegate the choice to an
  // LLM, the judge runs its own ctx.phase with a single judge agent and
  // parses the index out of the reply.
  const backTranslators = translations.map((t, i) =>
    ctx.agent(
      `Translate the following ${LANGUAGES[i]} text back into English. Return only the translation, no commentary.\n\n${t.text}`,
      { id: `back-${i}` },
    ),
  );

  const verdict = await ctx.vote(backTranslators, async (responses) => {
    const numbered = responses.map((r, i) => `[${i}] ${r}`).join("\n\n");
    const [judge] = await ctx.phase("vote-judge", [
      ctx.agent(
        `Original text:\n"${input}"\n\nCandidate back-translations:\n${numbered}\n\nWhich candidate best preserves the original meaning and tone? Reply with ONLY the integer index (0-${responses.length - 1}) — no other text.`,
        { id: "quality-judge" },
      ),
    ]);
    const match = judge.text.trim().match(/\d+/);
    const idx = match ? parseInt(match[0], 10) : 0;
    const safeIdx = Math.max(0, Math.min(responses.length - 1, idx));
    return responses[safeIdx];
  });

  const winnerIdx = verdict.responses.indexOf(verdict.winner);

  return {
    input,
    translations: Object.fromEntries(
      LANGUAGES.map((lang, i) => [lang, translations[i].text]),
    ),
    bestLanguage: LANGUAGES[winnerIdx] ?? "unknown",
    backTranslation: verdict.winner,
  };
}
