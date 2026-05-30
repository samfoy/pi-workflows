/// <reference types="@samfp/pi-workflows" />

export const meta = { name: 'codebase-audit', description: 'Audit a codebase for issues', version: '1.0.0' };

/**
 * /codebase-audit — phased audit of the current repo.
 *
 * Phases:
 *   1. recon    — 1 agent identifies module/area boundaries.
 *   2. analyze  — N agents in parallel (one per area) audit each area.
 *   3. vote     — 3 judges rank-order all findings via a Borda count.
 *   4. summarize — 1 agent writes the final report.
 *
 * Usage:
 *   /codebase-audit              — audit cwd
 *   /codebase-audit ./src        — audit specific subtree
 *
 * Returns: { runId, cwd, findingsConsidered, top10, report }
 *
 * This script is the canonical pi-workflows reference implementation.
 * It demonstrates: ctx.phase, ctx.agent, ctx.cache, ctx.log,
 * cacheKeyExtra, inheritSkills, and multi-phase fan-out + aggregation.
 */

export default async function main(ctx, input) {
  // ─── BUG-W01 fix: robust JSON extractor ────────────────────────────────────
  //
  // Agents frequently wrap JSON in markdown fences or add prose before/after
  // the JSON block. A simple .match() regex fails when agents emit preamble
  // like "Here are the areas:" — the match may anchor on a partial nested array
  // or miss the outer array entirely.
  //
  // Fix: scan for the first opening brace/bracket, then track depth to extract
  // the outermost balanced JSON structure. Uses char codes throughout to avoid
  // literal { } in string literals — the sandbox's shape-B brace-walker is a
  // simple counter that doesn't track strings, so brace literals in strings
  // would corrupt its depth count and cause "braces unbalanced" errors.
  //
  // Char code reference: 123={ 125=} 91=[ 93=] 92=\ 34="
  function extractJsonFromText(text) {
    if (typeof text !== 'string') return null;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 123 || c === 91) { start = i; break; } // { or [
    }
    if (start === -1) return null;
    const openerCode = text.charCodeAt(start);
    const closerCode = openerCode === 123 ? 125 : 93;  // } or ]
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (escape) { escape = false; continue; }
      if (c === 92 && inString) { escape = true; continue; } // backslash
      if (c === 34) { inString = !inString; continue; }       // double-quote
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

  ctx.log(`codebase-audit starting on ${ctx.run.cwd}; input="${input}"`);

  // ---- Phase 1: recon ----
  const [recon] = await ctx.phase("recon", [
    ctx.agent(
      `Survey the repo at ${ctx.run.cwd}. Identify the 5–8 most important
      module/area boundaries. Output as a JSON array:
      [{"area": "...", "paths": ["..."], "why": "..."}].
      Focus on auth, data, IO boundaries, and anything mutating shared state.
      User context: "${input || "general audit"}"`,
      { id: "recon", inheritSkills: true },
    ),
  ]);

  // BUG-W01 fix: use extractJsonFromText() instead of bare regex.
  const areas = extractJsonFromText(recon.text);
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new Error(`recon agent did not return parseable JSON array`);
  }
  ctx.log(`recon: identified ${areas.length} areas to audit`);
  await ctx.cache.set("areas", areas);

  // ---- Phase 2: analyze (parallel, one agent per area) ----
  const analyzers = areas.map((area, i) =>
    ctx.agent(
      `Audit area "${area.area}" (paths: ${area.paths.join(", ")}). Look for:
      bugs, dead code, tech debt, missing tests, security smells, perf issues.
      Output 3–8 findings as JSON:
      [{"title": "...", "severity": "high|med|low", "path": "...", "detail": "..."}].
      Be specific; cite line numbers.`,
      { id: `analyze-${i}`, inheritSkills: true, cacheKeyExtra: { area: area.area } },
    ),
  );
  const analyses = await ctx.phase("analyze", analyzers);

  const allFindings = [];
  for (const a of analyses) {
    // BUG-W01 fix: use extractJsonFromText() instead of bare regex.
    const parsed = extractJsonFromText(a.text);
    if (Array.isArray(parsed)) {
      allFindings.push(...parsed);
    } else {
      ctx.log(
        { msg: "analyze agent returned unparseable JSON", agentId: a.agentId },
        { level: "warn" },
      );
    }
  }
  ctx.log(`analyze: ${allFindings.length} findings collected from ${analyses.length} agents`);
  await ctx.cache.set("findings", allFindings);

  if (allFindings.length === 0) {
    return { status: "clean", message: "No findings." };
  }

  // ---- Phase 3: vote on top 10 via Borda count ----
  // Note: ctx.vote() is for single-winner judging. Here we need ranked
  // selection (top 10 ordered from 3 voters) — the explicit Borda loop
  // below demonstrates how to compose phases for richer aggregation.
  //
  // Truncate to top 30 findings by severity to avoid context crashes from
  // inlining large findings JSON into voter prompts (SKILL.md anti-pattern:
  // "Never inline file contents in prompts — causes context crashes").
  const severityOrder = { high: 0, med: 1, low: 2 };
  const totalCount = allFindings.length;
  const topFindings = allFindings
    .slice()
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))
    .slice(0, 30);
  const findingsJson = JSON.stringify(topFindings, null, 2);
  const voters = [0, 1, 2].map((i) =>
    ctx.agent(
      `Analyzing top ${topFindings.length} of ${totalCount} total findings.
      Rank-order the TOP 10 most critical for a code review. Consider
      severity, blast radius, fix difficulty. Return JSON:
      [{"rank": 1, "title": "...", "justification": "..."}, ...].
      Findings:\n${findingsJson}`,
      { id: `voter-${i}`, thinking: "high" },
    ),
  );
  const votes = await ctx.phase("vote", voters);

  // Borda count: rank position r of 10 → score (11 - r). Ties broken by
  // first-voter preference.
  const scores = new Map();
  for (const v of votes) {
    // BUG-W01 fix: use extractJsonFromText() for voter outputs too.
    try {
      const ranked = extractJsonFromText(v.text);
      if (Array.isArray(ranked)) {
        for (const r of ranked) {
          scores.set(r.title, (scores.get(r.title) || 0) + (11 - r.rank));
        }
      }
    } catch { /* skip malformed voter — resilient aggregation */ }
  }
  const top10 = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title]) => allFindings.find((f) => f.title === title))
    .filter(Boolean);

  // ---- Phase 4: summarize ----
  const [summary] = await ctx.phase("summarize", [
    ctx.agent(
      `Write a 1-page audit report. Group these top findings by severity and
      area. Include actionable next steps. Be specific and reference paths.
      Top findings:\n${JSON.stringify(top10, null, 2)}`,
      { id: "summarize", thinking: "high" },
    ),
  ]);

  return {
    runId: ctx.run.id,
    cwd: ctx.run.cwd,
    findingsConsidered: allFindings.length,
    top10,
    report: summary.text,
  };
}
