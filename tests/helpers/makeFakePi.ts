/**
 * tests/helpers/makeFakePi.ts — in-memory pi runtime stub.
 *
 * Provides just enough of `ExtensionAPI` for slice-1 unit and
 * integration tests to drive the extension without booting real pi.
 *
 * Surface mirrored from `pi-coding-agent`'s public types
 * (`@earendil-works/pi-coding-agent`):
 *
 *   - `pi.registerCommand(name, options)`     — captured into a Map
 *   - `pi.on(event, handler)`                  — captured by event name
 *   - `pi.sendMessage(message, opts?)`         — captured into an array
 *   - `pi.appendEntry(customType, data?)`      — captured into an array
 *
 * Helpers:
 *
 *   - `fakePi.fireSessionStart(cwd)` — invoke all `session_start`
 *     handlers in registration order with a fake `ExtensionContext`.
 *   - `fakePi.invokeCommand(name, args)` — run the registered handler
 *     for `/<name>` with the same fake `ExtensionCommandContext`.
 *   - `fakePi.notifications`           — observed `ctx.ui.notify` calls.
 *
 * Slice 6 will extend this with subprocess-mock support (the
 * dispatcher's `mockDispatch` reads from `fixtures.jsonl`). The
 * fixtures.jsonl schema is documented inline below so slice-1 tests
 * that reference it stay accurate; slice 6 implements the loader.
 *
 * fixtures.jsonl schema (per `plan.md` §5.2):
 *
 *   { "agentId": "...", "promptHash": "<sha256>",
 *     "result": { ...AgentResult... } }
 *
 * One record per `(agentId, promptHash)` pair. Slice-1 tests don't
 * read this; the helper just notes the contract.
 */

import type {
  ExtensionContextLike,
} from "../../src/types/internal.js";

