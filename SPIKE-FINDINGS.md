# Spike Findings — Slice 0

**Date:** 2026-05-28
**Pi version:** `@earendil-works/pi-coding-agent` resolved at
`/local/home/samfp/.local/share/mise/installs/node/24.7.0/lib/node_modules/`
**Reproducibility:** the two `scripts/spike-*.mjs` files in this repo regenerate
the verbatim citations below. Re-run them if pi-coding-agent is upgraded and
this doc looks stale.

This slice answers two open design questions before slice 1 starts. Each
section follows the four-sub-heading template required by `plan.md` §4
Slice 0:

1. **Question** — one-sentence statement.
2. **Method** — exact commands run.
3. **Observed** — verbatim output (sanitised to `$PI` for the global pi path).
4. **Recommendation + escape hatch** — what slice N should do, and what to fall
   back to if reality bites.

---

## Q1 — Does `ctx.ui.custom` support nested overlays?

### Question

If `/workflows` opens an overlay via `ctx.ui.custom({ overlay: true })` while
`pi-conductor`'s `Ctrl+G` focused-stream overlay is already up, does pi-tui
push a second overlay on top (Esc pops to conductor), replace the existing
overlay, or crash? `PRD.md` §10.8 / §15.D depend on the answer; slice 13
encodes it as a TUI design constant.

### Method

Two evidence sources, both reproducible without a TTY:

```bash
# Source-level evidence — pi-tui's overlay machinery and the shipped
# /overlay-stack QA example.
node scripts/spike-overlay-nest.mjs
```

The script greps the installed `pi-tui/dist/tui.js` for the canonical
`overlayStack` push/pop calls, the renderer's composite path, and the shipped
`examples/extensions/overlay-qa-tests.ts` `/overlay-stack` command (which
mounts three simultaneous overlays via `ctx.ui.custom`). It also greps
`pi-conductor`'s `focused-overlay-shortcut.ts` to confirm conductor's existing
design assumes nesting works.

A live two-overlay TUI test was considered but rejected as lower-evidence:
source semantics are authoritative, and the shipped `/overlay-stack` example
in pi-coding-agent already proves the behavior in production.

### Observed

```
======================================================================
Q1.1  pi-tui maintains overlayStack as an array (push/pop)
======================================================================
> $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:120:     overlayStack = [];

======================================================================
Q1.2  showOverlay() pushes onto overlayStack
======================================================================
  $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:175:             focusOrder: ++this.focusOrderCounter,
  $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:176:         };
> $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:177:         this.overlayStack.push(entry);

======================================================================
Q1.3  hideOverlay() pops the topmost overlay
======================================================================
  $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:242:     hideOverlay() {
> $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:243:         const overlay = this.overlayStack.pop();
  $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:244:         if (!overlay)

======================================================================
Q1.4  Renderer composites all visible overlays sorted by focusOrder
======================================================================
> $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:572:     /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
  $PI/node_modules/@earendil-works/pi-tui/dist/tui.js:573:     compositeOverlays(lines, termWidth, termHeight) {

======================================================================
Q1.5  Shipped /overlay-stack example mounts three simultaneous overlays
======================================================================
> $PI/examples/extensions/overlay-qa-tests.ts:115: 	pi.registerCommand("overlay-stack", {
> $PI/examples/extensions/overlay-qa-tests.ts:153: 			const results = await Promise.all([p1, p2, p3]);

======================================================================
Q1.6  pi-conductor's Ctrl+G shortcut already assumes nesting
======================================================================
> /home/samfp/scratch/pi-conductor/src/focused-overlay-shortcut.ts:171:     // Don't hijack Ctrl+G when an overlay is already open — let the
  /home/samfp/scratch/pi-conductor/src/focused-overlay-shortcut.ts:172:     // overlay's own bindings see the keystroke.

======================================================================
RESULT
======================================================================
PASS — overlay nesting is push/pop. Slice 13 may rely on it.
Recommendation: NEST-WORKS (push/pop). Esc closes topmost.
```

`tui.js:120` declares `overlayStack = []`; `tui.js:177` pushes a new entry on
every `showOverlay()`; `tui.js:243` pops on every `hideOverlay()`. The
renderer composites all visible overlays sorted by `focusOrder` (higher = on
top) — that's a real stack, not a single-slot replace. The shipped
`/overlay-stack` command in pi-coding-agent's own QA suite mounts three
overlays in parallel and awaits `Promise.all([p1, p2, p3])`, demonstrating
end-to-end nesting in production code. pi-conductor's shortcut at
`focused-overlay-shortcut.ts:171` already short-circuits `Ctrl+G` when its
overlay is open, leaving the topmost overlay in charge of the keystroke —
the conductor team designed against the same nested-overlay contract.

The full `pi-tui/dist/tui.js` `showOverlay` / `hideOverlay` block (sanitised):

