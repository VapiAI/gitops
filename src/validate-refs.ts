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
import { RESOURCE_TYPES_WITH_REFS, referencesCollect } from "./resolver.ts";
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

// Push never resolves references inside these objects, so a name there
// reaches the API as-is.
const OVERRIDE_KEYS = new Set([
  "assistantOverrides",
  "membersOverrides",
  "targetOverrides",
]);

const refClean = (id: string) => id.split("##")[0]?.trim() ?? "";

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
  // UUID → the state key that tracks it, per type.
  tracked: Map<ResourceType, Map<string, string>>;
  credentials: Map<string, string>;
  org: string;
  state: StateFile;
  ignorePatterns: string[];
}): ValidationFinding[] {
  const { resource, type, local, tracked, credentials, org, state } = args;
  const { ignorePatterns } = args;
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
      if (id === "") {
        finding(
          "error",
          "malformed-reference",
          `a ${folder} reference is empty or isn't a name (an empty list ` +
            `item, or an object where a name belongs)`,
        );
        continue;
      }
      if (UUID_RE.test(id)) {
        // Only a UUID this repo tracks has a name to use instead. An untracked
        // one is dashboard-owned (ignored), deleted, or from another org, and
        // push's own "untracked UUID" line covers it.
        const slug = tracked.get(refType)?.get(id);
        if (slug)
          finding(
            "warn",
            "reference-by-uuid",
            `references ${folder}/${id} by UUID, which only exists in one org ` +
              `and breaks promotion; use "${slug}" instead`,
          );
        continue;
      }
      // Reported by the reference-to-ignored rule instead.
      if (matchesIgnore(folder, id, ignorePatterns)) continue;
      // `?.uuid`, as the resolver reads it: names like "constructor" must not
      // resolve through Object.prototype.
      if (local.get(refType)!.has(id) || state[refType][id]?.uuid) continue;
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
        `the tool inline in the override's tools:append instead (model.tools ` +
        `there replaces the member's whole tool set)`,
    );

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
    RESOURCE_TYPES_WITH_REFS.map((type) => [
      type,
      new Set(loaded[type].map((resource) => resource.resourceId)),
    ]),
  );
  const tracked = new Map<ResourceType, Map<string, string>>(
    RESOURCE_TYPES_WITH_REFS.map((type) => [
      type,
      new Map(
        Object.entries(state[type] ?? {}).map(([slug, entry]) => [
          entry.uuid,
          slug,
        ]),
      ),
    ]),
  );
  const credentials = credentialForwardMap(state);
  return RESOURCE_TYPES_WITH_REFS.flatMap((type) =>
    loaded[type].flatMap((resource) =>
      resourceReferencesCheck({
        resource,
        type,
        local,
        tracked,
        credentials,
        org,
        state,
        ignorePatterns,
      }),
    ),
  );
}
