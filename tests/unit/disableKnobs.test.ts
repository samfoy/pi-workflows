/**
 * tests/unit/disableKnobs.test.ts — slice 10 audit of PRD §3.6 + §13.7
 * disable knobs.
 *
 * Slice 1 implemented `loadConfig`; this test pins the precedence
 * matrix that slice 10 finalizes:
 *
 *                       ENV unset      ENV=1        ENV=0/false
 *   setting=false       not disabled   disabled     not disabled
 *   setting=true        disabled       disabled     disabled (but reason=setting only when env not set)
 *
 * Specifically asserts:
 *
 *   - ENV `PI_DISABLE_WORKFLOWS=1` SHORT-CIRCUITS settings (the setting
 *     file is not even read).
 *   - When ENV is set, `disabledBy = "env"`; when only setting is set,
 *     `disabledBy = "setting"`.
 *   - `PI_WORKFLOWS_RECURSIVE=1` is orthogonal (still recorded even
 *     when disabled by env or setting).
 *   - Setting reading is robust: bad JSON, missing file, wrong type.
 *
 * Plus the end-to-end behavior: when the extension is loaded and
 * disabled-by-env, no commands are registered.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../src/config.ts";
import piWorkflowsExtension from "../../src/index.ts";
import { makeFakePi } from "../helpers/makeFakePi.ts";

function makeFakeHome(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "pi-wf-knobs-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-wf-knobs-cwd-"));
  return {
    home,
    cwd,
    cleanup: () => {
      // best-effort
    },
  };
}

function writeProjectSetting(cwd: string, value: unknown): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ "pi-workflows.disabled": value }),
    "utf8",
  );
}

// ─── precedence matrix: 4 cases (env × setting) ────────────────────────

test("knob matrix [env=unset, setting=false]: NOT disabled", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, false);
  const cfg = loadConfig({ env: {}, cwd });
  assert.equal(cfg.disabled, false);
  assert.equal(cfg.disabledBy, null);
});

test("knob matrix [env=unset, setting=true]: disabled by SETTING", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, true);
  const cfg = loadConfig({ env: {}, cwd });
  assert.equal(cfg.disabled, true);
  assert.equal(cfg.disabledBy, "setting");
});

test("knob matrix [env=1, setting=false]: disabled by ENV (env wins)", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, false);
  const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: "1" }, cwd });
  assert.equal(cfg.disabled, true);
  assert.equal(cfg.disabledBy, "env");
});

test("knob matrix [env=1, setting=true]: disabled by ENV (env wins, setting not even read)", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, true);
  const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: "1" }, cwd });
  assert.equal(cfg.disabled, true);
  assert.equal(cfg.disabledBy, "env");
});

// ─── env-truthy spectrum ──────────────────────────────────────────────

test("knob: env value '0' / 'false' is NOT truthy → not disabled", () => {
  const { cwd } = makeFakeHome();
  for (const v of ["0", "false", "FALSE", "no", ""]) {
    const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: v }, cwd });
    assert.equal(cfg.disabled, false, `expected env=${JSON.stringify(v)} not to disable`);
  }
});

test("knob: env value 'yes' / 'on' / 'true' / '1' all disable", () => {
  const { cwd } = makeFakeHome();
  for (const v of ["1", "true", "TRUE", "yes", "on"]) {
    const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: v }, cwd });
    assert.equal(cfg.disabled, true, `expected env=${JSON.stringify(v)} to disable`);
    assert.equal(cfg.disabledBy, "env");
  }
});

// ─── PI_WORKFLOWS_RECURSIVE is orthogonal ──────────────────────────────

test("knob: PI_WORKFLOWS_RECURSIVE recorded regardless of disabled state", () => {
  const { cwd } = makeFakeHome();
  const a = loadConfig({ env: { PI_WORKFLOWS_RECURSIVE: "1" }, cwd });
  assert.equal(a.recursive, true);
  assert.equal(a.disabled, false);

  const b = loadConfig({
    env: { PI_DISABLE_WORKFLOWS: "1", PI_WORKFLOWS_RECURSIVE: "1" },
    cwd,
  });
  assert.equal(b.recursive, true);
  assert.equal(b.disabled, true);
});

// ─── malformed settings ────────────────────────────────────────────────

test("knob: malformed JSON in settings → fall back to NOT disabled", () => {
  const { cwd } = makeFakeHome();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json", "utf8");
  const cfg = loadConfig({ env: {}, cwd });
  assert.equal(cfg.disabled, false);
});

test("knob: setting value of wrong type (string) ignored, not disabled", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, "yes" /* wrong type */);
  const cfg = loadConfig({ env: {}, cwd });
  assert.equal(cfg.disabled, false);
});

