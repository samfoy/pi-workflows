/**
 * src/runtime/schema.ts — schema-validation helpers used by ctx.agent
 * and ctx.interrupt.
 *
 * Extracted from src/runtime/runCtx.ts (post-2026 audit) so the validation
 * surface lives independently of the 2,000-line createRunCtxHost closure.
 * Three things land here:
 *
 *   - `extractJson(text)`  — pull a JSON block out of agent prose.
 *   - `validateAgainstSchema(value, schema)` — minimal JSON-Schema-subset
 *     validator covering the DSPy / OpenAI structured-outputs shape.
 *   - `SchemaValidationError` + `InterruptValueValidationError` — typed
 *     errors with `.path / .expected / .actual` so the cross-realm
 *     reconstructor can rehydrate them on the workflow-author side.
 *
 * `buildSchemaInstruction` is internal to runCtx.ts (only used during
 * prompt construction) so it stays there to avoid widening this module's
 * public surface.
 */

/**
 * Extract the last JSON value (object or array) from agent text output.
 * Tries a ```json fence first (takes the LAST fence block), then falls back
 * to scanning from the first `{` or `[` and finding the matching close
 * delimiter via bracket-depth tracking.
 *
 * BUG-051: old fallback used lastIndexOf which found the innermost brace and
 * sliced to end-of-string (breaking on trailing prose and nested objects).
 * BUG-052: old fence regex matched the FIRST code block; agents often emit
 * example blocks before the actual output block.
 */
export function extractJson(text: string): unknown {
  // BUG-052 fix: use matchAll + take the LAST fence block (not the first).
  const fenceMatches = [...text.matchAll(/```json\s*([\s\S]*?)```/gs)];
  const fenceMatch = fenceMatches.at(-1);
  if (fenceMatch?.[1] !== undefined) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // BUG-051 fix: scan from the FIRST { or [ and depth-track to the matching
  // close delimiter so nested JSON is correctly extracted and trailing prose
  // is excluded.
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start: number;
  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error("ctx.agent schema: no JSON found in agent output");
  }
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error("ctx.agent schema: no JSON found in agent output");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * gap-fix: post-parse schema validation at the phase boundary.
 *
 * Thrown after `extractJson` succeeds but the parsed value doesn't
 * match the agent's declared `opts.schema`. Surfaces the path to the
 * mismatch and the expected vs. actual shape so authors see WHERE the
 * agent's output drifted, not just that it did.
 *
 * Class identity is preserved through realmError.captureError and
 * the Context-realm reconstructor (sandbox.ts `__pi_reconstruct_error`)
 * so author code's `e instanceof Error && e.name === 'SchemaValidationError'`
 * predicate works.
 */
export class SchemaValidationError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  constructor(path: string, expected: string, actual: string) {
    super(
      `ctx.agent schema: validation failed at "${path}": expected ${expected}, got ${actual}`,
    );
    this.name = "SchemaValidationError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * ZONE_HITL gap follow-up #3 — thrown when a `ctx.interrupt({schema})`
 * receives a resume value that doesn't match the declared schema.
 * The supervisor sees the original interrupt prompt; the workflow
 * author sees this typed error so they can re-prompt or take an
 * alternate code path. Mirrors `SchemaValidationError`'s shape so
 * `e instanceof Error && e.name === 'InterruptValueValidationError'`
 * works across the realm boundary.
 */
export class InterruptValueValidationError extends Error {
  readonly key: string;
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  constructor(
    key: string,
    path: string,
    expected: string,
    actual: string,
  ) {
    super(
      `ctx.interrupt(${JSON.stringify(key)}) schema: validation failed at "${path}": expected ${expected}, got ${actual}`,
    );
    this.name = "InterruptValueValidationError";
    this.key = key;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Minimal JSON-Schema-subset validator. Supports the slice of JSON
 * Schema that DSPy and OpenAI structured-outputs use:
 *   - `type`: 'object' | 'array' | 'string' | 'number' | 'integer'
 *             | 'boolean' | 'null' (or array of these for unions)
 *   - `properties` + `required` for object
 *   - `items` for array
 *   - `additionalProperties: false` (default true)
 *   - `enum`: list of allowed primitive values
 *
 * Throws `SchemaValidationError` on first mismatch. Does NOT validate
 * non-shape constraints (minLength, format, pattern, etc.) — those
 * belong to a heavyweight validator like Ajv. The point here is
 * "agent returned the wrong SHAPE", not full JSON Schema conformance.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path: string = "$",
): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    // Non-object schema (e.g. boolean true) — accept anything.
    return;
  }
  const s = schema as Record<string, unknown>;
  // enum: value must be one of the listed primitives.
  if (Array.isArray(s.enum)) {
    const enumArr = s.enum as unknown[];
    let found = false;
    for (let i = 0; i < enumArr.length; i++) {
      if (enumArr[i] === value) { found = true; break; }
    }
    if (!found) {
      throw new SchemaValidationError(
        path,
        `one of ${JSON.stringify(enumArr)}`,
        JSON.stringify(value),
      );
    }
  }
  if (s.type === undefined) return;
  const types = Array.isArray(s.type) ? (s.type as unknown[]) : [s.type];
  // Resolve actual type label.
  const actualType = ((): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    const t = typeof value;
    if (t === "number") return Number.isInteger(value) ? "integer" : "number";
    return t;
  })();
  // 'integer' satisfies 'number' (JSON Schema spec); 'number' alone does
  // NOT satisfy 'integer'.
  let typeOk = false;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === actualType) { typeOk = true; break; }
    if (t === "number" && actualType === "integer") { typeOk = true; break; }
  }
  if (!typeOk) {
    throw new SchemaValidationError(
      path,
      types.length === 1 ? String(types[0]) : `one of ${JSON.stringify(types)}`,
      actualType,
    );
  }
  // Recurse for object/array.
  if (actualType === "object") {
    const v = value as Record<string, unknown>;
    const properties = (s.properties as Record<string, unknown> | undefined) ?? {};
    const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
    for (let i = 0; i < required.length; i++) {
      const key = required[i];
      if (typeof key !== "string") continue;
      if (!Object.prototype.hasOwnProperty.call(v, key)) {
        throw new SchemaValidationError(
          `${path}.${key}`,
          "required property",
          "undefined",
        );
      }
    }
    const propKeys = Object.keys(properties);
    for (let i = 0; i < propKeys.length; i++) {
      const key = propKeys[i] as string;
      if (Object.prototype.hasOwnProperty.call(v, key)) {
        validateAgainstSchema(v[key], properties[key], `${path}.${key}`);
      }
    }
    if (s.additionalProperties === false) {
      const valueKeys = Object.keys(v);
      for (let i = 0; i < valueKeys.length; i++) {
        const k = valueKeys[i] as string;
        if (!Object.prototype.hasOwnProperty.call(properties, k)) {
          throw new SchemaValidationError(
            `${path}.${k}`,
            "no extra properties",
            "unexpected property",
          );
        }
      }
    }
  } else if (actualType === "array" && s.items !== undefined) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      validateAgainstSchema(arr[i], s.items, `${path}[${i}]`);
    }
  }
}