```js
// $PI/node_modules/@earendil-works/pi-tui/dist/tui.js
showOverlay(component, options) {
    const entry = { component, options, preFocus: this.focusedComponent,
                    hidden: false, focusOrder: ++this.focusOrderCounter };
    this.overlayStack.push(entry);
    if (!options?.nonCapturing && this.isOverlayVisible(entry))
        this.setFocus(component);
    // ...returns a handle with hide(), setHidden(), focus(), unfocus()
}
hideOverlay() {
    const overlay = this.overlayStack.pop();
    if (!overlay) return;
    if (this.focusedComponent === overlay.component) {
        const topVisible = this.getTopmostVisibleOverlay();
        this.setFocus(topVisible?.component ?? overlay.preFocus);
    }
    // ...
}
```

`getTopmostVisibleOverlay()` (tui.js:266–278) walks the stack in reverse and
returns the highest-`focusOrder` non-hidden, non-`nonCapturing` entry. That's
the exact "Esc pops to previous" semantic `PRD.md` §10.8 wants.

### Recommendation + escape hatch

**v1 ships push/pop** (the `NEST-WORKS` option from `plan.md` §4 Slice 0).
Slice 13 mounts `/workflows` via `ctx.ui.custom({ overlay: true })` without a
pre-close pass; if pi-conductor's overlay is up, workflows stacks on top, and
Esc returns to conductor (and Esc again returns to the underlying editor).
Encode this as a constant in `src/ui/overlay.tsx`:

```ts
// Slice 0 / Q1 finding (date-stamped 2026-05-28): pi-tui's overlayStack is
// push/pop with focusOrder-based compositing. We rely on that contract.
export const OVERLAY_NESTING = "push-pop" as const;
```

