// ─────────────────────────────────────────────────────────────────────────────
// Drift detection
//
// Before each PATCH, GET the current platform payload, hash it, and compare
// to the `lastPulledHash` recorded in state. If the hashes differ, the
// dashboard has drifted away from the version we last pulled — refuse to
// push without `--overwrite`.
//
// Behavior matrix:
//   - No `lastPulledHash` (e.g., legacy state, first push after schema
//     migration): log "drift unknown — proceeding" and continue. Don't block.
//   - Hashes match:           continue silently.
//   - Hashes differ + no --overwrite: refuse the push, return false.
//   - Hashes differ + --overwrite:    log "overwriting drift" and continue.
//
// The check fires GET against the same endpoint the apply function would
// PATCH. We don't centralize it inside `vapiRequest` because POST (create)
// has nothing to compare against — only PATCH (update) is drift-sensitive.
// ─────────────────────────────────────────────────────────────────────────────

import { VapiApiError, vapiGet } from "./api.ts";
import {
  canonicalizeForHash,
  isVersionedResource,
  type VapiResource,
} from "./canonical.ts";
import { credentialReverseMap } from "./credentials.ts";
import { readBaseline } from "./hash-store.ts";
import {
  type LocalResourceContent,
  localResourceContent,
  readLocalResourceContent,
} from "./resources.ts";
import { hashPayload } from "./state-serialize.ts";
import type { ResourceType, StateFile } from "./types.ts";

export type DriftDirection =
  | "clean"
  | "dashboard-ahead"
  | "local-ahead"
  | "both-diverged"
  | "no-baseline";

export interface ClassifyDriftInput {
  localHash: string;
  lastPulledHash?: string;
  platformHash: string;
}

export function classifyDrift(input: ClassifyDriftInput): DriftDirection {
  const { localHash, lastPulledHash, platformHash } = input;
  if (!lastPulledHash) return "no-baseline";
  // INVARIANT: live local + platform agreement is NEVER drift, whatever the
  // (possibly stale) baseline says. A stale baseline happens legitimately —
  // e.g. a push made the dashboard match local while the baseline still held
  // the previous pull's hash. Callers treat `clean` as "refresh the baseline
  // and move on", which self-heals the stale pointer.
  if (localHash === platformHash) return "clean";
  const localMatches = localHash === lastPulledHash;
  const platformMatches = platformHash === lastPulledHash;
  if (localMatches && platformMatches) return "clean";
  if (localMatches && !platformMatches) return "dashboard-ahead";
  if (!localMatches && platformMatches) return "local-ahead";
  return "both-diverged";
}

export function compareResourceDrift({
  local,
  remote,
  state,
  credReverse,
  resourceType,
  baseline,
}: {
  local: LocalResourceContent | null;
  remote: VapiResource;
  state: StateFile;
  credReverse: Map<string, string>;
  resourceType: ResourceType;
  baseline?: string;
}): { localHash: string; platformHash: string; direction: DriftDirection } {
  const platform = canonicalizeForHash(
    remote,
    state,
    credReverse,
    resourceType,
  );
  const platformHash = hashPayload(platform);
  let lastPulledHash = baseline;
  if (
    baseline &&
    platformHash !== baseline &&
    local?.hash !== baseline &&
    local?.hash !== platformHash &&
    isVersionedResource(resourceType)
  ) {
    for (const latestVersion of new Set([
      local?.latestVersion,
      remote.latestVersion,
    ])) {
      if (
        latestVersion !== null &&
        typeof latestVersion !== "string" &&
        typeof latestVersion !== "number"
      )
        continue;
      if (hashPayload({ ...platform, latestVersion }) === baseline) {
        lastPulledHash = platformHash;
        break;
      }
      if (
        local &&
        hashPayload({ ...local.config, latestVersion }) === baseline
      ) {
        lastPulledHash = local.hash;
        break;
      }
    }
  }
  const localHash = local?.hash ?? lastPulledHash ?? "";
  return {
    localHash,
    platformHash,
    direction: classifyDrift({
      localHash,
      lastPulledHash,
      platformHash,
    }),
  };
}

