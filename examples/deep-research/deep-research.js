/// <reference types="@samfp/pi-workflows" />

export const meta = {
  name: "deep-research",
  description: "Multi-angle deep research on any question, with cross-checking and a polished Markdown report.",
  version: "1.0.0",
  whenToUse: "Use when you want thorough, cited research on a topic — fans out across 4–6 angles, cross-checks uncertain claims, and returns an executive summary with inline citations and a Limitations section.",
  phases: [
    { title: "Decompose" },
    { title: "Research" },
    { title: "Cross-check" },
    { title: "Synthesize" },
  ],
};

/**
 * /deep-research — phased research on any question.
 *
 * Phases:
 *   1. decompose   — 1 agent breaks the question into 4–6 focused angles.
 *   2. research    — N agents in parallel (one per angle) using web_search
 *                    and fetch_content; returns claims + summary per angle.
 *   3. cross-check — 1 agent verifies medium/low-confidence claims (skipped
 *                    when all claims are high-confidence).
 *   4. synthesize  — 1 agent writes a Markdown report with executive summary,
 *                    key findings, inline citations, and a Limitations section.
 *
 * Usage:
 *   /deep-research                                   — default question
 *   /deep-research What is the state of fusion power?
 *
 * Returns: { question, anglesResearched, report }
 */
