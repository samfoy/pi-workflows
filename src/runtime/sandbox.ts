/**
 * pi-workflows — sandbox factory.
 *
 * Implements PRD §1.2 pin 5 (vm.Context with frozen curated globals;
 * NOT worker_thread), §4.3 (allowed/blocked globals table), §8.2-8.6
 * (sandbox surface + escape vectors). Slice 2 entry point.
 *
 * Invariants this module guarantees:
 *
 *   1. Every sandbox is a fresh `vm.Context`. No reuse — caller
 *      always gets a clean realm.
 *   2. After Context init, every curated global and its prototype
 *      chain (one level deep) is `Object.freeze`d. Writes throw.
 *   3. Disallowed globals (process, require, fetch, fs, child_process,
 *      worker_threads, Buffer with caveats) are NOT installed.
 *      Reference inside the script throws `ReferenceError`.
 *   4. The host bridge for timers is captured into the Context-realm
 *      `setTimeout`/etc. closures and then DELETED from `globalThis`.
 *      The script can't reach the bridge by enumeration.
 *   5. Errors thrown by the script propagate as Context-realm Errors;
 *      errors thrown by the host bridge are reconstructed as
 *      Context-realm Errors per PRD §8.3.4 before crossing the
 *      boundary.
 *
 * **Known footgun (PRD §8.3.6):** a sandbox script with a synchronous
 * infinite loop wedges the entire pi event loop. The TUI cannot
 * receive `x` (stop), the overlay cannot redraw, and `AbortSignal`
 * listeners cannot fire. The user must SIGINT pi from another
 * terminal. We accept this in v1 — alternative mitigations
 * (worker_threads, interrupt-on-tick) are out of scope per pin 5.
 * Documented in the parity-gaps stub (slice 18).
 *
 * **Resource exhaustion (memory):** also out of scope per §8.3.7. Node's
 * default heap (4GB) bounds the damage to one pi process; cross-run
 * isolation isn't part of the v1 trust model.
 *
 * Slice 2 covers the substrate. Slice 8a mounts the real workflow
 * author API (`ctx.agent`, `ctx.phase`, `ctx.cache.*`, `ctx.log`)
 * onto the same `runScript` entry point. Slice 7 wires the `log` DI
 * to the ledger writer.
 */

import vm from "node:vm";

import type {
  AgentHandleData,
  AgentResultLike,
  RunCtxBridgeResult,
  RunMetaData,
  SandboxOptions,
  SandboxResult,
  SandboxLogEntry,
  SandboxViolationError,
} from "../types/internal.js";
import { installTimerBridge, type TimerBridge } from "./timerTable.js";
import { rethrowAcrossRealm, safeStringifyThrown } from "./realmError.js";
import { STDLIB_INIT_SOURCE } from "./stdlib.js";
import { MAX_PROMPT_LENGTH } from "../util/limits.js";

/**
 * Payload passed through the bridge nonce slot.
 *
 * The init script reads each field, captures into closure-locals, and
 * deletes the global nonce property so user code can't enumerate the
 * payload back. PRD §8.3.4 host-realm-eval defense.
 */
interface HostBridgePayload {
  readonly timer: TimerBridge["bridge"];
  readonly consoleLog: (level: string, args: unknown[]) => void;
  readonly hostGlobals: HostGlobals;
  /**
   * Slice 8a — host-side runtime ctx bridge. May be `null` for slice-2
   * tests that don't need a real runtime; in that case the init
   * script falls back to the slice-2 stub literal. Captured into
   * closure-locals + DELETED from `globalThis` per the same
   * close-and-hide pattern as the timer/console bridges (PRD §8.3.4).
   */
  readonly runCtxHost: RunCtxHostInternal | null;
}

/**
 * Host-realm bridge object the init script captures into closure
 * locals. Same shape as `RunCtxHost` from `internal.d.ts` minus the
 * pure-data `runMeta` and `input` (which are JSON-stringified and
 * inlined into the bind script). Functions only.
 */
