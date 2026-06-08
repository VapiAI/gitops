// ─────────────────────────────────────────────────────────────────────────────
// Shared slug helpers — config-free, no side-effect imports.
//
// This module exists to break two duplications that previously lived across
// `pull.ts`, `dep-dedup.ts`, `audit.ts`, and `setup.ts`:
//   - `slugify(name)` — 4 byte-identical copies
//   - `extractBaseSlug(resourceId)` — 2 byte-identical copies
//
// It also exposes the strict `isEngineSuffixedSlug` form used by
// `recanonicalize.ts` to prove a state key was engine-generated (i.e. the
// captured 8-hex matches the entry's UUID prefix), and the canonical
// `UUID_SUFFIX_RE` constant.
//
// Config-free is load-bearing: `config.ts` asserts `argv[2]` / `VAPI_TOKEN`
// at module load. Any test that imports a slug helper without going through
// this module would otherwise have to prime `process.argv` and
// `process.env.VAPI_TOKEN` (see `tests/recanonicalize.test.ts:7-8`). This
// module has zero such side effects so it's safely importable from any test.
// ─────────────────────────────────────────────────────────────────────────────

// `^(.+)-([0-9a-f]{8})$` deliberately requires a non-empty base. An engine-
// generated state key always carries a real slug before the 8-hex suffix —
// the synthetic `-deadbeef` shape (empty base) is never produced.
export const UUID_SUFFIX_RE = /^(.+)-([0-9a-f]{8})$/i;

// Lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing
// `-`, and collapse repeated `-`. Mirrors the slug shape produced by
// `generateResourceId` in `src/pull.ts` and downstream `<base>-<uuid8>`
// patterns.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

// Loose form: strip a trailing 8-hex segment if the resourceId matches the
// engine-generated `<base>-<uuid8>` shape; otherwise return the input
// unchanged. Used by callers that don't have a UUID handy (audit's
// sibling-base-slug check, the orphan-gate's pairing pass, pull's
// `findExistingResourceId`, dep-dedup's `extractBaseSlug` consumers).
//
// This intentionally does NOT verify that the captured suffix matches any
// specific UUID — that proof requires `isEngineSuffixedSlug`. Loose callers
// only need a best-effort canonical form.
export function extractBaseSlug(resourceId: string): string {
  const match = resourceId.match(UUID_SUFFIX_RE);
  return match?.[1] ?? resourceId;
}

// Strict form: return the parsed `{ base, suffix }` ONLY when the captured
// 8 hex chars match the leading 8 hex chars of `uuid` (case-insensitive,
// dashes stripped defensively). Returns `null` otherwise — including when
// the resourceId doesn't match the engine shape at all.
//
// Use this when you have BOTH a state key AND its entry's UUID and need to
// prove the key was engine-generated (the precondition-2 check in
// `recanonicalize.ts`). A user-given name that coincidentally ends in
// `-abcd1234` will NOT match because its UUID prefix is different.
//
// Mirrors `generateResourceId` in `src/pull.ts:265-273` — UUIDs have the
// form `xxxxxxxx-xxxx-...` so the first 8 hex chars are dash-free, but the
// dash-strip is kept as defense against malformed input.
export function isEngineSuffixedSlug(
  stateKey: string,
  uuid: string,
): { base: string; suffix: string } | null {
  const match = stateKey.match(UUID_SUFFIX_RE);
  if (!match) return null;
  const base = match[1];
  const capturedSuffix = match[2];
  if (!base || !capturedSuffix) return null;
  const uuidPrefix = uuid.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (capturedSuffix.toLowerCase() !== uuidPrefix) return null;
  return { base, suffix: capturedSuffix.toLowerCase() };
}

// Dashboard-backup sibling files (`<name>.<TIMESTAMP>.bkp.yml|.yaml|.md`) are
// written by the push conflict prompt for manual merging. Every discovery
// path (resource loader, orphan gate, audit, interactive picker, explicit
// CLI paths) must treat them as invisible — they are never resources, and
// loading one would re-create it on the platform as a duplicate.
// `.dashboard.` is the legacy pre-timestamp naming; keep excluding it so
// leftover copies can't be loaded either. Lives here (not resources.ts)
// because the interactive launcher is config-free and can't import modules
// that pull in config.ts.
export function isBackupCopyFile(fileName: string): boolean {
  return /\.(bkp|dashboard)\.(yml|yaml|md)$/.test(fileName);
}
