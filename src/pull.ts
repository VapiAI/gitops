import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { stringify } from "yaml";
import {
  APPLY_FILTER,
  BASE_DIR,
  BOOTSTRAP_SYNC,
  loadIgnorePatterns,
  matchesIgnore,
  RESOURCES_DIR,
  VAPI_BASE_URL,
  VAPI_ENV,
  VAPI_TOKEN,
} from "./config.ts";
import { credentialReverseMap, replaceCredentialRefs } from "./credentials.ts";
import {
  classifyDrift,
  formatDriftLabel,
  type DriftDirection,
} from "./drift.ts";
import {
  formatRecanonicalizeReport,
  recanonicalizeStateKeys,
} from "./recanonicalize.ts";
import { FOLDER_MAP, hashLocalResource } from "./resources.ts";
import { extractBaseSlug, slugify } from "./slug-utils.ts";
import { hashPayload, loadState, saveState, upsertState } from "./state.ts";
import type { ResourceState, ResourceType, StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VapiResource {
  id: string;
  name?: string;
  [key: string]: unknown;
}

// Fields to remove from resources before saving (server-managed or computed fields)
const EXCLUDED_FIELDS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
  // Computed/derived fields that shouldn't be synced back
  "isServerUrlSecretSet", // Computed: indicates if server URL secret is set
  "workflowIds", // Server-managed: workflows are a separate resource type
];

// Map resource types to their API endpoints
const ENDPOINT_MAP: Record<ResourceType, string> = {
  tools: "/tool",
  structuredOutputs: "/structured-output",
  assistants: "/assistant",
  squads: "/squad",
  personalities: "/eval/simulation/personality",
  scenarios: "/eval/simulation/scenario",
  simulations: "/eval/simulation",
  simulationSuites: "/eval/simulation/suite",
  evals: "/eval",
};

// ─────────────────────────────────────────────────────────────────────────────
// Git Helpers (detect locally changed files to skip during pull)
// ─────────────────────────────────────────────────────────────────────────────

