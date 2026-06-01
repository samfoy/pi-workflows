/**
 * tests/unit/ipcCtrlWatcher.test.ts
 *
 * Unit tests for `startCtrlWatcher` reliability fixes:
 *
 *   - One-shot warning when `fs.watch` throws (Docker / NFS scenario).
 *   - Polling fallback (1s mtime poll) catches commands even when
 *     `fs.watch` is unavailable / silently fails.
 *   - `processNewLines` byte-offset tracking — never re-processes
 *     already-consumed lines.
 *   - Rotation: when ledger crosses `rotateBytes`, ctrl.jsonl is
 *     atomically renamed to `ctrl.jsonl.archived` and offset resets.
 *   - Tear-down on `run.terminated` clears both the native watcher
 *     and the polling interval.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { startCtrlWatcher } from "../../src/runManager.js";

// ─── Test scaffold ──────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-ctrl-watcher-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Minimal Run shape needed by `startCtrlWatcher`. Captures all calls
 * so tests can assert on dispatch.
 */
interface FakeRun {
  pauseCalls: string[];
  resumeCalls: string[];
  stopCalls: string[];
  terminate: () => void;
  // The fields startCtrlWatcher actually reads:
  pause: (reason: string) => Promise<boolean>;
  resumePaused: (reason: string) => Promise<boolean>;
  stop: (reason: string) => void;
  terminated: Promise<unknown>;
}

function makeFakeRun(): FakeRun {
  let resolveTerminated!: () => void;
  const terminated = new Promise<unknown>((r) => { resolveTerminated = () => r(undefined); });
  const fake: FakeRun = {
    pauseCalls: [],
    resumeCalls: [],
    stopCalls: [],
    terminate: () => resolveTerminated(),
    async pause(reason) { fake.pauseCalls.push(reason); return true; },
    async resumePaused(reason) { fake.resumeCalls.push(reason); return true; },
    stop(reason) { fake.stopCalls.push(reason); },
    terminated,
  };
  return fake;
}

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
  return pred();
}

// ─── fs.watch throw → one-shot warning + polling fallback works ─────────

describe("startCtrlWatcher: fs.watch throw → fallback", () => {
  it("emits exactly one warning when fs.watch throws", async () => {
    const run = makeFakeRun();
    const warnings: string[] = [];
    const throwingWatch = (() => {
      throw new Error("EINVAL: filesystem does not support events");
    }) as unknown as typeof import("node:fs").watch;

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      watchFn: throwingWatch,
      log: (level, msg) => { if (level === "warn") warnings.push(msg); },
      pollIntervalMs: 50,
    });

    // Give the poll a couple of ticks; warning should already be set.
    await new Promise((r) => setTimeout(r, 120));
    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(warnings.length, 1, "exactly one warning on fs.watch throw");
    assert.match(warnings[0]!, /fs\.watch unavailable/);
    assert.match(warnings[0]!, /mtime poll fallback/);
  });

  it("polling fallback dispatches commands written after watch failed", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");
    const throwingWatch = (() => {
      throw new Error("not supported");
    }) as unknown as typeof import("node:fs").watch;

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      watchFn: throwingWatch,
      pollIntervalMs: 30, // fast for tests
    });

    // Write a pause command after the watcher started.
    appendFileSync(ctrlFile, JSON.stringify({ type: "pause", reason: "test" }) + "\n");

    const ok = await waitFor(() => run.pauseCalls.length > 0, 1000, 20);
    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(ok, "polling fallback should dispatch pause within 1s");
    assert.equal(run.pauseCalls[0], "test");
  });
});

// ─── Always-on poll catches commands even when native watch is disabled ─

describe("startCtrlWatcher: native-watch-disabled (silent-fail simulation)", () => {
  it("dispatches commands via polling alone (disableNativeWatch=true)", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 30,
    });

    appendFileSync(ctrlFile, JSON.stringify({ type: "stop" }) + "\n");
    appendFileSync(ctrlFile, JSON.stringify({ type: "resume", reason: "rstart" }) + "\n");

    const ok = await waitFor(
      () => run.stopCalls.length > 0 && run.resumeCalls.length > 0,
      1000,
      20,
    );
    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(ok, "polling alone should dispatch both commands");
    assert.equal(run.stopCalls[0], "ctrl-ipc"); // no reason on stop → default
    assert.equal(run.resumeCalls[0], "rstart");
  });
});

// ─── Byte-offset tracking: idempotent, no re-processing ─────────────────

