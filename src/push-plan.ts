import { extractReferencedIds } from "./resolver.ts";
import type {
  LoadedResources,
  ResourceFile,
  ResourceType,
  StateFile,
} from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";
import type { ValidationFinding } from "./validate.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror ensure*Exists without fetching inventories or adopting remote IDs.
export function computePushPlan(
  selected: LoadedResources,
  local: LoadedResources,
  state: StateFile,
): Set<string> {
  const plan = new Set<string>();
  const available = new Map<ResourceType, Set<string>>();
  for (const type of VALID_RESOURCE_TYPES) {
    available.set(type, new Set(Object.keys(state[type])));
    for (const resource of selected[type]) {
      plan.add(`${type}:${resource.resourceId}`);
      available.get(type)!.add(resource.resourceId);
    }
  }
  const ensure = (type: "tools" | "structuredOutputs", id: string): boolean => {
    if (UUID_RE.test(id) || available.get(type)!.has(id)) return false;
    if (!local[type].some((r) => r.resourceId === id)) return false;
    plan.add(`${type}:${id}`);
    available.get(type)!.add(id);
    return true;
  };
  const assistantDeps = (assistant: ResourceFile<Record<string, unknown>>) => {
    const refs = extractReferencedIds(assistant.data);
    let created = false;
    for (const id of refs.tools) created = ensure("tools", id) || created;
    for (const id of refs.structuredOutputs)
      created = ensure("structuredOutputs", id) || created;
    return created;
  };
  for (const assistant of selected.assistants) assistantDeps(assistant);
  for (const squad of selected.squads) {
    for (const id of extractReferencedIds(squad.data).assistants) {
      if (UUID_RE.test(id)) continue;
      const assistant = local.assistants.find((r) => r.resourceId === id);
      if (!assistant) continue;
      const depsCreated = assistantDeps(assistant);
      if (depsCreated || !available.get("assistants")!.has(id)) {
        plan.add(`assistants:${id}`);
        available.get("assistants")!.add(id);
      }
    }
  }
  return plan;
}

export function pushBlockingFindings(
  findings: ValidationFinding[],
  plan: Set<string>,
  strict: boolean,
): ValidationFinding[] {
  return findings
    .filter(
      (finding) =>
        (finding.severity === "error" && strict) ||
        (plan.has(`${finding.type}:${finding.resourceId}`) &&
          (finding.severity === "error" ||
            finding.rule === "unresolved-credential")),
    )
    .map((finding) => ({ ...finding, severity: "error" }));
}
