import type { StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ID Resolution - Convert resource IDs to Vapi UUIDs
// ─────────────────────────────────────────────────────────────────────────────

// UUID regex pattern - matches standard UUID format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function resolveToolId(
  toolId: string,
  state: StateFile
): string | null {
  // Remove comments from YAML (e.g., "transfer-call ## Reference...")
  const cleanId = toolId.split("##")[0]?.trim() ?? "";
  
  // If already a UUID, return it directly
  if (isUUID(cleanId)) {
    return cleanId;
  }
  
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
      
      // If already a UUID, return it directly
      if (isUUID(cleanId)) {
        return cleanId;
      }
      
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
  
  // If already a UUID, return it directly
  if (isUUID(cleanId)) {
    return cleanId;
  }
  
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

export function resolvePersonalityId(
  personalityId: string,
  state: StateFile
): string | null {
  const cleanId = personalityId.split("##")[0]?.trim() ?? "";
  
  // If already a UUID, return it directly
  if (isUUID(cleanId)) {
    return cleanId;
  }
  
  const uuid = state.personalities[cleanId];
  if (!uuid) {
    console.warn(`  ⚠️  Personality reference not found: ${cleanId}`);
    return null;
  }
  return uuid;
}

export function resolveScenarioId(
  scenarioId: string,
  state: StateFile
): string | null {
  const cleanId = scenarioId.split("##")[0]?.trim() ?? "";
  
  // If already a UUID, return it directly
  if (isUUID(cleanId)) {
    return cleanId;
  }
  
  const uuid = state.scenarios[cleanId];
  if (!uuid) {
    console.warn(`  ⚠️  Scenario reference not found: ${cleanId}`);
    return null;
  }
  return uuid;
}

export function resolveSimulationId(
  simulationId: string,
  state: StateFile
): string | null {
  const cleanId = simulationId.split("##")[0]?.trim() ?? "";
  
  // If already a UUID, return it directly
  if (isUUID(cleanId)) {
    return cleanId;
  }
  
  const uuid = state.simulations[cleanId];
  if (!uuid) {
    console.warn(`  ⚠️  Simulation reference not found: ${cleanId}`);
    return null;
  }
  return uuid;
}

export function resolveSimulationIds(
  simulationIds: string[],
  state: StateFile
): string[] {
  return simulationIds
    .map((refId: string) => resolveSimulationId(refId, state))
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

  // Resolve members[].assistantId in squads
  if (Array.isArray(resolved.members)) {
    for (const member of resolved.members as Record<string, unknown>[]) {
      if (typeof member.assistantId === "string") {
        const resolvedId = resolveAssistantId(member.assistantId, state);
        if (resolvedId) {
          member.assistantId = resolvedId;
        }
      }
      // Resolve assistantDestinations[].assistantId
      if (Array.isArray(member.assistantDestinations)) {
        for (const dest of member.assistantDestinations as Record<string, unknown>[]) {
          if (typeof dest.assistantId === "string") {
            const resolvedId = resolveAssistantId(dest.assistantId, state);
            if (resolvedId) {
              dest.assistantId = resolvedId;
            }
          }
        }
      }
    }
  }

  // Resolve personalityId in simulations
  if (typeof resolved.personalityId === "string") {
    const resolvedId = resolvePersonalityId(resolved.personalityId, state);
    if (resolvedId) {
      resolved.personalityId = resolvedId;
    }
  }

  // Resolve scenarioId in simulations
  if (typeof resolved.scenarioId === "string") {
    const resolvedId = resolveScenarioId(resolved.scenarioId, state);
    if (resolvedId) {
      resolved.scenarioId = resolvedId;
    }
  }

  // Resolve simulationIds in simulation suites
  if (Array.isArray(resolved.simulationIds)) {
    resolved.simulationIds = resolveSimulationIds(
      resolved.simulationIds as string[],
      state
    );
  }

  // Resolve evaluations[].structuredOutputId in scenarios
  if (Array.isArray(resolved.evaluations)) {
    for (const evaluation of resolved.evaluations as Record<string, unknown>[]) {
      if (typeof evaluation.structuredOutputId === "string") {
        const cleanId = evaluation.structuredOutputId.split("##")[0]?.trim() ?? "";
        
        // If already a UUID, keep it as-is
        if (isUUID(cleanId)) {
          evaluation.structuredOutputId = cleanId;
        } else {
          const uuid = state.structuredOutputs[cleanId];
          if (uuid) {
            evaluation.structuredOutputId = uuid;
          } else {
            console.warn(`  ⚠️  Structured output reference not found in evaluation: ${cleanId}`);
          }
        }
      }
    }
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Extraction - Find all IDs referenced in a resource
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedReferences {
  tools: string[];
  structuredOutputs: string[];
  assistants: string[];
  personalities: string[];
  scenarios: string[];
  simulations: string[];
}

export function extractReferencedIds(data: Record<string, unknown>): ExtractedReferences {
  const tools: string[] = [];
  const structuredOutputs: string[] = [];
  const assistants: string[] = [];
  const personalities: string[] = [];
  const scenarios: string[] = [];
  const simulations: string[] = [];

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

  // Check members[].assistantId in squads
  if (Array.isArray(data.members)) {
    for (const member of data.members as Record<string, unknown>[]) {
      if (typeof member.assistantId === "string") {
        assistants.push(cleanId(member.assistantId));
      }
      // Check assistantDestinations[].assistantId
      if (Array.isArray(member.assistantDestinations)) {
        for (const dest of member.assistantDestinations as Record<string, unknown>[]) {
          if (typeof dest.assistantId === "string") {
            assistants.push(cleanId(dest.assistantId));
          }
        }
      }
    }
  }

  // Check personalityId in simulations
  if (typeof data.personalityId === "string") {
    personalities.push(cleanId(data.personalityId));
  }

  // Check scenarioId in simulations
  if (typeof data.scenarioId === "string") {
    scenarios.push(cleanId(data.scenarioId));
  }

  // Check simulationIds in simulation suites
  if (Array.isArray(data.simulationIds)) {
    simulations.push(...(data.simulationIds as string[]).map(cleanId));
  }

  return { tools, structuredOutputs, assistants, personalities, scenarios, simulations };
}

