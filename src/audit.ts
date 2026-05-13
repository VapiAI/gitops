// ─────────────────────────────────────────────────────────────────────────────
// Read-only audit — detects orphan / duplicate / drift conditions in gitops
// state that have been accumulating cruft in customer-fork repos.
//
// Surfaces seven conditions (none mutate state or filesystem):
//   1. orphan-yaml          local YAML with no state entry
//   2. state-ghost          state UUID missing from dashboard
//   3. state-uuid-collision multiple slugs pointing at the same UUID
//   4. content-identical    multiple slugs sharing the same lastPulledHash
//   5. sibling-base-slug    multiple slugs sharing the same base-slug
//   6. dashboard-orphan     dashboard UUID not in state (.vapi-ignore suppresses)
//   7. inline-tools         assistant with non-empty model.tools (use toolIds)
//
// Designed for dependency injection: state loader, local file lister, remote
// fetcher, and per-assistant tool reader are all swappable so tests stay
// filesystem-free and network-free.
//
// CLI entry: `npm run audit -- <org>`. Exit code 0 if clean, 1 if any finding.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from "fs/promises";
import { join } from "path";
import { matchesIgnore, RESOURCES_DIR } from "./config.ts";
import {
  extractBaseSlug,
  fetchAllResources,
  listExistingResourceIds,
  type VapiResource,
} from "./pull.ts";
import { FOLDER_MAP } from "./resources.ts";
import { loadState } from "./state.ts";
import type { ResourceType, StateFile } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type AuditRule =
  | "orphan-yaml"
  | "state-ghost"
  | "state-uuid-collision"
  | "content-identical"
  | "sibling-base-slug"
  | "dashboard-orphan"
  | "inline-tools";

export type AuditSeverity = "warn" | "error";

export interface AuditFinding {
  severity: AuditSeverity;
  type: ResourceType;
  rule: AuditRule;
  resourceIds: string[]; // 1+ slugs
  uuid?: string; // for state-ghost / dashboard-orphan / collision
  message: string;
  suggestedAction?: string;
}

export interface AuditOptions {
  // Subset of resource types to audit. Defaults to VALID_RESOURCE_TYPES.
  types?: ResourceType[];
  // When false, skips fetchAllResources calls — used by tests AND for a
  // fully-offline mode if we ever want it. Default true.
  fetchRemote?: boolean;
  // DI seam: swap the network call. When supplied, `fetchRemote` is implied
  // true and the default `fetchAllResources` is not used.
  remoteFetcher?: (t: ResourceType) => Promise<VapiResource[]>;
  // DI seam: swap state loading (default reads .vapi-state.<env>.json).
  stateLoader?: () => StateFile;
  // DI seam: swap local-file enumeration (default walks resources/<env>/<type>/).
  listLocalIds?: (t: ResourceType) => string[];
  // DI seam: swap per-assistant inline-tool reader. Returning a non-empty
  // array marks the assistant as carrying inline tools. Defaults to YAML/MD
  // frontmatter parsing of the assistant file on disk. Sync OR async return
  // is accepted so tests can keep their fixtures plain-object.
  readAssistantTools?: (resourceId: string) => unknown[] | Promise<unknown[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default DI implementations
// ─────────────────────────────────────────────────────────────────────────────

// Read assistants/<resourceId>.{md,yml,yaml} and pull out `model.tools` if it's
// an array. Returns [] when the file is missing, malformed, or the field is
// absent. Designed to be tolerant — audit is read-only and should not throw
// on unparseable assistant files (push/validate already surface those).
async function defaultReadAssistantTools(
  resourceId: string,
): Promise<unknown[]> {
  const baseDir = join(RESOURCES_DIR, FOLDER_MAP.assistants);
  const candidates = [
    join(baseDir, `${resourceId}.md`),
    join(baseDir, `${resourceId}.yml`),
    join(baseDir, `${resourceId}.yaml`),
  ];

  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      continue;
    }

    // For .md we only need the frontmatter; for .yml/.yaml the whole file.
    let yamlSource = raw;
    if (path.endsWith(".md")) {
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) return [];
      yamlSource = match[1] ?? "";
    }

    // Lazy import yaml to keep the module light when DI is used in tests.
    const { parse: parseYaml } = await import("yaml");
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlSource);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const model = (parsed as { model?: unknown }).model;
    if (!model || typeof model !== "object") return [];
    const tools = (model as { tools?: unknown }).tools;
    return Array.isArray(tools) ? tools : [];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug helpers (kept local; mirror src/pull.ts conventions)
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function extractRemoteName(resource: VapiResource): string | undefined {
  if (typeof resource.name === "string" && resource.name) return resource.name;
  // Tools store their name under function.name
  const fn = (resource as { function?: unknown }).function;
  if (fn && typeof fn === "object") {
    const fname = (fn as { name?: unknown }).name;
    if (typeof fname === "string" && fname) return fname;
  }
  return undefined;
}

