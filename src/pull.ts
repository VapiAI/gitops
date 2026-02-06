import { execSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join, dirname, relative } from "path";
import { stringify } from "yaml";
import { VAPI_ENV, VAPI_BASE_URL, VAPI_TOKEN, RESOURCES_DIR, BASE_DIR } from "./config.ts";
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

// Fields to remove from resources before saving (server-managed or computed fields)
const EXCLUDED_FIELDS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
  // Computed/derived fields that shouldn't be synced back
  "isServerUrlSecretSet",  // Computed: indicates if server URL secret is set
  "workflowIds",           // Server-managed: workflows are a separate resource type
];

// Map resource types to their API endpoints
const ENDPOINT_MAP: Record<ResourceType, string> = {
  tools: "/tool",
  structuredOutputs: "/structured-output",
  assistants: "/assistant",
  squads: "/squad",
  personalities: "/eval/simulation/personality",
  scenarios: "/eval/simulation/scenario",
  simulations: "/eval/simulation",
  simulationSuites: "/eval/simulation/suite",
};

// Map resource types to their folder paths (relative to resources/)
const FOLDER_MAP: Record<ResourceType, string> = {
  tools: "tools",
  structuredOutputs: "structuredOutputs",
  assistants: "assistants",
  squads: "squads",
  personalities: "simulations/personalities",
  scenarios: "simulations/scenarios",
  simulations: "simulations/tests",
  simulationSuites: "simulations/suites",
};

// ─────────────────────────────────────────────────────────────────────────────
// Git Helpers (detect locally changed files to skip during pull)
// ─────────────────────────────────────────────────────────────────────────────

