/**
 * tests/unit/limits.test.ts — bounds checks on author-facing string sizes.
 *
 * Two limits, two surfaces:
 *   - MAX_PROMPT_LENGTH bounds `ctx.agent(prompt, …)`. Validated in the
 *     Context realm by the wrapped agent helper.
 *   - MAX_INPUT_LENGTH bounds `args` passed to `startWorkflowRun`, which
 *     becomes `ctx.input`. Validated in the host realm before any run
 *     state is materialized.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import { startWorkflowRun } from "../../src/runManager.js";
import {
  MAX_INPUT_LENGTH,
  MAX_PROMPT_LENGTH,
} from "../../src/util/limits.js";
import type {
  AgentResultLike,
  RunCtxHost,
  WorkflowFile,
} from "../../src/types/internal.js";

/** Minimal host so the wrapped ctx.agent in runCtx.ts is reachable. */
function stubHost(): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-limitstest00",
      workflowName: "limits",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: ".",
      resumed: false,
    },
    input: "",
    agent: (prompt, optsArg) => {
      const o =
        optsArg && typeof optsArg === "object"
          ? (optsArg as Record<string, unknown>)
          : {};
      const id = typeof o.id === "string" ? (o.id as string) : "auto";
      return ok({
        kind: "agent" as const,
        id,
        prompt: String(prompt),
        opts: Object.freeze({ id }),
      });
    },
    phase: async (_n, agents) =>
      ok(
        (agents as ReadonlyArray<unknown>).map((h) => {
          const o = h as { id?: string };
          return {
            agentId: o.id ?? "?",
            text: "stub",
            usage: { input: 0, output: 0, totalTokens: 0 },
            durationMs: 0,
            toolCalls: 0,
            transcriptPath: "",
            cached: false,
          };
        }) as AgentResultLike[],
      ),
    cacheGet: async () => ok(undefined),
    cacheSet: async () => ok(null),
    cacheHas: async () => ok(false),
    cacheDelete: async () => ok(null),
    log: () => ok(null),
    finishCallback: () => ok(null),
    getBudgetSpent: () => 0,
    tokenBudget: null,
    progress: () => ok(null),
    checkpoint: async () => ok(false),
    report: () => ok(null),
    gate: async () => ok(true),
    interrupt: async () => ok({ key: "int-0", value: null }),
    memo_check: async () => ok({ hit: false as const }),
    memo_set: async () => ok(null),
  };
}

async function runWith(source: string): Promise<unknown> {
  const ctrl = new AbortController();
  const r = await runScript(source, {
    signal: ctrl.signal,
    runCtxHost: stubHost(),
  });
  return r.returnValue;
}

test("MAX_PROMPT_LENGTH and MAX_INPUT_LENGTH have sensible defaults", () => {
  assert.ok(MAX_INPUT_LENGTH > 0);
  assert.ok(MAX_PROMPT_LENGTH > MAX_INPUT_LENGTH);
  assert.equal(MAX_PROMPT_LENGTH, 256 * 1024);
  assert.equal(MAX_INPUT_LENGTH, 64 * 1024);
});

test("ctx.agent: rejects prompts exceeding MAX_PROMPT_LENGTH with RangeError", async () => {
  const out = (await runWith(
    `
      const big = "x".repeat(${MAX_PROMPT_LENGTH + 1});
      try {
        ctx.agent(big, { id: "a" });
        return { rejected: false };
      } catch (e) {
        return {
          rejected: true,
          isRangeError: e instanceof RangeError,
          name: e?.name,
          message: e?.message,
        };
      }
    `,
  )) as {
    rejected: boolean;
    isRangeError: boolean;
    name: string;
    message: string;
  };
  assert.equal(out.rejected, true);
  assert.equal(out.isRangeError, true, "should be RangeError");
  assert.match(out.message, /MAX_PROMPT_LENGTH/);
  assert.match(out.message, new RegExp(`got ${MAX_PROMPT_LENGTH + 1}`));
});

test("ctx.agent: prompts exactly at MAX_PROMPT_LENGTH are accepted", async () => {
  const out = (await runWith(
    `
      const big = "x".repeat(${MAX_PROMPT_LENGTH});
      const handle = ctx.agent(big, { id: "a" });
      return { accepted: handle?.kind === "agent", id: handle?.id };
    `,
  )) as { accepted: boolean; id: string };
  assert.equal(out.accepted, true);
  assert.equal(out.id, "a");
});

test("startWorkflowRun: rejects input exceeding MAX_INPUT_LENGTH with RangeError", async () => {
  const oversized = "x".repeat(MAX_INPUT_LENGTH + 1);
  const fakeWorkflow: WorkflowFile = {
    name: "irrelevant",
    absPath: "/nonexistent/will-not-be-read.js",
    scope: "personal",
  };
  await assert.rejects(
    () => startWorkflowRun(fakeWorkflow, oversized),
    (err: unknown) =>
      err instanceof RangeError &&
      /MAX_INPUT_LENGTH/.test((err as Error).message) &&
      new RegExp(`got ${oversized.length}`).test((err as Error).message),
  );
});

test("startWorkflowRun: rejects non-string input with TypeError", async () => {
  const fakeWorkflow: WorkflowFile = {
    name: "irrelevant",
    absPath: "/nonexistent/will-not-be-read.js",
    scope: "personal",
  };
  await assert.rejects(
    () => startWorkflowRun(fakeWorkflow, 42 as unknown as string),
    (err: unknown) =>
      err instanceof TypeError &&
      /must be a string/.test((err as Error).message),
  );
});
