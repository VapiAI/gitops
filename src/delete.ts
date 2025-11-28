import { vapiDelete } from "./api.ts";
import { extractReferencedIds } from "./resolver.ts";
import type {
  ResourceFile,
  StateFile,
  LoadedResources,
  OrphanedResource,
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

export function findReferencingResources(
  targetId: string,
  targetType: "tools" | "structuredOutputs" | "assistants",
  allResources: LoadedResources
): string[] {
  const referencingResources: string[] = [];

  const checkResource = (resource: ResourceFile) => {
    const refs = extractReferencedIds(resource.data as Record<string, unknown>);

    // resourceId already includes the full path (e.g., "assistants/healthcare/booking")
    if (targetType === "tools" && refs.tools.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
    if (
      targetType === "structuredOutputs" &&
      refs.structuredOutputs.includes(targetId)
    ) {
      referencingResources.push(resource.resourceId);
    }
    if (targetType === "assistants" && refs.assistants.includes(targetId)) {
      referencingResources.push(resource.resourceId);
    }
  };

  for (const resource of allResources.assistants) {
    checkResource(resource);
  }
  for (const resource of allResources.structuredOutputs) {
    checkResource(resource);
  }

  return referencingResources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Deletion
// ─────────────────────────────────────────────────────────────────────────────

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

  // Check for orphan references before deleting
  const errors: string[] = [];

  for (const { resourceId } of orphanedTools) {
    const refs = findReferencingResources(resourceId, "tools", loadedResources);
    if (refs.length > 0) {
      errors.push(
        `Cannot delete tool "${resourceId}" - still referenced by: ${refs.join(", ")}`
      );
    }
  }

  for (const { resourceId } of orphanedOutputs) {
    const refs = findReferencingResources(
      resourceId,
      "structuredOutputs",
      loadedResources
    );
    if (refs.length > 0) {
      errors.push(
        `Cannot delete structured output "${resourceId}" - still referenced by: ${refs.join(", ")}`
      );
    }
  }

  for (const { resourceId } of orphanedAssistants) {
    const refs = findReferencingResources(
      resourceId,
      "assistants",
      loadedResources
    );
    if (refs.length > 0) {
      errors.push(
        `Cannot delete assistant "${resourceId}" - still referenced by: ${refs.join(", ")}`
      );
    }
  }

  if (errors.length > 0) {
    console.error("\n❌ Orphan reference errors:\n");
    for (const error of errors) {
      console.error(`   ${error}`);
    }
    console.error(
      "\n   Remove the references before deleting these resources.\n"
    );
    throw new Error("Cannot delete resources that are still referenced");
  }

  // Delete in reverse dependency order: assistants → outputs → tools
  for (const { resourceId, uuid } of orphanedAssistants) {
    try {
      console.log(`  🗑️  Deleting assistant: ${resourceId} (${uuid})`);
      await vapiDelete(`/assistant/${uuid}`);
      delete state.assistants[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete assistant ${resourceId}:`, error);
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedOutputs) {
    try {
      console.log(`  🗑️  Deleting structured output: ${resourceId} (${uuid})`);
      await vapiDelete(`/structured-output/${uuid}`);
      delete state.structuredOutputs[resourceId];
    } catch (error) {
      console.error(
        `  ❌ Failed to delete structured output ${resourceId}:`,
        error
      );
      throw error;
    }
  }

  for (const { resourceId, uuid } of orphanedTools) {
    try {
      console.log(`  🗑️  Deleting tool: ${resourceId} (${uuid})`);
      await vapiDelete(`/tool/${uuid}`);
      delete state.tools[resourceId];
    } catch (error) {
      console.error(`  ❌ Failed to delete tool ${resourceId}:`, error);
      throw error;
    }
  }
}

