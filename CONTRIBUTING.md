# Contributing to pi-workflows

## Development setup

```bash
git clone <repo>
cd pi-workflows
npm install
npm run build
npm test
```

## Running tests

```bash
npm test                  # all (unit + integration + security)
npm run test:unit         # unit tests only
npm run test:integration  # integration tests only  
npm run test:security     # sandbox escape-vector tests
npx tsc --noEmit          # type check
```

## Manual smoke procedure (PRD §12.8)

Run this before tagging a release:

**1. Build and link locally**
```bash
npm run build
npm link
```

**2. Install in a test pi session directory**
```bash
cd /tmp/smoke-test
npm link @samfp/pi-workflows
```

**3. Write a smoke workflow**
```bash
mkdir -p .pi/workflows
cat > .pi/workflows/smoke.js <<'EOF'
export default async function (ctx, input) {
  const [r] = await ctx.phase("echo", [
    ctx.agent(`Echo back: ${input || "hello"}`, { id: "echo" }),
  ]);
  ctx.finishCallback(r.text);
}
EOF
```

**4. Launch pi and invoke the workflow**
```
pi
/smoke test message
```

Expected: approval prompt appears, user approves, workflow runs, result
appears in chat.

**5. Open the TUI overlay**
Press `w` — the overlay should show the smoke run with state `done`.

**6. Test resume**
```
/workflows resume <runId from step 5>
```
Expected: "run already completed" message (not a crash).

**7. Test `/codebase-audit`**
```
/codebase-audit src/
```
Expected: 4 phases, final report with findings.

**8. Test hot-reload**
Edit `.pi/workflows/smoke.js` — save. Within 500ms pi should log
"workflow smoke.js changed — trust revoked". Next invocation shows
re-approval prompt.

**9. Cleanup**
```bash
npm unlink @samfp/pi-workflows
```

## Releasing

```bash
npm version patch   # or minor / major
npm publish --dry-run   # verify pack contents
npm publish
```

The `prepublishOnly` script runs `npm run build && npm test` automatically.
