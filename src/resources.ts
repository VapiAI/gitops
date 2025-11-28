import { parse as parseYaml } from "yaml";
import { readdir, readFile, stat } from "fs/promises";
import { join, extname, relative } from "path";
import { existsSync } from "fs";
import { RESOURCES_DIR } from "./config.ts";
import type { ResourceFile, ResourceType } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Resource Loading
// ─────────────────────────────────────────────────────────────────────────────

const VALID_EXTENSIONS = [".yml", ".yaml", ".ts"];

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
  const resourceDir = join(RESOURCES_DIR, type);

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

