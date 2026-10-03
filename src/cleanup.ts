import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  loadIgnorePatterns,
  matchesIgnore,
  VAPI_BASE_URL,
  VAPI_ENV,
  VAPI_TOKEN,
} from "./config.ts";
import { FOLDER_MAP } from "./resource-parse.ts";
import { slugify } from "./slug-utils.ts";
import { loadState } from "./state.ts";
import type { ResourceType } from "./types.ts";
import { userAgentGet } from "./user-agent.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Dangerous Sync - Delete everything NOT in state file
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_DELAY_MS = 700;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function vapiGet<T>(endpoint: string, debug = false): Promise<T> {
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${VAPI_TOKEN}`,
      "User-Agent": userAgentGet(),
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${endpoint} failed: ${response.status}`);
  }
  const data: unknown = await response.json();

  if (debug && isRecord(data)) {
    console.log(`   DEBUG: Response keys: ${Object.keys(data)}`);
  }

  // Handle paginated responses - check various wrapper formats
  if (isRecord(data)) {
    // Try common pagination patterns: { data }, { results }, { items }, { structuredOutputs }
    const possibleArrayKeys = [
      "data",
      "results",
      "items",
      "structuredOutputs",
      "assistants",
      "tools",
      "squads",
    ];
    for (const key of possibleArrayKeys) {
      const wrappedValue = data[key];
      if (Array.isArray(wrappedValue)) {
        return wrappedValue as T;
      }
    }
  }

  return data as T;
}

async function vapiDelete(endpoint: string): Promise<void> {
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${VAPI_TOKEN}`,
      "User-Agent": userAgentGet(),
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${endpoint} failed: ${response.status}`);
  }
}

interface VapiResource {
  id: string;
  name?: string;
  function?: { name?: string };
}

// The .vapi-ignore pattern a platform resource matches, or null. Checks the
// ids pull would give it — its name slug with the UUID suffix (what pull
// writes for an untracked resource) and without it — so a pattern written
// against either form protects the resource.
function ignoredBy(
  folder: string,
  resource: VapiResource,
  patterns: string[],
): string | null {
  if (patterns.length === 0) return null;
  // Truthy, not ??: pull treats an empty name as missing (extractName).
  const name = resource.name || resource.function?.name;
  const shortId = resource.id.slice(0, 8);
  const ids = name
    ? [`${slugify(name)}-${shortId}`, slugify(name)]
    : [`resource-${shortId}`];
  for (const id of ids) {
    const matched = matchesIgnore(folder, id, patterns);
    if (matched) return matched;
  }
  return null;
}

