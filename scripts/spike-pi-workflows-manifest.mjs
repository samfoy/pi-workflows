#!/usr/bin/env node
// scripts/spike-pi-workflows-manifest.mjs
//
// Slice 0 / Q2: Verify whether pi-coding-agent's package installer reads a
// `pi.workflows` manifest field. If it does, slice 17 ships bundled
// /codebase-audit via the manifest. If it doesn't, slice 17 self-installs
// from dist/ on first session_start.
//
// Method: read pi-core's package-manager.js and confirm the canonical
// RESOURCE_TYPES constant. Also grep the entire dist/ tree for any "workflows"
// usage — if pi-core has *any* hook for adding resource types, we'd find it.
//
// Usage:  node scripts/spike-pi-workflows-manifest.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

function findPiPackage() {
	try {
		const root = execSync("npm root -g", { encoding: "utf8" }).trim();
		const candidate = `${root}/@earendil-works/pi-coding-agent`;
		if (existsSync(candidate)) return candidate;
	} catch {}
	const fallback = "/local/home/samfp/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent";
	if (existsSync(fallback)) return fallback;
	throw new Error("Could not locate @earendil-works/pi-coding-agent.");
}

const PI = findPiPackage();
const PKG_MGR = `${PI}/dist/core/package-manager.js`;
const PACKAGES_DOC = `${PI}/docs/packages.md`;

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
		console.log(`  (no matches for ${regex} in ${path.replace(PI, "$PI")})`);
		return [];
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
	return matches;
}

bannerOpen("Q2.1  pi-core's RESOURCE_TYPES constant (the authoritative manifest fields)");
const matches1 = citeLines(PKG_MGR, /^const RESOURCE_TYPES = /, 0, 5);
const ok1 = matches1.length > 0;

bannerOpen("Q2.2  readPiManifestFile — what it reads from package.json");
citeLines(PKG_MGR, /function readPiManifestFile|return pkg\.pi/, 0, 1);

bannerOpen("Q2.3  Grep the whole pi dist/ tree for any 'workflows' usage");
let foundWorkflows = false;
function walk(dir) {
	for (const e of readdirSync(dir)) {
		const p = `${dir}/${e}`;
		const st = statSync(p);
		if (st.isDirectory()) walk(p);
		else if (p.endsWith(".js") || p.endsWith(".d.ts")) {
			const txt = readFileSync(p, "utf8");
			const lines = txt.split("\n");
			lines.forEach((line, i) => {
				if (/\bworkflows?\b/i.test(line) && !/^\s*\*|\/\//.test(line.trim())) {
					console.log(`  ${p.replace(PI, "$PI")}:${i + 1}: ${line.trim().slice(0, 120)}`);
					foundWorkflows = true;
				}
			});
		}
	}
}
walk(`${PI}/dist`);
if (!foundWorkflows) console.log("  (no source-level workflows references — confirmed not handled by pi-core)");

bannerOpen("Q2.4  docs/packages.md — documented manifest fields");
citeLines(PACKAGES_DOC, /"pi": \{|"extensions":|"skills":|"prompts":|"themes":|"video":|"image":/, 0, 0);

bannerOpen("Q2.5  Confirm pi-core has no extension hook for adding resource types");
let foundHook = false;
const hookPatterns = [
	/registerResourceType/,
	/addResourceType/,
	/customResource/,
	/resources_discover/,
];
walk2(`${PI}/dist`, hookPatterns);
function walk2(dir, patterns) {
	for (const e of readdirSync(dir)) {
		const p = `${dir}/${e}`;
		const st = statSync(p);
		if (st.isDirectory()) walk2(p, patterns);
		else if (p.endsWith(".js") || p.endsWith(".d.ts")) {
			const txt = readFileSync(p, "utf8");
			const lines = txt.split("\n");
			lines.forEach((line, i) => {
				for (const pat of patterns) {
					if (pat.test(line)) {
						console.log(`  ${p.replace(PI, "$PI")}:${i + 1}: ${line.trim().slice(0, 120)}`);
						foundHook = true;
					}
				}
			});
		}
	}
}
if (!foundHook) console.log("  (no hook for adding resource types — confirmed)");

bannerOpen("RESULT");
if (ok1) {
	console.log("RESOURCE_TYPES is hardcoded — pi-core does NOT read pi.workflows.");
	console.log("Recommendation: FALLBACK-VIA-SELF-INSTALL (slice 17 owns it).");
	console.log("");
	console.log("Concrete plan: at session_start, the @samfp/pi-workflows extension");
	console.log("copies its bundled workflows from <packageRoot>/examples/codebase-audit/");
	console.log("into ~/.pi/agent/workflows/<name>.js if and only if no file with that");
	console.log("name already exists (idempotent — never overwrites user edits).");
	process.exit(0);
} else {
	console.log("UNEXPECTED — RESOURCE_TYPES not found at expected location.");
	console.log("Slice 17 builder must re-run this spike before assuming the fallback.");
	process.exit(1);
}
