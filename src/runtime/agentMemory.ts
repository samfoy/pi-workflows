/**
 * pi-workflows — persistent per-agent memory (ZONE_MEMORY).
 *
 * Auto-mounted MEMORY.md per (scope, name) — the highest-leverage
 * capability port from Claude Code subagents (gap-analysis 2026-05-31
 * §2). Surface is intentionally small:
 *
 *   - `ctx.agent(prompt, { memory: 'user' | 'project' | 'local', name? })`
 *   - On dispatch, runtime reads up to 25 KB of MEMORY.md from the
 *     resolved scope and prepends `Persistent memory:\n<content>\n\n`
 *     to the prompt the sub-agent sees.
 *   - The sub-agent can write back by emitting JSON-stream events of
 *     shape `{ type: 'memory_update', text: '...' }`. The dispatcher
 *     observes these during streaming and appends `text` to
 *     MEMORY.md after the stream settles.
 *
 * Three scopes:
 *   - user    → ~/.pi/agent/workflows/agent-memory/<name>/
 *   - project → <cwd>/.pi/workflows/agent-memory/<name>/
 *   - local   → <runDir>/agent-memory/<name>/
 *
 * The `<name>` segment defaults to `opts.id` (the agent id) so an
 * author who supplies neither still gets per-agent memory; prefer
 * `opts.name` when grouping multiple agent calls under one persona.
 *
 * Path safety mirrors `assertSafeAgentId` — names containing `/`,
 * `\`, `..`, NUL, or starting with `.` are rejected before they
 * touch the filesystem so a malicious workflow can't escape its
 * memory dir to clobber other state.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** Three scopes per the gap analysis. */
export type MemoryScope = "user" | "project" | "local";

/** Filename inside the resolved scope directory. */
export const MEMORY_FILE_NAME = "MEMORY.md";

/**
 * Maximum bytes to inject from MEMORY.md. Larger files are truncated
 * at this boundary; the agent only sees the leading 25 KiB. Matches
 * Claude Code's auto-injection budget (cf. the gap-analysis row
 * "agent-memory/<name>/ + MEMORY.md auto-injection") and keeps prompt
 * blow-up bounded.
 */
export const MEMORY_READ_CAP_BYTES = 25 * 1024;

/** Prefix prepended to the prompt when memory is injected. */
export const MEMORY_PROMPT_PREFIX = "Persistent memory:\n";

/**
 * Thrown when a memory `name` is rejected as a path-traversal vector.
 * Mirrors `InvalidAgentIdError` semantics — the runtime never lets a
 * caller-controlled string flow into `path.join` without validation.
 */
export class InvalidMemoryNameError extends Error {
  readonly memoryName: string;
  readonly reason: string;
  constructor(memoryName: string, reason: string) {
    super(`invalid memory name ${JSON.stringify(memoryName)}: ${reason}`);
    this.name = "InvalidMemoryNameError";
    this.memoryName = memoryName;
    this.reason = reason;
  }
}

/**
 * Reject any memory name that could escape its parent dir or collide
 * with hidden-file semantics. Same disallow list as
 * `assertSafeAgentId` — kept in sync deliberately so the two paths
 * (agent transcripts + agent memory) reject the same shapes.
 */
export function assertSafeMemoryName(
  name: unknown,
): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidMemoryNameError(
      typeof name === "string" ? name : String(name),
      "must be a non-empty string",
    );
  }
  if (name.indexOf("\0") !== -1) {
    throw new InvalidMemoryNameError(name, "contains NUL byte");
  }
  if (name.indexOf("/") !== -1 || name.indexOf("\\") !== -1) {
    throw new InvalidMemoryNameError(name, "contains path separator");
  }
  if (name.indexOf("..") !== -1) {
    throw new InvalidMemoryNameError(
      name,
      "contains path-traversal sequence '..'",
    );
  }
  if (name.startsWith(".")) {
    throw new InvalidMemoryNameError(name, "starts with '.' (hidden file)");
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new InvalidMemoryNameError(name, "contains control character");
  }
}

export interface ResolveMemoryDirOpts {
  readonly scope: MemoryScope;
  readonly name: string;
  /** Run cwd — used for `project` scope. */
  readonly cwd: string;
  /** Absolute run directory — used for `local` scope. */
  readonly runDirAbs: string;
  /** Test seam — overrides `os.homedir()` for `user` scope. */
  readonly homeDir?: string;
}

