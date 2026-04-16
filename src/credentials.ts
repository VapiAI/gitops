import type { StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Credential Resolution — resolve org-specific credential UUIDs across environments
//
// Credentials are pulled from the API and stored in state (name-slug → UUID).
// Resource files store credential NAMES (e.g., "roofr-server-credential").
// Push resolves names → UUIDs. Pull resolves UUIDs → names.
//
// Replacement is scoped to `credentialId` / `credentialIds` fields only.
// Credential slugs like `openai`, `langfuse`, `11labs` collide with enum
// values for fields such as `model.provider`, `voice.provider`,
// `observabilityPlan.provider`. A generic string-level walk would swap those
// enum values with UUIDs and break POST validation.
// ─────────────────────────────────────────────────────────────────────────────

// Build UUID → name reverse map from state.credentials
export function credentialReverseMap(state: StateFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, uuid] of Object.entries(state.credentials)) {
    map.set(uuid, name);
  }
  return map;
}

// Build name → UUID forward map from state.credentials
export function credentialForwardMap(state: StateFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, uuid] of Object.entries(state.credentials)) {
    map.set(name, uuid);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped walker: replace values only at `credentialId` / `credentialIds` keys.
// Works at any depth in any object/array structure.
// ─────────────────────────────────────────────────────────────────────────────

export function replaceCredentialRefs<T>(
  obj: T,
  replacements: Map<string, string>,
): T {
  if (replacements.size === 0) return obj;
  return walk(obj, replacements, new WeakSet()) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  // Only walk into objects produced by JSON parsing or object literals.
  // Date/Map/Set/Buffer/etc. should pass through unchanged — recursing into
  // them via Object.entries silently drops their prototype methods.
  return proto === Object.prototype || proto === null;
}

function walk(
  value: unknown,
  replacements: Map<string, string>,
  seen: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => walk(item, replacements, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "credentialId" && typeof val === "string") {
        result[key] = replacements.get(val) ?? val;
      } else if (key === "credentialIds" && Array.isArray(val)) {
        result[key] = val.map((item) =>
          typeof item === "string"
            ? (replacements.get(item) ?? item)
            : walk(item, replacements, seen),
        );
      } else {
        result[key] = walk(val, replacements, seen);
      }
    }
    return result;
  }

  return value;
}
