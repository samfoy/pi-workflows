/**
 * pi-workflows — `workflow` keyword trigger.
 *
 * Pure helpers for the inline keyword-trigger DX described in
 * `docs/gap-analysis/2026-05-31-gap-analysis.md` (row "No
 * keyword-trigger workflow drafting").
 *
 * Pi's extension SDK exposes no `session_primer` hook (see
 * `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
 * event list). The closest equivalents are `input` (fires on user
 * submit, before agent processing) and `before_agent_start` (can
 * mutate the system prompt for that turn). `src/index.ts` wires
 * them together: `input` arms a flag, `before_agent_start` consumes
 * it and injects `WORKFLOW_DIRECTIVE` into the system prompt for that
 * one turn only.
 *
 * Splitting these constants out of `src/index.ts` keeps them
 * testable without booting the extension's full transitive graph
 * (which currently traverses runtime/stdlib.ts and is sensitive to
 * unrelated zone churn).
 */

/**
 * Regex used to decide whether a user prompt should arm the
 * workflow-trigger directive. Word-bounded and case-insensitive so
 * "draft a workflow" and "DRAFT WORKFLOWS" both fire, while compound
 * words like "subworkflow", "workflowy", or "workflowing" do not.
 *
 * The trailing `s?` accepts both singular and plural — the gap doc
 * promises "type `workflow` anywhere in a prompt", and refusing the
 * plural is a sub-optimal interpretation.
 */
export const WORKFLOW_KEYWORD_REGEX = /\bworkflows?\b/i;

/**
 * Single-line notice surfaced via `ctx.ui.notify(...)` when the
 * keyword fires. Kept under 6 lines per gap-doc spec.
 */
export const KEYWORD_NOTICE =
  "[pi-workflows] workflow keyword detected — Claude will write a workflow script for this task";

/**
 * System-prompt directive appended for a single turn after the
 * keyword fires. Multi-line block; the leading newline is intentional
 * so it concatenates cleanly onto whatever the existing prompt is.
 */
export const WORKFLOW_DIRECTIVE = [
  "",
  "## WORKFLOW TRIGGER",
  "The user's prompt contains the word \"workflow\". You MUST respond by",
  "calling the write_workflow tool to create a workflow script for this",
  "task rather than working through it turn-by-turn. Design the workflow",
  "with ctx.phase() for parallel agent fleets, appropriate failMode, and",
  "a clear export const meta header. Call write_workflow with runNow:true",
  "to save and immediately start the run.",
].join("\n");

/**
 * Decide whether a given input event should arm the trigger.
 * Returns false when:
 *   - the event was emitted by another extension (`source === "extension"`)
 *     — guards against feedback loops when pi sends injected messages
 *   - the text starts with `/` — already routed by command dispatch
 *   - the text doesn't match `WORKFLOW_KEYWORD_REGEX`
 *
 * The toggle (`_keywordTriggerEnabled` in `src/index.ts`) is checked
 * by the caller so this helper stays pure.
 */
export function shouldArmKeywordTrigger(event: { text: string; source: string }): boolean {
  if (event.source === "extension") return false;
  if (event.text.trimStart().startsWith("/")) return false;
  return WORKFLOW_KEYWORD_REGEX.test(event.text);
}
