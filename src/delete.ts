import { VapiApiError, vapiDelete } from "./api.ts";
import { FORCE_DELETE, loadIgnorePatterns, matchesIgnore } from "./config.ts";
import { extractReferencedIds } from "./resolver.ts";
import { FOLDER_MAP } from "./resources.ts";
import type {
  LoadedResources,
  OrphanedResource,
  ResourceFile,
  ResourceState,
  ResourceType,
  StateFile,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Orphan Detection
// ─────────────────────────────────────────────────────────────────────────────

export function findOrphanedResources(
  loadedResourceIds: string[],
  stateResourceIds: Record<string, ResourceState>,
  ignoredIds?: Set<string>,
): OrphanedResource[] {
  const orphaned: OrphanedResource[] = [];

  for (const [resourceId, entry] of Object.entries(stateResourceIds)) {
    if (loadedResourceIds.includes(resourceId)) continue;
    // Data-safety: an id absent from local files BUT listed in .vapi-ignore
    // is an opt-out, not an orphan. Excluding here prevents `--force` push
    // from silently DELETE'ing dashboard resources the repo has explicitly
    // declined to manage.
    if (ignoredIds?.has(resourceId)) continue;
    orphaned.push({ resourceId, uuid: entry.uuid });
  }

  return orphaned;
}

// Compute the set of state-tracked ids that match the current .vapi-ignore
// for a given resource type. Used by `deleteOrphanedResources` to wire
// orphan-protect and to emit the "retained" log lines.
function computeIgnoredIds(
  type: ResourceType,
  stateSection: Record<string, ResourceState>,
  patterns: string[],
): { ignored: Set<string>; matched: Array<{ id: string; pattern: string }> } {
  const ignored = new Set<string>();
  const matched: Array<{ id: string; pattern: string }> = [];
  if (patterns.length === 0) return { ignored, matched };
  const folder = FOLDER_MAP[type];
  for (const resourceId of Object.keys(stateSection)) {
    const pattern = matchesIgnore(folder, resourceId, patterns);
    if (pattern) {
      ignored.add(resourceId);
      matched.push({ id: resourceId, pattern });
    }
  }
  return { ignored, matched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Checking - Find resources that reference a given resource
// ─────────────────────────────────────────────────────────────────────────────

type ReferenceableType =
  | "tools"
  | "structuredOutputs"
  | "assistants"
  | "personalities"
  | "scenarios"
  | "simulations";

export interface ResourceReference {
  resourceId: string;
  resourceType: string;
}

export function findReferencingResources(
  targetId: string,
  targetType: ReferenceableType,
  allResources: LoadedResources,
): ResourceReference[] {
  const referencingResources: ResourceReference[] = [];

  const checkResource = (resource: ResourceFile, resourceType: string) => {
    const refs = extractReferencedIds(resource.data as Record<string, unknown>);

    if (targetType === "tools" && refs.tools.includes(targetId)) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
    }
    if (
      targetType === "structuredOutputs" &&
      refs.structuredOutputs.includes(targetId)
    ) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
    }
    if (targetType === "assistants" && refs.assistants.includes(targetId)) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
    }
    if (
      targetType === "personalities" &&
      refs.personalities.includes(targetId)
    ) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
    }
    if (targetType === "scenarios" && refs.scenarios.includes(targetId)) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
    }
    if (targetType === "simulations" && refs.simulations.includes(targetId)) {
      referencingResources.push({
        resourceId: resource.resourceId,
        resourceType,
      });
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
  evals: "/eval",
};

// Map display type back to ReferenceableType for reference checking
const REFERENCEABLE_TYPE_MAP: Record<string, ReferenceableType | null> = {
  tool: "tools",
  "structured output": "structuredOutputs",
  assistant: "assistants",
  personality: "personalities",
  scenario: "scenarios",
  simulation: "simulations",
  "simulation suite": null, // not referenceable by others
  squad: null, // not referenceable by others
  eval: null, // not referenceable by others
};