describe("startCtrlWatcher: byte-offset tracking", () => {
  it("does not re-dispatch commands written before tear-down", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 30,
    });

    // First append → poll picks up.
    appendFileSync(ctrlFile, JSON.stringify({ type: "pause" }) + "\n");
    await waitFor(() => run.pauseCalls.length === 1, 500);

    // Second append → poll picks up only the new line (offset advances).
    appendFileSync(ctrlFile, JSON.stringify({ type: "pause", reason: "second" }) + "\n");
    await waitFor(() => run.pauseCalls.length === 2, 500);

    run.terminate();
    await new Promise((r) => setTimeout(r, 100));

    // Strict count check — if offset tracking regressed, we'd see 3+
    // (the first command counted twice on a re-read).
    assert.equal(run.pauseCalls.length, 2, "exactly 2 pause dispatches across 2 appends");
    assert.equal(run.pauseCalls[0], "ctrl-ipc");
    assert.equal(run.pauseCalls[1], "second");
  });

  it("resets offset when file is externally truncated", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 30,
    });

    appendFileSync(ctrlFile, JSON.stringify({ type: "pause" }) + "\n");
    await waitFor(() => run.pauseCalls.length === 1, 500);

    // External truncate (simulates rotation by another process).
    writeFileSync(ctrlFile, "");
    // Now write a fresh command at offset 0.
    appendFileSync(ctrlFile, JSON.stringify({ type: "stop" }) + "\n");
    await waitFor(() => run.stopCalls.length === 1, 500);

    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(run.stopCalls.length, 1, "stop dispatched after truncate-and-rewrite");
    assert.equal(run.pauseCalls.length, 1, "pause not double-dispatched after truncate");
  });
});

// ─── Rotation at ~8 MiB ──────────────────────────────────────────────────

describe("startCtrlWatcher: rotation", () => {
  it("renames ctrl.jsonl → ctrl.jsonl.archived once bytesRead crosses threshold", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");
    const archivedFile = ctrlFile + ".archived";
    // Note: the rotation may add a timestamp suffix (e.g. .archived.1234567890)
    const archivedPattern = ctrlFile + ".archived";
    const infos: string[] = [];

    // Tiny rotateBytes for fast testing — write enough lines to cross it.
    const rotateBytes = 1024; // 1 KiB
    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 20,
      rotateBytes,
      log: (level, msg) => { if (level === "info") infos.push(msg); },
    });

    // Append commands until file size is well above rotateBytes.
    // Each line is ~30 bytes; ~50 lines comfortably crosses 1 KiB.
    const line = JSON.stringify({ type: "pause", reason: "x".repeat(20) }) + "\n";
    for (let i = 0; i < 100; i++) {
      appendFileSync(ctrlFile, line);
    }

    // Wait for rotation to happen — check for any file starting with the archived pattern.
    const { readdirSync } = await import("node:fs");
    const rotated = await waitFor(() => readdirSync(tmpDir).some(f => f.startsWith("ctrl.jsonl.archived")), 2000, 30);
    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(rotated, "ctrl.jsonl.archived should exist after rotation");
    assert.ok(
      infos.some((m) => m.includes("rotated")),
      "should log a rotation info notice",
    );
    // After rotation, the live ctrl.jsonl should be gone (or recreated
    // empty by a subsequent writer; we appended in a loop so it's gone).
    if (existsSync(ctrlFile)) {
      const sizeAfter = statSync(ctrlFile).size;
      assert.ok(sizeAfter < rotateBytes, "post-rotate file (if any) should be small");
    }
  });

  it("does not rotate when bytesRead stays below threshold", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");
    const archivedFile = ctrlFile + ".archived";

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 20,
      rotateBytes: 8 * 1024 * 1024,
    });

    appendFileSync(ctrlFile, JSON.stringify({ type: "pause" }) + "\n");
    await waitFor(() => run.pauseCalls.length === 1, 500);

    run.terminate();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!existsSync(archivedFile), "no rotation under threshold");
  });
});

// ─── Tear-down ───────────────────────────────────────────────────────────

describe("startCtrlWatcher: tear-down on terminated", () => {
  it("stops polling once run.terminated resolves", async () => {
    const run = makeFakeRun();
    const ctrlFile = join(tmpDir, "ctrl.jsonl");

    startCtrlWatcher(tmpDir, run as unknown as Parameters<typeof startCtrlWatcher>[1], {
      disableNativeWatch: true,
      pollIntervalMs: 20,
    });

    appendFileSync(ctrlFile, JSON.stringify({ type: "pause" }) + "\n");
    await waitFor(() => run.pauseCalls.length === 1, 500);

    run.terminate();
    await new Promise((r) => setTimeout(r, 100)); // let tear-down propagate

    // Append a command AFTER tear-down — should never be picked up.
    appendFileSync(ctrlFile, JSON.stringify({ type: "stop" }) + "\n");
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(run.stopCalls.length, 0, "stop must NOT be dispatched after terminated");
  });
});