// Build the candidate resourceId(s) that a dashboard-orphan UUID would map to,
// so we can check them against `.vapi-ignore`. Two shapes are produced because
// real customer .vapi-ignore patterns target either form:
//   - the bare name-slug (e.g. `assistants/iform-triage-classifier`)
//   - the `<name>-<uuid8>` form pull.ts emits (`assistants/iform-...-d98136d9`)
function candidateResourceIdsForRemote(resource: VapiResource): string[] {
  const name = extractRemoteName(resource);
  const shortId = resource.id.slice(0, 8);
  if (!name) return [`resource-${shortId}`];
  const baseSlug = slugify(name);
  return [baseSlug, `${baseSlug}-${shortId}`];
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual check implementations
//
// Each takes the per-type inputs it needs and returns AuditFinding[]. Keeping
// them small and pure makes the test surface obvious and avoids the "one giant
// function with seven nested loops" antipattern.
// ─────────────────────────────────────────────────────────────────────────────

function checkOrphanYaml(
  type: ResourceType,
  localIds: string[],
  state: StateFile,
): AuditFinding[] {
  const stateKeys = new Set(Object.keys(state[type]));
  const findings: AuditFinding[] = [];
  for (const localId of localIds) {
    if (stateKeys.has(localId)) continue;
    findings.push({
      severity: "warn",
      type,
      rule: "orphan-yaml",
      resourceIds: [localId],
      message: `local file ${type}/${localId} has no state entry`,
      suggestedAction:
        "delete file OR run `npm run pull` to re-key it into state",
    });
  }
  return findings;
}

function checkStateGhosts(
  type: ResourceType,
  state: StateFile,
  remoteUuids: Set<string>,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const [resourceId, entry] of Object.entries(state[type])) {
    if (remoteUuids.has(entry.uuid)) continue;
    findings.push({
      severity: "warn",
      type,
      rule: "state-ghost",
      resourceIds: [resourceId],
      uuid: entry.uuid,
      message: `state entry ${type}/${resourceId} points at UUID ${entry.uuid} which is not on the dashboard`,
      suggestedAction:
        "remove state entry; dashboard resource no longer exists",
    });
  }
  return findings;
}

function checkStateUuidCollisions(
  type: ResourceType,
  state: StateFile,
): AuditFinding[] {
  const byUuid = new Map<string, string[]>();
  for (const [resourceId, entry] of Object.entries(state[type])) {
    const slugs = byUuid.get(entry.uuid) ?? [];
    slugs.push(resourceId);
    byUuid.set(entry.uuid, slugs);
  }

  const findings: AuditFinding[] = [];
  for (const [uuid, slugs] of byUuid) {
    if (slugs.length < 2) continue;
    findings.push({
      severity: "error",
      type,
      rule: "state-uuid-collision",
      resourceIds: slugs.slice().sort(),
      uuid,
      message: `${slugs.length} state slugs for ${type} share UUID ${uuid}: ${slugs.join(", ")}`,
      suggestedAction:
        "manual state edit — pick one slug and delete the others",
    });
  }
  return findings;
}

function checkContentIdentical(
  type: ResourceType,
  state: StateFile,
): { findings: AuditFinding[]; identicalSlugs: Set<string> } {
  const byHash = new Map<string, string[]>();
  for (const [resourceId, entry] of Object.entries(state[type])) {
    const hash = entry.lastPulledHash;
    if (!hash) continue;
    const slugs = byHash.get(hash) ?? [];
    slugs.push(resourceId);
    byHash.set(hash, slugs);
  }

  const findings: AuditFinding[] = [];
  const identicalSlugs = new Set<string>();
  for (const [, slugs] of byHash) {
    if (slugs.length < 2) continue;
    const sorted = slugs.slice().sort();
    for (const s of sorted) identicalSlugs.add(s);
    findings.push({
      severity: "warn",
      type,
      rule: "content-identical",
      resourceIds: sorted,
      message: `${slugs.length} ${type} share the same lastPulledHash (content-identical): ${sorted.join(", ")}`,
      suggestedAction:
        "consolidate references onto a single canonical slug, then retire others via delete-files → push → API-delete → pull",
    });
  }
  return { findings, identicalSlugs };
}

function checkSiblingBaseSlug(
  type: ResourceType,
  state: StateFile,
  identicalSlugs: Set<string>,
): AuditFinding[] {
  const byBase = new Map<string, string[]>();
  for (const resourceId of Object.keys(state[type])) {
    const base = extractBaseSlug(resourceId);
    // A resourceId without the `-<8hex>` suffix returns itself — clustering
    // bare slugs against suffixed ones is the whole point, so keep them.
    const slugs = byBase.get(base) ?? [];
    slugs.push(resourceId);
    byBase.set(base, slugs);
  }

  const findings: AuditFinding[] = [];
  for (const [base, slugs] of byBase) {
    if (slugs.length < 2) continue;
    const sorted = slugs.slice().sort();
    const overlapsIdentical = sorted.some((s) => identicalSlugs.has(s));
    const crossRef = overlapsIdentical
      ? " — overlaps with content-identical cluster (cascade-duplicate risk)"
      : "";
    findings.push({
      severity: "warn",
      type,
      rule: "sibling-base-slug",
      resourceIds: sorted,
      message: `${slugs.length} ${type} share base slug "${base}": ${sorted.join(", ")}${crossRef}`,
      suggestedAction: "investigate cascade-duplicate risk",
    });
  }
  return findings;
}

