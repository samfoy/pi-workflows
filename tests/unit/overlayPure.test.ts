/**
 * tests/unit/overlayPure.test.ts — slice 13 pure-helper unit suite.
 *
 * The overlay module's god-component (1461 lines) is tested at the
 * mount-and-drive level in tests/unit/overlay.test.ts. This file
 * targets the pure helpers that don't need a TUI mount:
 *
 *   - narrowEntry / narrowPhaseEntry (ledger event validators)
 *   - shortenId
 *   - runKill (found / not-found / appendEntry-throws / pi-without-appendEntry)
 *   - bindRegistryToFeed contract
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  __narrowForTest,
  bindRegistryToFeed,
  runKill,
} from "../../src/runtime/overlay.js";
import { ActiveRunsRegistry } from "../../src/runtime/activeRuns.js";
import type { ExtensionAPI } from "../../src/types/internal.js";
import type { Run, RunTerminalInfo } from "../../src/runManager.js";

const { narrowEntry, narrowPhaseEntry, shortenId } = __narrowForTest;

function fakeRun(opts: {
  runId: string;
  onStop?: (reason?: string) => void;
}): Run {
  return {
    runId: opts.runId,
    runDirAbs: `/tmp/${opts.runId}`,
    promise: Promise.resolve(undefined),
    signal: AbortSignal.abort(),
    getFinishCallbackPrompt: () => null,
    cancel: () => undefined,
    approvalDecision: null,
    pause: async () => false,
    resumePaused: async () => false,
    stop: opts.onStop ?? (() => undefined),
    terminated: new Promise<RunTerminalInfo>(() => {
      /* never */
    }),
  } as unknown as Run;
}

// ─── shortenId ───────────────────────────────────────────────────────

test("shortenId: <12 chars passes through unchanged", () => {
  assert.equal(shortenId("wf-abc"), "wf-abc");
  assert.equal(shortenId(""), "");
});

test("shortenId: exactly 12 chars passes through (boundary)", () => {
  assert.equal(shortenId("wf-abcdefghi"), "wf-abcdefghi");
});

test("shortenId: >12 chars is truncated to 12", () => {
  assert.equal(shortenId("wf-1234567890abcdef"), "wf-123456789");
});

// ─── narrowEntry: ledger-event validation matrix ────────────────────

test("narrowEntry: rejects null / non-object / array data", () => {
  assert.equal(narrowEntry("pi-workflows.run.started", null), null);
  assert.equal(narrowEntry("pi-workflows.run.started", "string"), null);
  assert.equal(narrowEntry("pi-workflows.run.started", 42), null);
  // Note: arrays are typeof 'object' but the runId check fails via path.
  assert.equal(narrowEntry("pi-workflows.run.started", []), null);
});

test("narrowEntry: rejects payload missing runId", () => {
  assert.equal(narrowEntry("pi-workflows.run.started", { workflowName: "x" }), null);
});

test("narrowEntry: run.started accepts well-formed payload", () => {
  const out = narrowEntry("pi-workflows.run.started", {
    runId: "wf-aa",
    workflowName: "x",
  });
  assert.notEqual(out, null);
  assert.equal(out!.customType, "pi-workflows.run.started");
});

test("narrowEntry: run.transitioned requires toState", () => {
  assert.equal(
    narrowEntry("pi-workflows.run.transitioned", { runId: "wf-aa" }),
    null,
    "missing toState",
  );
  assert.notEqual(
    narrowEntry("pi-workflows.run.transitioned", {
      runId: "wf-aa",
      toState: "paused",
    }),
    null,
  );
});

test("narrowEntry: run.ended requires outcome", () => {
  assert.equal(
    narrowEntry("pi-workflows.run.ended", { runId: "wf-aa" }),
    null,
  );
  assert.notEqual(
    narrowEntry("pi-workflows.run.ended", {
      runId: "wf-aa",
      outcome: "done",
    }),
    null,
  );
});

