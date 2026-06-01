/**
 * Unit tests for run_workflow tool — registration, lookup, dispatch, errors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatRegistryHint,
  normaliseWorkflowName,
  registerRunWorkflowTool,
} from "../../src/runtime/runWorkflowTool.js";
import type { ExtensionAPI, WorkflowFile } from "../../src/types/internal.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFakePi(): ExtensionAPI & {
  registeredTool: { name: string; execute: Function } | null;
  appendEntries: Array<{ customType: string; data: unknown }>;
} {
  const obj = {
    registeredTool: null as { name: string; execute: Function } | null,
    appendEntries: [] as Array<{ customType: string; data: unknown }>,
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

function fakeWorkflow(
  name: string,
  scope: "project" | "personal" = "project",
): WorkflowFile {
  return { name, absPath: `/tmp/.pi/workflows/${name}.js`, scope };
}

// ─── normaliseWorkflowName ───────────────────────────────────────────────────

test("normaliseWorkflowName: passes through bare names", () => {
  assert.equal(normaliseWorkflowName("audit-and-improve"), "audit-and-improve");
});

test("normaliseWorkflowName: strips leading slash", () => {
  assert.equal(normaliseWorkflowName("/audit-and-improve"), "audit-and-improve");
});

test("normaliseWorkflowName: strips multiple leading slashes", () => {
  assert.equal(normaliseWorkflowName("///codebase-audit"), "codebase-audit");
});

test("normaliseWorkflowName: trims surrounding whitespace", () => {
  assert.equal(normaliseWorkflowName("  /deep-research  "), "deep-research");
});

// ─── formatRegistryHint ──────────────────────────────────────────────────────

test("formatRegistryHint: empty registry yields write_workflow nudge", () => {
  const hint = formatRegistryHint(new Map());
  assert.match(hint, /No workflows registered/);
  assert.match(hint, /write_workflow/);
});

test("formatRegistryHint: lists workflows alphabetically with scope", () => {
  const reg = new Map<string, WorkflowFile>([
    ["zeta", fakeWorkflow("zeta", "personal")],
    ["alpha", fakeWorkflow("alpha", "project")],
  ]);
  const hint = formatRegistryHint(reg);
  const alphaIdx = hint.indexOf("/alpha");
  const zetaIdx = hint.indexOf("/zeta");
  assert.ok(alphaIdx !== -1 && zetaIdx !== -1);
  assert.ok(alphaIdx < zetaIdx, "alpha should appear before zeta");
  assert.match(hint, /\(project\)/);
  assert.match(hint, /\(personal\)/);
});

// ─── registration ────────────────────────────────────────────────────────────

test("registerRunWorkflowTool: registers a tool named run_workflow", () => {
  const pi = makeFakePi();
  registerRunWorkflowTool({
    pi,
    getRegistry: () => new Map(),
    startRun: async () => {},
  });
  assert.ok(pi.registeredTool !== null);
  assert.equal(pi.registeredTool!.name, "run_workflow");
});

test("registerRunWorkflowTool: degrades gracefully when registerTool absent", () => {
  const pi = makeFakePi();
  delete (pi as Partial<typeof pi>).registerTool;
  assert.doesNotThrow(() =>
    registerRunWorkflowTool({
      pi,
      getRegistry: () => new Map(),
      startRun: async () => {},
    }),
  );
});

// ─── execute: lookup miss ────────────────────────────────────────────────────

test("execute: missing workflow returns error card with available list", async () => {
  const pi = makeFakePi();
  const reg = new Map<string, WorkflowFile>([
    ["audit-and-improve", fakeWorkflow("audit-and-improve")],
    ["codebase-audit", fakeWorkflow("codebase-audit")],
  ]);
  let startRunCalled = false;
  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async () => {
      startRunCalled = true;
    },
  });

  const result = await pi.registeredTool!.execute(
    "id1",
    { name: "does-not-exist" },
    {} as unknown,
  );

  assert.equal(startRunCalled, false, "startRun must NOT be called on miss");
  assert.match(result.content[0].text, /❌/);
  assert.match(result.content[0].text, /does-not-exist/);
  assert.match(result.content[0].text, /audit-and-improve/);
  assert.match(result.content[0].text, /codebase-audit/);
  assert.equal(result.details?.error, "workflow-not-found");
  assert.deepEqual(result.details?.available, [
    "audit-and-improve",
    "codebase-audit",
  ]);
});

test("execute: leading slash on requested name still resolves", async () => {
  const pi = makeFakePi();
  const reg = new Map<string, WorkflowFile>([
    ["audit-and-improve", fakeWorkflow("audit-and-improve")],
  ]);
  let startedName: string | null = null;
  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async (wf) => {
      startedName = wf.name;
    },
  });

  const result = await pi.registeredTool!.execute(
    "id-slash",
    { name: "/audit-and-improve" },
    {} as unknown,
  );

  assert.equal(startedName, "audit-and-improve");
  assert.equal(result.details?.runStarted, true);
});

// ─── execute: success path ───────────────────────────────────────────────────

test("execute: dispatches startRun with workflow + input + ctx", async () => {
  const pi = makeFakePi();
  const wf = fakeWorkflow("my-flow", "personal");
  const reg = new Map([["my-flow", wf]]);
  let receivedWorkflow: WorkflowFile | null = null;
  let receivedInput: string | null = null;
  let receivedCtx: unknown = null;

  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async (workflow, input, ctx) => {
      receivedWorkflow = workflow;
      receivedInput = input;
      receivedCtx = ctx;
    },
  });

  const fakeCtx = { ui: { notify: () => {} } };
  const result = await pi.registeredTool!.execute(
    "id-ok",
    { name: "my-flow", input: "src/auth" },
    fakeCtx as unknown,
  );

  assert.deepEqual(receivedWorkflow, wf);
  assert.equal(receivedInput, "src/auth");
  assert.equal(receivedCtx, fakeCtx);
  assert.match(result.content[0].text, /▶/);
  assert.match(result.content[0].text, /my-flow/);
  assert.match(result.content[0].text, /src\/auth/);
  assert.equal(result.details?.runStarted, true);
  assert.equal(result.details?.scope, "personal");
});

test("execute: omitted input defaults to empty string", async () => {
  const pi = makeFakePi();
  const reg = new Map([["x", fakeWorkflow("x")]]);
  let received: string | null = null;
  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async (_wf, input) => {
      received = input;
    },
  });

  await pi.registeredTool!.execute("id2", { name: "x" }, {} as unknown);
  assert.equal(received, "");
});

// ─── execute: startRun failure ───────────────────────────────────────────────

test("execute: startRun throws — returns error card without crashing", async () => {
  const pi = makeFakePi();
  const reg = new Map([["broken", fakeWorkflow("broken")]]);
  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async () => {
      throw new Error("approval denied");
    },
  });

  const result = await pi.registeredTool!.execute(
    "id-err",
    { name: "broken" },
    {} as unknown,
  );

  assert.match(result.content[0].text, /⚠/);
  assert.match(result.content[0].text, /approval denied/);
  assert.equal(result.details?.error, "start-failed");
  assert.equal(result.details?.name, "broken");
  assert.equal(result.details?.message, "approval denied");
});

test("execute: registry getter is called per invocation (sees hot-reload changes)", async () => {
  const pi = makeFakePi();
  const reg = new Map<string, WorkflowFile>();
  registerRunWorkflowTool({
    pi,
    getRegistry: () => reg,
    startRun: async () => {},
  });

  // First call: empty registry → miss
  const r1 = await pi.registeredTool!.execute(
    "id-pre",
    { name: "late" },
    {} as unknown,
  );
  assert.equal(r1.details?.error, "workflow-not-found");

  // Simulate hot-reload registering the workflow
  reg.set("late", fakeWorkflow("late"));

  // Second call: registry populated → success
  const r2 = await pi.registeredTool!.execute(
    "id-post",
    { name: "late" },
    {} as unknown,
  );
  assert.equal(r2.details?.runStarted, true);
});
