import { relative, resolve } from "path";
import { fileURLToPath } from "url";
import { getDryRunCounts, VapiApiError, vapiRequest } from "./api.ts";
import {
  ALLOW_NEW_FILES,
  APPLY_FILTER,
  BASE_DIR,
  BOOTSTRAP_SYNC,
  DRY_RUN,
  FORCE_DELETE,
  loadIgnorePatterns,
  OVERWRITE_DRIFT,
  removeExcludedKeys,
  STATE_FILE_PATH,
  STRICT_VALIDATION,
  VAPI_BASE_URL,
  VAPI_ENV,
} from "./config.ts";
import {
  extractResourceName,
  findExistingResourceByName,
  type RemoteResource,
} from "./dep-dedup.ts";
import { select } from "@inquirer/prompts";
import { canonicalizeForHash, type VapiResource } from "./canonical.ts";
import { checkDriftForUpdate, type DriftCheckResult } from "./drift.ts";
import { deleteBaseline, writeBaseline } from "./hash-store.ts";
import { assertStateMigrated } from "./migrate-hash-store.ts";
import { detectOrphanYamls, formatGateMessage } from "./new-file-gate.ts";
import {
  formatRecanonicalizeReport,
  recanonicalizeStateKeys,
} from "./recanonicalize.ts";
import { reconcileStateKeyForResource } from "./reconcile-state-key.ts";
import { writeSnapshot } from "./snapshot.ts";
import { mergeScoped } from "./state-merge.ts";
import {
  summarizeFindings,
  validateNoIgnoredReferences,
  validateResources,
} from "./validate.ts";

// Map a resource label to its state-file key. Used for snapshotting —
// snapshot directories are keyed by the same names the state file uses.
const RESOURCE_LABEL_TO_TYPE: Record<string, ResourceType> = {
  tool: "tools",
  "structured output": "structuredOutputs",
  assistant: "assistants",
  squad: "squads",
  personality: "personalities",
  scenario: "scenarios",
  simulation: "simulations",
  "simulation suite": "simulationSuites",
};

