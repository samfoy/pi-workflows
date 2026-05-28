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

export interface FakeContext {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface FakeCommandContext extends FakeContext {
  /** Slice 1 doesn't need session control; placeholder for slice 11+. */
  readonly waitForIdle?: () => Promise<void>;
}

export interface FakePi {
  // ── ExtensionAPI surface ──────────────────────────────────────
  registerCommand(name: string, options: Omit<FakeRegisteredCommand, "name">): void;
  on(event: string, handler: (e: unknown, ctx: FakeContext) => Promise<void> | void): void;
  sendMessage<T = unknown>(
    message: { customType: string; content: string; display?: boolean; details?: T },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;

  // ── Inspection ────────────────────────────────────────────────
  readonly commands: ReadonlyMap<string, FakeRegisteredCommand>;
  readonly handlers: ReadonlyMap<string, ReadonlyArray<(e: unknown, ctx: FakeContext) => Promise<void> | void>>;
  readonly messages: ReadonlyArray<FakeSentMessage>;
  readonly notifications: ReadonlyArray<FakeNotification>;
  readonly entries: ReadonlyArray<FakeAppendEntry>;

  // ── Drivers ───────────────────────────────────────────────────
  /** Fires every `session_start` handler in registration order. */
  fireSessionStart(cwd: string): Promise<void>;
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

  const makeCtx = (cwd: string): FakeCommandContext => ({
    cwd,
    ui: {
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
    },
  });

  const pi: FakePi = {
    registerCommand(name, options) {
      commands.set(name, { name, ...options });
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      const entry: FakeSentMessage = options !== undefined
        ? { ...message, options }
        : { ...message };
      messages.push(entry);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },

    commands,
    handlers,
    messages,
    notifications,
    entries,

    async fireSessionStart(cwd) {
      const list = handlers.get("session_start") ?? [];
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
    },
  };
  return pi;
}
