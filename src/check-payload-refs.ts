// Shared pieces of the inline payload builder: the build context, reference
// lookup (local file by slug, or by UUID through the source org's state),
// and field stripping. Pure; no I/O.

import type { OrgResource } from "./resource-parse.ts";
import { FOLDER_MAP } from "./resource-parse.ts";
import type { ResourceType, StateFile } from "./types.ts";

// Squad member names keyed by every way a file can refer to the member: its
// slug and its source-org UUID.
export type SquadMembers = Map<string, string>;

export interface CheckPayloadContext {
  org: string;
  resources: Map<string, OrgResource>;
  sourceState: StateFile;
  runState: StateFile;
  // toolMocks: strict — tools inside overrides must already be inline.
  strict: boolean;
  // Set once a squad target is built, for scenario targetOverrides.
  targetMembers?: SquadMembers;
  errors: string[];
  warnings: string[];
}

export interface ResolvedRef {
  slug: string;
  resource?: OrgResource;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Server-managed fields push never sends meaningfully; inline copies drop
// them so the payload reads like a create.
const SERVER_FIELDS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "analyticsMetadata",
  "isDeleted",
  "isServerUrlSecretSet",
  "_platformDefault",
];

// Linkage fields that only mean something on stored resources.
const LINK_FIELDS = [
  "assistant_ids",
  "assistantIds",
  "workflow_ids",
  "workflowIds",
];

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

// A `##` suffix is a human comment on a reference (`lookup ## CRM tool`), as
// resolver.ts treats it.
export function refClean(ref: string): string {
  return ref.split("##")[0]?.trim() ?? "";
}

// Find the local file a reference points at: a slug directly, or a UUID
// through the source org's state.
export function refResolve(
  ctx: CheckPayloadContext,
  type: ResourceType,
  ref: string,
): ResolvedRef {
  const clean = refClean(ref);
  let slug = clean;
  if (isUuid(clean)) {
    const entry = Object.entries(ctx.sourceState[type]).find(
      ([, value]) => value.uuid === clean,
    );
    if (!entry) return { slug: clean };
    slug = entry[0];
  }
  return { slug, resource: ctx.resources.get(`${type}:${slug}`) };
}

// The UUID a slug has in the source org, so stored-side references written
// as UUIDs (squad member maps, `assistant_ids`) can be matched.
export function sourceUuid(
  ctx: CheckPayloadContext,
  type: ResourceType,
  slug: string,
): string | undefined {
  return ctx.sourceState[type][slug]?.uuid;
}

export function serverFieldsStrip(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const copy = clone(data);
  for (const key of SERVER_FIELDS) delete copy[key];
  return copy;
}

export function linkedFieldsStrip(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const copy = serverFieldsStrip(data);
  for (const key of LINK_FIELDS) delete copy[key];
  return copy;
}

export function missingRef(
  ctx: CheckPayloadContext,
  label: string,
  type: ResourceType,
  ref: string,
): void {
  ctx.errors.push(
    `${label}: "${refClean(ref)}" has no file in resources/${ctx.org}/${FOLDER_MAP[type]}/`,
  );
}
