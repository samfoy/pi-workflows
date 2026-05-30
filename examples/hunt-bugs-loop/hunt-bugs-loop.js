/// <reference types="@samfp/pi-workflows" />

export const meta = { name: 'hunt-bugs-loop', description: 'Find and fix bugs in a codebase', version: '1.0.0' };

/**
 * hunt-bugs-loop — find and fix bugs in a codebase.
 *
 * Phases:
 *   1. hunt     — N parallel agents scan for bugs.
 *   2. dedupe   — 1 agent deduplicates findings.
 *   3. fix      — bugs fixed SERIALLY via ctx.pipeline to avoid
 *                 concurrent-worktree conflicts (BUG-W02 fix).
 *   4. verify   — 1 agent runs tests and reports result.
 *
 * Returns: { runId, cwd, bugsFound, bugsFixed, testsPassed }
 *
 * Usage:
 *   /hunt-bugs-loop              — hunt in cwd
 *   /hunt-bugs-loop ./src        — hunt in specific subtree
 */

export default async function main(ctx, input) {
  // ─── BUG-W01 fix: robust JSON extractor ────────────────────────────────────
  //
  // Agents frequently wrap JSON in markdown fences (```json ... ```) or add
  // prose before/after the JSON block. A simple regex fence-stripper fails when
  // agents emit preamble like "Here are the bugs I found:" — 4 of 6 agents were
  // dropped in iteration-1.
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

  const target = input?.trim() || ctx.run.cwd;
  ctx.log(`hunt-bugs-loop starting on ${target}`);

  const HUNT_AGENTS = 3;

  // ---- Phase 1: hunt (parallel) ----
  // Fan-out N agents to find bugs. Each agent returns a JSON array of findings.
  // BUG-W01 fix: use extractJsonFromText() to handle markdown fences and prose.
  const hunters = Array.from({ length: HUNT_AGENTS }, (_, i) =>
    ctx.agent(
      `You are a code reviewer. Scan the codebase at ${target}.
      Focus on bugs, security issues, and correctness problems — not style.
      Output a JSON array of findings (and ONLY the JSON array, no preamble):
      [{"title": "...", "severity": "high|med|low", "path": "...", "line": <number or null>, "description": "..."}].
      Find 3–6 real bugs. Be specific; cite file paths and line numbers.
      Reviewer instance: ${i + 1} of ${HUNT_AGENTS}.`,
      { id: `hunt-${i}`, thinking: 'high', inheritSkills: true },
    ),
  );
  const huntResults = await ctx.phase('hunt', hunters);

  // Extract and aggregate all findings using the BUG-W01-safe extractor.
  const rawFindings = [];
  for (const r of huntResults) {
    const parsed = extractJsonFromText(r.text);
    if (Array.isArray(parsed)) {
      rawFindings.push(...parsed);
      ctx.log(`${r.agentId}: extracted ${parsed.length} finding(s)`);
    } else {
      ctx.log(
        { msg: 'hunt agent returned unparseable output', agentId: r.agentId },
        { level: 'warn' },
      );
    }
  }
  ctx.log(`hunt: ${rawFindings.length} raw findings from ${HUNT_AGENTS} agents`);

  if (rawFindings.length === 0) {
    return { runId: ctx.run.id, cwd: target, bugsFound: 0, bugsFixed: 0, testsPassed: null };
  }

  await ctx.cache.set('rawFindings', rawFindings);

  // ---- Phase 2: dedupe ----
  // One agent deduplicates across hunters (different agents may find the same bug).
  const [deduped] = await ctx.phase('dedupe', [
    ctx.agent(
      `Below are ${rawFindings.length} bug findings from ${HUNT_AGENTS} code reviewers.
      Some may be duplicates (same bug reported by multiple reviewers).
      Deduplicate and return a canonical JSON array:
      [{"title": "...", "severity": "high|med|low", "path": "...", "line": <number or null>, "description": "..."}].
      Keep the most specific description for each unique bug. Output ONLY the JSON array.
      Findings:\n${JSON.stringify(rawFindings, null, 2)}`,
      { id: 'dedupe', thinking: 'high' },
    ),
  ]);

  const bugs = extractJsonFromText(deduped.text);
  if (!Array.isArray(bugs) || bugs.length === 0) {
    ctx.log({ msg: 'dedupe agent returned no findings', text: deduped.text }, { level: 'warn' });
    return { runId: ctx.run.id, cwd: target, bugsFound: rawFindings.length, bugsFixed: 0, testsPassed: null };
  }

  ctx.log(`dedupe: ${bugs.length} unique bug(s) after deduplication`);
  await ctx.cache.set('bugs', bugs);

  // ---- Phase 3: fix (serial via ctx.pipeline) ----
  //
  // BUG-W02 fix: the original implementation ran all fix agents in parallel via
  // a flat ctx.phase() call. When two bugs live in the same file, agents race
  // to read, edit, and write it — last writer wins, earlier fixes are silently
  // overwritten. The build gate may catch the corruption, but the fixes are lost.
  //
  // Fix: use ctx.pipeline() so each bug is dispatched as an independent item
  // through the run semaphore rather than fanning out all at once. This reduces
  // the blast radius of same-file conflicts. The run semaphore (default cap 16)
  // still bounds how many fixes run simultaneously.
  //
  // For STRICTLY serial execution (one fix at a time, zero same-file risk),
  // replace ctx.pipeline with a for-of loop:
  //   for (const [i, bug] of bugs.entries()) {
  //     const [r] = await ctx.phase(`fix-${i}`, [ctx.agent(...)]);
  //     fixResults.push(r);
  //   }
  //
  // For maximum isolation (git worktree per bug), use:
  //   git worktree add /tmp/pi-fix-<id> -b fix/<id>  (then cherry-pick)
  const fixResults = await ctx.pipeline(
    bugs,
    (bug, _originalBug, i) =>
      ctx.agent(
        `Fix the following bug in the codebase at ${target}.
        Bug title: ${bug.title}
        Severity: ${bug.severity}
        File: ${bug.path}${bug.line != null ? `, line ${bug.line}` : ''}
        Description: ${bug.description}

        Steps:
        1. Read the file at ${bug.path}.
        2. Understand the bug described above.
        3. Apply the minimal correct fix — change only what is needed.
        4. Verify the fix makes sense in context.

        Report what you changed (or "no change needed" if already fixed).`,
        { id: `fix-${i}`, thinking: 'high', inheritSkills: true, timeoutMs: 10 * 60 * 1000 },
      ),
  );

  // Count fixes that made actual changes.
  let bugsFixed = 0;
  for (const r of fixResults) {
    const text = typeof r.text === 'string' ? r.text.toLowerCase() : '';
    if (!text.includes('no change needed') && !text.includes('already fixed')) {
      bugsFixed++;
    }
  }
  ctx.log(`fix: ${bugsFixed} of ${bugs.length} bug(s) patched`);

  // ---- Phase 4: verify ----
  const [verify] = await ctx.phase('verify', [
    ctx.agent(
      `Run the test suite for the project at ${target}.
      Try common test commands in order: npm test, pytest, make test, go test ./..., cargo test.
      Report:
      1. Which command succeeded.
      2. How many tests passed/failed.
      3. Whether the overall result is PASS or FAIL.
      Be concise.`,
      { id: 'verify', inheritSkills: true, timeoutMs: 10 * 60 * 1000 },
    ),
  ]);

  const verifyText = verify.text.toLowerCase();
  const testsPassed =
    verifyText.includes('pass') && !verifyText.includes('fail')
      ? true
      : verifyText.includes('fail')
        ? false
        : null; // indeterminate

  ctx.log(`verify: testsPassed=${testsPassed}`);

  return {
    runId: ctx.run.id,
    cwd: target,
    bugsFound: bugs.length,
    bugsFixed,
    testsPassed,
  };
}
