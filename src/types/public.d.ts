/**
 * pi-workflows — public author-facing types.
 *
 * Per `plan.md` §5.1 this file is checked in from slice 1 but only
 * receives content in slice 8a, when the `ctx` API stabilises and the
 * `import type { ... } from "@samfp/pi-workflows/workflows"` surface
 * starts shipping author-visible types.
 *
 * Frozen-after-8a contract: once 8a lands the public types, no
 * subsequent slice may rename, retype, or remove a public type without
 * a major-version bump.
 *
 * Slice 1 leaves this file empty so the `tsconfig.build.json` declaration
 * emitter has a stable target without forcing every slice to touch the
 * file.
 */

export {};
