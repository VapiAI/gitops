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

import { VAPI_BASE_URL, VAPI_TOKEN } from "./config.ts";
import { hashPayload } from "./state-serialize.ts";
import type { ResourceState } from "./types.ts";

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
  const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${VAPI_TOKEN}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drift GET ${endpoint} → ${response.status}: ${text}`);
  }
  return response.json();
}

// Strip server-managed fields before hashing so the platform's payload hash
// matches the last-pulled-hash basis (which excluded them via cleanResource).
const SERVER_FIELDS = new Set([
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
  "isServerUrlSecretSet",
  "workflowIds",
]);

function stripServerFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!SERVER_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export async function checkDriftForUpdate(options: {
  endpoint: string; // e.g. "/assistant/<uuid>"
  resourceLabel: string; // for log lines
  resourceId: string; // local resource id
  state: ResourceState;
  overwrite: boolean;
  localHash?: string;
}): Promise<DriftCheckResult> {
  const { endpoint, resourceLabel, resourceId, state, overwrite, localHash } =
    options;

  if (!state.lastPulledHash) {
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

  const platformHash = hashPayload(stripServerFields(remote));
  if (platformHash === state.lastPulledHash) {
    return { ok: true, reason: "match", platformHash };
  }

  const effectiveLocalHash = localHash ?? state.lastPulledHash ?? platformHash;
  const direction = classifyDrift({
    localHash: effectiveLocalHash,
    lastPulledHash: state.lastPulledHash,
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
      `(${state.lastPulledHash.slice(0, 8)}...). ` +
      `${formatDriftLabel(direction)} ` +
      `Re-run pull, resolve locally, or push with --overwrite to take ownership.`,
  };
}

// Re-export the pure helper from state-serialize so call sites can import
// from drift.ts but tests can import the pure version directly.
export { checkPronunciationDictDrop } from "./state-serialize.ts";
