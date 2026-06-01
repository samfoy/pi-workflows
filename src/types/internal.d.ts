/**
 * pi-workflows — internal type definitions barrel.
 *
 * Per `plan.md` §5.1 these are runtime-internal types. Author-facing
 * types live in `public.d.ts` and are frozen from slice 8a onward.
 *
 * ─── LAYOUT ────────────────────────────────────────────────
 * The 2026 audit's god-types finding was addressed in two passes:
 *
 *   - Targeted in-place fixes (commit dd16d3a + 7c7538d): the
 *     `as unknown as` cluster in runCtx, the missing `SettledAgent`
 *     type, and the schema validators (now in src/runtime/schema.ts).
 *
 *   - Per-slice file split: the type definitions themselves now live
 *     under src/types/internal/, one file per slice header. This file
 *     is a barrel that re-exports * from each, so existing
 *     `import { ... } from "../types/internal.js"` paths keep working
 *     unchanged. New code SHOULD prefer the specific slice file when
 *     only one slice's types are needed.
 *
 * Files (size at split-time):
 *   internal/extension.d.ts    Slice 1   423L  workflows, ExtensionAPI, Tui*
 *   internal/sandbox.d.ts      Slice 2   382L  sandbox + RunCtxHost bridge
 *   internal/cache.d.ts        Slice 3    89L  cache record types
 *   internal/concurrency.d.ts  Slice 4    59L  Semaphore + AcquireToken
 *   internal/dispatcher.d.ts   Slice 6   216L  Agent*, Dispatcher*, Spawn*
 *   internal/ledger.d.ts       Slice 7   293L  RunState, LedgerEntry union
 *   internal/approval.d.ts     Slice 9   143L  Trust*, ApprovalDialog
 *   internal/result.d.ts       Slice 10  130L  RunOutcome, ResultCard*
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
