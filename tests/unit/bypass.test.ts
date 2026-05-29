/**
 * tests/unit/bypass.test.ts — slice 9 bypass detector.
 *
 * Coverage matrix:
 *   - PI_BYPASS_PERMISSIONS=1 → bypass=true + banner
 *   - PI_PROMPT_MODE=1 + trusted → bypass=true, no banner
 *   - PI_PROMPT_MODE=1 + untrusted → bypass=false + error
 *   - PI_WORKFLOWS_SDK=1 → bypass=true, no banner
 *   - --mock-agents → bypass=true, no banner
 *   - precedence: PI_BYPASS_PERMISSIONS wins over PI_PROMPT_MODE
 *   - banner is byte-exact per PRD §7.5 critic checklist
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BYPASS_PERMISSIONS_BANNER,
  PI_P_UNTRUSTED_ERROR,
  checkBypass,
} from "../../src/runtime/bypass.ts";

const TRUSTED = {
  "/abs/x.workflow.js": [{ name: "x", sha256: "abc" }],
};
const UNTRUSTED = {};

test("PI_BYPASS_PERMISSIONS=1 → bypass with exact banner per PRD §7.5", () => {
  const r = checkBypass({
    env: { PI_BYPASS_PERMISSIONS: "1" },
    trust: UNTRUSTED,
    absPath: "/abs/x.workflow.js",
    sha256: "abc",
  });
  assert.equal(r.bypass, true);
  assert.equal(r.reason, "bypass-permissions");
  assert.equal(r.banner, BYPASS_PERMISSIONS_BANNER);
});

test("BYPASS BANNER is byte-exact (critic checklist)", () => {
  // Per plan §4 Slice 9 critic checklist. If anyone retypes the banner
  // string this test catches the divergence.
  assert.equal(
    BYPASS_PERMISSIONS_BANNER,
    "\u26a0 pi-workflows: this run is bypassed by --bypass-permissions; " +
      "sub-agents inherit bypass.",
  );
});

test("PI_PROMPT_MODE + trusted → bypass=true, reason=pi-p-trusted, no banner", () => {
  const r = checkBypass({
    env: { PI_PROMPT_MODE: "1" },
    trust: TRUSTED,
    absPath: "/abs/x.workflow.js",
    sha256: "abc",
  });
  assert.equal(r.bypass, true);
  assert.equal(r.reason, "pi-p-trusted");
  assert.equal(r.banner, undefined);
});

test("PI_PROMPT_MODE + untrusted → bypass=false + error message", () => {
  const r = checkBypass({
    env: { PI_PROMPT_MODE: "1" },
    trust: UNTRUSTED,
    absPath: "/abs/x.workflow.js",
    sha256: "abc",
  });
  assert.equal(r.bypass, false);
  assert.equal(r.reason, "pi-p-untrusted");
  assert.equal(r.error, PI_P_UNTRUSTED_ERROR);
  assert.match(r.error!, /not yet trusted/);
  assert.match(r.error!, /run interactively first/);
});

test("PI_PROMPT_MODE + sha mismatch → untrusted (slice-2 revision)", () => {
  const r = checkBypass({
    env: { PI_PROMPT_MODE: "1" },
    trust: TRUSTED,
    absPath: "/abs/x.workflow.js",
    sha256: "OTHER-HASH",
  });
  assert.equal(r.bypass, false);
  assert.equal(r.reason, "pi-p-untrusted");
});

test("PI_WORKFLOWS_SDK=1 → bypass without banner", () => {
  const r = checkBypass({
    env: { PI_WORKFLOWS_SDK: "1" },
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.bypass, true);
  assert.equal(r.reason, "sdk");
  assert.equal(r.banner, undefined);
});

test("mockAgents=true → bypass without banner", () => {
  const r = checkBypass({
    env: {},
    mockAgents: true,
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.bypass, true);
  assert.equal(r.reason, "mock-agents");
});

test("PI_WORKFLOWS_MOCK_AGENTS=1 env also triggers mock bypass", () => {
  const r = checkBypass({
    env: { PI_WORKFLOWS_MOCK_AGENTS: "1" },
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.bypass, true);
  assert.equal(r.reason, "mock-agents");
});

test("precedence: PI_BYPASS_PERMISSIONS wins over PI_PROMPT_MODE", () => {
  const r = checkBypass({
    env: { PI_BYPASS_PERMISSIONS: "1", PI_PROMPT_MODE: "1" },
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.reason, "bypass-permissions");
});

test("precedence: PI_BYPASS_PERMISSIONS wins over mock-agents", () => {
  const r = checkBypass({
    env: { PI_BYPASS_PERMISSIONS: "1" },
    mockAgents: true,
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.reason, "bypass-permissions");
  assert.equal(r.banner, BYPASS_PERMISSIONS_BANNER);
});

test("no env vars + not mock → bypass=false (dialog must run)", () => {
  const r = checkBypass({
    env: {},
    trust: UNTRUSTED,
    absPath: "/abs/x",
    sha256: "abc",
  });
  assert.equal(r.bypass, false);
  assert.equal(r.reason, null);
});