export default async function main(ctx, input) {
  const question =
    typeof input === "string" && input.trim()
      ? input.trim()
      : "What are the key developments in AI agents in 2026?";

  // ─── Robust JSON extractor ─────────────────────────────────────────────────
  //
  // Agents frequently wrap JSON in markdown fences or add prose before/after.
  // Scans for the outermost balanced JSON structure using depth-tracking.
  // Uses char codes to avoid literal { } in string literals — the sandbox's
  // brace-walker is a simple counter that doesn't track strings.
  //
  // Char code reference: 123={ 125=} 91=[ 93=] 92=\ 34="
  function extractJsonFromText(text) {
    if (typeof text !== "string") return null;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 123 || c === 91) { start = i; break; }
    }
    if (start === -1) return null;
    const openerCode = text.charCodeAt(start);
    const closerCode = openerCode === 123 ? 125 : 93;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (escape) { escape = false; continue; }
      if (c === 92 && inString) { escape = true; continue; }
      if (c === 34) { inString = !inString; continue; }
      if (inString) continue;
      if (c === openerCode) depth++;
      else if (c === closerCode) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  ctx.log(`deep-research starting: "${question}"`);

  // ── Phase 1: decompose ──────────────────────────────────────────────────────
  const decomposeSchema = {
    type: "object",
    properties: {
      angles: {
        type: "array",
        minItems: 4,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            query: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["id", "title", "query", "rationale"],
        },
      },
    },
    required: ["angles"],
  };

  const [decomposed] = await ctx.phase("decompose", [
    ctx.agent(
      `Break the following research question into 4–6 focused, non-overlapping research angles.
Each angle should target a distinct facet: e.g. current state, history, key players, technical details, challenges, future outlook, or policy/societal impact.

Research question: "${question}"

Return ONLY a JSON object (no markdown fences, no prose). Shape:
[
  [id: short kebab-case string (e.g. "current-state")],
  [title: descriptive title (e.g. "Current State of the Field")],
  [query: focused web-search query for this angle],
  [rationale: one sentence explaining what this angle contributes]
]

Wrapped as: {"angles": [...]}

Aim for exactly 5 angles that meaningfully differ from each other.`,
      { id: "decompose", schema: decomposeSchema },
    ),
  ]);

  // Prefer schema-parsed output; fall back to text extraction.
  let angles = decomposed.output && Array.isArray(decomposed.output.angles)
    ? decomposed.output.angles
    : null;

  if (!angles) {
    const parsed = extractJsonFromText(decomposed.text);
    angles = parsed && Array.isArray(parsed.angles)
      ? parsed.angles
      : Array.isArray(parsed)
        ? parsed
        : null;
  }

  if (!Array.isArray(angles) || angles.length === 0) {
    throw new Error("decompose agent did not return a parseable angles array");
  }
  ctx.log(`decompose: ${angles.length} research angles identified`);

  // ── Phase 2: research (parallel, failMode: null) ────────────────────────────
  const angleResultSchema = {
    type: "object",
    properties: {
      angleId: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            sources: { type: "array", items: { type: "string" } },
          },
          required: ["claim", "confidence", "sources"],
        },
      },
    },
    required: ["angleId", "title", "summary", "claims"],
  };

  const researchHandles = angles.map((angle) =>
    ctx.agent(
      `You are a research agent investigating one angle of a larger question.

Overall question: "${question}"
Your angle: "${angle.title}"
Search query: ${angle.query}
Rationale: ${angle.rationale}

Steps:
1. Use web_search to find recent, authoritative sources on this specific angle.
2. Use fetch_content on the 2–3 most relevant URLs to read the full content.
3. Extract 3–6 concrete, specific claims from your findings.

For each claim, assign a confidence level:
- "high"   — multiple independent sources agree, content is recent and authoritative
- "medium" — found in 1–2 sources, or source quality is uncertain
- "low"    — single source, speculative, or hard to verify independently

Return ONLY a JSON object (no markdown fences). Shape:
{
  "angleId": "${angle.id}",
  "title": "${angle.title}",
  "summary": "2–3 sentence summary of what you found for this angle",
  "claims": [
    {
      "claim": "specific factual claim, as precise as possible",
      "confidence": "high|medium|low",
      "sources": ["URL or publication name"]
    }
  ]
}`,
      { id: `research-${angle.id}`, schema: angleResultSchema },
    ),
  );

  const rawResearchResults = await ctx.phase("research", researchHandles, { failMode: "null" });
  const researchResults = rawResearchResults.filter((r) => r !== null);
  ctx.log(`research: ${researchResults.length}/${angles.length} angles completed`);

  if (researchResults.length === 0) {
    throw new Error("all research agents failed — cannot synthesize a report");
  }

  // Collect structured data and flag uncertain claims.
  const angleData = [];
  const uncertainClaims = [];

  for (const r of researchResults) {
    let data = r.output && typeof r.output === "object" ? r.output : null;
    if (!data) {
      const parsed = extractJsonFromText(r.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
      }
    }
    if (data) {
      angleData.push(data);
      if (Array.isArray(data.claims)) {
        for (const claim of data.claims) {
          if (claim.confidence === "medium" || claim.confidence === "low") {
            uncertainClaims.push({
              claim: claim.claim,
              confidence: claim.confidence,
              sources: claim.sources,
              angle: data.title,
            });
          }
        }
      }
    }
  }

  // ── Phase 3: cross-check (conditional) ─────────────────────────────────────
  let crossCheckNotes = "";

  if (uncertainClaims.length > 0) {
    ctx.log(`cross-check: verifying ${uncertainClaims.length} medium/low-confidence claims`);
    const claimsJson = JSON.stringify(uncertainClaims, null, 2);
    const [crossCheck] = await ctx.phase("cross-check", [
      ctx.agent(
        `Cross-check the following uncertain research claims about: "${question}"

These claims were flagged as medium or low confidence during the research phase.
For each claim: search for additional evidence, then write a verdict.

Claims to verify:
${claimsJson}

Return a plain-text report (no JSON). Use this format:

## Cross-Check Report

For each claim, write a block:

**Claim**: [the claim]
**Original confidence**: medium/low
**Verdict**: supported | contradicted | unverifiable
**Notes**: [1–2 sentences on what you found]`,
        { id: "cross-check" },
      ),
    ]);
    crossCheckNotes = crossCheck.text;
  } else {
    ctx.log("cross-check: all claims are high-confidence, skipping");
  }

  // ── Phase 4: synthesize ─────────────────────────────────────────────────────
  ctx.log("synthesize: writing final report");

  const anglesSummary = angleData
    .map(
      (d) =>
        `### ${d.title}\n\n${d.summary}\n\n**Claims:**\n` +
        (d.claims || [])
          .map(
            (c) =>
              `- [${String(c.confidence).toUpperCase()}] ${c.claim}` +
              (c.sources && c.sources.length > 0
                ? ` _(Source: ${c.sources.join(", ")})_`
                : ""),
          )
          .join("\n"),
    )
    .join("\n\n---\n\n");

  const crossCheckBlock = crossCheckNotes
    ? `\n\n## Cross-Check Results\n\n${crossCheckNotes}`
    : "";

  const [synthesized] = await ctx.phase("synthesize", [
    ctx.agent(
      `Write a comprehensive research report that answers: "${question}"

You have research findings from ${angleData.length} angles:

${anglesSummary}${crossCheckBlock}

Write a polished Markdown report with these sections:

1. **Executive Summary** — 3–5 sentences capturing the most important answer
2. **Key Findings** — organized by theme or angle, with inline citations as _(Source: ...)_
3. **Limitations** — gaps in coverage, low-confidence findings, what the research couldn't determine

Style guidelines:
- Use concrete specifics, not vague generalities
- Cite sources inline (Source: URL or publication name)
- Use ## and ### headers for clear structure
- Be honest about uncertainty — explicitly flag anything low-confidence
- Target ~600–900 words total
- Do NOT include a JSON block — write clean prose Markdown only`,
      { id: "synthesize" },
    ),
  ]);

  return {
    question,
    anglesResearched: researchResults.length,
    report: synthesized.text,
  };
}
