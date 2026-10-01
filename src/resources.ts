import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename, extname, join, relative, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { BASE_DIR, matchesIgnore, RESOURCES_DIR } from "./config.ts";
import {
  FOLDER_MAP,
  type LoadOptions,
  markdownResourceParse,
  parseResourceDataFromFile,
  resourceDirLoad,
  VALID_EXTENSIONS,
} from "./resource-parse.ts";
import { isBackupCopyFile } from "./slug-utils.ts";
import { stateUuid } from "./state.ts";
import { hashPayload } from "./state-serialize.ts";
import type { ResourceFile, ResourceType, StateFile } from "./types.ts";

// The file-reading half lives in resource-parse.ts (config-free). These are
// re-exported so existing importers keep working.
export { FOLDER_MAP, VALID_EXTENSIONS };
export type { LoadOptions };

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

export async function loadResources<T>(
  type: ResourceType,
  options: LoadOptions = {},
): Promise<ResourceFile<T>[]> {
  return resourceDirLoad<T>(type, RESOURCES_DIR, options);
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
    // Dashboard-backup siblings are merge scratch material, never resources —
    // refuse them even when passed explicitly.
    if (isBackupCopyFile(basename(filePath))) {
      console.log(
        `  🚫 ${filePath} (dashboard-backup copy — merge reference only, not pullable)`,
      );
      continue;
    }
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

  // Dashboard-backup siblings are merge scratch material, never resources —
  // refuse them even when passed explicitly, or a selective push would
  // re-create the backup on the platform as a duplicate.
  if (isBackupCopyFile(basename(absolutePath))) {
    console.log(
      `  🚫 ${filePath} (dashboard-backup copy — merge reference only, not pushable)`,
    );
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
      data = markdownResourceParse(content);
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
