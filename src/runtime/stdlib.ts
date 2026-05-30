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
export const STDLIB_INIT_SOURCE = `
'use strict';

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
  // technical text — documented limitation. Authors needing
  // semantic consensus should use \`ctx.agent\` with a judge prompt.
  //
  // \`majorityText\` heuristic: response with the highest mean
  // similarity to all others. For 1 response the heuristic is
  // degenerate; we return \`agreed: true\` and that response.
  function consensus(agents, opts) {
    return Promise.resolve().then(function () {
      if (!Array.isArray(agents)) {
        throw new TypeError('ctx.consensus: agents must be an array');
      }
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
        });
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
      const handles = [];
      function step(i) {
        if (i >= items.length) {
          return ctxRef.current.phase(phaseName, handles);
        }
        // Invoke fn synchronously, then handle the result.
        // Check kind BEFORE Promise.resolve to avoid the then-getter (BUG-001 fix).
        var h = fn(items[i], ctxRef.current);
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
  };
};
`;
