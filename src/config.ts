import { existsSync, readFileSync } from "fs";
import { join, basename, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import type { Environment, ResourceType } from "./types.ts";
import { VALID_ENVIRONMENTS, VALID_RESOURCE_TYPES } from "./types.ts";

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

function parseEnvironment(): Environment {
  const envArg = process.argv[2] as Environment | undefined;

  if (!envArg) {
    console.error("❌ Environment argument is required");
    console.error("   Usage: npm run apply:dev | apply:stg | apply:prod");
    console.error("   Flags: --force (enable deletions)");
    console.error(
      "          --type <type> (apply only specific resource type)",
    );
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

  // Parse --type or -t flag
  const typeIndex = args.findIndex((a) => a === "--type" || a === "-t");
  if (typeIndex !== -1 && args[typeIndex + 1]) {
    const typeArg = args[typeIndex + 1]!;
    const resolved = resolveResourceTypes(typeArg);
    if (!resolved) {
      console.error(`❌ Invalid resource type: ${typeArg}`);
      console.error(`   Must be one of: ${VALID_TYPE_ARGS.join(", ")}`);
      process.exit(1);
    }
    result.applyFilter.resourceTypes = resolved;
  }

  const resourceIds: string[] = [];

  // Parse file paths and positional resource types
  const filePaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    // Skip flags and their values
    if (
      arg === "--force" ||
      arg === "--bootstrap" ||
      arg === "--id" ||
      arg === "--type" ||
      arg === "-t"
    ) {
      if (arg === "--type" || arg === "-t" || arg === "--id") i++; // skip the value too
      continue;
    }
    // Check if it's a resource type or group (positional)
    if (!result.applyFilter.resourceTypes) {
      const resolved = resolveResourceTypes(arg);
      if (resolved) {
        result.applyFilter.resourceTypes = resolved;
        continue;
      }
    }
    // If it looks like a file path (contains / or ends with .yml/.yaml/.md/.ts)
    if (arg.includes("/") || /\.(yml|yaml|md|ts)$/.test(arg)) {
      filePaths.push(arg);
    }
  }

  if (filePaths.length > 0) {
    result.applyFilter.filePaths = filePaths;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--id" && args[i + 1]) {
      resourceIds.push(args[i + 1]!);
      i++;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Ignore Patterns (.vapi-ignore)
//
// Resources matching any pattern in resources/<env>/.vapi-ignore are skipped
// during pull (never written, never tracked). This is the explicit opt-out
// mechanism for resources that exist on the dashboard but should not be
// managed by this repo.
//
// Pattern syntax (gitignore-flavored, simplified):
//   - Matches against `<folderPath>/<resourceId>` (no extension)
//     e.g. `assistants/ab-assistant-56b80091`
//   - `*`  matches any run of characters within a single path segment
//   - `**` matches across path segments (zero or more)
//   - Lines starting with `#` are comments
//   - Blank lines are ignored
//   - Leading `!` is reserved for future negation; treated as a comment today
// ─────────────────────────────────────────────────────────────────────────────

let cachedIgnorePatterns: string[] | null = null;

function getIgnoreFilePath(): string {
  return join(BASE_DIR, "resources", VAPI_ENV, ".vapi-ignore");
}

export function loadIgnorePatterns(): string[] {
  if (cachedIgnorePatterns !== null) return cachedIgnorePatterns;

  const path = getIgnoreFilePath();
  if (!existsSync(path)) {
    cachedIgnorePatterns = [];
    return cachedIgnorePatterns;
  }

  const raw = readFileSync(path, "utf-8");
  cachedIgnorePatterns = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));

  return cachedIgnorePatterns;
}

// Convert a gitignore-flavored glob to a RegExp. We keep the implementation
// intentionally small (no node_modules) since pull.ts is the only consumer.
function compilePattern(pattern: string): RegExp {
  // Escape regex metacharacters except the glob ones we handle explicitly.
  // `*` and `?` are translated below; everything else is literal.
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      // `**` → match any characters including path separators
      // `*`  → match any characters within a single segment (no `/`)
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++; // consume the second `*`
      } else {
        regex += "[^/]*";
      }
    } else if (c === "?") {
      regex += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(c as string)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

// Check whether a resource at `<folderPath>/<resourceId>` matches the ignore list.
// Returns the matched pattern (truthy) or null.
export function matchesIgnore(
  folderPath: string,
  resourceId: string,
  patterns: string[] = loadIgnorePatterns(),
): string | null {
  if (patterns.length === 0) return null;
  const target = `${folderPath}/${resourceId}`;
  for (const pattern of patterns) {
    if (compilePattern(pattern).test(target)) return pattern;
  }
  return null;
}

// Test-only: clear the cache. Production code does not need to call this.
export function _resetIgnoreCache(): void {
  cachedIgnorePatterns = null;
}
