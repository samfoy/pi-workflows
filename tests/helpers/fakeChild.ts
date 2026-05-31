/**
 * Helper: a minimal `child_process.spawn`-shaped fake. Tests can drive
 * stdout/stderr from a string (or array of strings) and pick exit
 * code + signal. No real subprocess is created.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

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
  /**
   * If set, the child also ignores SIGKILL. Used to verify the
   * dispatcher emits BOTH signals on the SIGTERM→SIGKILL escalation
   * path — inspect `signalsSent` on the returned record.
   */
  ignoresSigkill?: boolean;
  /**
   * If true, the stdout iterator hangs after emitting all chunks
   * instead of completing. Use to model a real subprocess whose
   * stdout stays open until the child exits — the dispatcher's
   * timeout-path tests need this so the timeout fires before the
   * stream ends and clears it.
   */
  stdoutNeverEnds?: boolean;
}

export interface FakeSpawnRecord {
  command: string;
  args: readonly string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    [k: string]: unknown;
  };
  /**
   * Every signal name passed to `child.kill(signal)` for this spawn,
   * in order. Lets tests assert SIGTERM→SIGKILL escalation without
   * spying on internal timers.
   */
  signalsSent: NodeJS.Signals[];
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
    const record: FakeSpawnRecord = {
      command,
      args,
      options: options as FakeSpawnRecord["options"],
      signalsSent: [],
    };
    calls.push(record);
    const spec: FakeChildSpec = Array.isArray(scripts) ? scripts[i++] ?? {} : scripts();
    const stdoutChunks = (spec.stdout ?? []).map((s) =>
      typeof s === "string" ? Buffer.from(s, "utf8") : s,
    );
    const stderrChunks = (spec.stderr ?? []).map((s) =>
      typeof s === "string" ? Buffer.from(s, "utf8") : s,
    );

    // PassThrough vs Readable.from(): when stdoutNeverEnds is true
    // we need to leave the stream open until exit so the dispatcher's
    // timeout path actually gets a chance to fire (Readable.from of a
    // finished iterator would emit 'end' immediately and the
    // dispatcher would clearTimeout the escalation before it ran).
    let stdout: NodeJS.ReadableStream;
    let stderr: NodeJS.ReadableStream;
    if (spec.stdoutNeverEnds === true) {
      const ptStdout = new PassThrough();
      const ptStderr = new PassThrough();
      // Push initial chunks asynchronously so the parser sees them.
      void (async () => {
        for (const c of stdoutChunks) {
          await new Promise<void>((r) => setImmediate(r));
          ptStdout.write(c);
        }
        // Don't end — wait for fireExit to destroy.
      })();
      void (async () => {
        for (const c of stderrChunks) {
          await new Promise<void>((r) => setImmediate(r));
          ptStderr.write(c);
        }
      })();
      stdout = ptStdout;
      stderr = ptStderr;
    } else {
      stdout = Readable.from(asyncIter(stdoutChunks));
      stderr = Readable.from(asyncIter(stderrChunks));
    }
    const child: SpawnedChildLike & EventEmitter = Object.assign(
      new EventEmitter(),
      {
        stdout,
        stderr,
        pid: 11111 + i,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
          record.signalsSent.push(signal);
          if (signal === "SIGTERM" && spec.ignoresSigterm) return true;
          if (signal === "SIGKILL" && spec.ignoresSigkill) return true;
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
      // Mirror real subprocess behavior: exit closes stdout/stderr.
      // Without this, a `stdoutNeverEnds: true` stream would block
      // the parser's `for await` loop even after the child died.
      // Use end()-then-destroy() to flush any pending writes (chunks
      // written by the async pumps above) and then signal EOF.
      try {
        if (typeof (stdout as PassThrough).end === "function") {
          (stdout as PassThrough).end();
        } else {
          (stdout as Readable).destroy();
        }
      } catch { /* ignore */ }
      try {
        if (typeof (stderr as PassThrough).end === "function") {
          (stderr as PassThrough).end();
        } else {
          (stderr as Readable).destroy();
        }
      } catch { /* ignore */ }
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
