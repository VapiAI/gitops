import { parse as parseYaml } from "yaml";
import { readdir, readFile, stat } from "fs/promises";
import { join, extname, relative, resolve, dirname } from "path";
import { existsSync } from "fs";
import { RESOURCES_DIR, BASE_DIR } from "./config.ts";
import type { ResourceFile, ResourceType } from "./types.ts";

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
};

// Reverse map: folder path to resource type
const FOLDER_TO_TYPE: Record<string, ResourceType> = Object.entries(FOLDER_MAP)
  .reduce((acc, [type, folder]) => {
    acc[folder] = type as ResourceType;
    return acc;
  }, {} as Record<string, ResourceType>);

// ─────────────────────────────────────────────────────────────────────────────
// Resource Loading
// ─────────────────────────────────────────────────────────────────────────────

const VALID_EXTENSIONS = [".yml", ".yaml", ".ts", ".md"];

/**
 * Parse a markdown file with YAML frontmatter
 * Format:
 * ---
 * key: value
 * ---
 * Markdown content (becomes system prompt)
 */
function parseFrontmatter(content: string): { config: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    throw new Error("Invalid frontmatter format - expected YAML between --- delimiters");
  }
  
  const [, yamlContent, body] = match;
  const config = parseYaml(yamlContent) as Record<string, unknown>;
  
  return { config, body: body.trim() };
}

/**
 * Recursively scan a directory for resource files (.yml, .yaml, .ts)
 * Warns about unsupported files found in resource directories
 */
async function scanDirectory(dir: string, baseDir: string): Promise<string[]> {
  const entries = await readdir(dir);
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
        console.warn(`  ⚠️  Skipping unsupported file: ${relativePath} (expected ${VALID_EXTENSIONS.join(", ")})`);
      }
    }
  }

  return files;
}

export async function loadResources<T>(
  type: ResourceType
): Promise<ResourceFile<T>[]> {
  const folderPath = FOLDER_MAP[type];
  const resourceDir = join(RESOURCES_DIR, folderPath);

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
    // e.g., /resources/assistants/healthcare/booking.yml → healthcare/booking
    // e.g., /resources/assistants/inbound-support.yml → inbound-support (backwards compatible)
    const relativePath = relative(resourceDir, filePath);
    const resourceId = relativePath.slice(0, -ext.length);

    // Check for duplicate resourceIds (e.g., foo.yml and foo.yaml in same directory)
    if (seenIds.has(resourceId)) {
      throw new Error(
        `Duplicate resource ID "${resourceId}" found:\n` +
        `  - ${seenIds.get(resourceId)}\n` +
        `  - ${filePath}\n` +
        `Each resource must have a unique path-based identifier.`
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
        throw new Error(`Failed to import TypeScript resource "${relativePath}": ${error}`);
      }
    } else if (ext === ".md") {
      // Parse Markdown files with YAML frontmatter (for assistants with system prompts)
      try {
        const content = await readFile(filePath, "utf-8");
        const { config, body } = parseFrontmatter(content);
        
        // Inject markdown body as system message if present
        if (body) {
          const model = (config.model as Record<string, unknown>) || {};
          const existingMessages = Array.isArray(model.messages) ? model.messages : [];
          model.messages = [
            { role: "system", content: body },
            ...existingMessages.filter((m: { role?: string }) => m.role !== "system"),
          ];
          config.model = model;
        }
        
        data = config as T;
      } catch (error) {
        throw new Error(`Failed to parse Markdown resource "${relativePath}": ${error}`);
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
          throw new Error(`YAML must be an object, got ${Array.isArray(data) ? "array" : typeof data}`);
        }
      } catch (error) {
        throw new Error(`Failed to parse YAML resource "${relativePath}": ${error}`);
      }
    }

    resources.push({ resourceId, filePath, data });
    console.log(`  📦 Loaded ${resourceId}`);
  }

  return resources;
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
    if (relativeToResources.startsWith(folder + "/") || relativeToResources.startsWith(folder)) {
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
  filePath: string
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

  let data: Record<string, unknown>;
  
  if (ext === ".ts") {
    try {
      const module = await import(absolutePath);
      data = module.default as Record<string, unknown>;
      if (data === undefined) {
        throw new Error(`No default export found`);
      }
    } catch (error) {
      throw new Error(`Failed to import TypeScript resource "${filePath}": ${error}`);
    }
  } else if (ext === ".md") {
    try {
      const content = await readFile(absolutePath, "utf-8");
      const { config, body } = parseFrontmatter(content);
      
      if (body) {
        const model = (config.model as Record<string, unknown>) || {};
        const existingMessages = Array.isArray(model.messages) ? model.messages : [];
        model.messages = [
          { role: "system", content: body },
          ...existingMessages.filter((m: { role?: string }) => m.role !== "system"),
        ];
        config.model = model;
      }
      
      data = config;
    } catch (error) {
      throw new Error(`Failed to parse Markdown resource "${filePath}": ${error}`);
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
