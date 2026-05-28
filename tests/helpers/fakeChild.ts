/**
 * Helper: a minimal `child_process.spawn`-shaped fake. Tests can drive
 * stdout/stderr from a string (or array of strings) and pick exit
 * code + signal. No real subprocess is created.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import type { SpawnLike, SpawnedChildLike } from "../../src/types/internal.js";

export interface FakeChildSpec {
  /** Lines (each gets `\n`) or raw chunks emitted on stdout. */
  stdout?: ReadonlyArray<string | Buffer>;
  /** Same for stderr. */
  stderr?: ReadonlyArray<string | Buffer>;
  /** Wall-clock delay before exit fires. Default 0. */
  exitDelayMs?: number;
  /** Exit code. Default 0. */
  exitCode?: number | null;
  /** Exit signal. Default null. */
  exitSignal?: NodeJS.Signals | null;
  /**
   * If set, simulate a child that ignores SIGTERM — the kill() call
   * doesn't change exitCode/signal. Otherwise SIGTERM aborts the
   * pending exit and exits with signal 'SIGTERM'.
   */
  ignoresSigterm?: boolean;
}

export interface FakeSpawnRecord {
  command: string;
  args: readonly string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    [k: string]: unknown;
  };
}

/**
 * Returns a `SpawnLike` that records every call and produces
 * deterministic stdout/stderr/exit per the supplied spec script.
 */
export function makeFakeSpawn(scripts: FakeChildSpec[] | (() => FakeChildSpec)): {
  spawn: SpawnLike;
  calls: FakeSpawnRecord[];
} {
  const calls: FakeSpawnRecord[] = [];
  let i = 0;
  const spawn: SpawnLike = (
    command,
    args,
    options,
  ): SpawnedChildLike => {
    calls.push({ command, args, options: options as FakeSpawnRecord["options"] });
    const spec: FakeChildSpec = Array.isArray(scripts) ? scripts[i++] ?? {} : scripts();
    const stdoutChunks = (spec.stdout ?? []).map((s) =>
      typeof s === "string" ? Buffer.from(s, "utf8") : s,
    );
    const stderrChunks = (spec.stderr ?? []).map((s) =>
      typeof s === "string" ? Buffer.from(s, "utf8") : s,
    );

    const stdout = Readable.from(asyncIter(stdoutChunks));
    const stderr = Readable.from(asyncIter(stderrChunks));
    const child: SpawnedChildLike & EventEmitter = Object.assign(
      new EventEmitter(),
      {
        stdout,
        stderr,
        pid: 11111 + i,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
          if (spec.ignoresSigterm) return true;
          // Force-exit immediately on the next tick.
          setImmediate(() => fireExit(signal));
          return true;
        },
      },
    ) as SpawnedChildLike & EventEmitter;

    let fired = false;
    const fireExit = (signalOverride?: NodeJS.Signals | null): void => {
      if (fired) return;
      fired = true;
      const code = signalOverride ? null : spec.exitCode ?? 0;
      const signal = signalOverride ?? spec.exitSignal ?? null;
      (child as unknown as { exitCode: number | null }).exitCode = code;
      (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = signal;
      (child as EventEmitter).emit("exit", code, signal);
    };
    setTimeout(fireExit, spec.exitDelayMs ?? 0);

    return child;
  };
  return { spawn, calls };
}

async function* asyncIter(chunks: Buffer[]): AsyncGenerator<Buffer, void, void> {
  for (const c of chunks) {
    // Yield each chunk with a tick of breathing room so it feels
    // stream-y (also lets the parser observe partial-line state).
    await new Promise<void>((r) => setImmediate(r));
    yield c;
  }
}