**Escape hatch — `close-other`:** if a future pi-coding-agent release breaks
nesting (covered by `plan.md`'s "spike conclusion is wrong" risk), slice 13
flips the constant to `"close-other"` and adds a one-shot pass: detect any
existing overlay via `ctx.ui.onTerminalInput`-derived state (no public API
yet for "is some overlay open"; we'd track our own ref to overlays we've
opened, and rely on the user closing conductor's overlay manually), then
print `"closed conductor overlay to open /workflows"` to the chat. This is
the documented fallback in `PRD.md` §10.8 and §15.D — both already wired into
the design.

**No PRD/plan revision triggered.** Both docs already pin the exact wording
of this finding's outcome ("locked recommendation: push/pop"); the spike
confirmed the lock.

---

## Q2 — Does pi-coding-agent's installer read a `pi.workflows` manifest field?

### Question

`PRD.md` §9.4 proposes shipping bundled `/codebase-audit` via:

```json
{ "pi": { "workflows": ["examples/codebase-audit/codebase-audit.js"] } }
```

`PRD.md` §15.9 names this as unverified. If pi-core's installer copies files
listed under `pi.workflows` into `~/.pi/agent/workflows/` automatically,
slice 17 uses the manifest field directly. If it doesn't, slice 17 needs a
fallback path so users get `/codebase-audit` working out-of-the-box.

### Method

```bash
# Confirm pi-core's RESOURCE_TYPES, the manifest reader, and the absence of
# any 'workflows' string in dist/. Also probes for extension hooks that
# might register new resource types at runtime.
node scripts/spike-pi-workflows-manifest.mjs
```

The script:
1. Reads `dist/core/package-manager.js` and prints the `RESOURCE_TYPES`
   constant + the `readPiManifestFile` function.
2. Recursively greps `dist/` for any case-insensitive `\bworkflows?\b` token
   (skipping comments).
3. Greps for known extension hooks that might add resource types
   (`registerResourceType`, `addResourceType`, `customResource`,
   `resources_discover`).
4. Cross-references `docs/packages.md`'s documented manifest fields.

### Observed

```
======================================================================
Q2.1  pi-core's RESOURCE_TYPES constant (the authoritative manifest fields)
======================================================================
> $PI/dist/core/package-manager.js:60: const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];
  $PI/dist/core/package-manager.js:61: const FILE_PATTERNS = {
  $PI/dist/core/package-manager.js:62:     extensions: /\.(ts|js)$/,
  $PI/dist/core/package-manager.js:63:     skills: /\.md$/,
  $PI/dist/core/package-manager.js:64:     prompts: /\.md$/,
  $PI/dist/core/package-manager.js:65:     themes: /\.json$/,

======================================================================
Q2.2  readPiManifestFile — what it reads from package.json
======================================================================
> $PI/dist/core/package-manager.js:351: function readPiManifestFile(packageJsonPath) {
  $PI/dist/core/package-manager.js:352:     try {
> $PI/dist/core/package-manager.js:355:         return pkg.pi ?? null;

======================================================================
Q2.3  Grep the whole pi dist/ tree for any 'workflows' usage
======================================================================
  (no source-level workflows references — confirmed not handled by pi-core)

======================================================================
Q2.4  docs/packages.md — documented manifest fields
======================================================================
> $PI/docs/packages.md:120:     "extensions": ["./extensions"],
> $PI/docs/packages.md:121:     "skills": ["./skills"],
> $PI/docs/packages.md:122:     "prompts": ["./prompts"],
> $PI/docs/packages.md:123:     "themes": ["./themes"]

======================================================================
Q2.5  Confirm pi-core has no extension hook for adding resource types
======================================================================
  $PI/dist/core/agent-session.js:1626: if (!this._extensionRunner.hasHandlers("resources_discover")) {
  $PI/dist/core/extensions/runner.js:760: const handlers = ext.handlers.get("resources_discover");
  $PI/dist/core/extensions/runner.js:783: event: "resources_discover",
  $PI/dist/core/extensions/types.d.ts:371: type: "resources_discover";

======================================================================
RESULT
======================================================================
RESOURCE_TYPES is hardcoded — pi-core does NOT read pi.workflows.
Recommendation: FALLBACK-VIA-SELF-INSTALL (slice 17 owns it).
```

Three findings worth pinning:

1. **`RESOURCE_TYPES` is hardcoded.** `package-manager.js:60` literally lists
   `["extensions", "skills", "prompts", "themes"]`. There is no runtime
   extensibility mechanism on this constant — the package installer iterates
   it directly with hardcoded `FILE_PATTERNS` for each type. A `pi.workflows`
   field in `package.json` would simply be ignored.

2. **No source-level `workflows` references.** `Q2.3` swept all `.js`/`.d.ts`
   files in `$PI/dist/` for any `\bworkflows?\b` token outside comments. Zero
   matches. pi-core has never heard of workflows.

3. **`resources_discover` is real but won't help.** The grep surfaced a
   `resources_discover` extension event (a recent addition). Reading
   `dist/core/extensions/runner.js:754–790` and `types.d.ts:365–377`:

   ```ts
   /** Result from resources_discover event handler */
   export interface ResourcesDiscoverResult {
       skillPaths?: string[];
       promptPaths?: string[];
       themePaths?: string[];
   }
   ```

   The hook lets an extension contribute additional `skill`, `prompt`, and
   `theme` paths at session start — but **not** new resource types and not
   extensions/workflows. A pi-workflows extension cannot use it to ship
   bundled workflow files to an end-user-visible location.

### Recommendation + escape hatch

**v1 ships fallback-via-self-install** (the `b` option from `PRD.md` §15.9).
The `@samfp/pi-workflows` extension registers a `session_start` handler in
slice 17 that:

1. Resolves the package's own root via `import.meta.url` (the extension
   knows where its bundle lives).
2. Reads bundled workflow files from `<packageRoot>/examples/<name>/<name>.js`
   (or a manifest list — TBD slice 17).
3. For each bundled workflow `<name>`, ensures `~/.pi/agent/workflows/<name>.js`
   exists. If the destination file is missing, copies the bundle in. If the
   destination already exists, **never** overwrites — this preserves user
   edits and is idempotent across reload.
4. Logs a one-line notification on first install
   (`"installed @samfp/pi-workflows bundled workflow: codebase-audit"`).

The reverse direction (uninstall) is not handled by pi-core's `pi remove`
since pi-core doesn't know about `~/.pi/agent/workflows/` either; we accept
that as a known v1 limitation and document a manual `rm` instruction in
the README.

**Escape hatch — `pi-core gains workflows manifest support`:** if a future
pi-coding-agent release adds `workflows` to `RESOURCE_TYPES`, slice 17's
`session_start` handler should detect this (e.g. by reading the installed
pi-coding-agent's `package.json` for a feature flag, or just by checking
`~/.pi/agent/workflows/codebase-audit.js` exists pre-handler — pi-core would
have placed it). When detected, the self-install becomes a no-op. The handler
is idempotent either way.

**Plan revision:** **none required.** `plan.md` §4 Slice 0 already names the
two outcomes ("manifest field works" vs "fallback needed") and §4 Slice 17
already spec's the fallback. The PRD's §9.4 prose talks about pi reading
`pi.workflows` as if it were native — that prose is aspirational, not spec.
§15.9 already pins the contingency. No upstream edits needed; slice 17
builder reads this finding and follows the fallback path.

---

## Cross-cutting notes

- **Both spikes are repeatable without a TTY**, by design. Slice 0's job is
  to remove blockers for slice 1, not to deliver a polished demo.
- The two `scripts/spike-*.mjs` files double as regression checks: if a
  future pi-coding-agent release breaks either contract, re-running these
  scripts will report `MISMATCH` and exit non-zero. Wiring them into CI is
  a v0.5 task (see `plan.md` slice 11) — not v0.1.
- **Neither finding triggers a PRD/plan edit.** `PRD.md` §10.8, §15.9, and
  `plan.md` §4 Slice 0 / Slice 13 / Slice 17 already encode the locked
  recommendation and the escape hatch. The spike's job was to discharge the
  contingency — it did, on the path the docs already named.

