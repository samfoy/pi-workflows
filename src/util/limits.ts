/**
 * src/util/limits.ts — author-facing input size limits.
 *
 * Two values, both measured in UTF-16 code units (the units `String.length`
 * returns) for cheap bounds checking in the Context realm:
 *
 *   MAX_PROMPT_LENGTH (256 KB) — bound on `ctx.agent(prompt, …)` strings.
 *     Picks 256K because (a) ~64K tokens is comfortable headroom for
 *     prompts that splice in file dumps, (b) it's well under the
 *     practical LLM context window the dispatcher proxies to (200K-1M
 *     tokens), and (c) it's a hard ceiling — workflow authors who
 *     actually need more should chunk their input rather than trust
 *     a single agent call.
 *
 *   MAX_INPUT_LENGTH (64 KB) — bound on `ctx.input` (the slash-command
 *     argument). 64K is generous: legitimate slash-command args fit in
 *     a single shell line, and an unbounded value gets persisted into
 *     manifest.json + ledger entries on every run, so a 100 MB payload
 *     would clobber disk and grep tooling silently.
 *
 * Limits are deliberately conservative — better to surface
 * `ctx.agent: prompt exceeds N` to the author at the call site than to
 * pass an attacker-sized string through to the dispatcher and let it
 * surface as a token-budget overrun, an OTel attribute truncation, or
 * a manifest write failure.
 */

/** Hard cap on the `prompt` string passed to `ctx.agent(prompt, …)`. */
export const MAX_PROMPT_LENGTH = 256 * 1024;

/** Hard cap on the slash-command / `run_workflow` `input` string exposed via `ctx.input`. */
export const MAX_INPUT_LENGTH = 64 * 1024;
