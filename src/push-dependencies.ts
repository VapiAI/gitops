import { findExistingResourceByName } from "./dep-dedup.ts";
import { extractReferencedIds } from "./resolver.ts";
import type {
  LoadedResources,
  ResourceFile,
  ResourceType,
  StateFile,
} from "./types.ts";

export interface UnlinkedDependency {
  type: ResourceType;
  resource: ResourceFile;
  neededBy: Set<string>;
}

export function collectUnlinkedDependencies(
  resources: LoadedResources,
  selected: Pick<LoadedResources, "assistants" | "squads">,
  state: StateFile,
): UnlinkedDependency[] {
  const dependencies = new Map<string, UnlinkedDependency>();
  for (const rootType of ["assistants", "squads"] as const) {
    for (const root of selected[rootType]) {
      const visited = new Set<string>();
      const visit = (type: ResourceType, resource: ResourceFile) => {
        const key = `${type}:${resource.resourceId}`;
        if (visited.has(key) || resource.data._platformDefault === true) return;
        visited.add(key);
        const refs = extractReferencedIds(resource.data);
        const childTypes: ("assistants" | "tools" | "structuredOutputs")[] =
          type === "squads"
            ? ["assistants"]
            : type === "assistants"
              ? ["tools", "structuredOutputs"]
              : [];
        for (const childType of childTypes) {
          for (const id of refs[childType]) {
            if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
              continue;
            const child = resources[childType].find(
              (file) => file.resourceId === id,
            );
            if (!child || child.data._platformDefault === true) continue;
            if (
              !state[childType][id] &&
              !findExistingResourceByName({
                localResourceId: id,
                localPayload: child.data,
                stateSection: state[childType],
              })
            ) {
              let dependency = dependencies.get(`${childType}:${id}`);
              if (!dependency) {
                dependency = {
                  type: childType,
                  resource: child,
                  neededBy: new Set(),
                };
                dependencies.set(`${childType}:${id}`, dependency);
              }
              dependency.neededBy.add(root.filePath);
            }
            visit(childType, child);
          }
        }
      };
      visit(rootType, root);
    }
  }
  return [...dependencies.values()];
}
