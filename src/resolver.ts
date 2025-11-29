import type { StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ID Resolution - Convert resource IDs to Vapi UUIDs
// ─────────────────────────────────────────────────────────────────────────────

export function resolveToolId(
  toolId: string,
  state: StateFile
): string | null {
  // Remove comments from YAML (e.g., "transfer-call ## Reference...")
  const cleanId = toolId.split("##")[0]?.trim() ?? "";
  const uuid = state.tools[cleanId];
  if (!uuid) {
    console.warn(`  ⚠️  Tool reference not found: ${cleanId}`);
    return null;
  }
  return uuid;
}

export function resolveToolIds(toolIds: string[], state: StateFile): string[] {
  return toolIds
    .map((refId: string) => resolveToolId(refId, state))
    .filter((id): id is string => id !== null);
}

export function resolveStructuredOutputIds(
  outputIds: string[],
  state: StateFile
): string[] {
  return outputIds
    .map((refId: string) => {
      const cleanId = refId.split("##")[0]?.trim() ?? "";
      const uuid = state.structuredOutputs[cleanId];
      if (!uuid) {
        console.warn(`  ⚠️  Structured output reference not found: ${cleanId}`);
        return null;
      }
      return uuid;
    })
    .filter((id): id is string => id !== null);
}

export function resolveAssistantId(
  assistantId: string,
  state: StateFile
): string | null {
  const cleanId = assistantId.split("##")[0]?.trim() ?? "";
  const uuid = state.assistants[cleanId];
  if (!uuid) {
    console.warn(`  ⚠️  Assistant reference not found: ${cleanId}`);
    return null;
  }
  return uuid;
}

export function resolveAssistantIds(
  assistantIds: string[],
  state: StateFile
): string[] {
  return assistantIds
    .map((refId: string) => resolveAssistantId(refId, state))
    .filter((id): id is string => id !== null);
}

export function resolveReferences(
  data: Record<string, unknown>,
  state: StateFile
): Record<string, unknown> {
  const resolved = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

  // Resolve toolIds at root level
  if (Array.isArray(resolved.toolIds)) {
    resolved.toolIds = resolveToolIds(resolved.toolIds as string[], state);
  }

  // Resolve toolIds inside model object
  if (resolved.model && typeof resolved.model === "object") {
    const model = resolved.model as Record<string, unknown>;
    if (Array.isArray(model.toolIds)) {
      model.toolIds = resolveToolIds(model.toolIds as string[], state);
    }
  }

  // Resolve structuredOutputIds in artifactPlan
  if (
    resolved.artifactPlan &&
    typeof resolved.artifactPlan === "object" &&
    Array.isArray(
      (resolved.artifactPlan as Record<string, unknown>).structuredOutputIds
    )
  ) {
    const artifactPlan = resolved.artifactPlan as Record<string, unknown>;
    artifactPlan.structuredOutputIds = resolveStructuredOutputIds(
      artifactPlan.structuredOutputIds as string[],
      state
    );
  }

  // Resolve assistant_ids in structured outputs
  if (Array.isArray(resolved.assistant_ids)) {
    resolved.assistantIds = resolveAssistantIds(
      resolved.assistant_ids as string[],
      state
    );
    delete resolved.assistant_ids; // Remove snake_case version
  }

  // Resolve workflow_ids in structured outputs
  if (Array.isArray(resolved.workflow_ids)) {
    resolved.workflowIds = resolved.workflow_ids.filter(Boolean);
    delete resolved.workflow_ids; // Remove snake_case version
  }

  // Resolve toolId in hooks[].do[] actions
  if (Array.isArray(resolved.hooks)) {
    for (const hook of resolved.hooks as Record<string, unknown>[]) {
      if (Array.isArray(hook.do)) {
        for (const action of hook.do as Record<string, unknown>[]) {
          if (typeof action.toolId === "string") {
            const resolvedId = resolveToolId(action.toolId, state);
            if (resolvedId) {
              action.toolId = resolvedId;
            }
          }
        }
      }
    }
  }

  // Resolve assistantId in destinations[] (for handoff tools)
  if (Array.isArray(resolved.destinations)) {
    for (const destination of resolved.destinations as Record<string, unknown>[]) {
      if (typeof destination.assistantId === "string") {
        const resolvedId = resolveAssistantId(destination.assistantId, state);
        if (resolvedId) {
          destination.assistantId = resolvedId;
        }
      }
    }
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Extraction - Find all IDs referenced in a resource
// ─────────────────────────────────────────────────────────────────────────────

export function extractReferencedIds(data: Record<string, unknown>): {
  tools: string[];
  structuredOutputs: string[];
  assistants: string[];
} {
  const tools: string[] = [];
  const structuredOutputs: string[] = [];
  const assistants: string[] = [];

  // Helper to clean IDs (remove comments)
  const cleanId = (id: string) => id.split("##")[0]?.trim() ?? "";

  // Check root level toolIds
  if (Array.isArray(data.toolIds)) {
    tools.push(...(data.toolIds as string[]).map(cleanId));
  }

  // Check model.toolIds
  if (data.model && typeof data.model === "object") {
    const model = data.model as Record<string, unknown>;
    if (Array.isArray(model.toolIds)) {
      tools.push(...(model.toolIds as string[]).map(cleanId));
    }
  }

  // Check artifactPlan.structuredOutputIds
  if (data.artifactPlan && typeof data.artifactPlan === "object") {
    const artifactPlan = data.artifactPlan as Record<string, unknown>;
    if (Array.isArray(artifactPlan.structuredOutputIds)) {
      structuredOutputs.push(
        ...(artifactPlan.structuredOutputIds as string[]).map(cleanId)
      );
    }
  }

  // Check assistant_ids in structured outputs
  if (Array.isArray(data.assistant_ids)) {
    assistants.push(...(data.assistant_ids as string[]).map(cleanId));
  }

  // Check hooks[].do[].toolId
  if (Array.isArray(data.hooks)) {
    for (const hook of data.hooks as Record<string, unknown>[]) {
      if (Array.isArray(hook.do)) {
        for (const action of hook.do as Record<string, unknown>[]) {
          if (typeof action.toolId === "string") {
            tools.push(cleanId(action.toolId));
          }
        }
      }
    }
  }

  // Check destinations[].assistantId (for handoff tools)
  if (Array.isArray(data.destinations)) {
    for (const destination of data.destinations as Record<string, unknown>[]) {
      if (typeof destination.assistantId === "string") {
        assistants.push(cleanId(destination.assistantId));
      }
    }
  }

  return { tools, structuredOutputs, assistants };
}

