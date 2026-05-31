/**
 * tests/unit/overlay.test.ts — slice 13 mount + non-TTY fallback +
 * re-open no-op + hotkey routing through the registry.
 *
 * These tests don't drive a real pi-tui; they use fakePi.ui.custom
 * (defined in makeFakePi) which captures the factory and lets us
 * push synthetic key strokes via `mount.component.handleInput(key)`.
 *
 * Concern coverage:
 *
 *   - F2: `x` hotkey on a registered run calls `Run.stop()`.
 *   - F4: `p` toggles to `pause` (running) / `resume` (paused) and
 *     forwards to `run.pause()` / `run.resumePaused()`.
 *   - re-open no-op: a second `/workflows` while overlay is open
 *     returns `mode: "already-open"` (PRD §10.1).
 *   - non-TTY fallback: with `forceTTY: false`, mount falls back to
 *     a sendMessage card carrying the runs-list lines.
 *   - help-line marks disabled hotkeys per F1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeFakePi } from "../helpers/makeFakePi.js";
import {
  ActiveRunsRegistry,
  __setActiveRunsSingletonForTest,
} from "../../src/runtime/activeRuns.js";
import {
  mountOverlay,
  __resetOverlayOpenForTest,
  __isOverlayOpenForTest,
  type OverlayHandleForTest,
} from "../../src/runtime/overlay.js";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";
import type { Run, RunTerminalInfo } from "../../src/runManager.js";

function fakeRun(opts: {
  runId: string;
  pause?: () => Promise<boolean>;
  resumePaused?: () => Promise<boolean>;
  stop?: () => void;
}): Run {
  let resolveTerm!: (info: RunTerminalInfo) => void;
  const term = new Promise<RunTerminalInfo>((res) => {
    resolveTerm = res;
  });
  const run: Run & { _terminate: (info?: Partial<RunTerminalInfo>) => void } = {
    runId: opts.runId,
    runDirAbs: `/tmp/${opts.runId}`,
    promise: new Promise(() => {
      /* never */
    }),
    signal: new AbortController().signal,
    getFinishCallbackPrompt: () => null,
    cancel: () => undefined,
    approvalDecision: null,
    pause: opts.pause ?? (async () => false),
    resumePaused: opts.resumePaused ?? (async () => false),
    stop: opts.stop ?? (() => undefined),
    terminated: term,
    _terminate: (info = {}) =>
      resolveTerm({
        runId: opts.runId,
        workflowName: "demo",
        runDirAbs: `/tmp/${opts.runId}`,
        outcome: "stopped",
        startedAt: "2026-05-29T00:00:00Z",
        endedAt: "2026-05-29T00:00:01Z",
        durationMs: 1000,
        result: undefined,
        error: null,
        agentCount: 0,
        finishCallbackPrompt: null,
        approval: null,
        ...info,
      }),
  } as Run & { _terminate: (info?: Partial<RunTerminalInfo>) => void };
  return run;
}

test.beforeEach(() => {
  __resetOverlayOpenForTest();
  __setActiveRunsSingletonForTest(null);
});

test("non-TTY fallback: sendMessage card with runs-list lines", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  registry.applyEntry({
    customType: "pi-workflows.run.started",
    data: {
      runId: "wf-nontty01",
      workflowName: "demo",
      startedAt: "2026-05-29T00:00:00Z",
    },
  });

  // Build a minimal command ctx (notify only — no `custom` so the
  // overlay falls back).
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      // omit `custom` to force fallback even if forceTTY=true
    },
  };

  const result = await mountOverlay({
    pi,
    ctx,
    registry,
    forceTTY: true, // even with forceTTY=true, missing `custom` triggers fallback
  });
  assert.equal(result.mounted, false);
  assert.equal(result.mode, "no-custom-api");

  const card = pi.messages.find(
    (m) => m.customType === "pi-workflows.overlay-fallback",
  );
  assert.ok(card, "fallback card emitted");
  assert.match(card!.content, /wf-nontty01/);
});

test("PRD §10.1: re-opening `/workflows` while overlay is mounted is a no-op", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  // Build a ctx that mounts via fakePi.ui.custom.
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      custom: pi.commands.size === 0 ? undefined : undefined, // placeholder
    },
  };
  // Use the fakePi's own custom by extracting it via invokeCommand
  // semantics: register a no-op command and read the ctx out of its
  // handler.
  let capturedCtx: typeof ctx | null = null;
  pi.registerCommand("test-mount", {
    handler: async (_args, c) => {
      capturedCtx = c as unknown as typeof ctx;
    },
  });
  await pi.invokeCommand("test-mount", "");
  assert.ok(capturedCtx, "ctx captured");
  // With forceTTY=true AND ctx.ui.custom defined, the overlay mounts.
  const r1 = await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    forceTTY: true,
  });
  assert.equal(r1.mounted, true);
  assert.equal(r1.mode, "tui");
  assert.equal(__isOverlayOpenForTest(), true);

  // Second call → already-open.
  const r2 = await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    forceTTY: true,
  });
  assert.equal(r2.mounted, false);
  assert.equal(r2.mode, "already-open");

  // Close via the captured component.
  const mount = pi.overlayMounts[0];
  assert.ok(mount);
  mount!.component.dispose?.();
  mount!.done();
});

