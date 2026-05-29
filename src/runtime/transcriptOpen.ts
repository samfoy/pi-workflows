/**
 * pi-workflows — slice 15 transcript open.
 *
 * `t` hotkey from agent detail opens the agent's JSONL transcript in
 * `$EDITOR` (split on whitespace per plan.md risk note), falling back
 * to a read-only TUI viewer via `ctx.ui.custom` if $EDITOR is unset.
 *
 * Clipboard (`c`) — tries `pbcopy` (macOS), then `xclip`, then
 * `xsel`. If all fail, surfaces prompt text directly.
 *
 * Refs: PRD §10.3 (agent detail hotkeys), plan.md §4 Slice 15 risks.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface TranscriptOpenOpts {
  /** Absolute path to the agent JSONL file. */
  readonly transcriptPath: string;
  /**
   * EDITOR string — split on whitespace. E.g. `"code -w"` → `["code", "-w"]`.
   * Defaults to `process.env.EDITOR`.
   */
  readonly editor?: string;
  /** Test seam — simpler callable signature to avoid overload complexity. */
  readonly _spawnSync?: (
    cmd: string,
    args: string[],
    opts?: { stdio?: unknown },
  ) => { error?: Error } | null;
}

export type TranscriptOpenResult =
  | { readonly kind: "opened-editor"; readonly editor: string; readonly args: string[] }
  | { readonly kind: "no-editor"; readonly reason: "EDITOR-unset" | "file-not-found" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Open the transcript in `$EDITOR`. Synchronous — the editor process
 * blocks until the user closes it (this is intentional for terminal
 * editors like nvim/vim; GUI editors with `-w` flag also block).
 *
 * For non-blocking GUI editors (without `-w`), the call returns
 * immediately — that's fine. The overlay resumes.
 */
export function openTranscriptInEditor(
  opts: TranscriptOpenOpts,
): TranscriptOpenResult {
  const editorStr = opts.editor ?? process.env["EDITOR"] ?? "";
  if (!editorStr) {
    return { kind: "no-editor", reason: "EDITOR-unset" };
  }
  if (!existsSync(opts.transcriptPath)) {
    return { kind: "no-editor", reason: "file-not-found" };
  }
  // Split on whitespace, per plan.md §15 risk note:
  //   "$EDITOR may be a multi-word command (e.g. `code -w`)"
  const parts = editorStr.trim().split(/\s+/).filter(Boolean);
  const editorBin = parts[0]!;
  const editorArgs = [...parts.slice(1), opts.transcriptPath];

  const spawn = opts._spawnSync ?? spawnSync;
  try {
    const r = spawn(editorBin, editorArgs, {
      stdio: "inherit",
    });
    if (r && r.error) throw r.error;
    return { kind: "opened-editor", editor: editorBin, args: editorArgs };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Clipboard helper ────────────────────────────────────────────────

export type ClipboardResult =
  | { readonly kind: "copied"; readonly tool: string }
  | { readonly kind: "no-tool"; readonly reason: string };

export interface CopyToClipboardOpts {
  readonly text: string;
  /** Test seam — override execFileSync. */
  readonly _execFileSync?: (
    bin: string,
    args: string[],
    opts?: { input?: string; stdio?: unknown },
  ) => Buffer | string;
}

/**
 * Copy `text` to clipboard via the first available tool:
 *   1. `pbcopy`  (macOS)
 *   2. `xclip -selection clipboard` (Linux X11)
 *   3. `xsel --clipboard --input`  (Linux X11, alternate)
 *
 * If all fail, returns `{ kind: "no-tool" }` with a reason string.
 * The caller should then surface the text itself (e.g. a TUI banner).
 */
export function copyToClipboard(opts: CopyToClipboardOpts): ClipboardResult {
  const exec = opts._execFileSync ?? execFileSync;

  // Tool configs: [binary, ...args-before-stdin]
  const tools: [string, string[]][] = [
    ["pbcopy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];

  const reasons: string[] = [];
  for (const [bin, args] of tools) {
    try {
      exec(bin, args, { input: opts.text, stdio: ["pipe", "inherit", "pipe"] });
      return { kind: "copied", tool: bin };
    } catch (err) {
      reasons.push(
        `${bin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    kind: "no-tool",
    reason: `no clipboard tool available (tried pbcopy, xclip, xsel). ${reasons.join(" | ")}`,
  };
}

/**
 * Derive the path to an agent's JSONL transcript file.
 *
 *   `<runDir>/agents/<agentId>.jsonl`
 *
 * Returns `undefined` if `runDir` is undefined.
 */
export function agentTranscriptPath(
  runDir: string | undefined,
  agentId: string,
): string | undefined {
  if (!runDir) return undefined;
  return join(runDir, "agents", `${agentId}.jsonl`);
}