test("narrowEntry: run.kill-requested has minimal shape (runId only)", () => {
  assert.notEqual(
    narrowEntry("pi-workflows.run.kill-requested", {
      runId: "wf-aa",
      reason: "test",
    }),
    null,
  );
});

test("narrowEntry: unknown customType returns null", () => {
  assert.equal(
    narrowEntry("pi-workflows.unknown.event", { runId: "wf-aa" }),
    null,
  );
});

// ─── narrowPhaseEntry: phase-feed validation matrix ─────────────────

test("narrowPhaseEntry: meta.phases requires phases array", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.meta.phases", { runId: "wf-aa" }),
    null,
  );
  assert.notEqual(
    narrowPhaseEntry("pi-workflows.meta.phases", {
      runId: "wf-aa",
      phases: [{ title: "x" }],
    }),
    null,
  );
});

test("narrowPhaseEntry: phase.started requires phaseName + agentCount(number)", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.phase.started", {
      runId: "wf-aa",
      phaseName: "p",
    }),
    null,
    "missing agentCount",
  );
  assert.equal(
    narrowPhaseEntry("pi-workflows.phase.started", {
      runId: "wf-aa",
      phaseName: "p",
      agentCount: "two", // wrong type
    }),
    null,
  );
  assert.notEqual(
    narrowPhaseEntry("pi-workflows.phase.started", {
      runId: "wf-aa",
      phaseName: "p",
      agentCount: 2,
    }),
    null,
  );
});

test("narrowPhaseEntry: phase.ended requires phaseName", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.phase.ended", { runId: "wf-aa" }),
    null,
  );
});

test("narrowPhaseEntry: agent.started requires phaseName + agentId", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.agent.started", {
      runId: "wf-aa",
      phaseName: "p",
    }),
    null,
  );
  assert.notEqual(
    narrowPhaseEntry("pi-workflows.agent.started", {
      runId: "wf-aa",
      phaseName: "p",
      agentId: "a1",
    }),
    null,
  );
});

test("narrowPhaseEntry: agent.ended requires phaseName + agentId", () => {
  assert.notEqual(
    narrowPhaseEntry("pi-workflows.agent.ended", {
      runId: "wf-aa",
      phaseName: "p",
      agentId: "a1",
    }),
    null,
  );
});

test("narrowPhaseEntry: run.log requires message string", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.run.log", {
      runId: "wf-aa",
      message: 42,
    }),
    null,
  );
  assert.notEqual(
    narrowPhaseEntry("pi-workflows.run.log", {
      runId: "wf-aa",
      message: "hello",
    }),
    null,
  );
});

test("narrowPhaseEntry: unknown customType returns null", () => {
  assert.equal(
    narrowPhaseEntry("pi-workflows.unknown.phase.event", {
      runId: "wf-aa",
    }),
    null,
  );
});

// ─── runKill ─────────────────────────────────────────────────────────

