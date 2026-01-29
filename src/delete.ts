import { vapiDelete } from "./api.ts";
import { FORCE_DELETE } from "./config.ts";
import { extractReferencedIds } from "./resolver.ts";
import type {
  ResourceFile,
  StateFile,
  LoadedResources,
  OrphanedResource,
  ResourceType,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Orphan Detection
// ─────────────────────────────────────────────────────────────────────────────

export function findOrphanedResources(
  loadedResourceIds: string[],
  stateResourceIds: Record<string, string>
): OrphanedResource[] {
  const orphaned: OrphanedResource[] = [];

  for (const [resourceId, uuid] of Object.entries(stateResourceIds)) {
    if (!loadedResourceIds.includes(resourceId)) {
      orphaned.push({ resourceId, uuid });
    }
  }

  return orphaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Checking - Find resources that reference a given resource
// ─────────────────────────────────────────────────────────────────────────────

type ReferenceableType = "tools" | "structuredOutputs" | "assistants" | "personalities" | "scenarios" | "simulations";

export function findReferencingResources(
  targetId: string,
  targetType: ReferenceableType,
  allResources: LoadedResources
): string[] {
  const referencingResources: string[] = [];

  const checkResource = (resource: ResourceFile) => {
    const refs = extractReferencedIds(resource.data as Record<string, unknown>);

    if (targetType === "tools" && refs.tools.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "structuredOutputs" && refs.structuredOutputs.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "assistants" && refs.assistants.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "personalities" && refs.personalities.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "scenarios" && refs.scenarios.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "simulations" && refs.simulations.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
  };

  // Check all resource types that might have references
  for (const resource of allResources.assistants) {
    checkResource(resource);
  }
  for (const resource of allResources.structuredOutputs) {
    checkResource(resource);
  }
  for (const resource of allResources.squads) {
    checkResource(resource);
  }
  for (const resource of allResources.simulations) {
    checkResource(resource);
  }
  for (const resource of allResources.simulationSuites) {
    checkResource(resource);
  }

  return referencingResources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Deletion
// ─────────────────────────────────────────────────────────────────────────────

// Map resource types to their API delete endpoints
const DELETE_ENDPOINT_MAP: Record<ResourceType, string> = {
  tools: "/tool",
  structuredOutputs: "/structured-output",
  assistants: "/assistant",
  squads: "/squad",
  personalities: "/eval/simulation/personality",
  scenarios: "/eval/simulation/scenario",
  simulations: "/eval/simulation",
  simulationSuites: "/eval/simulation/suite",
};

export async function deleteOrphanedResources(
  loadedResources: LoadedResources,
  state: StateFile
): Promise<void> {
  // Find all orphaned resources
  const orphanedTools = findOrphanedResources(
    loadedResources.tools.map((t) => t.resourceId),
    state.tools
  );
  const orphanedOutputs = findOrphanedResources(
    loadedResources.structuredOutputs.map((o) => o.resourceId),
    state.structuredOutputs
  );
  const orphanedAssistants = findOrphanedResources(
    loadedResources.assistants.map((a) => a.resourceId),
    state.assistants
  );
  const orphanedSquads = findOrphanedResources(
    loadedResources.squads.map((s) => s.resourceId),
    state.squads
  );
  const orphanedPersonalities = findOrphanedResources(
    loadedResources.personalities.map((p) => p.resourceId),
    state.personalities
  );
  const orphanedScenarios = findOrphanedResources(
    loadedResources.scenarios.map((s) => s.resourceId),
    state.scenarios
  );
  const orphanedSimulations = findOrphanedResources(
    loadedResources.simulations.map((s) => s.resourceId),
    state.simulations
  );
  const orphanedSimulationSuites = findOrphanedResources(
    loadedResources.simulationSuites.map((s) => s.resourceId),
    state.simulationSuites
  );

  // Collect all orphaned resources for summary
  const allOrphaned = [
    ...orphanedSimulationSuites.map((r) => ({ ...r, type: "simulation suite" as const })),
    ...orphanedSimulations.map((r) => ({ ...r, type: "simulation" as const })),
    ...orphanedScenarios.map((r) => ({ ...r, type: "scenario" as const })),
    ...orphanedPersonalities.map((r) => ({ ...r, type: "personality" as const })),
    ...orphanedSquads.map((r) => ({ ...r, type: "squad" as const })),
    ...orphanedAssistants.map((r) => ({ ...r, type: "assistant" as const })),
    ...orphanedOutputs.map((r) => ({ ...r, type: "structured output" as const })),
    ...orphanedTools.map((r) => ({ ...r, type: "tool" as const })),
  ];

  // No orphaned resources - nothing to do
  if (allOrphaned.length === 0) {
    console.log("  ✅ No orphaned resources found\n");
    return;
  }

  // Check for orphan references before deleting
  const errors: string[] = [];

  for (const { resourceId } of orphanedTools) {
    const refs = findReferencingResources(resourceId, "tools", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete tool "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  for (const { resourceId } of orphanedOutputs) {
    const refs = findReferencingResources(resourceId, "structuredOutputs", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete structured output "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  for (const { resourceId } of orphanedAssistants) {
    const refs = findReferencingResources(resourceId, "assistants", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete assistant "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  for (const { resourceId } of orphanedPersonalities) {
    const refs = findReferencingResources(resourceId, "personalities", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete personality "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  for (const { resourceId } of orphanedScenarios) {
    const refs = findReferencingResources(resourceId, "scenarios", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete scenario "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  for (const { resourceId } of orphanedSimulations) {
    const refs = findReferencingResources(resourceId, "simulations", loadedResources);
    if (refs.length > 0) {
      errors.push(`Cannot delete simulation "${resourceId}" - still referenced by: ${refs.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    console.error("\n❌ Orphan reference errors:\n");
    for (const error of errors) {
      console.error(`   ${error}`);
    }
    console.error("\n   Remove the references before deleting these resources.\n");
    throw new Error("Cannot delete resources that are still referenced");
  }

  // Dry-run mode (default): show what would be deleted
  if (!FORCE_DELETE) {
    console.log("  ⚠️  PENDING DELETIONS (dry-run mode):\n");
    for (const { resourceId, uuid, type } of allOrphaned) {
      console.log(`     🗑️  ${type}: ${resourceId} (${uuid})`);
    }
    console.log(`\n  📋 Total: ${allOrphaned.length} resource(s) pending deletion`);
    console.log("  ℹ️  These resources exist in Vapi but not in your local files.");
    console.log("  ℹ️  To delete them, run with --force flag:");
    console.log("     npm run apply:dev -- --force\n");
    console.log("  ℹ️  Or delete manually via Vapi Dashboard.\n");
    return;
  }

  // Force mode: actually delete
  console.log("  ⚠️  DELETING ORPHANED RESOURCES (--force enabled):\n");

  // Delete in reverse dependency order:
  // 1. Simulation suites (depends on simulations)
  // 2. Simulations (depends on personalities, scenarios)
  // 3. Scenarios, Personalities (no deps on other new types)
  // 4. Squads (depends on assistants)
  // 5. Assistants (depends on tools, structuredOutputs)
  // 6. Structured outputs
  // 7. Tools

  for (const { resourceId, uuid } of orphanedSimulationSuites) {
    try {
      console.log(`  🗑️  Deleting simulation suite: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.simulationSuites}/${uuid}`);
      delete state.simulationSuites[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete simulation suite ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedSimulations) {
    try {
      console.log(`  🗑️  Deleting simulation: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.simulations}/${uuid}`);
      delete state.simulations[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete simulation ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedScenarios) {
    try {
      console.log(`  🗑️  Deleting scenario: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.scenarios}/${uuid}`);
      delete state.scenarios[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete scenario ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedPersonalities) {
    try {
      console.log(`  🗑️  Deleting personality: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.personalities}/${uuid}`);
      delete state.personalities[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete personality ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedSquads) {
    try {
      console.log(`  🗑️  Deleting squad: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.squads}/${uuid}`);
      delete state.squads[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete squad ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedAssistants) {
    try {
      console.log(`  🗑️  Deleting assistant: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.assistants}/${uuid}`);
      delete state.assistants[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete assistant ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedOutputs) {
    try {
      console.log(`  🗑️  Deleting structured output: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.structuredOutputs}/${uuid}`);
      delete state.structuredOutputs[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete structured output ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedTools) {
    try {
      console.log(`  🗑️  Deleting tool: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP.tools}/${uuid}`);
      delete state.tools[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete tool ${resourceId}:`, error);
      throw error;
    }
  }

  console.log(`\n  ✅ Deleted ${allOrphaned.length} orphaned resource(s)\n`);
}

