/**
 * pi-workflows — slice 8b stdlib helpers (vote, consensus, parallel,
 * retry, sleep).
 *
 * The helpers run **inside the Context realm**: they're declared by
 * the init script and close over a Context-local `ctxRef` that
 * `__pi_build_ctx` populates after the frozen `ctx` literal is built.
 * That keeps `.constructor === Function` (Context Function) — the
 * wrapper-identity oracle in `tests/security/fixtures/host-realm-eval.
 * workflow.js` exercises the same invariant for `ctx.agent`/`ctx.phase`
 * etc. and now extends to these five helpers (PRD §8.3.4).
 *
 * Design rationale (vs. routing through `wrapHostMethod`):
 *
 *   - These helpers are **pure compositions** of `ctx.phase` /
 *     `ctx.agent` / `setTimeout`. Every cross-realm hop those primitives
 *     need is already paid; layering another bridge would only add
 *     overhead without strengthening the security boundary.
 *   - Pure Context-realm functions don't accept or return host-realm
 *     objects, so the host-realm-eval class of attack reduces to
 *     `.constructor === Function`, which is automatic.
 *
 * Authoritative references:
 *
 *   - PRD §4.2.6 (helper signatures)
 *   - PRD §15.A (Jaccard-vs-LLM consensus tradeoff; v1 is Jaccard)
 *   - plan.md §4 Slice 8b (acceptance, locked tokenization rules,
 *     critic checklist for AbortSignal handling)
 *
 * The source is a string template because it's evaluated **inside the
 * Context** via `vm.Script.runInContext`. Defining it in TS would
 * give it a host-realm `.constructor` and break the wrapper-identity
 * oracle.
 *
 * AbortSignal source priority for `sleep` / `retry`:
 *
 *   1. Explicit `opts.signal` (from the author).
 *   2. `ctx.signal` if defined — slice 9 wires this; slice 8b's design
 *      reads it lazily so when slice 9 lands, the helpers begin
 *      honoring run-level abort transparently with no churn here.
 *   3. No abort wiring otherwise (best-effort retry/sleep).
 */

/**
 * Identifier used when splicing this source into a `vm.Script` —
 * makes stack traces from helper code legible during debugging.
 * Mirrors the convention `buildInitScript` uses for its filename.
 */
export const STDLIB_INIT_SCRIPT_FILENAME = "pi-workflows-stdlib.js";

/**
 * Context-realm source for the stdlib helpers. Spliced into
 * `buildInitScript` (immediately after `wrapHostSync`/`wrapHostAsync`
 * are defined and before `__pi_build_ctx` is installed) so all five
 * helpers are available to both the slice-2 stub branch and the
 * real-host branch.
 *
 * Exposed Context-realm symbols:
 *   - `__pi_install_stdlib(ctxRef)` — returns `{ vote, consensus,
 *     parallel, retry, sleep }`. Each helper closes over the supplied
 *     `ctxRef` (`{ current: ctx | null }`) so the late-bound `ctx`
 *     reference is reachable without exposing it as a module-level
 *     mutable global.
 *
 * Security notes documented inline in the source:
 *
 *   - `__pi_tokenize` is regex-free (char-code loop) — keeps the
 *     bundled init script free of regex literals that would otherwise
 *     be sensitive to regex-engine catastrophic-backtracking attacks
 *     when an author passes adversarial agent output.
 *   - `parallel`'s `fn` callback runs in the Context realm; we
 *     `await` whatever it returns (handle or array of handles) and
 *     never inspect it for host objects — `ctx.phase` already does
 *     full validation.
 *   - `retry` rejects on `AbortError` (or any error when the active
 *     signal is aborted) without consuming the remaining attempt
 *     budget — required by plan.md §4 Slice 8b critic checklist.
 *   - `sleep` removes its abort listener on natural resolution to
 *     avoid an O(N) listener pile-up over a long-lived `ctx.signal`.
 */