function readConfirmToken(argv: string[]): string | undefined {
  // Accept either `--confirm <slug>` or `--confirm=<slug>`.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm") return argv[i + 1];
    if (arg?.startsWith("--confirm=")) return arg.slice("--confirm=".length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--force");
  const confirmToken = readConfirmToken(process.argv);

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🧹 Vapi Cleanup - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(
    `   Mode: ${dryRun ? "🔒 DRY-RUN (use --force to delete)" : "⚠️  DELETING"}`,
  );
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  // Destructive cleanup must be double-gated. `--force` alone is not enough
  // because it is easy to set habitually or copy from another command where
  // it has a different meaning. Require `--confirm <slug>` so the caller has
  // to name the org they intend to wipe.
  if (!dryRun && confirmToken !== VAPI_ENV) {
    console.error(
      `❌ Refusing to run destructive cleanup without explicit confirmation.`,
    );
    console.error(
      `   Re-run with: npm run cleanup -- ${VAPI_ENV} --force --confirm ${VAPI_ENV}`,
    );
    process.exit(1);
  }

  const state = loadState();
  // State values are ResourceState objects, not bare UUIDs. Extract each
  // .uuid for the orphan-detection set.
  const stateIds = new Set([
    ...Object.values(state.assistants).map((e) => e.uuid),
    ...Object.values(state.tools).map((e) => e.uuid),
    ...Object.values(state.structuredOutputs).map((e) => e.uuid),
    ...Object.values(state.squads).map((e) => e.uuid),
    ...Object.values(state.personalities).map((e) => e.uuid),
    ...Object.values(state.scenarios).map((e) => e.uuid),
    ...Object.values(state.simulations).map((e) => e.uuid),
    ...Object.values(state.simulationSuites).map((e) => e.uuid),
    ...Object.values(state.evals).map((e) => e.uuid),
  ]);

  // A state file with zero tracked resources is almost always a fresh clone,
  // a corrupted state, or a bootstrap that has not written yet. Deleting from
  // that baseline would wipe the entire org. Block it explicitly.
  if (!dryRun && stateIds.size === 0) {
    console.error(
      `❌ Refusing to run destructive cleanup: state file has 0 tracked resources.`,
    );
    console.error(
      `   This usually means the state was never bootstrapped. Run ` +
        `\`npm run pull -- ${VAPI_ENV} --bootstrap\` first, then retry.`,
    );
    process.exit(1);
  }

  console.log(`📄 State file has ${stateIds.size} resource IDs to keep\n`);

  const toDelete: {
    type: string;
    id: string;
    name: string;
    endpoint: string;
  }[] = [];

  // Fetch and compare each resource type
  const resourceTypes: Array<{
    type: ResourceType;
    name: string;
    endpoint: string;
    deleteEndpoint: string;
  }> = [
    {
      type: "assistants",
      name: "assistants",
      endpoint: "/assistant",
      deleteEndpoint: "/assistant",
    },
    {
      type: "tools",
      name: "tools",
      endpoint: "/tool",
      deleteEndpoint: "/tool",
    },
    {
      type: "structuredOutputs",
      name: "structured outputs",
      endpoint: "/structured-output",
      deleteEndpoint: "/structured-output",
    },
    {
      type: "squads",
      name: "squads",
      endpoint: "/squad",
      deleteEndpoint: "/squad",
    },
    {
      type: "personalities",
      name: "personalities",
      endpoint: "/eval/simulation/personality",
      deleteEndpoint: "/eval/simulation/personality",
    },
    {
      type: "scenarios",
      name: "scenarios",
      endpoint: "/eval/simulation/scenario",
      deleteEndpoint: "/eval/simulation/scenario",
    },
    {
      type: "simulations",
      name: "simulations",
      endpoint: "/eval/simulation",
      deleteEndpoint: "/eval/simulation",
    },
    {
      type: "simulationSuites",
      name: "simulation suites",
      endpoint: "/eval/simulation/suite",
      deleteEndpoint: "/eval/simulation/suite",
    },
    {
      type: "evals",
      name: "evals",
      endpoint: "/eval",
      deleteEndpoint: "/eval",
    },
  ];

  // Resources this repo must not manage (.vapi-ignore) are never written to
  // state, so every one of them would look like an orphan here. Keep them,
  // as push's orphan-protection does.
  const ignorePatterns = loadIgnorePatterns();
  let retained = 0;

  for (const { type, name, endpoint, deleteEndpoint } of resourceTypes) {
    console.log(`📥 Fetching ${name}...`);
    try {
      // Enable debug for structured outputs to see response format
      const debug = name === "structured outputs";
      const resources = await vapiGet<VapiResource[]>(endpoint, debug);

      if (!Array.isArray(resources)) {
        const resourceKeys = isRecord(resources)
          ? Object.keys(resources).join(", ")
          : "(none)";
        console.log(
          `   ⚠️  Unexpected response format for ${name}: ${typeof resources}, keys: ${resourceKeys}`,
        );
        continue;
      }

      const orphans: VapiResource[] = [];
      for (const r of resources.filter((r) => !stateIds.has(r.id))) {
        const matched = ignoredBy(FOLDER_MAP[type], r, ignorePatterns);
        if (matched) {
          console.log(
            `   🚫 ${r.name || r.function?.name || r.id} retained (matched .vapi-ignore: ${matched})`,
          );
          retained++;
        } else orphans.push(r);
      }

      if (orphans.length > 0) {
        console.log(
          `   Found ${orphans.length} orphaned ${name} (${resources.length} total)`,
        );
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

  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );

  if (retained > 0) {
    console.log(
      `\n🚫 ${retained} resource(s) not in state were kept because they match .vapi-ignore`,
    );
  }

  if (toDelete.length === 0) {
    console.log("✅ Nothing to delete - all resources match state file\n");
    return;
  }

  console.log(`\n⚠️  Found ${toDelete.length} resources to delete:\n`);

  for (const { type, id, name } of toDelete) {
    console.log(`   🗑️  ${type}: ${name} (${id})`);
  }

  if (dryRun) {
    console.log(
      "\n═══════════════════════════════════════════════════════════════",
    );
    console.log("🔒 DRY-RUN MODE - No resources were deleted");
    console.log("   To actually delete, run:");
    console.log(
      `   npm run cleanup -- ${VAPI_ENV} --force --confirm ${VAPI_ENV}`,
    );
    console.log(
      "═══════════════════════════════════════════════════════════════\n",
    );
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

  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );
  console.log(`✅ Cleanup complete: ${deleted} deleted, ${failed} failed`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );
}

export { main as runCleanup };

const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error) => {
    console.error("\n❌ Cleanup failed:", error);
    process.exit(1);
  });
}
