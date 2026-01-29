import { vapiRequest } from "./api.ts";
import { VAPI_ENV, VAPI_BASE_URL, FORCE_DELETE, removeExcludedKeys } from "./config.ts";
import { loadState, saveState } from "./state.ts";
import { loadResources } from "./resources.ts";
import { resolveReferences, resolveAssistantIds } from "./resolver.ts";
import { deleteOrphanedResources } from "./delete.ts";
import type { ResourceFile, StateFile } from "./types.ts";

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
// Main Apply Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🚀 Vapi GitOps Apply - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(`   Deletions: ${FORCE_DELETE ? "⚠️  ENABLED (--force)" : "🔒 Disabled (dry-run)"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load current state
  const state = loadState();

  // Load all resources
  console.log("\n📂 Loading resources...\n");
  const tools = await loadResources<Record<string, unknown>>("tools");
  const structuredOutputs = await loadResources<Record<string, unknown>>("structuredOutputs");
  const assistants = await loadResources<Record<string, unknown>>("assistants");
  const squads = await loadResources<Record<string, unknown>>("squads");
  const personalities = await loadResources<Record<string, unknown>>("personalities");
  const scenarios = await loadResources<Record<string, unknown>>("scenarios");
  const simulations = await loadResources<Record<string, unknown>>("simulations");
  const simulationSuites = await loadResources<Record<string, unknown>>("simulationSuites");

  // Delete orphaned resources first (checks for orphan references, then deletes)
  console.log("\n🗑️  Checking for deleted resources...\n");
  await deleteOrphanedResources({ 
    tools, structuredOutputs, assistants, squads,
    personalities, scenarios, simulations, simulationSuites 
  }, state);

  // Apply in dependency order:
  // 1. Base resources (tools, structuredOutputs)
  // 2. Assistants (references tools, structuredOutputs)
  // 3. Squads (references assistants)
  // 4. Simulation building blocks (personalities, scenarios)
  // 5. Simulations (references personalities, scenarios)
  // 6. Simulation suites (references simulations)

  console.log("\n🔧 Applying tools...\n");
  for (const tool of tools) {
    try {
      const uuid = await applyTool(tool, state);
      state.tools[tool.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply tool ${tool.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n📊 Applying structured outputs...\n");
  for (const output of structuredOutputs) {
    try {
      const uuid = await applyStructuredOutput(output, state);
      state.structuredOutputs[output.resourceId] = uuid;
    } catch (error) {
      console.error(
        `  ❌ Failed to apply structured output ${output.resourceId}:`,
        error
      );
      throw error;
    }
  }

  console.log("\n🤖 Applying assistants...\n");
  for (const assistant of assistants) {
    try {
      const uuid = await applyAssistant(assistant, state);
      state.assistants[assistant.resourceId] = uuid;
    } catch (error) {
      console.error(
        `  ❌ Failed to apply assistant ${assistant.resourceId}:`,
        error
      );
      throw error;
    }
  }

  console.log("\n👥 Applying squads...\n");
  for (const squad of squads) {
    try {
      const uuid = await applySquad(squad, state);
      state.squads[squad.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply squad ${squad.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n🎭 Applying personalities...\n");
  for (const personality of personalities) {
    try {
      const uuid = await applyPersonality(personality, state);
      state.personalities[personality.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply personality ${personality.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n📋 Applying scenarios...\n");
  for (const scenario of scenarios) {
    try {
      const uuid = await applyScenario(scenario, state);
      state.scenarios[scenario.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply scenario ${scenario.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n🧪 Applying simulations...\n");
  for (const simulation of simulations) {
    try {
      const uuid = await applySimulation(simulation, state);
      state.simulations[simulation.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply simulation ${simulation.resourceId}:`, error);
      throw error;
    }
  }

  console.log("\n📦 Applying simulation suites...\n");
  for (const suite of simulationSuites) {
    try {
      const uuid = await applySimulationSuite(suite, state);
      state.simulationSuites[suite.resourceId] = uuid;
    } catch (error) {
      console.error(`  ❌ Failed to apply simulation suite ${suite.resourceId}:`, error);
      throw error;
    }
  }

  // Second pass: Link resources to assistants (now that assistants exist)
  console.log("\n🔗 Linking tools to assistant destinations...\n");
  await updateToolAssistantRefs(tools, state);

  console.log("\n🔗 Linking structured outputs to assistants...\n");
  await updateStructuredOutputAssistantRefs(structuredOutputs, state);

  // Save updated state
  await saveState(state);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Apply complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Summary
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

// Run the apply engine
main().catch((error) => {
  console.error("\n❌ Apply failed:", error);
  process.exit(1);
});