export async function deleteOrphanedResources(
  loadedResources: LoadedResources,
  state: StateFile,
  typesToDelete?: ResourceType[],
): Promise<void> {
  const shouldCheck = (type: ResourceType) =>
    !typesToDelete || typesToDelete.includes(type);

  // Orphan-protect: always honor .vapi-ignore here, even under `--force`,
  // so an opt-out can't be silently DELETEd.
  const patterns = loadIgnorePatterns();
  const ignoredByType: Record<
    ResourceType,
    { ignored: Set<string>; matched: Array<{ id: string; pattern: string }> }
  > = {
    tools: computeIgnoredIds("tools", state.tools, patterns),
    structuredOutputs: computeIgnoredIds(
      "structuredOutputs",
      state.structuredOutputs,
      patterns,
    ),
    assistants: computeIgnoredIds("assistants", state.assistants, patterns),
    squads: computeIgnoredIds("squads", state.squads, patterns),
    personalities: computeIgnoredIds(
      "personalities",
      state.personalities,
      patterns,
    ),
    scenarios: computeIgnoredIds("scenarios", state.scenarios, patterns),
    simulations: computeIgnoredIds("simulations", state.simulations, patterns),
    simulationSuites: computeIgnoredIds(
      "simulationSuites",
      state.simulationSuites,
      patterns,
    ),
    evals: computeIgnoredIds("evals", state.evals, patterns),
  };

  const retainedLogLines: string[] = [];
  for (const [type, { matched }] of Object.entries(ignoredByType) as Array<
    [ResourceType, (typeof ignoredByType)[ResourceType]]
  >) {
    for (const { id } of matched) {
      // Only emit the retained line when the id WOULD have been an orphan
      // (i.e., not present in the loaded set). A still-loaded id is not at
      // risk of orphan deletion and logging it would be noise.
      const loadedIds = loadedResources[type].map((r) => r.resourceId);
      if (!loadedIds.includes(id)) {
        retainedLogLines.push(
          `  🚫 ${type}/${id} retained (matched .vapi-ignore — orphan-protected)`,
        );
      }
    }
  }

  // Find orphaned resources (only for applicable types)
  const orphanedTools = shouldCheck("tools")
    ? findOrphanedResources(
        loadedResources.tools.map((t) => t.resourceId),
        state.tools,
        ignoredByType.tools.ignored,
      )
    : [];
  const orphanedOutputs = shouldCheck("structuredOutputs")
    ? findOrphanedResources(
        loadedResources.structuredOutputs.map((o) => o.resourceId),
        state.structuredOutputs,
        ignoredByType.structuredOutputs.ignored,
      )
    : [];
  const orphanedAssistants = shouldCheck("assistants")
    ? findOrphanedResources(
        loadedResources.assistants.map((a) => a.resourceId),
        state.assistants,
        ignoredByType.assistants.ignored,
      )
    : [];
  const orphanedSquads = shouldCheck("squads")
    ? findOrphanedResources(
        loadedResources.squads.map((s) => s.resourceId),
        state.squads,
        ignoredByType.squads.ignored,
      )
    : [];
  const orphanedPersonalities = shouldCheck("personalities")
    ? findOrphanedResources(
        loadedResources.personalities.map((p) => p.resourceId),
        state.personalities,
        ignoredByType.personalities.ignored,
      )
    : [];
  const orphanedScenarios = shouldCheck("scenarios")
    ? findOrphanedResources(
        loadedResources.scenarios.map((s) => s.resourceId),
        state.scenarios,
        ignoredByType.scenarios.ignored,
      )
    : [];
  const orphanedSimulations = shouldCheck("simulations")
    ? findOrphanedResources(
        loadedResources.simulations.map((s) => s.resourceId),
        state.simulations,
        ignoredByType.simulations.ignored,
      )
    : [];
  const orphanedSimulationSuites = shouldCheck("simulationSuites")
    ? findOrphanedResources(
        loadedResources.simulationSuites.map((s) => s.resourceId),
        state.simulationSuites,
        ignoredByType.simulationSuites.ignored,
      )
    : [];
  const orphanedEvals = shouldCheck("evals")
    ? findOrphanedResources(
        loadedResources.evals.map((e) => e.resourceId),
        state.evals,
        ignoredByType.evals.ignored,
      )
    : [];

  if (retainedLogLines.length > 0) {
    for (const line of retainedLogLines) console.log(line);
  }

  // Collect all orphaned resources (in reverse dependency order for deletion)
  const allOrphaned = [
    ...orphanedEvals.map((r) => ({
      ...r,
      type: "eval" as const,
      stateKey: "evals" as ResourceType,
    })),
    ...orphanedSimulationSuites.map((r) => ({
      ...r,
      type: "simulation suite" as const,
      stateKey: "simulationSuites" as ResourceType,
    })),
    ...orphanedSimulations.map((r) => ({
      ...r,
      type: "simulation" as const,
      stateKey: "simulations" as ResourceType,
    })),
    ...orphanedScenarios.map((r) => ({
      ...r,
      type: "scenario" as const,
      stateKey: "scenarios" as ResourceType,
    })),
    ...orphanedPersonalities.map((r) => ({
      ...r,
      type: "personality" as const,
      stateKey: "personalities" as ResourceType,
    })),
    ...orphanedSquads.map((r) => ({
      ...r,
      type: "squad" as const,
      stateKey: "squads" as ResourceType,
    })),
    ...orphanedAssistants.map((r) => ({
      ...r,
      type: "assistant" as const,
      stateKey: "assistants" as ResourceType,
    })),
    ...orphanedOutputs.map((r) => ({
      ...r,
      type: "structured output" as const,
      stateKey: "structuredOutputs" as ResourceType,
    })),
    ...orphanedTools.map((r) => ({
      ...r,
      type: "tool" as const,
      stateKey: "tools" as ResourceType,
    })),
  ];

  // No orphaned resources - nothing to do
  if (allOrphaned.length === 0) {
    console.log("  ✅ No orphaned resources found\n");
    return;
  }

  // Check references for each orphaned resource - partition into safe and blocked
  const blocked: {
    resourceId: string;
    uuid: string;
    type: string;
    stateKey: ResourceType;
    refs: ResourceReference[];
  }[] = [];
  const safeToDelete: typeof allOrphaned = [];

  for (const orphan of allOrphaned) {
    const refType = REFERENCEABLE_TYPE_MAP[orphan.type];
    if (refType) {
      const refs = findReferencingResources(
        orphan.resourceId,
        refType,
        loadedResources,
      );
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
        console.log(
          `       ↳ referenced by ${ref.resourceType}: ${ref.resourceId}`,
        );
      }
    }
    console.log(
      "\n  ℹ️  Remove the references above before these resources can be deleted.\n",
    );
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
    console.log(
      `\n  📋 Total: ${safeToDelete.length} resource(s) pending deletion`,
    );
    if (blocked.length > 0) {
      console.log(
        `  ⛔ Skipped: ${blocked.length} resource(s) still referenced`,
      );
    }
    console.log(
      "  ℹ️  These resources exist in Vapi but not in your local files.",
    );
    console.log("  ℹ️  To delete them, run with --force flag:");
    console.log("     npm run push -- <org> --force\n");
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
      const msg =
        error instanceof VapiApiError
          ? error.apiMessage
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(`  ❌ Failed to delete ${type} ${resourceId}: ${msg}`);
      throw error;
    }
  }

  console.log(`\n  ✅ Deleted ${deleted} orphaned resource(s)`);
  if (blocked.length > 0) {
    console.log(`  ⛔ Skipped ${blocked.length} resource(s) still referenced`);
  }
  console.log("");
}
