import { existsSync, readFileSync } from "fs";
import { join, basename, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import type { Environment, ResourceType } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyFilter {
  resourceTypes?: ResourceType[]; // Filter by resource types
  filePaths?: string[]; // Apply only specific files
  resourceIds?: string[]; // Pull only specific remote resource IDs
}

// Group aliases: expand a shorthand into multiple resource types
const RESOURCE_GROUP_MAP: Record<string, ResourceType[]> = {
  simulations: [
    "personalities",
    "scenarios",
    "simulations",
    "simulationSuites",
  ],
};

// Path-based aliases: folder paths to resource types
const RESOURCE_PATH_MAP: Record<string, ResourceType> = {
  "simulations/personalities": "personalities",
  "simulations/scenarios": "scenarios",
  "simulations/tests": "simulations",
  "simulations/suites": "simulationSuites",
};

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parseEnvironment(): Environment {
  const envArg = process.argv[2];

  if (!envArg) {
    console.error("❌ Environment / org name argument is required");
    console.error("   Usage: npm run push <org>  |  npm run push:dev");
    console.error("   Flags: --force (enable deletions)");
    console.error(
      "          --type <type> (apply only specific resource type, repeatable)",
    );
    console.error("          -- <file...> (apply only specific files)");
    process.exit(1);
  }

  if (!SLUG_RE.test(envArg)) {
    console.error(`❌ Invalid environment / org name: ${envArg}`);
    console.error(
      "   Must be lowercase alphanumeric with optional hyphens (e.g., dev, my-org)",
    );
    process.exit(1);
  }

  return envArg;
}

// Resolve a type argument into resource types (handles groups, paths, and direct types)
function resolveResourceTypes(arg: string): ResourceType[] | null {
  // Check group aliases first (e.g., "simulations" → all 4 simulation types)
  if (RESOURCE_GROUP_MAP[arg]) {
    return RESOURCE_GROUP_MAP[arg];
  }
  // Check path-based aliases (e.g., "simulations/personalities" → ["personalities"])
  if (RESOURCE_PATH_MAP[arg]) {
    return [RESOURCE_PATH_MAP[arg]];
  }
  // Check direct resource type
  if (VALID_RESOURCE_TYPES.includes(arg as ResourceType)) {
    return [arg as ResourceType];
  }
  return null;
}

const VALID_TYPE_ARGS = [
  ...VALID_RESOURCE_TYPES,
  ...Object.keys(RESOURCE_GROUP_MAP),
  ...Object.keys(RESOURCE_PATH_MAP),
];

function parseFlags(): {
  forceDelete: boolean;
  bootstrapSync: boolean;
  applyFilter: ApplyFilter;
} {
  const args = process.argv.slice(3);
  const result: {
    forceDelete: boolean;
    bootstrapSync: boolean;
    applyFilter: ApplyFilter;
  } = {
    forceDelete: args.includes("--force"),
    bootstrapSync: args.includes("--bootstrap"),
    applyFilter: {},
  };

  const resourceIds: string[] = [];
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--force" || arg === "--bootstrap") continue;

    // --type / -t (repeatable): accumulate resource types
    if ((arg === "--type" || arg === "-t") && args[i + 1]) {
      const typeArg = args[i + 1]!;
      const resolved = resolveResourceTypes(typeArg);
      if (!resolved) {
        console.error(`❌ Invalid resource type: ${typeArg}`);
        console.error(`   Must be one of: ${VALID_TYPE_ARGS.join(", ")}`);
        process.exit(1);
      }
      if (!result.applyFilter.resourceTypes) {
        result.applyFilter.resourceTypes = [];
      }
      result.applyFilter.resourceTypes.push(...resolved);
      i++;
      continue;
    }

    // --id (repeatable)
    if (arg === "--id" && args[i + 1]) {
      resourceIds.push(args[i + 1]!);
      i++;
      continue;
    }

    // Positional resource type / group
    const resolved = resolveResourceTypes(arg);
    if (resolved) {
      if (!result.applyFilter.resourceTypes) {
        result.applyFilter.resourceTypes = [];
      }
      result.applyFilter.resourceTypes.push(...resolved);
      continue;
    }

    // File path
    if (arg.includes("/") || /\.(yml|yaml|md|ts)$/.test(arg)) {
      filePaths.push(arg);
    }
  }

  if (filePaths.length > 0) {
    result.applyFilter.filePaths = filePaths;
  }
  if (resourceIds.length > 0) {
    result.applyFilter.resourceIds = resourceIds;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment File Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(env: string, baseDir: string): void {
  const envFiles = [
    join(baseDir, `.env.${env}`), // .env.dev, .env.stg, .env.prod
    join(baseDir, `.env.${env}.local`), // .env.dev.local (for local overrides)
    join(baseDir, ".env.local"), // .env.local (always loaded last)
  ];

  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        // Only set if not already defined (env vars take precedence)
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      console.log(`📁 Loaded env file: ${basename(envFile)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// Base directory for the gitops project
const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = join(__dirname, "..");

// Parse environment, flags, and load env files
export const VAPI_ENV = parseEnvironment();
export const {
  forceDelete: FORCE_DELETE,
  bootstrapSync: BOOTSTRAP_SYNC,
  applyFilter: APPLY_FILTER,
} = parseFlags();

loadEnvFile(VAPI_ENV, BASE_DIR);

// API configuration
export const VAPI_TOKEN = process.env.VAPI_TOKEN;
export const VAPI_BASE_URL = process.env.VAPI_BASE_URL || "https://api.vapi.ai";

if (!VAPI_TOKEN) {
  console.error("❌ VAPI_TOKEN environment variable is required");
  console.error("   Create a .env.dev file with: VAPI_TOKEN=your-token");
  process.exit(1);
}

// Paths
export const RESOURCES_DIR = join(BASE_DIR, "resources", VAPI_ENV);
export const STATE_FILE_PATH = join(BASE_DIR, `.vapi-state.${VAPI_ENV}.json`);

// ─────────────────────────────────────────────────────────────────────────────
// Update Exclusions - Keys to remove when updating resources (PATCH)
// Add keys here that should not be sent during updates
// ─────────────────────────────────────────────────────────────────────────────

export const UPDATE_EXCLUDED_KEYS: Record<ResourceType, string[]> = {
  tools: ["type"],
  assistants: [],
  structuredOutputs: ["type"],
  squads: [],
  personalities: [],
  scenarios: [],
  simulations: [],
  simulationSuites: [],
};

export function removeExcludedKeys(
  payload: Record<string, unknown>,
  resourceType: ResourceType,
): Record<string, unknown> {
  const excludedKeys = UPDATE_EXCLUDED_KEYS[resourceType];
  if (excludedKeys.length === 0) return payload;

  const filtered = { ...payload };
  for (const key of excludedKeys) {
    delete filtered[key];
  }
  return filtered;
}
