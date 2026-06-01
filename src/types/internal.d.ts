/**
 * pi-workflows — internal type definitions (slice 1+).
 *
 * Per `plan.md` §5.1 these are runtime-internal types. They are extended
 * additively by each slice that adds runtime; no slice ever moves a type
 * out of this file. Author-facing types live in `public.d.ts` and are
 * frozen from slice 8a onward.
 *
 * Field-ownership comments tag every later-slice field with the slice
 * number that populates it, so cross-slice contracts stay legible.
 *
 * ─── ARCHITECTURE NOTE ──────────────────────────────────────
 * The 2026 audit flagged this file (1,600+ lines) as a god-types module
 * and recommended a capability-interface-segregation refactor splitting
 * it along its slice boundaries (manifest / extension / sandbox /
 * runCtx-host / cache / agent / ledger / approval). That split is
 * deferred:
 *
 *   - The cross-file fan-in is high (~50 importers across src/ and
 *     tests/), and a partial split would force a same-PR migration of
 *     every consumer.
 *   - The capability boundaries the audit suggested don't all line up
 *     cleanly with the existing slice headers; the right split needs
 *     a focused design pass to avoid landing on a slightly-better
 *     version of the same problem.
 *   - The actual day-to-day pain points the audit named
 *     (`as unknown as` clusters, AgentUsage<:Record, SettledAgent
 *     missing) have already been fixed in-place — see commit
 *     `dd16d3a refactor(types): replace 'as unknown as' cluster in
 *     runCtx`.
 *
 * Until then, slice headers (// ──── Slice N ────) are the navigation
 * primary key. Editor outline-folding gets you the rest of the way.
 */


// ──────────────────────────────────────────────────────────────────────────
// 2026 audit refactor: per-slice type definitions live in ./internal/ now.
// This file is a barrel re-export so all existing
//   `import { ... } from "../types/internal.js"`
// paths keep working unchanged. New code SHOULD prefer importing from the
// specific slice file (e.g. ./internal/dispatcher.js) when only one slice's
// types are needed.
// ──────────────────────────────────────────────────────────────────────────

export * from "./internal/extension.js";
export * from "./internal/sandbox.js";
export * from "./internal/cache.js";
export * from "./internal/concurrency.js";
export * from "./internal/dispatcher.js";
export * from "./internal/ledger.js";
export * from "./internal/approval.js";
export * from "./internal/result.js";