export function formatDriftLabel(direction: DriftDirection): string {
  switch (direction) {
    case "dashboard-ahead":
      return "[dashboard-ahead — dashboard changed, local unchanged; run npm run pull to sync it down]";
    case "local-ahead":
      return "[local-ahead — run npm run push to propagate local edits up]";
    case "both-diverged":
      return "[both-diverged — 3-way conflict, pass --resolve=ours|theirs|fail]";
    case "no-baseline":
      return "[direction unknown — no lastPulledHash baseline; pull --bootstrap first]";
    case "clean":
      return "[no drift]";
  }
}

export interface DriftCheckResult {
  ok: boolean;
  reason: "no-baseline" | "match" | "drift-overwritten" | "drift-blocked";
  message?: string;
  // Hash of the *current* platform payload in the canonical baseline basis.
  platformHash?: string;
  // The raw platform payload fetched for the check. Returned so the caller
  // can reuse it (e.g. for the pre-push rollback snapshot) instead of firing
  // a second GET against the same endpoint. Undefined when the check
  // short-circuited before fetching (no baseline) or the resource 404'd.
  platformPayload?: unknown;
}

async function fetchPlatformPayload(endpoint: string): Promise<unknown | null> {
  // GET against the same path the PATCH would target. 404 means the resource
  // was deleted on the dashboard — let the upsert path handle it (the existing
  // 404 → "stale mapping, drop and skip" recovery in
  // upsertResourceWithStateRecovery covers this case).
  try {
    return await vapiGet(endpoint);
  } catch (error) {
    if (error instanceof VapiApiError && error.statusCode === 404) return null;
    throw error;
  }
}

export async function checkDriftForUpdate(options: {
  endpoint: string; // e.g. "/assistant/<uuid>"
  resourceLabel: string; // for log lines
  resourceType: ResourceType;
  resourceId: string; // local resource id
  state: StateFile;
  loadedTypeScriptData?: Record<string, unknown>;
  env: string; // org slug — keys the hash store
  overwrite: boolean;
}): Promise<DriftCheckResult> {
  const {
    endpoint,
    resourceLabel,
    resourceType,
    resourceId,
    state,
    env,
    overwrite,
  } = options;

  // The drift baseline ("last platform state I saw") lives in the hash store,
  // keyed by the resource's UUID, not in the state file anymore.
  const entry = state[resourceType]?.[resourceId];
  const baseline = entry ? readBaseline(env, entry.uuid) : undefined;
  if (!baseline) {
    return {
      ok: true,
      reason: "no-baseline",
      message:
        `   ⚠️  drift check skipped for ${resourceLabel} ${resourceId}: ` +
        `no baseline on this machine. Run \`npm run pull\` to establish one.`,
    };
  }

  const remote = await fetchPlatformPayload(endpoint);
  if (remote === null) {
    // Resource was deleted on the dashboard — defer to the upsert recovery
    // path. Drift is not the right framing here.
    return { ok: true, reason: "no-baseline" };
  }

  const { direction, platformHash } = compareResourceDrift({
    local: options.loadedTypeScriptData
      ? localResourceContent(resourceType, options.loadedTypeScriptData)
      : readLocalResourceContent(resourceType, resourceId),
    remote: remote as VapiResource,
    state,
    credReverse: credentialReverseMap(state),
    resourceType,
    baseline,
  });
  if (direction === "clean" || direction === "local-ahead") {
    return { ok: true, reason: "match", platformHash, platformPayload: remote };
  }

  const directionTag = `[${direction}]`;

  if (overwrite) {
    return {
      ok: true,
      reason: "drift-overwritten",
      platformHash,
      platformPayload: remote,
      message:
        `   ⚠️  drift on ${resourceLabel} ${resourceId} ${directionTag}: platform changed since last pull, ` +
        `overwriting (--overwrite). ${formatDriftLabel(direction)}`,
    };
  }

  return {
    ok: false,
    reason: "drift-blocked",
    platformHash,
    platformPayload: remote,
    message:
      `   ❌ drift detected on ${resourceLabel} ${resourceId} ${directionTag}: ` +
      `platform hash (${platformHash.slice(0, 8)}...) differs from baseline ` +
      `(${baseline.slice(0, 8)}...). ` +
      `${formatDriftLabel(direction)} ` +
      `Re-run pull, resolve locally, or push with --overwrite to take ownership.`,
  };
}

// Re-export the pure helper from state-serialize so call sites can import
// from drift.ts but tests can import the pure version directly.
export { checkPronunciationDictDrop } from "./state-serialize.ts";
