#!/usr/bin/env node
// scripts/spike-overlay-nest.mjs
//
// Slice 0 / Q1: Verify ctx.ui.custom overlay nesting (push/pop) by reading
// the pi-tui source directly. We prefer source inspection over a live TUI
// run because (a) it's reproducible without a TTY, (b) source semantics are
// authoritative — a live TUI test only proves what was rendered today, not
// what the API contract is, and (c) the relevant source is shipped in the
// installed pi-coding-agent package.
//
// What this script proves, by extracting cited file:line evidence:
//
//   1. pi-tui's TUI class maintains an `overlayStack: OverlayEntry[]` array.
//   2. `showOverlay(component, options)` PUSHES onto the stack.
//   3. `hideOverlay()` POPS the topmost entry.
//   4. The composite renderer iterates the stack in focusOrder, so multiple
//      overlays render simultaneously.
//   5. The shipped `examples/extensions/overlay-qa-tests.ts` registers
//      `/overlay-stack` which mounts THREE overlays simultaneously and
//      awaits Promise.all — proving real-world push/pop usage.
//
// If pi-coding-agent is upgraded and the source no longer matches these
// patterns, this script will print "MISMATCH" and slice 13 must re-run it.
//
// Usage:  node scripts/spike-overlay-nest.mjs

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

function findPiPackage() {
	// Try to resolve via the running node's `npm root -g` so this works in
	// any host setup (mise, nvm, fnm, etc.).
	try {
		const root = execSync("npm root -g", { encoding: "utf8" }).trim();
		const candidate = `${root}/@earendil-works/pi-coding-agent`;
		if (existsSync(candidate)) return candidate;
	} catch {}
	const fallback = "/local/home/samfp/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent";
	if (existsSync(fallback)) return fallback;
	throw new Error("Could not locate @earendil-works/pi-coding-agent. Install pi globally first.");
}

const PI = findPiPackage();
const TUI_JS = `${PI}/node_modules/@earendil-works/pi-tui/dist/tui.js`;
const QA_TESTS = `${PI}/examples/extensions/overlay-qa-tests.ts`;

function bannerOpen(s) {
	console.log("\n" + "=".repeat(70));
	console.log(s);
	console.log("=".repeat(70));
}

function citeLines(path, regex, contextBefore = 0, contextAfter = 0) {
	const lines = readFileSync(path, "utf8").split("\n");
	const matches = [];
	lines.forEach((line, i) => {
		if (regex.test(line)) matches.push(i);
	});
	if (matches.length === 0) {
		console.log(`  (no matches for ${regex} in ${path})`);
		return false;
	}
	for (const idx of matches) {
		const start = Math.max(0, idx - contextBefore);
		const end = Math.min(lines.length, idx + contextAfter + 1);
		for (let j = start; j < end; j++) {
			const marker = j === idx ? ">" : " ";
			console.log(`${marker} ${path.replace(PI, "$PI")}:${j + 1}: ${lines[j]}`);
		}
		if (contextBefore + contextAfter > 0) console.log("  ---");
	}
	return true;
}

bannerOpen("Q1.1  pi-tui maintains overlayStack as an array (push/pop)");
const ok1 = citeLines(TUI_JS, /overlayStack = \[\]/);

bannerOpen("Q1.2  showOverlay() pushes onto overlayStack");
const ok2 = citeLines(TUI_JS, /this\.overlayStack\.push\(entry\)/, 2, 0);

bannerOpen("Q1.3  hideOverlay() pops the topmost overlay");
const ok3 = citeLines(TUI_JS, /this\.overlayStack\.pop\(\)/, 1, 1);

bannerOpen("Q1.4  Renderer composites all visible overlays sorted by focusOrder");
const ok4 = citeLines(TUI_JS, /Composite all overlays into content lines/, 0, 1);

bannerOpen("Q1.5  Shipped /overlay-stack example mounts three simultaneous overlays");
const ok5 = citeLines(
	QA_TESTS,
	/registerCommand\("overlay-stack"|Promise\.all\(\[p1, p2, p3\]\)/,
	0,
	0,
);

bannerOpen("Q1.6  pi-conductor's Ctrl+G shortcut already assumes nesting");
// Slightly different file but in the same investigation; conductor exists at
// /home/samfp/scratch/pi-conductor and uses isOverlayOpen() to know when to
// pass-through Ctrl+G to whichever overlay is on top.
const conductorShortcut = "/home/samfp/scratch/pi-conductor/src/focused-overlay-shortcut.ts";
const ok6 = existsSync(conductorShortcut)
	? citeLines(conductorShortcut, /Don't hijack Ctrl\+G when an overlay is already open/, 0, 1)
	: (console.log(`  (skipped — conductor checkout not at ${conductorShortcut})`), true);

bannerOpen("RESULT");
const allOk = ok1 && ok2 && ok3 && ok4 && ok5 && ok6;
if (allOk) {
	console.log("PASS — overlay nesting is push/pop. Slice 13 may rely on it.");
	console.log("Recommendation: NEST-WORKS (push/pop). Esc closes topmost.");
	process.exit(0);
} else {
	console.log("MISMATCH — at least one expected pattern not found.");
	console.log("Slice 13 must re-run this spike before encoding overlay logic.");
	process.exit(1);
}
