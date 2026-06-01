/**
 * tests/integration/aggregateErrorPropagation.test.ts — slice 8a F4.
 *
 * Per PRD §4.2.2 + §8.3.4: when `ctx.phase` rejects because of multiple
 * agent failures, the rejection MUST be an `AggregateError` whose
 * `.errors` are reconstructed across the realm boundary. Distinct
 * error classes (`MalformedAgentOutputError`, `AgentSubprocessError`,
 * `MockFixtureMissingError`, generic Error) must preserve their
 * `.name` and `.message` after reconstruction.
 *
 * This test stubs the dispatcher to throw the three error classes
 * deterministically (no real subprocess). The Context-realm script
 * catches the AggregateError and returns shape-checked introspection
 * back to the host.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentResult,
  DispatcherOptions,
  WorkflowFile,
} from "../../src/types/internal.js";
import {
  AgentSubprocessError,
  MalformedAgentOutputError,
} from "../../src/runtime/errors.js";
import { startWorkflowRun } from "../../src/runManager.js";

function tmpRunsRoot(): {
  resolveRunDir: (id: string) => string;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-wf-agg-"));
  return {
    root,
    resolveRunDir: (id) => {
      const d = join(root, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

const wf: (path: string) => WorkflowFile = (absPath) => ({
  name: "agg",
  absPath,
  scope: "personal",
});

test("ctx.phase rejection: AggregateError preserves both error classes", async () => {
  const { root, resolveRunDir } = tmpRunsRoot();
  const wfPath = join(root, "agg.workflow.js");
  writeFileSync(
    wfPath,
    `
      const a1 = ctx.agent("ok", { id: "a1" });
      const a2 = ctx.agent("malformed", { id: "a2" });
      const a3 = ctx.agent("subproc", { id: "a3" });
      let caught = null;
      try {
        await ctx.phase("fail-phase", [a1, a2, a3]);
      } catch (e) {
        caught = {
          isAggregateError: e instanceof AggregateError,
          isError: e instanceof Error,
          name: e.name,
          message: e.message,
          errorsCount: Array.isArray(e.errors) ? e.errors.length : -1,
          errorNames: Array.isArray(e.errors)
            ? e.errors.map((c) => (c && c.name) || "?")
            : [],
          errorMessages: Array.isArray(e.errors)
            ? e.errors.map((c) => (c && c.message) || "?")
            : [],
          // Confirm the reconstructed children are Context-realm Errors
          childIsCtxError: Array.isArray(e.errors)
            ? e.errors.map((c) => c instanceof Error)
            : [],
        };
      }
      return caught;
    `,
    "utf8",
  );

  // Stub dispatch: a1 succeeds, a2 throws MalformedAgentOutputError,
  // a3 throws AgentSubprocessError.
  const stubDispatch = async (opts: DispatcherOptions): Promise<AgentResult> => {
    if (opts.agentId === "a1") {
      return {
        ok: true,
        agentId: "a1",
        text: "OK",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        toolCalls: 0,
        durationMs: 1,
        transcriptPath: "",
        exitCode: 0,
      };
    }
    if (opts.agentId === "a2") {
      throw new MalformedAgentOutputError({
        agentId: "a2",
        cwd: opts.cwd,
        exitCode: 1,
        bytes: "{garbage",
        lineNumber: 3,
        reason: "parse",
      });
    }
    if (opts.agentId === "a3") {
      throw new AgentSubprocessError({
        agentId: "a3",
        exitCode: null,
        signal: "SIGTERM",
      });
    }
    throw new Error(`unexpected agent ${opts.agentId}`);
  };

  const run = await startWorkflowRun(wf(wfPath), "", {
    mockAgents: false, // we fully stub the dispatcher
    preApproved: true,
    dispatch: stubDispatch,
    cwd: root,
    resolveRunDir,
  });

  const captured = (await run.promise) as {
    isAggregateError: boolean;
    isError: boolean;
    name: string;
    message: string;
    errorsCount: number;
    errorNames: string[];
    errorMessages: string[];
    childIsCtxError: boolean[];
  };

  assert.equal(captured.isAggregateError, true, "rejection is AggregateError");
  assert.equal(captured.isError, true, "AggregateError instanceof Error");
  assert.equal(captured.name, "AggregateError");
  assert.match(captured.message, /fail-phase.*2.*3 agents rejected/);
  assert.equal(captured.errorsCount, 2, "errors.length === 2");
  // Order of settled rejections is non-deterministic — sort for stability.
  const names = [...captured.errorNames].sort();
  assert.deepEqual(
    names,
    ["AgentSubprocessError", "MalformedAgentOutputError"].sort(),
    "both error classes preserved by name",
  );
  assert.equal(
    captured.childIsCtxError.every((b) => b),
    true,
    "every reconstructed child is a Context-realm Error",
  );
  // Each error message contains the agent id.
  const allMsgs = captured.errorMessages.join(" | ");
  assert.match(allMsgs, /agent=a2/);
  assert.match(allMsgs, /agent=a3/);
});

test("ctx.phase failMode='null': preserves schema output on fulfilled agents when a sibling fails", async () => {
  // Regression: the failMode='null' branch built result entries inline
  // and dropped the `output` field, so any successful agent that
  // produced schema-parsed JSON lost its parsed payload whenever a
  // sibling rejected. The all-success path preserved it; the
  // any-failure path did not.
  const { root, resolveRunDir } = tmpRunsRoot();
  const wfPath = join(root, "schema-output.workflow.js");
  writeFileSync(
    wfPath,
    `
      const findingSchema = {
        type: "object",
        required: ["area", "findings"],
        properties: {
          area: { type: "string" },
          findings: { type: "array" },
        },
      };
      const a1 = ctx.agent("ok", { id: "a1", schema: findingSchema });
      const a2 = ctx.agent("boom", { id: "a2", schema: findingSchema });
      const results = await ctx.phase("recon", [a1, a2], { failMode: "null" });
      return {
        len: results.length,
        firstHasOutput: !!(results[0] && results[0].output),
        firstOutput: results[0] ? results[0].output : null,
        secondIsNull: results[1] === null,
      };
    `,
    "utf8",
  );

  // Stub dispatch: a1 returns valid JSON in a fenced block; a2 throws.
  const stubDispatch = async (opts: DispatcherOptions): Promise<AgentResult> => {
    if (opts.agentId === "a1") {
      return {
        ok: true,
        agentId: "a1",
        text:
          'Here is the report:\n\n```json\n' +
          '{"area": "quality", "findings": [{"title": "x"}]}\n' +
          '```',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        toolCalls: 0,
        durationMs: 1,
        transcriptPath: "",
        exitCode: 0,
      };
    }
    if (opts.agentId === "a2") {
      throw new AgentSubprocessError({
        agentId: "a2",
        exitCode: null,
        signal: "SIGTERM",
      });
    }
    throw new Error(`unexpected agent ${opts.agentId}`);
  };

  const run = await startWorkflowRun(wf(wfPath), "", {
    mockAgents: false,
    preApproved: true,
    dispatch: stubDispatch,
    cwd: root,
    resolveRunDir,
  });

  const captured = (await run.promise) as {
    len: number;
    firstHasOutput: boolean;
    firstOutput: { area?: string; findings?: unknown[] } | null;
    secondIsNull: boolean;
  };

  assert.equal(captured.len, 2);
  assert.equal(captured.secondIsNull, true, "failed agent slot is null");
  assert.equal(
    captured.firstHasOutput,
    true,
    "fulfilled agent's schema output survives failMode='null' alongside a failing sibling",
  );
  assert.equal(captured.firstOutput?.area, "quality");
  assert.equal(
    Array.isArray(captured.firstOutput?.findings),
    true,
    "findings array is preserved",
  );
});