test("runKill: registered run -> stop() called + appendEntry emitted", () => {
  const reg = new ActiveRunsRegistry();
  const stopCalls: string[] = [];
  const run = fakeRun({
    runId: "wf-rk1",
    onStop: (reason) => stopCalls.push(reason ?? "(none)"),
  });
  reg.register("wf-rk1", run, { workflowName: "x" });
  const entries: { type: string; data: unknown }[] = [];
  const pi: ExtensionAPI = {
    appendEntry: (t: string, d?: unknown) => {
      entries.push({ type: t, data: d });
    },
  } as unknown as ExtensionAPI;
  const result = runKill(pi, reg, "wf-rk1", "user-cancel");
  assert.equal(result.found, true);
  assert.equal(result.emittedEntry, true);
  assert.deepEqual(stopCalls, ["user-cancel"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "pi-workflows.run.kill-requested");
});

test("runKill: unregistered runId -> found=false but appendEntry still fires", () => {
  const reg = new ActiveRunsRegistry();
  const entries: { type: string; data: unknown }[] = [];
  const pi: ExtensionAPI = {
    appendEntry: (t: string, d?: unknown) => {
      entries.push({ type: t, data: d });
    },
  } as unknown as ExtensionAPI;
  const result = runKill(pi, reg, "wf-notfound000", "any");
  assert.equal(result.found, false);
  assert.equal(result.emittedEntry, true);
  assert.equal(entries.length, 1);
});

test("runKill: pi without appendEntry returns emittedEntry=false", () => {
  const reg = new ActiveRunsRegistry();
  const run = fakeRun({ runId: "wf-rk3" });
  reg.register("wf-rk3", run, { workflowName: "x" });
  const pi: ExtensionAPI = {} as unknown as ExtensionAPI;
  const result = runKill(pi, reg, "wf-rk3", "reason");
  assert.equal(result.found, true);
  assert.equal(result.emittedEntry, false);
});

test("runKill: appendEntry throwing is swallowed; emittedEntry stays false on throw", () => {
  const reg = new ActiveRunsRegistry();
  const pi: ExtensionAPI = {
    appendEntry: () => {
      throw new Error("boom");
    },
  } as unknown as ExtensionAPI;
  const result = runKill(pi, reg, "wf-anything00", "reason");
  // No throw escapes; emittedEntry stays false because the throw
  // happened before the bookkeeping flag flipped.
  assert.equal(result.emittedEntry, false);
});

test("runKill: Run.stop throwing is swallowed (idempotent semantics)", () => {
  const reg = new ActiveRunsRegistry();
  const run = fakeRun({
    runId: "wf-rk5",
    onStop: () => {
      throw new Error("already stopped");
    },
  });
  reg.register("wf-rk5", run, { workflowName: "x" });
  const pi: ExtensionAPI = {} as unknown as ExtensionAPI;
  // Must not throw.
  const result = runKill(pi, reg, "wf-rk5", "reason");
  assert.equal(result.found, true);
});

// ─── bindRegistryToFeed ──────────────────────────────────────────────

// ─── bindRegistryToFeed ──────────────────────────────────────────────

test("bindRegistryToFeed: monkeypatches pi.appendEntry to also drive the registry", () => {
  const reg = new ActiveRunsRegistry();
  const original: { type: string; data: unknown }[] = [];
  const pi: ExtensionAPI = {
    appendEntry: (t: string, d?: unknown) => {
      original.push({ type: t, data: d });
    },
  } as unknown as ExtensionAPI;

  const dispose = bindRegistryToFeed(pi, reg);
  assert.equal(typeof dispose, "function");

  // Calling the (now-wrapped) appendEntry routes the original side-effect
  // AND drives the registry.
  pi.appendEntry!("pi-workflows.run.started", {
    runId: "wf-fd1",
    workflowName: "demo",
  });
  assert.equal(original.length, 1, "original appendEntry still receives calls");
  assert.equal(reg.getSummary("wf-fd1")?.workflowName, "demo");

  // Malformed entry (no runId) lands on the original but does NOT
  // create a registry summary — narrowEntry returns null.
  pi.appendEntry!("pi-workflows.run.started", { workflowName: "y" });
  assert.equal(original.length, 2);
  assert.equal(reg.total, 1);

  // Unknown customType bypasses.
  pi.appendEntry!("pi-workflows.unknown.event", { runId: "wf-fd2" });
  assert.equal(original.length, 3);
  assert.equal(reg.total, 1);

  // dispose() must not throw.
  assert.doesNotThrow(() => dispose());
});

test("bindRegistryToFeed: pi without appendEntry returns a no-op disposer", () => {
  const reg = new ActiveRunsRegistry();
  const pi: ExtensionAPI = {} as unknown as ExtensionAPI;
  const dispose = bindRegistryToFeed(pi, reg);
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
});
