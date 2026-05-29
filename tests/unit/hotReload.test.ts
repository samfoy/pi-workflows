/**
 * tests/unit/hotReload.test.ts
 *
 * Unit tests for the slice-16 hot-reload watcher.
 *
 * All tests use a fake FSWatcher so no real filesystem is watched.
 * The fake exposes `emit(event, path)` so tests can trigger chokidar
 * events programmatically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHotReloadWatcher } from "../../src/runtime/hotReload.js";
import type { FSWatcherLike } from "../../src/runtime/hotReload.js";
import {
  ActiveRunsRegistry,
  __setActiveRunsSingletonForTest,
} from "../../src/runtime/activeRuns.js";
import type { WorkflowFile, ExtensionAPI } from "../../src/types/internal.js";

// ─── Fake FSWatcher ───────────────────────────────────────────────────

class FakeWatcher implements FSWatcherLike {
  readonly listeners = new Map<string, Array<(p: string | Error) => void>>();
  closed = false;

  on(event: string, listener: (p: string | Error) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }

  emit(event: string, payload: string | Error): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ─── Fake pi API ─────────────────────────────────────────────────────

function makeFakePi(): {
  pi: ExtensionAPI & { unregisterCommand(name: string): void };
  registered: Map<string, unknown>;
  unregistered: string[];
} {
  const registered = new Map<string, unknown>();
  const unregistered: string[] = [];

  const pi = {
    registerCommand(name: string, opts: unknown): void {
      registered.set(name, opts);
    },
    unregisterCommand(name: string): void {
      registered.delete(name);
      unregistered.push(name);
    },
    on(): void {},
    sendMessage(): void {},
  } as unknown as ExtensionAPI & { unregisterCommand(name: string): void };

  return { pi, registered, unregistered };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function makeRegistry(entries: WorkflowFile[] = []): Map<string, WorkflowFile> {
  return new Map(entries.map((e) => [e.name, e]));
}

async function flushTimers(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────

test("add: new .js file registers a command", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
  });

  watcher.emit("add", "/tmp/proj/.pi/workflows/my-workflow.js");
  await flushTimers(100);

  assert.ok(registered.has("my-workflow"), "command should be registered");
  assert.ok(registry.has("my-workflow"), "registry should have entry");

  await handle.dispose();
});

test("change: re-registers command and invalidates trust cache", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry([
    { name: "my-wf", absPath: "/tmp/proj/.pi/workflows/my-wf.js", scope: "project" },
  ]);
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();
  const logLines: string[] = [];

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
    log: (level, msg) => logLines.push(`${level}: ${msg}`),
  });

  watcher.emit("change", "/tmp/proj/.pi/workflows/my-wf.js");
  await flushTimers(100);

  assert.ok(registered.has("my-wf"), "command should still be registered after change");
  // trust invalidation logged when sha256 was previously seen
  // (no prior sha256 in this test, but re-register always logs)
  const reregistered = logLines.some((l) => l.includes("re-registered"));
  assert.ok(reregistered, "should log re-registration");

  await handle.dispose();
});

test("unlink: removes command from registry and unregisters", async () => {
  const { pi, registered, unregistered } = makeFakePi();
  const registry = makeRegistry([
    { name: "bye-wf", absPath: "/tmp/proj/.pi/workflows/bye-wf.js", scope: "project" },
  ]);
  // Pre-register so unregisterCommand can remove it.
  pi.registerCommand("bye-wf", { handler: async () => {} });
  assert.ok(registered.has("bye-wf"), "pre-condition: command registered");

  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
  });

  watcher.emit("unlink", "/tmp/proj/.pi/workflows/bye-wf.js");
  await flushTimers(100);

  assert.ok(!registry.has("bye-wf"), "registry should not have entry after unlink");
  assert.ok(unregistered.includes("bye-wf"), "command should be unregistered");

  await handle.dispose();
});

test("debounce: rapid saves produce 1 re-register, not N", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry([
    { name: "debounced", absPath: "/tmp/proj/.pi/workflows/debounced.js", scope: "project" },
  ]);
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();
  let reregisterCount = 0;

  const origRegister = pi.registerCommand.bind(pi);
  (pi as { registerCommand: (...a: unknown[]) => void }).registerCommand = (name: unknown, opts: unknown) => {
    if (name === "debounced") reregisterCount++;
    origRegister(name as string, opts as Parameters<typeof origRegister>[1]);
  };

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 80,
    watcherFactory: () => watcher,
  });

  // Fire 5 rapid change events.
  for (let i = 0; i < 5; i++) {
    watcher.emit("change", "/tmp/proj/.pi/workflows/debounced.js");
  }
  await flushTimers(200);

  assert.equal(reregisterCount, 1, "exactly 1 re-register after debounce window");

  await handle.dispose();
});

test(".ts file: skipped with warning", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();
  const warnings: string[] = [];

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
    log: (level, msg) => { if (level === "warn") warnings.push(msg); },
  });

  watcher.emit("add", "/tmp/proj/.pi/workflows/my-wf.ts");
  await flushTimers(100);

  assert.ok(!registered.has("my-wf"), "typescript file should NOT be registered");
  assert.ok(warnings.some((w) => w.includes("my-wf.ts")), "should warn about .ts file");

  await handle.dispose();
});

test("reserved name: skipped with warning on add", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();
  const warnings: string[] = [];

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
    log: (level, msg) => { if (level === "warn") warnings.push(msg); },
  });

  watcher.emit("add", "/tmp/proj/.pi/workflows/reload.js");
  await flushTimers(100);

  assert.ok(!registered.has("reload"), "reserved name should NOT be registered");
  assert.ok(warnings.some((w) => w.includes("reload.js")), "should warn about reserved name");

  await handle.dispose();
});

test("lock-during-active-run: defers re-register and logs notice", async () => {
  const { pi, registered } = makeFakePi();
  const absPath = "/tmp/proj/.pi/workflows/active-wf.js";
  const registry = makeRegistry([
    { name: "active-wf", absPath, scope: "project" },
  ]);
  const watcher = new FakeWatcher();

  // Inject an active run for "active-wf".
  const activeRuns = new ActiveRunsRegistry();
  activeRuns.applyEntry({
    customType: "pi-workflows.run.started",
    data: {
      runId: "wf-abc123456789",
      workflowName: "active-wf",
      startedAt: new Date().toISOString(),
    },
  });

  const logLines: string[] = [];
  let reregisterCount = 0;
  const origRegister = pi.registerCommand.bind(pi);
  (pi as { registerCommand: (...a: unknown[]) => void }).registerCommand = (name: unknown, opts: unknown) => {
    if (name === "active-wf") reregisterCount++;
    origRegister(name as string, opts as Parameters<typeof origRegister>[1]);
  };

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
    log: (level, msg) => logLines.push(`${level}: ${msg}`),
  });

  watcher.emit("change", absPath);
  await flushTimers(100);

  assert.equal(reregisterCount, 0, "should NOT re-register while run in progress");
  assert.ok(
    logLines.some((l) => l.includes("deferred") && l.includes("active-wf")),
    "should log deferred notice",
  );

  await handle.dispose();
});

test("recursive mode: does not register commands but still tracks registry", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: true, // <-- recursive mode
    debounceMs: 50,
    watcherFactory: () => watcher,
  });

  watcher.emit("add", "/tmp/proj/.pi/workflows/new-wf.js");
  await flushTimers(100);

  assert.ok(!registered.has("new-wf"), "in recursive mode, should NOT register command");
  assert.ok(registry.has("new-wf"), "registry entry should still be added");

  await handle.dispose();
});

test("dispose: closes watcher and cancels pending debounce", async () => {
  const { pi } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const activeRuns = new ActiveRunsRegistry();
  let registerAfterDispose = false;

  (pi as { registerCommand: (...a: unknown[]) => void }).registerCommand = () => {
    registerAfterDispose = true;
  };

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns,
    recursive: false,
    debounceMs: 200, // long debounce
    watcherFactory: () => watcher,
  });

  // Emit then immediately dispose before debounce fires.
  watcher.emit("add", "/tmp/proj/.pi/workflows/late-wf.js");
  await handle.dispose();
  await flushTimers(300);

  assert.ok(watcher.closed, "watcher should be closed after dispose");
  assert.ok(!registerAfterDispose, "no registration after dispose");
});

test("dispose is idempotent: double-dispose does not throw", async () => {
  const { pi } = makeFakePi();
  const watcher = new FakeWatcher();

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry: makeRegistry(),
    pi,
    activeRuns: new ActiveRunsRegistry(),
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
  });

  await handle.dispose();
  await assert.doesNotReject(() => handle.dispose(), "double dispose should not throw");
});

test("hidden file: silently ignored (no warning)", async () => {
  const { pi, registered } = makeFakePi();
  const registry = makeRegistry();
  const watcher = new FakeWatcher();
  const warnings: string[] = [];

  const handle = await createHotReloadWatcher({
    projectDir: "/tmp/proj/.pi/workflows",
    personalDir: "/tmp/home/.pi/agent/workflows",
    registry,
    pi,
    activeRuns: new ActiveRunsRegistry(),
    recursive: false,
    debounceMs: 50,
    watcherFactory: () => watcher,
    log: (level, msg) => { if (level === "warn") warnings.push(msg); },
  });

  watcher.emit("add", "/tmp/proj/.pi/workflows/.hidden.js");
  await flushTimers(100);

  assert.ok(!registered.has(".hidden"), "hidden file should not be registered");
  assert.equal(warnings.length, 0, "hidden file should produce no warning");

  await handle.dispose();
});
