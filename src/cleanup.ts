import { VAPI_ENV, VAPI_BASE_URL, VAPI_TOKEN } from "./config.ts";
import { loadState } from "./state.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Dangerous Sync - Delete everything NOT in state file
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_DELAY_MS = 700;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function vapiGet<T>(endpoint: string, debug = false): Promise<T> {
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${VAPI_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${endpoint} failed: ${response.status}`);
  }
  const data = await response.json();
  
  if (debug) {
    console.log(`   DEBUG: Response keys: ${Object.keys(data)}`);
  }
  
  // Handle paginated responses - check various wrapper formats
  if (data && typeof data === "object" && !Array.isArray(data)) {
    // Try common pagination patterns: { data }, { results }, { items }, { structuredOutputs }
    const possibleArrayKeys = ["data", "results", "items", "structuredOutputs", "assistants", "tools", "squads"];
    for (const key of possibleArrayKeys) {
      if (Array.isArray(data[key])) {
        return data[key] as T;
      }
    }
  }
  
  return data as T;
}

async function vapiDelete(endpoint: string): Promise<void> {
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${VAPI_TOKEN}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${endpoint} failed: ${response.status}`);
  }
}

interface VapiResource {
  id: string;
  name?: string;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--force");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🧹 Vapi Cleanup - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(`   Mode: ${dryRun ? "🔒 DRY-RUN (use --force to delete)" : "⚠️  DELETING"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const state = loadState();
  const stateIds = new Set([
    ...Object.values(state.assistants),
    ...Object.values(state.tools),
    ...Object.values(state.structuredOutputs),
    ...Object.values(state.squads),
    ...Object.values(state.personalities),
    ...Object.values(state.scenarios),
    ...Object.values(state.simulations),
    ...Object.values(state.simulationSuites),
  ]);

  console.log(`📄 State file has ${stateIds.size} resource IDs to keep\n`);

  const toDelete: { type: string; id: string; name: string; endpoint: string }[] = [];

  // Fetch and compare each resource type
  const resourceTypes = [
    { name: "assistants", endpoint: "/assistant", deleteEndpoint: "/assistant" },
    { name: "tools", endpoint: "/tool", deleteEndpoint: "/tool" },
    { name: "structured outputs", endpoint: "/structured-output", deleteEndpoint: "/structured-output" },
    { name: "squads", endpoint: "/squad", deleteEndpoint: "/squad" },
    { name: "personalities", endpoint: "/eval/simulation/personality", deleteEndpoint: "/eval/simulation/personality" },
    { name: "scenarios", endpoint: "/eval/simulation/scenario", deleteEndpoint: "/eval/simulation/scenario" },
    { name: "simulations", endpoint: "/eval/simulation", deleteEndpoint: "/eval/simulation" },
    { name: "simulation suites", endpoint: "/eval/simulation/suite", deleteEndpoint: "/eval/simulation/suite" },
  ];

  for (const { name, endpoint, deleteEndpoint } of resourceTypes) {
    console.log(`📥 Fetching ${name}...`);
    try {
      // Enable debug for structured outputs to see response format
      const debug = name === "structured outputs";
      const resources = await vapiGet<VapiResource[]>(endpoint, debug);
      
      if (!Array.isArray(resources)) {
        console.log(`   ⚠️  Unexpected response format for ${name}: ${typeof resources}, keys: ${Object.keys(resources as object)}`);
        continue;
      }
      
      const orphans = resources.filter((r) => !stateIds.has(r.id));
      
      if (orphans.length > 0) {
        console.log(`   Found ${orphans.length} orphaned ${name} (${resources.length} total)`);
        for (const r of orphans) {
          toDelete.push({
            type: name,
            id: r.id,
            name: r.name || "(unnamed)",
            endpoint: `${deleteEndpoint}/${r.id}`,
          });
        }
      } else {
        console.log(`   ✅ All ${resources.length} ${name} are in state`);
      }
    } catch (error) {
      console.log(`   ⚠️  Could not fetch ${name}: ${error}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");

  if (toDelete.length === 0) {
    console.log("✅ Nothing to delete - all resources match state file\n");
    return;
  }

  console.log(`\n⚠️  Found ${toDelete.length} resources to delete:\n`);

  for (const { type, id, name } of toDelete) {
    console.log(`   🗑️  ${type}: ${name} (${id})`);
  }

  if (dryRun) {
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("🔒 DRY-RUN MODE - No resources were deleted");
    console.log("   To actually delete, run:");
    console.log(`   npm run cleanup:${VAPI_ENV} -- --force`);
    console.log("═══════════════════════════════════════════════════════════════\n");
    return;
  }

  console.log("\n🗑️  Deleting...\n");

  let deleted = 0;
  let failed = 0;

  for (const { type, id, name, endpoint } of toDelete) {
    try {
      await vapiDelete(endpoint);
      console.log(`   ✅ Deleted ${type}: ${name}`);
      deleted++;
    } catch (error) {
      console.log(`   ❌ Failed to delete ${type}: ${name} - ${error}`);
      failed++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`✅ Cleanup complete: ${deleted} deleted, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("\n❌ Cleanup failed:", error);
  process.exit(1);
});
