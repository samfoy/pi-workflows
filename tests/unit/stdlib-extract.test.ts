/**
 * tests/unit/stdlib-extract.test.ts — gap-fix coverage for ctx.extractJSON
 * (exposed inside the sandbox) and the host-side post-parse schema
 * validation (validateAgainstSchema + SchemaValidationError).
 *
 * Mirror tests for the host extractJson() (already under stdlib.test.ts)
 * plus the in-sandbox extractor and the new validator.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runScript } from "../../src/runtime/sandbox.js";
import {
  validateAgainstSchema,
  SchemaValidationError,
} from "../../src/runtime/runCtx.js";
import type {
  RunCtxHost,
} from "../../src/types/internal.js";

function stubHost(): RunCtxHost {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-extract",
      workflowName: "extract",
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
    phase: async (_n, agentsArg) => {
      const handles = (agentsArg as ReadonlyArray<unknown>).map((h) => {
        const o = h as { id?: string };
        return { id: o.id ?? "?" };
      });
      return ok(
        handles.map((h) => ({
          agentId: h.id,
          text: "stub:" + h.id,
          usage: { input: 0, output: 0, totalTokens: 0 },
          durationMs: 0,
          toolCalls: 0,
          transcriptPath: "",
          cached: false,
        })),
      );
    },
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
    interrupt: async () => ok(null),
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

// Cross-realm comparison helper: JSON-roundtrip strips Context-realm
// prototypes and produces host-realm POJOs that deepEqual cleanly.
function j(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ─── ctx.extractJSON inside the sandbox ────────────────────────────

test("ctx.extractJSON: parses fenced JSON block (last fence wins)", async () => {
  const out = await runWith(`
    const text = "first try:\\n\\u0060\\u0060\\u0060json\\n{\\"old\\":true}\\n\\u0060\\u0060\\u0060\\nupdated:\\n\\u0060\\u0060\\u0060json\\n{\\"new\\":true}\\n\\u0060\\u0060\\u0060";
    return ctx.extractJSON(text);
  `);
  assert.deepEqual(j(out), { new: true });
});

test("ctx.extractJSON: bracket scan when no fence", async () => {
  const out = await runWith(`
    return ctx.extractJSON('Sure: {"x":1,"nested":{"y":[1,2,3]}}');
  `);
  assert.deepEqual(j(out), { x: 1, nested: { y: [1, 2, 3] } });
});

test("ctx.extractJSON: handles escaped quotes inside strings", async () => {
  const out = await runWith(`
    return ctx.extractJSON('prefix {"k":"a \\\\"quoted\\\\" b"} trailing prose');
  `);
  assert.deepEqual(j(out), { k: 'a "quoted" b' });
});

test("ctx.extractJSON: arrays in bracket scan", async () => {
  const out = await runWith(`return ctx.extractJSON("results: [1,2,3]");`);
  assert.deepEqual(j(out), [1, 2, 3]);
});

test("ctx.extractJSON: throws TypeError for non-string input", async () => {
  await assert.rejects(
    runWith(`return ctx.extractJSON(42);`),
    /text must be a string/,
  );
});

test("ctx.extractJSON: throws when no JSON found", async () => {
  await assert.rejects(
    runWith(`return ctx.extractJSON("nothing here");`),
    /no JSON found/,
  );
});

// ─── validateAgainstSchema (host) ──────────────────────────────────

test("validateAgainstSchema: object with required fields passes", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer" } },
    required: ["name", "count"],
  };
  validateAgainstSchema({ name: "sam", count: 3 }, schema);
});

test("validateAgainstSchema: missing required throws SchemaValidationError", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  assert.throws(
    () => validateAgainstSchema({}, schema),
    (e: unknown) => {
      assert.ok(e instanceof SchemaValidationError);
      assert.match((e as Error).message, /\$\.name/);
      return true;
    },
  );
});

test("validateAgainstSchema: type mismatch throws", () => {
  const schema = { type: "object", properties: { n: { type: "number" } } };
  assert.throws(
    () => validateAgainstSchema({ n: "hi" }, schema),
    (e: unknown) => {
      assert.ok(e instanceof SchemaValidationError);
      const err = e as SchemaValidationError;
      assert.equal(err.path, "$.n");
      assert.equal(err.expected, "number");
      assert.equal(err.actual, "string");
      return true;
    },
  );
});

test("validateAgainstSchema: integer requires integer (not float)", () => {
  const schema = { type: "integer" };
  assert.throws(
    () => validateAgainstSchema(1.5, schema),
    SchemaValidationError,
  );
  validateAgainstSchema(7, schema);
});

test("validateAgainstSchema: number accepts integer", () => {
  validateAgainstSchema(7, { type: "number" });
  validateAgainstSchema(7.5, { type: "number" });
});

test("validateAgainstSchema: array.items recurses", () => {
  const schema = { type: "array", items: { type: "string" } };
  validateAgainstSchema(["a", "b"], schema);
  assert.throws(
    () => validateAgainstSchema(["a", 2], schema),
    (e: unknown) => {
      assert.ok(e instanceof SchemaValidationError);
      assert.equal((e as SchemaValidationError).path, "$[1]");
      return true;
    },
  );
});

test("validateAgainstSchema: enum constraint", () => {
  validateAgainstSchema("high", { enum: ["high", "med", "low"] });
  assert.throws(
    () => validateAgainstSchema("foo", { enum: ["high", "med", "low"] }),
    SchemaValidationError,
  );
});

test("validateAgainstSchema: additionalProperties:false rejects extras", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  validateAgainstSchema({ a: "x" }, schema);
  assert.throws(
    () => validateAgainstSchema({ a: "x", b: 1 }, schema),
    SchemaValidationError,
  );
});

test("validateAgainstSchema: nested object", () => {
  const schema = {
    type: "object",
    properties: {
      angles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "number" },
          },
          required: ["id"],
        },
      },
    },
    required: ["angles"],
  };
  validateAgainstSchema({ angles: [{ id: "a" }, { id: "b", score: 0.5 }] }, schema);
  assert.throws(
    () => validateAgainstSchema({ angles: [{ id: 7 }] }, schema),
    SchemaValidationError,
  );
});

test("validateAgainstSchema: union types", () => {
  const schema = { type: ["string", "null"] };
  validateAgainstSchema(null, schema);
  validateAgainstSchema("hi", schema);
  assert.throws(() => validateAgainstSchema(42, schema), SchemaValidationError);
});
