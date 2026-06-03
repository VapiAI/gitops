import { existsSync, readFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { dirname, extname, join, relative, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { BASE_DIR, matchesIgnore, RESOURCES_DIR } from "./config.ts";
import { stateUuid } from "./state.ts";
import { hashPayload } from "./state-serialize.ts";
import type { ResourceFile, ResourceType, StateFile } from "./types.ts";

// Options bag for the load functions. `ignorePatterns` is the symmetric
// counterpart to pull's filter: when present, ids matching any pattern are
// dropped from the returned array (with a skip-log) before any caller sees
// them. Push wires this from `loadIgnorePatterns()`; pass `[]` (or omit) to
// preserve the pre-change behavior.
export interface LoadOptions {
  ignorePatterns?: string[];
}

// Map resource types to their folder paths (relative to resources/)
export const FOLDER_MAP: Record<ResourceType, string> = {
  tools: "tools",
  structuredOutputs: "structuredOutputs",
  assistants: "assistants",
  squads: "squads",
  personalities: "simulations/personalities",
  scenarios: "simulations/scenarios",
  simulations: "simulations/tests",
  simulationSuites: "simulations/suites",
  evals: "evals",
};

// Reverse map: folder path to resource type
const FOLDER_TO_TYPE: Record<string, ResourceType> = Object.entries(
  FOLDER_MAP,
).reduce(
  (acc, [type, folder]) => {
    acc[folder] = type as ResourceType;
    return acc;
  },
  {} as Record<string, ResourceType>,
);

// ─────────────────────────────────────────────────────────────────────────────
// Resource Loading
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth for resource file extensions. Imported by
// `recanonicalize.ts` so the precondition-5 "both files exist" check
// stays in lockstep with the loader — without this, a `.ts`-authored
// resource paired with a UUID-suffixed `.ts` twin would be invisible to
// the safety check and silently allow the data-loss shape the
// recanonicalize header explicitly refuses.
export const VALID_EXTENSIONS: readonly string[] = [
  ".yml",
  ".yaml",
  ".ts",
  ".md",
];

/**
 * Parse a markdown file with YAML frontmatter
 * Format:
 * ---
 * key: value
 * ---
 * Markdown content (becomes system prompt)
 */
function parseFrontmatter(content: string): {
  config: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error(
      "Invalid frontmatter format - expected YAML between --- delimiters",
    );
  }

  const yamlContent = match[1] ?? "";
  const body = match[2] ?? "";
  const config = parseYaml(yamlContent) as Record<string, unknown>;

  return { config, body: body.trim() };
}

function parseResourceDataFromFile(filePath: string): Record<string, unknown> {
  const ext = extname(filePath);

  if (ext === ".md") {
    const content = readFileSync(filePath, "utf-8");
    const { config, body } = parseFrontmatter(content);

    if (body) {
      const model = (config.model as Record<string, unknown>) || {};
      const existingMessages = Array.isArray(model.messages)
        ? model.messages
        : [];
      model.messages = [
        { role: "system", content: body },
        ...existingMessages.filter(
          (m: { role?: string }) => m.role !== "system",
        ),
      ];
      config.model = model;
    }

    return config;
  }

  const content = readFileSync(filePath, "utf-8");
  const data = parseYaml(content) as Record<string, unknown>;
  if (data === null || data === undefined) {
    throw new Error(`Empty or invalid YAML in ${filePath}`);
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`YAML must be an object in ${filePath}`);
  }
  return data;
}

