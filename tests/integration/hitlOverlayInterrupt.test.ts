/**
 * tests/integration/hitlOverlayInterrupt.test.ts — ZONE_TUI_HITL_FORK
 * end-to-end HITL flow.
 *
 * Drives a real workflow that calls `ctx.interrupt(...)` then mounts
 * the overlay with a stubbed pi.ui.input that supplies the answer
 * when the operator presses `i`. Asserts:
 *
 *   - Workflow blocks on ctx.interrupt() until the overlay dispatches
 *     a value.
 *   - The mounted overlay observes the appendEntry-emitted
 *     `pi-workflows.interrupt.requested` event and enables `i`.
 *   - Pressing `i` calls onInterruptAnswerRequested → ctx.ui.input →
 *     run.respondInterrupt(value, key) → workflow resumes with the
 *     value as the return of ctx.interrupt().
 *   - Final ledger contains `interrupt_requested` + `interrupt_resolved`
 *     with `source: "ipc"`.
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
import type { PendingInterruptPayload } from "../../src/runtime/overlay.js";
import { PhaseRegistry } from "../../src/runtime/phaseRegistry.js";
import { makeFakePi } from "../helpers/makeFakePi.ts";

function makeTmpRun(): {
  runsRoot: string;
  resolveRunDir: (id: string) => string;
} {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-wf-hitl-"));
  return {
    runsRoot,
    resolveRunDir: (id: string) => {
      const d = join(runsRoot, id);
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

const HITL_WORKFLOW_SOURCE = `
// ZONE_HITL polish: ctx.interrupt() now returns { key, value }; the
// answer the operator picked lives at .value.
const { value: answer } = await ctx.interrupt({ question: "Approve?", choices: ["yes", "no"] });
return { answer };
`;

test(
  "ZONE_HITL: overlay i hotkey resolves a real ctx.interrupt() through ctx.ui.input",
  { timeout: 15_000 },
  async () => {
    __resetOverlayOpenForTest();
    const { runsRoot, resolveRunDir } = makeTmpRun();
    const wfPath = join(runsRoot, "hitl.workflow.js");
    writeFileSync(wfPath, HITL_WORKFLOW_SOURCE);
    const workflow: WorkflowFile = {
      name: "hitl-test",
      absPath: wfPath,
      scope: "personal",
    };

    const registry = new ActiveRunsRegistry();
    const phaseRegistry = new PhaseRegistry();
    const pi = makeFakePi();

    // Capture ctx for mountOverlay.
    let capturedCtx: NonNullable<Parameters<typeof mountOverlay>[0]["ctx"]> | null = null;
    pi.registerCommand("c", {
      handler: async (_a, c) => {
        capturedCtx = c as unknown as typeof capturedCtx;
      },
    });
    await pi.invokeCommand("c", "");

    // Queue the answer the operator will pick when select() prompts
    // them via the interrupt callback.
    pi.nextSelectAnswers.push("yes");

    // Forward emitOverlayEvent to pi.appendEntry so the overlay's
    // listener picks up the interrupt.requested event.
    const run = await startWorkflowRun(workflow, "go", {
      preApproved: true,
      cwd: runsRoot,
      resolveRunDir,
      mockAgents: true,
      activeRuns: registry,
      emitOverlayEvent: (customType, data) => {
        try {
          pi.appendEntry(customType, data);
        } catch {
          /* swallow */
        }
      },
    });

    // Build the on-interrupt callback. We can't import the full
    // workflowCmd buildOverlayCallbacks here because it requires
    // a WorkflowRegistry; replicate the inner logic inline, as the
    // production wiring would.
    const interruptInvocations: PendingInterruptPayload[] = [];
    await mountOverlay({
      pi,
      ctx: capturedCtx!,
      registry,
      phaseRegistry,
      forceTTY: true,
      onInterruptAnswerRequested: async (runId, payload) => {
        interruptInvocations.push(payload);
        // Production wiring uses ctx.ui.select / ctx.ui.input; simulate
        // the same path here by reading from the queued select answers.
        const selectFn = capturedCtx!.ui.select;
        if (typeof selectFn !== "function") return "no select fn";
        const sel = selectFn as unknown as (
          t: string,
          o: string[],
        ) => Promise<string | undefined>;
        const answer = await sel(`Answer: ${payload.question}`, [...(payload.choices ?? [])]);
        if (answer === undefined) return "cancelled";
        const r = registry.getRun(runId);
        if (r === undefined) return "no run";
        const ok = r.respondInterrupt(answer, payload.key);
        return ok ? "resolved" : "no match";
      },
    });
    const mount = pi.overlayMounts[0];
    assert.ok(mount);

    // Wait for the interrupt.requested event to arrive at the overlay.
    // Poll the appendEntry log up to ~2s.
    const maxWaitMs = 2000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (
        pi.entries.some(
          (e) => e.customType === "pi-workflows.interrupt.requested",
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(
      pi.entries.some(
        (e) => e.customType === "pi-workflows.interrupt.requested",
      ),
      "overlay must observe pi-workflows.interrupt.requested emission",
    );

    // Operator presses `i` — overlay dispatches the answer prompt.
    mount!.component.handleInput!("i");

    // Workflow result resolves once the answer is posted.
    const result = (await run.promise) as { answer: unknown };
    await run.terminated;

    assert.equal(result.answer, "yes", "ctx.interrupt() must return the operator's answer");
    assert.equal(interruptInvocations.length, 1, "exactly one interrupt prompt should fire");
    assert.equal(interruptInvocations[0]!.question, "Approve?");

    // Ledger captures both events with source=ipc on the resolved one.
    const ledger = readFileSync(join(run.runDirAbs, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const requested = ledger.find((e) => e.type === "interrupt_requested");
    const resolved = ledger.find((e) => e.type === "interrupt_resolved");
    assert.ok(requested, "ledger must contain interrupt_requested");
    assert.ok(resolved, "ledger must contain interrupt_resolved");
    assert.equal(resolved!.source, "ipc");
    assert.equal(resolved!.value, "yes");

    mount!.done();
  },
);
