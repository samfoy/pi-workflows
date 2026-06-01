/**
 * pi-workflows — esbuild bundle config.
 *
 * Slice 2 extracted this from inline `package.json` scripts so future
 * slices can append externals (and other knobs) here without piling up
 * CLI flags. `package.json scripts.build` runs `node esbuild.config.js`.
 *
 * Externals contract:
 *   - `@earendil-works/pi-coding-agent` is a peerDep — pi resolves it
 *     at runtime, never bundle.
 *   - `typebox` is an optional peer used in slice 8a (validation of
 *     workflow input). External until / unless we ship runtime-side
 *     bundling.
 *   - `node:vm` and other `node:*` modules are bare specifiers; esbuild
 *     leaves them alone for `platform: 'node'`. We never list them.
 *
 * Append to `external` as later slices add deps. Treat the array as
 * an ordered list — newer slices append, older slices stay put.
 */

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const config = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  sourcemap: false,
  // Slice 6 will likely add a `banner` for the top-level `import`-shim
  // dance node ESM needs around `__dirname`. Leave alone for now.
  external: [
    "@earendil-works/pi-coding-agent",
    "typebox",
    // ─── slice 2 had no new bundle-time externals ───
    // future slices append here. Keep alphabetised within a slice
    // but slice-grouped to make `git blame` cleanly tied to a slice.
  ],
  logLevel: "info",
};

// Run when invoked directly via `node esbuild.config.js`. Importing
// the file (e.g. from a future test that wants to inspect the config)
// does NOT trigger a build.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.all([
    build(config),
    copyPublicTypes(),
  ]).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[pi-workflows] esbuild failed:", err);
    process.exit(1);
  });
}

// `src/types/public.d.ts` and `src/types/internal.d.ts` are
// manually-authored declaration files. tsc's `--declaration` does not
// emit anything from .d.ts inputs, so they never reach `dist/`. We copy
// them explicitly so consumers' tsc resolves the `./types/public.js`
// and `../types/internal.js` references that the emitted .d.ts files
// carry through verbatim from the .ts sources.
async function copyPublicTypes() {
  const files = [
    ["src/types/public.d.ts", "dist/types/public.d.ts"],
    ["src/types/internal.d.ts", "dist/types/internal.d.ts"],
  ];
  for (const [from, to] of files) {
    const src = path.resolve(from);
    const dst = path.resolve(to);
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}
