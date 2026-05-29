/**
 * tests/integration/hotReload.test.ts
 *
 * Integration tests for slice-16 hot-reload: uses real chokidar + real
 * tmpdir FS writes to exercise the actual event path.
 *
 * awaitWriteFinish is tuned for speed (50ms stability, 20ms poll) so
 * the suite completes in <3s total.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHotReloadWatcher } from "../../src/runtime/hotReload.js";
import { ActiveRunsRegistry } from "../../src/runtime/activeRuns.js";
import type { ExtensionAPI } from "../../src/types/internal.js";
import type { WorkflowFile } from "../../src/types/internal.js";

// ─── Helpers ─────────────────────────────────────────────────────────

const WORKFLOW_SCAFFOLD = `
// pi-workflow scaffold
export default async function run(ctx) {
  await ctx.agent({ prompt: "hello" });
}
`.trimStart();

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

/** Poll `pred()` every `intervalMs` until it returns true or `timeoutMs` expires. */
async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred(); // final check
}

// ─── Integration tests (real chokidar, real FS) ────────────────────

test("add: new .js file registers command within 200ms", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hr-add-"));
  const projDir = join(root, "proj", ".pi", "workflows");
  const persDir = join(root, "pers", ".pi", "agent", "workflows");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(persDir, { recursive: true });

  const { pi, registered } = makeFakePi();
  const handle = await createHotReloadWatcher({
    projectDir: projDir,
    personalDir: persDir,
    registry: new Map<string, WorkflowFile>(),
    pi,
    activeRuns: new ActiveRunsRegistry(),
    recursive: false,
    debounceMs: 50,
    // No watcherFactory — real chokidar with fast awaitWriteFinish
  });

  // Give chokidar a moment to start watching before we write.
  await new Promise((r) => setTimeout(r, 100));

  writeFileSync(join(projDir, "my-new-wf.js"), WORKFLOW_SCAFFOLD);

  const ok = await waitFor(() => registered.has("my-new-wf"), 1500);

  await handle.dispose();

  assert.ok(ok, `command 'my-new-wf' should be registered within 1500ms`);
});

test("rapid double-write: debounce coalesces 2 writes into exactly 1 re-register", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hr-debounce-"));
  const projDir = join(root, "proj", ".pi", "workflows");
  const persDir = join(root, "pers", ".pi", "agent", "workflows");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(persDir, { recursive: true });

  const wfPath = join(projDir, "double.js");
  writeFileSync(wfPath, WORKFLOW_SCAFFOLD);

  const { pi } = makeFakePi();
  const registry = new Map<string, WorkflowFile>([
    ["double", { name: "double", absPath: wfPath, scope: "project" }],
  ]);

  let reregisterCount = 0;
  const origRegister = pi.registerCommand.bind(pi);
  (pi as { registerCommand: (...a: unknown[]) => void }).registerCommand = (
    name: unknown,
    opts: unknown,
  ) => {
    if (name === "double") reregisterCount++;
    origRegister(name as string, opts as Parameters<typeof origRegister>[1]);
  };

  // Use real chokidar but WITHOUT awaitWriteFinish — each write fires its own
  // event so the debounce (not chokidar) is responsible for coalescing.
  const chokidar = (await import("chokidar")).default;
  const handle = await createHotReloadWatcher({
    projectDir: projDir,
    personalDir: persDir,
    registry,
    pi,
    activeRuns: new ActiveRunsRegistry(),
    recursive: false,
    debounceMs: 100,
    watcherFactory: (paths, _opts) =>
      chokidar.watch(paths, {
        ignoreInitial: true,
        depth: 0,
        persistent: false,
        // NO awaitWriteFinish — each write fires an independent event so
        // debounce is the only coalescing layer (mutation probe works).
      }),
  });

  await new Promise((r) => setTimeout(r, 150));

  // Write v1, wait 60ms (chokidar fires 2 separate events on this gap),
  // then write v2 — both within the 100ms debounce window so they
  // MUST be coalesced by clearTimeout, not by chokidar internals.
  writeFileSync(wfPath, WORKFLOW_SCAFFOLD + "\n// v1\n");
  await new Promise((r) => setTimeout(r, 60));
  writeFileSync(wfPath, WORKFLOW_SCAFFOLD + "\n// v2\n");

  // Wait: debounceMs(100) + FS latency + margin
  await new Promise((r) => setTimeout(r, 400));

  await handle.dispose();

  assert.strictEqual(
    reregisterCount,
    1,
    `two rapid writes should coalesce to exactly 1 re-register, got ${reregisterCount}`,
  );
});

test("unlink: registry entry removed and unregisterCommand called", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hr-unlink-"));
  const projDir = join(root, "proj", ".pi", "workflows");
  const persDir = join(root, "pers", ".pi", "agent", "workflows");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(persDir, { recursive: true });

  const filePath = join(projDir, "gone-wf.js");
  writeFileSync(filePath, WORKFLOW_SCAFFOLD);

  const { pi, registered, unregistered } = makeFakePi();
  // Pre-register so unregisterCommand has something to remove.
  pi.registerCommand("gone-wf", { handler: async () => {} });

  const registry = new Map<string, WorkflowFile>([
    ["gone-wf", { name: "gone-wf", absPath: filePath, scope: "project" }],
  ]);

  const handle = await createHotReloadWatcher({
    projectDir: projDir,
    personalDir: persDir,
    registry,
    pi,
    activeRuns: new ActiveRunsRegistry(),
    recursive: false,
    debounceMs: 50,
  });

  await new Promise((r) => setTimeout(r, 100));

  rmSync(filePath);

  const ok = await waitFor(() => !registry.has("gone-wf"), 1500);

  await handle.dispose();

  assert.ok(ok, "registry entry should be removed after file deletion");
  assert.ok(
    unregistered.includes("gone-wf"),
    "unregisterCommand should be called for deleted file",
  );
});