function findLocalResourceFile(
  type: ResourceType,
  resourceId: string,
): string | undefined {
  const dir = join(RESOURCES_DIR, FOLDER_MAP[type]);
  for (const ext of VALID_EXTENSIONS) {
    if (ext === ".ts") continue;
    const filePath = join(dir, `${resourceId}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return undefined;
}

/** Stable content hash of a local resource file (same basis as lastPulledHash). */
export function hashLocalResource(
  type: ResourceType,
  resourceId: string,
): string | null {
  const filePath = findLocalResourceFile(type, resourceId);
  if (!filePath) return null;
  try {
    return hashPayload(parseResourceDataFromFile(filePath));
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for resource files (.yml, .yaml, .ts)
 * Warns about unsupported files found in resource directories
 */
async function scanDirectory(dir: string, baseDir: string): Promise<string[]> {
  // Sort entries so iteration order is identical across filesystems/CI runners.
  // readdir() returns entries in OS-dependent order (APFS sorts, ext4 doesn't),
  // and downstream push order affects which resource is created first when
  // multiple files declare the same resourceId — non-determinism makes that
  // bug class hard to reproduce.
  const entries = (await readdir(dir)).slice().sort();
  const files: string[] = [];

  for (const entry of entries) {
    // Skip hidden files and directories (e.g., .DS_Store, .gitkeep)
    if (entry.startsWith(".")) {
      continue;
    }

    const fullPath = join(dir, entry);
    const stats = await stat(fullPath);
    const relativePath = relative(baseDir, fullPath);

    if (stats.isDirectory()) {
      // Recursively scan subdirectories
      const subFiles = await scanDirectory(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      const ext = extname(entry);
      if (VALID_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      } else {
        // Warn about unsupported files
        console.warn(
          `  ⚠️  Skipping unsupported file: ${relativePath} (expected ${VALID_EXTENSIONS.join(", ")})`,
        );
      }
    }
  }

  return files;
}

export async function loadResources<T>(
  type: ResourceType,
  options: LoadOptions = {},
): Promise<ResourceFile<T>[]> {
  const folderPath = FOLDER_MAP[type];
  const resourceDir = join(RESOURCES_DIR, folderPath);
  const ignorePatterns = options.ignorePatterns ?? [];

  if (!existsSync(resourceDir)) {
    console.log(`📁 No ${type} directory found, skipping...`);
    return [];
  }

  const filePaths = await scanDirectory(resourceDir, resourceDir);
  const resources: ResourceFile<T>[] = [];
  const seenIds = new Map<string, string>(); // resourceId -> filePath

  for (const filePath of filePaths) {
    const ext = extname(filePath);

    // Compute resourceId as path relative to the resource type directory, without extension
    // e.g., /resources/<org>/assistants/support/intake.yml → support/intake
    // e.g., /resources/<org>/assistants/inbound-support.yml → inbound-support
    const relativePath = relative(resourceDir, filePath);
    const resourceId = relativePath.slice(0, -ext.length);

    // Symmetric ignore: drop matched ids before duplicate-detection and
    // parsing so the rest of the pipeline never sees the file. Caller passes
    // `[]` (or omits) to opt out — preserves the pre-change behavior.
    if (ignorePatterns.length > 0) {
      const matched = matchesIgnore(folderPath, resourceId, ignorePatterns);
      if (matched) {
        console.log(`  🚫 ${resourceId} (matched .vapi-ignore: ${matched})`);
        continue;
      }
    }

    // Check for duplicate resourceIds (e.g., foo.yml and foo.yaml in same directory)
    if (seenIds.has(resourceId)) {
      throw new Error(
        `Duplicate resource ID "${resourceId}" found:\n` +
          `  - ${seenIds.get(resourceId)}\n` +
          `  - ${filePath}\n` +
          `Each resource must have a unique path-based identifier.`,
      );
    }
    seenIds.set(resourceId, filePath);

    let data: T;
    if (ext === ".ts") {
      // Dynamic import for TypeScript files
      try {
        const module = await import(filePath);
        data = module.default as T;
        if (data === undefined) {
          throw new Error(`No default export found in ${relativePath}`);
        }
      } catch (error) {
        throw new Error(
          `Failed to import TypeScript resource "${relativePath}": ${error}`,
        );
      }
    } else if (ext === ".md") {
      // Parse Markdown files with YAML frontmatter (for assistants with system prompts)
      try {
        const content = await readFile(filePath, "utf-8");
        const { config, body } = parseFrontmatter(content);

        // Inject markdown body as system message if present
        if (body) {
          const model = (config.model as Record<string, unknown>) || {};
          const existingMessages = Array.isArray(model.messages)
            ? model.messages
            : [];
          model.messages = [
            { role: "system", content: body },
            ...existingMessages.filter(
              (m: { role?: string }) => m.role !== "system",
            ),
          ];
          config.model = model;
        }

        data = config as T;
      } catch (error) {
        throw new Error(
          `Failed to parse Markdown resource "${relativePath}": ${error}`,
        );
      }
    } else {
      // Parse YAML files
      try {
        const content = await readFile(filePath, "utf-8");
        data = parseYaml(content) as T;
        if (data === null || data === undefined) {
          throw new Error(`Empty or invalid YAML`);
        }
        if (typeof data !== "object" || Array.isArray(data)) {
          throw new Error(
            `YAML must be an object, got ${Array.isArray(data) ? "array" : typeof data}`,
          );
        }
      } catch (error) {
        throw new Error(
          `Failed to parse YAML resource "${relativePath}": ${error}`,
        );
      }
    }

    resources.push({ resourceId, filePath, data });
    console.log(`  📦 Loaded ${resourceId}`);
  }

  return resources;
}

// Match a CLI-supplied path against a folder name. Shared by push (load
// filter) and pull (scoped apply) so short forms like `assistants/foo.md`
// behave the same in both directions.
export function pathMatchesFolder(filePath: string, folder: string): boolean {
  return (
    filePath === folder ||
    filePath.startsWith(`${folder}/`) ||
    filePath.startsWith(`${folder}\\`) ||
    filePath.includes(`/${folder}/`) ||
    filePath.includes(`\\${folder}\\`)
  );
}

function resourceIdFromFolderPath(
  filePath: string,
  folder: string,
): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const folderPrefix = `${folder}/`;
  const idx = normalized.lastIndexOf(folderPrefix);
  if (idx === -1) return null;
  const tail = normalized.slice(idx + folderPrefix.length);
  if (!tail) return null;
  return tail.replace(/\.(yml|yaml|md|ts)$/, "");
}

/**
 * Parse a resource file path into type + local resourceId.
 * Accepts long form (`resources/<org>/assistants/foo.md`) and short form
 * (`assistants/foo.md`).
 */
export function parseResourceFilePath(
  filePath: string,
): { type: ResourceType; resourceId: string } | null {
  const absolutePath = resolve(BASE_DIR, filePath);
  const typeFromResourcesDir = getResourceTypeFromPath(absolutePath);
  if (typeFromResourcesDir) {
    const folderPath = FOLDER_MAP[typeFromResourcesDir];
    const resourceDir = join(RESOURCES_DIR, folderPath);
    const ext = extname(absolutePath);
    const relativePath = relative(resourceDir, absolutePath);
    return {
      type: typeFromResourcesDir,
      resourceId: relativePath.slice(0, -ext.length),
    };
  }

  for (const [type, folder] of Object.entries(FOLDER_MAP)) {
    if (!pathMatchesFolder(filePath, folder)) continue;
    const resourceId = resourceIdFromFolderPath(filePath, folder);
    if (!resourceId) continue;
    return { type: type as ResourceType, resourceId };
  }

  return null;
}

export interface PullFileScope {
  types: ResourceType[];
  idsByType: Map<ResourceType, string[]>;
  skippedWithoutState: Array<{
    type: ResourceType;
    resourceId: string;
    filePath: string;
  }>;
  unrecognized: string[];
}

// Map selective-apply file paths to dashboard UUIDs via state. Resources
// without a state entry are push-only creates and skip the pull phase.
export function resolvePullScopeFromFilePaths(
  filePaths: string[],
  state: StateFile,
): PullFileScope {
  const idsByType = new Map<ResourceType, string[]>();
  const types = new Set<ResourceType>();
  const skippedWithoutState: PullFileScope["skippedWithoutState"] = [];
  const unrecognized: string[] = [];

  for (const filePath of filePaths) {
    const parsed = parseResourceFilePath(filePath);
    if (!parsed) {
      unrecognized.push(filePath);
      continue;
    }

    const { type, resourceId } = parsed;
    types.add(type);
    const uuid = stateUuid(state[type], resourceId);
    if (!uuid) {
      skippedWithoutState.push({ type, resourceId, filePath });
      continue;
    }

    const ids = idsByType.get(type) ?? [];
    if (!ids.includes(uuid)) ids.push(uuid);
    idsByType.set(type, ids);
  }

  return {
    types: [...types].filter((type) => (idsByType.get(type)?.length ?? 0) > 0),
    idsByType,
    skippedWithoutState,
    unrecognized,
  };
}

/**
 * Determine resource type from a file path
 * Resolves both absolute and relative paths
 */
export function getResourceTypeFromPath(filePath: string): ResourceType | null {
  // Resolve to absolute path
  const absolutePath = resolve(filePath);
  const relativeToResources = relative(RESOURCES_DIR, absolutePath);

  // Check if path is within resources directory
  if (relativeToResources.startsWith("..")) {
    return null;
  }

  // Find matching resource type folder
  for (const [type, folder] of Object.entries(FOLDER_MAP)) {
    if (
      relativeToResources.startsWith(folder + "/") ||
      relativeToResources.startsWith(folder)
    ) {
      return type as ResourceType;
    }
  }

  return null;
}

/**
 * Load a single resource file by path
 * Returns the resource with its type, or null if the path is invalid
 */
export async function loadSingleResource(
  filePath: string,
  options: LoadOptions = {},
): Promise<{ type: ResourceType; resource: ResourceFile } | null> {
  // Resolve path (could be relative to cwd or absolute)
  const absolutePath = resolve(filePath);

  if (!existsSync(absolutePath)) {
    console.error(`  ❌ File not found: ${filePath}`);
    return null;
  }

  const resourceType = getResourceTypeFromPath(absolutePath);
  if (!resourceType) {
    console.error(`  ❌ Could not determine resource type for: ${filePath}`);
    console.error(`     File must be within resources/ directory`);
    return null;
  }

  const folderPath = FOLDER_MAP[resourceType];
  const resourceDir = join(RESOURCES_DIR, folderPath);
  const ext = extname(absolutePath);
  const relativePath = relative(resourceDir, absolutePath);
  const resourceId = relativePath.slice(0, -ext.length);

  const ignorePatterns = options.ignorePatterns ?? [];
  if (ignorePatterns.length > 0) {
    const matched = matchesIgnore(folderPath, resourceId, ignorePatterns);
    if (matched) {
      console.log(`  🚫 ${resourceId} (matched .vapi-ignore: ${matched})`);
      return null;
    }
  }

  let data: Record<string, unknown>;

  if (ext === ".ts") {
    try {
      const module = await import(absolutePath);
      data = module.default as Record<string, unknown>;
      if (data === undefined) {
        throw new Error(`No default export found`);
      }
    } catch (error) {
      throw new Error(
        `Failed to import TypeScript resource "${filePath}": ${error}`,
      );
    }
  } else if (ext === ".md") {
    try {
      const content = await readFile(absolutePath, "utf-8");
      const { config, body } = parseFrontmatter(content);

      if (body) {
        const model = (config.model as Record<string, unknown>) || {};
        const existingMessages = Array.isArray(model.messages)
          ? model.messages
          : [];
        model.messages = [
          { role: "system", content: body },
          ...existingMessages.filter(
            (m: { role?: string }) => m.role !== "system",
          ),
        ];
        config.model = model;
      }

      data = config;
    } catch (error) {
      throw new Error(
        `Failed to parse Markdown resource "${filePath}": ${error}`,
      );
    }
  } else {
    try {
      const content = await readFile(absolutePath, "utf-8");
      data = parseYaml(content) as Record<string, unknown>;
      if (data === null || data === undefined) {
        throw new Error(`Empty or invalid YAML`);
      }
      if (typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`YAML must be an object`);
      }
    } catch (error) {
      throw new Error(`Failed to parse YAML resource "${filePath}": ${error}`);
    }
  }

  console.log(`  📦 Loaded ${resourceId} (${resourceType})`);

  return {
    type: resourceType,
    resource: { resourceId, filePath: absolutePath, data },
  };
}
