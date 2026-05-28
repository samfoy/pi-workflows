/**
 * tests/security/runtimeCtx.security.test.ts — slice 8a SC1+SC2.
 *
 * The host-realm-eval.workflow.js fixture, run with the slice-2 stub
 * `ctx`, verifies that ctx.* method `.constructor` walks land on
 * Context Function. That's a NECESSARY condition but not sufficient:
 * the slice-2 stub is a Context-realm literal (its closures NEVER
 * touch a host method), so the wrap-via-Reflect.apply path isn't
 * actually being exercised.
 *
 * This test runs the SAME fixture with a real `runCtxHost` injected.
 * Now `ctx.agent`/`ctx.phase`/`ctx.cache.*`/`ctx.log` are the
 * `wrapHostSync`/`wrapHostAsync` closures from sandbox.ts that DO
 * delegate to host methods via Reflect.apply. The wrapper-identity
 * oracle still checks `.constructor === Function`.
 *
 * If a future patch removes wrapHostMethod from any of these, this
 * test fails (along with the no-host fixture run — belt-and-braces).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runScript } from "../../src/runtime/sandbox.js";
import type { RunCtxHost } from "../../src/types/internal.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(
  __dirname,
  "fixtures",
  "host-realm-eval.workflow.js",
);

function noopHost(): RunCtxHost {
  // No-op host — every method returns ok with a placeholder. The
  // fixture never CALLS them; it only inspects `.constructor`.
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    runMeta: {
      id: "wf-securitytest1",
      workflowName: "sec",
      startedAt: "1970-01-01T00:00:00Z",
      cwd: ".",
      resumed: false,
    },
    input: "",
    agent: () =>
      ok({
        kind: "agent" as const,
        id: "a",
        prompt: "",
        opts: Object.freeze({}),
      }),
    phase: async () => ok([]),
    cacheGet: async () => ok(undefined),
    cacheSet: async () => ok(null),
    cacheHas: async () => ok(false),
    cacheDelete: async () => ok(null),
    log: () => ok(null),
    finishCallback: () => ok(null),
  };
}

test("slice 8a: host-realm-eval fixture passes with real runCtxHost", async () => {
  const source = readFileSync(FIXTURE_PATH, "utf-8");
  const ctrl = new AbortController();
  const result = await runScript(source, {
    signal: ctrl.signal,
    runCtxHost: noopHost(),
  });
  const r = result.returnValue as Record<string, unknown>;

  // ctx.* probes — the exploit attempts to walk Function constructor.
  for (const key of [
    "ctx-agent",
    "ctx-phase",
    "ctx-cache-get",
    "ctx-log",
    // Slice 8b: stdlib helpers.
    "ctx-vote",
    "ctx-consensus",
    "ctx-parallel",
    "ctx-retry",
    "ctx-sleep",
  ]) {
    const row = r[key] as {
      escaped: boolean;
      envKeys?: number;
      hasExit?: boolean;
      hasBinding?: boolean;
    };
    assert.ok(row, `probe row ${key} present`);
    if (row.escaped === false) continue; // call threw — best.
    assert.equal(row.envKeys, 0, `${key}: env must be empty stub`);
    assert.equal(row.hasExit, false, `${key}: process.exit unreachable`);
    assert.equal(row.hasBinding, false, `${key}: process.binding unreachable`);
  }

  // Wrapper-identity oracle: every ctx.* method's constructor === Context Function.
  const ctxIdent = r["wrapper-identity-ctx"] as Record<string, unknown>;
  assert.equal(ctxIdent.agentCtorIsContextFn, true);
  assert.equal(ctxIdent.phaseCtorIsContextFn, true);
  assert.equal(ctxIdent.cacheGetCtorIsContextFn, true);
  assert.equal(ctxIdent.cacheSetCtorIsContextFn, true);
  assert.equal(ctxIdent.cacheHasCtorIsContextFn, true);
  assert.equal(ctxIdent.cacheDelCtorIsContextFn, true);
  assert.equal(ctxIdent.logCtorIsContextFn, true);

  // Slice 8b: stdlib wrapper-identity oracle. Pure Context-realm
  // closures — if a future patch removes them or routes them through
  // a host shim, .constructor is no longer Context Function.
  const stdlibIdent = r["wrapper-identity-stdlib"] as Record<string, unknown>;
  assert.equal(stdlibIdent.voteCtorIsContextFn, true);
  assert.equal(stdlibIdent.consensusCtorIsContextFn, true);
  assert.equal(stdlibIdent.parallelCtorIsContextFn, true);
  assert.equal(stdlibIdent.retryCtorIsContextFn, true);
  assert.equal(stdlibIdent.sleepCtorIsContextFn, true);

  // Slice 8b: factory must be deleted post-init.
  const stdlibHidden = r["stdlib-factory-hidden"] as Record<string, unknown>;
  assert.equal(stdlibHidden.visibleAsKey, false);
  assert.equal(stdlibHidden.enumerable, false);
  assert.equal(stdlibHidden.fromGetOwnPropDescriptor, false);
});
