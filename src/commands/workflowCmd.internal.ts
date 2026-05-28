/**
 * pi-workflows — internal helpers for slash-command stub messages.
 *
 * **Test access pattern (slice-2 establishes).** This file is the
 * canonical example of the convention: anything a unit test needs
 * to import from a runtime module that is *not* part of the package's
 * public surface (`exports` map in `package.json`) lives in a
 * `*.internal.ts` sibling. Tests import from the `.internal.ts`
 * directly via a relative path; production code (e.g.
 * `workflowCmd.ts`) re-imports the same names.
 *
 * Why not `__testInternals` exports on the production module?
 *   - bloats the production module's surface,
 *   - leaks into bundler tree-shaking analysis,
 *   - tempts other production code into reaching for "test-only" names.
 *
 * Why not a single `tests/helpers/internalAccessor.ts`?
 *   - couples test helpers to absolute paths into `src/`, which breaks
 *     when modules move,
 *   - makes it harder to discover which internals are exposed.
 *
 * The `.internal.ts` convention scales: every later slice that needs
 * test-only access to a runtime helper drops a `<module>.internal.ts`
 * next to the production file.
 *
 * NOTE: this file MUST NOT export a `default` and MUST NOT do any
 * side-effectful imports (e.g. fs, vm) so importing it from a test
 * is cheap.
 */

import type {
  WorkflowFile,
  WorkflowRegistry,
} from "../types/internal.js";

export const STUB_BODY =
  "workflows runtime not yet wired in this slice (v0.1 development)";

export const STUB_CUSTOM_TYPE = "pi-workflows.stub";

export function stubDescription(file: WorkflowFile): string {
  return `Workflow ${file.name} (${file.scope}; slice-1 stub — runtime not wired)`;
}

export function stubMessage(file: WorkflowFile): string {
  return [
    `▶ ${STUB_BODY}`,
    `  workflow: ${file.name}`,
    `  source:   ${file.absPath}`,
    `  scope:    ${file.scope}`,
    "",
    "This is the slice-1 skeleton. The runtime (sandbox, cache,",
    "dispatcher, ledger, overlay, approval flow) lands in slices 2-17.",
    "Track progress in plan.md.",
  ].join("\n");
}

export function formatRegistryListing(registry: WorkflowRegistry): string {
  if (registry.size === 0) {
    return [
      "no workflows discovered",
      "",
      "drop a `.js` file in `<projectRoot>/.pi/workflows/` or",
      "`~/.pi/agent/workflows/` and `/reload` to register it.",
    ].join("\n");
  }
  const rows: string[] = [
    `${registry.size} workflow(s) discovered (TUI overlay lands in slice 13):`,
    "",
  ];
  // Sort for deterministic output.
  const sorted = [...registry.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const f of sorted) {
    rows.push(`  /${f.name}  (${f.scope})  ${f.absPath}`);
  }
  rows.push("");
  rows.push("invoke any of the above with arguments, e.g. `/<name> hello`.");
  return rows.join("\n");
}
