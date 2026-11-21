import { resolve } from "path";
import { APPLY_FILTER, BASE_DIR } from "./config.ts";
import { FOLDER_MAP, pathMatchesFolder } from "./resources.ts";
import type { ResourceFile, ResourceType } from "./types.ts";

export function shouldApplyResourceType(type: ResourceType): boolean {
  if (APPLY_FILTER.filePaths?.length) {
    const folder = FOLDER_MAP[type];
    return APPLY_FILTER.filePaths.some((fp) => pathMatchesFolder(fp, folder));
  }
  if (APPLY_FILTER.resourceTypes?.length) {
    return APPLY_FILTER.resourceTypes.includes(type);
  }
  return true;
}

export function filterResourcesByPaths<T>(
  resources: ResourceFile<T>[],
  _type: ResourceType,
): ResourceFile<T>[] {
  if (!APPLY_FILTER.filePaths?.length) return resources;

  const matchingIds = new Set<string>();
  for (const filePath of APPLY_FILTER.filePaths) {
    const resolvedInput = resolve(BASE_DIR, filePath);
    for (const resource of resources) {
      if (
        resource.filePath === resolvedInput ||
        resource.filePath.endsWith(filePath) ||
        filePath.endsWith(resource.resourceId + ".yml") ||
        filePath.endsWith(resource.resourceId + ".yaml") ||
        filePath.endsWith(resource.resourceId + ".md") ||
        filePath.endsWith(resource.resourceId + ".ts") ||
        resource.filePath === filePath ||
        resource.resourceId === filePath.replace(/\.(yml|yaml|md|ts)$/, "")
      ) {
        matchingIds.add(resource.resourceId);
      }
    }
  }
  return resources.filter((resource) => matchingIds.has(resource.resourceId));
}