import {
  credentialForwardMap,
  credentialReverseMap,
  replaceCredentialRefs,
} from "./credentials.ts";
import { deleteOrphanedResources } from "./delete.ts";
import {
  fetchAllResources,
  fetchResourceById,
  runPull,
  writeDashboardBackup,
} from "./pull.ts";
import {
  extractReferencedIds,
  resolveAssistantIds,
  resolveReferences,
} from "./resolver.ts";
import {
  FOLDER_MAP,
  loadResources,
  loadSingleResource,
  pathMatchesFolder,
} from "./resources.ts";
import { hashPayload, loadState, saveState, upsertState } from "./state.ts";
import type {
  LoadedResources,
  ResourceFile,
  ResourceState,
  ResourceType,
  StateFile,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Error Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatApiError(resourceId: string, error: unknown): string {
  if (error instanceof VapiApiError) {
    return [
      `  ❌ Failed: ${resourceId}`,
      `     ${error.method} ${error.endpoint} → ${error.statusCode}`,
      `     ${error.apiMessage}`,
    ].join("\n");
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `  ❌ Failed: ${resourceId}\n     ${msg}`;
}

// A drift conflict is only ever resolved per resource, at the moment the push
// is about to touch it — never via an umbrella flag answered up front. The
// prompt fires only in a real terminal; CI/piped runs keep the hard block
// (or --overwrite) semantics.
function isInteractiveSession(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

type DriftResolutionChoice = "push-local" | "keep-dashboard" | "dashboard-copy";

async function promptDriftResolution(
  resourceLabel: string,
  resourceId: string,
): Promise<DriftResolutionChoice> {
  console.log(
    `\n   ⚠️  ${resourceLabel} "${resourceId}": the dashboard version changed since your last pull/push — someone else published changes.`,
  );
  return select<DriftResolutionChoice>({
    message: `Conflict on ${resourceLabel} "${resourceId}" — what do you want to do?`,
    choices: [
      {
        name: "Push my local version (overwrite the dashboard change)",
        value: "push-local",
      },
      {
        name: "Keep the dashboard version (skip pushing this resource)",
        value: "keep-dashboard",
      },
      {
        name: "Save a dashboard copy beside my file for manual merge (skip push)",
        value: "dashboard-copy",
      },
    ],
  });
}

// Refresh the per-resource drift baseline from an API response — the full
// resource as the platform stored it after our POST/PATCH. Hashed in the same
// canonical basis pull and drift use, so the very next push of a further local
// edit compares clean ("my change is the natural next step") without a pull in
// between. Skipped in dry-run (the response is synthetic). Failures are logged
// but never block the push — the baseline is a drift hint, not a precondition.
async function writeBaselineFromResponse(
  uuid: string,
  response: unknown,
  state: StateFile,
): Promise<void> {
  if (DRY_RUN) return;
  if (!response || typeof response !== "object") return;
  try {
    const credReverse = credentialReverseMap(state);
    const hash = hashPayload(
      canonicalizeForHash(response as VapiResource, state, credReverse),
    );
    await writeBaseline(VAPI_ENV, uuid, hash);
  } catch (err) {
    console.warn(
      `   ⚠️  failed to update drift baseline for ${uuid}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function upsertResourceWithStateRecovery(options: {
  resourceLabel: string;
  resourceId: string;
  existingUuid?: string;
  stateSection: Record<string, ResourceState>;
  updateEndpoint: string;
  updatePayload: Record<string, unknown>;
  createEndpoint: string;
  createPayload: Record<string, unknown>;
  // Full state file — needed so drift detection can canonicalize the platform
  // payload into the same basis as `lastPulledHash` (resolves UUID refs back
  // to resourceId slugs + credential names). Without it the drift check
  // compares incompatible hash bases and phantom-reports `both-diverged` on
  // every resource that references a tool, credential, or has a prompt.
  fullState: StateFile;
}): Promise<string | null> {
  const {
    resourceLabel,
    resourceId,
    existingUuid,
    stateSection,
    updateEndpoint,
    updatePayload,
    createEndpoint,
    createPayload,
    fullState,
  } = options;

  if (!existingUuid) {
    console.log(`  ✨ Creating ${resourceLabel}: ${resourceId}`);
    const result = await vapiRequest("POST", createEndpoint, createPayload);
    await writeBaselineFromResponse(result.id, result, fullState);
    return result.id;
  }

  console.log(
    `  🔄 Updating ${resourceLabel}: ${resourceId} (${existingUuid})`,
  );

  // Drift detection. Before PATCH, GET the current platform payload, hash
  // it, and compare to lastPulledHash. Refuse to overwrite without
  // --overwrite. Skipped in dry-run because the operator just wants to see
  // what would happen, and skipped if no baseline hash.
  // When we successfully fetch the platform payload, snapshot it (and our
  // outgoing payload) so `npm run rollback` has a target.
  if (!DRY_RUN) {
    const stateEntry = stateSection[resourceId];
    if (stateEntry) {
      const driftResourceType = RESOURCE_LABEL_TO_TYPE[resourceLabel];
      // Platform payload fetched by the drift check, reused for the rollback
      // snapshot below so we don't fire a second GET at the same endpoint.
      let platformPayloadForSnapshot: unknown;
      // The drift check now owns the full hash computation (platform, local,
      // and baseline all canonicalized via canonical.ts). Push just hands it
      // the full state + resource type — no hash plumbing at the call site.
      if (driftResourceType) {
        let drift: DriftCheckResult | undefined;
        try {
          drift = await checkDriftForUpdate({
            endpoint: updateEndpoint,
            resourceLabel,
            resourceType: driftResourceType,
            resourceId,
            state: fullState,
            env: VAPI_ENV,
            overwrite: OVERWRITE_DRIFT,
          });
        } catch (driftErr) {
          // A drift check failure should NOT block the push — the existing
          // PATCH path will surface the real error. Log and move on.
          console.warn(
            `   ⚠️  drift check failed for ${resourceLabel} ${resourceId}: ` +
              (driftErr instanceof Error
                ? driftErr.message
                : String(driftErr)) +
              ". Continuing.",
          );
        }

        if (drift) {
          platformPayloadForSnapshot = drift.platformPayload;

          if (drift.ok) {
            // Baseline matches the dashboard (or --overwrite / no baseline):
            // the local edit is the natural next step — push silently.
            if (drift.message) console.log(drift.message);
          } else if (!isInteractiveSession()) {
            // CI / piped run: keep the hard block-or---overwrite behavior.
            if (drift.message) console.error(drift.message);
            return null;
          } else {
            // Real terminal: per-resource 3-way resolution. Deliberately
            // OUTSIDE the try/catch above — Ctrl+C in the prompt must abort
            // the push, not be swallowed as "drift check failed, continuing".
            const choice = await promptDriftResolution(
              resourceLabel,
              resourceId,
            );
            if (choice === "keep-dashboard") {
              console.log(
                `   ⏭️  ${resourceId}: keeping dashboard version — push skipped, local file untouched.`,
              );
              return null;
            }
            if (choice === "dashboard-copy") {
              const copyPath = await writeDashboardBackup(
                driftResourceType,
                resourceId,
                drift.platformPayload as VapiResource,
                fullState,
              );
              console.log(
                `   📄 ${resourceId}: dashboard version saved to ${relative(BASE_DIR, copyPath)} — merge manually, then push again. Push skipped.`,
              );
              return null;
            }
            console.log(
              `   ⬆️  ${resourceId}: pushing local version (taking ownership of the conflict).`,
            );
          }
        }
      }

      // Snapshot the current platform payload + our outgoing payload to a
      // per-push directory so rollback can revert. Reuses the drift check's
      // GET when available; falls back to its own fetch when the check
      // short-circuited (no baseline) or failed.
      try {
        const resourceType = RESOURCE_LABEL_TO_TYPE[resourceLabel];
        if (resourceType) {
          if (platformPayloadForSnapshot === undefined) {
            const platformResponse = await fetch(
              `${VAPI_BASE_URL}${updateEndpoint}`,
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${process.env.VAPI_TOKEN}`,
                },
              },
            );
            if (platformResponse.ok) {
              platformPayloadForSnapshot = await platformResponse.json();
            }
          }
          if (platformPayloadForSnapshot !== undefined) {
            await writeSnapshot({
              baseDir: BASE_DIR,
              env: VAPI_ENV,
              resourceType,
              resourceId,
              payload: {
                outgoing: updatePayload,
                platform: platformPayloadForSnapshot,
              },
            });
          }
        }
      } catch (snapshotErr) {
        // Snapshot failures should NOT block the push — the snapshot is a
        // safety net, not a precondition. Log and move on.
        console.warn(
          `   ⚠️  snapshot failed for ${resourceLabel} ${resourceId}: ` +
            (snapshotErr instanceof Error
              ? snapshotErr.message
              : String(snapshotErr)),
        );
      }
    }
  }

  try {
    const result = await vapiRequest("PATCH", updateEndpoint, updatePayload);
    // The PATCH response is the full resource as the platform now stores it —
    // the freshest possible "last known platform state." Hash it as the new
    // drift baseline so the next push of a further local edit is clean.
    await writeBaselineFromResponse(existingUuid, result, fullState);
    return existingUuid;
  } catch (error) {
    if (!(error instanceof VapiApiError) || error.statusCode !== 404) {
      throw error;
    }

    console.warn(
      `  ⚠️  State entry for ${resourceLabel} "${resourceId}" points to missing remote ID ${existingUuid}. Removing the stale mapping from state and skipping this resource for the current run.`,
    );
    delete stateSection[resourceId];
    await deleteBaseline(VAPI_ENV, existingUuid);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential Validation — warn about unresolved credential names
// ─────────────────────────────────────────────────────────────────────────────

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Must stay in sync with `VALID_RESOURCE_TYPES` in `src/types.ts`. Used by
// `hasAnyLoadedResources`, `getTargetedResourceTypes`, and the credential /
// state-sanity checks — dropping a type here silently disables those
// pre-flight checks for that type.
const ALL_RESOURCE_TYPES: ResourceType[] = [
  "tools",
  "structuredOutputs",
  "assistants",
  "squads",
  "personalities",
  "scenarios",
  "simulations",
  "simulationSuites",
  "evals",
];

function warnUnresolvedCredentials(
  resourceId: string,
  data: Record<string, unknown>,
): void {
  walkForCredentials(resourceId, data);
}

function collectCredentialNames(
  obj: unknown,
  names: Set<string> = new Set(),
): Set<string> {
  if (obj === null || obj === undefined || typeof obj !== "object")
    return names;
  if (Array.isArray(obj)) {
    for (const item of obj) collectCredentialNames(item, names);
    return names;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (
      key === "credentialId" &&
      typeof value === "string" &&
      !UUID_REGEX.test(value)
    ) {
      names.add(value);
    }
    collectCredentialNames(value, names);
  }
  return names;
}

function hasAnyLoadedResources(resources: LoadedResources): boolean {
  return ALL_RESOURCE_TYPES.some((type) => resources[type].length > 0);
}

function getTargetedResourceTypes(resources: LoadedResources): ResourceType[] {
  return ALL_RESOURCE_TYPES.filter((type) => resources[type].length > 0);
}

function getMissingCredentialNames(
  resources: LoadedResources,
  state: StateFile,
): string[] {
  const credentialMap = credentialForwardMap(state);
  const names = new Set<string>();
  for (const type of ALL_RESOURCE_TYPES) {
    for (const resource of resources[type]) {
      collectCredentialNames(resource.data, names);
    }
  }
  return [...names].filter((name) => !credentialMap.has(name));
}

async function getInvalidStateMappings(
  resources: LoadedResources,
  state: StateFile,
): Promise<
  Array<{
    type: ResourceType;
    resourceId: string;
    uuid: string;
    reason: "missing_remote";
  }>
> {
  const invalidMappings: Array<{
    type: ResourceType;
    resourceId: string;
    uuid: string;
    reason: "missing_remote";
  }> = [];

  for (const type of getTargetedResourceTypes(resources)) {
    const trackedResources = resources[type]
      .map((resource) => ({
        resourceId: resource.resourceId,
        uuid: state[type][resource.resourceId]?.uuid,
      }))
      .filter(
        (
          entry,
        ): entry is {
          resourceId: string;
          uuid: string;
        } => typeof entry.uuid === "string",
      );

    if (trackedResources.length === 0) {
      continue;
    }

    let remoteResources: Awaited<ReturnType<typeof fetchAllResources>>;
    if (isPartialApply() && trackedResources.length <= 10) {
      remoteResources = [];
      for (const trackedResource of trackedResources) {
        const remoteResource = await fetchResourceById(
          type,
          trackedResource.uuid,
        );
        if (remoteResource) remoteResources.push(remoteResource);
      }
    } else {
      remoteResources = await fetchAllResources(type);
    }
    const remoteResourcesById = new Map(
      remoteResources.map((resource) => [resource.id, resource]),
    );

    for (const trackedResource of trackedResources) {
      const remoteResource = remoteResourcesById.get(trackedResource.uuid);
      // Only `missing_remote` is genuinely stale state. A dashboard rename
      // (remote `name` no longer matches the local filename slug) is NOT a
      // problem — the filename is a stable local handle, decoupled from the
      // dashboard name. Flagging renames here used to force a bootstrap that
      // re-keyed state to a name-derived slug, orphaning the local file and
      // creating a duplicate on the next push.
      if (!remoteResource) {
        invalidMappings.push({
          type,
          ...trackedResource,
          reason: "missing_remote",
        });
      }
    }
  }

  return invalidMappings;
}

async function maybeBootstrapState(
  resources: LoadedResources,
  state: StateFile,
): Promise<StateFile> {
  const scopedResources = scopeLoadedResourcesForApply(resources);

  if (!hasAnyLoadedResources(scopedResources)) {
    return state;
  }

  const targetedTypes = getTargetedResourceTypes(scopedResources);
  const missingCredentialNames = getMissingCredentialNames(
    scopedResources,
    state,
  );
  const stateUninitialized =
    Object.keys(state.credentials).length === 0 ||
    targetedTypes.every((type) => Object.keys(state[type]).length === 0);
  const invalidMappings = await getInvalidStateMappings(scopedResources, state);

  if (
    !stateUninitialized &&
    missingCredentialNames.length === 0 &&
    invalidMappings.length === 0
  ) {
    return state;
  }

  console.log("\n🧭 Bootstrap state sync required before apply.");
  if (stateUninitialized) {
    console.log(
      "   - Local state is uninitialized for this environment or target resource set.",
    );
  }
  if (missingCredentialNames.length > 0) {
    console.log(
      `   - Missing credential mappings: ${missingCredentialNames.join(", ")}`,
    );
  }
  for (const mapping of invalidMappings) {
    console.log(
      `   - Invalid ${mapping.type} mapping (${mapping.reason}): ${mapping.resourceId} -> ${mapping.uuid}`,
    );
  }

  const result = await runPull({ bootstrap: true, typeFilter: [] });
  return result.state;
}

// Recursively find any `credentialId` field whose value isn't a UUID
function walkForCredentials(resourceId: string, obj: unknown): void {
  if (obj === null || obj === undefined || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkForCredentials(resourceId, item);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (
      key === "credentialId" &&
      typeof value === "string" &&
      !UUID_REGEX.test(value)
    ) {
      console.warn(
        `  ⚠️  Unresolved credential in ${resourceId}: credentialId="${value}" — run pull to populate credentials in state`,
      );
    }
    if (typeof value === "object") walkForCredentials(resourceId, value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Apply Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function applyTool(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.tools[resourceId]?.uuid;

  // Resolve references (but assistants may not exist yet on first pass)
  const payload = resolveReferences(data as Record<string, unknown>, state);

  // For handoff tools with assistant destinations, strip unresolved assistantIds for initial creation
  // They will be linked after assistants are created
  const payloadForCreate = stripUnresolvedAssistantDestinations(
    payload,
    data as Record<string, unknown>,
  );

  return upsertResourceWithStateRecovery({
    resourceLabel: "tool",
    resourceId,
    existingUuid,
    stateSection: state.tools,
    fullState: state,
    updateEndpoint: `/tool/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "tools"),
    createEndpoint: "/tool",
    createPayload: payloadForCreate,
  });
}

// Strip destinations with unresolved assistantIds (where original equals resolved = not found in state)
function stripUnresolvedAssistantDestinations(
  resolved: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(resolved.destinations)) {
    return resolved;
  }

  const originalDests = original.destinations as Record<string, unknown>[];
  const resolvedDests = resolved.destinations as Record<string, unknown>[];

  // Filter out destinations where assistantId wasn't resolved (still matches original)
  const filteredDests = resolvedDests.filter((dest, idx) => {
    if (typeof dest.assistantId !== "string") return true;
    const origDest = originalDests[idx];
    if (!origDest || typeof origDest.assistantId !== "string") return true;
    // Keep if resolved (UUID format) or no original assistantId
    const originalId = (origDest.assistantId as string).split("##")[0]?.trim();
    return dest.assistantId !== originalId;
  });

  return { ...resolved, destinations: filteredDests };
}

export async function applyStructuredOutput(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.structuredOutputs[resourceId]?.uuid;

  // Resolve references to assistants (but assistants might not exist yet in first pass)
  const payload = resolveReferences(data as Record<string, unknown>, state);

  // Remove assistant references for initial creation (circular dependency)
  const { assistantIds, ...payloadWithoutAssistants } = payload;

  return upsertResourceWithStateRecovery({
    resourceLabel: "structured output",
    resourceId,
    existingUuid,
    stateSection: state.structuredOutputs,
    fullState: state,
    updateEndpoint: `/structured-output/${existingUuid}?schemaOverride=true`,
    updatePayload: removeExcludedKeys(payload, "structuredOutputs"),
    createEndpoint: "/structured-output",
    createPayload: payloadWithoutAssistants,
  });
}

export async function applyAssistant(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.assistants[resourceId]?.uuid;

  // Resolve tool and structured output references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "assistant",
    resourceId,
    existingUuid,
    stateSection: state.assistants,
    fullState: state,
    updateEndpoint: `/assistant/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "assistants"),
    createEndpoint: "/assistant",
    createPayload: payload,
  });
}

export async function applySquad(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.squads[resourceId]?.uuid;

  // Resolve assistant references in members
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "squad",
    resourceId,
    existingUuid,
    stateSection: state.squads,
    fullState: state,
    updateEndpoint: `/squad/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "squads"),
    createEndpoint: "/squad",
    createPayload: payload,
  });
}

export async function applyPersonality(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.personalities[resourceId]?.uuid;

  // Personalities contain inline assistant config, no external references to resolve
  const payload = data as Record<string, unknown>;

  return upsertResourceWithStateRecovery({
    resourceLabel: "personality",
    resourceId,
    existingUuid,
    stateSection: state.personalities,
    fullState: state,
    updateEndpoint: `/eval/simulation/personality/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "personalities"),
    createEndpoint: "/eval/simulation/personality",
    createPayload: payload,
  });
}

