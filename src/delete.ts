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

export interface ResourceReference {
  resourceId: string;
  resourceType: string;
}

export function findReferencingResources(
  targetId: string,
  targetType: ReferenceableType,
  allResources: LoadedResources
): ResourceReference[] {
  const referencingResources: ResourceReference[] = [];

  const checkResource = (resource: ResourceFile, resourceType: string) => {
    const refs = extractReferencedIds(resource.data as Record<string, unknown>);

    if (targetType === "tools" && refs.tools.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
    if (targetType === "structuredOutputs" && refs.structuredOutputs.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
    if (targetType === "assistants" && refs.assistants.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
    if (targetType === "personalities" && refs.personalities.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
    if (targetType === "scenarios" && refs.scenarios.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
    if (targetType === "simulations" && refs.simulations.includes(targetId)) {
      referencingResources.push({ resourceId: resource.resourceId, resourceType });
    }
  };

  // Check all resource types that might have references
  for (const resource of allResources.assistants) {
    checkResource(resource, "assistant");
  }
  for (const resource of allResources.structuredOutputs) {
    checkResource(resource, "structured output");
  }
  for (const resource of allResources.squads) {
    checkResource(resource, "squad");
  }
  for (const resource of allResources.simulations) {
    checkResource(resource, "simulation");
  }
  for (const resource of allResources.simulationSuites) {
    checkResource(resource, "simulation suite");
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

// Map display type back to ReferenceableType for reference checking
const REFERENCEABLE_TYPE_MAP: Record<string, ReferenceableType | null> = {
  "tool": "tools",
  "structured output": "structuredOutputs",
  "assistant": "assistants",
  "personality": "personalities",
  "scenario": "scenarios",
  "simulation": "simulations",
  "simulation suite": null, // not referenceable by others
  "squad": null,            // not referenceable by others
};

export async function deleteOrphanedResources(
  loadedResources: LoadedResources,
  state: StateFile,
  typesToDelete?: ResourceType[]
): Promise<void> {
  const shouldCheck = (type: ResourceType) =>
    !typesToDelete || typesToDelete.includes(type);

  // Find orphaned resources (only for applicable types)
  const orphanedTools = shouldCheck("tools")
    ? findOrphanedResources(loadedResources.tools.map((t) => t.resourceId), state.tools)
    : [];
  const orphanedOutputs = shouldCheck("structuredOutputs")
    ? findOrphanedResources(loadedResources.structuredOutputs.map((o) => o.resourceId), state.structuredOutputs)
    : [];
  const orphanedAssistants = shouldCheck("assistants")
    ? findOrphanedResources(loadedResources.assistants.map((a) => a.resourceId), state.assistants)
    : [];
  const orphanedSquads = shouldCheck("squads")
    ? findOrphanedResources(loadedResources.squads.map((s) => s.resourceId), state.squads)
    : [];
  const orphanedPersonalities = shouldCheck("personalities")
    ? findOrphanedResources(loadedResources.personalities.map((p) => p.resourceId), state.personalities)
    : [];
  const orphanedScenarios = shouldCheck("scenarios")
    ? findOrphanedResources(loadedResources.scenarios.map((s) => s.resourceId), state.scenarios)
    : [];
  const orphanedSimulations = shouldCheck("simulations")
    ? findOrphanedResources(loadedResources.simulations.map((s) => s.resourceId), state.simulations)
    : [];
  const orphanedSimulationSuites = shouldCheck("simulationSuites")
    ? findOrphanedResources(loadedResources.simulationSuites.map((s) => s.resourceId), state.simulationSuites)
    : [];

  // Collect all orphaned resources (in reverse dependency order for deletion)
  const allOrphaned = [
    ...orphanedSimulationSuites.map((r) => ({ ...r, type: "simulation suite" as const, stateKey: "simulationSuites" as ResourceType })),
    ...orphanedSimulations.map((r) => ({ ...r, type: "simulation" as const, stateKey: "simulations" as ResourceType })),
    ...orphanedScenarios.map((r) => ({ ...r, type: "scenario" as const, stateKey: "scenarios" as ResourceType })),
    ...orphanedPersonalities.map((r) => ({ ...r, type: "personality" as const, stateKey: "personalities" as ResourceType })),
    ...orphanedSquads.map((r) => ({ ...r, type: "squad" as const, stateKey: "squads" as ResourceType })),
    ...orphanedAssistants.map((r) => ({ ...r, type: "assistant" as const, stateKey: "assistants" as ResourceType })),
    ...orphanedOutputs.map((r) => ({ ...r, type: "structured output" as const, stateKey: "structuredOutputs" as ResourceType })),
    ...orphanedTools.map((r) => ({ ...r, type: "tool" as const, stateKey: "tools" as ResourceType })),
  ];

  // No orphaned resources - nothing to do
  if (allOrphaned.length === 0) {
    console.log("  ✅ No orphaned resources found\n");
    return;
  }

  // Check references for each orphaned resource - partition into safe and blocked
  const blocked: { resourceId: string; uuid: string; type: string; stateKey: ResourceType; refs: ResourceReference[] }[] = [];
  const safeToDelete: typeof allOrphaned = [];

  for (const orphan of allOrphaned) {
    const refType = REFERENCEABLE_TYPE_MAP[orphan.type];
    if (refType) {
      const refs = findReferencingResources(orphan.resourceId, refType, loadedResources);
      if (refs.length > 0) {
        blocked.push({ ...orphan, refs });
        continue;
      }
    }
    safeToDelete.push(orphan);
  }

  // Show blocked resources
  if (blocked.length > 0) {
    console.log("  ⛔ Cannot delete (still referenced):\n");
    for (const { resourceId, type, refs } of blocked) {
      console.log(`     ${type}: ${resourceId}`);
      for (const ref of refs) {
        console.log(`       ↳ referenced by ${ref.resourceType}: ${ref.resourceId}`);
      }
    }
    console.log("\n  ℹ️  Remove the references above before these resources can be deleted.\n");
  }

  // Nothing safe to delete
  if (safeToDelete.length === 0) {
    return;
  }

  // Dry-run mode (default): show what would be deleted
  if (!FORCE_DELETE) {
    console.log("  ⚠️  PENDING DELETIONS (dry-run mode):\n");
    for (const { resourceId, uuid, type } of safeToDelete) {
      console.log(`     🗑️  ${type}: ${resourceId} (${uuid})`);
    }
    console.log(`\n  📋 Total: ${safeToDelete.length} resource(s) pending deletion`);
    if (blocked.length > 0) {
      console.log(`  ⛔ Skipped: ${blocked.length} resource(s) still referenced`);
    }
    console.log("  ℹ️  These resources exist in Vapi but not in your local files.");
    console.log("  ℹ️  To delete them, run with --force flag:");
    console.log("     npm run apply:dev:force\n");
    return;
  }

  // Force mode: actually delete (already in reverse dependency order)
  console.log("  ⚠️  DELETING ORPHANED RESOURCES (--force enabled):\n");

  let deleted = 0;
  for (const { resourceId, uuid, type, stateKey } of safeToDelete) {
    try {
      console.log(`  🗑️  Deleting ${type}: ${resourceId} (${uuid})`);
      await vapiDelete(`${DELETE_ENDPOINT_MAP[stateKey]}/${uuid}`);
      delete state[stateKey][resourceId];
      deleted++;
    } catch (error) {
      console.error(`  ❌ Failed to delete ${type} ${resourceId}:`, error);
      throw error;
    }
  }

  console.log(`\n  ✅ Deleted ${deleted} orphaned resource(s)`);
  if (blocked.length > 0) {
    console.log(`  ⛔ Skipped ${blocked.length} resource(s) still referenced`);
  }
  console.log("");
}
