// ─────────────────────────────────────────────────────────────────────────────
// Canonical content basis for resources.
//
// A platform resource (UUID references, credential UUIDs, prompt inline) and a
// local file (resourceId references, credential names, prompt in the md body)
// are two encodings of the SAME logical content. Drift detection only works if
// every site hashes them in ONE shared basis. That basis is defined here.
//
// This module is deliberately dependency-light (credentials + types only) so
// that pull.ts, push.ts, audit.ts, AND drift.ts can all import it without the
// import cycle that previously trapped this logic inside pull.ts (pull imports
// drift, so drift could not import back — it grew a divergent copy instead).
// ─────────────────────────────────────────────────────────────────────────────

import { replaceCredentialRefs } from "./credentials.ts";
import type { ResourceType, StateFile } from "./types.ts";

export interface VapiResource {
  id: string;
  name?: string;
  [key: string]: unknown;
}

// Fields to remove before hashing/writing (server-managed or computed).
// Single source of truth — drift's old private `SERVER_FIELDS` was an exact
// duplicate of this and drifted out of sync risk-free only by luck.
export const EXCLUDED_FIELDS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
  // Computed/derived fields that shouldn't be synced back
  "isServerUrlSecretSet", // Computed: indicates if server URL secret is set
  "workflowIds", // Server-managed: workflows are a separate resource type
];

export function cleanResource(resource: VapiResource): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  // Preserve `null` values: the API uses `null` to represent an intentionally
  // cleared field (e.g. `voicemailMessage: null`), which is semantically
  // different from an absent field. Stripping it on pull would cause the next
  // push to drop the clear and re-apply any prior value still on the server.
  for (const [key, value] of Object.entries(resource)) {
    if (!EXCLUDED_FIELDS.includes(key) && value !== undefined) {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

// uuid -> resourceId, for a single resource type's state section.
export function buildReverseMap(
  state: StateFile,
  resourceType: ResourceType,
): Map<string, string> {
  const map = new Map<string, string>();
  const stateSection = state[resourceType];

  for (const [resourceId, entry] of Object.entries(stateSection)) {
    map.set(entry.uuid, resourceId);
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Resolution (UUID -> resourceId)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveReferencesToResourceIds(
  resource: Record<string, unknown>,
  state: StateFile,
): Record<string, unknown> {
  const toolsMap = buildReverseMap(state, "tools");
  const assistantsMap = buildReverseMap(state, "assistants");
  const structuredOutputsMap = buildReverseMap(state, "structuredOutputs");
  const personalitiesMap = buildReverseMap(state, "personalities");
  const scenariosMap = buildReverseMap(state, "scenarios");
  const simulationsMap = buildReverseMap(state, "simulations");

  const resolved = { ...resource };

  // Resolve toolIds in model
  if (resolved.model && typeof resolved.model === "object") {
    const model = { ...(resolved.model as Record<string, unknown>) };
    if (Array.isArray(model.toolIds)) {
      model.toolIds = model.toolIds.map(
        (uuid: string) => toolsMap.get(uuid) ?? uuid,
      );
    }
    resolved.model = model;
  }

  // Resolve structuredOutputIds in artifactPlan
  if (resolved.artifactPlan && typeof resolved.artifactPlan === "object") {
    const artifactPlan = {
      ...(resolved.artifactPlan as Record<string, unknown>),
    };
    if (Array.isArray(artifactPlan.structuredOutputIds)) {
      artifactPlan.structuredOutputIds = artifactPlan.structuredOutputIds.map(
        (uuid: string) => structuredOutputsMap.get(uuid) ?? uuid,
      );
    }
    resolved.artifactPlan = artifactPlan;
  }

  // Resolve assistantIds in structured outputs (API returns camelCase)
  if (Array.isArray(resolved.assistantIds)) {
    resolved.assistant_ids = (resolved.assistantIds as string[]).map(
      (uuid: string) => assistantsMap.get(uuid) ?? uuid,
    );
    delete resolved.assistantIds;
  }

  // Resolve assistantId in tool destinations (handoff tools)
  if (Array.isArray(resolved.destinations)) {
    resolved.destinations = (
      resolved.destinations as Record<string, unknown>[]
    ).map((dest) => {
      if (typeof dest.assistantId === "string") {
        return {
          ...dest,
          assistantId: assistantsMap.get(dest.assistantId) ?? dest.assistantId,
        };
      }
      return dest;
    });
  }

  // Resolve members[].assistantId in squads
  if (Array.isArray(resolved.members)) {
    resolved.members = (resolved.members as Record<string, unknown>[]).map(
      (member) => {
        const resolvedMember = { ...member };
        if (typeof member.assistantId === "string") {
          resolvedMember.assistantId =
            assistantsMap.get(member.assistantId) ?? member.assistantId;
        }
        // Resolve assistantDestinations[].assistantId
        if (Array.isArray(member.assistantDestinations)) {
          resolvedMember.assistantDestinations = (
            member.assistantDestinations as Record<string, unknown>[]
          ).map((dest) => {
            if (typeof dest.assistantId === "string") {
              return {
                ...dest,
                assistantId:
                  assistantsMap.get(dest.assistantId) ?? dest.assistantId,
              };
            }
            return dest;
          });
        }
        return resolvedMember;
      },
    );
  }

  // Resolve personalityId in simulations
  if (typeof resolved.personalityId === "string") {
    resolved.personalityId =
      personalitiesMap.get(resolved.personalityId) ?? resolved.personalityId;
  }

  // Resolve scenarioId in simulations
  if (typeof resolved.scenarioId === "string") {
    resolved.scenarioId =
      scenariosMap.get(resolved.scenarioId) ?? resolved.scenarioId;
  }

  // Resolve simulationIds in simulation suites
  if (Array.isArray(resolved.simulationIds)) {
    resolved.simulationIds = (resolved.simulationIds as string[]).map(
      (uuid: string) => simulationsMap.get(uuid) ?? uuid,
    );
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization for content-hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for the canonical hash basis of a platform resource.
 *
 * Encodes the full pipeline: `cleanResource → resolveReferencesToResourceIds
 * → replaceCredentialRefs → _platformDefault marker injection`.
 *
 * ALL hash sites MUST use this helper — pull-write fallback, the pull
 * classifier, the audit (audit.ts/checkContentDrift), and the push drift check
 * (drift.ts). Any divergence (a missing step, a different mutation order) makes
 * the recomputed `platformHash` disagree with the stored `lastPulledHash` from
 * a prior pull, producing permanent phantom `both-diverged` reports that only
 * `--overwrite` can clear.
 *
 * Note: this is the *pre-write* canonical form (in-memory). At write sites,
 * `lastPulledHash` should still be sourced from `hashLocalResource(...)` after
 * the file is on disk, because YAML round-trip / MD frontmatter serialization
 * is not guaranteed to be identity-preserving. This helper is the correct
 * fallback when no file write happened (bootstrap mode) or when reading a
 * platform payload for classifier/audit/drift purposes.
 */
export function canonicalizeForHash(
  resource: VapiResource,
  state: StateFile,
  credReverse: Map<string, string>,
): Record<string, unknown> {
  const cleaned = cleanResource(resource);
  const resolved = resolveReferencesToResourceIds(cleaned, state);
  const withCredNames = replaceCredentialRefs(resolved, credReverse);
  const isPlatformDefault =
    resource.orgId === null || resource.orgId === undefined;
  if (isPlatformDefault) {
    withCredNames._platformDefault = true;
  }
  return withCredNames;
}
