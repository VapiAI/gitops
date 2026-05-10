// Dependency deduplication helpers for the push pipeline.
//
// On a targeted assistant push, `ensureToolExists` / `ensureStructuredOutputExists`
// previously skipped auto-create only when (a) the dep id was UUID-shaped,
// (b) `state.tools[depId]` was an exact key match, or (c) we'd already
// auto-applied this id in the current run. Bootstrap pull stores resources
// under `<slug>-<uuid8>` keys (e.g. `end-call-67aea057`), so a local file
// referencing `b2b-invoice-end-call` would miss the exact-key check and
// POST a duplicate dashboard tool. Repeated targeted pushes accumulated
// orphans on the dashboard.
//
// This module's helpers detect those collisions BEFORE create:
//   - `findExistingResourceByName` — match local payload's canonical name
//     against existing state entries (renamed/state-only keys) and the live
//     dashboard list. Returns the UUID to adopt, plus an `ambiguous` flag
//     when multiple distinct UUIDs share the same name (real on-dashboard
//     duplicates from prior bug runs — the caller should warn and surface
//     the loser UUIDs so a follow-up `npm run cleanup` can prune them).
//
// NOTE on duplication: `slugify` and `extractBaseSlug` here mirror the
// definitions in `src/pull.ts`. pull.ts imports config.ts, which calls
// `parseEnvironment()` at module load and `process.exit(1)`s without a
// CLI env arg — making it impossible to import in a unit test. This
// module imports ONLY from `./types.ts` so it stays testable in
// isolation. Five lines duplicated is the right tradeoff; do not "DRY"
// these back into pull.ts.

import type { ResourceState } from "./types.ts";

export interface RemoteResource {
  id: string;
  name?: string;
  function?: { name?: string };
}

export interface DedupMatch {
  uuid: string;
  source: "state" | "dashboard" | "both";
  ambiguous: boolean;
  // Other distinct UUIDs we saw under the same canonical name. Empty when
  // `ambiguous` is false. Caller should surface these in a warning so the
  // user can run `npm run cleanup` to prune the duplicates.
  duplicateUuids: string[];
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function extractBaseSlug(resourceId: string): string {
  const match = resourceId.match(/^(.*)-([a-f0-9]{8})$/i);
  return match?.[1] ?? resourceId;
}

// Minimal payload shape this module needs. Local resource files are loaded
// as `Record<string, unknown>`, so the only fields we know exist are `name`
// (top-level, used by SOs / assistants / squads) and a nested `function.name`
// (used by tools). Everything else stays opaque — we narrow at use.
export type NameablePayload = { name?: unknown; function?: unknown };

// Pulls the canonical name from a tool / SO / assistant payload.
// For tools: `function.name` is the canonical name.
// For SOs / assistants / etc.: top-level `name`. Top-level wins when both
// are present.
export function extractResourceName(
  payload: NameablePayload,
): string | undefined {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  const fn = payload.function;
  if (
    fn !== null &&
    typeof fn === "object" &&
    "name" in fn &&
    typeof fn.name === "string" &&
    fn.name
  ) {
    return fn.name;
  }
  return undefined;
}

// Find an existing resource (in state or dashboard) whose canonical name
// matches the local payload's canonical name. Used by ensureToolExists /
// ensureStructuredOutputExists to avoid creating a duplicate when bootstrap
// pull has already stored the same dashboard resource under a different
// state key.
//
// `localResourceId` is the key the engine WANTS to use in state. If a state
// entry already exists under that exact key, the caller short-circuits BEFORE
// calling this — so we exclude it here as a safety belt.
//
// Tiebreaker for >1 distinct UUID matching the same slugified name (i.e.
// real on-dashboard duplicates from prior bug runs): pick lexically smallest
// UUID for stable, deterministic adoption. Set `ambiguous=true` and surface
// the loser UUIDs in `duplicateUuids` so the caller can warn.
export function findExistingResourceByName(args: {
  localResourceId: string;
  localPayload: NameablePayload;
  stateSection: Record<string, ResourceState>;
  remoteList?: RemoteResource[];
}): DedupMatch | undefined {
  const localName = extractResourceName(args.localPayload);
  if (!localName) return undefined;
  const localSlug = slugify(localName);

  // uuid -> set of source labels (state:<key>, dashboard:<id>)
  const matches = new Map<string, Set<string>>();

  for (const [stateKey, entry] of Object.entries(args.stateSection)) {
    if (stateKey === args.localResourceId) continue;
    if (extractBaseSlug(stateKey) === localSlug) {
      const set = matches.get(entry.uuid) ?? new Set<string>();
      set.add(`state:${stateKey}`);
      matches.set(entry.uuid, set);
    }
  }

  for (const remote of args.remoteList ?? []) {
    const remoteName =
      (typeof remote.name === "string" && remote.name) || remote.function?.name;
    if (!remoteName) continue;
    if (slugify(remoteName) === localSlug) {
      const set = matches.get(remote.id) ?? new Set<string>();
      set.add(`dashboard:${remote.id}`);
      matches.set(remote.id, set);
    }
  }

  if (matches.size === 0) return undefined;

  const sorted = [...matches.keys()].sort();
  const winner = sorted[0]!;
  const winnerSources = matches.get(winner)!;
  const hasState = [...winnerSources].some((s) => s.startsWith("state:"));
  const hasDashboard = [...winnerSources].some((s) =>
    s.startsWith("dashboard:"),
  );
  const source: DedupMatch["source"] =
    hasState && hasDashboard ? "both" : hasState ? "state" : "dashboard";

  return {
    uuid: winner,
    source,
    ambiguous: matches.size > 1,
    duplicateUuids: sorted.slice(1),
  };
}