function checkDashboardOrphans(
  type: ResourceType,
  state: StateFile,
  remote: VapiResource[],
): AuditFinding[] {
  const knownUuids = new Set<string>();
  for (const entry of Object.values(state[type])) knownUuids.add(entry.uuid);

  const findings: AuditFinding[] = [];
  const folderPath = FOLDER_MAP[type];

  for (const resource of remote) {
    if (knownUuids.has(resource.id)) continue;

    // .vapi-ignore suppression: a customer can intentionally ignore a remote
    // resource (e.g. dashboard-managed test artifact). Try the candidate
    // resourceIds the pull engine would have generated.
    const candidates = candidateResourceIdsForRemote(resource);
    let matchedPattern: string | null = null;
    for (const cand of candidates) {
      matchedPattern = matchesIgnore(folderPath, cand);
      if (matchedPattern) break;
    }
    if (matchedPattern) continue;

    const displayName = extractRemoteName(resource) ?? "(unnamed)";
    findings.push({
      severity: "warn",
      type,
      rule: "dashboard-orphan",
      resourceIds: candidates,
      uuid: resource.id,
      message: `dashboard ${type} "${displayName}" (UUID ${resource.id}) is not tracked in state`,
      suggestedAction:
        "add to `.vapi-ignore` if intentional, or delete from dashboard",
    });
  }
  return findings;
}

async function checkInlineTools(
  state: StateFile,
  readAssistantTools: (resourceId: string) => unknown[] | Promise<unknown[]>,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const resourceId of Object.keys(state.assistants)) {
    const tools = await readAssistantTools(resourceId);
    if (!Array.isArray(tools) || tools.length === 0) continue;
    findings.push({
      severity: "warn",
      type: "assistants",
      rule: "inline-tools",
      resourceIds: [resourceId],
      message: `assistant ${resourceId} declares ${tools.length} inline model.tools (not toolIds references)`,
      suggestedAction:
        "migrate inline tools to `toolIds` references — inline blocks are a suspected duplicate-spawn surface",
    });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: runAudit
// ─────────────────────────────────────────────────────────────────────────────

export async function runAudit(
  opts: AuditOptions = {},
): Promise<AuditFinding[]> {
  const types = opts.types ?? [...VALID_RESOURCE_TYPES];
  const fetchRemote = opts.fetchRemote ?? true;

  const stateLoader = opts.stateLoader ?? loadState;
  const listLocalIds = opts.listLocalIds ?? listExistingResourceIds;
  const remoteFetcher = opts.remoteFetcher ?? fetchAllResources;
  const readAssistantTools =
    opts.readAssistantTools ?? defaultReadAssistantTools;

  const state = stateLoader();

  // Parallelize dashboard fetches per type — the API is per-resource-type and
  // the audit is read-only, so concurrency is safe and noticeably faster on
  // an org with many types.
  const remoteByType = new Map<ResourceType, VapiResource[]>();
  if (fetchRemote) {
    const fetched = await Promise.all(
      types.map(async (t) => [t, await remoteFetcher(t)] as const),
    );
    for (const [t, list] of fetched) remoteByType.set(t, list);
  }

  const findings: AuditFinding[] = [];

  for (const type of types) {
    const localIds = listLocalIds(type);

    findings.push(...checkOrphanYaml(type, localIds, state));

    if (fetchRemote) {
      const remote = remoteByType.get(type) ?? [];
      const remoteUuids = new Set(remote.map((r) => r.id));
      findings.push(...checkStateGhosts(type, state, remoteUuids));
      findings.push(...checkDashboardOrphans(type, state, remote));
    }

    findings.push(...checkStateUuidCollisions(type, state));

    const { findings: identicalFindings, identicalSlugs } =
      checkContentIdentical(type, state);
    findings.push(...identicalFindings);

    findings.push(...checkSiblingBaseSlug(type, state, identicalSlugs));

    if (type === "assistants") {
      findings.push(...(await checkInlineTools(state, readAssistantTools)));
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (used by the CLI handler and exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

export function formatFinding(f: AuditFinding): string {
  const icon = f.severity === "error" ? "❌" : "⚠️ ";
  const uuidSuffix = f.uuid ? ` [uuid=${f.uuid}]` : "";
  const lines = [
    `  ${icon} [${f.rule}] ${f.type}/${f.resourceIds.join(", ")}${uuidSuffix}`,
    `      ${f.message}`,
  ];
  if (f.suggestedAction) {
    lines.push(`      → ${f.suggestedAction}`);
  }
  return lines.join("\n");
}

export function summarizeFindings(findings: AuditFinding[]): string {
  if (findings.length === 0) return "✅ No audit findings.";
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  return `📋 Audit: ${findings.length} finding(s) — ${errors} error(s), ${warns} warning(s)`;
}
