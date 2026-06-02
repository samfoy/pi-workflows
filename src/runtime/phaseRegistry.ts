/**
 * pi-workflows — slice 14 phase registry (per-run state).
 *
 * Mirror of `activeRuns.ts` but at one level deeper — tracks the
 * phases inside a single run, and the agents inside a phase. Driven
 * by `pi-workflows.phase.{started,ended}` and
 * `pi-workflows.agent.{started,ended}` appendEntry events (PRD §10.5).
 *
 * Pure data store — same observer pattern as `ActiveRunsRegistry`. The
 * phase view renders from a snapshot; subscribers fire on mutation.
 *
 * Concern carry-forward: slice 13's overlay already binds appendEntry
 * → ActiveRunsRegistry. Slice 14 extends `bindRegistryToFeed` (overlay.ts)
 * to also drive THIS registry. Tests drive it directly via `applyEntry`.
 *
 * Refs: PRD §10.3 (phase wireframe), §10.5 (event topics), plan.md §4 Slice 14.
 */

export type PhaseStatus = "pending" | "running" | "done";

export interface AgentSnapshot {
  readonly agentId: string;
  readonly state: "queued" | "running" | "done";
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  /** True if cache hit per `pi-workflows.agent.ended.cached`. */
  readonly cached?: boolean;
  /** Optional one-line prompt summary surfaced via runCtx. */
  readonly summary?: string;
  /** Token usage recorded when the agent ended. */
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
  };
}

export interface PhaseSnapshot {
  readonly phaseName: string;
  readonly status: PhaseStatus;
  readonly agentCount: number;
  /** Optional description from `meta.phases[].description` (Phase 2 / TUI cards). */
  readonly description?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly agents: ReadonlyArray<AgentSnapshot>;
  /** Aggregate token total across all agents in this phase. */
  readonly totalTokens: number;
  /** Tokens from cache-hit agents (subset of totalTokens). */
  readonly cachedTokens: number;
}

export interface RunPhaseSnapshot {
  readonly runId: string;
  readonly phases: ReadonlyArray<PhaseSnapshot>;
  /** Aggregate counters for the header — derived but cached. */
  readonly totalAgents: number;
  readonly runningAgents: number;
  readonly completedAgents: number;
  readonly queuedAgents: number;
  /** Aggregate token totals across all phases. */
  readonly totalTokens: number;
  readonly cachedTokens: number;
  /** Last 50 log entries (`pi-workflows.run.log`). */
  readonly logTail: ReadonlyArray<{ readonly at: string; readonly message: string }>;
}

export type PhaseFeedEntry =
  | {
      readonly customType: "pi-workflows.meta.phases";
      readonly data: {
        readonly runId: string;
        /** Phase titles declared in `meta.phases` — seeded as pending before any run. */
        readonly phases: ReadonlyArray<{ readonly title: string; readonly description?: string }>;
      };
    }
  | {
      readonly customType: "pi-workflows.phase.started";
      readonly data: {
        readonly runId: string;
        readonly phaseName: string;
        readonly agentCount: number;
        readonly startedAt?: string;
      };
    }
  | {
      readonly customType: "pi-workflows.phase.ended";
      readonly data: {
        readonly runId: string;
        readonly phaseName: string;
        readonly endedAt?: string;
        readonly durationMs?: number;
      };
    }
  | {
      readonly customType: "pi-workflows.agent.started";
      readonly data: {
        readonly runId: string;
        readonly phaseName: string;
        readonly agentId: string;
        readonly startedAt?: string;
        readonly summary?: string;
      };
    }
  | {
      readonly customType: "pi-workflows.agent.ended";
      readonly data: {
        readonly runId: string;
        readonly phaseName: string;
        readonly agentId: string;
        readonly endedAt?: string;
        readonly durationMs?: number;
        readonly cached?: boolean;
        readonly usage?: {
          readonly input: number;
          readonly output: number;
          readonly cacheRead: number;
          readonly cacheWrite: number;
          readonly totalTokens: number;
        };
      };
    }
  | {
      readonly customType: "pi-workflows.run.log";
      readonly data: {
        readonly runId: string;
        readonly at?: string;
        readonly message: string;
      };
    };

export type PhaseRegistryListener = (runId: string) => void;

interface MutablePhase {
  phaseName: string;
  status: PhaseStatus;
  agentCount: number;
  description?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  agents: Map<string, AgentSnapshot>;
  totalTokens: number;
  cachedTokens: number;
}