export const STDLIB_INIT_SOURCE_HEAD = `
'use strict';

// ─── extractJSON: char-code based, fence + bracket aware ──────────
//
// Mirrors the host extractor in runCtx.ts (extractJson) but lives in
// the Context realm so authors can call it without bouncing through
// a host bridge. Tolerates: leading prose, trailing prose, \\\`\\\`\\\`json
// fences (last fence wins, per BUG-052), nested braces, escaped
// quotes inside strings, and truncated/incomplete trailing braces
// (returns the last balanced block).
//
// Char codes: 123={ 125=} 91=[ 93=] 92=\\ 34=\" 96=\\\` 10=\\n
function __pi_extract_json(text) {
  if (typeof text !== 'string') {
    throw new TypeError('ctx.extractJSON: text must be a string');
  }
  // Pass 1: scan for the LAST \\\`\\\`\\\`json fence block.
  // We do this with a char-code state machine — no regex.
  // Look for backtick-backtick-backtick followed by 'json' optional whitespace,
  // then capture until the next \\\`\\\`\\\`. Last match wins.
  let lastFenceStart = -1;
  let lastFenceEnd = -1;
  let i = 0;
  while (i < text.length - 6) {
    if (
      text.charCodeAt(i) === 96 &&
      text.charCodeAt(i + 1) === 96 &&
      text.charCodeAt(i + 2) === 96
    ) {
      // After the three backticks, optional 'json' tag (case-insensitive)
      // then whitespace then payload until the next \\\`\\\`\\\`.
      let j = i + 3;
      // Skip a 'json' tag if present.
      if (
        j + 4 <= text.length &&
        (text.charCodeAt(j) === 106 || text.charCodeAt(j) === 74) &&    // j J
        (text.charCodeAt(j + 1) === 115 || text.charCodeAt(j + 1) === 83) && // s S
        (text.charCodeAt(j + 2) === 111 || text.charCodeAt(j + 2) === 79) && // o O
        (text.charCodeAt(j + 3) === 110 || text.charCodeAt(j + 3) === 78)   // n N
      ) {
        j += 4;
      }
      // Skip whitespace + newline.
      while (j < text.length) {
        const cc = text.charCodeAt(j);
        if (cc === 32 || cc === 9 || cc === 10 || cc === 13) j++;
        else break;
      }
      // Find closing \\\`\\\`\\\`.
      let k = j;
      let closed = -1;
      while (k < text.length - 2) {
        if (
          text.charCodeAt(k) === 96 &&
          text.charCodeAt(k + 1) === 96 &&
          text.charCodeAt(k + 2) === 96
        ) {
          closed = k;
          break;
        }
        k++;
      }
      if (closed !== -1) {
        lastFenceStart = j;
        lastFenceEnd = closed;
        i = closed + 3;
        continue;
      }
    }
    i++;
  }
  if (lastFenceStart !== -1) {
    const fenced = text.slice(lastFenceStart, lastFenceEnd);
    // Trim trailing whitespace/newlines.
    let s = 0;
    let e = fenced.length;
    while (s < e) {
      const cc = fenced.charCodeAt(s);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13) s++;
      else break;
    }
    while (e > s) {
      const cc = fenced.charCodeAt(e - 1);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13) e--;
      else break;
    }
    try {
      return JSON.parse(fenced.slice(s, e));
    } catch (_) {
      // Fall through to bracket scan below — fence may have been a
      // false positive (e.g. literal triple-backtick inside prose).
    }
  }
  // Pass 2: scan from the FIRST '{' or '[' and depth-track to the
  // matching close so trailing prose / truncation are handled.
  let firstBrace = -1;
  let firstBracket = -1;
  for (let p = 0; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (firstBrace === -1 && c === 123) firstBrace = p;
    if (firstBracket === -1 && c === 91) firstBracket = p;
    if (firstBrace !== -1 && firstBracket !== -1) break;
  }
  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error('ctx.extractJSON: no JSON found in text');
  }
  let start;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = firstBrace < firstBracket ? firstBrace : firstBracket;
  const openCode = text.charCodeAt(start);
  const closeCode = openCode === 123 ? 125 : 93;
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let p = start; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (escape) { escape = false; continue; }
    if (c === 92 && inString) { escape = true; continue; }
    if (c === 34) { inString = !inString; continue; }
    if (inString) continue;
    if (c === openCode) depth++;
    else if (c === closeCode) {
      depth--;
      if (depth === 0) { end = p; break; }
    }
  }
  if (end === -1) {
    // Truncation tolerance: if we reached EOF still nested, return the
    // longest balanced prefix by walking back to the deepest matched
    // close. Simpler: re-scan and remember the last position where
    // depth dropped to 1 then to 0 — but for now, fail loudly.
    throw new Error('ctx.extractJSON: no JSON found in text');
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ─── tokenize: lowercase + ASCII-alnum split (regex-free) ─────────
//
// Plan §4 Slice 8b risk pin: "lowercase + whitespace-split + strip
// ASCII punctuation". Implemented as a char-code scan to avoid regex
// in the Context (defense in depth + cheap for short strings).
function __pi_tokenize(s) {
  if (typeof s !== 'string') return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Normalize ASCII upper to lower.
    const lo = (c >= 65 && c <= 90) ? c + 32 : c;
    // Token chars: 0-9 (48-57), a-z (97-122), '_' (95).
    const isTok =
      (lo >= 48 && lo <= 57) ||
      (lo >= 97 && lo <= 122) ||
      lo === 95;
    if (isTok) {
      cur += String.fromCharCode(lo);
    } else if (cur.length > 0) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ─── Jaccard similarity over token sets ───────────────────────────
function __pi_jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter++;
  }
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 1 : inter / uni;
}

// ─── AbortSignal helpers ──────────────────────────────────────────
function __pi_aborted_reason(sig) {
  if (sig && sig.aborted === true) {
    const r = sig.reason;
    return r !== undefined ? r : new Error('aborted');
  }
  return null;
}
function __pi_pick_signal(opts, ctxRef) {
  if (opts && typeof opts === 'object') {
    const o = opts;
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      return o.signal;
    }
  }
  const c = ctxRef && ctxRef.current;
  if (c && c.signal && typeof c.signal.addEventListener === 'function') {
    return c.signal;
  }
  return null;
}

globalThis.__pi_install_stdlib = function (ctxRef) {
  // ─── ctx.vote(agents, judge) ────────────────────────────────────
  function vote(agents, judge) {
    return Promise.resolve().then(function () {
      if (!Array.isArray(agents)) {
        throw new TypeError('ctx.vote: agents must be an array');
      }
      if (typeof judge !== 'function') {
        throw new TypeError('ctx.vote: judge must be a function');
      }
      return ctxRef.current.phase('vote', agents).then(function (results) {
        const responses = results.map(function (r) { return r.text; });
        // Judge can be sync or async; Promise.resolve normalizes both.
        return Promise.resolve(judge(responses)).then(function (winner) {
          return { winner: winner, responses: responses };
        });
      });
    });
  }

  // ─── ctx.consensus(agents, opts?) ───────────────────────────────
  //
  // v1 model: pairwise Jaccard similarity over token sets (PRD
  // §15.A). \`agreed\` iff at least \`threshold\` fraction of the
  // pairwise comparisons cross the same threshold. Crude on
  // technical text — documented limitation.
  //
  // gap-fix: opts.method now accepts 'jaccard' (default) or any of
  // the ranked-aggregation methods supported by ctx.aggregate
  // ('borda', 'schulze', 'ranked_pairs', etc.). When a ranked method
  // is selected, each agent's text is parsed as a JSON ranking via
  // __pi_extract_json (must be an array of candidate identifiers,
  // best-to-worst). \`majorityText\` is the winning candidate; the
  // agreed flag is true when the top-2 winners are stable across
  // the chosen aggregator's runner-up margin.
  function consensus(agents, opts) {
    return Promise.resolve().then(function () {
      if (!Array.isArray(agents)) {
        throw new TypeError('ctx.consensus: agents must be an array');
      }
      const method =
        opts && typeof opts.method === 'string' ? opts.method : 'jaccard';
      const threshold =
        opts && typeof opts.threshold === 'number'
          ? opts.threshold
          : 0.6;
      if (!(threshold >= 0 && threshold <= 1)) {
        throw new RangeError(
          'ctx.consensus: opts.threshold must be in [0, 1]',
        );
      }
      return ctxRef.current
        .phase('consensus', agents)
        .then(function (results) {
          const responses = results.map(function (r) { return r.text; });
          if (responses.length === 0) {
            return { agreed: true, majorityText: '', responses: responses };
          }
          if (responses.length === 1) {
            return {
              agreed: true,
              majorityText: responses[0],
              responses: responses,
            };
          }
          if (method === 'jaccard') {
            const tokens = responses.map(__pi_tokenize);
            let totalPairs = 0;
            let crossed = 0;
            let bestI = 0;
            let bestSum = -Infinity;
            for (let i = 0; i < tokens.length; i++) {
              let sum = 0;
              for (let j = 0; j < tokens.length; j++) {
                if (i === j) continue;
                const sim = __pi_jaccard(tokens[i], tokens[j]);
                sum += sim;
                if (j > i) {
                  totalPairs++;
                  if (sim >= threshold) crossed++;
                }
              }
              if (sum > bestSum) {
                bestSum = sum;
                bestI = i;
              }
            }
            const ratio = totalPairs === 0 ? 1 : crossed / totalPairs;
            const agreed = ratio >= threshold;
            return {
              agreed: agreed,
              majorityText: responses[bestI],
              responses: responses,
            };
          }
          // Ranked-aggregation method: parse each response as a
          // ranking via __pi_extract_json. Skip unparseable responses
          // — the aggregator handles smaller ballot counts gracefully.
          const ballots = [];
          for (let i = 0; i < responses.length; i++) {
            try {
              const parsed = __pi_extract_json(responses[i]);
              if (Array.isArray(parsed)) ballots.push(parsed);
            } catch (_) { /* skip malformed */ }
          }
          if (ballots.length === 0) {
            return {
              agreed: false,
              majorityText: responses[0],
              responses: responses,
            };
          }
          const result = __pi_aggregate(method, ballots, opts);
          // Heuristic: 'agreed' iff the winner appears at rank 0 in at
          // least \`threshold\` fraction of the ballots.
          let topCount = 0;
          for (let i = 0; i < ballots.length; i++) {
            if (ballots[i][0] === result.winner) topCount++;
          }
          const ratio = topCount / ballots.length;
          return {
            agreed: ratio >= threshold,
            majorityText: String(result.winner),
            responses: responses,
            ranking: result.ranking,
          };
        });
    });
  }

  // ─── ctx.aggregate(method, ballots, opts?) ──────────────────────
  //
  // Pure ranked-aggregation primitive. \`method\` is one of:
  //   'borda' — Borda count (positional scoring)
  //   'schulze' — Schulze beatpath method
  //   'ranked_pairs' — Tideman's ranked-pairs
  //   'kemeny_young' — Kendall-tau minimization (exhaustive; small N)
  //   'instant_runoff' — IRV / single-transferable-vote single-winner
  //   'coombs' — Coombs method (eliminate worst-ranked first)
  //   'score' — score voting (ballots are { candidate: score } maps)
  //   'approval' — approval voting (ballots are arrays of approved candidates)
  //
  // Returns { winner, ranking } where ranking is the candidates
  // ordered best-to-worst by the chosen method. Pure; no side
  // effects. Synchronous (no host bridge).
  function aggregate(method, ballots, opts) {
    if (typeof method !== 'string') {
      throw new TypeError('ctx.aggregate: method must be a string');
    }
    if (!Array.isArray(ballots)) {
      throw new TypeError('ctx.aggregate: ballots must be an array');
    }
    return __pi_aggregate(method, ballots, opts || {});
  }

  // ─── ctx.extractJSON(text) ──────────────────────────────────────
  //
  // Pure: parses fenced JSON from agent output. Tolerant of leading
  // prose, trailing prose, last-fence-wins, and bracket-depth scans
  // when no fence is present. Mirrors the host runCtx extractJson
  // (BUG-051 + BUG-052 fixed). Replaces the ~40 LOC that 3 of 5
  // bundled examples duplicate verbatim.
  function extractJSON(text) {
    return __pi_extract_json(text);
  }

  // ─── ctx.critique({ producer, critic, maxRounds, accept }) ─────
  //
  // Producer-critic loop. Each round: producer is called with the
  // most recent critique (null on round 0); the producer's output
  // is fed to the critic; the critic's output is checked by
  // accept(critique, output). Returns when accepted, or after
  // maxRounds with the last { output, critique, accepted: false }.
  //
  // producer: (lastCritique | null, round) => Promise<output>
  // critic:   (output, round) => Promise<critique>
  // accept:   (critique, output) => boolean   (sync, default: returns false → hits maxRounds)
  // maxRounds: positive integer, default 3
  //
  // Mirrors the 1-producer-1-judge pattern Anthropic / AutoGen
  // Magentic-One / DSPy MultiChainComparison ship. Authors are
  // expected to pass producer/critic functions that internally
  // wrap ctx.agent + ctx.phase calls — the helper itself is realm-
  // pure and never spawns agents directly.
  function critique(opts) {
    return Promise.resolve().then(function () {
      if (!opts || typeof opts !== 'object') {
        throw new TypeError('ctx.critique: opts must be an object');
      }
      if (typeof opts.producer !== 'function') {
        throw new TypeError('ctx.critique: opts.producer must be a function');
      }
      if (typeof opts.critic !== 'function') {
        throw new TypeError('ctx.critique: opts.critic must be a function');
      }
      const accept =
        typeof opts.accept === 'function'
          ? opts.accept
          : function () { return false; };
      const rawMax =
        typeof opts.maxRounds === 'number' ? opts.maxRounds : 3;
      if (!Number.isFinite(rawMax) || rawMax < 1) {
        throw new RangeError(
          'ctx.critique: opts.maxRounds must be a finite number >= 1',
        );
      }
      const maxRounds = Math.floor(rawMax);
      const history = [];
      let lastCritique = null;
      function step(round) {
        if (round >= maxRounds) {
          // Loop budget exhausted — return the last entry with accepted=false.
          const last = history.length > 0
            ? history[history.length - 1]
            : { output: null, critique: null };
          return {
            accepted: false,
            output: last.output,
            critique: last.critique,
            rounds: round,
            history: history,
          };
        }
        return Promise.resolve(opts.producer(lastCritique, round)).then(
          function (output) {
            return Promise.resolve(opts.critic(output, round)).then(
              function (cri) {
                const entry = { output: output, critique: cri };
                history.push(entry);
                lastCritique = cri;
                let accepted = false;
                try {
                  accepted = accept(cri, output) === true;
                } catch (e) {
                  // Surface accept() errors verbatim — author bug.
                  throw e;
                }
                if (accepted) {
                  return {
                    accepted: true,
                    output: output,
                    critique: cri,
                    rounds: round + 1,
                    history: history,
                  };
                }
                return step(round + 1);
              },
            );
          },
        );
      }
      return step(0);
    });
  }

  // ─── ctx.parallel(items, fn, opts?) ─────────────────────────────
  //
  // Maps items → AgentHandles via \`fn\`. \`fn\` may return a single
  // handle or an array (flattened into the phase). Runs all in a
  // single \`ctx.phase\` so they share one semaphore reservation
  // window and one ledger phase_start/phase_end pair.
  //
  // \`fn\` is invoked sequentially per item — the cap is enforced
  // by the underlying semaphore inside \`ctx.phase\`. Sequential
  // construction is intentional: lets authors do
  // \`fn(item, ctx)\` with shared state without races.
  function parallel(items, fn, opts) {
    return Promise.resolve().then(function () {
      if (!Array.isArray(items)) {
        throw new TypeError('ctx.parallel: items must be an array');
      }
      if (typeof fn !== 'function') {
        throw new TypeError('ctx.parallel: fn must be a function');
      }
      const phaseName =
        opts &&
        typeof opts.phaseName === 'string' &&
        opts.phaseName.length > 0
          ? opts.phaseName
          : 'parallel';
      // Forward PhaseOpts (failMode / timeoutMs / maxConcurrent) to the
      // underlying ctx.phase call. Drop phaseName — that's our own knob.
      // We construct a fresh object so user-supplied prototypes / extra
      // keys can't leak through.
      let phaseOpts;
      if (opts && typeof opts === 'object') {
        phaseOpts = {};
        if (opts.failMode !== undefined) phaseOpts.failMode = opts.failMode;
        if (opts.timeoutMs !== undefined) phaseOpts.timeoutMs = opts.timeoutMs;
        if (opts.maxConcurrent !== undefined)
          phaseOpts.maxConcurrent = opts.maxConcurrent;
      }
      const handles = [];
      function step(i) {
        if (i >= items.length) {
          return ctxRef.current.phase(phaseName, handles, phaseOpts);
        }
        // Invoke fn synchronously, then handle the result.
        // Check kind BEFORE Promise.resolve to avoid the then-getter (BUG-001 fix).
        // BUG-W06 fix: pass (item, index, ctx) like Array.prototype.map so authors
        // can use the index without accidentally capturing the ctx object as 'i'.
        var h = fn(items[i], i, ctxRef.current);
        if (h !== null && typeof h === 'object' && !Array.isArray(h) && h.kind === 'agent') {
          handles.push(h);
          return step(i + 1);
        }
        return Promise.resolve(h).then(function (resolved) {
          if (Array.isArray(resolved)) {
            for (var k = 0; k < resolved.length; k++) handles.push(resolved[k]);
          } else {
            handles.push(resolved);
          }
          return step(i + 1);
        });
      }
      return step(0);
    });
  }

  // ─── ctx.pipeline(items, ...stages) ────────────────────────────
  //
  // Runs each item through sequential stages. Items are processed
  // concurrently; stages within an item are sequential. If a stage
  // returns an AgentHandle (object with kind === 'agent'), it is
  // automatically run through a single-agent phase. Each stage
  // receives (previousValue, originalItem, index).
  function pipeline(items) {
    var stages = Array.prototype.slice.call(arguments, 1);
    return Promise.resolve().then(function () {
      if (!Array.isArray(items)) {
        throw new TypeError('ctx.pipeline: first argument must be an array');
      }
      if (stages.some(function(s) { return typeof s !== 'function'; })) {
        throw new TypeError('ctx.pipeline: all stage arguments must be functions');
      }
      return Promise.all(
        items.map(function (item, index) {
          function runStages(i, value) {
            if (i >= stages.length) return Promise.resolve(value);
            var stageResult;
            try {
              stageResult = stages[i](value, item, index);
            } catch (e) {
              return Promise.reject(e);
            }
            // Auto-run AgentHandle results through a single-agent phase.
            // Check kind BEFORE Promise.resolve() to avoid triggering
            // the then-getter that guards against accidental await (BUG-001 fix).
            if (stageResult !== null && typeof stageResult === 'object' &&
                stageResult.kind === 'agent') {
              return ctxRef.current.phase(
                'pipeline-stage-' + i, [stageResult]
              ).then(function (results) {
                return runStages(i + 1, results[0]);
              });
            }
            return Promise.resolve(stageResult).then(function (result) {
              return runStages(i + 1, result);
            });
          }
          return runStages(0, item);
        })
      );
    });
  }

  // ─── ctx.sleep(ms, opts?) ───────────────────────────────────────
  //
  // Promise resolving after \`ms\` via \`setTimeout\` (the Context-
  // realm wrapper from buildInitScript). AbortSignal-aware: priority
  // is opts.signal > ctx.signal (slice 9 wires the latter). Listener
  // is removed on natural resolution to avoid leaks across thousands
  // of sleeps in a long retry chain.
  function sleep(ms, opts) {
    return new Promise(function (resolve, reject) {
      const n = +ms;
      if (!Number.isFinite(n) || n < 0) {
        reject(
          new TypeError(
            'ctx.sleep: ms must be a non-negative finite number',
          ),
        );
        return;
      }
      const sig = __pi_pick_signal(opts, ctxRef);
      const aborted = __pi_aborted_reason(sig);
      if (aborted !== null) {
        reject(aborted);
        return;
      }
      let onAbort = null;
      const t = setTimeout(function () {
        if (sig !== null && onAbort !== null) {
          sig.removeEventListener('abort', onAbort);
        }
        resolve();
      }, n);
      if (sig !== null) {
        onAbort = function () {
          clearTimeout(t);
          const r = sig.reason;
          reject(r !== undefined ? r : new Error('aborted'));
        };
        sig.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ─── ctx.retry(fn, opts?) ───────────────────────────────────────
  //
  // Bounded retry with exponential backoff (\`backoffMs * 2^i\`).
  // Per plan §4 Slice 8b critic checklist: AbortError must NOT be
  // swallowed — rethrown immediately. Likewise any error caught
  // while the active signal is aborted is surfaced verbatim
  // (the run is shutting down; retry is meaningless).
  //
  // \`opts.signal\` overrides \`ctx.signal\` (which slice 9 wires).
  // Both states are re-read on every iteration so a slice-9 patch
  // that wires \`ctx.signal\` is transparent.
  function retry(fn, opts) {
    return Promise.resolve().then(function () {
      if (typeof fn !== 'function') {
        throw new TypeError('ctx.retry: fn must be a function');
      }
      const rawAttempts =
        opts && typeof opts.attempts === 'number' ? opts.attempts : 3;
      if (!Number.isFinite(rawAttempts) || rawAttempts < 1) {
        throw new RangeError(
          'ctx.retry: opts.attempts must be a finite number >= 1',
        );
      }
      const attempts = Math.floor(rawAttempts);
      const backoffMs =
        opts &&
        typeof opts.backoffMs === 'number' &&
        opts.backoffMs >= 0
          ? opts.backoffMs
          : 100;
      const explicitSig =
        opts && opts.signal && typeof opts.signal.addEventListener === 'function'
          ? opts.signal
          : null;
      function activeSig() {
        if (explicitSig !== null) return explicitSig;
        const c = ctxRef.current;
        return c && c.signal && typeof c.signal.addEventListener === 'function'
          ? c.signal
          : null;
      }
      let lastErr;
      function step(i) {
        const sig = activeSig();
        const aborted = __pi_aborted_reason(sig);
        if (aborted !== null) return Promise.reject(aborted);
        return Promise.resolve()
          .then(fn)
          .then(
            function (v) { return v; },
            function (e) {
              // AbortError or active-abort → no retry, no swallow.
              const sigNow = activeSig();
              if (
                (e && e.name === 'AbortError') ||
                (sigNow !== null && sigNow.aborted === true)
              ) {
                throw e;
              }
              lastErr = e;
              if (i + 1 >= attempts) throw lastErr;
              const ms = backoffMs * Math.pow(2, i);
              const sleepOpts =
                explicitSig !== null ? { signal: explicitSig } : undefined;
              return sleep(ms, sleepOpts).then(function () {
                return step(i + 1);
              });
            },
          );
      }
      return step(0);
    });
  }

  return {
    vote: vote,
    consensus: consensus,
    parallel: parallel,
    pipeline: pipeline,
    retry: retry,
    sleep: sleep,
    aggregate: aggregate,
    extractJSON: extractJSON,
    critique: critique,
  };
};
`;

