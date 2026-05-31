/**
 * tests/integration/forkOverlayHotkey.test.ts — ZONE_TUI_HITL_FORK
 * end-to-end fork-from-checkpoint via the `f` overlay hotkey.
 *
 * Drives:
 *   1. A 3-phase parent run completes.
 *   2. The overlay is mounted with a fork callback that mimics the
 *      production wiring (read parent ledger for phase list, prompt
 *      via ctx.ui.select for atPhase, prompt via ctx.ui.input for
 *      overrides JSON, call forkFromCheckpoint).
 *   3. Pressing `f` on the parent's row resolves the prompts from
 *      queued ctx.ui mocks and starts the fork.
 *   4. Asserts the fork was created with the expected parentRunId +
 *      forkAtPhase recorded in its manifest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowFile } from "../../src/types/internal.js";
import { startWorkflowRun } from "../../src/runManager.js";
import { ActiveRunsRegistry } from "../../src/runtime/activeRuns.js";
import {
  mountOverlay,
  __resetOverlayOpenForTest,
} from "../../src/runtime/overlay.js";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";
import { LedgerReader } from "../../src/runtime/ledger.js";
import { forkFromCheckpoint } from "../../src/runtime/forkRun.js";
import { sha256 } from "../../src/util/hash.js";
import { makeFakePi } from "../helpers/makeFakePi.ts";

const FIXTURE_REL = "../fixtures/workflows/three-phase-fork.workflow.js";

function makeTmpRun(): {
  runsRoot: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-fork-overlay-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function fixturesFor(
  prompts: { agentId: string; prompt: string; text: string }[],
): string {
  return (
    prompts
      .map((p) =>
        JSON.stringify({
          agentId: p.agentId,
          promptHash: sha256(p.prompt),
          result: { text: p.text, usage: { input: 1, output: 1, totalTokens: 2 } },
        }),
      )
      .join("\n") + "\n"
  );
}

function copyFixture(dstAbs: string): void {
  const src = new URL(FIXTURE_REL, import.meta.url).pathname;
  writeFileSync(dstAbs, readFileSync(src, "utf8"));
}

test(
  "ZONE_TIMETRAVEL: f hotkey on overlay drives forkFromCheckpoint via ctx.ui prompts",
  { timeout: 30_000 },
  async () => {
    __resetOverlayOpenForTest();
    const { runsRoot, resolveRunDir } = makeTmpRun();
    const wfPath = join(runsRoot, "three-phase-fork.workflow.js");
    copyFixture(wfPath);
    const workflow: WorkflowFile = {
      name: "three-phase-fork",
      absPath: wfPath,
      scope: "personal",
    };

    // Run the parent.
    const parentSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1" },
      { agentId: "a2", prompt: "phase 2 default prompt", text: "P2" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3" },
    ]);
    const registry = new ActiveRunsRegistry();
    const phaseRegistry = new PhaseRegistry();
    const parent = await startWorkflowRun(workflow, "go", {
      preApproved: true,
      mockAgents: true,
      cwd: runsRoot,
      resolveRunDir,
      seedFixturesJsonl: parentSeed,
      activeRuns: registry,
    });
    await parent.promise;
    await parent.terminated;

    // Mount the overlay with a fork callback that reads the parent
    // ledger, prompts for atPhase + overrides via ctx.ui.{select,input},
    // then calls forkFromCheckpoint.
    const pi = makeFakePi();
    let capturedCtx: NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]> | null = null;
    pi.registerCommand("c", {
      handler: async (_a, c) => {
        capturedCtx = c as unknown as typeof capturedCtx;
      },
    });
    await pi.invokeCommand("c", "");

    // Queue answers: pick "p2" as atPhase, then provide an overrides JSON.
    pi.nextSelectAnswers.push("p2");
    pi.nextInputAnswers.push(JSON.stringify({ phase2Prompt: "OVERRIDE" }));

    // Pre-load fork seed fixtures so the fork run can dispatch.
    const forkSeed = fixturesFor([
      { agentId: "a1", prompt: "phase 1 default prompt", text: "P1-FORK" },
      { agentId: "a2", prompt: "OVERRIDE", text: "P2-FORK" },
      { agentId: "a3", prompt: "phase 3 default prompt", text: "P3-FORK" },
    ]);

    let forkRunId: string | undefined;

    await mountOverlay({
      pi,
      ctx: capturedCtx!,
      registry,
      phaseRegistry,
      forceTTY: true,
      onForkRequested: async (runId) => {
        // Read parent ledger for phase list.
        const summary = registry.getSummary(runId);
        if (summary === undefined || summary.runDir === undefined) {
          return `fork: no run summary for ${runId}`;
        }
        const reader = new LedgerReader({
          runId,
          resolveLedgerPath: () => join(summary.runDir!, "ledger.jsonl"),
        });
        const { entries } = await reader.read();
        const phases: string[] = [];
        const seen = new Set<string>();
        for (const e of entries) {
          if (e.type === "phase_start" && !seen.has(e.phaseName)) {
            seen.add(e.phaseName);
            phases.push(e.phaseName);
          }
        }
        const sel = capturedCtx!.ui.select as unknown as (
          t: string,
          o: string[],
        ) => Promise<string | undefined>;
        const atPhase = await sel("Choose phase", phases);
        if (atPhase === undefined) return "fork: cancelled";
        const inputFn = capturedCtx!.ui.input as unknown as (
          t: string,
          p?: string,
        ) => Promise<string | undefined>;
        const raw = await inputFn("Overrides JSON", "");
        let overrides: unknown = undefined;
        if (raw !== undefined && raw.trim().length > 0) {
          overrides = JSON.parse(raw);
        }
        const fork = await forkFromCheckpoint(runId, {
          atPhase,
          ...(overrides !== undefined ? { overrides } : {}),
          preApproved: true,
          mockAgents: true,
          cwd: runsRoot,
          resolveRunDir,
          seedFixturesJsonl: forkSeed,
          activeRuns: registry,
        });
        forkRunId = fork.runId;
        await fork.promise;
        await fork.terminated;
        return `forked: ${fork.runId}`;
      },
    });
    const mount = pi.overlayMounts[0];
    assert.ok(mount);

    // Press `f` on the parent (only run in registry → cursor=0).
    mount!.component.handleInput!("f");

    // Wait for the fork callback to resolve. It runs async; poll
    // until forkRunId is set.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (forkRunId !== undefined) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(forkRunId, "fork callback must complete");

    // Verify the fork's manifest carries lineage.
    const forkManifest = JSON.parse(
      readFileSync(
        join(resolveRunDir(forkRunId!), "manifest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(forkManifest.parentRunId, parent.runId);
    assert.equal(forkManifest.forkAtPhase, "p2");

    // Verify the prompts were actually invoked.
    assert.equal(pi.selectCalls.length, 1, "ctx.ui.select must be called once for atPhase");
    assert.equal(pi.inputCalls.length, 1, "ctx.ui.input must be called once for overrides JSON");

    mount!.done();
  },
);
