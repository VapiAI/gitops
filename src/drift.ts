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

import { vapiGet, VapiApiError } from "./api.ts";
import { canonicalizeForHash, type VapiResource } from "./canonical.ts";
import { credentialReverseMap } from "./credentials.ts";
import { hashLocalResource } from "./resources.ts";
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
  const localMatches = localHash === lastPulledHash;
  const platformMatches = platformHash === lastPulledHash;
  if (localMatches && platformMatches) return "clean";
  if (localMatches && !platformMatches) return "dashboard-ahead";
  if (!localMatches && platformMatches) return "local-ahead";
  return "both-diverged";
}

export function formatDriftLabel(direction: DriftDirection): string {
  switch (direction) {
    case "dashboard-ahead":
      return "[dashboard-ahead — sync down via plain pull (preserves local) or push --overwrite to take ownership]";
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
  // Hash of the *current* platform payload — caller may want to update
  // state's `lastPulledHash` after a successful push so subsequent pushes
  // start from the platform's current state, not the stale pre-overwrite hash.
  platformHash?: string;
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
  overwrite: boolean;
}): Promise<DriftCheckResult> {
  const { endpoint, resourceLabel, resourceType, resourceId, state, overwrite } =
    options;

  const entry = state[resourceType]?.[resourceId];
  if (!entry?.lastPulledHash) {
    return {
      ok: true,
      reason: "no-baseline",
      message:
        `   ⚠️  drift check skipped for ${resourceLabel} ${resourceId}: ` +
        `no lastPulledHash in state. Run \`npm run pull\` to establish a baseline.`,
    };
  }

  const remote = await fetchPlatformPayload(endpoint);
  if (remote === null) {
    // Resource was deleted on the dashboard — defer to the upsert recovery
    // path. Drift is not the right framing here.
    return { ok: true, reason: "no-baseline" };
  }

  // Hash all three points (platform, local, baseline) in ONE basis — the
  // canonical form defined in canonical.ts that pull also uses to write
  // `lastPulledHash`. Drift previously carried its own field-strip copy that
  // omitted reference/credential resolution, so any tool- or credential-bearing
  // resource hashed differently here than at pull time → phantom both-diverged.
  const credReverse = credentialReverseMap(state);
  const platformHash = hashPayload(
    canonicalizeForHash(remote as VapiResource, state, credReverse),
  );
  if (platformHash === entry.lastPulledHash) {
    return { ok: true, reason: "match", platformHash };
  }

  // On-disk hash in the same basis as `lastPulledHash`. Absent a local file
  // (rare on an update path), fall back to the baseline so the direction is
  // dashboard-ahead rather than a phantom both-diverged.
  const localHash =
    hashLocalResource(resourceType, resourceId) ?? entry.lastPulledHash;

  // Local and platform are byte-identical → there is nothing to reconcile and
  // the PATCH is a no-op. NEVER block here, even if `lastPulledHash` disagrees
  // with both (a stale or older-basis baseline must not manufacture a conflict
  // when the two LIVE sides already agree). `classifyDrift` still reports this
  // as `both-diverged` by its descriptive contract — that signals the stale
  // state pointer — but the push *gate* treats agreement between local and
  // platform as clean. This is the fix for the phantom-drift class: a freshly
  // upgraded customer repo carries baselines written in an older hash basis,
  // so every untouched resource hit `both-diverged` on its first push.
  if (localHash === platformHash) {
    return { ok: true, reason: "match", platformHash };
  }

  const direction = classifyDrift({
    localHash,
    lastPulledHash: entry.lastPulledHash,
    platformHash,
  });
  const directionTag = `[${direction}]`;

  if (overwrite) {
    return {
      ok: true,
      reason: "drift-overwritten",
      platformHash,
      message:
        `   ⚠️  drift on ${resourceLabel} ${resourceId} ${directionTag}: platform changed since last pull, ` +
        `overwriting (--overwrite). ${formatDriftLabel(direction)}`,
    };
  }

  return {
    ok: false,
    reason: "drift-blocked",
    platformHash,
    message:
      `   ❌ drift detected on ${resourceLabel} ${resourceId} ${directionTag}: ` +
      `platform hash (${platformHash.slice(0, 8)}...) differs from last-pulled ` +
      `(${entry.lastPulledHash.slice(0, 8)}...). ` +
      `${formatDriftLabel(direction)} ` +
      `Re-run pull, resolve locally, or push with --overwrite to take ownership.`,
  };
}

// Re-export the pure helper from state-serialize so call sites can import
// from drift.ts but tests can import the pure version directly.
export { checkPronunciationDictDrop } from "./state-serialize.ts";