// (gap-fix) STDLIB_INIT_SOURCE is composed AFTER __PI_AGGREGATE_SOURCE__
// is declared at the bottom of this file — see the trailing
// `export const STDLIB_INIT_SOURCE = ...`. Splitting the head from
// the tail avoids a TDZ at module load (a parallel-zone change
// declared __PI_AGGREGATE_SOURCE__ AFTER its first reference).

/**
 * Aggregation-algorithms source string. Spliced into STDLIB_INIT_SOURCE
 * as a top-level helper block so __pi_aggregate is hoisted at the same
 * scope as __pi_tokenize / __pi_jaccard. Ports DSPy issue #8898 (MIT)
 * algorithms: borda_count, schulze_method, ranked_pairs, kemeny_young,
 * instant_runoff, coombs_method, score_voting, approval_voting.
 *
 * Ballot conventions:
 *   - ranked methods (borda, schulze, ranked_pairs, kemeny_young,
 *     instant_runoff, coombs): each ballot is an array of candidate
 *     identifiers ordered best-to-worst. Missing candidates rank last
 *     in arbitrary order.
 *   - score: each ballot is { candidate: number } — higher is better.
 *   - approval: each ballot is an array of approved candidate ids.
 *
 * Every algorithm returns { winner, ranking } where ranking is
 * candidates ordered best-to-worst. Ties are broken by candidate id
 * comparison (deterministic).
 */