export interface FakeRegisteredCommand {
  readonly name: string;
  readonly description?: string;
  readonly handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

export interface FakeSentMessage {
  readonly customType: string;
  readonly content: string;
  readonly display?: boolean;
  readonly details?: unknown;
  readonly options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

export interface FakeNotification {
  readonly message: string;
  readonly type: "info" | "warning" | "error";
}

export interface FakeAppendEntry {
  readonly customType: string;
  readonly data: unknown;
}

export interface FakeUserMessage {
  readonly prompt: string;
  readonly options?: { deliverAs?: "steer" | "followUp" };
}

export interface FakeContext {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    /** Slice 13 — fakePi's `ctx.ui.custom` mock. The harness records
     * the factory; tests can drive the overlay via `fakePi.overlayMounts[i].component.handleInput(key)`.
     * Returns a never-resolving Promise (the real overlay is closed by
     * `done()`); the harness exposes `mount.done()` to fire it. */
    custom?: FakeCustomFn;
    /**
     * ZONE_TUI_HITL_FORK — confirm dialog mock. Tests that need
     * the resume / fork / interrupt flows to choose an answer set
     * `pi.nextConfirmAnswer = true|false` before invoking the command.
     * Default: `true` (matches pi-coding-agent's bare-minimum surface
     * where confirm is optional).
     */
    confirm?: (title: string, message?: string) => Promise<boolean>;
    /**
     * ZONE_TUI_HITL_FORK — free-text input mock. When set, returns the
     * value queued via `pi.nextInputAnswers.push(...)` (FIFO) so a
     * test that drives multi-step prompts (atPhase + overrides JSON)
     * gets each answer in turn.
     */
    input?: (
      title: string,
      placeholder?: string,
    ) => Promise<string | undefined>;
    /**
     * ZONE_TUI_HITL_FORK — select dialog mock. Returns the value
     * queued via `pi.nextSelectAnswers.push(...)` (FIFO).
     */
    select?: (
      title: string,
      options: string[],
    ) => Promise<string | undefined>;
  };
}

export interface FakeCommandContext extends FakeContext {
  /** Slice 1 doesn't need session control; placeholder for slice 11+. */
  readonly waitForIdle?: () => Promise<void>;
}

export interface FakeOverlayMount {
  readonly component: {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
    dispose?(): void;
  };
  readonly overlay: boolean;
  done(result?: unknown): void;
  closed: boolean;
}

export type FakeCustomFn = NonNullable<ExtensionContextLike["ui"]["custom"]>;

export interface FakePi {
  // ── ExtensionAPI surface ──────────────────────────────────────
  registerCommand(name: string, options: Omit<FakeRegisteredCommand, "name">): void;
  on(event: "session_start", handler: (e: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  on(event: "session_shutdown", handler: (e: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  on(event: string, handler: (e: unknown, ctx: ExtensionContextLike) => unknown): void;
  sendMessage<T = unknown>(
    message: { customType: string; content: string; display?: boolean; details?: T },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(
    prompt: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;

  // ── Inspection ────────────────────────────────────────────────
  readonly commands: ReadonlyMap<string, FakeRegisteredCommand>;
  readonly handlers: ReadonlyMap<string, ReadonlyArray<(e: unknown, ctx: FakeContext) => Promise<void> | void>>;
  readonly messages: ReadonlyArray<FakeSentMessage>;
  readonly notifications: ReadonlyArray<FakeNotification>;
  readonly entries: ReadonlyArray<FakeAppendEntry>;
  readonly userMessages: ReadonlyArray<FakeUserMessage>;
  /** Slice 13 — every overlay factory the extension mounted via
   * `ctx.ui.custom`. Tests assert on length to verify mount/no-mount
   * and call `mount.component.handleInput(key)` to drive hotkeys. */
  readonly overlayMounts: ReadonlyArray<FakeOverlayMount>;
  /** ZONE_TUI_HITL_FORK — next answer for `ctx.ui.confirm`. Default true. */
  nextConfirmAnswer: boolean;
  /** ZONE_TUI_HITL_FORK — FIFO queue of answers for `ctx.ui.input`. */
  nextInputAnswers: string[];
  /** ZONE_TUI_HITL_FORK — FIFO queue of answers for `ctx.ui.select`. */
  nextSelectAnswers: string[];
  /** ZONE_TUI_HITL_FORK — record of confirm calls (for assertions). */
  readonly confirmCalls: ReadonlyArray<{ title: string; message?: string }>;
  readonly inputCalls: ReadonlyArray<{ title: string; placeholder?: string }>;
  readonly selectCalls: ReadonlyArray<{ title: string; options: string[] }>;

  // ── Drivers ───────────────────────────────────────────────────
  /** Fires every `session_start` handler in registration order. */
  fireSessionStart(cwd: string): Promise<void>;
  /** Slice 10: fires `session_shutdown` handlers in registration order. */
  fireSessionShutdown(cwd: string): Promise<void>;
  /** Invokes a registered slash command's handler. */
  invokeCommand(name: string, args?: string): Promise<void>;
  /** Resets observed-call buffers without forgetting registrations. */
  resetObservations(): void;
}

export interface MakeFakePiOpts {
  /** Override the `ctx.cwd` used by `fireSessionStart`. */
  readonly cwd?: string;
}

export function makeFakePi(_opts: MakeFakePiOpts = {}): FakePi {
  const commands = new Map<string, FakeRegisteredCommand>();
  const handlers = new Map<string, Array<(e: unknown, ctx: FakeContext) => Promise<void> | void>>();
  const messages: FakeSentMessage[] = [];
  const notifications: FakeNotification[] = [];
  const entries: FakeAppendEntry[] = [];
  const userMessages: FakeUserMessage[] = [];
  const overlayMounts: FakeOverlayMount[] = [];
  // ZONE_TUI_HITL_FORK — prompt mocks. The makeCtx() factory below
  // wires these into ctx.ui.{confirm,input,select} so workflowCmd.ts
  // (and any other consumer of these prompts) can be black-box tested.
  const confirmCalls: { title: string; message?: string }[] = [];
  const inputCalls: { title: string; placeholder?: string }[] = [];
  const selectCalls: { title: string; options: string[] }[] = [];
  let nextConfirmAnswer = true;
  const nextInputAnswers: string[] = [];
  const nextSelectAnswers: string[] = [];
  /**
   * Slice 13 — fake `ctx.ui.custom`. Captures the factory; awaiting
   * the returned Promise blocks until `done()` fires (mirrors real
   * pi-tui's contract).
   */
  const fakeCustom: FakeCustomFn = async (factory, options = {}) => {
    let resolveFn: (v: unknown) => void;
    const p = new Promise<unknown>((r) => {
      resolveFn = r;
    });
    let mountRecord!: FakeOverlayMount;
    const result = factory(
      {} as never,
      {} as never,
      {} as never,
      ((v: unknown) => {
        if (mountRecord) mountRecord.closed = true;
        resolveFn(v);
      }) as never,
    );
    const component = (await Promise.resolve(result)) as FakeOverlayMount["component"];
    mountRecord = {
      component,
      overlay: options.overlay === true,
      done: ((v?: unknown) => resolveFn(v)) as (r?: unknown) => void,
      closed: false,
    };
    overlayMounts.push(mountRecord);
    return p as never;
  };

  const makeCtx = (cwd: string): FakeCommandContext => ({
    cwd,
    ui: {
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
      custom: fakeCustom,
      async confirm(title, message) {
        const call: { title: string; message?: string } = { title };
        if (message !== undefined) call.message = message;
        confirmCalls.push(call);
        return nextConfirmAnswer;
      },
      async input(title, placeholder) {
        const call: { title: string; placeholder?: string } = { title };
        if (placeholder !== undefined) call.placeholder = placeholder;
        inputCalls.push(call);
        if (nextInputAnswers.length === 0) return undefined;
        return nextInputAnswers.shift();
      },
      async select(title, options) {
        selectCalls.push({ title, options });
        if (nextSelectAnswers.length === 0) return undefined;
        return nextSelectAnswers.shift();
      },
    },
  });

  const pi: FakePi = {
    registerCommand(name, options) {
      commands.set(name, { name, ...options });
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (e: unknown, ctx: FakeContext) => void | Promise<void>);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      const entry: FakeSentMessage = options !== undefined
        ? { ...message, options }
        : { ...message };
      messages.push(entry);
    },
    sendUserMessage(prompt, options) {
      userMessages.push(options !== undefined ? { prompt, options } : { prompt });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },

    commands,
    handlers,
    messages,
    notifications,
    entries,
    userMessages,
    overlayMounts,
    confirmCalls,
    inputCalls,
    selectCalls,
    nextInputAnswers,
    nextSelectAnswers,
    get nextConfirmAnswer() {
      return nextConfirmAnswer;
    },
    set nextConfirmAnswer(v: boolean) {
      nextConfirmAnswer = v;
    },

    async fireSessionStart(cwd) {
      const list = handlers.get("session_start") ?? [];
      const ctx = makeCtx(cwd);
      for (const h of list) {
        await h({}, ctx);
      }
    },
    async fireSessionShutdown(cwd) {
      const list = handlers.get("session_shutdown") ?? [];
      const ctx = makeCtx(cwd);
      for (const h of list) {
        await h({}, ctx);
      }
    },
    async invokeCommand(name, args = "") {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`fakePi: no command registered as /${name}`);
      const ctx = makeCtx(_opts.cwd ?? process.cwd());
      await cmd.handler(args, ctx);
    },
    resetObservations() {
      messages.length = 0;
      notifications.length = 0;
      entries.length = 0;
      userMessages.length = 0;
      overlayMounts.length = 0;
    },
  };
  return pi;
}
