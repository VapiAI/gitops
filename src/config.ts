import { existsSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import type { Environment, ResourceType } from "./types.ts";
import { VALID_ENVIRONMENTS } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseEnvironment(): Environment {
  const envArg = process.argv[2] as Environment | undefined;

  if (!envArg) {
    console.error("❌ Environment argument is required");
    console.error("   Usage: npm run apply:dev | apply:prod");
    process.exit(1);
  }

  if (!VALID_ENVIRONMENTS.includes(envArg)) {
    console.error(`❌ Invalid environment: ${envArg}`);
    console.error(`   Must be one of: ${VALID_ENVIRONMENTS.join(", ")}`);
    process.exit(1);
  }

  return envArg;
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

// Parse environment and load env files
export const VAPI_ENV = parseEnvironment();
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