/**
 * Resolve the absolute directory housing MEMORY.md for one (scope,
 * name) pair. The directory is NOT created here — `appendMemoryUpdate`
 * mkdirp's lazily on first write, and `readMemoryFile` returns `null`
 * when nothing's there yet.
 */
export function resolveMemoryDir(opts: ResolveMemoryDirOpts): string {
  assertSafeMemoryName(opts.name);
  const home = opts.homeDir ?? homedir();
  switch (opts.scope) {
    case "user":
      return join(
        home,
        ".pi",
        "agent",
        "workflows",
        "agent-memory",
        opts.name,
      );
    case "project":
      return join(
        opts.cwd,
        ".pi",
        "workflows",
        "agent-memory",
        opts.name,
      );
    case "local":
      return join(opts.runDirAbs, "agent-memory", opts.name);
  }
}

/**
 * Read MEMORY.md from `dir` capped at `MEMORY_READ_CAP_BYTES`. Returns
 * `null` when:
 *   - the directory does not exist
 *   - the file does not exist
 *   - the file is empty
 *   - any I/O / permission error (silent no-inject; logged by caller)
 *
 * On oversize files, only the leading cap is returned — we do NOT
 * surface a warning here because the cap is a documented contract,
 * not an error condition. The caller may log if it cares.
 */
export async function readMemoryFile(dir: string): Promise<string | null> {
  const r = await readMemoryFileWithMeta(dir);
  return r === null ? null : r.content;
}

/**
 * Result of {@link readMemoryFileWithMeta}. `truncated` is `true`
 * when the on-disk file was larger than {@link MEMORY_READ_CAP_BYTES}
 * and the returned `content` is just the leading slice. Callers can
 * use this signal to surface a one-shot warning without re-stat'ing
 * the file.
 */
