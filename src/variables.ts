// ─────────────────────────────────────────────────────────────────────────────
// Managed variables — centralized, hand-authored values referenced from
// resource files via whole-value liquid placeholders (`{{name}}`).
//
// This is the variable analogue of canonical.ts's reference resolution:
//   - resolveVariables()            forward  (push):     {{name}} → value
//   - restoreVariablePlaceholders() reverse  (pull):     value    → {{name}}  (guided)
//   - extractPlaceholders()         discovery (validate): list every {{name}} used
//
// WHOLE-VALUE ONLY. A placeholder substitutes only when the ENTIRE (trimmed)
// string value is a single `{{name}}`. Embedded placeholders inside a longer
// string (e.g. "Hi {{name}}") are intentionally left untouched: in-string
// interpolation is lossy and cannot round-trip cleanly through pull/drift.
// Because substitution is whole-value, the value→placeholder reverse is a
// clean, type-preserving inverse — variables slot into the same symmetric
// model the engine already uses for tool/assistant/credential references.
//
// Config-free and dependency-light (only state-serialize's pure `canonicalize`)
// so resolver.ts, resources.ts, pull.ts, and validate.ts can all import it
// without an import cycle.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalize } from "./state-serialize.ts";
import type { Variables } from "./types.ts";

// A managed variable name: identifier-ish (letters, digits, underscore, dot,
// hyphen). NO internal spaces — keeps the whole-value match unambiguous and
// mirrors the state-file key shape. Whitespace inside the braces is allowed
// and ignored, so `{{ x }}` and `{{x}}` are the same placeholder.
const PLACEHOLDER_RE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

// If `value` is a whole-value placeholder string, return the variable name;
// otherwise null. Leading/trailing whitespace around the whole scalar is
// tolerated so a YAML value that picked up stray spaces still matches.
export function parsePlaceholder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(PLACEHOLDER_RE);
  return match ? (match[1] as string) : null;
}

// Order-insensitive structural equality in the SAME basis the engine hashes in
// (`canonicalize` sorts object keys and drops nullish leaves). Used to decide
// whether a platform value still equals a managed variable's value.
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

// Forward (push): deep-walk `data`, replacing every whole-value `{{name}}`
// with the managed value, native type preserved. Unknown names are left
// as-is — validate.ts surfaces them as blocking findings and push warns;
// silently dropping them here would mask the mistake. Pure: returns a new
// structure, never mutates the input. Single pass — a variable whose value
// itself contains a placeholder is NOT recursively resolved.
export function resolveVariables(
  data: unknown,
  variables: Variables = {},
): unknown {
  // Tolerate a nullish map: some callers read the state file by casting raw
  // JSON instead of going through loadState()/normalizeVariables, so
  // `state.variables` can be undefined there. Degrade to a no-op rather than
  // throwing on `hasOwnProperty.call(undefined, ...)`.
  if (!variables) variables = {};
  if (Array.isArray(data)) {
    return data.map((item) => resolveVariables(item, variables));
  }
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = resolveVariables(value, variables);
    }
    return out;
  }
  const name = parsePlaceholder(data);
  if (name !== null && Object.prototype.hasOwnProperty.call(variables, name)) {
    // structuredClone so an object/array variable referenced from multiple
    // placeholder sites can't be aliased into a shared mutable instance.
    return structuredClone(variables[name]);
  }
  return data;
}

// Reverse (pull), GUIDED by the previously-authored local file. Walk the
// platform `data` in parallel with the `local` structure. Wherever the local
// file had a whole-value `{{name}}` AND the platform value at that same path
// still equals the managed value, emit the ORIGINAL local placeholder string
// verbatim (preserving the author's exact text). Everywhere else emit the
// platform value unchanged.
//
// Guidance by the local file is what makes this safe: a placeholder is only
// ever re-inserted where the author already had one, so a literal value that
// merely happens to equal a variable's value is NEVER rewritten. A field
// changed on the dashboard (value no longer equals the variable) falls through
// to the literal — the caller is responsible for any "field changed" notice.
export function restoreVariablePlaceholders(
  data: unknown,
  local: unknown,
  variables: Variables = {},
): unknown {
  if (!variables) variables = {};
  const name = parsePlaceholder(local);
  if (
    name !== null &&
    Object.prototype.hasOwnProperty.call(variables, name) &&
    valuesEqual(data, variables[name])
  ) {
    return local; // keep the author's exact placeholder text
  }

  if (Array.isArray(data)) {
    const localArr = Array.isArray(local) ? local : [];
    return data.map((item, idx) =>
      restoreVariablePlaceholders(item, localArr[idx], variables),
    );
  }
  if (data && typeof data === "object") {
    const localObj =
      local && typeof local === "object" && !Array.isArray(local)
        ? (local as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = restoreVariablePlaceholders(value, localObj[key], variables);
    }
    return out;
  }
  return data;
}

// Discovery (validate): every distinct whole-value placeholder name referenced
// anywhere in `data`, sorted for deterministic output.
export function extractPlaceholders(data: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        walk(value);
      }
      return;
    }
    const name = parsePlaceholder(node);
    if (name !== null) names.add(name);
  };
  walk(data);
  return [...names].sort();
}

// Validate + normalize a raw `variables` blob read from the state file. A
// non-object (or array) becomes `{}`; otherwise the map is copied through.
// Variable VALUES are arbitrary JSON, so there is nothing to validate at the
// leaf level (functions/undefined cannot survive JSON.parse).
export function normalizeVariables(raw: unknown): Variables {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Variables) };
}
