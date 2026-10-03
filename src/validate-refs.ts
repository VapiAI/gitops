// ─────────────────────────────────────────────────────────────────────────────
// Reference validators — does every reference point at something?
//
// Push resolves a reference by name through the org's state file, after it
// has created any local files. A name that matches neither is dropped from
// some fields, sent raw (and rejected mid-push) in others, and deferred in
// the rest (improvements #31). These checks catch it before any of that runs.
// Config-free: the caller passes the state and the ignore patterns.
// ─────────────────────────────────────────────────────────────────────────────

import { credentialForwardMap } from "./credentials.ts";
import { extractReferencedIds } from "./resolver.ts";
import { FOLDER_MAP, matchesIgnore } from "./resource-parse.ts";
import type {
  LoadedResources,
  ResourceFile,
  ResourceType,
  StateFile,
} from "./types.ts";
import type { ValidationFinding } from "./validate.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vapi's built-in personalities exist in every org, so a UUID is the only
// way to reference them and is portable.
const STOCK_PERSONALITY_RE = /^a0000000-0000-4000-8000-00000000000\d$/;

const REF_TYPES: Array<{
  refKey: keyof ReturnType<typeof extractReferencedIds>;
  refType: ResourceType;
}> = [
  { refKey: "tools", refType: "tools" },
  { refKey: "structuredOutputs", refType: "structuredOutputs" },
  { refKey: "assistants", refType: "assistants" },
  { refKey: "personalities", refType: "personalities" },
  { refKey: "scenarios", refType: "scenarios" },
  { refKey: "simulations", refType: "simulations" },
];

const RESOURCE_TYPES: ResourceType[] = [
  "tools",
  "structuredOutputs",
  "assistants",
  "squads",
  "personalities",
  "scenarios",
  "simulations",
  "simulationSuites",
  "evals",
];

// Push never resolves references inside these objects, so a name there
// reaches the API as-is.
const OVERRIDE_KEYS = new Set([
  "assistantOverrides",
  "membersOverrides",
  "targetOverrides",
]);

const refClean = (id: string) => id.split("##")[0]?.trim() ?? "";

// Every reference push resolves: the shared walk, plus scenario judges'
// `evaluations[].structuredOutputId`, which the resolver handles separately.
function referencesCollect(
  data: Record<string, unknown>,
): Map<ResourceType, string[]> {
  const extracted = extractReferencedIds(data);
  const refs = new Map<ResourceType, string[]>();
  for (const { refKey, refType } of REF_TYPES)
    refs.set(refType, extracted[refKey].map(refClean).filter(Boolean));
  if (Array.isArray(data.evaluations)) {
    for (const evaluation of data.evaluations) {
      const id = (evaluation as { structuredOutputId?: unknown })
        ?.structuredOutputId;
      if (typeof id === "string")
        refs.get("structuredOutputs")!.push(refClean(id));
    }
  }
  return refs;
}

// `toolIds` entries inside override objects that aren't UUIDs.
function overrideToolNames(value: unknown, inOverride = false): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => overrideToolNames(item, inOverride));
  if (!value || typeof value !== "object") return [];
  const names: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (inOverride && key === "toolIds" && Array.isArray(child)) {
      for (const id of child)
        if (typeof id === "string" && !UUID_RE.test(refClean(id)))
          names.push(refClean(id));
      continue;
    }
    names.push(
      ...overrideToolNames(child, inOverride || OVERRIDE_KEYS.has(key)),
    );
  }
  return names;
}

// Credential names (`credentialId` / `credentialIds` values that aren't UUIDs).
function credentialNames(
  value: unknown,
  names = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) credentialNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  for (const [key, child] of Object.entries(value)) {
    if (key === "credentialId" && typeof child === "string") {
      if (!UUID_RE.test(child)) names.add(child);
    } else if (key === "credentialIds" && Array.isArray(child)) {
      for (const id of child)
        if (typeof id === "string" && !UUID_RE.test(id)) names.add(id);
    } else {
      credentialNames(child, names);
    }
  }
  return names;
}

function resourceReferencesCheck(args: {
  resource: ResourceFile;
  type: ResourceType;
  local: Map<ResourceType, Set<string>>;
  org: string;
  state: StateFile;
  ignorePatterns: string[];
}): ValidationFinding[] {
  const { resource, type, local, org, state, ignorePatterns } = args;
  const findings: ValidationFinding[] = [];
  const finding = (
    severity: ValidationFinding["severity"],
    rule: string,
    message: string,
  ) =>
    findings.push({
      severity,
      type,
      resourceId: resource.resourceId,
      rule,
      message,
    });
  const data = resource.data as Record<string, unknown>;

  for (const [refType, ids] of referencesCollect(data)) {
    const folder = FOLDER_MAP[refType];
    for (const id of new Set(ids)) {
      if (UUID_RE.test(id)) {
        if (refType === "personalities" && STOCK_PERSONALITY_RE.test(id))
          continue;
        finding(
          "warn",
          "reference-by-uuid",
          `references ${folder}/${id} by UUID, which only exists in one org ` +
            `and breaks promotion; reference the file by name instead`,
        );
        continue;
      }
      // Reported by the reference-to-ignored rule instead.
      if (matchesIgnore(folder, id, ignorePatterns)) continue;
      if (local.get(refType)!.has(id) || state[refType][id]) continue;
      finding(
        "error",
        "dangling-reference",
        `references ${folder}/${id}, but there is no such file and no ` +
          `${refType} entry "${id}" in the state file; check the name, or ` +
          `pull first if the resource was created in the dashboard`,
      );
    }
  }

  for (const name of new Set(overrideToolNames(data)))
    finding(
      "error",
      "override-tool-by-name",
      `an override lists tool "${name}" in toolIds, but references inside ` +
        `overrides aren't resolved, so the API would receive the name; put ` +
        `the tool inline in the override's model.tools instead`,
    );

  const credentials = credentialForwardMap(state);
  for (const name of credentialNames(data))
    if (!credentials.has(name))
      finding(
        "warn",
        "unresolved-credential",
        `credential "${name}" isn't in the state file; deploys look it up ` +
          `with a bootstrap pull and fail if the org has no credential with ` +
          `that name. Run \`npm run pull -- ${org} --bootstrap\` and commit ` +
          `the state file`,
      );

  return findings;
}

export function validateReferences(args: {
  loaded: LoadedResources;
  org: string;
  state: StateFile;
  ignorePatterns: string[];
}): ValidationFinding[] {
  const { loaded, org, state, ignorePatterns } = args;
  const local = new Map<ResourceType, Set<string>>(
    RESOURCE_TYPES.map((type) => [
      type,
      new Set(loaded[type].map((resource) => resource.resourceId)),
    ]),
  );
  return RESOURCE_TYPES.flatMap((type) =>
    loaded[type].flatMap((resource) =>
      resourceReferencesCheck({
        resource,
        type,
        local,
        org,
        state,
        ignorePatterns,
      }),
    ),
  );
}