export interface ReadMemoryFileResult {
  readonly content: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/**
 * Lower-level read that surfaces oversize-truncation as a structured
 * field. Same null semantics as {@link readMemoryFile}: missing file
 * / empty file / I/O error all return `null`.
 */
export async function readMemoryFileWithMeta(
  dir: string,
): Promise<ReadMemoryFileResult | null> {
  const p = join(dir, MEMORY_FILE_NAME);
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(p, "r");
  } catch {
    return null;
  }
  try {
    // Stat the open fd — not the path — so totalBytes and the read refer to
    // the same inode. A concurrent compactMemoryFile rename between a
    // path-stat and fs.open would otherwise produce a spurious truncated flag.
    const st = await fh.stat();
    const totalBytes = st.size;
    const buf = Buffer.alloc(MEMORY_READ_CAP_BYTES);
    const { bytesRead } = await fh.read(
      buf,
      0,
      MEMORY_READ_CAP_BYTES,
      0,
    );
    if (bytesRead === 0) return null;
    return {
      content: buf.subarray(0, bytesRead).toString("utf8"),
      totalBytes,
      truncated: totalBytes > MEMORY_READ_CAP_BYTES,
    };
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Per-directory write queue ─────────────────────────────────────────────
//
// Serializes appendMemoryUpdate and the write phase of compactMemoryFile so
// a slow summarize() call cannot silently clobber concurrent appends.
// Keyed by the absolute directory path so distinct memory dirs never block
// each other.
const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueue `task` for `dir`, serialized behind any previously queued write
 * for the same directory. Errors thrown by `task` are propagated to the
 * caller but do **not** stall the queue — subsequent tasks continue to run.
 */
function enqueueWrite(dir: string, task: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(dir) ?? Promise.resolve();
  // chain: always run task regardless of whether prev resolved or rejected.
  const next = prev.catch(() => {}).then(task);
  // Store a never-rejecting tail so future enqueues don't inherit our error.
  const chainable = next.catch(() => {});
  writeQueues.set(dir, chainable);
  chainable.then(() => {
    if (writeQueues.get(dir) === chainable) writeQueues.delete(dir);
  });
  return next; // caller gets the real promise (may reject).
}

/**
 * Append a memory-update payload to `<dir>/MEMORY.md`. Creates the
 * parent directory on demand. Empty / non-string `text` is a no-op
 * so a malformed `memory_update` event from a misbehaving agent
 * doesn't corrupt the file.
 *
 * Behavior:
 *   - prefix existing-file content with a `\n` separator iff the
 *     existing tail isn't already a newline (defensive — keeps
 *     consecutive updates from running together)
 *   - guarantee a trailing newline on the appended text
 *
 * The stat + tail-read + append sequence runs inside the per-directory
 * write queue so it cannot interleave with compactMemoryFile's rename.
 */
export async function appendMemoryUpdate(
  dir: string,
  text: unknown,
): Promise<void> {
  if (typeof text !== "string" || text.length === 0) return;
  await fs.mkdir(dir, { recursive: true });
  await enqueueWrite(dir, async () => {
    const p = join(dir, MEMORY_FILE_NAME);
    // Decide whether to prepend a separator newline.
    let needsLeadingNewline = false;
    try {
      const stat = await fs.stat(p);
      if (stat.size > 0) {
        const fh = await fs.open(p, "r");
        try {
          const tailBuf = Buffer.alloc(1);
          await fh.read(tailBuf, 0, 1, Math.max(0, stat.size - 1));
          if (tailBuf.toString("utf8") !== "\n") needsLeadingNewline = true;
        } finally {
          await fh.close();
        }
      }
    } catch {
      /* file absent — no separator needed */
    }
    const payload =
      (needsLeadingNewline ? "\n" : "") +
      (text.endsWith("\n") ? text : text + "\n");
    // Open with 'a' (append) then fsync before closing so the OS page-cache
    // is flushed to durable storage.  A plain fs.appendFile() returns as
    // soon as the kernel accepts the write, leaving the data at risk of
    // loss if the process crashes before the OS flushes its buffer.
    const fh = await fs.open(p, "a");
    try {
      await fh.writeFile(payload, "utf8");
      await fh.datasync();
    } finally {
      await fh.close();
    }
  });
}

/**
 * Build the prompt the dispatcher should send to the sub-agent. When
 * `memoryContent` is `null` or empty the original prompt is returned
 * verbatim — no marker, no whitespace change — so memory disabled
 * is bit-identical to the previous code path.
 */
export function buildPromptWithMemory(
  originalPrompt: string,
  memoryContent: string | null,
): string {
  if (memoryContent === null || memoryContent.length === 0) {
    return originalPrompt;
  }
  // Single blank line between memory block and the original prompt.
  const separator = memoryContent.endsWith("\n") ? "\n" : "\n\n";
  return MEMORY_PROMPT_PREFIX + memoryContent + separator + originalPrompt;
}

/**
 * Parse a raw `opts.memory` value into a typed `MemoryScope | null`.
 * Returns `null` for `false`, `undefined`, and any unrecognized value
 * — the runtime treats those as "no memory" and skips injection.
 *
 * Throws `TypeError` for shapes that look like an attempt to enable
 * memory but with the wrong type (e.g. `{}` or `42`) so authors get
 * a clear error instead of silently disabled memory.
 *
 * NOTE: this returns ONLY the scope — it does not surface the
 * `readOnly` flag from the object form. Callers that need read-only
 * semantics use {@link parseMemoryOpts} instead. This narrow helper
 * is preserved for back-compat with code paths that only care about
 * scope resolution.
 */
export function parseMemoryScope(raw: unknown): MemoryScope | null {
  if (raw === false || raw === undefined || raw === null) return null;
  if (raw === "user" || raw === "project" || raw === "local") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.scope === "user" || o.scope === "project" || o.scope === "local") {
      return o.scope;
    }
  }
  throw new TypeError(
    `ctx.agent: opts.memory must be 'user' | 'project' | 'local' | false | { scope, readOnly? } (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Parsed memory options. The object form lets authors flag a memory
 * mount as read-only — the runtime injects MEMORY.md into the
 * sub-agent prompt as usual but drops any `{type:'memory_update'}`
 * events the sub-agent emits. Useful for shared "playbook" personas
 * where a writer would corrupt the canonical memory file.
 */
export interface MemoryOpts {
  readonly scope: MemoryScope;
  readonly readOnly: boolean;
}

/**
 * Parse a raw `opts.memory` value into a typed `MemoryOpts | null`.
 * Accepts the legacy string shape (`'user'|'project'|'local'`) and
 * the v0.3 object shape (`{ scope, readOnly? }`). Returns `null` for
 * `false`/`undefined`/`null` (no-op).
 *
 * Throws `TypeError` for malformed shapes — same blame surface as
 * {@link parseMemoryScope}.
 */
export function parseMemoryOpts(raw: unknown): MemoryOpts | null {
  if (raw === false || raw === undefined || raw === null) return null;
  if (raw === "user" || raw === "project" || raw === "local") {
    return { scope: raw, readOnly: false };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.scope === "user" || o.scope === "project" || o.scope === "local") {
      const readOnly = o.readOnly === true;
      return { scope: o.scope, readOnly };
    }
  }
  throw new TypeError(
    `ctx.agent: opts.memory must be 'user' | 'project' | 'local' | false | { scope, readOnly? } (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Build a string key for a (scope, name) tuple — used to track which
 * tuples are flagged read-only across the run so `ctx.memory.append`
 * can refuse writes against them.
 */
export function memoryReadOnlyKey(scope: MemoryScope, name: string): string {
  return `${scope}:${name}`;
}

/**
 * Thrown by `ctx.memory.append` when the (name, scope) tuple has been
 * marked read-only via a prior `ctx.agent({memory: {scope, readOnly:
 * true}, name})` call. Mirrors `SchemaValidationError`'s shape so
 * `e instanceof Error && e.name === 'ReadOnlyMemoryError'` works
 * across the realm boundary.
 */
export class ReadOnlyMemoryError extends Error {
  readonly memoryName: string;
  readonly memoryScope: MemoryScope;
  constructor(memoryName: string, memoryScope: MemoryScope) {
    super(
      `ctx.memory.append: "${memoryName}" (${memoryScope}) is mounted read-only — drop the readOnly flag on ctx.agent() or call from a different name/scope.`,
    );
    this.name = "ReadOnlyMemoryError";
    this.memoryName = memoryName;
    this.memoryScope = memoryScope;
  }
}

// ─── Cross-check on resume (gap follow-up #3) ───────────────────────

export interface MemoryDirMismatch {
  readonly name: string;
  readonly recordedDir: string;
  /** Live-resolved dirs the recorded value was checked against. */
  readonly liveCandidates: ReadonlyArray<{ scope: MemoryScope; dir: string }>;
}

export interface CrossCheckOpts {
  readonly recorded: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runDirAbs: string;
  readonly homeDir?: string;
}

/**
 * Compare each `(name, recordedDir)` pair against the live re-resolved
 * directory across all three scopes. Returns one entry per name whose
 * recorded dir matches NONE of the live candidates — that's the
 * "memory dir moved between runs" case (e.g. cwd changed under a
 * project-scoped persona, or `$HOME` differs).
 *
 * Names whose recorded dir matches at least one live scope are
 * considered well-anchored and produce no warning.
 */
export function crossCheckAgentMemoryDirs(
  opts: CrossCheckOpts,
): MemoryDirMismatch[] {
  const out: MemoryDirMismatch[] = [];
  const scopes: MemoryScope[] = ["user", "project", "local"];
  for (const [name, recordedDir] of Object.entries(opts.recorded)) {
    if (typeof recordedDir !== "string" || recordedDir.length === 0) continue;
    let safe: string | null = null;
    try {
      assertSafeMemoryName(name);
      safe = name;
    } catch {
      // Recorded name fails sanitization — skip silently. The dispatch
      // path rejects these before they're written, so this only happens
      // if a manifest is hand-edited.
      continue;
    }
    const candidates = scopes.map((scope) => ({
      scope,
      dir: resolveMemoryDir({
        scope,
        name: safe!,
        cwd: opts.cwd,
        runDirAbs: opts.runDirAbs,
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      }),
    }));
    const matched = candidates.some((c) => c.dir === recordedDir);
    if (!matched) {
      out.push({ name, recordedDir, liveCandidates: candidates });
    }
  }
  return out;
}

// ─── Compaction (gap follow-up #1) ──────────────────────────────────

export class CompactionError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CompactionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CompactionResult {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly ratio: number;
}

export interface CompactMemoryFileOpts {
  /** Directory containing MEMORY.md. */
  readonly dir: string;
  /**
   * Async hook invoked with the original file content. Must resolve
   * to the new (compacted) content. Errors propagate as
   * {@link CompactionError}.
   */
  readonly summarize: (original: string) => Promise<string>;
}

/**
 * Atomically compact MEMORY.md.
 *
 * Steps:
 *   1. Read the file (fails fast as `CompactionError` if missing).
 *   2. Call `summarize(original)` — caller-supplied async hook.
 *   3. Write the result to a sibling `.tmp` file then `rename` over
 *      the original. Same atomic-write pattern used by
 *      `manifestWriter.ts`.
 *
 * On any error the original file is left untouched (the rename only
 * happens after a successful summarize + tmp write).
 */
export async function compactMemoryFile(
  opts: CompactMemoryFileOpts,
): Promise<CompactionResult> {
  const target = join(opts.dir, MEMORY_FILE_NAME);
  let original: string;
  let beforeBytes: number;
  try {
    // Open the fd first and stat+read through it so both operations refer to
    // the same inode.  A concurrent compactMemoryFile rename between a
    // path-stat and fs.readFile would otherwise let beforeBytes describe the
    // old file while original contains the already-compacted replacement,
    // causing the queue's rescue logic to summarize already-summarized content
    // (summary-of-a-summary).  Same fix as BUG-154 applied to
    // readMemoryFileWithMeta.
    const fh = await fs.open(target, "r");
    try {
      const st = await fh.stat();
      beforeBytes = st.size;
      original = await fh.readFile({ encoding: "utf8" });
    } finally {
      await fh.close();
    }
  } catch (e) {
    throw new CompactionError(
      `compactMemoryFile: source ${target} unreadable: ${(e as Error).message}`,
      e,
    );
  }
  let summarized: string;
  try {
    summarized = await opts.summarize(original);
  } catch (e) {
    throw new CompactionError(
      `compactMemoryFile: summarize hook threw: ${(e as Error).message}`,
      e,
    );
  }
  if (typeof summarized !== "string") {
    throw new CompactionError(
      `compactMemoryFile: summarize hook must return a string (got ${typeof summarized})`,
    );
  }
  // Enqueue the write so it cannot race with concurrent appendMemoryUpdate
  // calls.  Inside the queue we re-read the file to rescue any appends that
  // arrived while summarize() was running (which can take tens of seconds),
  // then write summary + rescued tail atomically.
  let afterBytes = 0;
  await enqueueWrite(opts.dir, async () => {
    // Rescue appends made during the slow summarize() call.
    let tail = "";
    try {
      const current = await fs.readFile(target, "utf8");
      // If the file still starts with what we originally read, the suffix is
      // new content written by concurrent appends — preserve it after the
      // summary so nothing is silently lost.
      if (current.startsWith(original) && current.length > original.length) {
        tail = current.slice(original.length);
      }
    } catch {
      /* file may have been removed — write summary only */
    }
    // Guarantee a trailing newline so future appends keep their separator.
    const base = summarized.endsWith("\n") ? summarized : summarized + "\n";
    const finalContent = tail ? base + tail : base;
    const tmp = join(
      opts.dir,
      `${MEMORY_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${randomBytes(
        4,
      ).toString("hex")}`,
    );
    try {
      await fs.writeFile(tmp, finalContent, "utf8");
      // fsync the tmp file before rename so content is durable on crash.
      // rename is POSIX-atomic but the pages may still be in the OS cache;
      // without fsync a crash after rename can leave MEMORY.md corrupt/empty.
      const fd = await fs.open(tmp, "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      await fs.rename(tmp, target);
      afterBytes = Buffer.byteLength(finalContent, "utf8");
    } catch (e) {
      // Best-effort cleanup of the tmp file; ignore failure.
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw new CompactionError(
        `compactMemoryFile: atomic write failed: ${(e as Error).message}`,
        e,
      );
    }
  });
  return {
    beforeBytes,
    afterBytes,
    ratio: beforeBytes === 0 ? 1 : afterBytes / beforeBytes,
  };
}

// `sep` is exported only to make path-prefix checks straightforward in
// callers without re-importing `node:path`.
export { sep as PATH_SEP };
