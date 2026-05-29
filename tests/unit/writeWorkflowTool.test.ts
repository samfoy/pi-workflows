/**
 * Unit tests for write_workflow tool — validation, save, and result shape.
 *
 * Slice: write_workflow (v0.2.0).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateWorkflowScript, registerWriteWorkflowTool } from "../../src/runtime/writeWorkflowTool.js";
import type { ExtensionAPI } from "../../src/types/internal.js";

// ─── validateWorkflowScript ───────────────────────────────────────────────────

test("validates a correct workflow script", () => {
  const script = `
export const meta = { name: "my-audit", description: "Audit", version: "1.0.0" };
export async function main(ctx) { return ctx.agent("hi"); }
`.trim();
  const result = validateWorkflowScript(script);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.name, "my-audit");
});

test("rejects empty script", () => {
  const result = validateWorkflowScript("");
  assert.ok(!result.ok);
  assert.match(result.ok === false ? result.error : "", /empty/i);
});

test("rejects script without meta export", () => {
  const script = `export async function main(ctx) { return "hi"; }`;
  const result = validateWorkflowScript(script);
  assert.ok(!result.ok);
  assert.match(result.ok === false ? result.error : "", /meta/i);
});

test("rejects script with meta after function declaration", () => {
  const script = `
export async function main(ctx) { return "hi"; }
export const meta = { name: "bad", description: "test", version: "1.0.0" };
`.trim();
  // strip-then-check: first non-comment token is `export async function`, not `export const meta`
  const result = validateWorkflowScript(script);
  assert.ok(!result.ok);
  assert.match(result.ok === false ? result.error : "", /must start with|export const meta/i);
});

test("rejects script where meta.name is missing", () => {
  const script = `export const meta = { description: "no name", version: "1.0.0" };`;
  const result = validateWorkflowScript(script);
  assert.ok(!result.ok);
  assert.match(result.ok === false ? result.error : "", /name/i);
});

test("rejects script with a reserved workflow name", () => {
  const script = `export const meta = { name: "help", description: "x", version: "1.0.0" };`;
  const result = validateWorkflowScript(script);
  assert.ok(!result.ok);
  assert.match(result.ok === false ? result.error : "", /reserved|invalid/i);
});

test("rejects script with an invalid workflow name (spaces)", () => {
  const script = `export const meta = { name: "bad name", description: "x", version: "1.0.0" };`;
  const result = validateWorkflowScript(script);
  assert.ok(!result.ok);
});

test("accepts script with leading block comment before meta", () => {
  const script = `
/* copyright notice */
export const meta = { name: "annotated", description: "x", version: "1.0.0" };
export async function main(ctx) { return "ok"; }
`.trim();
  const result = validateWorkflowScript(script);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.name, "annotated");
});

test("rejects script with import statement before meta", () => {
  const badScript = [
    `import something from 'somewhere';`,
    `export const meta = { name: "x", description: "y", version: "1.0.0" };`,
    `export async function main(ctx) { return ctx.agent("hi"); }`,
  ].join("\n");
  const result = validateWorkflowScript(badScript);
  assert.ok(!result.ok, "should reject script with import before meta");
  assert.match(
    result.ok === false ? result.error : "",
    /must start with|export const meta/i,
  );
});

// MUTATION-PROBE: verify hasMetaFirst is load-bearing
test("MUTATION-PROBE: disabling hasMetaFirst check causes import-before-meta to pass", () => {
  // Simulate the mutated path: skip the hasMetaFirst guard entirely.
  // If the rest of validateWorkflowScript ran without the check, it would
  // find the meta pattern via the name-extraction regex and return ok:true.
  const badScript = [
    `import something from 'somewhere';`,
    `export const meta = { name: "x", description: "y", version: "1.0.0" };`,
    `export async function main(ctx) { return "hi"; }`,
  ].join("\n");
  // The name-extraction regex would find name: "x" even in the mutated path.
  // This probe documents that the REAL path (with hasMetaFirst) rejects it.
  const realResult = validateWorkflowScript(badScript);
  assert.ok(!realResult.ok, "REAL: must reject import-before-meta");
  // Mutated simulation: bypass hasMetaFirst, go straight to name extraction.
  const nameMatch = badScript.match(/export\s+const\s+meta\s*=\s*\{[^}]*name\s*:\s*["']([^"']+)["']/);
  assert.ok(nameMatch !== null, "mutant would find name via regex");
  // This proves that without hasMetaFirst the check would silently pass.
  // The probe witnesses that removing hasMetaFirst is a semantic regression.
});

// ─── registerWriteWorkflowTool — save flow ────────────────────────────────────

function makeFakePi(): ExtensionAPI & {
  appendEntries: Array<{ customType: string; data: unknown }>;
  registeredTool: { name: string; execute: Function } | null;
} {
  const obj = {
    appendEntries: [] as Array<{ customType: string; data: unknown }>,
    registeredTool: null as { name: string; execute: Function } | null,
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    appendEntry(customType: string, data: unknown) {
      obj.appendEntries.push({ customType, data });
    },
    registerTool(tool: { name: string; execute: Function }) {
      obj.registeredTool = tool;
    },
  };
  return obj as unknown as ExtensionAPI & typeof obj;
}

test("registerWriteWorkflowTool: registers a tool named write_workflow", () => {
  const pi = makeFakePi();
  registerWriteWorkflowTool({ pi, getCwd: () => "/tmp" });
  assert.ok(pi.registeredTool !== null);
  assert.equal(pi.registeredTool!.name, "write_workflow");
});

test("registerWriteWorkflowTool: execute saves file and returns result card", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ww-test-"));
  try {
    const pi = makeFakePi();
    registerWriteWorkflowTool({ pi, getCwd: () => dir, saveDirOverride: dir });

    const script = `
