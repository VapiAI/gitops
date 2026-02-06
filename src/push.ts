import { vapiRequest } from "./api.ts";
import { VAPI_ENV, VAPI_BASE_URL, FORCE_DELETE, APPLY_FILTER, removeExcludedKeys } from "./config.ts";
import { loadState, saveState } from "./state.ts";
import { loadResources, loadSingleResource, FOLDER_MAP } from "./resources.ts";
import { resolveReferences, resolveAssistantIds } from "./resolver.ts";
import { deleteOrphanedResources } from "./delete.ts";
import type { ResourceFile, StateFile, ResourceType, LoadedResources } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Resource Apply Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function applyTool(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.tools[resourceId];

  // Resolve references (but assistants may not exist yet on first pass)
  const payload = resolveReferences(data as Record<string, unknown>, state);

  // For handoff tools with assistant destinations, strip unresolved assistantIds for initial creation
  // They will be linked after assistants are created
  const payloadForCreate = stripUnresolvedAssistantDestinations(
    payload,
    data as Record<string, unknown>
  );

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "tools");
    console.log(`  🔄 Updating tool: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/tool/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating tool: ${resourceId}`);
    const result = await vapiRequest("POST", "/tool", payloadForCreate);
    return result.id;
  }
}

// Strip destinations with unresolved assistantIds (where original equals resolved = not found in state)
function stripUnresolvedAssistantDestinations(
  resolved: Record<string, unknown>,
  original: Record<string, unknown>
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
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.structuredOutputs[resourceId];

  // Resolve references to assistants (but assistants might not exist yet in first pass)
  const payload = resolveReferences(data as Record<string, unknown>, state);

  // Remove assistant references for initial creation (circular dependency)
  const { assistantIds, ...payloadWithoutAssistants } = payload;

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "structuredOutputs");
    console.log(`  🔄 Updating structured output: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/structured-output/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating structured output: ${resourceId}`);
    const result = await vapiRequest("POST", "/structured-output", payloadWithoutAssistants);
    return result.id;
  }
}

export async function applyAssistant(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.assistants[resourceId];

  // Resolve tool and structured output references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "assistants");
    console.log(`  🔄 Updating assistant: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/assistant/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating assistant: ${resourceId}`);
    const result = await vapiRequest("POST", "/assistant", payload);
    return result.id;
  }
}

export async function applySquad(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.squads[resourceId];

  // Resolve assistant references in members
  const payload = resolveReferences(data as Record<string, unknown>, state);

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "squads");
    console.log(`  🔄 Updating squad: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/squad/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating squad: ${resourceId}`);
    const result = await vapiRequest("POST", "/squad", payload);
    return result.id;
  }
}

export async function applyPersonality(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.personalities[resourceId];

  // Personalities contain inline assistant config, no external references to resolve
  const payload = data as Record<string, unknown>;

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "personalities");
    console.log(`  🔄 Updating personality: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/eval/simulation/personality/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating personality: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval/simulation/personality", payload);
    return result.id;
  }
}

export async function applyScenario(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.scenarios[resourceId];

  // Resolve structuredOutputId references in evaluations
  const payload = resolveReferences(data as Record<string, unknown>, state);

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "scenarios");
    console.log(`  🔄 Updating scenario: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/eval/simulation/scenario/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating scenario: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval/simulation/scenario", payload);
    return result.id;
  }
}

