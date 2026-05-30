/**
 * Unit tests for the IPC inspection surface:
 *   - ActiveRunsRegistry.writeActiveIndex
 *   - WorkflowClient (listActiveRuns, getRunState, sendControl, tailEvents)
 *   - ctrl.jsonl watcher (indirect via startWorkflowRun integration)
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  ActiveRunsRegistry,
  isTerminalState,
} from "../../src/runtime/activeRuns.js";
import { WorkflowClient } from "../../src/client.js";
import { LedgerWriter } from "../../src/runtime/ledger.js";
import type { LedgerEntry } from "../../src/types/internal.js";

// ─── Test scaffold ─────────────────────────────────────────────────────────

let tmpDir: string;
let runsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-ipc-test-"));
  runsDir = join(tmpDir, "runs");
  mkdirSync(runsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunDir(runId: string): string {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── ActiveRunsRegistry.writeActiveIndex ──────────────────────────────────

describe("ActiveRunsRegistry.writeActiveIndex", () => {
  it("writes an empty index when no runs are registered", () => {
    const registry = new ActiveRunsRegistry();
    const indexPath = join(runsDir, ".active");
    registry.writeActiveIndex(indexPath);
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as { runs: string[]; updatedAt: string };
    assert.deepEqual(parsed.runs, []);
    assert.ok(typeof parsed.updatedAt === "string");
  });

  it("lists only non-terminal runs", async () => {
    const registry = new ActiveRunsRegistry();
    const indexPath = join(runsDir, ".active");

    // Fake run handles
    const noop = () => {};
    const neverPromise = new Promise<never>(() => {});
    const fakeRun = (runId: string) => ({
      runId,
      runDirAbs: join(runsDir, runId),
      promise: neverPromise as Promise<unknown>,
      signal: new AbortController().signal,
      getFinishCallbackPrompt: () => null,
      cancel: noop,
      approvalDecision: null,
      terminated: neverPromise as Promise<{ runId: string; workflowName: string; runDirAbs: string; outcome: "done"; startedAt: string; endedAt: string; durationMs: number; error: null }>,
      pause: async () => false as boolean,
      resumePaused: async () => false as boolean,
      stop: noop,
    });

    registry.register("wf-aaa", fakeRun("wf-aaa") as any, {
      workflowName: "alpha",
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      runDir: join(runsDir, "wf-aaa"),
    });
    registry.register("wf-bbb", fakeRun("wf-bbb") as any, {
      workflowName: "beta",
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      runDir: join(runsDir, "wf-bbb"),
    });
    // Mark wf-bbb as done via applyEntry
    registry.applyEntry({
      customType: "pi-workflows.run.ended",
      data: { runId: "wf-bbb", outcome: "done", endedAt: "2026-01-01T00:01:00.000Z" },
    });

    registry.writeActiveIndex(indexPath);
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as { runs: string[] };
    assert.deepEqual(parsed.runs, ["wf-aaa"]);
  });

  it("writes atomically via tmp+rename (file is always complete JSON)", () => {
    const registry = new ActiveRunsRegistry();
    const indexPath = join(runsDir, ".active");
    // Write 50 times in tight loop — each write should leave a valid JSON file
    for (let i = 0; i < 50; i++) {
      registry.writeActiveIndex(indexPath);
      const raw = readFileSync(indexPath, "utf8");
      // Should never throw
      JSON.parse(raw);
    }
  });

  it("creates parent directory if missing", () => {
    const registry = new ActiveRunsRegistry();
    const deepDir = join(tmpDir, "deep", "nested", "runs");
    const indexPath = join(deepDir, ".active");
    // Should not throw even though the directory doesn't exist
    assert.doesNotThrow(() => registry.writeActiveIndex(indexPath));
  });
});

// ─── WorkflowClient.listActiveRuns ────────────────────────────────────────

describe("WorkflowClient.listActiveRuns", () => {
  it("returns empty array when .active file missing", () => {
    const client = new WorkflowClient({ runsHome: runsDir });
    assert.deepEqual(client.listActiveRuns(), []);
  });

  it("reads run IDs from .active file", () => {
    const indexPath = join(runsDir, ".active");
    writeFileSync(
      indexPath,
      JSON.stringify({ runs: ["wf-abc", "wf-def"], updatedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const client = new WorkflowClient({ runsHome: runsDir });
    assert.deepEqual(client.listActiveRuns(), ["wf-abc", "wf-def"]);
  });

  it("returns empty array on malformed .active file", () => {
    const indexPath = join(runsDir, ".active");
    writeFileSync(indexPath, "{{not json}}");
    const client = new WorkflowClient({ runsHome: runsDir });
    assert.deepEqual(client.listActiveRuns(), []);
  });
});

// ─── WorkflowClient.getRunState ───────────────────────────────────────────

describe("WorkflowClient.getRunState", () => {
  it("returns null for unknown run ID", async () => {
    const client = new WorkflowClient({ runsHome: runsDir });
    const state = await client.getRunState("wf-nonexistent");
    assert.equal(state, null);
  });

  it("reads state from ledger.jsonl", async () => {
    const runId = "wf-test01";
    const dir = makeRunDir(runId);
    const writer = new LedgerWriter({
      runId,
      resolveLedgerPath: () => join(dir, "ledger.jsonl"),
    });
    await writer.append({ type: "init", at: "2026-01-01T00:00:00.000Z", manifest: {} });
    await writer.append({
      type: "transition",
      at: "2026-01-01T00:00:01.000Z",
      from: "pending",
      to: "approved",
    });
    await writer.append({
      type: "transition",
      at: "2026-01-01T00:00:02.000Z",
      from: "approved",
      to: "running",
    });

    const client = new WorkflowClient({ runsHome: runsDir });
    const result = await client.getRunState(runId);
    assert.ok(result !== null);
    assert.equal(result.state, "running");
    assert.equal(result.entries.length, 3);
  });

  it("extracts phases and agent counts", async () => {
    const runId = "wf-phases01";
    const dir = makeRunDir(runId);
    const writer = new LedgerWriter({
      runId,
      resolveLedgerPath: () => join(dir, "ledger.jsonl"),
    });
    await writer.append({
      type: "phase_start",
      at: "2026-01-01T00:00:01.000Z",
      phaseName: "research",
      agentCount: 3,
    });
    await writer.append({
      type: "phase_end",
      at: "2026-01-01T00:00:05.000Z",
      phaseName: "research",
      durationMs: 4000,
      agentResults: { ok: 2, error: 1, cacheHit: 0 },
    });

    const client = new WorkflowClient({ runsHome: runsDir });
    const result = await client.getRunState(runId);
    assert.ok(result !== null);
    assert.deepEqual(result.phases, ["research"]);
    assert.deepEqual(result.agentCounts["research"], { ok: 2, error: 1, cacheHit: 0 });
  });
});

// ─── WorkflowClient.sendControl ───────────────────────────────────────────

describe("WorkflowClient.sendControl", () => {
  it("writes a valid JSON line to ctrl.jsonl", async () => {
    const runId = "wf-ctrl01";
    makeRunDir(runId);
    const client = new WorkflowClient({ runsHome: runsDir });
    await client.sendControl(runId, { type: "pause" });

    const ctrlFile = join(runsDir, runId, "ctrl.jsonl");
    const raw = readFileSync(ctrlFile, "utf8").trim();
    const cmd = JSON.parse(raw) as { type: string; at: string };
    assert.equal(cmd.type, "pause");
    assert.ok(typeof cmd.at === "string");
  });

  it("appends multiple commands as separate lines", async () => {
    const runId = "wf-ctrl02";
    makeRunDir(runId);
    const client = new WorkflowClient({ runsHome: runsDir });
    await client.sendControl(runId, { type: "pause" });
    await client.sendControl(runId, { type: "resume", reason: "test" });
    await client.sendControl(runId, { type: "stop" });

    const ctrlFile = join(runsDir, runId, "ctrl.jsonl");
    const lines = readFileSync(ctrlFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 3);
    const cmds = lines.map((l) => JSON.parse(l) as { type: string; reason?: string });
    assert.equal(cmds[0]!.type, "pause");
    assert.equal(cmds[1]!.type, "resume");
    assert.equal(cmds[1]!.reason, "test");
    assert.equal(cmds[2]!.type, "stop");
  });

  it("creates run directory if missing", async () => {
    const runId = "wf-ctrl03";
    // Don't call makeRunDir — sendControl should create it
    const client = new WorkflowClient({ runsHome: runsDir });
    await assert.doesNotReject(() => client.sendControl(runId, { type: "stop" }));
  });
});

// ─── WorkflowClient.tailEvents ────────────────────────────────────────────

describe("WorkflowClient.tailEvents", () => {
  it("yields entries from an existing ledger and stops at terminal state", async () => {
    const runId = "wf-tail01";
    const dir = makeRunDir(runId);
    const writer = new LedgerWriter({
      runId,
      resolveLedgerPath: () => join(dir, "ledger.jsonl"),
    });
    await writer.append({ type: "init", at: "2026-01-01T00:00:00.000Z", manifest: {} });
    await writer.append({
      type: "transition",
      at: "2026-01-01T00:00:01.000Z",
      from: "pending",
      to: "approved",
    });
    await writer.append({
      type: "transition",
      at: "2026-01-01T00:00:02.000Z",
      from: "approved",
      to: "running",
    });
    await writer.append({
      type: "transition",
      at: "2026-01-01T00:00:10.000Z",
      from: "running",
      to: "done",
    });

    const client = new WorkflowClient({ runsHome: runsDir, pollIntervalMs: 10 });
    const collected: LedgerEntry[] = [];
    for await (const entry of client.tailEvents(runId)) {
      collected.push(entry);
    }
    assert.equal(collected.length, 4);
    const last = collected.at(-1);
    assert.ok(last?.type === "transition" && (last as Extract<typeof last, {type:"transition"}>).to === "done");
  });

  it("yields appendEntry events written to the ledger", async () => {
    const runId = "wf-tail02";
    const dir = makeRunDir(runId);
    // Manually write an appendEntry entry (simulating what bindRegistryToFeed does)
    const ledgerFile = join(dir, "ledger.jsonl");
    const appendEntry = {
      type: "appendEntry",
      at: "2026-01-01T00:00:05.000Z",
      customType: "pi-workflows.agent.log",
      data: { runId, agentId: "ag-001", line: "hello from agent" },
    };
    writeFileSync(ledgerFile, JSON.stringify(appendEntry) + "\n");
    // Also write a terminal transition so tailEvents stops
    const terminal = {
      type: "transition",
      at: "2026-01-01T00:00:10.000Z",
      from: "running",
      to: "done",
    };
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ledgerFile, JSON.stringify(terminal) + "\n");

    const client = new WorkflowClient({ runsHome: runsDir, pollIntervalMs: 10 });
    const collected: LedgerEntry[] = [];
    for await (const entry of client.tailEvents(runId)) {
      collected.push(entry);
    }
    const appEntry = collected.find((e) => e.type === "appendEntry");
    assert.ok(appEntry !== undefined);
    assert.equal((appEntry as Extract<LedgerEntry, {type:"appendEntry"}>).customType, "pi-workflows.agent.log");
  });
});