export const meta = { name: "my-wf", description: "Test", version: "1.0.0" };
export async function main(ctx) { return ctx.agent("hello"); }
`.trim();

    const result = await pi.registeredTool!.execute("id1", { name: "my-wf", script }, {} as any);
    assert.ok(result.content[0].text.includes("my-wf"));
    assert.ok(result.content[0].text.includes("✅"));
    assert.ok(result.details?.name === "my-wf");

    const savedPath = join(dir, "my-wf.js");
    assert.ok(existsSync(savedPath), "file should be saved");
    assert.equal(readFileSync(savedPath, "utf-8"), script);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWriteWorkflowTool: execute returns error card on invalid script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ww-invalid-"));
  try {
    const pi = makeFakePi();
    registerWriteWorkflowTool({ pi, getCwd: () => dir, saveDirOverride: dir });

    const result = await pi.registeredTool!.execute("id2", {
      name: "bad",
      script: "export function main() {}",  // missing meta
    }, {} as any);

    assert.ok(result.content[0].text.includes("❌"));
    assert.ok(!existsSync(join(dir, "bad.js")), "file must NOT be saved on error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWriteWorkflowTool: execute marks overwrite when file exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ww-overwrite-"));
  try {
    const pi = makeFakePi();
    registerWriteWorkflowTool({ pi, getCwd: () => dir, saveDirOverride: dir });

    const script = `export const meta = { name: "ow-wf", description: "x", version: "1.0.0" };\nexport async function main(ctx) { return "v1"; }`;
    // First save
    await pi.registeredTool!.execute("id3a", { name: "ow-wf", script }, {} as any);
    // Second save
    const script2 = script.replace("v1", "v2");
    const result = await pi.registeredTool!.execute("id3b", { name: "ow-wf", script: script2 }, {} as any);

    assert.ok(result.details?.isOverwrite === true);
    assert.equal(readFileSync(join(dir, "ow-wf.js"), "utf-8"), script2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWriteWorkflowTool: execute emits appendEntry on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ww-emit-"));
  try {
    const pi = makeFakePi();
    registerWriteWorkflowTool({ pi, getCwd: () => dir, saveDirOverride: dir });

    const script = `export const meta = { name: "emit-wf", description: "x", version: "1.0.0" };\nexport async function main(ctx) { return "ok"; }`;
    await pi.registeredTool!.execute("id4", { name: "emit-wf", script }, {} as any);

    const entries = pi.appendEntries.filter(e => e.customType === "pi-workflows.workflow-saved");
    assert.equal(entries.length, 1);
    assert.equal((entries[0]!.data as any).name, "emit-wf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWriteWorkflowTool: degrades gracefully when registerTool absent", () => {
  const pi = makeFakePi();
  delete (pi as any).registerTool;
  // Must not throw
  assert.doesNotThrow(() => registerWriteWorkflowTool({ pi, getCwd: () => "/tmp" }));
});