function gitCmd(args: string): string {
  return execSync(`git ${args}`, {
    cwd: BASE_DIR,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function isGitRepo(): boolean {
  try {
    gitCmd("rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

function gitHasCommits(): boolean {
  try {
    gitCmd("rev-parse HEAD");
    return true;
  } catch {
    return false;
  }
}

// Returns relative paths of all locally modified, deleted, or untracked files.
//
// Two flags matter here:
//
// - `--untracked-files=all`: by default, `git status --porcelain` collapses
//   untracked directories to a single entry like `?? resources/<org>/`. In a
//   fresh-clone workflow where the resource tree is not yet tracked, that
//   collapsed entry would not match the per-file lookup downstream and locally
//   edited files would silently get overwritten on pull. `=all` forces git to
//   list each individual file.
//
// - `-z` (null-terminated): so filenames containing spaces, newlines, or
//   quotes parse correctly without the ad-hoc quote/arrow stripping that the
//   plain porcelain format requires. With `-z`, renames emit two separate
//   null-terminated records: `XY new\0old\0` — we want `new`, so we consume
//   the record after any `R`/`C` status.
function getLocallyChangedFiles(): Set<string> {
  const status = gitCmd("status --porcelain --untracked-files=all -z");
  const files = new Set<string>();
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    // Each record is `XY <path>`. For R/C statuses, the NEXT record is the
    // original path, which we skip.
    const x = record[0];
    const filePath = record.slice(3);
    if (filePath) files.add(filePath);
    if (x === "R" || x === "C") {
      // Skip the following "from" path record
      i++;
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllResources(
  resourceType: ResourceType,
): Promise<VapiResource[]> {
  const endpoint = ENDPOINT_MAP[resourceType];
  const url = `${VAPI_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${VAPI_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let apiMessage = errorText;
    try {
      const parsed = JSON.parse(errorText);
      if (typeof parsed.message === "string") apiMessage = parsed.message;
    } catch {}
    throw new Error(
      `API GET ${endpoint} failed (${response.status}): ${apiMessage}`,
    );
  }

  const data = await response.json();

  // Handle paginated response format (e.g., structured-output returns { results: [], metadata: {} })
  if (
    data &&
    typeof data === "object" &&
    "results" in data &&
    Array.isArray(data.results)
  ) {
    return data.results as VapiResource[];
  }

  return data as VapiResource[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential Fetching
// ─────────────────────────────────────────────────────────────────────────────

interface VapiCredential {
  id: string;
  name?: string;
  provider: string;
  [key: string]: unknown;
}

async function fetchCredentials(): Promise<VapiCredential[]> {
  const url = `${VAPI_BASE_URL}/credential`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${VAPI_TOKEN}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let apiMessage = errorText;
    try {
      const parsed = JSON.parse(errorText);
      if (typeof parsed.message === "string") apiMessage = parsed.message;
    } catch {}
    throw new Error(
      `API GET /credential failed (${response.status}): ${apiMessage}`,
    );
  }

  return (await response.json()) as VapiCredential[];
}

function credentialSlug(cred: VapiCredential): string {
  const base = cred.name || cred.provider || "credential";
  return slugify(base);
}

async function pullCredentials(state: StateFile): Promise<void> {
  console.log("\n🔑 Pulling credentials...");
  const credentials = await fetchCredentials();
  console.log(`   Found ${credentials.length} credentials in Vapi`);

  const newSection: Record<string, ResourceState> = {};
  // Build reverse map from existing state to preserve slug stability
  const existingReverse = new Map<string, string>();
  for (const [slug, entry] of Object.entries(state.credentials)) {
    existingReverse.set(entry.uuid, slug);
  }

  for (const cred of credentials) {
    // Reuse existing slug if available, otherwise generate a new one
    let slug = existingReverse.get(cred.id);
    if (!slug) {
      slug = credentialSlug(cred);
    }
    // Preserve existing hash metadata if the slug+uuid pair survives.
    const prior = state.credentials[slug];
    newSection[slug] =
      prior && prior.uuid === cred.id
        ? prior
        : { uuid: cred.id, lastPulledAt: new Date().toISOString() };
    console.log(`   🔑 ${slug} -> ${cred.id}`);
  }

  state.credentials = newSection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource naming (slug generation lives in src/slug-utils.ts)
// ─────────────────────────────────────────────────────────────────────────────

function extractName(resource: VapiResource): string | undefined {
  if (resource.name) return resource.name;
  // Tools store their name under function.name
  const fn = resource.function as Record<string, unknown> | undefined;
  if (fn?.name && typeof fn.name === "string") return fn.name;
  return undefined;
}

function generateResourceId(resource: VapiResource): string {
  const name = extractName(resource);
  const shortId = resource.id.slice(0, 8);
  return name ? `${slugify(name)}-${shortId}` : `resource-${shortId}`;
}

export function resourceIdMatchesName(
  resourceId: string,
  resource: VapiResource,
): boolean {
  const name = extractName(resource);
  if (!name) return true;
  return extractBaseSlug(resourceId) === slugify(name);
}

export function listExistingResourceIds(resourceType: ResourceType): string[] {
  const dir = join(RESOURCES_DIR, FOLDER_MAP[resourceType]);
  if (!existsSync(dir)) return [];

  const walk = (currentDir: string, ids: string[]): string[] => {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, ids);
        continue;
      }

      if (!/\.(yml|yaml|md)$/.test(entry.name)) {
        continue;
      }

      const relativePath = relative(dir, fullPath);
      ids.push(relativePath.replace(/\.(yml|yaml|md)$/, ""));
    }

    return ids;
  };

  return walk(dir, []);
}

// When pulling a new environment, a resource may already exist on disk under a
// different UUID suffix (e.g., `end-call-tool-8102e715` from dev). Match by
// name-slug so we reuse the existing file instead of creating a duplicate.
//
// State-awareness guard: if a name-matching file is already claimed in state
// by a *different* UUID, refuse adoption. Without this guard, two dashboard
// resources sharing a name (e.g. a Duplicate-Assistant click, or any
// platform auto-seed of a same-named twin) collapse onto the same file —
// the second pull silently overwrites the first's content and reassigns
// the slug's state mapping to the new UUID, orphaning the original.
// Falling through to `generateResourceId` (caller) produces a deterministic
// `<name>-<uuid8>` slug per UUID, so the second resource gets its own file.
export function findExistingResourceId(
  existingResourceIds: string[],
  resource: VapiResource,
  stateSection: Record<string, ResourceState>,
): string | undefined {
  const name = extractName(resource);
  if (!name) return undefined;

  const nameSlug = slugify(name);
  const matches = existingResourceIds.filter(
    (id) => extractBaseSlug(id) === nameSlug,
  );
  if (matches.length === 0) return undefined;

  // A file is adoptable when it is either unclaimed in state (cross-env
  // pull: file shipped from dev, this env has no prior state for it) or
  // already claimed by THIS resource's UUID. The same-UUID branch is
  // defensive — in the production code path the caller's
  // `reverseMap.get(resource.id)` short-circuits this case, so we only
  // reach this function when the UUID is unknown to state. Keep the
  // branch anyway so the helper is correct in isolation.
  // A file claimed by a *different* UUID is not adoptable — adopting it
  // would clobber the existing resource's content and state mapping.
  const adoptable = matches.filter((id) => {
    const claim = stateSection[id]?.uuid;
    return claim === undefined || claim === resource.id;
  });

  return adoptable.length === 1 ? adoptable[0] : undefined;
}

function removeUuidMappings(
  stateSection: Record<string, ResourceState>,
  uuid: string,
  keepResourceId?: string,
): void {
  for (const [resourceId, entry] of Object.entries(stateSection)) {
    if (entry.uuid === uuid && resourceId !== keepResourceId) {
      delete stateSection[resourceId];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Processing
// ─────────────────────────────────────────────────────────────────────────────

export function cleanResource(resource: VapiResource): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  // Preserve `null` values: the API uses `null` to represent an intentionally
  // cleared field (e.g. `voicemailMessage: null`), which is semantically
  // different from an absent field. Stripping it on pull would cause the next
  // push to drop the clear and re-apply any prior value still on the server.
  for (const [key, value] of Object.entries(resource)) {
    if (!EXCLUDED_FIELDS.includes(key) && value !== undefined) {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

function buildReverseMap(
  state: StateFile,
  resourceType: ResourceType,
): Map<string, string> {
  // uuid -> resourceId
  const map = new Map<string, string>();
  const stateSection = state[resourceType];

  for (const [resourceId, entry] of Object.entries(stateSection)) {
    map.set(entry.uuid, resourceId);
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Resolution (UUID -> resourceId)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveReferencesToResourceIds(
  resource: Record<string, unknown>,
  state: StateFile,
): Record<string, unknown> {
  const toolsMap = buildReverseMap(state, "tools");
  const assistantsMap = buildReverseMap(state, "assistants");
  const structuredOutputsMap = buildReverseMap(state, "structuredOutputs");
  const personalitiesMap = buildReverseMap(state, "personalities");
  const scenariosMap = buildReverseMap(state, "scenarios");
  const simulationsMap = buildReverseMap(state, "simulations");

  const resolved = { ...resource };

  // Resolve toolIds in model
  if (resolved.model && typeof resolved.model === "object") {
    const model = { ...(resolved.model as Record<string, unknown>) };
    if (Array.isArray(model.toolIds)) {
      model.toolIds = model.toolIds.map(
        (uuid: string) => toolsMap.get(uuid) ?? uuid,
      );
    }
    resolved.model = model;
  }

  // Resolve structuredOutputIds in artifactPlan
  if (resolved.artifactPlan && typeof resolved.artifactPlan === "object") {
    const artifactPlan = {
      ...(resolved.artifactPlan as Record<string, unknown>),
    };
    if (Array.isArray(artifactPlan.structuredOutputIds)) {
      artifactPlan.structuredOutputIds = artifactPlan.structuredOutputIds.map(
        (uuid: string) => structuredOutputsMap.get(uuid) ?? uuid,
      );
    }
    resolved.artifactPlan = artifactPlan;
  }

  // Resolve assistantIds in structured outputs (API returns camelCase)
  if (Array.isArray(resolved.assistantIds)) {
    resolved.assistant_ids = (resolved.assistantIds as string[]).map(
      (uuid: string) => assistantsMap.get(uuid) ?? uuid,
    );
    delete resolved.assistantIds;
  }

  // Resolve assistantId in tool destinations (handoff tools)
  if (Array.isArray(resolved.destinations)) {
    resolved.destinations = (
      resolved.destinations as Record<string, unknown>[]
    ).map((dest) => {
      if (typeof dest.assistantId === "string") {
        return {
          ...dest,
          assistantId: assistantsMap.get(dest.assistantId) ?? dest.assistantId,
        };
      }
      return dest;
    });
  }

  // Resolve members[].assistantId in squads
  if (Array.isArray(resolved.members)) {
    resolved.members = (resolved.members as Record<string, unknown>[]).map(
      (member) => {
        const resolvedMember = { ...member };
        if (typeof member.assistantId === "string") {
          resolvedMember.assistantId =
            assistantsMap.get(member.assistantId) ?? member.assistantId;
        }
        // Resolve assistantDestinations[].assistantId
        if (Array.isArray(member.assistantDestinations)) {
          resolvedMember.assistantDestinations = (
            member.assistantDestinations as Record<string, unknown>[]
          ).map((dest) => {
            if (typeof dest.assistantId === "string") {
              return {
                ...dest,
                assistantId:
                  assistantsMap.get(dest.assistantId) ?? dest.assistantId,
              };
            }
            return dest;
          });
        }
        return resolvedMember;
      },
    );
  }

  // Resolve personalityId in simulations
  if (typeof resolved.personalityId === "string") {
    resolved.personalityId =
      personalitiesMap.get(resolved.personalityId) ?? resolved.personalityId;
  }

  // Resolve scenarioId in simulations
  if (typeof resolved.scenarioId === "string") {
    resolved.scenarioId =
      scenariosMap.get(resolved.scenarioId) ?? resolved.scenarioId;
  }

  // Resolve simulationIds in simulation suites
  if (Array.isArray(resolved.simulationIds)) {
    resolved.simulationIds = (resolved.simulationIds as string[]).map(
      (uuid: string) => simulationsMap.get(uuid) ?? uuid,
    );
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization for content-hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for the canonical hash basis of a platform resource.
 *
 * Encodes the full pipeline: `cleanResource → resolveReferencesToResourceIds
 * → replaceCredentialRefs → _platformDefault marker injection`.
 *
 * ALL hash sites MUST use this helper. The classifier (pull.ts), the audit
 * (audit.ts/checkContentDrift), and the pull-write fallback all need the
 * same transformation applied in the same order — any divergence (a missing
 * step, a different mutation order) makes the resulting `lastPulledHash`
 * disagree with the next read's `localHash`, producing permanent phantom
 * `both-diverged` reports that only `--overwrite` can clear.
 *
 * Note: this is the *pre-write* canonical form (in-memory). At write sites,
 * `lastPulledHash` should still be sourced from `hashLocalResource(...)` after
 * the file is on disk, because YAML round-trip / MD frontmatter serialization
 * is not guaranteed to be identity-preserving. This helper is the correct
 * fallback when no file write happened (bootstrap mode) or when reading a
 * platform payload for classifier/audit purposes.
 */
export function canonicalizeForHash(
  resource: VapiResource,
  state: StateFile,
  credReverse: Map<string, string>,
): Record<string, unknown> {
  const cleaned = cleanResource(resource);
  const resolved = resolveReferencesToResourceIds(cleaned, state);
  const withCredNames = replaceCredentialRefs(resolved, credReverse);
  const isPlatformDefault =
    resource.orgId === null || resource.orgId === undefined;
  if (isPlatformDefault) {
    withCredNames._platformDefault = true;
  }
  return withCredNames;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract system prompt from model.messages if present
 * Returns the system prompt content and the cleaned data (without system message)
 */
function extractSystemPrompt(data: Record<string, unknown>): {
  systemPrompt: string | null;
  cleanedData: Record<string, unknown>;
} {
  const model = data.model as Record<string, unknown> | undefined;
  if (!model || !Array.isArray(model.messages)) {
    return { systemPrompt: null, cleanedData: data };
  }

  const messages = model.messages as Array<{ role?: string; content?: string }>;
  const systemMessage = messages.find((m) => m.role === "system");

  if (!systemMessage?.content) {
    return { systemPrompt: null, cleanedData: data };
  }

  // Remove system message from messages array
  const remainingMessages = messages.filter((m) => m.role !== "system");

  // Create cleaned data without system message
  const cleanedData = { ...data };
  const cleanedModel = { ...model };

  if (remainingMessages.length > 0) {
    cleanedModel.messages = remainingMessages;
  } else {
    delete cleanedModel.messages;
  }

  cleanedData.model = cleanedModel;

  return { systemPrompt: systemMessage.content, cleanedData };
}

// Deterministic key ordering: 'name' first, then alphabetical
// Applied to all levels (top-level and nested objects) for stable diffs
const sortMapEntries = (a: { key: unknown }, b: { key: unknown }): number => {
  const aKey = String(a.key);
  const bKey = String(b.key);
  if (aKey === "name") return -1;
  if (bKey === "name") return 1;
  return aKey.localeCompare(bKey);
};

const YAML_OPTIONS = {
  lineWidth: 0,
  defaultStringType: "PLAIN" as const,
  defaultKeyType: "PLAIN" as const,
  sortMapEntries,
};

async function writeResourceFile(
  resourceType: ResourceType,
  resourceId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const folderPath = FOLDER_MAP[resourceType];
  const dir = join(RESOURCES_DIR, folderPath);

  // For assistants, check if there's a system prompt to extract
  if (resourceType === "assistants") {
    const { systemPrompt, cleanedData } = extractSystemPrompt(data);

    if (systemPrompt) {
      // Write as .md with frontmatter
      const filePath = join(dir, `${resourceId}.md`);
      await mkdir(dirname(filePath), { recursive: true });

      const yamlContent = stringify(cleanedData, YAML_OPTIONS);

      const mdContent = `---\n${yamlContent}---\n\n${systemPrompt}\n`;
      await writeFile(filePath, mdContent);

      return filePath;
    }
  }

  // Default: write as .yml
  const filePath = join(dir, `${resourceId}.yml`);
  await mkdir(dirname(filePath), { recursive: true });

  const yamlContent = stringify(data, YAML_OPTIONS);

  await writeFile(filePath, yamlContent);

  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface PullStats {
  created: number;
  updated: number;
  skipped: number;
}

export type DriftResolveMode = "ours" | "theirs" | "fail";

export interface BothDivergedResource {
  resourceType: ResourceType;
  resourceId: string;
  resource: VapiResource;
  localHash: string;
  platformHash: string;
  lastPulledHash: string;
}

export type DriftDirectionCounts = Record<DriftDirection, number>;

function emptyDriftCounts(): DriftDirectionCounts {
  return {
    clean: 0,
    "dashboard-ahead": 0,
    "local-ahead": 0,
    "both-diverged": 0,
    "no-baseline": 0,
  };
}

function parseResolveMode(explicit?: DriftResolveMode): DriftResolveMode | undefined {
  if (explicit) return explicit;
  const arg = process.argv.find((a) => a.startsWith("--resolve="));
  if (!arg) return undefined;
  const mode = arg.slice("--resolve=".length);
  if (mode === "ours" || mode === "theirs" || mode === "fail") return mode;
  throw new Error(
    `Invalid --resolve value: ${mode}. Use --resolve=ours|theirs|fail`,
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLocalResourcePath(
  folderPath: string,
  resourceId: string,
): string | undefined {
  const dir = join(RESOURCES_DIR, folderPath);
  return [
    join(dir, `${resourceId}.md`),
    join(dir, `${resourceId}.yml`),
    join(dir, `${resourceId}.yaml`),
  ].find((p) => existsSync(p));
}

export interface PullOptions {
  force?: boolean;
  bootstrap?: boolean;
  typeFilter?: ResourceType[];
  resourceIds?: string[];
  resolveMode?: DriftResolveMode;
}

export interface PullResult {
  state: StateFile;
  stats: Record<ResourceType, PullStats>;
  force: boolean;
  bootstrap: boolean;
}

export async function pullResourceType(
  resourceType: ResourceType,
  state: StateFile,
  options: {
    changedFiles?: Set<string>;
    force?: boolean;
    bootstrap?: boolean;
    resourceIds?: string[];
    driftCounts?: DriftDirectionCounts;
    bothDiverged?: BothDivergedResource[];
  } = {},
): Promise<PullStats> {
  const {
    changedFiles,
    force,
    bootstrap,
    resourceIds,
    driftCounts,
    bothDiverged,
  } = options;
  console.log(`\n📥 Pulling ${resourceType}...`);

  const allResources = (await fetchAllResources(resourceType)) ?? [];

  if (!Array.isArray(allResources)) {
    console.log(`   ⚠️  No ${resourceType} found (API returned non-array)`);
    return { created: 0, updated: 0, skipped: 0 };
  }

  let resources = allResources;
  if (resourceIds?.length) {
    const requestedIds = new Set(resourceIds);
    resources = allResources.filter((resource) =>
      requestedIds.has(resource.id),
    );
    const foundIds = new Set(resources.map((resource) => resource.id));
    const missingIds = resourceIds.filter((id) => !foundIds.has(id));

    console.log(
      `   Found ${resources.length} matching ${resourceType} in Vapi (requested ${resourceIds.length})`,
    );
    if (missingIds.length > 0) {
      console.log(
        `   ⚠️  Requested IDs not found for ${resourceType}: ${missingIds.join(", ")}`,
      );
    }
  } else {
    console.log(`   Found ${resources.length} ${resourceType} in Vapi`);
  }

  const reverseMap = buildReverseMap(state, resourceType);
  const credReverse = credentialReverseMap(state);
  const newStateSection: Record<string, ResourceState> = resourceIds?.length
    ? { ...state[resourceType] }
    : {};
  const existingResourceIds = bootstrap
    ? []
    : listExistingResourceIds(resourceType);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const resource of resources) {
    // Check if we already have this resource in state (by UUID)
    let resourceId = reverseMap.get(resource.id);
    if (resourceId && !resourceIdMatchesName(resourceId, resource)) {
      delete newStateSection[resourceId];
      resourceId = undefined;
    }

    if (!resourceId) {
      // Reuse an existing file's resourceId if the name matches (cross-env
      // pull). The adoption guard needs both prior-pull claims AND
      // intra-pull claims so the fix is iteration-order-independent:
      //   - `state[resourceType]` carries prior-pull claims loaded from
      //     disk. Without this, if the dashboard returns the new same-name
      //     twin BEFORE the tracked one, the new twin sees `newStateSection`
      //     empty and clobbers the tracked file. The customer's mudflap-prod
      //     5-Rileys investigation surfaced this ordering dependency.
      //   - `newStateSection` carries intra-pull claims from earlier
      //     iterations. Handles the converse (tracked-then-twin order).
      // Spread `newStateSection` last so it wins when both have the same
      // slug — the in-flight value is the more authoritative claim during
      // this pull (e.g. an earlier iteration rekeyed the slug to a new UUID).
      const claimView = { ...state[resourceType], ...newStateSection };
      resourceId = bootstrap
        ? generateResourceId(resource)
        : (findExistingResourceId(existingResourceIds, resource, claimView) ??
          generateResourceId(resource));
    }
    const isNew =
      !reverseMap.get(resource.id) ||
      !resourceIdMatchesName(resourceId, resource);

    removeUuidMappings(newStateSection, resource.id, resourceId);

    const folderPath = FOLDER_MAP[resourceType];

    // Skip resources matched by .vapi-ignore.
    // These are explicit opt-outs — the resource exists on the dashboard but
    // this repo does not manage it. Do NOT track in state (so a future
    // un-ignore pulls cleanly and so state doesn't accumulate stale entries).
    if (!bootstrap && !force) {
      const matched = matchesIgnore(folderPath, resourceId);
      if (matched) {
        console.log(`   🚫 ${resourceId} (matched .vapi-ignore: ${matched})`);
        skipped++;
        continue;
      }
    }

    let skipLegacyPreserveChecks = false;

    // Hash-based drift direction when a lastPulledHash baseline exists.
    if (!bootstrap && !force) {
      const stateEntry =
        newStateSection[resourceId] ?? state[resourceType][resourceId];
      const lastPulledHash = stateEntry?.lastPulledHash;
      const localFile = findLocalResourcePath(folderPath, resourceId);

      if (localFile && lastPulledHash) {
        const localHash = hashLocalResource(resourceType, resourceId);
        if (localHash) {
          // Use canonicalizeForHash so platform-default mutation (_platformDefault)
          // and the 3-step pipeline are applied identically across pull-write,
          // classifier, audit, and resolveBothDiverged sites. Any asymmetry here
          // makes every drifted file look `both-diverged` even when content matches.
          const platformHash = hashPayload(
            canonicalizeForHash(resource, state, credReverse),
          );
          const direction = classifyDrift({
            localHash,
            lastPulledHash,
            platformHash,
          });
          if (driftCounts) driftCounts[direction]++;

          if (direction === "both-diverged") {
            bothDiverged?.push({
              resourceType,
              resourceId,
              resource,
              localHash,
              platformHash,
              lastPulledHash,
            });
            skipped++;
            continue;
          }

          if (direction === "dashboard-ahead") {
            console.log(
              `   ✏️  ${resourceId} (locally modified, preserving) ${formatDriftLabel(direction)}`,
            );
            upsertState(newStateSection, resourceId, { uuid: resource.id });
            skipped++;
            continue;
          }

          if (direction === "local-ahead") {
            // ⬆️ — local has unpushed edits, needs to flow UP to dashboard.
            // Distinct from 📝 (= engine wrote a file to disk) to avoid icon
            // overload in mixed-direction pulls.
            console.log(
              `   ⬆️  ${resourceId} (local ahead of dashboard) ${formatDriftLabel(direction)}`,
            );
            upsertState(newStateSection, resourceId, { uuid: resource.id });
            skipped++;
            continue;
          }

          skipLegacyPreserveChecks = true;
        }
      } else if (localFile && !lastPulledHash && driftCounts) {
        driftCounts["no-baseline"]++;
      }
    }

    // Skip files that have been locally modified (git detection)
    if (!skipLegacyPreserveChecks && !bootstrap && changedFiles) {
      const mdPath = join(
        "resources",
        VAPI_ENV,
        folderPath,
        `${resourceId}.md`,
      );
      const ymlPath = join(
        "resources",
        VAPI_ENV,
        folderPath,
        `${resourceId}.yml`,
      );
      const yamlPath = join(
        "resources",
        VAPI_ENV,
        folderPath,
        `${resourceId}.yaml`,
      );
      if (
        changedFiles.has(mdPath) ||
        changedFiles.has(ymlPath) ||
        changedFiles.has(yamlPath)
      ) {
        console.log(`   ✏️  ${resourceId} (locally modified, preserving)`);
        upsertState(newStateSection, resourceId, { uuid: resource.id });
        skipped++;
        continue;
      }
    }

    // Skip locally edited files even without git (mtime-based detection).
    if (
      !skipLegacyPreserveChecks &&
      !bootstrap &&
      !force &&
      !isNew &&
      (!changedFiles || changedFiles.size === 0)
    ) {
      const dir = join(RESOURCES_DIR, folderPath);
      const localFile = [
        join(dir, `${resourceId}.md`),
        join(dir, `${resourceId}.yml`),
        join(dir, `${resourceId}.yaml`),
      ].find((p) => existsSync(p));
      if (localFile) {
        const stateFilePath = join(BASE_DIR, `.vapi-state.${VAPI_ENV}.json`);
        if (existsSync(stateFilePath)) {
          const localMtime = statSync(localFile).mtimeMs;
          const stateMtime = statSync(stateFilePath).mtimeMs;
          if (localMtime > stateMtime) {
            console.log(`   ✏️  ${resourceId} (locally modified, preserving)`);
            upsertState(newStateSection, resourceId, { uuid: resource.id });
            skipped++;
            continue;
          }
        }
      }
    }

    // Skip resources whose local file was deleted (works without git).
    // A resource that was previously tracked in state but now has no local
    // file is treated as an intentional deletion. To stop tracking it
    // entirely (so it never re-appears on pull), add it to .vapi-ignore.
    if (!bootstrap && !force && !isNew) {
      const dir = join(RESOURCES_DIR, folderPath);
      const fileExists =
        existsSync(join(dir, `${resourceId}.md`)) ||
        existsSync(join(dir, `${resourceId}.yml`)) ||
        existsSync(join(dir, `${resourceId}.yaml`));
      if (!fileExists) {
        console.log(
          `   🗑️  ${resourceId} (deleted locally, intent in state — add to .vapi-ignore to stop tracking)`,
        );
        upsertState(newStateSection, resourceId, { uuid: resource.id });
        skipped++;
        continue;
      }
    }

    // Detect platform defaults (orgId is null/missing — read-only, immutable)
    const isPlatformDefault =
      resource.orgId === null || resource.orgId === undefined;

    // Single canonicalization for both the file write AND the lastPulledHash
    // fallback. Encodes the 3-step pipeline (cleanResource → resolve refs →
    // replace credential UUIDs) plus the _platformDefault marker.
    const withCredNames = canonicalizeForHash(resource, state, credReverse);

    if (bootstrap) {
      const icon = isPlatformDefault ? "🔒" : isNew ? "✨" : "📝";
      console.log(
        `   ${icon} ${resourceId} -> state only${isPlatformDefault ? " (platform default, read-only)" : ""}`,
      );
    } else {
      // Write to file
      const filePath = await writeResourceFile(
        resourceType,
        resourceId,
        withCredNames,
      );
      const icon = isPlatformDefault ? "🔒" : isNew ? "✨" : "📝";
      const relPath = relative(BASE_DIR, filePath);
      console.log(
        `   ${icon} ${resourceId} -> ${relPath}${isPlatformDefault ? " (platform default, read-only)" : ""}`,
      );
    }

    if (isNew) created++;
    else updated++;

    // Update state with new content hash + timestamp.
    //
    // CRITICAL INVARIANT: `lastPulledHash` MUST equal what `hashLocalResource`
    // will return when classifyDrift next inspects this file. The way to
    // guarantee that by construction is to hash the FILE AS WRITTEN TO DISK,
    // not the in-memory payload before YAML/MD serialization. The two diverge
    // for any resource whose YAML round-trip (key order, scalar formatting) or
    // .md frontmatter split/merge isn't identity-preserving — historically the
    // root cause of the simulation-suite phantom-drift logged in
    // improvements.md and the `_platformDefault` marker asymmetry surfaced by
    // code review on the drift-direction-classifier PR.
    //
    // Bootstrap mode writes no file; fall back to the in-memory canonical form.
    upsertState(newStateSection, resourceId, {
      uuid: resource.id,
      lastPulledHash:
        hashLocalResource(resourceType, resourceId) ??
        hashPayload(withCredNames),
      lastPulledAt: new Date().toISOString(),
    });
  }

  // Update state with new mappings
  state[resourceType] = newStateSection;

  return { created, updated, skipped };
}

async function resolveBothDivergedResources(options: {
  state: StateFile;
  bothDiverged: BothDivergedResource[];
  resolveMode?: DriftResolveMode;
}): Promise<{ exitCode: number }> {
  const { state, bothDiverged, resolveMode } = options;
  if (bothDiverged.length === 0) return { exitCode: 0 };

  if (resolveMode === "fail") {
    console.error(
      `\n❌ ${bothDiverged.length} resource(s) have 3-way drift (--resolve=fail).`,
    );
    for (const entry of bothDiverged) {
      console.error(
        `     - ${entry.resourceType}/${entry.resourceId}\n` +
          `       local-hash: ${entry.localHash.slice(0, 8)}…   platform-hash: ${entry.platformHash.slice(0, 8)}…   last-pulled: ${entry.lastPulledHash.slice(0, 8)}…`,
      );
    }
    return { exitCode: 1 };
  }

  if (!resolveMode) {
    console.error(
      `\n❌ ${bothDiverged.length} resource(s) have 3-way drift (both local and dashboard changed since last pull).`,
    );
    console.error(
      "   Pass --resolve=ours|theirs|fail to proceed:",
    );
    for (const entry of bothDiverged) {
      console.error(
        `     - ${FOLDER_MAP[entry.resourceType]}/${entry.resourceId}\n` +
          `       local-hash: ${entry.localHash.slice(0, 8)}…   platform-hash: ${entry.platformHash.slice(0, 8)}…   last-pulled: ${entry.lastPulledHash.slice(0, 8)}…`,
      );
    }
    console.error(
      "\n     --resolve=ours   keep local version (overrides dashboard edits — same as today's preserve-local default; you'll push local up next)",
    );
    console.error(
      "     --resolve=theirs overwrite local with dashboard version (loses local edits; same as --force pull but scoped to both-diverged only)",
    );
    console.error(
      "     --resolve=fail   exit non-zero without writing anything (CI mode — fail the build so a human investigates)",
    );
    return { exitCode: 1 };
  }

  const credReverse = credentialReverseMap(state);

  for (const entry of bothDiverged) {
    const section = state[entry.resourceType];
    if (resolveMode === "ours") {
      console.log(
        `   ⬆️  ${entry.resourceId} (both diverged — resolving with --resolve=ours, preserving local) ${formatDriftLabel("both-diverged")}`,
      );
      // No write — local file is preserved. lastPulledHash = entry.platformHash
      // marks "the last-pulled baseline was the platform state at resolve time,
      // even though we kept local," so the next classifyDrift correctly reports
      // `local-ahead` instead of re-flagging `both-diverged`.
      upsertState(section, entry.resourceId, {
        uuid: entry.resource.id,
        lastPulledHash: entry.platformHash,
        lastPulledAt: new Date().toISOString(),
      });
      continue;
    }

    const withCredNames = canonicalizeForHash(entry.resource, state, credReverse);

    await writeResourceFile(
      entry.resourceType,
      entry.resourceId,
      withCredNames,
    );
    console.log(
      `   ⬇️  ${entry.resourceId} (both diverged — resolving with --resolve=theirs, overwriting local with platform) ${formatDriftLabel("both-diverged")}`,
    );
    // Hash the post-write disk form (same invariant as the normal pull-write path).
    upsertState(section, entry.resourceId, {
      uuid: entry.resource.id,
      lastPulledHash:
        hashLocalResource(entry.resourceType, entry.resourceId) ??
        hashPayload(withCredNames),
      lastPulledAt: new Date().toISOString(),
    });
  }

  return { exitCode: 0 };
}

function printDriftSummary(counts: DriftDirectionCounts): void {
  const lines: string[] = [];
  if (counts["dashboard-ahead"] > 0) {
    lines.push(
      `   ✏️  dashboard-ahead : ${counts["dashboard-ahead"]}  (these resources have UI edits since last pull; preserved locally)`,
    );
  }
  if (counts["local-ahead"] > 0) {
    lines.push(
      `   ⬆️  local-ahead      : ${counts["local-ahead"]}  (run npm run push to propagate local edits up)`,
    );
  }
  if (counts["both-diverged"] > 0) {
    lines.push(`   ⚠️  both-diverged   : ${counts["both-diverged"]}`);
  }
  if (counts["no-baseline"] > 0) {
    lines.push(
      `   ❓ no-baseline      : ${counts["no-baseline"]}  (run pull once with --bootstrap to seed)`,
    );
  }
  if (lines.length === 0) return;
  console.log("\n📊 Drift direction summary:");
  for (const line of lines) console.log(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pull Engine
// ─────────────────────────────────────────────────────────────────────────────

export async function runPull(options: PullOptions = {}): Promise<PullResult> {
  const force = options.force ?? process.argv.includes("--force");
  const bootstrap = options.bootstrap ?? BOOTSTRAP_SYNC;
  const typeFilter = options.typeFilter ?? APPLY_FILTER.resourceTypes;
  const resourceIds = options.resourceIds ?? APPLY_FILTER.resourceIds;
  const resolveMode = parseResolveMode(options.resolveMode);
  const driftCounts = emptyDriftCounts();
  const bothDivergedResources: BothDivergedResource[] = [];

  if (force && process.env.CI !== "true") {
    console.warn(
      "\n⚠️  --force will overwrite local files without showing you direction labels or surfacing 3-way conflicts.",
    );
    console.warn(
      "   Run `npm run pull -- <org>` (no flag) first to see the drift report.",
    );
    console.warn("   Continuing in 2s — Ctrl+C to abort.");
    await sleepMs(2000);
  }

  if (resourceIds?.length) {
    if (!typeFilter?.length || typeFilter.length !== 1) {
      throw new Error(
        "Single-resource pull requires exactly one resource type. Example: npm run pull -- <org> --type squads --id <uuid>",
      );
    }
  }

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(
    `🔄 Vapi GitOps Pull - Environment: ${VAPI_ENV}${force ? " (force)" : ""}${bootstrap ? " (bootstrap)" : ""}`,
  );
  console.log(`   API: ${VAPI_BASE_URL}`);
  if (typeFilter?.length) {
    console.log(`   Filter: ${typeFilter.join(", ")}`);
  }
  if (resourceIds?.length) {
    console.log(`   IDs: ${resourceIds.join(", ")}`);
  }
  if (bootstrap) {
    console.log(
      "   Mode: state sync only (remote resources are not written locally)",
    );
  }
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );

  // Default mode: skip locally changed files (local is source of truth)
  // Force mode: overwrite everything (platform is source of truth)
  let changedFiles: Set<string> | undefined;
  const gitEnabled = !force && !bootstrap && isGitRepo() && gitHasCommits();

  if (gitEnabled) {
    changedFiles = getLocallyChangedFiles();
    // Only keep resource files — non-resource changes don't matter
    for (const f of changedFiles) {
      if (!f.startsWith(`resources/${VAPI_ENV}/`)) changedFiles.delete(f);
    }
    if (changedFiles.size > 0) {
      console.log(
        `\n📦 ${changedFiles.size} locally modified file(s) will be preserved`,
      );
      console.log(
        "   Use --force to overwrite all local files with platform state",
      );
    }
  }

  const ignorePatterns = !bootstrap && !force ? loadIgnorePatterns() : [];
  if (ignorePatterns.length > 0) {
    console.log(
      `\n🚫 ${ignorePatterns.length} pattern(s) loaded from .vapi-ignore — matching resources will be skipped`,
    );
  }

  if (force) {
    console.log(
      "\n⚡ Force mode: overwriting all local files with platform state",
    );
  } else if (bootstrap) {
    console.log(
      "\n🧭 Bootstrap mode: refreshing state and credentials without materializing remote resources",
    );
  }

  const state = loadState();

  // Credentials are always pulled first — they're needed to reverse-resolve UUIDs in resource files
  await pullCredentials(state);

  const zero: PullStats = { created: 0, updated: 0, skipped: 0 };
  const stats: Record<ResourceType, PullStats> = {
    tools: { ...zero },
    structuredOutputs: { ...zero },
    assistants: { ...zero },
    squads: { ...zero },
    personalities: { ...zero },
    scenarios: { ...zero },
    simulations: { ...zero },
    simulationSuites: { ...zero },
    evals: { ...zero },
  };

  // Pull in reverse-resolution order: pull resources that are referenced by others first,
  // so their state is populated when resolving references (UUID → resourceId) in dependent types.
  // e.g. structuredOutputs reference assistants, so assistants must be pulled first.
  const shouldPull = (type: ResourceType) =>
    !typeFilter?.length || typeFilter.includes(type);

  const pullOpts = {
    changedFiles,
    force,
    bootstrap,
    resourceIds,
    driftCounts,
    bothDiverged: bothDivergedResources,
  };

  if (shouldPull("tools"))
    stats.tools = await pullResourceType("tools", state, pullOpts);
  if (shouldPull("assistants"))
    stats.assistants = await pullResourceType("assistants", state, pullOpts);
  if (shouldPull("structuredOutputs"))
    stats.structuredOutputs = await pullResourceType(
      "structuredOutputs",
      state,
      pullOpts,
    );
  if (shouldPull("squads"))
    stats.squads = await pullResourceType("squads", state, pullOpts);
  if (shouldPull("personalities"))
    stats.personalities = await pullResourceType("personalities", state, pullOpts);
  if (shouldPull("scenarios"))
    stats.scenarios = await pullResourceType("scenarios", state, pullOpts);
  if (shouldPull("simulations"))
    stats.simulations = await pullResourceType("simulations", state, pullOpts);
  if (shouldPull("simulationSuites"))
    stats.simulationSuites = await pullResourceType(
      "simulationSuites",
      state,
      pullOpts,
    );
  if (shouldPull("evals"))
    stats.evals = await pullResourceType("evals", state, pullOpts);

  // Collapse UUID-suffixed state keys back to canonical when the underlying
  // name-collision has resolved (the conflicting twin was deleted, etc.).
  // Skipped during bootstrap because bootstrap is supposed to populate state
  // from scratch — there is no prior rekey to undo. Also skipped on targeted
  // ID pulls so we don't sweep types we haven't fully refreshed. When the
  // pull is scoped by typeFilter, the pass is restricted to those types so
  // we don't touch sections this pull didn't refresh — preserves the stated
  // safety boundary even though the preconditions themselves are safe.
  // Pull's saveState writes wholesale, so `touched` isn't needed here.
  if (!bootstrap && !resourceIds?.length) {
    const report = recanonicalizeStateKeys({
      state,
      types: typeFilter?.length ? (typeFilter as ResourceType[]) : undefined,
    });
    const summary = formatRecanonicalizeReport(report);
    if (summary) {
      console.log(`\n${summary}`);
    }
  }

  const resolveResult = await resolveBothDivergedResources({
    state,
    bothDiverged: bothDivergedResources,
    resolveMode,
  });

  await saveState(state);

  // Summary
  const totalSkipped = Object.values(stats).reduce(
    (sum, s) => sum + s.skipped,
    0,
  );
  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );
  console.log("✅ Pull complete!");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  console.log("📋 Summary:");
  for (const [type, { created, updated, skipped }] of Object.entries(stats)) {
    const parts = [`${created} new`, `${updated} updated`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    console.log(`   ${type}: ${parts.join(", ")}`);
  }

  if (totalSkipped > 0) {
    console.log(
      `\n   ℹ️  ${totalSkipped} resource(s) skipped — see lines above for reasons:`,
    );
    console.log("       🚫 = matched .vapi-ignore (not tracked)");
    console.log("       ✏️  = locally modified (preserved)");
    console.log("       ⬆️  = local ahead of dashboard (preserved)");
    console.log("       ⬇️  = both diverged, --resolve=theirs (overwrote local)");
    console.log("       📝 = engine wrote/updated file on disk");
    console.log("       🗑️  = locally deleted (intent in state)");
    console.log(
      `   Run with --force to overwrite: npm run pull -- ${VAPI_ENV} --force`,
    );
  }

  if (!force && !bootstrap) {
    printDriftSummary(driftCounts);
    if (
      driftCounts["dashboard-ahead"] > 0 ||
      driftCounts["both-diverged"] > 0
    ) {
      console.log(
        "\n💡 Tip: run plain pull first (this) to see what changed before resorting to --force.",
      );
      console.log(
        "   --force is for \"I know exactly what I want from the dashboard and I'm overwriting locals\" — rare.",
      );
    }
  }

  if (resolveResult.exitCode !== 0) {
    throw new Error("Pull halted: unresolved 3-way drift (both-diverged).");
  }

  return { state, stats, force, bootstrap };
}

async function main(): Promise<void> {
  await runPull();
}

// Run the pull engine
const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(
      "\n❌ Pull failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