export async function applyScenario(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.scenarios[resourceId]?.uuid;

  // Resolve structuredOutputId references in evaluations
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "scenario",
    resourceId,
    existingUuid,
    stateSection: state.scenarios,
    fullState: state,
    updateEndpoint: `/eval/simulation/scenario/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "scenarios"),
    createEndpoint: "/eval/simulation/scenario",
    createPayload: payload,
  });
}

export async function applySimulation(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.simulations[resourceId]?.uuid;

  // Resolve personality and scenario references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "simulation",
    resourceId,
    existingUuid,
    stateSection: state.simulations,
    fullState: state,
    updateEndpoint: `/eval/simulation/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "simulations"),
    createEndpoint: "/eval/simulation",
    createPayload: payload,
  });
}

export async function applySimulationSuite(
  resource: ResourceFile,
  state: StateFile,
): Promise<string | null> {
  const { resourceId, data } = resource;
  const existingUuid = state.simulationSuites[resourceId]?.uuid;

  // Resolve simulation references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "simulation suite",
    resourceId,
    existingUuid,
    stateSection: state.simulationSuites,
    fullState: state,
    updateEndpoint: `/eval/simulation/suite/${existingUuid}`,
    updatePayload: removeExcludedKeys(payload, "simulationSuites"),
    createEndpoint: "/eval/simulation/suite",
    createPayload: payload,
  });
}

export async function applyEval(
  resource: ResourceFile,
  state: StateFile,
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.evals[resourceId]?.uuid;

  const payload = data as Record<string, unknown>;

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "evals");
    console.log(`  🔄 Updating eval: ${resourceId} (${existingUuid})`);
    const result = await vapiRequest("PATCH", `/eval/${existingUuid}`, updatePayload);
    await writeBaselineFromResponse(existingUuid, result, state);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating eval: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval", payload);
    await writeBaselineFromResponse(result.id, result, state);
    return result.id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-Apply: Update Tools with Assistant References (for handoff tools)
// ─────────────────────────────────────────────────────────────────────────────

