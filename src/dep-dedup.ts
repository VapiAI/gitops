// Dependency reuse requires recorded ownership; names alone are not authorization.

import { extractBaseSlug, slugify } from "./slug-utils.ts";
import type { ResourceState } from "./types.ts";

export { extractBaseSlug, slugify } from "./slug-utils.ts";

export interface RemoteResource {
  id: string;
  name?: string;
  function?: { name?: string };
}

export interface DedupMatch {
  uuid: string;
  origin: "pushed" | "adopted";
  source: "state";
  ambiguous: boolean;
  // Other distinct UUIDs we saw under the same canonical name. Empty when
  // `ambiguous` is false. Caller should surface these in a warning so the
  // user can run `npm run cleanup` to prune the duplicates.
  duplicateUuids: string[];
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

// Only repo-created or explicitly adopted state entries can be reused.
export function findExistingResourceByName(args: {
  localResourceId: string;
  localPayload: NameablePayload;
  stateSection: Record<string, ResourceState>;
  remoteList?: RemoteResource[];
}): DedupMatch | undefined {
  const localName = extractResourceName(args.localPayload);
  if (!localName) return undefined;
  const localSlug = slugify(localName);

  const matches = new Map<string, "pushed" | "adopted">();

  for (const [stateKey, entry] of Object.entries(args.stateSection)) {
    if (stateKey === args.localResourceId) continue;
    if (
      extractBaseSlug(stateKey) === localSlug &&
      (entry.origin === "pushed" || entry.origin === "adopted")
    ) {
      matches.set(entry.uuid, entry.origin);
    }
  }

  if (matches.size === 0) return undefined;

  const sorted = [...matches.keys()].sort();
  const winner = sorted[0]!;

  return {
    uuid: winner,
    origin: matches.get(winner)!,
    source: "state",
    ambiguous: matches.size > 1,
    duplicateUuids: sorted.slice(1),
  };
}

export function warnUnownedNameMatches(args: {
  resourceType: string;
  localResourceId: string;
  localPayload: NameablePayload;
  stateSection: Record<string, ResourceState>;
  remoteList: RemoteResource[];
  reusedUuid?: string;
}): void {
  const name = extractResourceName(args.localPayload) ?? args.localResourceId;
  const slug = slugify(name);
  const matches = new Map<string, string>();
  for (const [key, entry] of Object.entries(args.stateSection)) {
    if (extractBaseSlug(key) === slug) matches.set(entry.uuid, name);
  }
  for (const remote of args.remoteList) {
    const remoteName = extractResourceName(remote);
    if (remoteName && slugify(remoteName) === slug)
      matches.set(remote.id, remoteName);
  }
  for (const [uuid, remoteName] of matches) {
    if (uuid === args.reusedUuid) continue;
    console.warn(
      `  ⚠️  Existing ${args.resourceType} "${remoteName}" (${uuid}) was NOT linked by name. --adopt ${args.localResourceId} takes it over instead.`,
    );
  }
}
