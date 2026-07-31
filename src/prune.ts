// Stale-tracked-file pruning for `pull --force`.
//
// WHY THIS EXISTS
//
// `pull --force` is documented as "nuke-and-rematerialize local from dashboard"
// but historically only ever *overwrote* files the dashboard returned. A
// resource deleted on the dashboard dropped out of the rewritten state file
// while its local file stayed behind — an untracked orphan that then failed
// push's orphan-YAML gate, or worse, got recreated by
// `push --allow-new-files`. The customer-visible instance of this was a
// deleted assistant whose file survived three forced pulls without a single
// line of output mentioning it.
//
// THE SAFETY MODEL
//
// Deleting local files is the most destructive thing this engine can do to a
// working copy, so pruning is gated on four independent facts, ALL of which
// must hold:
//
//   1. The slug was in the PRE-pull state section. A local file with no prior
//      state entry may be a genuinely new resource, an unfinished edit, a
//      hand-copied fixture, or a rename awaiting reconciliation — never
//      touched.
//   2. The slug is absent from the POST-pull state section. If a recreated or
//      adopted dashboard resource claimed the same slug, the file is live.
//   3. The UUID is absent from the dashboard listing entirely. This filters
//      out duplicate state mappings (two slugs, one UUID), where the resource
//      is very much alive and only the extra mapping is stale.
//   4. A direct GET on the UUID returns 404. This is the one that makes the
//      whole thing sound: `fetchAllResources` does not paginate, so the
//      listing in (3) is a hint, not proof. An explicit 404 is proof. A
//      transient 5xx, a timeout, or any other error leaves the file alone.
//
// `.vapi-ignore` matches are additionally never deleted, matching the ignore
// contract everywhere else in the engine ("orphan-protected against `--force`
// deletion"). Note that force pull deliberately bypasses ignore for *writes*;
// it does not get to bypass it for deletes.

import { rm } from "fs/promises";
import { relative } from "path";
import type { VapiResource } from "./canonical.ts";
import { BASE_DIR, matchesIgnore, VAPI_ENV } from "./config.ts";
import { deleteBaseline } from "./hash-store.ts";
import { FOLDER_MAP, listLocalResourceFiles } from "./resources.ts";
import type { ResourceState, ResourceType } from "./types.ts";

export type StaleDisposition =
  // Exactly one tracked file on disk — eligible for deletion once the
  // platform 404 confirms the resource is really gone.
  | "prunable"
  // State entry with no local file. Already existence-scenario C; there is
  // nothing to delete, only a dangling baseline to clean up.
  | "no-file"
  // `.vapi-ignore` protects it. Retained whatever `--force` says.
  | "ignored"
  // Duplicate-extension twins (`foo.yml` + `foo.yaml`). Deleting both would
  // silently discard a file the operator never reconciled; deleting one would
  // be a coin flip. Refuse and report.
  | "ambiguous";

export interface StaleTrackedResource {
  resourceType: ResourceType;
  resourceId: string;
  uuid: string;
  disposition: StaleDisposition;
  /** Resolved local file(s) for this slug. Empty for `no-file`. */
  filePaths: string[];
  /** The `.vapi-ignore` pattern that matched, for `ignored`. */
  ignorePattern?: string;
}

// Facts (1)–(3) from the header. The two disk/ignore lookups are injectable
// (same convention as `audit`'s `remoteFetcher`) so the safety rules can be
// unit-tested in-process without materializing a resource tree.
export function classifyStaleTrackedResources(options: {
  resourceType: ResourceType;
  previousSection: Record<string, ResourceState>;
  newSection: Record<string, ResourceState>;
  liveUuids: Set<string>;
  resolveFiles?: (type: ResourceType, resourceId: string) => string[];
  ignoreMatcher?: (folderPath: string, resourceId: string) => string | null;
}): StaleTrackedResource[] {
  const {
    resourceType,
    previousSection,
    newSection,
    liveUuids,
    resolveFiles = listLocalResourceFiles,
    ignoreMatcher = matchesIgnore,
  } = options;
  const folderPath = FOLDER_MAP[resourceType];
  const stale: StaleTrackedResource[] = [];

  for (const [resourceId, entry] of Object.entries(previousSection)) {
    // (2) the slug survived this pull — a recreated or adopted resource owns
    // it now, so the file on disk is current, not stale.
    if (newSection[resourceId]) continue;
    // (3) the UUID is still on the dashboard under some other slug. The extra
    // mapping is stale; the resource is not. Leave the file to `audit`.
    if (liveUuids.has(entry.uuid)) continue;

    const ignorePattern = ignoreMatcher(folderPath, resourceId);
    const filePaths = resolveFiles(resourceType, resourceId);

    let disposition: StaleDisposition;
    if (ignorePattern) disposition = "ignored";
    else if (filePaths.length === 0) disposition = "no-file";
    else if (filePaths.length > 1) disposition = "ambiguous";
    else disposition = "prunable";

    stale.push({
      resourceType,
      resourceId,
      uuid: entry.uuid,
      disposition,
      filePaths,
      ...(ignorePattern ? { ignorePattern } : {}),
    });
  }

  return stale;
}

