import { existsSync, readFileSync } from "fs";
import { join, basename, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import type { Environment, ResourceType } from "./types.ts";
import { VALID_ENVIRONMENTS, VALID_RESOURCE_TYPES } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyFilter {
  resourceType?: ResourceType;  // Filter by resource type (e.g., "assistants")
  filePaths?: string[];         // Apply only specific files
}

function parseEnvironment(): Environment {
  const envArg = process.argv[2] as Environment | undefined;

  if (!envArg) {
    console.error("❌ Environment argument is required");
    console.error("   Usage: npm run apply:dev | apply:prod");
    console.error("   Flags: --force (enable deletions)");
    console.error("          --type <type> (apply only specific resource type)");
    console.error("          -- <file...> (apply only specific files)");
    process.exit(1);
  }

  if (!VALID_ENVIRONMENTS.includes(envArg)) {
    console.error(`❌ Invalid environment: ${envArg}`);
    console.error(`   Must be one of: ${VALID_ENVIRONMENTS.join(", ")}`);
    process.exit(1);
  }

  return envArg;
}

function parseFlags(): { forceDelete: boolean; applyFilter: ApplyFilter } {
  const args = process.argv.slice(3);
  const result: { forceDelete: boolean; applyFilter: ApplyFilter } = {
    forceDelete: args.includes("--force"),
    applyFilter: {},
  };

  // Parse --type or -t flag
  const typeIndex = args.findIndex(a => a === "--type" || a === "-t");
  if (typeIndex !== -1 && args[typeIndex + 1]) {
    const resourceType = args[typeIndex + 1] as ResourceType;
    if (!VALID_RESOURCE_TYPES.includes(resourceType)) {
      console.error(`❌ Invalid resource type: ${resourceType}`);
      console.error(`   Must be one of: ${VALID_RESOURCE_TYPES.join(", ")}`);
      process.exit(1);
    }
    result.applyFilter.resourceType = resourceType;
  }

  // Parse file paths and positional resource types
  const filePaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    // Skip flags and their values
    if (arg === "--force" || arg === "--type" || arg === "-t") {
      if (arg === "--type" || arg === "-t") i++; // skip the value too
      continue;
    }
    // Check if it's a resource type (positional, like "npm run apply:dev assistants")
    if (VALID_RESOURCE_TYPES.includes(arg as ResourceType) && !result.applyFilter.resourceType) {
      result.applyFilter.resourceType = arg as ResourceType;
      continue;
    }
    // If it looks like a file path (contains / or ends with .yml/.yaml/.md/.ts)
    if (arg.includes("/") || /\.(yml|yaml|md|ts)$/.test(arg)) {
      filePaths.push(arg);
    }
  }

  if (filePaths.length > 0) {
    result.applyFilter.filePaths = filePaths;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment File Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(env: string, baseDir: string): void {
  const envFiles = [
    join(baseDir, `.env.${env}`),       // .env.dev, .env.staging, .env.prod
    join(baseDir, `.env.${env}.local`), // .env.dev.local (for local overrides)
    join(baseDir, ".env.local"),        // .env.local (always loaded last)
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
export const { forceDelete: FORCE_DELETE, applyFilter: APPLY_FILTER } = parseFlags();
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
export const RESOURCES_DIR = join(BASE_DIR, "resources");
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
  resourceType: ResourceType
): Record<string, unknown> {
  const excludedKeys = UPDATE_EXCLUDED_KEYS[resourceType];
  if (excludedKeys.length === 0) return payload;

  const filtered = { ...payload };
  for (const key of excludedKeys) {
    delete filtered[key];
  }
  return filtered;
}