interface MutableRun {
  runId: string;
  phases: Map<string, MutablePhase>;
  log: { at: string; message: string }[];
}

const MAX_LOG_LINES = 50;

export class PhaseRegistry {
  readonly #runs = new Map<string, MutableRun>();
  readonly #listeners = new Set<PhaseRegistryListener>();
  #notifyScheduled = false;
  #notifyQueue = new Set<string>();

  applyEntry(entry: PhaseFeedEntry): void {
    const runId = entry.data.runId;
    if (typeof runId !== "string" || runId.length === 0) return;
    const run = this.#getOrInit(runId);

    switch (entry.customType) {
      case "pi-workflows.meta.phases": {
        // Pre-seed pending phases from meta declaration.
        // Only inserts phases that don't already exist (run may have started).
        for (const p of entry.data.phases) {
          const prior = run.phases.get(p.title);
          if (prior === undefined) {
            run.phases.set(p.title, {
              phaseName: p.title,
              status: "pending",
              agentCount: 0,
              agents: new Map(),
              totalTokens: 0,
              cachedTokens: 0,
              ...(p.description !== undefined ? { description: p.description } : {}),
            });
          } else if (p.description !== undefined && prior.description === undefined) {
            prior.description = p.description;
          }
        }
        break;
      }
      case "pi-workflows.phase.started": {
        const d = entry.data;
        const prior = run.phases.get(d.phaseName);
        const phase: MutablePhase = prior ?? {
          phaseName: d.phaseName,
          status: "running",
          agentCount: d.agentCount,
          agents: new Map(),
          totalTokens: 0,
          cachedTokens: 0,
        };
        phase.status = "running";
        phase.agentCount = d.agentCount;
        if (d.startedAt !== undefined) phase.startedAt = d.startedAt;
        run.phases.set(d.phaseName, phase);
        break;
      }
      case "pi-workflows.phase.ended": {
        const d = entry.data;
        const phase = run.phases.get(d.phaseName);
        if (phase === undefined) return;
        phase.status = "done";
        if (d.endedAt !== undefined) phase.endedAt = d.endedAt;
        if (d.durationMs !== undefined) phase.durationMs = d.durationMs;
        // Coerce any lingering "running"/"queued" agents to done so the view
        // doesn't show stale states (defensive — dispatcher should emit
        // agent.ended for each).
        for (const [aid, a] of phase.agents) {
          if (a.state !== "done") {
            phase.agents.set(aid, { ...a, state: "done" });
          }
        }
        break;
      }
      case "pi-workflows.agent.started": {
        const d = entry.data;
        const phase = run.phases.get(d.phaseName) ?? {
          phaseName: d.phaseName,
          status: "running" as const,
          agentCount: 1,
          agents: new Map<string, AgentSnapshot>(),
          totalTokens: 0,
          cachedTokens: 0,
        };
        const prior = phase.agents.get(d.agentId);
        const agent: AgentSnapshot = {
          agentId: d.agentId,
          state: "running",
          ...(d.startedAt !== undefined ? { startedAt: d.startedAt } : prior?.startedAt !== undefined ? { startedAt: prior.startedAt } : {}),
          ...(d.summary !== undefined ? { summary: d.summary } : prior?.summary !== undefined ? { summary: prior.summary } : {}),
        };
        phase.agents.set(d.agentId, agent);
        run.phases.set(d.phaseName, phase);
        break;
      }
      case "pi-workflows.agent.ended": {
        const d = entry.data;
        const phase = run.phases.get(d.phaseName);
        if (phase === undefined) return;
        const prior = phase.agents.get(d.agentId);
        // Subtract prior agent's contribution before overwriting (idempotent re-apply).
        if (prior?.usage !== undefined) {
          phase.totalTokens -= prior.usage.totalTokens;
          if (prior.cached === true) phase.cachedTokens -= prior.usage.totalTokens;
        }
        const next: AgentSnapshot = {
          agentId: d.agentId,
          state: "done",
          ...(prior?.startedAt !== undefined ? { startedAt: prior.startedAt } : {}),
          ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {}),
          ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
          ...(d.cached !== undefined ? { cached: d.cached } : {}),
          ...(prior?.summary !== undefined ? { summary: prior.summary } : {}),
          ...(d.usage !== undefined ? { usage: d.usage } : {}),
        };
        phase.agents.set(d.agentId, next);
        // Add this agent's token contribution to the phase totals.
        if (d.usage !== undefined) {
          phase.totalTokens += d.usage.totalTokens;
          if (d.cached === true) phase.cachedTokens += d.usage.totalTokens;
        }
        break;
      }
      case "pi-workflows.run.log": {
        const d = entry.data;
        run.log.push({
          at: d.at ?? new Date().toISOString(),
          message: d.message,
        });
        if (run.log.length > MAX_LOG_LINES) {
          run.log.splice(0, run.log.length - MAX_LOG_LINES);
        }
        break;
      }
    }
    this.#scheduleNotify(runId);
  }

  /**
   * Append a free-form log line for a run (test seam + slice 8b stdlib hooks).
   */
  appendLog(runId: string, message: string, at?: string): void {
    if (typeof runId !== "string" || runId.length === 0) return;
    const run = this.#getOrInit(runId);
    run.log.push({ at: at ?? new Date().toISOString(), message });
    if (run.log.length > MAX_LOG_LINES) {
      run.log.splice(0, run.log.length - MAX_LOG_LINES);
    }
    this.#scheduleNotify(runId);
  }

  getRunSnapshot(runId: string): RunPhaseSnapshot | undefined {
    const run = this.#runs.get(runId);
    if (run === undefined) return undefined;
    return this.#snapshot(run);
  }

  hasRun(runId: string): boolean {
    return this.#runs.has(runId);
  }

  forgetRun(runId: string): boolean {
    const removed = this.#runs.delete(runId);
    if (removed) this.#scheduleNotify(runId);
    return removed;
  }

  subscribe(listener: PhaseRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reset(): void {
    this.#runs.clear();
    this.#listeners.clear();
    this.#notifyQueue.clear();
  }

  /** ──────────────────────────────────────────────── private */

  #getOrInit(runId: string): MutableRun {
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing;
    const fresh: MutableRun = { runId, phases: new Map(), log: [] };
    this.#runs.set(runId, fresh);
    return fresh;
  }

  #snapshot(run: MutableRun): RunPhaseSnapshot {
    const phases: PhaseSnapshot[] = [];
    let totalAgents = 0;
    let runningAgents = 0;
    let completedAgents = 0;
    let queuedAgents = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    for (const phase of run.phases.values()) {
      const agentArr: AgentSnapshot[] = Array.from(phase.agents.values());
      // Stable sort by agentId for determinism.
      agentArr.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
      for (const a of agentArr) {
        totalAgents++;
        if (a.state === "running") runningAgents++;
        else if (a.state === "done") completedAgents++;
        else queuedAgents++;
      }
      totalTokens += phase.totalTokens;
      cachedTokens += phase.cachedTokens;
      phases.push({
        phaseName: phase.phaseName,
        status: phase.status,
        agentCount: phase.agentCount,
        ...(phase.description !== undefined ? { description: phase.description } : {}),
        ...(phase.startedAt !== undefined ? { startedAt: phase.startedAt } : {}),
        ...(phase.endedAt !== undefined ? { endedAt: phase.endedAt } : {}),
        ...(phase.durationMs !== undefined ? { durationMs: phase.durationMs } : {}),
        agents: agentArr,
        totalTokens: phase.totalTokens,
        cachedTokens: phase.cachedTokens,
      });
    }
    return {
      runId: run.runId,
      phases,
      totalAgents,
      runningAgents,
      completedAgents,
      queuedAgents,
      totalTokens,
      cachedTokens,
      logTail: run.log.slice(-MAX_LOG_LINES),
    };
  }

  #scheduleNotify(runId: string): void {
    this.#notifyQueue.add(runId);
    if (this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      const ids = Array.from(this.#notifyQueue);
      this.#notifyQueue.clear();
      for (const l of Array.from(this.#listeners)) {
        for (const id of ids) {
          try {
            l(id);
          } catch {
            /* listener errors must not break siblings */
          }
        }
      }
    });
  }
}

let _singleton: PhaseRegistry | null = null;

export function getPhaseRegistry(): PhaseRegistry {
  if (_singleton === null) _singleton = new PhaseRegistry();
  return _singleton;
}

export function __setPhaseRegistrySingletonForTest(
  next: PhaseRegistry | null,
): PhaseRegistry | null {
  const prior = _singleton;
  _singleton = next;
  return prior;
}