export interface PruneResult {
  /** Local files actually removed. */
  deleted: StaleTrackedResource[];
  /** Candidates left on disk, with the reason. */
  retained: Array<{ resource: StaleTrackedResource; reason: string }>;
}

// Fact (4) plus the deletion itself. `fetchById` is injected so tests can
// drive the 404 / error branches without HTTP; production passes
// `fetchResourceById`, which returns `null` on 404 and throws on anything
// else.
export async function pruneStaleTrackedResources(options: {
  stale: StaleTrackedResource[];
  fetchById: (
    resourceType: ResourceType,
    uuid: string,
  ) => Promise<VapiResource | null>;
  log?: (message: string) => void;
}): Promise<PruneResult> {
  const { stale, fetchById, log = console.log } = options;
  const result: PruneResult = { deleted: [], retained: [] };

  for (const candidate of stale) {
    const { resourceId, uuid, disposition } = candidate;

    if (disposition === "ignored") {
      log(
        `   🚫 ${resourceId} retained locally — protected by .vapi-ignore (${candidate.ignorePattern})`,
      );
      result.retained.push({ resource: candidate, reason: "ignored" });
      continue;
    }

    if (disposition === "ambiguous") {
      const names = candidate.filePaths
        .map((p) => relative(BASE_DIR, p))
        .join(", ");
      log(
        `   ⚠️  ${resourceId} retained — multiple files for one slug (${names}); reconcile by hand before pruning`,
      );
      result.retained.push({ resource: candidate, reason: "ambiguous" });
      continue;
    }

    if (disposition === "prunable" && candidate.filePaths.length !== 1) {
      log(
        `   ⚠️  ${resourceId} retained — invalid local file inventory for pruning`,
      );
      result.retained.push({
        resource: candidate,
        reason: "invalid-file-inventory",
      });
      continue;
    }

    // Prove it. A stale state key plus an absent listing entry is suggestive;
    // only an explicit 404 authorizes deletion.
    let confirmedGone: boolean;
    try {
      confirmedGone = (await fetchById(candidate.resourceType, uuid)) === null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `   ⚠️  ${resourceId} retained — could not confirm deletion on the platform (${message})`,
      );
      result.retained.push({ resource: candidate, reason: "unconfirmed" });
      continue;
    }

    if (!confirmedGone) {
      // The listing omitted it but a direct GET found it: a truncated or
      // filtered list response. Exactly the case that would have made
      // list-diff pruning destructive.
      log(
        `   ⚠️  ${resourceId} retained — absent from the listing but still returned by GET (listing may be incomplete)`,
      );
      result.retained.push({ resource: candidate, reason: "still-exists" });
      continue;
    }

    // The baseline is keyed by UUID and is now garbage either way: a later
    // recreation or adoption of this slug must not inherit it.
    await deleteBaseline(VAPI_ENV, uuid);

    if (disposition === "no-file") {
      // Nothing on disk — the state entry has already dropped out of the
      // rewritten section. Silent: this is scenario C reaching its natural
      // end, not a deletion the operator needs to review.
      continue;
    }

    const [filePath] = candidate.filePaths;
    if (!filePath) continue;
    await rm(filePath, { force: true });
    log(
      `   🗑️  ${resourceId} — deleted on the dashboard, removed ${relative(BASE_DIR, filePath)}`,
    );
    result.deleted.push(candidate);
  }

  return result;
}

// Plain-pull reporting. No network call: the warning is advisory, and a
// listing-based hint is enough to stop the operator from losing track of a
// file the way the Riley orphan was lost. Deliberately worded as "listing"
// rather than "deleted" because plain pull never confirms with a GET.
export function warnStaleTrackedResources(options: {
  stale: StaleTrackedResource[];
  log?: (message: string) => void;
}): number {
  const { stale, log = console.log } = options;
  let retained = 0;

  for (const candidate of stale) {
    if (candidate.disposition === "no-file") continue;
    if (candidate.disposition === "ignored") continue;
    retained += candidate.filePaths.length;
    log(
      `   ⚠️  ${candidate.resourceId} is no longer in the dashboard listing — local file retained (plain pull never deletes).`,
    );
  }

  return retained;
}