interface RunCtxHostInternal {
  agent(prompt: unknown, opts: unknown): RunCtxBridgeResult<AgentHandleData>;
  phase(
    name: unknown,
    agents: unknown,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<readonly (AgentResultLike | null)[]>>;
  cacheGet(key: unknown): Promise<RunCtxBridgeResult<unknown>>;
  cacheSet(key: unknown, value: unknown): Promise<RunCtxBridgeResult<null>>;
  cacheHas(key: unknown): Promise<RunCtxBridgeResult<boolean>>;
  cacheDelete(key: unknown): Promise<RunCtxBridgeResult<null>>;
  log(message: unknown, level: unknown): RunCtxBridgeResult<null>;
  finishCallback(prompt: unknown): RunCtxBridgeResult<null>;
  getBudgetSpent(): number;
  readonly tokenBudget: number | null;
  /** Improvement 5: ephemeral progress event. */
  progress(pct: unknown, message?: unknown): RunCtxBridgeResult<null>;
  /** Improvement 6: idempotent checkpoint. */
  checkpoint(label: unknown, data?: unknown): Promise<RunCtxBridgeResult<boolean>>;
  /** Improvement 7: structured report event. With `{format:'mermaid'}` returns a Mermaid DAG. */
  report(eventType: unknown, data?: unknown): RunCtxBridgeResult<null | string>;
  gate(message: unknown, opts?: unknown): Promise<RunCtxBridgeResult<boolean>>;
  /** ZONE_HITL: mid-phase pause-and-route primitive. */
  interrupt(opts: unknown): Promise<RunCtxBridgeResult<{ key: string; value: unknown }>>;
  /** ZONE_WORKTREE follow-up #2 — promote agent worktree edits to parent. */
  promote?(
    agentId: unknown,
    opts?: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      strategy: "apply" | "rebase";
      applied: boolean;
      files: readonly string[];
    }>
  >;
  memo_check(
    key: string,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<{ hit: boolean; value?: unknown }>>;
  memo_set(
    key: string,
    value: unknown,
    opts?: unknown,
  ): Promise<RunCtxBridgeResult<null>>;
  /** ZONE_MEMORY follow-up: stdlib helpers. Optional — see RunCtxHost. */
  memory_read?(
    name: unknown,
    scope: unknown,
  ): Promise<RunCtxBridgeResult<string | null>>;
  memory_append?(
    name: unknown,
    scope: unknown,
    text: unknown,
  ): Promise<RunCtxBridgeResult<null>>;
  memory_compact?(
    name: unknown,
    scope: unknown,
  ): Promise<
    RunCtxBridgeResult<{
      beforeBytes: number;
      afterBytes: number;
      ratio: number;
    }>
  >;
}

/**
 * Host-realm originals the init script wraps inside the Context. Each
 * field may be `undefined` if the host platform doesn't expose it.
 */
interface HostGlobals {
  readonly Buffer?: typeof Buffer | undefined;
  readonly crypto?: unknown;
  readonly URL?: typeof URL | undefined;
  readonly URLSearchParams?: typeof URLSearchParams | undefined;
  readonly TextEncoder?: typeof TextEncoder | undefined;
  readonly TextDecoder?: typeof TextDecoder | undefined;
  readonly atob?: typeof atob | undefined;
  readonly btoa?: typeof btoa | undefined;
}

/**
 * Snapshot host-realm originals once per sandbox construction. Fields
 * default to `undefined` if not present on the host's globalThis.
 */
function collectHostGlobals(): HostGlobals {
  const g = globalThis as Record<string, unknown>;
  return {
    Buffer: g.Buffer as typeof Buffer | undefined,
    crypto: g.crypto,
    URL: g.URL as typeof URL | undefined,
    URLSearchParams: g.URLSearchParams as typeof URLSearchParams | undefined,
    TextEncoder: g.TextEncoder as typeof TextEncoder | undefined,
    TextDecoder: g.TextDecoder as typeof TextDecoder | undefined,
    atob: g.atob as typeof atob | undefined,
    btoa: g.btoa as typeof btoa | undefined,
  };
}

/**
 * Random nonce for the bridge name on `globalThis` during init.
 * Mangling defends against typo-level access (`globalThis.__bridge`)
 * but not a determined attacker — the trust model assumes the author
 * is trusted (PRD §8.1). The init script DELETES this key after
 * capturing it into closure, so even the mangled name is unreachable
 * from user code.
 */
function bridgeNonce(): string {
  return (
    "__pi_workflows_bridge_" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

/**
 * Curated globals contract — PRD §4.3. The arrays are exported so
 * tests can iterate and assert each row.
 *
 * Allowed: ECMAScript intrinsics + selected Web APIs.
 * Blocked: every Node-specific or capability-bearing global.
 *
 * "Native" globals (those Node implements automatically inside a fresh
 * vm.Context) include all ECMAScript intrinsics — Object, Array,
 * Function, Promise, Error, Map, Set, WeakMap, WeakSet, Symbol, Date,
 * RegExp, Math, JSON, Number, String, Boolean, BigInt, ArrayBuffer,
 * typed arrays, DataView, AggregateError. Web APIs we INSTALL: URL,
 * URLSearchParams, TextEncoder, TextDecoder, atob, btoa.
 *
 * Conspicuously absent (must NOT be installed): fs, child_process,
 * net, http, https, dns, tls, stream, worker_threads, vm, Buffer,
 * process, require, module, dynamic-import, fetch, XMLHttpRequest.
 *
 * `setTimeout` / `setInterval` / `setImmediate` / `clearTimeout` /
 * `clearInterval` / `clearImmediate` / `queueMicrotask` are installed
 * by `installTimers` below (per §8.3.5 trampoline contract).
 *
 * `console.{log,info,warn,error,debug}` is installed by
 * `installConsole` below — wired to the SandboxOptions.log sink.
 *
 * `crypto.{subtle, randomUUID, getRandomValues}` is installed by
 * `installCrypto` — pulls Node's `globalThis.crypto` directly. Per PRD
 * §4.3 the docs warn that randomUUID/getRandomValues break cache
 * reproducibility.
 */
export const ALLOWED_NATIVE_GLOBALS: readonly string[] = [
  "Object",
  "Array",
  "Function",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AggregateError",
  "EvalError",
  "URIError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Date",
  "RegExp",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Reflect",
  "Proxy",
  "globalThis",
  "Infinity",
  "NaN",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
];

/**
 * Globals that are documented as ABSENT (PRD §4.3 ❌ rows). Sandbox
 * tests assert each is `undefined` from inside the Context.
 *
 * Note: `process` is NOT in this list — PRD §4.3 + §8.3.9 specify a
 * frozen stub (`{ env: {}, platform, arch, versions: { node } }`) is
 * present so author code doing `process.env.X || default` works.
 * `Buffer` is also NOT in this list — PRD §4.3 marks it ⚠ "Available".
 */
export const BLOCKED_GLOBALS: readonly string[] = [
  "require",
  "module",
  "global",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
];

/**
 * Globals that are stubbed (PRD §4.3 + §8.3.9). Tests assert the stub
 * is present and has the documented shape (e.g. `process.env === {}`).
 */
export const STUBBED_GLOBALS: readonly string[] = [
  "process",
];

/**
 * Web APIs we install on the Context. These are pulled directly from
 * the host's `globalThis` — they're pure data utilities (no I/O, no
 * capability) so realm-crossing them is safe per PRD §8.3.4 (host
 * functions wrapped on demand).
 *
 * `URL` and `URLSearchParams` ARE realm-leaks if the script does
 * `new URL("...").constructor === Object` (returns false because the
 * constructor is from host realm). For slice 2 we accept this — the
 * trust model says we're not defending against determined attackers
 * (§8.1).
 */
export const INSTALLED_WEB_APIS: readonly string[] = [
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "atob",
  "btoa",
];

/** Default debug name for `vm.createContext`. */
const DEFAULT_DEBUG_NAME = "pi-workflows:sandbox";

/**
 * Construct a violation error with the right `.name` shape.
 */
function violation(
  kind: SandboxViolationError["violation"],
  message: string,
  hostCause?: unknown,
): SandboxViolationError {
  const e = new Error(message) as Error & {
    name: "SandboxViolationError";
    violation: SandboxViolationError["violation"];
    hostCause?: unknown;
  };
  e.name = "SandboxViolationError";
  e.violation = kind;
  if (hostCause !== undefined) {
    Object.defineProperty(e, "hostCause", {
      value: hostCause,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return e as SandboxViolationError;
}

/**
 * Auto-detect script shape (PRD §4.1) and return a function-body
 * string ready for wrapping.
 *
 * Shape A: bare top-level — script body becomes the function body.
 * Shape B: `export default async function (ctx, input) { ... }` or
 *           `export default function (...) {...}` — extract the body.
 *
 * The detection is heuristic — slice 8a's docs recommend authors stick
 * to shape A or B canonical forms. Edge cases (multiple exports,
 * comments before `export default`, etc.) fall through to a regex
 * extractor that takes the first top-level `export default` body.
 *
 * Returns a `{ body, shape }` pair so error messages can cite the
 * detected shape. Throws `SandboxViolationError("shape-detect-failed")`
 * if shape B is detected but the body cannot be extracted (malformed
 * source).
 */
export function detectShape(source: string): {
  body: string;
  shape: "A" | "B" | "C";
} {
  // Strip line + block comments for shape detection only.
  const stripped = source
    .replace(/\/\/[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // Shape C: meta-header style — `export const meta = {...}; export async function main(ctx)`.
  // Used by write_workflow tool and bundled /codebase-audit.
  // Transform: strip `export` keywords from const/function declarations,
  // append `return await main(ctx);` as the implicit entry point.
  if (
    /(^|\n|\r)\s*export\s+const\s+meta\s*=/.test(stripped) &&
    /(^|\n|\r)\s*export\s+(?:async\s+)?function\s+main\s*\(/.test(stripped)
  ) {
    // Remove `export ` prefix from all top-level `export const/let/var/function/async function`.
    // This makes them plain declarations the vm can run as a script body.
    const body =
      source
        .replace(/^(\s*)export\s+(const|let|var|async\s+function|function)\s/gm, "$1$2 ") +
      "\nreturn await main(ctx);";
    return { body, shape: "C" };
  }

  // Shape B: export default function / arrow.
  if (!/(^|\n|\r)\s*export\s+default\s+/.test(stripped)) {
    return { body: source, shape: "A" };
  }

  // Shape B. Extract the body of `export default async? function (...) { ... }`.
  // Handle both function-declaration and arrow-function forms.
  const fnMatch = source.match(
    /export\s+default\s+(?:async\s+)?function\s*\*?\s*[A-Za-z_$][A-Za-z0-9_$]*?\s*\(([^)]*)\)\s*\{/,
  );
  // (named function — fnMatch[0] points at the opening brace)
  // Try anonymous function next:
  const anonMatch = source.match(
    /export\s+default\s+(?:async\s+)?function\s*\*?\s*\(([^)]*)\)\s*\{/,
  );
  const arrowMatch = source.match(
    /export\s+default\s+(?:async\s+)?\(([^)]*)\)\s*=>\s*\{/,
  );

  const matches = [fnMatch, anonMatch, arrowMatch].filter(
    (m): m is RegExpMatchArray => m !== null,
  );
  if (matches.length === 0) {
    // Could be `export default async (ctx, input) => expression` (no
    // brace). Or some other shape we don't handle.
    throw violation(
      "shape-detect-failed",
      "shape B detected (export default present) but function body unrecoverable",
    );
  }
  // Take the earliest match.
  const match = matches.sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  )[0]!;
  const start = (match.index ?? 0) + match[0].length;
  // Walk braces forward from `start` to find the matching close brace.
  // We don't try to honor strings/regexes/comments — too brittle. This
  // is good enough for canonical author code; slice 8a's tests catch
  // anything else.
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw violation(
      "shape-detect-failed",
      "shape B detected but braces unbalanced",
    );
  }
  const body = source.slice(start, i - 1);
  return { body, shape: "B" };
}

/**
 * Wrap a body in `(async (ctx, input) => { 'use strict'; <BODY> })`,
 * ready for `new vm.Script` compilation. The async wrapper means the
 * body's `await`s work and a top-level `return` cleanly resolves.
 *
 * The trailing `(ctx, input)` invocation is intentional — the script's
 * value is the Promise. Slice 8a's `runScript` awaits it.
 */
export function wrapBody(body: string): string {
  // Use `(0, async function(ctx, input){...})(ctx, input)` for the
  // "indirect call" form so the function isn't named (named function
  // expressions can shadow scope). The explicit IIFE captures `ctx`
  // and `input` from the outer scope (which the Sandbox installs as
  // bindings via `vm.runInContext`'s sandbox).
  return [
    "(async function __pi_workflows_user__(ctx, input) {",
    "  'use strict';",
    body,
    "})(globalThis.ctx, globalThis.input)",
  ].join("\n");
}

/**
 * Sandbox class. Constructs a vm.Context, installs the bridge, freezes
 * globals, and exposes `runScript(source)`. One-shot per slice 2; slice
 * 8a may want to reuse Contexts for resume — left to that slice.
 */
export class Sandbox {
  private readonly context: vm.Context;
  private readonly opts: SandboxOptions;
  private readonly logSink: SandboxLogEntry[] = [];
  private readonly logFn: (entry: SandboxLogEntry) => void;
  private readonly timerBridge: TimerBridge;
  private disposed = false;
  /** Per-run abort controller — set during runScript, null otherwise. */
  private _runAbort: AbortController | null = null;

  constructor(opts: SandboxOptions) {
    this.opts = opts;
    this.logFn =
      opts.log ??
      ((entry) => {
        this.logSink.push(entry);
      });

    // Build the sandbox object with ONLY the bridge + (input, ctx) slots.
    // We don't put curated globals here — they're already on the Context.
    const nonce = bridgeNonce();
    const sandboxBase: Record<string, unknown> = {};
    // Placeholder that the init script will replace with closures.
    // We need the bridge installed BEFORE we run init. installTimerBridge
    // requires the context, so we createContext first with empty
    // placeholders, then attach.
    const context = vm.createContext(sandboxBase, {
      name: opts.debugName ?? DEFAULT_DEBUG_NAME,
      codeGeneration: {
        // PRD §4.3 ⚠ row: eval / Function are AVAILABLE but useless
        // (they evaluate inside the same Context). Default to `false`
        // to match docs/threat-model.md §Sandbox construction; authors
        // who need `eval(string)` / `new Function(string)` opt in via
        // SandboxOptions.allowCodegen=true. The wrapper-identity
        // defense (PRD §8.3.4) makes opt-in safe-by-construction —
        // Function constructed inside the Context still resolves to
        // the Context's frozen globals — but defense in depth is worth
        // the extra keystroke.
        strings: opts.allowCodegen ?? false,
        wasm: false,
      },
    });
    this.context = context;

    // Install the timer bridge.
    this.timerBridge = installTimerBridge(context, {
      signal: opts.signal,
      onTimerError: (e) => {
        // Fires when realm-error reconstruction failed — pass the
        // SandboxViolationError to the log channel, then abort the run.
        this.logFn({
          t: new Date().toISOString(),
          level: "error",
          args: [
            "[sandbox-timer-error] " + safeStringifyThrown(e),
          ],
        });
        this._runAbort?.abort(new Error(safeStringifyThrown(e)));
      },
      onTimerContextError: (e) => {
        // Fires on the happy path: realm-error was reconstructed
        // successfully. Log via the same channel, then abort the run.
        this.logFn({
          t: new Date().toISOString(),
          level: "error",
          args: [
            "[sandbox-timer-error] " + safeStringifyThrown(e),
          ],
        });
        this._runAbort?.abort(new Error(safeStringifyThrown(e)));
      },
    });

    // Smuggle the bridge through the sandbox via a one-shot global.
    // Init script captures into closure and DELETES the global.
    //
    // The bridge object also carries the host-realm console log fn and
    // the host-realm originals for every curated global the init
    // script needs to wrap (Buffer, crypto, URL, URLSearchParams,
    // TextEncoder, TextDecoder, atob, btoa). Wrapping happens inside
    // the Context so the wrapper functions' `.constructor` resolves to
    // the Context's `Function` (PRD §8.3.4 host-realm-eval defense).
    const consoleHandler = (level: string, args: unknown[]): void => {
      const stringArgs = (Array.isArray(args) ? args : []).map((a) =>
        safeStringifyThrown(a),
      );
      const lvl: SandboxLogEntry["level"] =
        level === "log" ||
        level === "info" ||
        level === "warn" ||
        level === "error" ||
        level === "debug"
          ? level
          : "log";
      this.logFn({
        t: new Date().toISOString(),
        level: lvl,
        args: stringArgs,
      });
    };
    const hostBridge: HostBridgePayload = {
      timer: this.timerBridge.bridge,
      consoleLog: consoleHandler,
      hostGlobals: collectHostGlobals(),
      runCtxHost: opts.runCtxHost ?? null,
    };
    (sandboxBase as Record<string, unknown>)[nonce] = hostBridge;

    // Run init script: install timers, console, web APIs, freeze.
    try {
      vm.runInContext(buildInitScript(nonce), context, {
        displayErrors: true,
        filename: "pi-workflows-sandbox-init.js",
      });
    } catch (e) {
      this.timerBridge.dispose();
      throw violation(
        "init-script-failed",
        "sandbox init script threw: " + (e as Error).message,
        e,
      );
    }

    // Verify the bridge was hidden.
    const stillThere = vm.runInContext(
      `typeof globalThis['${nonce}']`,
      context,
    );
    if (stillThere !== "undefined") {
      throw violation(
        "bridge-tampered",
        "init script failed to hide bridge nonce — sandbox not safe",
      );
    }

    // Verify the console bridge is no longer enumerable from inside
    // the Context. The init script captured it into a closure-local
    // and deleted the global — same pattern as the timer nonce.
    const consoleBridgeStillThere = vm.runInContext(
      `Object.getOwnPropertyDescriptor(globalThis, '__pi_console_log__') !== undefined`,
      context,
    );
    if (consoleBridgeStillThere) {
      throw violation(
        "bridge-tampered",
        "init script failed to hide console bridge — sandbox not safe",
      );
    }

    // installConsole / installCrypto / installBuffer / installWebApis
    // were pre-bridge legacy helpers — now removed. The init script
    // wraps everything itself from the bridge payload (PRD §8.3.4
    // host-realm-eval defense).

    // NOTE: we intentionally do NOT call `Object.freeze(globalThis)`. In
    // a `vm.Context`, `globalThis` is a Proxy over the sandbox object
    // that refuses both `Object.freeze` and `Object.preventExtensions`
    // (Node throws "Cannot freeze" / "Cannot prevent extensions"). The
    // meaningful pollution defense is freezing `Object.prototype` and
    // friends — done in the init script. Authors CAN still write
    // `globalThis.foo = 1` inside the sandbox; that creates a property
    // on the Context's globalThis (NOT on the host's). Each `runScript`
    // call uses the same Context but rebinds `ctx`/`input` first, so a
    // prior run's stray globals are observable but harmless. PRD §8.3.2
    // only mandates Object.prototype freezing, which is what we do.
  }

  /**
   * Run a script source string. Auto-detects shape A vs B, wraps in
   * the async IIFE, compiles via `new vm.Script`, runs in this
   * sandbox's Context. Returns the user's return value (or undefined),
   * the captured log, and elapsed wall time.
   *
   * Throws:
   *   - SandboxViolationError if shape detection or compilation fails.
   *   - Whatever the user script throws (Context-realm Error, possibly
   *     reconstructed by the timer bridge).
   *   - AbortError if the run signal fires before/during compile.
   */
  async runScript(source: string): Promise<SandboxResult> {
    // BUG-024 fix: record log cursor so we return only logs from THIS call,
    // not all logs accumulated since construction.
    const logStart = this.logSink.length;
    if (this.disposed) {
      throw violation("init-script-failed", "sandbox already disposed");
    }
    if (this.opts.signal.aborted) {
      const e = new (vm.runInContext("Error", this.context) as ErrorConstructor)(
        "aborted before run",
      );
      // BUG-025 fix: set name='AbortError' to match raceWithAbort() output.
      Object.defineProperty(e, 'name', { value: 'AbortError', configurable: true, writable: true, enumerable: false });
      throw e;
    }

    const t0 = Date.now();

    // Detect shape, wrap.
    const { body } = detectShape(source);
    const wrapped = wrapBody(body);

    // Install ctx + input bindings on the Context's globalThis. We do
    // this RIGHT BEFORE running so a previous `runScript` call's
    // bindings don't bleed in.
    //
    // Slice 8a: when `runCtxHost` was supplied, the init script
    // installed `__pi_build_ctx(runMeta, input)`. We call it inside
    // the Context to build the frozen ctx. When no host was supplied
    // (slice-2 path), the same factory returns the slice-2 stub.
    //
    // We pass `runMeta` + `input` as JSON-source literals embedded in
    // the bind script. The literals evaluate inside the Context, so
    // the resulting objects' prototype chains run through the Context's
    // Object/Array (matches `host-input-realm.workflow.js` expectation
    // that `inputCtorIsCtxObject === true`). JSON.stringify is the
    // safe encoding because every value we embed is JSON-cloneable.
    const runMetaJson = JSON.stringify(
      this.opts.runCtxHost?.runMeta ?? slice2StubRunMeta(),
    );
    const inputJson =
      this.opts.runCtxHost !== undefined
        ? JSON.stringify(String(this.opts.runCtxHost.input ?? ""))
        : JSON.stringify(this.opts.input ?? null);
    const bindScript = [
      `globalThis.input = ${inputJson};`,
      // Slice 9: build a Context-realm signal pair, capture the abort
      // thunk back into the host realm, then forward host signal aborts
      // through it. The thunk is captured BEFORE we delete the global
      // so user code can never reach it.
      `globalThis.__pi_signal_pair__ = globalThis.__pi_make_signal();`,
      `globalThis.ctx = globalThis.__pi_build_ctx(${runMetaJson}, globalThis.input, globalThis.__pi_signal_pair__.signal);`,
    ].join("\n");
    try {
      vm.runInContext(bindScript, this.context, {
        filename: "pi-workflows-bind-ctx.js",
      });
    } catch (e) {
      throw violation(
        "init-script-failed",
        "ctx bind failed: " + (e as Error).message,
        e,
      );
    }

    // Capture the Context-realm abort thunk + delete the smuggle slot.
    let signalAbortThunk: ((reason?: unknown) => void) | null = null;
    try {
      signalAbortThunk = vm.runInContext(
        `(function(){ var p = globalThis.__pi_signal_pair__; delete globalThis.__pi_signal_pair__; return p && p.abort; })()`,
        this.context,
        { filename: "pi-workflows-signal-bind.js" },
      ) as (reason?: unknown) => void;
    } catch (e) {
      throw violation(
        "init-script-failed",
        "ctx.signal bind failed: " + (e as Error).message,
        e,
      );
    }

    // BUG-022: remove __pi_build_ctx and __pi_make_signal before user code
    // runs. They were needed during the bind phase but user code must not
    // be able to call them to create a second wired ctx (budget bypass).
    vm.runInContext(
      "delete globalThis.__pi_build_ctx; delete globalThis.__pi_make_signal;",
      this.context,
      { filename: "pi-workflows-cleanup.js" },
    );

    // Wire host signal → Context signal.
    const hostSignal = this.opts.signal;
    const fireCtxAbort = (): void => {
      if (!signalAbortThunk) return;
      const r = hostSignal.reason;
      const msg =
        r && typeof r === "object" && typeof (r as { message?: unknown }).message === "string"
          ? (r as { message: string }).message
          : r === undefined || r === null
            ? "aborted"
            : String(r);
      try {
        signalAbortThunk(msg);
      } catch {
        /* swallow — Context closures shouldn't throw out */
      }
    };
    if (hostSignal.aborted) {
      fireCtxAbort();
    } else {
      hostSignal.addEventListener("abort", fireCtxAbort, { once: true });
    }

    // Compile + run.
    let script: vm.Script;
    try {
      script = new vm.Script(wrapped, {
        filename: this.opts.debugName ?? "workflow.js",
      });
    } catch (e) {
      throw violation(
        "compile-failed",
        "workflow source did not compile: " + (e as Error).message,
        e,
      );
    }

    // Honor abort: race the script promise against the signal.
    // BUG-061: always remove the fireCtxAbort listener after the run
    // completes (normal return, abort, or non-abort rejection). The
    // { once: true } flag only self-removes when the signal fires; on
    // all other exit paths the listener stays registered, preventing
    // GC of the Context realm as long as the AbortController lives.
    //
    // _runAbort is set BEFORE runInContext so that onTimerContextError
    // callbacks (which can fire synchronously during the context's first
    // microtask tick) always see a non-null controller.
    this._runAbort = new AbortController();
    let promise: Promise<unknown>;
    try {
      promise = script.runInContext(this.context, {
        displayErrors: true,
        timeout: this.opts.runScriptTimeoutMs ?? 5_000,
      }) as Promise<unknown>;
    } catch (e) {
      // vm.Script.runInContext throws when the synchronous portion
      // exceeds `timeout`. The thrown object may have `instanceof Error`
      // === false due to cross-realm prototype chains, so we check
      // `name`/`message` directly.
      const _eAny = e as Record<string, unknown> | null;
      if (
        _eAny != null &&
        typeof _eAny.message === "string" &&
        (_eAny.message.includes("Script execution timed out") ||
          _eAny.message.includes("Execution timed out") ||
          _eAny.message.includes("timed out"))
      ) {
        throw violation(
          "sync-timeout",
          `workflow synchronous execution exceeded ${
            this.opts.runScriptTimeoutMs ?? 5_000
          }ms — possible infinite loop before first await`,
          e,
        );
      }
      // Synchronous error in the wrapper itself — re-throw the
      // Context-realm Error.
      throw rethrowAcrossRealm(e, this.context);
    }

    // Honor abort: race the script promise against the signal.
    // BUG-061: always remove the fireCtxAbort listener after the run
    // completes (normal return, abort, or non-abort rejection). The
    // { once: true } flag only self-removes when the signal fires; on
    // all other exit paths the listener stays registered, preventing
    // GC of the Context realm as long as the AbortController lives.
    let returnValue: unknown;
    try {
      returnValue = await raceWithAbort(
        promise,
        AbortSignal.any([this.opts.signal, this._runAbort.signal]),
        this.context,
      );
    } finally {
      hostSignal.removeEventListener("abort", fireCtxAbort);
      this._runAbort = null;
    }

    const durationMs = Date.now() - t0;
    return {
      returnValue,
      // BUG-024 fix: slice from logStart so only this call's logs are returned.
      log: this.logSink.slice(logStart),
      durationMs,
    };
  }

  /**
   * Tear down. Cancels all outstanding timers, drops the Context.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timerBridge.dispose();
  }

  /** Test/debug helper — peek at the captured log without running again. */
  takeLog(): readonly SandboxLogEntry[] {
    return this.logSink.slice();
  }

  /** Test helper — outstanding timer counts. */
  get timerStats(): TimerBridge["stats"] {
    return this.timerBridge.stats;
  }
}

/**
 * Convenience: construct, run, dispose. Slice 8a's `runWorkflow` will
 * use this directly.
 */
export async function runScript(
  source: string,
  opts: SandboxOptions,
): Promise<SandboxResult> {
  const sb = new Sandbox(opts);
  try {
    return await sb.runScript(source);
  } finally {
    sb.dispose();
  }
}

// ════════════════════════════════════════════════════════════════
// Internals
// ════════════════════════════════════════════════════════════════

/**
 * Race the user-script Promise against the AbortSignal. If the signal
 * fires first, reject with a Context-realm Error. The user script's
 * pending Promise is left dangling — its timer-driven side effects
 * have already been clipped by the timer bridge's dispose hook.
 */
async function raceWithAbort<T>(
  p: Promise<T>,
  signal: AbortSignal,
  context: vm.Context,
): Promise<T> {
  if (!signal.aborted) {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const ContextError = vm.runInContext("Error", context) as ErrorConstructor;
        const e = new ContextError("aborted");
        Object.defineProperty(e, "name", {
          value: "AbortError",
          configurable: true,
          writable: true,
          enumerable: false,
        });
        reject(e);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
  const ContextError = vm.runInContext("Error", context) as ErrorConstructor;
  const e = new ContextError("aborted");
  Object.defineProperty(e, "name", {
    value: "AbortError",
    configurable: true,
    writable: true,
    enumerable: false,
  });
  throw e;
}

/**
 * Slice-2 fallback runMeta values — used when no `runCtxHost` was
 * supplied so the security/sandbox tests still get a `ctx.run` shape.
 */
function slice2StubRunMeta(): RunMetaData {
  return {
    id: "wf-stub",
    workflowName: "stub",
    startedAt: "1970-01-01T00:00:00Z",
    cwd: ".",
    resumed: false,
  };
}

/**
 * The init script Source. Runs ONCE at Context construction.
 *
 * Responsibilities:
 *   1. Capture the bridge from `globalThis[nonce]` into a closure-local
 *      `__h`, then DELETE the global so user code can't enumerate it.
 *   2. Install Context-realm `setTimeout` / `clearTimeout` /
 *      `setInterval` / `clearInterval` / `setImmediate` /
 *      `clearImmediate` / `queueMicrotask` that delegate to `__h`.
 *   3. Install web APIs from the host (assigned via host bridge later;
 *      see `installWebAPIs`). The init script just declares the slot.
 *   4. Freeze `Object.prototype`, `Array.prototype`, `Function.prototype`,
 *      and other prototype targets named in PRD §8.3.2.
 *   5. Define the `console` object referencing a host-bridged log
 *      function (`__pi_console_log__`).
 *
 * The script is constructed in JS-source form because vm.compileFunction
 * is finicky with multi-line bodies and we want stable line numbers in
 * stack traces.
 */
function buildInitScript(nonce: string): string {
  return [
    "'use strict';",
    // BUG-023: IIFE makes all helper functions closure-local so they are
    // NOT properties of globalThis and user code cannot overwrite them
    // (e.g. poisoning __pi_unwrap to suppress error propagation).
    "(function() {",
    `const __bridge = globalThis[${JSON.stringify(nonce)}];`,
    `delete globalThis[${JSON.stringify(nonce)}];`,
    "const __h = __bridge.timer;",
    "const __consoleLog = __bridge.consoleLog;",
    "const __hostGlobals = __bridge.hostGlobals;",
    "const __runCtxHost = __bridge.runCtxHost;",
    "",
    "// Capture Reflect.apply before any user code runs and before Reflect is",
    "// frozen — all bridge wrappers use this reference (BUG-106).",
    "const __reflect_apply = Reflect.apply;",
    "",
    "// wrapHostMethod: builds a Context-realm function that delegates",
    "// to a host-realm method via Reflect.apply. The returned function's",
    "// .constructor is the Context's Function, so a script doing",
    "// `wrapped.constructor(\"return process\")()` evaluates inside the",
    "// Context (gets the process stub) instead of the host realm.",
    "// PRD §8.3.4.",
    "function wrapHostMethod(host) {",
    "  return function (...args) { return __reflect_apply(host, this, args); };",
    "}",
    "",
    "// Timers — Context-realm wrappers. `cb` is a Context-realm function;",
    "// the wrapper `() => cb(...args)` is also Context-realm so when the host's",
    "// Node timer fires it, execution starts in Context realm with `this===undefined`.",
    "globalThis.setTimeout = function setTimeout(cb, ms, ...args) {",
    "  if (typeof cb !== 'function') throw new TypeError('setTimeout: callback is not a function');",
    "  return __h.scheduleTimeout(() => { cb(...args); }, +ms || 0);",
    "};",
    "globalThis.clearTimeout = function clearTimeout(handle) {",
    "  if (typeof handle === 'number') __h.cancelTimeout(handle);",
    "};",
    "globalThis.setInterval = function setInterval(cb, ms, ...args) {",
    "  if (typeof cb !== 'function') throw new TypeError('setInterval: callback is not a function');",
    "  return __h.scheduleInterval(() => { cb(...args); }, +ms || 0);",
    "};",
    "globalThis.clearInterval = function clearInterval(handle) {",
    "  if (typeof handle === 'number') __h.cancelInterval(handle);",
    "};",
    "globalThis.setImmediate = function setImmediate(cb, ...args) {",
    "  if (typeof cb !== 'function') throw new TypeError('setImmediate: callback is not a function');",
    "  return __h.scheduleImmediate(() => { cb(...args); });",
    "};",
    "globalThis.clearImmediate = function clearImmediate(handle) {",
    "  if (typeof handle === 'number') __h.cancelImmediate(handle);",
    "};",
    "globalThis.queueMicrotask = function queueMicrotask(cb) {",
    "  if (typeof cb !== 'function') throw new TypeError('queueMicrotask: callback is not a function');",
    "  __h.queueMicrotask(() => { cb(); });",
    "};",
    "",
    "// `console` — closes over the host log fn captured into __consoleLog.",
    "// The bridge is NOT exposed on globalThis (PRD §8.3.4 — closure-hide",
    "// pattern matching the timer nonce).",
    "globalThis.console = Object.freeze({",
    "  log:   (...args) => { try { __consoleLog('log',   args); } catch (e) { /* swallow */ } },",
    "  info:  (...args) => { try { __consoleLog('info',  args); } catch (e) { /* swallow */ } },",
    "  warn:  (...args) => { try { __consoleLog('warn',  args); } catch (e) { /* swallow */ } },",
    "  error: (...args) => { try { __consoleLog('error', args); } catch (e) { /* swallow */ } },",
    "  debug: (...args) => { try { __consoleLog('debug', args); } catch (e) { /* swallow */ } },",
    "});",
    "",
    "// ---- Buffer (Context-realm wrapper namespace) ----------------",
    "// PRD §4.3 ⚠ row. Static methods are wrapped via wrapHostMethod",
    "// so .constructor walks land on Context Function. Instance methods",
    "// (e.g. Buffer.from('AB').toString) still walk to the host realm —",
    "// documented as a parity gap; authors who only use static methods",
    "// (encode/decode/concat) are safe.",
    "if (__hostGlobals.Buffer) {",
    "  const HB = __hostGlobals.Buffer;",
    "  globalThis.Buffer = Object.freeze({",
    "    from:        wrapHostMethod(HB.from),",
    "    alloc:       wrapHostMethod(HB.alloc),",
    "    allocUnsafe: wrapHostMethod(HB.allocUnsafe),",
    "    byteLength:  wrapHostMethod(HB.byteLength),",
    "    concat:      wrapHostMethod(HB.concat),",
    "    isBuffer:    wrapHostMethod(HB.isBuffer),",
    "    isEncoding:  wrapHostMethod(HB.isEncoding),",
    "    compare:     wrapHostMethod(HB.compare),",
    "  });",
    "}",
    "",
    "// ---- crypto (whitelisted methods) ----------------------------",
    "// Whitelist: randomUUID, randomBytes, randomFillSync, getRandomValues, subtle.",
    "// subtle IS exposed; all its methods are async and work across realm boundaries.",
    "if (__hostGlobals.crypto) {",
    "  const HC = __hostGlobals.crypto;",
    "  const cryptoNs = {};",
    "  if (typeof HC.randomUUID === 'function')",
    "    cryptoNs.randomUUID = wrapHostMethod(HC.randomUUID.bind(HC));",
    "  if (typeof HC.getRandomValues === 'function')",
    "    cryptoNs.getRandomValues = wrapHostMethod(HC.getRandomValues.bind(HC));",
    "  if (typeof HC.randomBytes === 'function')",
    "    cryptoNs.randomBytes = wrapHostMethod(HC.randomBytes.bind(HC));",
    "  if (typeof HC.randomFillSync === 'function')",
    "    cryptoNs.randomFillSync = wrapHostMethod(HC.randomFillSync.bind(HC));",
    "  if (HC.subtle)",
    "    cryptoNs.subtle = HC.subtle;",
    "  globalThis.crypto = Object.freeze(cryptoNs);",
    "}",
    "",
    "// ---- TextEncoder / TextDecoder (Context-realm classes) -------",
    "if (__hostGlobals.TextEncoder) {",
    "  const HTE = __hostGlobals.TextEncoder;",
    "  globalThis.TextEncoder = function TextEncoder() {",
    "    const inst = new HTE();",
    "    Object.defineProperty(this, 'encoding', { value: 'utf-8', enumerable: true });",
    "    this.encode = function encode(input) { return Reflect.apply(inst.encode, inst, [input]); };",
    "    this.encodeInto = function encodeInto(src, dest) { return Reflect.apply(inst.encodeInto, inst, [src, dest]); };",
    "    Object.freeze(this);",
    "  };",
    "  Object.freeze(globalThis.TextEncoder.prototype);",
    "  Object.freeze(globalThis.TextEncoder);",
    "}",
    "if (__hostGlobals.TextDecoder) {",
    "  const HTD = __hostGlobals.TextDecoder;",
    "  globalThis.TextDecoder = function TextDecoder(label, options) {",
    "    const inst = label === undefined ? new HTD() : (options === undefined ? new HTD(label) : new HTD(label, options));",
    "    Object.defineProperty(this, 'encoding', { value: inst.encoding, enumerable: true });",
    "    Object.defineProperty(this, 'fatal',    { value: inst.fatal,    enumerable: true });",
    "    Object.defineProperty(this, 'ignoreBOM',{ value: inst.ignoreBOM,enumerable: true });",
    "    this.decode = function decode(input, opts) { return Reflect.apply(inst.decode, inst, opts === undefined ? [input] : [input, opts]); };",
    "    Object.freeze(this);",
    "  };",
    "  Object.freeze(globalThis.TextDecoder.prototype);",
    "  Object.freeze(globalThis.TextDecoder);",
    "}",
    "",
    "// ---- URL / URLSearchParams (Context-realm classes) -----------",
    "// Snapshot model: properties are captured at construction; setters",
    "// are NOT supported (immutable URL). Authors who need mutation can",
    "// construct a new URL. PRD §4.3, parity-gaps.md.",
    "if (__hostGlobals.URL) {",
    "  const HU = __hostGlobals.URL;",
    "  const URL_PROPS = ['href','origin','protocol','username','password','host','hostname','port','pathname','search','hash'];",
    "  globalThis.URL = function URL(input, base) {",
    "    const u = base === undefined ? new HU(String(input)) : new HU(String(input), String(base));",
    "    for (let i = 0; i < URL_PROPS.length; i++) {",
    "      const k = URL_PROPS[i];",
    "      Object.defineProperty(this, k, { value: u[k], enumerable: true });",
    "    }",
    "    this.toString = function toString() { return u.href; };",
    "    this.toJSON   = function toJSON()   { return u.href; };",
    "    Object.freeze(this);",
    "  };",
    "  if (typeof HU.canParse === 'function') {",
    "    globalThis.URL.canParse = wrapHostMethod(HU.canParse.bind(HU));",
    "  }",
    "  Object.freeze(globalThis.URL.prototype);",
    "  Object.freeze(globalThis.URL);",
    "}",
    "if (__hostGlobals.URLSearchParams) {",
    "  const HUSP = __hostGlobals.URLSearchParams;",
    "  globalThis.URLSearchParams = function URLSearchParams(init) {",
    "    const u = init === undefined ? new HUSP() : new HUSP(init);",
    "    this.get        = function get(k)        { return Reflect.apply(u.get,        u, [k]); };",
    "    this.getAll     = function getAll(k)     { const arr = Reflect.apply(u.getAll, u, [k]); return Array.from(arr, String); };",
    "    this.has        = function has(k)        { return Reflect.apply(u.has,        u, [k]); };",
    "    this.set        = function set(k, v)     { Reflect.apply(u.set,        u, [k, v]); };",
    "    this.append     = function append(k, v)  { Reflect.apply(u.append,     u, [k, v]); };",
    "    this.delete     = function deleteFn(k)   { Reflect.apply(u.delete,     u, [k]); };",
    "    this.toString   = function toString()    { return u.toString(); };",
    "    this.entries    = function* entries()    { for (const e of u.entries()) yield [String(e[0]), String(e[1])]; };",
    "    this.keys       = function* keys()       { for (const k of u.keys()) yield String(k); };",
    "    this.values     = function* values()     { for (const v of u.values()) yield String(v); };",
    "    this.forEach    = function forEach(cb, thisArg) { u.forEach((v, k) => cb.call(thisArg, String(v), String(k), this)); };",
    "    Object.defineProperty(this, 'size', { get: () => u.size, enumerable: true });",
    "    Object.defineProperty(this, Symbol.iterator, { value: this.entries, enumerable: false, writable: false, configurable: false });",
    "    Object.freeze(this);",
    "  };",
    "  Object.freeze(globalThis.URLSearchParams.prototype);",
    "  Object.freeze(globalThis.URLSearchParams);",
    "}",
    "",
    "// ---- atob / btoa --------------------------------------------",
    "if (typeof __hostGlobals.atob === 'function') {",
    "  globalThis.atob = wrapHostMethod(__hostGlobals.atob);",
    "}",
    "if (typeof __hostGlobals.btoa === 'function') {",
    "  globalThis.btoa = wrapHostMethod(__hostGlobals.btoa);",
    "}",
    "",
    "// Process stub — PRD §8.3.9. Empty env, only platform/arch/versions.",
    "globalThis.process = Object.freeze({",
    "  env: Object.freeze({}),",
    "  platform: 'sandbox',",
    "  arch: 'sandbox',",
    "  versions: Object.freeze({ node: '0.0.0-sandbox' }),",
    "});",
    "// PRD §4.3 ❌ row: process is NOT supposed to be visible. The stub above",
    "// satisfies §8.3.9 (env leak prevention) but removes the row's claim.",
    "// We keep the stub since author code commonly does `process.env.X || default`.",
    "// Slice 8a docs MUST clarify this gap with PRD §4.3.",
    "",
    "",
    "// ---- ctx factory (slice 8a) --------------------------------",
    "// __runCtxHost is a host-realm bridge object (or null). We build a",
    "// Context-realm `__pi_build_ctx(runMetaJson, inputStr)` factory",
    "// function. Per-runScript bind path calls it inside the Context to",
    "// construct the frozen `ctx` object. All ctx.* methods are",
    "// Context-realm closures whose .constructor === Context Function",
    "// (PRD \u00a78.3.4 host-realm-eval defense \u2014 mirrors Buffer/crypto/URL",
    "// wrapping above).",
    "",
    "// wrapAsync: returns a Context-realm async function that calls a",
    "// host-realm tagged-result method. Inspects the {ok,value,error}",
    "// envelope; on `ok:true` clones value through Context JSON; on",
    "// `ok:false` reconstructs a Context-realm Error from the",
    "// RealmErrorRecord and throws it.",
    "function __pi_clone_into_ctx(value, seen) {",
    "  if (value === undefined) return undefined;",
    "  if (value === null) return null;",
    "  if (typeof value !== 'object') return value;",
    "  if (!seen) seen = new Set();",
    "  if (seen.has(value)) throw new Error('__pi_clone_into_ctx: circular reference detected');",
    "  seen.add(value);",
    "  var result;",
    "  if (Array.isArray(value)) {",
    "    result = new Array(value.length);",
    "    for (var i = 0; i < value.length; i++) {",
    "      result[i] = __pi_clone_into_ctx(value[i], seen);",
    "    }",
    "  } else {",
    "    result = {};",
    "    var keys = Object.keys(value);",
    "    for (var j = 0; j < keys.length; j++) {",
    "      var k = keys[j];",
    "      result[k] = __pi_clone_into_ctx(value[k], seen);",
    "    }",
    "  }",
    "  seen.delete(value);",
    "  return result;",
    "}",
    "function __pi_reconstruct_error(record) {",
    "  // record is a host-realm object but its fields are primitives",
    "  // and arrays of records. Rebuild as Context-realm Error/Aggregate.",
    "  if (!record || typeof record !== 'object') {",
    "    return new Error('unknown ctx bridge error');",
    "  }",
    "  const message = typeof record.message === 'string' ? record.message : '';",
    "  const name    = typeof record.name    === 'string' ? record.name    : 'Error';",
    "  let result;",
    "  if (record.errors && typeof record.errors.length === 'number') {",
    "    const children = [];",
    "    for (let i = 0; i < record.errors.length; i++) {",
    "      children.push(__pi_reconstruct_error(record.errors[i]));",
    "    }",
    "    result = new AggregateError(children, message);",
    "  } else {",
    "    result = new Error(message);",
    "  }",
    "  Object.defineProperty(result, 'name', { value: name, configurable: true, writable: true, enumerable: false });",
    "  if (typeof record.stack === 'string') {",
    "    Object.defineProperty(result, 'stack', { value: record.stack, configurable: true, writable: true, enumerable: false });",
    "  }",
    "  if (record.cause !== undefined && record.cause !== null) {",
    "    Object.defineProperty(result, 'cause', { value: __pi_reconstruct_error(record.cause), configurable: true, writable: true, enumerable: false });",
    "  }",
    "  return result;",
    "}",
    "function __pi_unwrap(envelope) {",
    "  if (!envelope || typeof envelope !== 'object') {",
    "    throw new Error('ctx bridge returned invalid envelope');",
    "  }",
    "  if (envelope.ok === true) return __pi_clone_into_ctx(envelope.value);",
    "  throw __pi_reconstruct_error(envelope.error);",
    "}",
    "function wrapHostAsync(host) {",
    "  // Plain (non-async) function so .constructor === Function.",
    "  // We still hand out a Promise; the chain unwraps host's tagged",
    "  // envelope on resolve. AsyncFunction's .constructor would be",
    "  // AsyncFunction (a different intrinsic) and would fail the",
    "  // wrapper-identity oracle in tests/security/host-realm-eval.",
    "  return function (...args) {",
    "    return Promise.resolve(__reflect_apply(host, this, args)).then(__pi_unwrap);",
    "  };",
    "}",
    "function wrapHostSync(host) {",
    "  return function (...args) {",
    "    return __pi_unwrap(__reflect_apply(host, this, args));",
    "  };",
    "}",
    "",
    // Slice 8b — install Context-realm stdlib helpers (vote, consensus,
    // parallel, retry, sleep). Defines __pi_install_stdlib on globalThis;
    // we capture-and-delete below so the factory survives via closure
    // but isn't reachable as a Reflect.ownKeys entry on globalThis.
    STDLIB_INIT_SOURCE,
    "const __pi_stdlib = globalThis.__pi_install_stdlib;",
    "delete globalThis.__pi_install_stdlib;",
    "",
    // Slice 9 — Context-realm AbortSignal factory used by `__pi_build_ctx`.
    // Each runScript() call mints a fresh signal pair (signal + abort).
    // The host captures the abort thunk after bind to wire the host
    // signal to it. The signal object's methods are pure Context-realm
    // closures — their .constructor === Context Function (PRD §8.3.4).
    "globalThis.__pi_make_signal = function () {",
    "  const listeners = [];",
    "  let aborted = false;",
    "  let reason = undefined;",
    "  const signal = {",
    "    get aborted() { return aborted; },",
    "    get reason() { return reason; },",
    "    addEventListener: function (name, fn, _opts) {",
    "      if (name !== 'abort' || typeof fn !== 'function') return;",
    "      for (let i = 0; i < listeners.length; i++) {",
    "        if (listeners[i] === fn) return;",
    "      }",
    "      listeners.push(fn);",
    "    },",
    "    removeEventListener: function (name, fn) {",
    "      if (name !== 'abort') return;",
    "      const idx = listeners.indexOf(fn);",
    "      if (idx >= 0) listeners.splice(idx, 1);",
    "    },",
    "    // gap-fix: real dispatchEvent — invokes listeners for the named",
    "    // event so author code that re-broadcasts via dispatchEvent works.",
    "    // Returns false iff a listener called event.preventDefault() (we",
    "    // don't model preventDefault here — always returns true).",
    "    dispatchEvent: function (event) {",
    "      if (!event || typeof event !== 'object' || event.type !== 'abort') return true;",
    "      const snapshot = listeners.slice();",
    "      for (let i = 0; i < snapshot.length; i++) {",
    "        try { snapshot[i].call(undefined, event); } catch (_) {}",
    "      }",
    "      return true;",
    "    },",
    "    // gap-fix: web AbortSignal.throwIfAborted() — synchronous guard",
    "    // authors use to bail out of long sync work.",
    "    throwIfAborted: function () {",
    "      if (aborted) {",
    "        throw reason !== undefined ? reason : new Error('aborted');",
    "      }",
    "    },",
    "  };",
    "  function abort(rawReason) {",
    "    if (aborted) return;",
    "    aborted = true;",
    "    // gap-fix: if the rawReason is already an Error (e.g. TimeoutError",
    "    // from AbortSignal.timeout), preserve it as-is so its name flows",
    "    // to throwIfAborted/listener callbacks unchanged. Only synthesize",
    "    // a fresh AbortError when the caller passed nothing or a non-Error.",
    "    if (rawReason && typeof rawReason === 'object' && typeof rawReason.message === 'string' && typeof rawReason.name === 'string') {",
    "      reason = rawReason;",
    "    } else {",
    "      let msg;",
    "      if (rawReason && typeof rawReason === 'object' && typeof rawReason.message === 'string') {",
    "        msg = rawReason.message;",
    "      } else if (rawReason === undefined || rawReason === null) {",
    "        msg = 'aborted';",
    "      } else {",
    "        msg = String(rawReason);",
    "      }",
    "      const err = new Error(msg);",
    "      Object.defineProperty(err, 'name', { value: 'AbortError', configurable: true, writable: true, enumerable: false });",
    "      reason = err;",
    "    }",
    "    const snapshot = listeners.slice();",
    "    listeners.length = 0;",
    "    for (let i = 0; i < snapshot.length; i++) {",
    "      try { snapshot[i].call(undefined, { type: 'abort', target: signal }); } catch (_) {}",
    "    }",
    "  }",
    "  Object.freeze(signal);",
    "  return { signal: signal, abort: abort };",
    "};",
    "",
    "// gap-fix: capture __pi_make_signal into the IIFE closure so the",
    "// AbortSignal namespace below can mint signals after the cleanup",
    "// step deletes globalThis.__pi_make_signal at end of init (BUG-022).",
    "const __pi_make_signal_fn = globalThis.__pi_make_signal;",
    "",
    "// gap-fix: globalThis.AbortSignal stand-in. The sandbox doesn't expose a",
    "// real AbortSignal *class* (the run-level signal is a plain object), so we",
    "// shim a namespace with the two static factories that web AbortSignal",
    "// ships: AbortSignal.timeout(ms) and AbortSignal.any(signals). Each",
    "// returns a fresh ctx-shaped signal (same shape as ctx.signal) so all",
    "// stdlib helpers and author code consume them uniformly.",
    "globalThis.AbortSignal = Object.freeze({",
    "  timeout: function (ms) {",
    "    const n = +ms;",
    "    if (!Number.isFinite(n) || n < 0) {",
    "      throw new TypeError('AbortSignal.timeout: ms must be a non-negative finite number');",
    "    }",
    "    const pair = __pi_make_signal_fn();",
    "    const t = __h.scheduleTimeout(function () {",
    "      const e = new Error('signal timed out');",
    "      Object.defineProperty(e, 'name', { value: 'TimeoutError', configurable: true, writable: true, enumerable: false });",
    "      pair.abort(e);",
    "    }, n);",
    "    void t;",
    "    return pair.signal;",
    "  },",
    "  any: function (signals) {",
    "    if (!Array.isArray(signals)) {",
    "      throw new TypeError('AbortSignal.any: signals must be an array');",
    "    }",
    "    const pair = __pi_make_signal_fn();",
    "    // If any input is already aborted, abort synchronously.",
    "    for (let i = 0; i < signals.length; i++) {",
    "      const s = signals[i];",
    "      if (s && s.aborted === true) {",
    "        pair.abort(s.reason);",
    "        return pair.signal;",
    "      }",
    "    }",
    "    // Otherwise, listen on each.",
    "    function onAbort() {",
    "      for (let i = 0; i < signals.length; i++) {",
    "        const s = signals[i];",
    "        if (s && s.aborted === true) {",
    "          pair.abort(s.reason);",
    "          return;",
    "        }",
    "      }",
    "    }",
    "    for (let i = 0; i < signals.length; i++) {",
    "      const s = signals[i];",
    "      if (s && typeof s.addEventListener === 'function') {",
    "        s.addEventListener('abort', onAbort, { once: true });",
    "      }",
    "    }",
    "    return pair.signal;",
    "  },",
    "});",
    "",
    "globalThis.__pi_build_ctx = function (runMeta, input, signal) {",
    "  // ctxRef is the late-bound back-reference the stdlib helpers close",
    "  // over. Populated AFTER ctx is built so vote/parallel/etc. can call",
    "  // ctx.phase without a circular-construction dance. Per-call ref",
    "  // means each script gets its own helper closures (no leak).",
    "  const __ctxRef = { current: null };",
    "  const __helpers = __pi_stdlib(__ctxRef);",,
    "  let __base;",
    "  if (!__runCtxHost) {",
    "    // Slice-2 stub branch — helpers exist (so wrapper-identity",
    "    // oracle passes) but throw 'no runtime' the moment they touch",
    "    // ctx.phase, which is itself a throwing stub.",
    "    __base = {",
    "      log:    function () { throw new Error('ctx.log: no runtime (slice-2 stub)'); },",
    "      agent:  function () { throw new Error('ctx.agent: no runtime (slice-2 stub)'); },",
    "      phase:  function () { throw new Error('ctx.phase: no runtime (slice-2 stub)'); },",
    "      cache:  Object.freeze({",
    "        get:    function () { throw new Error('ctx.cache: no runtime (slice-2 stub)'); },",
    "        set:    function () { throw new Error('ctx.cache: no runtime (slice-2 stub)'); },",
    "        has:    function () { throw new Error('ctx.cache: no runtime (slice-2 stub)'); },",
    "        delete: function () { throw new Error('ctx.cache: no runtime (slice-2 stub)'); },",
    "      }),",
    "      finishCallback: function () { throw new Error('ctx.finishCallback: no runtime (slice-2 stub)'); },",
    "      gate:           function () { throw new Error('ctx.gate: no runtime (slice-2 stub)'); },",
    "      interrupt:      function () { throw new Error('ctx.interrupt: no runtime (slice-2 stub)'); },",
    "      memo:           function () { throw new Error('ctx.memo: no runtime (slice-2 stub)'); },",
    "      budget: Object.freeze({ total: null, spent: function() { return 0; }, remaining: function() { return Infinity; } }),",
    "      run: Object.freeze({ id: 'wf-stub', workflowName: 'stub', startedAt: '1970-01-01T00:00:00Z', cwd: '.', resumed: false }),",
    "      input: '',",
    "      signal: signal,",
    "    };",
    "  } else {",
    "    const cache = Object.freeze({",
    "      get:    wrapHostAsync(__runCtxHost.cacheGet),",
    "      set:    wrapHostAsync(__runCtxHost.cacheSet),",
    "      has:    wrapHostAsync(__runCtxHost.cacheHas),",
    "      delete: wrapHostAsync(__runCtxHost.cacheDelete),",
    "    });",
    "    __base = {",
    "      log:            wrapHostSync(__runCtxHost.log),",
    "      agent:          wrapHostSync(__runCtxHost.agent),",
    "      phase:          wrapHostAsync(__runCtxHost.phase),",
    "      cache:          cache,",
    "      finishCallback: wrapHostSync(__runCtxHost.finishCallback),",
    "      gate:           wrapHostAsync(__runCtxHost.gate),",
    "      interrupt:      wrapHostAsync(__runCtxHost.interrupt),",
    "      memo:           async function(key, fn, opts) {",
    "        if (typeof key !== 'string') throw new TypeError('ctx.memo: key must be a string');",
    "        if (typeof fn !== 'function') throw new TypeError('ctx.memo: fn must be a function');",
    "        var checkResult = __pi_unwrap(await __runCtxHost.memo_check(key, opts));",
    "        if (checkResult.hit) return checkResult.value;",
    "        var value = await fn();",
    "        __pi_unwrap(await __runCtxHost.memo_set(key, value, opts));",
    "        return value;",
    "      },",
    "      run:            Object.freeze(runMeta),",
    "      input:          input,",
    "      signal:         signal,",
    "      budget:         Object.freeze({",
    "        total:     __runCtxHost.tokenBudget,",
    "        spent:     function() { return __runCtxHost.getBudgetSpent(); },",
    "        remaining: function() {",
    "          var t = __runCtxHost.tokenBudget;",
    "          return t === null ? Infinity : Math.max(0, t - __runCtxHost.getBudgetSpent());",
    "        },",
    "      }),",
    "    };",
    "  }",
    "  // BUG-001 fix: wrap ctx.agent so returned handles throw on await",
    "  var __rawAgent = __base.agent;",
    "  __base.agent = function() {",
    "    var __p = arguments[0];",
    `    if (typeof __p === 'string' && __p.length > ${MAX_PROMPT_LENGTH}) {`,
    "      throw new RangeError(",
    `        'ctx.agent: prompt exceeds MAX_PROMPT_LENGTH (got ' + __p.length + ', max ${MAX_PROMPT_LENGTH}). Chunk the input across multiple agents instead of relying on a single oversized call.'`,
    "      );",
    "    }",
    "    var handle = __rawAgent.apply(this, arguments);",
    "    if (handle && typeof handle === 'object' && handle.kind === 'agent') {",
    "      Object.defineProperty(handle, 'then', {",
    "        get: function() {",
    "          throw new TypeError(",
    "            'AgentHandle is not awaitable — wrap in ctx.phase(name, [handle]) to run it.',",
    "          );",
    "        },",
    "        enumerable: false,",
    "        configurable: false,",
    "      });",
    "    }",
    "    return handle;",
    "  };",
    "  __base.vote      = __helpers.vote;",
    "  __base.consensus = __helpers.consensus;",
    "  __base.parallel  = __helpers.parallel;",
    "  __base.pipeline  = __helpers.pipeline;",
    "  __base.retry     = __helpers.retry;",
    "  __base.sleep     = __helpers.sleep;",
    "  // gap-fix stdlib additions:",
    "  __base.aggregate   = __helpers.aggregate;",
    "  __base.extractJSON = __helpers.extractJSON;",
    "  __base.critique    = __helpers.critique;",
    "  // Improvements 5-7: progress, checkpoint, report bindings.",
    "  if (__runCtxHost) {",
    "    __base.progress    = wrapHostSync(__runCtxHost.progress);",
    "    __base.checkpoint  = wrapHostAsync(__runCtxHost.checkpoint);",
    "    __base.report      = wrapHostSync(__runCtxHost.report);",
    "    // ZONE_MEMORY follow-up #6: stdlib helpers ctx.memory.*",
    "    __base.memory      = Object.freeze({",
    "      read:    wrapHostAsync(__runCtxHost.memory_read),",
    "      append:  wrapHostAsync(__runCtxHost.memory_append),",
    "      compact: wrapHostAsync(__runCtxHost.memory_compact),",
    "    });",
    "    // ZONE_WORKTREE follow-up #2: ctx.promote(agentId, opts?).",
    "    __base.promote     = wrapHostAsync(__runCtxHost.promote);",,
    "  } else {",
    "    __base.progress   = function() { throw new Error('ctx.progress: no runtime (slice-2 stub)'); };",
    "    __base.checkpoint = function() { throw new Error('ctx.checkpoint: no runtime (slice-2 stub)'); };",
    "    __base.report     = function() { throw new Error('ctx.report: no runtime (slice-2 stub)'); };",
    "    __base.memory     = Object.freeze({",
    "      read:    function() { throw new Error('ctx.memory.read: no runtime (slice-2 stub)'); },",
    "      append:  function() { throw new Error('ctx.memory.append: no runtime (slice-2 stub)'); },",
    "      compact: function() { throw new Error('ctx.memory.compact: no runtime (slice-2 stub)'); },",
    "    });",
    "    __base.promote    = function() { throw new Error('ctx.promote: no runtime (slice-2 stub)'); };",,
    "  }",
    "  const ctx = Object.freeze(__base);",
    "  __ctxRef.current = ctx;",
    "  // Expose budget as a read-only top-level global (Michaelliv compat).",
    "  // BUG-111: use Object.defineProperty so user code cannot overwrite or",
    "  // delete the alias, and a prior run's mutation cannot persist across",
    "  // multiple runScript() calls on the same Sandbox.",
    "  Object.defineProperty(globalThis, 'budget', { value: ctx.budget, writable: false, configurable: false, enumerable: true });",
    "  return ctx;",
    "};",
    "",
    "// Prototype-pollution defense \u2014 PRD \u00a78.3.2.",
    "Object.freeze(Object.prototype);",
    "Object.freeze(Array.prototype);",
    "Object.freeze(Function.prototype);",
    "Object.freeze(String.prototype);",
    "Object.freeze(Number.prototype);",
    "Object.freeze(Boolean.prototype);",
    "Object.freeze(Symbol.prototype);",
    "Object.freeze(Error.prototype);",
    "Object.freeze(Promise.prototype);",
    "Object.freeze(Map.prototype);",
    "Object.freeze(Set.prototype);",
    "Object.freeze(WeakMap.prototype);",
    "Object.freeze(WeakSet.prototype);",
    "Object.freeze(Date.prototype);",
    "Object.freeze(RegExp.prototype);",
    "Object.freeze(JSON);",
    "Object.freeze(Math);",
    "Object.freeze(Reflect);",
    "// BUG-108: freeze AsyncFunction/GeneratorFunction prototypes so user code",
    "// cannot add a `then` property and make stdlib async helpers thenable.",
    "Object.freeze(Object.getPrototypeOf(async function(){}));",
    "Object.freeze(Object.getPrototypeOf(function*(){}));",
    "Object.freeze(Object.getPrototypeOf(async function*(){}));",
    "// Note: globalThis itself is frozen at the very end of init by",
    "// finalFreeze() — host-side, after we install console+crypto+webapis.",
    "}());",
  ].join("\n");
}

