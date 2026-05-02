// Pure serialization helpers for the state file (and snapshot files).
//
// Kept config-free so tests can import without triggering the CLI argument
// parser in `config.ts` (which `process.exit(1)`s when no env is supplied).

// JSON.stringify replacer that emits object keys in alphabetical order at
// every nesting level. Without this, the state file diff includes pure
// reorderings every time a resource map gets rebuilt from multiple sources
// (push, pull, bootstrap) — about half the diff lines are insertion-order
// churn rather than semantic change. Reviewers stop reading state diffs
// closely as a result, which defeats the point of versioning the file.
//
// Arrays are returned as-is so existing array order (e.g. squad members,
// tool destinations) is preserved.
export function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

// Canonicalize a value: sort object keys at every level, drop null/undefined
// leaves recursively, leave array order intact. Produces a stable shape
// regardless of insertion order or transient nullish leaves the API may
// emit. Used by Stack F (content hashes) and Stack G (drift detection) —
// kept here so the helpers stay co-located.
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const c = canonicalize(item);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const c = canonicalize((value as Record<string, unknown>)[k]);
    if (c !== undefined) sorted[k] = c;
  }
  return sorted;
}