export async function applySimulation(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.simulations[resourceId];

  // Resolve personality and scenario references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "simulations");
    console.log(`  🔄 Updating simulation: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/eval/simulation/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating simulation: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval/simulation", payload);
    return result.id;
  }
}

export async function applySimulationSuite(
  resource: ResourceFile,
  state: StateFile
): Promise<string> {
  const { resourceId, data } = resource;
  const existingUuid = state.simulationSuites[resourceId];

  // Resolve simulation references
  const payload = resolveReferences(data as Record<string, unknown>, state);

  if (existingUuid) {
    const updatePayload = removeExcludedKeys(payload, "simulationSuites");
    console.log(`  🔄 Updating simulation suite: ${resourceId} (${existingUuid})`);
    await vapiRequest("PATCH", `/eval/simulation/suite/${existingUuid}`, updatePayload);
    return existingUuid;
  } else {
    console.log(`  ✨ Creating simulation suite: ${resourceId}`);
    const result = await vapiRequest("POST", "/eval/simulation/suite", payload);
    return result.id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-Apply: Update Tools with Assistant References (for handoff tools)
// ─────────────────────────────────────────────────────────────────────────────

export async function updateToolAssistantRefs(
  tools: ResourceFile[],
  state: StateFile
): Promise<void> {
  for (const resource of tools) {
    const { resourceId, data } = resource;
    const rawData = data as Record<string, unknown>;

    // Check if this tool has destinations with assistant references
    if (!Array.isArray(rawData.destinations)) {
      continue;
    }

    const hasAssistantRefs = (rawData.destinations as Record<string, unknown>[]).some(
      (dest) => typeof dest.assistantId === "string"
    );

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
  state: StateFile
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
      state
    );

    if (assistantIds.length > 0) {
      console.log(`  🔗 Linking structured output ${resourceId} to assistants`);
      await vapiRequest("PATCH", `/structured-output/${uuid}`, { assistantIds });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Filtering
// ─────────────────────────────────────────────────────────────────────────────

function isPartialApply(): boolean {
  return !!(APPLY_FILTER.resourceTypes?.length || APPLY_FILTER.filePaths?.length);
}

function shouldApplyResourceType(type: ResourceType): boolean {
  // If filtering by specific files, check if any file matches this type
  if (APPLY_FILTER.filePaths?.length) {
    return true; // We'll filter by resourceId later
  }
  // If filtering by types, only include matching types
  if (APPLY_FILTER.resourceTypes?.length) {
    return APPLY_FILTER.resourceTypes.includes(type);
  }
  return true;
}

function filterResourcesByPaths<T>(
  resources: ResourceFile<T>[],
  type: ResourceType
): ResourceFile<T>[] {
  if (!APPLY_FILTER.filePaths?.length) return resources;
  
  // Get all resourceIds that match the file paths for this type
  const matchingIds = new Set<string>();
  
  for (const filePath of APPLY_FILTER.filePaths) {
    // Try to match the file path to a resourceId
    for (const resource of resources) {
      if (resource.filePath.endsWith(filePath) || 
          filePath.endsWith(resource.resourceId + ".yml") ||
          filePath.endsWith(resource.resourceId + ".yaml") ||
          filePath.endsWith(resource.resourceId + ".md") ||
          filePath.endsWith(resource.resourceId + ".ts") ||
          resource.filePath === filePath ||
          resource.resourceId === filePath.replace(/\.(yml|yaml|md|ts)$/, "")) {
        matchingIds.add(resource.resourceId);
      }
    }
  }
  
  return resources.filter(r => matchingIds.has(r.resourceId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Apply Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const partial = isPartialApply();
  
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🚀 Vapi GitOps Apply - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(`   Deletions: ${FORCE_DELETE ? "⚠️  ENABLED (--force)" : "🔒 Disabled (dry-run)"}`);
  if (APPLY_FILTER.resourceTypes?.length) {
    console.log(`   Filter: ${APPLY_FILTER.resourceTypes.join(", ")}`);
  }
  if (APPLY_FILTER.filePaths?.length) {
    console.log(`   Files: ${APPLY_FILTER.filePaths.join(", ")}`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load current state (needed for reference resolution even in partial apply)
  const state = loadState();

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
  };

  // Load all resources (we need them for reference resolution and filtering)
  console.log("\n📂 Loading resources...\n");
  const allToolsRaw = await loadResources<Record<string, unknown>>("tools");
  const allStructuredOutputsRaw = await loadResources<Record<string, unknown>>("structuredOutputs");
  const allAssistantsRaw = await loadResources<Record<string, unknown>>("assistants");
  const allSquadsRaw = await loadResources<Record<string, unknown>>("squads");
  const allPersonalitiesRaw = await loadResources<Record<string, unknown>>("personalities");
  const allScenariosRaw = await loadResources<Record<string, unknown>>("scenarios");
  const allSimulationsRaw = await loadResources<Record<string, unknown>>("simulations");
  const allSimulationSuitesRaw = await loadResources<Record<string, unknown>>("simulationSuites");

  // Filter out platform defaults (read-only, cannot be updated via API)
  const filterDefaults = <T extends Record<string, unknown>>(resources: ResourceFile<T>[]) => {
    const defaults = resources.filter(r => (r.data as Record<string, unknown>)._platformDefault === true);
    if (defaults.length > 0) {
      for (const d of defaults) {
        console.log(`  🔒 Skipping platform default: ${d.resourceId}`);
      }
    }
    return resources.filter(r => (r.data as Record<string, unknown>)._platformDefault !== true);
  };

  const allTools = filterDefaults(allToolsRaw);
  const allStructuredOutputs = filterDefaults(allStructuredOutputsRaw);
  const allAssistants = filterDefaults(allAssistantsRaw);
  const allSquads = filterDefaults(allSquadsRaw);
  const allPersonalities = filterDefaults(allPersonalitiesRaw);
  const allScenarios = filterDefaults(allScenariosRaw);
  const allSimulations = filterDefaults(allSimulationsRaw);
  const allSimulationSuites = filterDefaults(allSimulationSuitesRaw);

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
    }
  }

  console.log(partial
    ? `\n🗑️  Checking for deleted resources (${typesToDelete!.join(", ")})...\n`
    : "\n🗑️  Checking for deleted resources...\n"
  );
  // Use raw (unfiltered) lists for orphan checking — platform defaults must be
  // included so they aren't mistakenly detected as orphaned and deleted
  await deleteOrphanedResources({
    tools: allToolsRaw,
    structuredOutputs: allStructuredOutputsRaw,
    assistants: allAssistantsRaw,
    squads: allSquadsRaw,
    personalities: allPersonalitiesRaw,
    scenarios: allScenariosRaw,
    simulations: allSimulationsRaw,
    simulationSuites: allSimulationSuitesRaw
  }, state, typesToDelete);

  // Apply in dependency order:
  // 1. Base resources (tools, structuredOutputs)
  // 2. Assistants (references tools, structuredOutputs)
  // 3. Squads (references assistants)
  // 4. Simulation building blocks (personalities, scenarios)
  // 5. Simulations (references personalities, scenarios)
  // 6. Simulation suites (references simulations)

  if (tools.length > 0) {
    console.log("\n🔧 Applying tools...\n");
    for (const tool of tools) {
      try {
        const uuid = await applyTool(tool, state);
        state.tools[tool.resourceId] = uuid;
        applied.tools++;
      } catch (error) {
        console.error(`  ❌ Failed to apply tool ${tool.resourceId}:`, error);
        throw error;
      }
    }
  }

  if (structuredOutputs.length > 0) {
    console.log("\n📊 Applying structured outputs...\n");
    for (const output of structuredOutputs) {
      try {
        const uuid = await applyStructuredOutput(output, state);
        state.structuredOutputs[output.resourceId] = uuid;
        applied.structuredOutputs++;
      } catch (error) {
        console.error(
          `  ❌ Failed to apply structured output ${output.resourceId}:`,
          error
        );
        throw error;
      }
    }
  }

  if (assistants.length > 0) {
    console.log("\n🤖 Applying assistants...\n");
    for (const assistant of assistants) {
      try {
        const uuid = await applyAssistant(assistant, state);
        state.assistants[assistant.resourceId] = uuid;
        applied.assistants++;
      } catch (error) {
        console.error(
          `  ❌ Failed to apply assistant ${assistant.resourceId}:`,
          error
        );
        throw error;
      }
    }
  }

  if (squads.length > 0) {
    console.log("\n👥 Applying squads...\n");
    for (const squad of squads) {
      try {
        const uuid = await applySquad(squad, state);
        state.squads[squad.resourceId] = uuid;
        applied.squads++;
      } catch (error) {
        console.error(`  ❌ Failed to apply squad ${squad.resourceId}:`, error);
        throw error;
      }
    }
  }

  if (personalities.length > 0) {
    console.log("\n🎭 Applying personalities...\n");
    for (const personality of personalities) {
      try {
        const uuid = await applyPersonality(personality, state);
        state.personalities[personality.resourceId] = uuid;
        applied.personalities++;
      } catch (error) {
        console.error(`  ❌ Failed to apply personality ${personality.resourceId}:`, error);
        throw error;
      }
    }
  }

  if (scenarios.length > 0) {
    console.log("\n📋 Applying scenarios...\n");
    for (const scenario of scenarios) {
      try {
        const uuid = await applyScenario(scenario, state);
        state.scenarios[scenario.resourceId] = uuid;
        applied.scenarios++;
      } catch (error) {
        console.error(`  ❌ Failed to apply scenario ${scenario.resourceId}:`, error);
        throw error;
      }
    }
  }

  if (simulations.length > 0) {
    console.log("\n🧪 Applying simulations...\n");
    for (const simulation of simulations) {
      try {
        const uuid = await applySimulation(simulation, state);
        state.simulations[simulation.resourceId] = uuid;
        applied.simulations++;
      } catch (error) {
        console.error(`  ❌ Failed to apply simulation ${simulation.resourceId}:`, error);
        throw error;
      }
    }
  }

  if (simulationSuites.length > 0) {
    console.log("\n📦 Applying simulation suites...\n");
    for (const suite of simulationSuites) {
      try {
        const uuid = await applySimulationSuite(suite, state);
        state.simulationSuites[suite.resourceId] = uuid;
        applied.simulationSuites++;
      } catch (error) {
        console.error(`  ❌ Failed to apply simulation suite ${suite.resourceId}:`, error);
        throw error;
      }
    }
  }

  // Second pass: Link resources to assistants (only for tools/structuredOutputs being applied)
  if (tools.length > 0) {
    console.log("\n🔗 Linking tools to assistant destinations...\n");
    await updateToolAssistantRefs(tools, state);
  }

  if (structuredOutputs.length > 0) {
    console.log("\n🔗 Linking structured outputs to assistants...\n");
    await updateStructuredOutputAssistantRefs(structuredOutputs, state);
  }

  // Save updated state
  await saveState(state);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Apply complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Summary - show what was applied vs total in state
  const totalApplied = Object.values(applied).reduce((a, b) => a + b, 0);
  
  if (partial) {
    console.log(`📋 Applied ${totalApplied} resource(s):`);
    if (applied.tools > 0) console.log(`   Tools: ${applied.tools}`);
    if (applied.structuredOutputs > 0) console.log(`   Structured Outputs: ${applied.structuredOutputs}`);
    if (applied.assistants > 0) console.log(`   Assistants: ${applied.assistants}`);
    if (applied.squads > 0) console.log(`   Squads: ${applied.squads}`);
    if (applied.personalities > 0) console.log(`   Personalities: ${applied.personalities}`);
    if (applied.scenarios > 0) console.log(`   Scenarios: ${applied.scenarios}`);
    if (applied.simulations > 0) console.log(`   Simulations: ${applied.simulations}`);
    if (applied.simulationSuites > 0) console.log(`   Simulation Suites: ${applied.simulationSuites}`);
  } else {
    console.log("📋 Summary:");
    console.log(`   Tools: ${Object.keys(state.tools).length}`);
    console.log(`   Structured Outputs: ${Object.keys(state.structuredOutputs).length}`);
    console.log(`   Assistants: ${Object.keys(state.assistants).length}`);
    console.log(`   Squads: ${Object.keys(state.squads).length}`);
    console.log(`   Personalities: ${Object.keys(state.personalities).length}`);
    console.log(`   Scenarios: ${Object.keys(state.scenarios).length}`);
    console.log(`   Simulations: ${Object.keys(state.simulations).length}`);
    console.log(`   Simulation Suites: ${Object.keys(state.simulationSuites).length}`);
  }
}

// Run the apply engine
main().catch((error) => {
  console.error("\n❌ Apply failed:", error);
  process.exit(1);
});
