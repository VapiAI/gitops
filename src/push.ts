import { resolve } from "path";
import { fileURLToPath } from "url";
import { vapiRequest, VapiApiError } from "./api.ts";
import {
  VAPI_ENV,
  VAPI_BASE_URL,
  FORCE_DELETE,
  APPLY_FILTER,
  removeExcludedKeys,
} from "./config.ts";
import { loadState, saveState } from "./state.ts";
import { loadResources, loadSingleResource, FOLDER_MAP } from "./resources.ts";
import { fetchAllResources, resourceIdMatchesName, runPull } from "./pull.ts";
import {
  resolveReferences,
  resolveAssistantIds,
  extractReferencedIds,
} from "./resolver.ts";
import { credentialForwardMap, deepReplaceValues } from "./credentials.ts";
import { deleteOrphanedResources } from "./delete.ts";
import type {
  ResourceFile,
  StateFile,
  ResourceType,
  LoadedResources,
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

async function upsertResourceWithStateRecovery(options: {
  resourceLabel: string;
  resourceId: string;
  existingUuid?: string;
  stateSection: Record<string, string>;
  updateEndpoint: string;
  updatePayload: Record<string, unknown>;
  createEndpoint: string;
  createPayload: Record<string, unknown>;
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
  } = options;

  if (!existingUuid) {
    console.log(`  ✨ Creating ${resourceLabel}: ${resourceId}`);
    const result = await vapiRequest("POST", createEndpoint, createPayload);
    return result.id;
  }

  console.log(
    `  🔄 Updating ${resourceLabel}: ${resourceId} (${existingUuid})`,
  );

  try {
    await vapiRequest("PATCH", updateEndpoint, updatePayload);
    return existingUuid;
  } catch (error) {
    if (!(error instanceof VapiApiError) || error.statusCode !== 404) {
      throw error;
    }

    console.warn(
      `  ⚠️  State entry for ${resourceLabel} "${resourceId}" points to missing remote ID ${existingUuid}. Removing the stale mapping from state and skipping this resource for the current run.`,
    );
    delete stateSection[resourceId];
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential Validation — warn about unresolved credential names
// ─────────────────────────────────────────────────────────────────────────────

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALL_RESOURCE_TYPES: ResourceType[] = [
  "tools",
  "structuredOutputs",
  "assistants",
  "squads",
  "personalities",
  "scenarios",
  "simulations",
  "simulationSuites",
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
    reason: "missing_remote" | "name_mismatch";
  }>
> {
  const invalidMappings: Array<{
    type: ResourceType;
    resourceId: string;
    uuid: string;
    reason: "missing_remote" | "name_mismatch";
  }> = [];

  for (const type of getTargetedResourceTypes(resources)) {
    const trackedResources = resources[type]
      .map((resource) => ({
        resourceId: resource.resourceId,
        uuid: state[type][resource.resourceId],
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

    const remoteResources = await fetchAllResources(type);
    const remoteResourcesById = new Map(
      remoteResources.map((resource) => [resource.id, resource]),
    );

    for (const trackedResource of trackedResources) {
      const remoteResource = remoteResourcesById.get(trackedResource.uuid);
      if (!remoteResource) {
        invalidMappings.push({
          type,
          ...trackedResource,
          reason: "missing_remote",
        });
        continue;
      }

      if (!resourceIdMatchesName(trackedResource.resourceId, remoteResource)) {
        invalidMappings.push({
          type,
          ...trackedResource,
          reason: "name_mismatch",
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
  if (!hasAnyLoadedResources(resources)) {
    return state;
  }

  const targetedTypes = getTargetedResourceTypes(resources);
  const missingCredentialNames = getMissingCredentialNames(resources, state);
  const stateUninitialized =
    Object.keys(state.credentials).length === 0 ||
    targetedTypes.every((type) => Object.keys(state[type]).length === 0);
  const invalidMappings = await getInvalidStateMappings(resources, state);

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
  const existingUuid = state.tools[resourceId];

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
  const existingUuid = state.structuredOutputs[resourceId];

  // Resolve references to assistants (but assistants might not exist yet in first pass)
  const payload = resolveReferences(data as Record<string, unknown>, state);

  // Remove assistant references for initial creation (circular dependency)
  const { assistantIds, ...payloadWithoutAssistants } = payload;

  return upsertResourceWithStateRecovery({
    resourceLabel: "structured output",
    resourceId,
    existingUuid,
    stateSection: state.structuredOutputs,
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
  const existingUuid = state.assistants[resourceId];

  // Resolve tool and structured output references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "assistant",
    resourceId,
    existingUuid,
    stateSection: state.assistants,
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
  const existingUuid = state.squads[resourceId];

  // Resolve assistant references in members
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "squad",
    resourceId,
    existingUuid,
    stateSection: state.squads,
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
  const existingUuid = state.personalities[resourceId];

  // Personalities contain inline assistant config, no external references to resolve
  const payload = data as Record<string, unknown>;

  return upsertResourceWithStateRecovery({
    resourceLabel: "personality",
    resourceId,
    existingUuid,
    stateSection: state.personalities,
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
  const existingUuid = state.scenarios[resourceId];

  // Resolve structuredOutputId references in evaluations
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "scenario",
    resourceId,
    existingUuid,
    stateSection: state.scenarios,
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
  const existingUuid = state.simulations[resourceId];

  // Resolve personality and scenario references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "simulation",
    resourceId,
    existingUuid,
    stateSection: state.simulations,
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
  const existingUuid = state.simulationSuites[resourceId];

  // Resolve simulation references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  return upsertResourceWithStateRecovery({
    resourceLabel: "simulation suite",
    resourceId,
    existingUuid,
    stateSection: state.simulationSuites,
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
  const existingUuid = state.evals[resourceId];

  const payload = data as Record<string, unknown>;

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "evals");
    console.log(`  🔄 Updating eval: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/eval/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating eval: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval", payload);
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

    const uuid = state.tools[resourceId];
    if (!uuid) continue;

    // Resolve destinations now that all assistants exist
    const resolved = resolveReferences(rawData, state);

    console.log(`  🔗 Linking tool ${resourceId} to assistant destinations`);
    await vapiRequest("PATCH", `/tool/${uuid}`, {
      destinations: resolved.destinations,
    });
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

    const uuid = state.structuredOutputs[resourceId];
    if (!uuid) continue;

    // Resolve assistant IDs now that all assistants exist
    const assistantIds = resolveAssistantIds(
      rawData.assistant_ids as string[],
      state,
    );

    if (assistantIds.length > 0) {
      console.log(`  🔗 Linking structured output ${resourceId} to assistants`);
      await vapiRequest("PATCH", `/structured-output/${uuid}`, {
        assistantIds,
      });
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
    return APPLY_FILTER.filePaths.some(
      (fp) => fp.includes(`/${folder}/`) || fp.includes(`\\${folder}\\`),
    );
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

  // Get all resourceIds that match the file paths for this type
  const matchingIds = new Set<string>();

  for (const filePath of APPLY_FILTER.filePaths) {
    // Try to match the file path to a resourceId
    for (const resource of resources) {
      if (
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

  console.log(`  📦 Auto-applying dependency → tool: ${toolId}`);
  try {
    const uuid = await applyTool(tool, ctx.state);
    ctx.autoApplied.add(`tools:${toolId}`);
    if (!uuid) return;
    ctx.state.tools[tool.resourceId] = uuid;
    ctx.applied.tools++;
    ctx.autoAppliedTools.push(tool);
  } catch (error) {
    console.error(formatApiError(toolId, error));
    throw error;
  }
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

  console.log(`  📦 Auto-applying dependency → structured output: ${outputId}`);
  try {
    const uuid = await applyStructuredOutput(output, ctx.state);
    ctx.autoApplied.add(`structuredOutputs:${outputId}`);
    if (!uuid) return;
    ctx.state.structuredOutputs[output.resourceId] = uuid;
    ctx.applied.structuredOutputs++;
    ctx.autoAppliedStructuredOutputs.push(output);
  } catch (error) {
    console.error(formatApiError(outputId, error));
    throw error;
  }
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

  console.log(`  📦 Auto-applying dependency → assistant: ${assistantId}`);
  try {
    const uuid = await applyAssistant(assistant, ctx.state);
    if (!uuid) {
      ctx.autoApplied.add(`assistants:${assistantId}`);
      return;
    }
    ctx.state.assistants[assistant.resourceId] = uuid;
    ctx.applied.assistants++;
    ctx.autoApplied.add(`assistants:${assistantId}`);
  } catch (error) {
    console.error(formatApiError(assistantId, error));
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Apply Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const partial = isPartialApply();

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🚀 Vapi GitOps Apply - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(
    `   Deletions: ${FORCE_DELETE ? "⚠️  ENABLED (--force)" : "🔒 Disabled (dry-run)"}`,
  );
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

  // Load all resources (we need them for reference resolution and filtering)
  console.log("\n📂 Loading resources...\n");
  const allToolsRaw = await loadResources<Record<string, unknown>>("tools");
  const allStructuredOutputsRaw =
    await loadResources<Record<string, unknown>>("structuredOutputs");
  const allAssistantsRaw =
    await loadResources<Record<string, unknown>>("assistants");
  const allSquadsRaw = await loadResources<Record<string, unknown>>("squads");
  const allPersonalitiesRaw =
    await loadResources<Record<string, unknown>>("personalities");
  const allScenariosRaw =
    await loadResources<Record<string, unknown>>("scenarios");
  const allSimulationsRaw =
    await loadResources<Record<string, unknown>>("simulations");
  const allSimulationSuitesRaw =
    await loadResources<Record<string, unknown>>("simulationSuites");
  const allEvalsRaw =
    await loadResources<Record<string, unknown>>("evals");

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
      const resolved = deepReplaceValues(r.data, credMap);
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
  const allSimulations = resolveCredentials(filterDefaults(allSimulationsRaw));
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
  const autoAppliedStructuredOutputs: ResourceFile<Record<string, unknown>>[] =
    [];
  const depCtx: DependencyContext = {
    allTools,
    allStructuredOutputs,
    allAssistants,
    state,
    applied,
    autoApplied,
    autoAppliedTools,
    autoAppliedStructuredOutputs,
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
      if (structuredOutputs.length > 0) typesToDelete.push("structuredOutputs");
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
        state.tools[tool.resourceId] = uuid;
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
        state.structuredOutputs[output.resourceId] = uuid;
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
        state.assistants[assistant.resourceId] = uuid;
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
      const refs = extractReferencedIds(squad.data as Record<string, unknown>);
      for (const assistantId of refs.assistants) {
        await ensureAssistantExists(assistantId, depCtx);
      }
    }
    for (const squad of squads) {
      try {
        const uuid = await applySquad(squad, state);
        if (!uuid) continue;
        state.squads[squad.resourceId] = uuid;
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
        state.personalities[personality.resourceId] = uuid;
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
        state.scenarios[scenario.resourceId] = uuid;
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
        state.simulations[simulation.resourceId] = uuid;
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
        state.simulationSuites[suite.resourceId] = uuid;
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
        state.evals[evalResource.resourceId] = uuid;
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

  // Save updated state
  await saveState(state);

  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );
  console.log("✅ Apply complete!");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

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
    console.log(`   Personalities: ${Object.keys(state.personalities).length}`);
    console.log(`   Scenarios: ${Object.keys(state.scenarios).length}`);
    console.log(`   Simulations: ${Object.keys(state.simulations).length}`);
    console.log(
      `   Simulation Suites: ${Object.keys(state.simulationSuites).length}`,
    );
    console.log(`   Evals: ${Object.keys(state.evals).length}`);
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
