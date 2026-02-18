import type { StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Credential Resolution — resolve org-specific credential UUIDs across environments
//
// Credentials are pulled from the API and stored in state (name-slug → UUID).
// Resource files store credential NAMES (e.g., "roofr-server-credential").
// Push resolves names → UUIDs. Pull resolves UUIDs → names.
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
// Deep walk: replace string values matching the map keys
// Works at any depth in any object/array structure
// ─────────────────────────────────────────────────────────────────────────────

export function deepReplaceValues<T>(obj: T, replacements: Map<string, string>): T {
  if (replacements.size === 0) return obj;
  return walk(obj, replacements) as T;
}

function walk(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") {
    return replacements.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, replacements));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = walk(val, replacements);
    }
    return result;
  }

  return value;
}