export async function updateToolAssistantRefs(
  tools: ResourceFile[],
  state: StateFile,
): Promise<void> {
  for (const resource of tools) {
    const { resourceId, data } = resource;
    const rawData = data as Record<string, unknown>;

    // Check if this tool has destinations with assistant references
    if (!Array.isArray(rawData.destinations)) {
      continue;
    }

    const hasAssistantRefs = (
      rawData.destinations as Record<string, unknown>[]
    ).some((dest) => typeof dest.assistantId === "string");

    if (!hasAssistantRefs) continue;

    const uuid = state.tools[resourceId]?.uuid;
    if (!uuid) continue;

    // Resolve destinations now that all assistants exist
    const resolved = resolveReferences(rawData, state);

    console.log(`  🔗 Linking tool ${resourceId} to assistant destinations`);
    const result = await vapiRequest("PATCH", `/tool/${uuid}`, {
      destinations: resolved.destinations,
    });
    // This PATCH mutates the platform AFTER the main upsert wrote its
    // baseline — refresh it from the linking response, or the next push would
    // see drift we caused ourselves.
    await writeBaselineFromResponse(uuid, result, state);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-Apply: Update Structured Outputs with Assistant References
// ─────────────────────────────────────────────────────────────────────────────

export async function updateStructuredOutputAssistantRefs(
  structuredOutputs: ResourceFile[],
  state: StateFile,
): Promise<void> {
  for (const resource of structuredOutputs) {
    const { resourceId, data } = resource;
    const rawData = data as Record<string, unknown>;

    // Check if this structured output has assistant references
    if (
      !Array.isArray(rawData.assistant_ids) ||
      rawData.assistant_ids.length === 0
    ) {
      continue;
    }

    const uuid = state.structuredOutputs[resourceId]?.uuid;
    if (!uuid) continue;

    // Resolve assistant IDs now that all assistants exist
    const assistantIds = resolveAssistantIds(
      rawData.assistant_ids as string[],
      state,
    );

    if (assistantIds.length > 0) {
      console.log(`  🔗 Linking structured output ${resourceId} to assistants`);
      const result = await vapiRequest("PATCH", `/structured-output/${uuid}`, {
        assistantIds,
      });
      // Same post-upsert mutation as the tool-linking PATCH above — refresh
      // the baseline from the response to avoid self-inflicted drift.
      await writeBaselineFromResponse(uuid, result, state);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Filtering
// ─────────────────────────────────────────────────────────────────────────────

function isPartialApply(): boolean {
  return !!(
    APPLY_FILTER.resourceTypes?.length || APPLY_FILTER.filePaths?.length
  );
}

function shouldApplyResourceType(type: ResourceType): boolean {
  if (APPLY_FILTER.filePaths?.length) {
    const folder = FOLDER_MAP[type];
    return APPLY_FILTER.filePaths.some((fp) => pathMatchesFolder(fp, folder));
  }
  if (APPLY_FILTER.resourceTypes?.length) {
    return APPLY_FILTER.resourceTypes.includes(type);
  }
  return true;
}

function filterResourcesByPaths<T>(
  resources: ResourceFile<T>[],
  type: ResourceType,
): ResourceFile<T>[] {
  if (!APPLY_FILTER.filePaths?.length) return resources;

  const matchingIds = new Set<string>();

  for (const filePath of APPLY_FILTER.filePaths) {
    const resolvedInput = resolve(BASE_DIR, filePath);

    for (const resource of resources) {
      if (
        resource.filePath === resolvedInput ||
        resource.filePath.endsWith(filePath) ||
        filePath.endsWith(resource.resourceId + ".yml") ||
        filePath.endsWith(resource.resourceId + ".yaml") ||
        filePath.endsWith(resource.resourceId + ".md") ||
        filePath.endsWith(resource.resourceId + ".ts") ||
        resource.filePath === filePath ||
        resource.resourceId === filePath.replace(/\.(yml|yaml|md|ts)$/, "")
      ) {
        matchingIds.add(resource.resourceId);
      }
    }
  }

  return resources.filter((r) => matchingIds.has(r.resourceId));
}

function scopeLoadedResourcesForApply(
  resources: LoadedResources,
): LoadedResources {
  if (!isPartialApply()) return resources;

  return {
    tools: shouldApplyResourceType("tools")
      ? filterResourcesByPaths(resources.tools, "tools")
      : [],
    structuredOutputs: shouldApplyResourceType("structuredOutputs")
      ? filterResourcesByPaths(resources.structuredOutputs, "structuredOutputs")
      : [],
    assistants: shouldApplyResourceType("assistants")
      ? filterResourcesByPaths(resources.assistants, "assistants")
      : [],
    squads: shouldApplyResourceType("squads")
      ? filterResourcesByPaths(resources.squads, "squads")
      : [],
    personalities: shouldApplyResourceType("personalities")
      ? filterResourcesByPaths(resources.personalities, "personalities")
      : [],
    scenarios: shouldApplyResourceType("scenarios")
      ? filterResourcesByPaths(resources.scenarios, "scenarios")
      : [],
    simulations: shouldApplyResourceType("simulations")
      ? filterResourcesByPaths(resources.simulations, "simulations")
      : [],
    simulationSuites: shouldApplyResourceType("simulationSuites")
      ? filterResourcesByPaths(
          resources.simulationSuites,
          "simulationSuites",
        )
      : [],
    evals: shouldApplyResourceType("evals")
      ? filterResourcesByPaths(resources.evals, "evals")
      : [],
  };
}

// Track which resourceIds were actually written during this apply. On
// scoped push, the end-of-run save merges only these entries back into
// the on-disk state, leaving untouched entries alone. Without this, a
// scoped push (`npm run push -- <env> assistants/foo.md`) would sweep
// pre-existing drift across the entire state file into the commit-able
// diff.
interface TouchedSets {
  tools: Set<string>;
  structuredOutputs: Set<string>;
  assistants: Set<string>;
  squads: Set<string>;
  personalities: Set<string>;
  scenarios: Set<string>;
  simulations: Set<string>;
  simulationSuites: Set<string>;
  evals: Set<string>;
  // refreshed on every push (bootstrap pull populates them)
  credentials: Set<string>;
}

function emptyTouchedSets(): TouchedSets {
  return {
    tools: new Set(),
    structuredOutputs: new Set(),
    assistants: new Set(),
    squads: new Set(),
    personalities: new Set(),
    scenarios: new Set(),
    simulations: new Set(),
    simulationSuites: new Set(),
    evals: new Set(),
    credentials: new Set(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Dependency Resolution
// When pushing a resource with missing dependencies, auto-apply them first
// Chain: squads → assistants → tools + structuredOutputs
// ─────────────────────────────────────────────────────────────────────────────

interface DependencyContext {
  allTools: ResourceFile<Record<string, unknown>>[];
  allStructuredOutputs: ResourceFile<Record<string, unknown>>[];
  allAssistants: ResourceFile<Record<string, unknown>>[];
  state: StateFile;
  applied: Record<ResourceType, number>;
  autoApplied: Set<string>;
  autoAppliedTools: ResourceFile<Record<string, unknown>>[];
  autoAppliedStructuredOutputs: ResourceFile<Record<string, unknown>>[];
  // Lazy-fetched dashboard inventories — populated at most once per push,
  // only when an auto-apply path needs to verify an existing dashboard
  // resource isn't being shadowed by a renamed/state-only key.
  // `undefined` = not yet fetched; `[]` = fetched but dashboard returned 0
  // (or the fetch failed and we degraded to state-only dedup).
  //
  // Simulations / personalities / scenarios / simulation suites are not
  // listed here because they're not auto-applied as dependencies anywhere
  // in the engine (they're top-level resources only). If we ever add a
  // dependency-resolution path for them, mirror this pattern.
  existingRemoteTools?: RemoteResource[];
  existingRemoteStructuredOutputs?: RemoteResource[];
  existingRemoteAssistants?: RemoteResource[];
  // Track which resourceIds we mutated so the scoped state-merge on save
  // can flush only the touched section, leaving untouched on-disk state
  // alone. Required for adoption: without it, a scoped push would lose
  // the adopted UUID at end-of-run save.
  touched: TouchedSets;
}

// Lazy-fetch the live dashboard inventory for a given resource type. Used by
// the auto-apply path to detect existing dashboard resources before minting
// a duplicate POST. Honors dry-run by skipping the API call entirely
// (empty list → state-only dedup).
async function getExistingRemoteTools(
  ctx: DependencyContext,
): Promise<RemoteResource[]> {
  if (ctx.existingRemoteTools !== undefined) return ctx.existingRemoteTools;
  if (DRY_RUN) {
    ctx.existingRemoteTools = [];
    return ctx.existingRemoteTools;
  }
  try {
    const remote = await fetchAllResources("tools");
    ctx.existingRemoteTools = remote as unknown as RemoteResource[];
  } catch (err) {
    console.warn(
      `   ⚠️  Could not fetch dashboard tools for dedup check: ${
        err instanceof Error ? err.message : String(err)
      }. Falling back to state-only dedup.`,
    );
    ctx.existingRemoteTools = [];
  }
  return ctx.existingRemoteTools;
}

async function getExistingRemoteStructuredOutputs(
  ctx: DependencyContext,
): Promise<RemoteResource[]> {
  if (ctx.existingRemoteStructuredOutputs !== undefined)
    return ctx.existingRemoteStructuredOutputs;
  if (DRY_RUN) {
    ctx.existingRemoteStructuredOutputs = [];
    return ctx.existingRemoteStructuredOutputs;
  }
  try {
    const remote = await fetchAllResources("structuredOutputs");
    ctx.existingRemoteStructuredOutputs = remote as unknown as RemoteResource[];
  } catch (err) {
    console.warn(
      `   ⚠️  Could not fetch dashboard structured outputs for dedup check: ${
        err instanceof Error ? err.message : String(err)
      }. Falling back to state-only dedup.`,
    );
    ctx.existingRemoteStructuredOutputs = [];
  }
  return ctx.existingRemoteStructuredOutputs;
}

async function getExistingRemoteAssistants(
  ctx: DependencyContext,
): Promise<RemoteResource[]> {
  if (ctx.existingRemoteAssistants !== undefined)
    return ctx.existingRemoteAssistants;
  if (DRY_RUN) {
    ctx.existingRemoteAssistants = [];
    return ctx.existingRemoteAssistants;
  }
  try {
    const remote = await fetchAllResources("assistants");
    ctx.existingRemoteAssistants = remote as unknown as RemoteResource[];
  } catch (err) {
    console.warn(
      `   ⚠️  Could not fetch dashboard assistants for dedup check: ${
        err instanceof Error ? err.message : String(err)
      }. Falling back to state-only dedup.`,
    );
    ctx.existingRemoteAssistants = [];
  }
  return ctx.existingRemoteAssistants;
}

async function ensureToolExists(
  toolId: string,
  ctx: DependencyContext,
): Promise<void> {
  if (
    UUID_REGEX.test(toolId) ||
    ctx.state.tools[toolId] ||
    ctx.autoApplied.has(`tools:${toolId}`)
  )
    return;

  const tool = ctx.allTools.find((t) => t.resourceId === toolId);
  if (!tool) return;

  await reconcileStateKeyForResource({
    resourceType: "tools",
    resource: tool,
    state: ctx.state,
    touched: ctx.touched,
    applied: ctx.applied,
    autoApplied: ctx.autoApplied,
    pushToAutoAppliedList: (r) => ctx.autoAppliedTools.push(r),
    getRemoteList: () => getExistingRemoteTools(ctx),
    applyFn: applyTool,
    vapiEnv: VAPI_ENV,
    formatError: formatApiError,
  });
}

async function ensureStructuredOutputExists(
  outputId: string,
  ctx: DependencyContext,
): Promise<void> {
  if (
    UUID_REGEX.test(outputId) ||
    ctx.state.structuredOutputs[outputId] ||
    ctx.autoApplied.has(`structuredOutputs:${outputId}`)
  )
    return;

  const output = ctx.allStructuredOutputs.find(
    (o) => o.resourceId === outputId,
  );
  if (!output) return;

  await reconcileStateKeyForResource({
    resourceType: "structuredOutputs",
    resource: output,
    state: ctx.state,
    touched: ctx.touched,
    applied: ctx.applied,
    autoApplied: ctx.autoApplied,
    pushToAutoAppliedList: (r) => ctx.autoAppliedStructuredOutputs.push(r),
    getRemoteList: () => getExistingRemoteStructuredOutputs(ctx),
    applyFn: applyStructuredOutput,
    vapiEnv: VAPI_ENV,
    formatError: formatApiError,
  });
}

async function ensureAssistantDepsExist(
  assistantId: string,
  ctx: DependencyContext,
): Promise<boolean> {
  if (UUID_REGEX.test(assistantId)) return false;

  const assistant = ctx.allAssistants.find((a) => a.resourceId === assistantId);
  if (!assistant) return false;

  const refs = extractReferencedIds(assistant.data as Record<string, unknown>);
  let depsCreated = false;

  for (const toolId of refs.tools) {
    if (!UUID_REGEX.test(toolId) && !ctx.state.tools[toolId]) {
      await ensureToolExists(toolId, ctx);
      if (ctx.state.tools[toolId]) depsCreated = true;
    }
  }
  for (const outputId of refs.structuredOutputs) {
    if (!UUID_REGEX.test(outputId) && !ctx.state.structuredOutputs[outputId]) {
      await ensureStructuredOutputExists(outputId, ctx);
      if (ctx.state.structuredOutputs[outputId]) depsCreated = true;
    }
  }

  return depsCreated;
}

async function ensureAssistantExists(
  assistantId: string,
  ctx: DependencyContext,
): Promise<void> {
  if (UUID_REGEX.test(assistantId)) return;

  // Always resolve tool/SO deps, even if the assistant already exists in state
  const depsCreated = await ensureAssistantDepsExist(assistantId, ctx);

  // Assistant already on platform — update it if we just created missing deps
  if (ctx.state.assistants[assistantId]) {
    if (depsCreated) {
      const assistant = ctx.allAssistants.find(
        (a) => a.resourceId === assistantId,
      );
      if (assistant) {
        console.log(
          `  🔄 Updating assistant with new dependencies: ${assistantId}`,
        );
        await applyAssistant(assistant, ctx.state);
      }
    }
    return;
  }

  if (ctx.autoApplied.has(`assistants:${assistantId}`)) return;

  const assistant = ctx.allAssistants.find((a) => a.resourceId === assistantId);
  if (!assistant) return;

  // Same dedup pattern as `ensureToolExists` / `ensureStructuredOutputExists`,
  // against the assistant state section and live dashboard list. Catches the
  // case where bootstrap pull stored the same dashboard assistant under a
  // `<name-slug>-<uuid8>` key and the squad references it by the original
  // local key.
  const remoteList = await getExistingRemoteAssistants(ctx);
  const match = findExistingResourceByName({
    localResourceId: assistantId,
    localPayload: assistant.data,
    stateSection: ctx.state.assistants,
    remoteList,
  });
  if (match) {
    if (match.ambiguous) {
      const displayName = extractResourceName(assistant.data) ?? assistantId;
      console.warn(
        `  ⚠️  Multiple dashboard assistants share the name "${displayName}" — adopting ${match.uuid} (lex-smallest). Other UUIDs: ${match.duplicateUuids.join(", ")}. Run \`npm run cleanup -- ${VAPI_ENV}\` to prune duplicates.`,
      );
    }
    console.log(
      `  🔁 Reusing existing assistant: ${assistantId} → ${match.uuid} (matched via ${match.source})`,
    );

    upsertState(ctx.state.assistants, assistant.resourceId, {
      uuid: match.uuid,
    });

    // Orphan-deletion guard — drop other state keys pointing at the SAME
    // uuid so a subsequent full push doesn't see them as "tracked but no
    // local file" and DELETE the dashboard resource we just adopted.
    for (const [staleKey, entry] of Object.entries(ctx.state.assistants)) {
      if (staleKey !== assistant.resourceId && entry.uuid === match.uuid) {
        delete ctx.state.assistants[staleKey];
        ctx.touched.assistants.add(staleKey);
      }
    }

    // PATCH via the standard apply path so drift detection fires and any
    // local edits land on the dashboard.
    try {
      const uuid = await applyAssistant(assistant, ctx.state);
      ctx.autoApplied.add(`assistants:${assistantId}`);
      if (!uuid) return;
      upsertState(ctx.state.assistants, assistant.resourceId, {
        uuid,
      });
      ctx.applied.assistants++;
      ctx.touched.assistants.add(assistant.resourceId);
    } catch (error) {
      console.error(formatApiError(assistantId, error));
      throw error;
    }
    return;
  }

  console.log(`  📦 Auto-applying dependency → assistant: ${assistantId}`);
  try {
    const uuid = await applyAssistant(assistant, ctx.state);
    if (!uuid) {
      ctx.autoApplied.add(`assistants:${assistantId}`);
      return;
    }
    upsertState(ctx.state.assistants, assistant.resourceId, {
      uuid,
    });
    ctx.applied.assistants++;
    ctx.autoApplied.add(`assistants:${assistantId}`);
    ctx.touched.assistants.add(assistant.resourceId);
  } catch (error) {
    console.error(formatApiError(assistantId, error));
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Apply Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Guard here (not only in runPush): apply spawns `tsx src/push.ts` directly,
  // which enters via the isMainModule block below and never calls runPush.
  assertStateMigrated(STATE_FILE_PATH);

  const partial = isPartialApply();

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🚀 Vapi GitOps Apply - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(
    `   Deletions: ${FORCE_DELETE ? "⚠️  ENABLED (--force)" : "🔒 Disabled (pass --force to enable)"}`,
  );
  if (DRY_RUN) {
    console.log("   Mode: 🧪 DRY-RUN (no API mutations, no state file write)");
  }
  if (APPLY_FILTER.resourceTypes?.length) {
    console.log(`   Filter: ${APPLY_FILTER.resourceTypes.join(", ")}`);
  }
  if (APPLY_FILTER.filePaths?.length) {
    console.log(`   Files: ${APPLY_FILTER.filePaths.join(", ")}`);
  }
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  // Load current state (needed for reference resolution even in partial apply)
  let state = loadState();

  // Track which resourceIds we actually mutate so the end-of-run save can
  // merge into existing on-disk state instead of rewriting wholesale.
  const touched: TouchedSets = emptyTouchedSets();

  // Track what was applied for summary
  const applied: Record<ResourceType, number> = {
    tools: 0,
    structuredOutputs: 0,
    assistants: 0,
    squads: 0,
    personalities: 0,
    scenarios: 0,
    simulations: 0,
    simulationSuites: 0,
    evals: 0,
  };

  // From here on, any path out of the function (success OR thrown error) must
  // flush the state file. If an early 5xx kills the apply after a few resources
  // have been created on the remote, we still need their UUIDs recorded locally
  // — otherwise the next run creates duplicates.
  try {
    // Load all resources (we need them for reference resolution and filtering).
    // `.vapi-ignore` is symmetric with pull: matched ids are filtered out
    // before validation, drift check, and apply. `--force` bypasses the
    // load-filter (so deliberate overrides flow through); the orphan-protect
    // pass inside `deleteOrphanedResources` ALWAYS honors the ignore list so
    // a `--force` push can't silently delete a dashboard resource the repo
    // has explicitly opted out of managing. Bootstrap-pull paths read their
    // own patterns directly and are unaffected by this constant.
    console.log("\n📂 Loading resources...\n");
    const ignorePatterns = FORCE_DELETE ? [] : loadIgnorePatterns();
    const loadOpts = { ignorePatterns };
    const allToolsRaw = await loadResources<Record<string, unknown>>(
      "tools",
      loadOpts,
    );
    const allStructuredOutputsRaw = await loadResources<
      Record<string, unknown>
    >("structuredOutputs", loadOpts);
    const allAssistantsRaw = await loadResources<Record<string, unknown>>(
      "assistants",
      loadOpts,
    );
    const allSquadsRaw = await loadResources<Record<string, unknown>>(
      "squads",
      loadOpts,
    );
    const allPersonalitiesRaw = await loadResources<Record<string, unknown>>(
      "personalities",
      loadOpts,
    );
    const allScenariosRaw = await loadResources<Record<string, unknown>>(
      "scenarios",
      loadOpts,
    );
    const allSimulationsRaw = await loadResources<Record<string, unknown>>(
      "simulations",
      loadOpts,
    );
    const allSimulationSuitesRaw = await loadResources<Record<string, unknown>>(
      "simulationSuites",
      loadOpts,
    );
    const allEvalsRaw = await loadResources<Record<string, unknown>>(
      "evals",
      loadOpts,
    );

    const loadedResources: LoadedResources = {
      tools: allToolsRaw,
      structuredOutputs: allStructuredOutputsRaw,
      assistants: allAssistantsRaw,
      squads: allSquadsRaw,
      personalities: allPersonalitiesRaw,
      scenarios: allScenariosRaw,
      simulations: allSimulationsRaw,
      simulationSuites: allSimulationSuitesRaw,
      evals: allEvalsRaw,
    };

    state = await maybeBootstrapState(loadedResources, state);

    // Recanonicalize stale UUID-suffixed state keys back to canonical slugs
    // before the orphan-YAML gate runs. This is the safe collapse of the
    // pull-side rekey-on-name-collision behavior (src/pull.ts) once the
    // underlying collision has resolved (e.g. the conflicting twin was
    // deleted on the dashboard). Without this pass, the orphan-YAML gate
    // sees the canonical-slug local file as "new" — the recurring
    // duplicate-creation root cause documented in improvements.md.
    //
    // Gating: `BOOTSTRAP_SYNC` (the user's explicit `--bootstrap` flag)
    // skips this pass because state is being rebuilt from scratch. Note
    // that the *internal* bootstrap-recovery pull triggered by
    // `maybeBootstrapState` above does NOT set `BOOTSTRAP_SYNC` — so
    // recanonicalize still runs after that recovery, which is intentional:
    // bootstrap freshly generates UUID-suffixed keys for unresolved
    // collisions, and recanonicalize collapses any that no longer have a
    // live conflict.
    //
    // `touched` is plumbed through so scoped pushes flush the rename via
    // `mergeScoped` at save time. Without this, the on-disk stale key
    // would silently re-overwrite the in-memory canonical rename — H1 in
    // the code review.
    if (!BOOTSTRAP_SYNC) {
      const recanonReport = recanonicalizeStateKeys({ state, touched });
      const recanonSummary = formatRecanonicalizeReport(recanonReport);
      if (recanonSummary) {
        console.log(`\n${recanonSummary}`);
      }
    }

    // Orphan-YAML pre-flight gate. Runs ONCE for ALL resource types after
    // bootstrap (so state-recovery has a chance to rekey first) and BEFORE
    // any apply phase. Halts push when local files exist with no state entry
    // — the duplicate-creation pattern we surfaced during the gitops-mudflap
    // working session 2026-05-13 (see src/new-file-gate.ts for context).
    //
    // Skipped during explicit `--bootstrap` runs: a bootstrap is supposed to
    // populate state from scratch, so every local file legitimately lacks a
    // state entry at that point.
    if (!BOOTSTRAP_SYNC) {
      const orphanReport = detectOrphanYamls({
        state,
        filePathFilter: APPLY_FILTER.filePaths,
      });
      if (orphanReport.orphans.length > 0) {
        if (ALLOW_NEW_FILES) {
          const verb = DRY_RUN ? "would create" : "creating";
          console.log(
            `   ⚠️  bypassing new-file gate: ${verb} ${orphanReport.orphans.length} new resource(s) on the dashboard`,
          );
        } else {
          console.error(
            formatGateMessage(orphanReport, VAPI_ENV, {
              color: process.stderr.isTTY === true,
            }),
          );
          process.exit(1);
        }
      }
    }

    // Run client-side validators against the loaded resource set. In default
    // mode, errors are surfaced as warnings so a single bad spec doesn't block
    // an otherwise-good push. With --strict, any error-severity finding aborts
    // before any API call.
    console.log("\n🔎 Running validators...");
    const findings = [
      ...validateResources(loadedResources),
      // Cross-ignore reference check uses the user-facing ignore list (NOT
      // the FORCE_DELETE-shadowed `ignorePatterns`) — even under `--force`,
      // a config that references an ignored resource is a contradiction the
      // operator should see.
      ...validateNoIgnoredReferences(loadedResources, loadIgnorePatterns()),
    ];
    if (findings.length > 0) {
      console.log(summarizeFindings(findings));
    } else {
      console.log("   ✅ No validation issues.");
    }
    const errorCount = findings.filter((f) => f.severity === "error").length;
    if (errorCount > 0) {
      if (STRICT_VALIDATION) {
        console.error(
          `\n❌ Validation failed (${errorCount} error(s)). --strict refuses to push. Fix the issues above or drop --strict.`,
        );
        process.exit(1);
      }
      console.warn(
        `   ⚠️  ${errorCount} validation error(s) detected — push will continue (use --strict to abort on errors).`,
      );
    }

    // Resolve credential names → UUIDs in all resource data before applying
    const credMap = credentialForwardMap(state);
    if (credMap.size > 0) {
      console.log(`\n🔑 Resolving credentials (${credMap.size} mapped)...\n`);
    } else {
      console.log(
        "\n🔑 No credentials in state — run pull first to populate credential mappings",
      );
    }

    const resolveCredentials = <T>(
      resources: ResourceFile<T>[],
    ): ResourceFile<T>[] =>
      resources.map((r) => {
        const resolved = replaceCredentialRefs(r.data, credMap);
        warnUnresolvedCredentials(
          r.resourceId,
          resolved as Record<string, unknown>,
        );
        return { ...r, data: resolved };
      });

    // Filter out platform defaults (read-only, cannot be updated via API)
    const filterDefaults = <T extends Record<string, unknown>>(
      resources: ResourceFile<T>[],
    ) => {
      const defaults = resources.filter(
        (r) => (r.data as Record<string, unknown>)._platformDefault === true,
      );
      if (defaults.length > 0) {
        for (const d of defaults) {
          console.log(`  🔒 Skipping platform default: ${d.resourceId}`);
        }
      }
      return resources.filter(
        (r) => (r.data as Record<string, unknown>)._platformDefault !== true,
      );
    };

    const allTools = resolveCredentials(filterDefaults(allToolsRaw));
    const allStructuredOutputs = resolveCredentials(
      filterDefaults(allStructuredOutputsRaw),
    );
    const allAssistants = resolveCredentials(filterDefaults(allAssistantsRaw));
    const allSquads = resolveCredentials(filterDefaults(allSquadsRaw));
    const allPersonalities = resolveCredentials(
      filterDefaults(allPersonalitiesRaw),
    );
    const allScenarios = resolveCredentials(filterDefaults(allScenariosRaw));
    const allSimulations = resolveCredentials(
      filterDefaults(allSimulationsRaw),
    );
    const allSimulationSuites = resolveCredentials(
      filterDefaults(allSimulationSuitesRaw),
    );
    const allEvals = resolveCredentials(filterDefaults(allEvalsRaw));

    // Filter resources based on apply filter
    const tools = shouldApplyResourceType("tools")
      ? filterResourcesByPaths(allTools, "tools")
      : [];
    const structuredOutputs = shouldApplyResourceType("structuredOutputs")
      ? filterResourcesByPaths(allStructuredOutputs, "structuredOutputs")
      : [];
    const assistants = shouldApplyResourceType("assistants")
      ? filterResourcesByPaths(allAssistants, "assistants")
      : [];
    const squads = shouldApplyResourceType("squads")
      ? filterResourcesByPaths(allSquads, "squads")
      : [];
    const personalities = shouldApplyResourceType("personalities")
      ? filterResourcesByPaths(allPersonalities, "personalities")
      : [];
    const scenarios = shouldApplyResourceType("scenarios")
      ? filterResourcesByPaths(allScenarios, "scenarios")
      : [];
    const simulations = shouldApplyResourceType("simulations")
      ? filterResourcesByPaths(allSimulations, "simulations")
      : [];
    const simulationSuites = shouldApplyResourceType("simulationSuites")
      ? filterResourcesByPaths(allSimulationSuites, "simulationSuites")
      : [];
    const evals = shouldApplyResourceType("evals")
      ? filterResourcesByPaths(allEvals, "evals")
      : [];

    // Auto-dependency resolution context
    const autoApplied = new Set<string>();
    const autoAppliedTools: ResourceFile<Record<string, unknown>>[] = [];
    const autoAppliedStructuredOutputs: ResourceFile<
      Record<string, unknown>
    >[] = [];
    const depCtx: DependencyContext = {
      allTools,
      allStructuredOutputs,
      allAssistants,
      state,
      applied,
      autoApplied,
      autoAppliedTools,
      autoAppliedStructuredOutputs,
      touched,
    };

    // Determine which types to check for orphaned deletions
    // Full apply: check all types. Partial apply: only check the filtered type(s).
    let typesToDelete: ResourceType[] | undefined;
    if (partial) {
      typesToDelete = [];
      if (APPLY_FILTER.resourceTypes?.length) {
        typesToDelete.push(...APPLY_FILTER.resourceTypes);
      } else if (APPLY_FILTER.filePaths?.length) {
        if (tools.length > 0) typesToDelete.push("tools");
        if (structuredOutputs.length > 0)
          typesToDelete.push("structuredOutputs");
        if (assistants.length > 0) typesToDelete.push("assistants");
        if (squads.length > 0) typesToDelete.push("squads");
        if (personalities.length > 0) typesToDelete.push("personalities");
        if (scenarios.length > 0) typesToDelete.push("scenarios");
        if (simulations.length > 0) typesToDelete.push("simulations");
        if (simulationSuites.length > 0) typesToDelete.push("simulationSuites");
        if (evals.length > 0) typesToDelete.push("evals");
      }
    }

    console.log(
      partial
        ? `\n🗑️  Checking for deleted resources (${typesToDelete!.join(", ")})...\n`
        : "\n🗑️  Checking for deleted resources...\n",
    );
    // Use raw (unfiltered) lists for orphan checking — platform defaults must be
    // included so they aren't mistakenly detected as orphaned and deleted
    await deleteOrphanedResources(
      {
        tools: allToolsRaw,
        structuredOutputs: allStructuredOutputsRaw,
        assistants: allAssistantsRaw,
        squads: allSquadsRaw,
        personalities: allPersonalitiesRaw,
        scenarios: allScenariosRaw,
        simulations: allSimulationsRaw,
        simulationSuites: allSimulationSuitesRaw,
        evals: allEvalsRaw,
      },
      state,
      typesToDelete,
    );

    // Apply in dependency order:
    // 1. Base resources (tools, structuredOutputs)
    // 2. Assistants (references tools, structuredOutputs)
    // 3. Squads (references assistants)
    // 4. Simulation building blocks (personalities, scenarios)
    // 5. Simulations (references personalities, scenarios)
    // 6. Simulation suites (references simulations)
    // 7. Evals

    if (tools.length > 0) {
      console.log("\n🔧 Applying tools...\n");
      for (const tool of tools) {
        try {
          const uuid = await applyTool(tool, state);
          if (!uuid) continue;
          upsertState(state.tools, tool.resourceId, {
            uuid,
          });
          touched.tools.add(tool.resourceId);
          applied.tools++;
        } catch (error) {
          console.error(formatApiError(tool.resourceId, error));
          throw error;
        }
      }
    }

    if (structuredOutputs.length > 0) {
      console.log("\n📊 Applying structured outputs...\n");
      for (const output of structuredOutputs) {
        try {
          const uuid = await applyStructuredOutput(output, state);
          if (!uuid) continue;
          upsertState(state.structuredOutputs, output.resourceId, {
            uuid,
          });
          touched.structuredOutputs.add(output.resourceId);
          applied.structuredOutputs++;
        } catch (error) {
          console.error(formatApiError(output.resourceId, error));
          throw error;
        }
      }
    }

    if (assistants.length > 0) {
      console.log("\n🤖 Applying assistants...\n");
      // Auto-resolve missing tool & structured output dependencies
      for (const assistant of assistants) {
        const refs = extractReferencedIds(
          assistant.data as Record<string, unknown>,
        );
        for (const toolId of refs.tools) {
          await ensureToolExists(toolId, depCtx);
        }
        for (const outputId of refs.structuredOutputs) {
          await ensureStructuredOutputExists(outputId, depCtx);
        }
      }
      for (const assistant of assistants) {
        if (autoApplied.has(`assistants:${assistant.resourceId}`)) continue;
        try {
          const uuid = await applyAssistant(assistant, state);
          if (!uuid) continue;
          upsertState(state.assistants, assistant.resourceId, {
            uuid,
          });
          touched.assistants.add(assistant.resourceId);
          applied.assistants++;
        } catch (error) {
          console.error(formatApiError(assistant.resourceId, error));
          throw error;
        }
      }
    }

    if (squads.length > 0) {
      console.log("\n👥 Applying squads...\n");
      // Auto-resolve missing assistant dependencies (recursively resolves tools/SOs)
      for (const squad of squads) {
        const refs = extractReferencedIds(
          squad.data as Record<string, unknown>,
        );
        for (const assistantId of refs.assistants) {
          await ensureAssistantExists(assistantId, depCtx);
        }
      }
      for (const squad of squads) {
        try {
          const uuid = await applySquad(squad, state);
          if (!uuid) continue;
          upsertState(state.squads, squad.resourceId, {
            uuid,
          });
          touched.squads.add(squad.resourceId);
          applied.squads++;
        } catch (error) {
          console.error(formatApiError(squad.resourceId, error));
          throw error;
        }
      }
    }

    if (personalities.length > 0) {
      console.log("\n🎭 Applying personalities...\n");
      for (const personality of personalities) {
        try {
          const uuid = await applyPersonality(personality, state);
          if (!uuid) continue;
          upsertState(state.personalities, personality.resourceId, {
            uuid,
          });
          touched.personalities.add(personality.resourceId);
          applied.personalities++;
        } catch (error) {
          console.error(formatApiError(personality.resourceId, error));
          throw error;
        }
      }
    }

    if (scenarios.length > 0) {
      console.log("\n📋 Applying scenarios...\n");
      for (const scenario of scenarios) {
        try {
          const uuid = await applyScenario(scenario, state);
          if (!uuid) continue;
          upsertState(state.scenarios, scenario.resourceId, {
            uuid,
          });
          touched.scenarios.add(scenario.resourceId);
          applied.scenarios++;
        } catch (error) {
          console.error(formatApiError(scenario.resourceId, error));
          throw error;
        }
      }
    }

    if (simulations.length > 0) {
      console.log("\n🧪 Applying simulations...\n");
      for (const simulation of simulations) {
        try {
          const uuid = await applySimulation(simulation, state);
          if (!uuid) continue;
          upsertState(state.simulations, simulation.resourceId, {
            uuid,
          });
          touched.simulations.add(simulation.resourceId);
          applied.simulations++;
        } catch (error) {
          console.error(formatApiError(simulation.resourceId, error));
          throw error;
        }
      }
    }

    if (simulationSuites.length > 0) {
      console.log("\n📦 Applying simulation suites...\n");
      for (const suite of simulationSuites) {
        try {
          const uuid = await applySimulationSuite(suite, state);
          if (!uuid) continue;
          upsertState(state.simulationSuites, suite.resourceId, {
            uuid,
          });
          touched.simulationSuites.add(suite.resourceId);
          applied.simulationSuites++;
        } catch (error) {
          console.error(formatApiError(suite.resourceId, error));
          throw error;
        }
      }
    }

    if (evals.length > 0) {
      console.log("\n🧪 Applying evals...\n");
      for (const evalResource of evals) {
        try {
          const uuid = await applyEval(evalResource, state);
          upsertState(state.evals, evalResource.resourceId, {
            uuid,
          });
          touched.evals.add(evalResource.resourceId);
          applied.evals++;
        } catch (error) {
          console.error(formatApiError(evalResource.resourceId, error));
          throw error;
        }
      }
    }

    // Second pass: Link resources to assistants (include auto-applied deps)
    const allAppliedTools = [...tools, ...autoAppliedTools];
    if (allAppliedTools.length > 0) {
      console.log("\n🔗 Linking tools to assistant destinations...\n");
      await updateToolAssistantRefs(allAppliedTools, state);
    }

    const allAppliedOutputs = [
      ...structuredOutputs,
      ...autoAppliedStructuredOutputs,
    ];
    if (allAppliedOutputs.length > 0) {
      console.log("\n🔗 Linking structured outputs to assistants...\n");
      await updateStructuredOutputAssistantRefs(allAppliedOutputs, state);
    }

    console.log(
      "\n═══════════════════════════════════════════════════════════════",
    );
    console.log(
      DRY_RUN
        ? "🧪 Dry-run complete (no changes applied)!"
        : "✅ Apply complete!",
    );
    console.log(
      "═══════════════════════════════════════════════════════════════\n",
    );

    if (DRY_RUN) {
      const counts = getDryRunCounts();
      console.log(
        `🧪 Would create ${counts.POST}, would update ${counts.PATCH}, would delete ${counts.DELETE} (no API calls fired)`,
      );
    }

    // Summary - show what was applied vs total in state
    const totalApplied = Object.values(applied).reduce((a, b) => a + b, 0);

    if (partial) {
      console.log(`📋 Applied ${totalApplied} resource(s):`);
      if (applied.tools > 0) console.log(`   Tools: ${applied.tools}`);
      if (applied.structuredOutputs > 0)
        console.log(`   Structured Outputs: ${applied.structuredOutputs}`);
      if (applied.assistants > 0)
        console.log(`   Assistants: ${applied.assistants}`);
      if (applied.squads > 0) console.log(`   Squads: ${applied.squads}`);
      if (applied.personalities > 0)
        console.log(`   Personalities: ${applied.personalities}`);
      if (applied.scenarios > 0)
        console.log(`   Scenarios: ${applied.scenarios}`);
      if (applied.simulations > 0)
        console.log(`   Simulations: ${applied.simulations}`);
      if (applied.simulationSuites > 0)
        console.log(`   Simulation Suites: ${applied.simulationSuites}`);
      if (applied.evals > 0) console.log(`   Evals: ${applied.evals}`);
    } else {
      console.log("📋 Summary:");
      console.log(`   Tools: ${Object.keys(state.tools).length}`);
      console.log(
        `   Structured Outputs: ${Object.keys(state.structuredOutputs).length}`,
      );
      console.log(`   Assistants: ${Object.keys(state.assistants).length}`);
      console.log(`   Squads: ${Object.keys(state.squads).length}`);
      console.log(
        `   Personalities: ${Object.keys(state.personalities).length}`,
      );
      console.log(`   Scenarios: ${Object.keys(state.scenarios).length}`);
      console.log(`   Simulations: ${Object.keys(state.simulations).length}`);
      console.log(
        `   Simulation Suites: ${Object.keys(state.simulationSuites).length}`,
      );
      console.log(`   Evals: ${Object.keys(state.evals).length}`);
    }

    const totalCandidates =
      tools.length +
      structuredOutputs.length +
      assistants.length +
      squads.length +
      personalities.length +
      scenarios.length +
      simulations.length +
      simulationSuites.length +
      evals.length;

    if (partial && !DRY_RUN && totalCandidates > 0 && totalApplied === 0) {
      console.error(
        "\n❌ Push finished but applied 0 resource(s). Likely drift-blocked — " +
          "run with --overwrite or resolve pull conflicts first.",
      );
      process.exit(1);
    }
  } finally {
    // Always flush state, even on partial failure — resources that already
    // received UUIDs from the API must be recorded so the next run does not
    // re-create them.
    //
    // EXCEPT in dry-run mode: no real API calls fired, so the state file
    // would be polluted with synthetic dry-run UUIDs. Skip the save entirely.
    if (DRY_RUN) {
      console.log(
        "\n🧪 [dry-run] Skipping state file write (would have written to " +
          `.vapi-state.${VAPI_ENV}.json)`,
      );
    } else {
      try {
        // For scoped pushes, only persist entries we actually mutated.
        // Re-load disk state and merge our touched entries on top so
        // unrelated drift in untouched entries is left alone. A bare
        // (non-partial) push falls through to the wholesale save.
        const stateToWrite = partial
          ? mergeScoped(loadState(), state, touched)
          : state;
        await saveState(stateToWrite);
      } catch (saveError) {
        console.error(
          "\n⚠️  Failed to persist state file after apply:",
          saveError instanceof Error ? saveError.message : saveError,
        );
        console.error(
          `   Local state may be out of sync with platform. Run \`npm run pull -- ${VAPI_ENV} --bootstrap\` to recover.`,
        );
      }
    }
  }
}

export async function runPush(): Promise<void> {
  return main();
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    if (error instanceof VapiApiError) {
      console.error(`\n❌ Apply failed: ${error.apiMessage}`);
    } else {
      console.error(
        "\n❌ Apply failed:",
        error instanceof Error ? error.message : error,
      );
    }
    process.exit(1);
  });
}