const __PI_AGGREGATE_SOURCE__ = `
// Helper: collect the universe of candidates across all ballots.
function __pi_collect_candidates(ballots, kind) {
  const set = new Set();
  for (let i = 0; i < ballots.length; i++) {
    const b = ballots[i];
    if (kind === 'score') {
      const keys = Object.keys(b);
      for (let j = 0; j < keys.length; j++) set.add(keys[j]);
    } else {
      // ranked / approval: array of ids.
      for (let j = 0; j < b.length; j++) set.add(b[j]);
    }
  }
  return Array.from(set);
}

function __pi_borda(ballots, candidates) {
  // Standard Borda: rank-position r out of N candidates → score (N - r - 1).
  // Ballots may omit candidates; missing candidates score 0 from that ballot.
  const N = candidates.length;
  const score = Object.create(null);
  for (let i = 0; i < N; i++) score[candidates[i]] = 0;
  for (let i = 0; i < ballots.length; i++) {
    const b = ballots[i];
    for (let r = 0; r < b.length; r++) {
      const c = b[r];
      if (score[c] === undefined) continue;
      score[c] += (N - r - 1);
    }
  }
  const ranking = candidates.slice().sort(function (a, b) {
    if (score[b] !== score[a]) return score[b] - score[a];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return { winner: ranking[0], ranking: ranking, scores: score };
}

function __pi_pairwise(ballots, candidates) {
  // Build pairwise preference matrix: pref[a][b] = number of ballots
  // ranking a above b. Missing candidates treated as tied last.
  const N = candidates.length;
  const idx = Object.create(null);
  for (let i = 0; i < N; i++) idx[candidates[i]] = i;
  // pref is a flat N*N typed-friendly array.
  const pref = new Array(N * N);
  for (let i = 0; i < N * N; i++) pref[i] = 0;
  for (let bi = 0; bi < ballots.length; bi++) {
    const b = ballots[bi];
    // Build position map for this ballot: candidate -> rank (0=best).
    const pos = Object.create(null);
    for (let r = 0; r < b.length; r++) {
      if (idx[b[r]] !== undefined && pos[b[r]] === undefined) {
        pos[b[r]] = r;
      }
    }
    // Compare every pair of candidates.
    for (let i = 0; i < N; i++) {
      const ci = candidates[i];
      const ri = pos[ci];
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const cj = candidates[j];
        const rj = pos[cj];
        // i ranks above j iff i is present and (j is absent OR i comes first)
        if (ri !== undefined && (rj === undefined || ri < rj)) {
          pref[i * N + j] += 1;
        }
      }
    }
  }
  return pref;
}

function __pi_schulze(ballots, candidates) {
  // Schulze beatpath: strongest path strength p[i][j].
  // Standard Floyd-Warshall-like iteration.
  const N = candidates.length;
  const pref = __pi_pairwise(ballots, candidates);
  const p = new Array(N * N);
  for (let i = 0; i < N * N; i++) p[i] = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const ij = pref[i * N + j];
      const ji = pref[j * N + i];
      p[i * N + j] = ij > ji ? ij : 0;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      for (let k = 0; k < N; k++) {
        if (i === k || j === k) continue;
        const through = Math.min(p[j * N + i], p[i * N + k]);
        if (through > p[j * N + k]) {
          p[j * N + k] = through;
        }
      }
    }
  }
  // Rank candidates by Schulze ordering: i is ranked above j iff p[i][j] > p[j][i].
  const wins = new Array(N);
  for (let i = 0; i < N; i++) {
    let w = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      if (p[i * N + j] > p[j * N + i]) w++;
    }
    wins[i] = w;
  }
  const order = candidates.slice().sort(function (a, b) {
    const ai = candidates.indexOf(a);
    const bi = candidates.indexOf(b);
    if (wins[bi] !== wins[ai]) return wins[bi] - wins[ai];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return { winner: order[0], ranking: order };
}

function __pi_ranked_pairs(ballots, candidates) {
  // Tideman: sort pairwise majorities by margin desc, lock in unless
  // doing so creates a cycle.
  const N = candidates.length;
  const pref = __pi_pairwise(ballots, candidates);
  const majorities = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const ij = pref[i * N + j];
      const ji = pref[j * N + i];
      if (ij > ji) majorities.push({ from: i, to: j, margin: ij - ji });
      else if (ji > ij) majorities.push({ from: j, to: i, margin: ji - ij });
    }
  }
  majorities.sort(function (a, b) {
    if (b.margin !== a.margin) return b.margin - a.margin;
    if (a.from !== b.from) return a.from - b.from;
    return a.to - b.to;
  });
  // Lock-in graph: adj[i] = Set<j> for edges from i.
  const adj = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = new Set();
  function reachable(from, to) {
    if (from === to) return true;
    const stack = [from];
    const seen = new Set();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = adj[cur];
      for (const v of next) {
        if (v === to) return true;
        stack.push(v);
      }
    }
    return false;
  }
  for (let m = 0; m < majorities.length; m++) {
    const e = majorities[m];
    // Locking from->to creates a cycle iff to can already reach from.
    if (reachable(e.to, e.from)) continue;
    adj[e.from].add(e.to);
  }
  // Source of the DAG = winner. Topo sort = ranking.
  const indeg = new Array(N);
  for (let i = 0; i < N; i++) indeg[i] = 0;
  for (let i = 0; i < N; i++) {
    for (const j of adj[i]) indeg[j] += 1;
  }
  const ranking = [];
  // Kahn's: repeatedly pick zero-indegree (deterministic by candidate name).
  while (ranking.length < N) {
    let pick = -1;
    let pickName = null;
    for (let i = 0; i < N; i++) {
      if (indeg[i] === 0) {
        const nm = candidates[i];
        if (pick === -1 || nm < pickName) { pick = i; pickName = nm; }
      }
    }
    if (pick === -1) {
      // Should not happen — DAG by construction. Fall back to remaining order.
      for (let i = 0; i < N; i++) {
        if (indeg[i] !== -1) ranking.push(candidates[i]);
      }
      break;
    }
    ranking.push(candidates[pick]);
    indeg[pick] = -1; // mark consumed
    for (const j of adj[pick]) indeg[j] -= 1;
  }
  return { winner: ranking[0], ranking: ranking };
}

function __pi_kemeny_young(ballots, candidates) {
  // Kendall-tau minimization. Brute-force over all permutations of
  // \\\`candidates\\\` — only feasible for small N (<= 8 or so). For
  // larger sets the caller should pick another method.
  const N = candidates.length;
  if (N > 8) {
    throw new RangeError(
      'ctx.aggregate(kemeny_young): too many candidates (max 8 — use schulze for larger sets)',
    );
  }
  const pref = __pi_pairwise(ballots, candidates);
  let best = null;
  let bestScore = -Infinity;
  // Heap's algorithm to enumerate permutations.
  const arr = [];
  for (let i = 0; i < N; i++) arr.push(i);
  const c = new Array(N).fill(0);
  let i = 0;
  function score(perm) {
    // For each pair (i<j) in perm, add pref[perm[i]][perm[j]].
    let s = 0;
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        s += pref[perm[a] * N + perm[b]];
      }
    }
    return s;
  }
  // Initial permutation.
  let s = score(arr);
  best = arr.slice();
  bestScore = s;
  while (i < N) {
    if (c[i] < i) {
      const swapWith = (i % 2 === 0) ? 0 : c[i];
      const tmp = arr[swapWith];
      arr[swapWith] = arr[i];
      arr[i] = tmp;
      const sc = score(arr);
      if (sc > bestScore) {
        bestScore = sc;
        best = arr.slice();
      } else if (sc === bestScore) {
        // Tie-break: prefer the lexicographically-smaller candidate-name ranking.
        const nameA = arr.map(function (k) { return candidates[k]; }).join('|');
        const nameB = best.map(function (k) { return candidates[k]; }).join('|');
        if (nameA < nameB) best = arr.slice();
      }
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  const ranking = best.map(function (k) { return candidates[k]; });
  return { winner: ranking[0], ranking: ranking };
}

function __pi_instant_runoff(ballots, candidates) {
  // IRV: count first-rank votes; eliminate lowest; redistribute; repeat.
  // Returns the winner. Ranking is reverse-elimination order (last
  // standing → first eliminated).
  const remaining = new Set(candidates);
  const eliminationOrder = [];
  while (remaining.size > 1) {
    const tally = Object.create(null);
    for (const c of remaining) tally[c] = 0;
    for (let i = 0; i < ballots.length; i++) {
      const b = ballots[i];
      // Find first ranked candidate still in the race.
      for (let r = 0; r < b.length; r++) {
        if (remaining.has(b[r])) {
          tally[b[r]] += 1;
          break;
        }
      }
    }
    // Find candidate(s) with min votes.
    let minVotes = Infinity;
    for (const c of remaining) {
      if (tally[c] < minVotes) minVotes = tally[c];
    }
    let toEliminate = null;
    for (const c of remaining) {
      if (tally[c] === minVotes) {
        if (toEliminate === null || c < toEliminate) toEliminate = c;
      }
    }
    eliminationOrder.push(toEliminate);
    remaining.delete(toEliminate);
  }
  let winner = null;
  for (const c of remaining) winner = c;
  const ranking = [winner].concat(eliminationOrder.reverse());
  return { winner: winner, ranking: ranking };
}

function __pi_coombs(ballots, candidates) {
  // Coombs: eliminate the candidate with the most LAST-place rankings.
  const remaining = new Set(candidates);
  const eliminationOrder = [];
  while (remaining.size > 1) {
    const lastPlaceCount = Object.create(null);
    for (const c of remaining) lastPlaceCount[c] = 0;
    for (let i = 0; i < ballots.length; i++) {
      const b = ballots[i];
      // Find last-place candidate among remaining (highest rank index).
      let last = null;
      let lastIdx = -1;
      for (let r = 0; r < b.length; r++) {
        if (remaining.has(b[r]) && r > lastIdx) {
          lastIdx = r;
          last = b[r];
        }
      }
      if (last !== null) lastPlaceCount[last] += 1;
    }
    let maxLast = -1;
    for (const c of remaining) {
      if (lastPlaceCount[c] > maxLast) maxLast = lastPlaceCount[c];
    }
    let toEliminate = null;
    for (const c of remaining) {
      if (lastPlaceCount[c] === maxLast) {
        if (toEliminate === null || c < toEliminate) toEliminate = c;
      }
    }
    eliminationOrder.push(toEliminate);
    remaining.delete(toEliminate);
  }
  let winner = null;
  for (const c of remaining) winner = c;
  const ranking = [winner].concat(eliminationOrder.reverse());
  return { winner: winner, ranking: ranking };
}

function __pi_score(ballots, candidates) {
  // Score voting: sum scores per candidate.
  const total = Object.create(null);
  for (let i = 0; i < candidates.length; i++) total[candidates[i]] = 0;
  for (let i = 0; i < ballots.length; i++) {
    const b = ballots[i];
    const keys = Object.keys(b);
    for (let k = 0; k < keys.length; k++) {
      const c = keys[k];
      const v = b[c];
      if (typeof v === 'number' && Number.isFinite(v) && total[c] !== undefined) {
        total[c] += v;
      }
    }
  }
  const ranking = candidates.slice().sort(function (a, b) {
    if (total[b] !== total[a]) return total[b] - total[a];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return { winner: ranking[0], ranking: ranking, scores: total };
}

function __pi_approval(ballots, candidates) {
  // Approval voting: each ballot is a list of approved candidates.
  const total = Object.create(null);
  for (let i = 0; i < candidates.length; i++) total[candidates[i]] = 0;
  for (let i = 0; i < ballots.length; i++) {
    const b = ballots[i];
    for (let k = 0; k < b.length; k++) {
      const c = b[k];
      if (total[c] !== undefined) total[c] += 1;
    }
  }
  const ranking = candidates.slice().sort(function (a, b) {
    if (total[b] !== total[a]) return total[b] - total[a];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return { winner: ranking[0], ranking: ranking, scores: total };
}

function __pi_aggregate(method, ballots, opts) {
  if (ballots.length === 0) {
    return { winner: null, ranking: [] };
  }
  if (method === 'score') {
    const candidates = __pi_collect_candidates(ballots, 'score');
    return __pi_score(ballots, candidates);
  }
  if (method === 'approval') {
    const candidates = __pi_collect_candidates(ballots, 'approval');
    return __pi_approval(ballots, candidates);
  }
  // ranked methods
  const candidates = __pi_collect_candidates(ballots, 'ranked');
  if (method === 'borda') return __pi_borda(ballots, candidates);
  if (method === 'schulze') return __pi_schulze(ballots, candidates);
  if (method === 'ranked_pairs') return __pi_ranked_pairs(ballots, candidates);
  if (method === 'kemeny_young') return __pi_kemeny_young(ballots, candidates);
  if (method === 'instant_runoff') return __pi_instant_runoff(ballots, candidates);
  if (method === 'coombs') return __pi_coombs(ballots, candidates);
  throw new Error(
    'ctx.aggregate: unknown method "' + method + '" (expected one of: borda, schulze, ranked_pairs, kemeny_young, instant_runoff, coombs, score, approval)',
  );
}
`;

/**
 * Combined sandbox bootstrap source. STDLIB_INIT_SOURCE_HEAD declares
 * the public stdlib (vote/parallel/retry/aggregate/...) and references
 * `__pi_aggregate`, which is implemented in __PI_AGGREGATE_SOURCE__.
 * The two strings are concatenated AFTER both are declared so module
 * load doesn't TDZ on `__PI_AGGREGATE_SOURCE__`.
 */
export const STDLIB_INIT_SOURCE = STDLIB_INIT_SOURCE_HEAD + __PI_AGGREGATE_SOURCE__;
