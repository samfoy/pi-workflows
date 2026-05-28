/**
 * tests/unit/config.test.ts — disable knobs and recursion env.
 *
 * Acceptance per `plan.md` §4 Slice 1:
 *   - `PI_DISABLE_WORKFLOWS=1` short-circuits before settings read
 *   - setting alone disables
 *   - both off → enabled
 *   - `PI_WORKFLOWS_RECURSIVE=1` is observed independent of disable
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../src/config.ts";

function withProject(settingsContent: string | null): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-cfg-"));
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  if (settingsContent !== null) {
    writeFileSync(join(piDir, "settings.json"), settingsContent);
  }
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("config: PI_DISABLE_WORKFLOWS=1 short-circuits (no settings read)", () => {
  // No settings at all. Env wins.
  const { cwd, cleanup } = withProject(null);
  try {
    const cfg = loadConfig({
      env: { PI_DISABLE_WORKFLOWS: "1" },
      cwd,
    });
    assert.equal(cfg.disabled, true);
    assert.equal(cfg.disabledBy, "env");
    assert.equal(cfg.recursive, false);
  } finally {
    cleanup();
  }
});

test("config: PI_DISABLE_WORKFLOWS=1 wins over a setting that says enabled", () => {
  // Even though the setting explicitly says NOT disabled, env still
  // disables. Order: env first, hard kill.
  const { cwd, cleanup } = withProject(
    JSON.stringify({ "pi-workflows.disabled": false, unrelated: "x" }),
  );
  try {
    const cfg = loadConfig({
      env: { PI_DISABLE_WORKFLOWS: "true" },
      cwd,
    });
    assert.equal(cfg.disabled, true);
    assert.equal(cfg.disabledBy, "env");
  } finally {
    cleanup();
  }
});

test("config: setting alone disables when env is unset", () => {
  const { cwd, cleanup } = withProject(
    JSON.stringify({ "pi-workflows.disabled": true }),
  );
  try {
    const cfg = loadConfig({ env: {}, cwd });
    assert.equal(cfg.disabled, true);
    assert.equal(cfg.disabledBy, "setting");
  } finally {
    cleanup();
  }
});

test("config: both off → enabled", () => {
  const { cwd, cleanup } = withProject(
    JSON.stringify({ "pi-workflows.disabled": false }),
  );
  try {
    const cfg = loadConfig({ env: {}, cwd });
    assert.equal(cfg.disabled, false);
    assert.equal(cfg.disabledBy, null);
    assert.equal(cfg.recursive, false);
  } finally {
    cleanup();
  }
});

test("config: missing settings file with env unset → enabled", () => {
  // No settings file, no env — extension is enabled.
  const { cwd, cleanup } = withProject(null);
  try {
    const cfg = loadConfig({ env: {}, cwd });
    assert.equal(cfg.disabled, false);
    assert.equal(cfg.disabledBy, null);
  } finally {
    cleanup();
  }
});

test("config: malformed settings.json never crashes (falls back to enabled)", () => {
  const { cwd, cleanup } = withProject("{ this is not json :::");
  try {
    const cfg = loadConfig({ env: {}, cwd });
    assert.equal(cfg.disabled, false);
    assert.equal(cfg.disabledBy, null);
  } finally {
    cleanup();
  }
});

test("config: PI_WORKFLOWS_RECURSIVE=1 is observed regardless of disable", () => {
  // Recursive flag is independent — set with extension enabled.
  const { cwd, cleanup } = withProject(null);
  try {
    const cfg = loadConfig({
      env: { PI_WORKFLOWS_RECURSIVE: "1" },
      cwd,
    });
    assert.equal(cfg.disabled, false);
    assert.equal(cfg.recursive, true);
  } finally {
    cleanup();
  }

  // And again with disable on — both flags set.
  const { cwd: cwd2, cleanup: cleanup2 } = withProject(null);
  try {
    const cfg = loadConfig({
      env: { PI_DISABLE_WORKFLOWS: "1", PI_WORKFLOWS_RECURSIVE: "1" },
      cwd: cwd2,
    });
    assert.equal(cfg.disabled, true);
    assert.equal(cfg.disabledBy, "env");
    assert.equal(cfg.recursive, true);
  } finally {
    cleanup2();
  }
});

test("config: env truthy parser accepts 1, true, yes, on (case-insensitive)", () => {
  for (const raw of ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON"]) {
    const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: raw }, cwd: "/" });
    assert.equal(cfg.disabled, true, `should be disabled for env=${raw}`);
  }
  for (const raw of ["0", "false", "no", "off", "", "  "]) {
    const cfg = loadConfig({ env: { PI_DISABLE_WORKFLOWS: raw }, cwd: "/" });
    assert.equal(cfg.disabled, false, `should be enabled for env=${raw}`);
  }
});

test("config: bad-typed setting (string instead of bool) is treated as not disabled", () => {
  const { cwd, cleanup } = withProject(
    JSON.stringify({ "pi-workflows.disabled": "true" }),
  );
  try {
    const cfg = loadConfig({ env: {}, cwd });
    // We require strict `=== true` — a string "true" is NOT acceptable.
    // This protects users who typo their settings.json.
    assert.equal(cfg.disabled, false);
  } finally {
    cleanup();
  }
});
