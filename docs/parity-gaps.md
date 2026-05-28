# Parity gaps — pi-workflows v0.1

Documented limitations that diverge from the PRD's idealized author API
or from Claude Code's "Dynamic Workflows" feature. Filled in
incrementally per slice; finalised in slice 18.

## Slice 2 — sandbox substrate

### sync-loop wedge (PRD §8.3.6)

A workflow with a synchronous infinite loop (`while (true) {}`,
`for (;;);`, etc.) blocks the Node event loop. While that loop runs:

- The pi TUI cannot receive keystrokes; **`x` (stop) does NOT fire**.
- The overlay cannot redraw.
- Other extensions' timers / event handlers are starved.
- AbortSignal listeners cannot fire (they're scheduled as microtasks).

The only recovery is `kill -INT <pi-pid>` from another terminal, which
terminates **every** active run, not only the offender.

We accept this in v1 because alternatives (worker_threads,
interrupt-on-tick) are out of scope per pin 5 of PRD §1.2. Authors must
yield via `await` at least every ~10ms — see `docs/authoring.md`'s
"avoid CPU loops" guidance (slice 18 stub).

### globalThis is not freezable in vm.Context

`Object.freeze(globalThis)` and `Object.preventExtensions(globalThis)`
both throw "Cannot freeze" / "Cannot prevent extensions" inside a
`vm.Context` because the Context's globalThis is a Proxy that refuses
those operations. The meaningful pollution defense is freezing
`Object.prototype`, `Array.prototype`, etc. — which we do.

Effect: a script can write `globalThis.foo = 1` and the assignment
succeeds, putting `foo` on the Context's globalThis (NOT the host's).
Each `Sandbox` is a fresh Context, so cross-run pollution is
impossible. Within a run, multiple `runScript` calls reuse the Context
but rebind `ctx`/`input` first, so a prior call's stray globals are
observable but harmless.

### Realm-leak via host-realm globals: crypto, Buffer, URL, etc. (closed at slice 2)

**Status: closed.** All exposed globals (`Buffer`, `crypto`, `URL`,
`URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`,
`console`) are Context-realm wrappers around their host-realm originals.
`Buffer.from.constructor` resolves to the Context's `Function`, so
`.constructor.constructor("return process")()` evaluates inside the
Context and gets the Context-realm `process` stub, not the host's.
Verified by `tests/security/fixtures/host-realm-eval.workflow.js`.

Slice 8a's `ctx.agent` / `ctx.phase` host-method wrappers must follow
the same pattern — see `wrapHostMethod` inside
`src/runtime/sandbox.ts` `buildInitScript` for the reference
implementation. Cross-ref PRD §8.3.4, §8.3.10.

#### Residual gaps inside this defense

- **`Buffer` instance methods** still walk to the host realm.
  `Buffer.from('AB').toString.constructor.constructor` returns the
  host's `Function` because the returned `Buffer` is a host-realm
  instance whose prototype chain is host. Authors who only use the
  wrapped statics (`from`, `alloc`, `concat`, `byteLength`,
  `isBuffer`, `isEncoding`, `compare`) are safe; chains through
  instance methods are not. Workflows that need locked-down byte
  manipulation should convert the result to a Context-realm
  `Uint8Array` (`new Uint8Array(buf)`) before further work.
  Closing this fully would require wrapping every `Buffer.prototype`
  method, which is large and rarely needed.

- **`crypto` whitelist.** Only `randomUUID`, `getRandomValues`,
  `randomBytes`, `randomFillSync` are exposed. `crypto.subtle`,
  `crypto.createHash`, `crypto.createHmac`, etc. are NOT exposed —
  they're capability-bearing or stateful and outside the v1 trust
  model. A future slice can add purified wrappers if author feedback
  surfaces a need.

- **`URL` and `URLSearchParams` are immutable snapshots.** Construction
  delegates to host `URL`, but properties (`href`, `pathname`, etc.)
  are captured at construction and frozen. There are no setters. To
  mutate a URL, construct a new one. This is a behavioural departure
  from the WHATWG spec but avoids exposing host setter side-effects.

- **TextEncoder / TextDecoder** wrap the host instance via
  `Reflect.apply` so `.encode` / `.decode` return host-realm typed
  arrays. The methods themselves are Context-realm functions, so the
  constructor walk on the method is closed; the returned typed array
  IS host-realm. Authors who downstream-walk
  `tEnc.encode('x').constructor` reach the host `Uint8Array` —
  documented but acceptable since `Uint8Array` doesn't grant
  capability beyond what `Buffer` already exposed.

### Custom Error subclass identity does not survive realm crossing

When a host-side error crosses into the sandbox via the
realm-error reconstruction contract (PRD §8.3.4), custom subclasses
(`class FooError extends Error {}`) are reconstructed as Context-realm
`Error` with `.name` preserved. `instanceof FooError` returns false
inside the script.

Authors should compare `.name` (`if (e.name === "FooError")`) instead
of `instanceof`. Documented in `docs/authoring.md` slice 18.

### Resource exhaustion is bounded only by Node's heap

A script doing `const a = []; while (true) a.push(a);` will OOM the
entire pi process. v1 has no per-run heap cap. Acceptance per
PRD §8.3.7 — the trust model assumes the author isn't actively trying
to crash pi.

The `--max-old-space-size` Node flag (default 4GB) is the only bound.
Slice 17 may revisit if user feedback flags the gap.

### `process` is a stub, not absent

PRD §4.3 ❌ row says "process: Replaced by a frozen stub". The
sandbox installs a frozen object `{ env: {}, platform: 'sandbox',
arch: 'sandbox', versions: { node: '0.0.0-sandbox' } }`. Author code
doing `process.env.X || default` works (returns default).

This deliberately differs from "process is undefined" — many ergonomic
patterns rely on the object existing. The security claim (no env
leak) is preserved by `process.env === {}`.

## Future slices

Slices 3–17 will append further parity-gap notes here. Slice 18 is the
final pass that authors `docs/authoring.md` + this file as
public-facing release notes.