test("F2: `x` on a registered run calls Run.stop() via the overlay", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  let stopCalls = 0;
  const run = fakeRun({
    runId: "wf-killtest1",
    stop: () => {
      stopCalls++;
    },
  });
  registry.register("wf-killtest1", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-29T00:00:00Z",
  });

  let capturedCtx:
    | (NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]>)
    | null = null;
  pi.registerCommand("c", {
    handler: async (_a, c) => {
      capturedCtx = c as unknown as typeof capturedCtx;
    },
  });
  await pi.invokeCommand("c", "");
  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    forceTTY: true,
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);
  // Send `x` → should route through dispatchHotkey → stop action →
  // runKill helper → run.stop().
  mount!.component.handleInput!("x");
  assert.equal(stopCalls, 1, "Run.stop must be invoked exactly once");

  // appendEntry kill-requested also fired.
  const killEntry = pi.entries.find(
    (e) => e.customType === "pi-workflows.run.kill-requested",
  );
  assert.ok(killEntry, "kill-requested entry emitted");
  mount!.done();
});

test("F4: `p` toggles pause↔resume by current state", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  let pauseCalls = 0;
  let resumeCalls = 0;
  const run = fakeRun({
    runId: "wf-pause001",
    pause: async () => {
      pauseCalls++;
      return true;
    },
    resumePaused: async () => {
      resumeCalls++;
      return true;
    },
  });
  registry.register("wf-pause001", run, {
    workflowName: "demo",
    state: "running",
    startedAt: "2026-05-29T00:00:00Z",
  });

  let capturedCtx: { cwd: string; ui: { notify: () => void } } | null = null;
  pi.registerCommand("c2", {
    handler: async (_a, c) => {
      capturedCtx = c as never;
    },
  });
  await pi.invokeCommand("c2", "");
  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    forceTTY: true,
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);
  // Running → `p` pauses.
  mount!.component.handleInput!("p");
  await Promise.resolve();
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 0);

  // Flip the registry summary to paused (the real handle would fire
  // a `transitioned` entry; we simulate it directly).
  registry.applyEntry({
    customType: "pi-workflows.run.transitioned",
    data: { runId: "wf-pause001", toState: "paused" },
  });
  await Promise.resolve();
  await Promise.resolve();
  // Wait for debounced overlay snapshot refresh (default 30ms).
  await new Promise((r) => setTimeout(r, 50));
  mount!.component.handleInput!("p");
  await Promise.resolve();
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);
  mount!.done();
});

test("BUG-007: dispose() cleans up phase subscription, appendEntry shim, and debounce timers", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();

  // Track phase-listener subscription count — a leaked unsubPhase would
  // leave the registry with a listener pointing at dead state.
  let phaseListenerFired = 0;
  const origPhaseSubscribe = phaseRegistry.subscribe.bind(phaseRegistry);
  // @ts-ignore -- spy wrapper
  phaseRegistry.subscribe = (listener: (rid: string) => void) => {
    const unsub = origPhaseSubscribe(listener);
    return () => {
      phaseListenerFired++; // counts unsubscribe calls
      unsub();
    };
  };

  // Capture the original appendEntry so we can check it's restored.
  const originalAppendEntry = pi.appendEntry;

  let capturedCtx: NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]> | null = null;
  pi.registerCommand("bug007", {
    handler: async (_a, c) => {
      capturedCtx = c as unknown as typeof capturedCtx;
    },
  });
  await pi.invokeCommand("bug007", "");

  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    phaseRegistry,
    forceTTY: true,
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount, "overlay must have mounted");

  // Verify appendEntry was shimmed by the overlay.
  assert.notEqual(
    pi.appendEntry,
    originalAppendEntry,
    "appendEntry should be shimmed while overlay is open",
  );

  // dispose() — simulates pi-tui forced teardown without user pressing Esc.
  mount!.component.dispose?.();
  mount!.done();
  // _overlayOpen is reset in the .finally() on the customApi promise chain
  // (fakeCustom async → catch → finally = 3 microtask layers). Drain all.
  await new Promise((r) => setTimeout(r, 0));

  // 1. Phase subscription must have been cleaned up (unsubPhase called).
  assert.equal(
    phaseListenerFired,
    1,
    "unsubPhase must be called exactly once on dispose()",
  );

  // 2. appendEntry shim must be restored.
  assert.equal(
    pi.appendEntry,
    originalAppendEntry,
    "pi.appendEntry must be restored to original after dispose()",
  );

  // 3. _overlayOpen must be cleared (no stuck overlay via BUG-072).
  assert.equal(
    __isOverlayOpenForTest(),
    false,
    "_overlayOpen must be false after dispose()",
  );
});

