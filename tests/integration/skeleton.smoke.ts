/**
 * tests/integration/skeleton.smoke.ts — extension load + slash invocation.
 *
 * Acceptance per `plan.md` §4 Slice 1:
 *   - Drop `<tmp>/.pi/workflows/foo.js` → `pi.commands` map contains `/foo`
 *   - Invoking `/foo` returns the stub message
 *   - `/workflows` is registered and lists the discovered workflow names
 *   - PI_DISABLE_WORKFLOWS=1 short-circuits at extension-load (no
 *     commands are registered)
 *   - PI_WORKFLOWS_RECURSIVE=1 short-circuits per-workflow registration
 *     while keeping `/workflows` registered (with the documented
 *     "disabled in nested pi sessions" body)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piWorkflowsExtension from "../../src/index.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

interface SmokeFixture {
  readonly cwd: string;
  readonly projectWorkflows: string;
  readonly cleanup: () => void;
}

function makeFixture(): SmokeFixture {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-smoke-"));
  const projectWorkflows = join(cwd, ".pi", "workflows");
  mkdirSync(projectWorkflows, { recursive: true });
  return {
    cwd,
    projectWorkflows,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

/**
 * Save & restore env vars so individual tests can mutate them safely.
 * Without this, a test that sets `PI_DISABLE_WORKFLOWS=1` would
 * pollute later tests.
 */
function withEnv<R>(
  vars: Record<string, string | undefined>,
  fn: () => R,
): R {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) original[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("smoke: drops foo.js → /foo registered → invoking returns stub", async () => {
  const fix = makeFixture();
  try {
    writeFileSync(
      join(fix.projectWorkflows, "foo.js"),
      "export default async function (ctx, input) { return 'hi'; }",
    );

    await withEnv(
      { PI_DISABLE_WORKFLOWS: undefined, PI_WORKFLOWS_RECURSIVE: undefined },
      async () => {
        const pi = makeFakePi({ cwd: fix.cwd });
        // Boot the extension. Any session_start handler is registered.
        piWorkflowsExtension(pi);
        // Fire session_start to drive discovery + command registration.
        await pi.fireSessionStart(fix.cwd);

        // /foo is registered.
        assert.ok(
          pi.commands.has("foo"),
          `expected /foo to be registered; got [${[...pi.commands.keys()].join(", ")}]`,
        );

        // /workflows is registered.
        assert.ok(pi.commands.has("workflows"));

        // Invoke /foo — observe a stub sendMessage. Slice 8a:
        // workflowCmd actually starts a run via RunManager; we get a
        // "started workflow ..." card (or the runtime-init failure
        // fallback if anything goes wrong).
        await pi.invokeCommand("foo", "");
        const stubMsg = pi.messages.find(
          (m) => m.customType === "pi-workflows.stub",
        );
        assert.ok(stubMsg, "expected a stub message after /foo invocation");
        assert.match(
          stubMsg!.content,
          /Workflow "foo" started|started workflow|runtime-init failed/,
          "slice-10 stub body should report run-start or init-failure",
        );
        assert.deepEqual(
          (stubMsg!.details as { workflowName: string }).workflowName,
          "foo",
        );
      },
    );
  } finally {
    fix.cleanup();
  }
});

test("smoke: /workflows lists discovered workflow names", async () => {
  const fix = makeFixture();
  try {
    writeFileSync(join(fix.projectWorkflows, "alpha.js"), "// a");
    writeFileSync(join(fix.projectWorkflows, "beta.js"), "// b");

    await withEnv(
      { PI_DISABLE_WORKFLOWS: undefined, PI_WORKFLOWS_RECURSIVE: undefined },
      async () => {
        const pi = makeFakePi({ cwd: fix.cwd });
        piWorkflowsExtension(pi);
        await pi.fireSessionStart(fix.cwd);
        await pi.invokeCommand("workflows", "");

        const card = pi.messages.find(
          (m) => m.customType === "pi-workflows.stub",
        );
        assert.ok(card, "/workflows should produce a sendMessage card");
        assert.match(card!.content, /\/alpha/, "listing should mention /alpha");
        assert.match(card!.content, /\/beta/, "listing should mention /beta");
        // Slice-1 hint that the TUI overlay is not yet here.
        assert.match(card!.content, /TUI overlay lands in slice 13/);
      },
    );
  } finally {
    fix.cleanup();
  }
});

test("smoke: PI_DISABLE_WORKFLOWS=1 short-circuits — no commands registered", async () => {
  const fix = makeFixture();
  try {
    writeFileSync(join(fix.projectWorkflows, "foo.js"), "// nope");

    await withEnv({ PI_DISABLE_WORKFLOWS: "1" }, async () => {
      const pi = makeFakePi({ cwd: fix.cwd });
      piWorkflowsExtension(pi);
      // No session_start handler should have been registered either.
      // (The `if (initialCfg.disabled) return;` short-circuits before
      // pi.on("session_start", ...) is called.)
      assert.equal(
        (pi.handlers.get("session_start") ?? []).length,
        0,
        "no session_start handler should be registered when disabled",
      );
      assert.equal(pi.commands.size, 0);
    });
  } finally {
    fix.cleanup();
  }
});

test("smoke: PI_WORKFLOWS_RECURSIVE=1 skips /<name> but keeps /workflows", async () => {
  const fix = makeFixture();
  try {
    writeFileSync(join(fix.projectWorkflows, "foo.js"), "// nope");

    await withEnv(
      { PI_DISABLE_WORKFLOWS: undefined, PI_WORKFLOWS_RECURSIVE: "1" },
      async () => {
        const pi = makeFakePi({ cwd: fix.cwd });
        piWorkflowsExtension(pi);
        await pi.fireSessionStart(fix.cwd);

        // Per PRD §13.7: /<name> is NOT registered.
        assert.ok(!pi.commands.has("foo"), "/foo must not be registered in recursive mode");
        // But /workflows IS registered, so users in nested sessions can
        // see the disabled message.
        assert.ok(pi.commands.has("workflows"));

        // And invoking /workflows in recursive mode returns the
        // documented error.
        await pi.invokeCommand("workflows", "");
        const card = pi.messages.find(
          (m) => m.customType === "pi-workflows.stub",
        );
        assert.ok(card);
        assert.match(card!.content, /workflows are disabled in nested pi sessions/);
      },
    );
  } finally {
    fix.cleanup();
  }
});

test("smoke: skipped files surface as ctx.ui.notify warnings", async () => {
  const fix = makeFixture();
  try {
    writeFileSync(join(fix.projectWorkflows, "ok.js"), "// good");
    writeFileSync(join(fix.projectWorkflows, "bad.txt"), "// nope");
    writeFileSync(join(fix.projectWorkflows, "workflows.js"), "// reserved");

    await withEnv(
      { PI_DISABLE_WORKFLOWS: undefined, PI_WORKFLOWS_RECURSIVE: undefined },
      async () => {
        const pi = makeFakePi({ cwd: fix.cwd });
        piWorkflowsExtension(pi);
        await pi.fireSessionStart(fix.cwd);

        // /ok is registered.
        assert.ok(pi.commands.has("ok"));
        // The two bad files surfaced as warnings.
        const warnings = pi.notifications.filter((n) => n.type === "warning");
        assert.ok(
          warnings.some((w) => w.message.includes("bad.txt")),
          `expected a warning mentioning bad.txt; got ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          warnings.some((w) => w.message.includes("workflows.js")),
          `expected a warning mentioning workflows.js; got ${JSON.stringify(warnings)}`,
        );
      },
    );
  } finally {
    fix.cleanup();
  }
});
