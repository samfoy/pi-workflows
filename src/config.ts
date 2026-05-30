/**
 * pi-workflows — config loader.
 *
 * Per PRD §3.6 the disable order is:
 *
 *   1. `PI_DISABLE_WORKFLOWS=1` env (hard kill switch — wins).
 *   2. `pi-workflows.disabled: true` setting (project then user).
 *
 * Both checks run at extension load. `PI_WORKFLOWS_RECURSIVE=1` is a
 * separate dispatcher-set hint that doesn't disable the extension but
 * does suppress `registerCommand` for discovered workflow files
 * (PRD §3.6 + §13.7). The slice-1 entry point (`src/index.ts`) reads
 * `loadConfig()` once at `session_start` and acts on the result.
 *
 * Setting reading is done by direct file I/O against `settings.json`
 * (PRD §11; matches pi-conductor's pattern). pi-coding-agent does not
 * yet expose a typed `getSetting()` API; until it does we read the
 * documented locations directly.
 *
 * Bad-typed values fall back to defaults silently (forward-compat with
 * future settings that may collide with our key prefix). Malformed JSON
 * does the same — we never crash the session over a bad settings file.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./types/internal.js";

const ENV_DISABLE = "PI_DISABLE_WORKFLOWS";
const ENV_RECURSIVE = "PI_WORKFLOWS_RECURSIVE";
const SETTING_DISABLED = "pi-workflows.disabled";
const SETTING_AUTO_RESUME = "pi-workflows.autoResumeCrashedWorkflows";

export interface LoadConfigOpts {
  /** Overrides `process.env` — used by tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides `process.cwd()` — used by tests and the session_start cb. */
  readonly cwd?: string;
}

export function loadConfig(opts: LoadConfigOpts = {}): Config {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Step 1: env wins. PRD §3.6.
  if (truthy(env[ENV_DISABLE])) {
    return {
      disabled: true,
      recursive: truthy(env[ENV_RECURSIVE]),
      disabledBy: "env",
      autoResumeCrashedWorkflows: false,
    };
  }

  // Step 2: settings. Project then user (project would shadow user, but
  // for a boolean kill-switch we only care that *someone* set it true).
  const projectSettings = projectSettingsPath(cwd);
  const userSettings = userSettingsPath();

  const settingDisabled =
    readBoolSetting(projectSettings, SETTING_DISABLED) ||
    readBoolSetting(userSettings, SETTING_DISABLED);

  if (settingDisabled) {
    return {
      disabled: true,
      recursive: truthy(env[ENV_RECURSIVE]),
      disabledBy: "setting",
      autoResumeCrashedWorkflows: false,
    };
  }

  // Read optional feature flags — project shadow user (first truthy wins).
  const autoResumeCrashedWorkflows =
    readBoolSetting(projectSettings, SETTING_AUTO_RESUME) ||
    readBoolSetting(userSettings, SETTING_AUTO_RESUME);

  return {
    disabled: false,
    recursive: truthy(env[ENV_RECURSIVE]),
    disabledBy: null,
    autoResumeCrashedWorkflows,
  };
}

/**
 * `1`, `true`, `yes`, `on` (case-insensitive) → true. Anything else
 * (including unset) → false. Mirrors pi-coding-agent's own env
 * truthy/falsy rules so users don't have to remember which flavour
 * each extension uses.
 */
function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function userSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function readBoolSetting(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // Malformed JSON — never crash a session over this.
  }
  if (!parsed || typeof parsed !== "object") return false;
  const v = (parsed as Record<string, unknown>)[key];
  return v === true;
}