test("BUG-007: cleanup() is idempotent — dispose() then close() does not double-unsubscribe", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseRegistry = new PhaseRegistry();

  let unsubPhaseCallCount = 0;
  const origPhaseSubscribe = phaseRegistry.subscribe.bind(phaseRegistry);
  // @ts-ignore -- spy wrapper
  phaseRegistry.subscribe = (listener: (rid: string) => void) => {
    const unsub = origPhaseSubscribe(listener);
    return () => {
      unsubPhaseCallCount++;
      unsub();
    };
  };

  let capturedCtx: NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]> | null = null;
  pi.registerCommand("bug007b", {
    handler: async (_a, c) => {
      capturedCtx = c as unknown as typeof capturedCtx;
    },
  });
  await pi.invokeCommand("bug007b", "");

  let handle: OverlayHandleForTest | null = null;
  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    phaseRegistry,
    forceTTY: true,
    onMounted: (api) => { handle = api; },
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount, "overlay must have mounted");
  assert.ok(handle, "onMounted callback must fire");

  // Simulate Esc (user closes) then dispose() (pi-tui also tears down).
  (handle as OverlayHandleForTest).close();
  mount!.done();
  mount!.component.dispose?.();

  // unsubPhase must fire exactly once despite double close.
  assert.equal(
    unsubPhaseCallCount,
    1,
    "unsubPhase must be called exactly once even when close() and dispose() both run",
  );
});

test("disabled hotkey on terminal run is a silent noop (F1)", async () => {
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  let stopCalls = 0;
  const run = fakeRun({
    runId: "wf-done0001",
    stop: () => stopCalls++,
  });
  registry.register("wf-done0001", run, {
    workflowName: "demo",
    state: "done",
    startedAt: "2026-05-29T00:00:00Z",
  });
  let capturedCtx: { cwd: string; ui: { notify: () => void } } | null = null;
  pi.registerCommand("c3", {
    handler: async (_a, c) => {
      capturedCtx = c as never;
    },
  });
  await pi.invokeCommand("c3", "");
  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    forceTTY: true,
  });
  const mount = pi.overlayMounts[0];
  assert.ok(mount);
  mount!.component.handleInput!("x"); // disabled on done
  mount!.component.handleInput!("p"); // disabled on done
  assert.equal(stopCalls, 0, "stop() must NOT fire on a terminal run");
  // No kill-requested entry for the disabled press.
  const killEntries = pi.entries.filter(
    (e) => e.customType === "pi-workflows.run.kill-requested",
  );
  assert.equal(killEntries.length, 0);
  mount!.done();
});

test("banner TTL: stale banner is dropped from render after expiry", async () => {
  // Simulates the gap analysis 2026-05-31 row "Banner state has no TTL":
  // pressing `s` on a terminal run in phase-view emits a "saving
  // script…" banner; after the 4s TTL the render must drop it even
  // when no other event triggers a redraw.
  const pi = makeFakePi();
  const registry = new ActiveRunsRegistry();
  const phaseReg = new PhaseRegistry();
  // Drive a run into a terminal state so `s` fires save-script-requested
  // (which sets a banner). `phase.started` makes phase-view renderable.
  const runId = "wf-bnrttl0001";
  registry.register(runId, fakeRun({ runId }), {
    workflowName: "demo",
    state: "done",
    startedAt: "2026-05-29T00:00:00Z",
  });
  phaseReg.applyEntry({
    customType: "pi-workflows.phase.started",
    data: { runId, phaseName: "p1", agentCount: 1 },
  } as never);

  let capturedCtx: { cwd: string; ui: { notify: () => void } } | null = null;
  pi.registerCommand("bnr-ttl", {
    handler: async (_a, c) => {
      capturedCtx = c as never;
    },
  });
  await pi.invokeCommand("bnr-ttl", "");

  // Drive a virtual clock so we can step past the 4s TTL without sleeping.
  let now = 1_700_000_000_000;
  let handle: OverlayHandleForTest | null = null;
  let saveCalls = 0;
  await mountOverlay({
    pi,
    ctx: capturedCtx!,
    registry,
    phaseRegistry: phaseReg,
    forceTTY: true,
    nowMs: () => now,
    onSaveScriptRequested: () => {
      saveCalls++;
    },
    onMounted: (api) => {
      handle = api;
    },
  });
  assert.ok(handle, "onMounted must fire");
  const h: OverlayHandleForTest = handle!;

  // Drill into phase-view (Enter), then press `s` to set the banner.
  h.handleKey("\r");
  await new Promise((r) => setTimeout(r, 50));
  h.handleKey("s");
  assert.equal(saveCalls, 1, "save-script callback must fire");

  const linesAtSet = h.currentLines().join("\n");
  assert.match(
    linesAtSet,
    /saving script/,
    `expected banner to be visible right after press, got:\n${linesAtSet}`,
  );

  // Step past the 4s TTL and re-render. With TTL the banner must be gone.
  now += 5_000;
  const linesAfterTtl = h.currentLines().join("\n");
  assert.doesNotMatch(
    linesAfterTtl,
    /saving script/,
    `banner must be cleared after TTL, got:\n${linesAfterTtl}`,
  );
  h.close();
});