function gitCmd(args: string): string {
  return execSync(`git ${args}`, {
    cwd: BASE_DIR,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function isGitRepo(): boolean {
  try { gitCmd("rev-parse --is-inside-work-tree"); return true; } catch { return false; }
}

function gitHasCommits(): boolean {
  try { gitCmd("rev-parse HEAD"); return true; } catch { return false; }
}

// Returns relative paths of all locally modified, deleted, or untracked files
function getLocallyChangedFiles(): Set<string> {
  const status = gitCmd("status --porcelain");
  const files = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    // format: XY filename  (or XY "filename" for special chars)
    let filePath = line.slice(3);
    // Handle renames: "old -> new"
    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4);
    // Strip quotes if present
    filePath = filePath.replace(/^"|"$/g, "").trim();
    files.add(filePath);
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllResources(resourceType: ResourceType): Promise<VapiResource[]> {
  const endpoint = ENDPOINT_MAP[resourceType];
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

  const data = await response.json();
  
  // Handle paginated response format (e.g., structured-output returns { results: [], metadata: {} })
  if (data && typeof data === "object" && "results" in data && Array.isArray(data.results)) {
    return data.results as VapiResource[];
  }
  
  return data as VapiResource[];
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

function extractName(resource: VapiResource): string | undefined {
  if (resource.name) return resource.name;
  // Tools store their name under function.name
  const fn = resource.function as Record<string, unknown> | undefined;
  if (fn?.name && typeof fn.name === "string") return fn.name;
  return undefined;
}

function generateResourceId(resource: VapiResource, existingIds: Set<string>): string {
  const name = extractName(resource);
  const baseName = name
    ? slugify(name)
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
  const personalitiesMap = buildReverseMap(state, "personalities");
  const scenariosMap = buildReverseMap(state, "scenarios");
  const simulationsMap = buildReverseMap(state, "simulations");
  
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
  
  // Resolve assistantIds in structured outputs (API returns camelCase)
  if (Array.isArray(resolved.assistantIds)) {
    resolved.assistant_ids = (resolved.assistantIds as string[]).map((uuid: string) =>
      assistantsMap.get(uuid) ?? uuid
    );
    delete resolved.assistantIds;
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
  
  // Resolve members[].assistantId in squads
  if (Array.isArray(resolved.members)) {
    resolved.members = (resolved.members as Record<string, unknown>[]).map((member) => {
      const resolvedMember = { ...member };
      if (typeof member.assistantId === "string") {
        resolvedMember.assistantId = assistantsMap.get(member.assistantId) ?? member.assistantId;
      }
      // Resolve assistantDestinations[].assistantId
      if (Array.isArray(member.assistantDestinations)) {
        resolvedMember.assistantDestinations = (member.assistantDestinations as Record<string, unknown>[]).map((dest) => {
          if (typeof dest.assistantId === "string") {
            return { ...dest, assistantId: assistantsMap.get(dest.assistantId) ?? dest.assistantId };
          }
          return dest;
        });
      }
      return resolvedMember;
    });
  }
  
  // Resolve personalityId in simulations
  if (typeof resolved.personalityId === "string") {
    resolved.personalityId = personalitiesMap.get(resolved.personalityId) ?? resolved.personalityId;
  }
  
  // Resolve scenarioId in simulations
  if (typeof resolved.scenarioId === "string") {
    resolved.scenarioId = scenariosMap.get(resolved.scenarioId) ?? resolved.scenarioId;
  }
  
  // Resolve simulationIds in simulation suites
  if (Array.isArray(resolved.simulationIds)) {
    resolved.simulationIds = (resolved.simulationIds as string[]).map((uuid: string) =>
      simulationsMap.get(uuid) ?? uuid
    );
  }
  
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract system prompt from model.messages if present
 * Returns the system prompt content and the cleaned data (without system message)
 */
function extractSystemPrompt(data: Record<string, unknown>): { systemPrompt: string | null; cleanedData: Record<string, unknown> } {
  const model = data.model as Record<string, unknown> | undefined;
  if (!model || !Array.isArray(model.messages)) {
    return { systemPrompt: null, cleanedData: data };
  }
  
  const messages = model.messages as Array<{ role?: string; content?: string }>;
  const systemMessage = messages.find(m => m.role === "system");
  
  if (!systemMessage?.content) {
    return { systemPrompt: null, cleanedData: data };
  }
  
  // Remove system message from messages array
  const remainingMessages = messages.filter(m => m.role !== "system");
  
  // Create cleaned data without system message
  const cleanedData = { ...data };
  const cleanedModel = { ...model };
  
  if (remainingMessages.length > 0) {
    cleanedModel.messages = remainingMessages;
  } else {
    delete cleanedModel.messages;
  }
  
  cleanedData.model = cleanedModel;
  
  return { systemPrompt: systemMessage.content, cleanedData };
}

// Deterministic key ordering: 'name' first, then alphabetical
// Applied to all levels (top-level and nested objects) for stable diffs
const sortMapEntries = (a: { key: unknown }, b: { key: unknown }): number => {
  const aKey = String(a.key);
  const bKey = String(b.key);
  if (aKey === "name") return -1;
  if (bKey === "name") return 1;
  return aKey.localeCompare(bKey);
};

const YAML_OPTIONS = {
  lineWidth: 0,
  defaultStringType: "PLAIN" as const,
  defaultKeyType: "PLAIN" as const,
  sortMapEntries,
};

async function writeResourceFile(
  resourceType: ResourceType,
  resourceId: string,
  data: Record<string, unknown>
): Promise<string> {
  const folderPath = FOLDER_MAP[resourceType];
  const dir = join(RESOURCES_DIR, folderPath);
  
  // For assistants, check if there's a system prompt to extract
  if (resourceType === "assistants") {
    const { systemPrompt, cleanedData } = extractSystemPrompt(data);
    
    if (systemPrompt) {
      // Write as .md with frontmatter
      const filePath = join(dir, `${resourceId}.md`);
      await mkdir(dirname(filePath), { recursive: true });
      
      const yamlContent = stringify(cleanedData, YAML_OPTIONS);
      
      const mdContent = `---\n${yamlContent}---\n\n${systemPrompt}\n`;
      await writeFile(filePath, mdContent);
      
      return filePath;
    }
  }
  
  // Default: write as .yml
  const filePath = join(dir, `${resourceId}.yml`);
  await mkdir(dirname(filePath), { recursive: true });
  
  const yamlContent = stringify(data, YAML_OPTIONS);
  
  await writeFile(filePath, yamlContent);
  
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface PullStats {
  created: number;
  updated: number;
  skipped: number;
}

export async function pullResourceType(
  resourceType: ResourceType,
  state: StateFile,
  changedFiles?: Set<string>,
): Promise<PullStats> {
  console.log(`\n📥 Pulling ${resourceType}...`);
  
  const resources = await fetchAllResources(resourceType) ?? [];
  
  if (!Array.isArray(resources)) {
    console.log(`   ⚠️  No ${resourceType} found (API returned non-array)`);
    return { created: 0, updated: 0, skipped: 0 };
  }
  
  console.log(`   Found ${resources.length} ${resourceType} in Vapi`);

  const reverseMap = buildReverseMap(state, resourceType);
  const existingIds = new Set(Object.keys(state[resourceType]));
  const newStateSection: Record<string, string> = {};

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const resource of resources) {
    // Check if we already have this resource in state (by UUID)
    let resourceId = reverseMap.get(resource.id);
    const isNew = !resourceId;
    
    if (!resourceId) {
      // Generate new resource ID
      resourceId = generateResourceId(resource, existingIds);
      existingIds.add(resourceId);
    }

    // Skip files that have been locally modified or deleted (default mode)
    if (changedFiles) {
      const folderPath = FOLDER_MAP[resourceType];
      const mdPath = join("resources", folderPath, `${resourceId}.md`);
      const ymlPath = join("resources", folderPath, `${resourceId}.yml`);
      if (changedFiles.has(mdPath) || changedFiles.has(ymlPath)) {
        console.log(`   ⏭️  ${resourceId} (locally changed, skipping)`);
        newStateSection[resourceId] = resource.id;
        skipped++;
        continue;
      }
    }
    
    // Detect platform defaults (orgId is null/missing — read-only, immutable)
    const isPlatformDefault = resource.orgId === null || resource.orgId === undefined;

    // Clean and resolve references
    const cleaned = cleanResource(resource);
    const resolved = resolveReferencesToResourceIds(cleaned, state);

    // Mark platform defaults so apply skips them
    if (isPlatformDefault) {
      resolved._platformDefault = true;
    }
    
    // Write to file
    const filePath = await writeResourceFile(resourceType, resourceId, resolved);
    const icon = isPlatformDefault ? "🔒" : isNew ? "✨" : "📝";
    const relPath = relative(BASE_DIR, filePath);
    console.log(`   ${icon} ${resourceId} -> ${relPath}${isPlatformDefault ? " (platform default, read-only)" : ""}`);
    
    if (isNew) created++;
    else updated++;

    // Update state
    newStateSection[resourceId] = resource.id;
  }
  
  // Update state with new mappings
  state[resourceType] = newStateSection;
  
  return { created, updated, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pull Engine
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🔄 Vapi GitOps Pull - Environment: ${VAPI_ENV}${force ? " (force)" : ""}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Default mode: skip locally changed files (local is source of truth)
  // Force mode: overwrite everything (platform is source of truth)
  let changedFiles: Set<string> | undefined;
  const gitEnabled = !force && isGitRepo() && gitHasCommits();

  if (gitEnabled) {
    changedFiles = getLocallyChangedFiles();
    // Only keep resource files — non-resource changes don't matter
    for (const f of changedFiles) {
      if (!f.startsWith("resources/")) changedFiles.delete(f);
    }
    if (changedFiles.size > 0) {
      console.log(`\n📦 ${changedFiles.size} locally changed file(s) will be preserved`);
      console.log("   Use --force to overwrite all local files with platform state");
    }
  } else if (force) {
    console.log("\n⚡ Force mode: overwriting all local files with platform state");
  }

  const state = loadState();

  const zero: PullStats = { created: 0, updated: 0, skipped: 0 };
  const stats: Record<string, PullStats> = {
    tools: { ...zero },
    structuredOutputs: { ...zero },
    assistants: { ...zero },
    squads: { ...zero },
    personalities: { ...zero },
    scenarios: { ...zero },
    simulations: { ...zero },
    simulationSuites: { ...zero },
  };

  // Pull in dependency order
  stats.tools = await pullResourceType("tools", state, changedFiles);
  stats.structuredOutputs = await pullResourceType("structuredOutputs", state, changedFiles);
  stats.assistants = await pullResourceType("assistants", state, changedFiles);
  stats.squads = await pullResourceType("squads", state, changedFiles);
  stats.personalities = await pullResourceType("personalities", state, changedFiles);
  stats.scenarios = await pullResourceType("scenarios", state, changedFiles);
  stats.simulations = await pullResourceType("simulations", state, changedFiles);
  stats.simulationSuites = await pullResourceType("simulationSuites", state, changedFiles);

  await saveState(state);

  // Summary
  const totalSkipped = Object.values(stats).reduce((sum, s) => sum + s.skipped, 0);
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Pull complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("📋 Summary:");
  for (const [type, { created, updated, skipped }] of Object.entries(stats)) {
    const parts = [`${created} new`, `${updated} updated`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    console.log(`   ${type}: ${parts.join(", ")}`);
  }

  if (totalSkipped > 0) {
    console.log(`\n   ℹ️  ${totalSkipped} file(s) preserved (locally changed)`);
    console.log("   Run with --force to overwrite: npm run pull:dev:force");
  }
}

// Run the pull engine
main().catch((error) => {
  console.error("\n❌ Pull failed:", error);
  process.exit(1);
});
