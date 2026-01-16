import { mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { stringify } from "yaml";
import { VAPI_ENV, VAPI_BASE_URL, VAPI_TOKEN, RESOURCES_DIR } from "./config.ts";
import { loadState, saveState } from "./state.ts";
import type { StateFile, ResourceType } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface VapiResource {
  id: string;
  name?: string;
  [key: string]: unknown;
}

// Fields to remove from resources before saving (server-managed fields)
const EXCLUDED_FIELDS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
];

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllResources(resourceType: ResourceType): Promise<VapiResource[]> {
  const endpoint = resourceType === "structuredOutputs" 
    ? "/structured-output" 
    : `/${resourceType.replace(/s$/, "")}`;
  
  const url = `${VAPI_BASE_URL}${endpoint}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${VAPI_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API GET ${endpoint} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<VapiResource[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming & Slug Generation
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function generateResourceId(resource: VapiResource, existingIds: Set<string>): string {
  // Use name if available, otherwise use type + short id
  const baseName = resource.name 
    ? slugify(resource.name)
    : `resource-${resource.id.slice(0, 8)}`;
  
  let resourceId = baseName;
  let counter = 1;
  
  // Ensure uniqueness
  while (existingIds.has(resourceId)) {
    resourceId = `${baseName}-${counter}`;
    counter++;
  }
  
  return resourceId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Processing
// ─────────────────────────────────────────────────────────────────────────────

function cleanResource(resource: VapiResource): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(resource)) {
    if (!EXCLUDED_FIELDS.includes(key) && value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  
  return cleaned;
}

function buildReverseMap(state: StateFile, resourceType: ResourceType): Map<string, string> {
  // uuid -> resourceId
  const map = new Map<string, string>();
  const stateSection = state[resourceType];
  
  for (const [resourceId, uuid] of Object.entries(stateSection)) {
    map.set(uuid, resourceId);
  }
  
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Resolution (UUID -> resourceId)
// ─────────────────────────────────────────────────────────────────────────────

function resolveReferencesToResourceIds(
  resource: Record<string, unknown>,
  state: StateFile
): Record<string, unknown> {
  const toolsMap = buildReverseMap(state, "tools");
  const assistantsMap = buildReverseMap(state, "assistants");
  const structuredOutputsMap = buildReverseMap(state, "structuredOutputs");
  
  const resolved = { ...resource };
  
  // Resolve toolIds in model
  if (resolved.model && typeof resolved.model === "object") {
    const model = { ...(resolved.model as Record<string, unknown>) };
    if (Array.isArray(model.toolIds)) {
      model.toolIds = model.toolIds.map((uuid: string) => 
        toolsMap.get(uuid) ?? uuid
      );
    }
    resolved.model = model;
  }
  
  // Resolve structuredOutputIds in artifactPlan
  if (resolved.artifactPlan && typeof resolved.artifactPlan === "object") {
    const artifactPlan = { ...(resolved.artifactPlan as Record<string, unknown>) };
    if (Array.isArray(artifactPlan.structuredOutputIds)) {
      artifactPlan.structuredOutputIds = artifactPlan.structuredOutputIds.map((uuid: string) =>
        structuredOutputsMap.get(uuid) ?? uuid
      );
    }
    resolved.artifactPlan = artifactPlan;
  }
  
  // Resolve assistant_ids in structured outputs
  if (Array.isArray(resolved.assistant_ids)) {
    resolved.assistant_ids = (resolved.assistant_ids as string[]).map((uuid: string) =>
      assistantsMap.get(uuid) ?? uuid
    );
  }
  
  // Resolve assistantId in tool destinations (handoff tools)
  if (Array.isArray(resolved.destinations)) {
    resolved.destinations = (resolved.destinations as Record<string, unknown>[]).map((dest) => {
      if (typeof dest.assistantId === "string") {
        return {
          ...dest,
          assistantId: assistantsMap.get(dest.assistantId) ?? dest.assistantId,
        };
      }
      return dest;
    });
  }
  
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Writing
// ─────────────────────────────────────────────────────────────────────────────

async function writeResourceFile(
  resourceType: ResourceType,
  resourceId: string,
  data: Record<string, unknown>
): Promise<string> {
  const dir = join(RESOURCES_DIR, resourceType);
  const filePath = join(dir, `${resourceId}.yml`);
  
  // Ensure directory exists
  await mkdir(dirname(filePath), { recursive: true });
  
  // Convert to YAML and write
  const yamlContent = stringify(data, {
    lineWidth: 0, // Don't wrap lines
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
  
  await writeFile(filePath, yamlContent);
  
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface PullStats {
  created: number;
  updated: number;
}

export async function pullResourceType(
  resourceType: ResourceType,
  state: StateFile
): Promise<PullStats> {
  console.log(`\n📥 Pulling ${resourceType}...`);
  
  const resources = await fetchAllResources(resourceType);
  console.log(`   Found ${resources.length} ${resourceType} in Vapi`);
  
  const reverseMap = buildReverseMap(state, resourceType);
  const existingIds = new Set(Object.keys(state[resourceType]));
  const newStateSection: Record<string, string> = {};
  
  let created = 0;
  let updated = 0;
  
  for (const resource of resources) {
    // Check if we already have this resource in state (by UUID)
    let resourceId = reverseMap.get(resource.id);
    const isNew = !resourceId;
    
    if (!resourceId) {
      // Generate new resource ID
      resourceId = generateResourceId(resource, existingIds);
      existingIds.add(resourceId);
      created++;
    } else {
      updated++;
    }
    
    // Clean and resolve references
    const cleaned = cleanResource(resource);
    const resolved = resolveReferencesToResourceIds(cleaned, state);
    
    // Write to file
    const filePath = await writeResourceFile(resourceType, resourceId, resolved);
    console.log(`   ${isNew ? "✨" : "📝"} ${resourceId} -> ${filePath}`);
    
    // Update state
    newStateSection[resourceId] = resource.id;
  }
  
  // Update state with new mappings
  state[resourceType] = newStateSection;
  
  return { created, updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pull Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🔄 Vapi GitOps Pull - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const state = loadState();

  const stats: Record<string, PullStats> = {
    tools: { created: 0, updated: 0 },
    structuredOutputs: { created: 0, updated: 0 },
    assistants: { created: 0, updated: 0 },
  };

  // Pull in dependency order (tools first, then structured outputs, then assistants)
  stats.tools = await pullResourceType("tools", state);
  stats.structuredOutputs = await pullResourceType("structuredOutputs", state);
  stats.assistants = await pullResourceType("assistants", state);

  // Save updated state
  await saveState(state);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Pull complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("📋 Summary:");
  for (const [type, { created, updated }] of Object.entries(stats)) {
    console.log(`   ${type}: ${created} new, ${updated} existing`);
  }
}

// Run the pull engine
main().catch((error) => {
  console.error("\n❌ Pull failed:", error);
  process.exit(1);
});