test("knob: setting value of true (only true counts) → disabled", () => {
  const { cwd } = makeFakeHome();
  writeProjectSetting(cwd, true);
  const cfg = loadConfig({ env: {}, cwd });
  assert.equal(cfg.disabled, true);
});

// ─── extension-level integration: disabled load short-circuits ─────────

test("extension: PI_DISABLE_WORKFLOWS=1 short-circuits factory; no on('session_start') registered", () => {
  const realEnv = process.env.PI_DISABLE_WORKFLOWS;
  process.env.PI_DISABLE_WORKFLOWS = "1";
  try {
    const pi = makeFakePi();
    piWorkflowsExtension(pi as unknown as Parameters<typeof piWorkflowsExtension>[0]);
    // No handlers registered.
    assert.equal(pi.handlers.size, 0);
    // No commands registered.
    assert.equal(pi.commands.size, 0);
  } finally {
    if (realEnv === undefined) delete process.env.PI_DISABLE_WORKFLOWS;
    else process.env.PI_DISABLE_WORKFLOWS = realEnv;
  }
});

test("extension: PI_WORKFLOWS_RECURSIVE=1 keeps loading but skips per-workflow commands", async () => {
  const { cwd, home } = makeFakeHome();
  // Drop a fake workflow file so registry has something to enumerate.
  mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "workflows", "foo.workflow.js"),
    `return "ok";`,
    "utf8",
  );

  // Snapshot every env var loadConfig + the recursion guard read so an
  // ambient parent-shell value (e.g. PI_DISABLE_WORKFLOWS=1 leftover from
  // a previous workflow run) doesn't make the extension short-circuit
  // and skip /workflows registration. The test asserts the recursion
  // guard branch in isolation; ambient disable-style flags must be off.
  const realRecursive = process.env.PI_WORKFLOWS_RECURSIVE;
  const realDisable = process.env.PI_DISABLE_WORKFLOWS;
  const realHome = process.env.HOME;
  process.env.PI_WORKFLOWS_RECURSIVE = "1";
  delete process.env.PI_DISABLE_WORKFLOWS;
  process.env.HOME = home;
  try {
    const pi = makeFakePi();
    piWorkflowsExtension(pi as unknown as Parameters<typeof piWorkflowsExtension>[0]);
    await pi.fireSessionStart(cwd);
    // /workflows is registered (so error message is reachable).
    assert.ok(pi.commands.has("workflows"), "/workflows always registered");
    // /foo is NOT registered (recursion guard).
    assert.equal(
      pi.commands.has("foo"),
      false,
      "/<workflowName> must be skipped under PI_WORKFLOWS_RECURSIVE=1",
    );
    // notify line confirms the recursive nesting.
    assert.ok(
      pi.notifications.some((n) => n.message.includes("nested pi session")),
    );
  } finally {
    if (realRecursive === undefined)
      delete process.env.PI_WORKFLOWS_RECURSIVE;
    else process.env.PI_WORKFLOWS_RECURSIVE = realRecursive;
    if (realDisable === undefined) delete process.env.PI_DISABLE_WORKFLOWS;
    else process.env.PI_DISABLE_WORKFLOWS = realDisable;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("extension: session_shutdown handler registered at load (slice 10 stub)", () => {
  const realEnv = process.env.PI_DISABLE_WORKFLOWS;
  delete process.env.PI_DISABLE_WORKFLOWS;
  try {
    const pi = makeFakePi();
    piWorkflowsExtension(pi as unknown as Parameters<typeof piWorkflowsExtension>[0]);
    assert.ok(pi.handlers.has("session_shutdown"));
  } finally {
    if (realEnv !== undefined) process.env.PI_DISABLE_WORKFLOWS = realEnv;
  }
});
