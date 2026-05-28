/**
 * pi-workflows — run id generator.
 *
 * Per PRD §6.2 + §4.2.7: `runId` is `wf-` + 12 hex chars, where the hex
 * is randomly generated per run. 48 bits of entropy is enough for the
 * single-host use case (collision odds < 1e-7 over 1k runs/day for 100
 * years per birthday-paradox math).
 *
 * `randomBytes` from `node:crypto` is the entropy source — same module
 * the rest of the codebase uses for sha256.
 *
 * Slice 8a owner. Slice 11 (resume) reads existing run ids; doesn't
 * mint new ones.
 */

import { randomBytes } from "node:crypto";

const RUN_ID_PREFIX = "wf-";
const RUN_ID_HEX_LEN = 12;

/**
 * Mint a new run id. Format: `wf-<12 lowercase hex chars>`.
 *
 * Tests pass an injectable `rng` for determinism. Production callers
 * use the default.
 */
export function newRunId(opts: { rng?: () => Buffer } = {}): string {
  const rng = opts.rng ?? (() => randomBytes(6));
  const hex = rng().toString("hex").slice(0, RUN_ID_HEX_LEN);
  if (!/^[0-9a-f]{12}$/.test(hex)) {
    throw new Error(
      `pi-workflows: rng produced invalid hex "${hex}" (expected 12 lowercase hex chars)`,
    );
  }
  return RUN_ID_PREFIX + hex;
}

/** Validate that a string matches the `wf-<12 hex>` shape. */
export function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^wf-[0-9a-f]{12}$/.test(value);
}
