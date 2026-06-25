// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// Per-resource state metadata. The state file is a pure `name → { uuid }`
// map: the only thing it records is which platform UUID a local resource
// file is bound to. Nothing else.
//
// The "last known platform state" content hash that drives drift detection
// lives OUTSIDE this file, in the gitignored per-developer hash store at
// `.vapi-state-hash/<org>/<uuid>` (see `hash-store.ts`). Keeping hashes out
// of the committed state file means the state diff is purely semantic
// (added/removed/re-bound resources) and the drift baseline is local to each
// developer's working copy.
//
// Legacy state files (bare string values, or objects carrying lastPulledHash /
// lastPushedHash / lastPulledAt) are NOT loaded by the sync commands — the
// `assertStateMigrated` guard in `migrate-hash-store.ts` blocks pull/push/apply
// until `npm run migrate` has slimmed every state file and seeded the hash
// store from the old hashes.
export interface ResourceState {
  uuid: string;
}

// A managed variable value. Variables are authored by hand in the `variables`
// section of the state file and referenced from resource files via whole-value
// liquid placeholders (`{{name}}`). The value can be any JSON type — at push
// the placeholder is replaced by this value with its native type preserved
// (a number stays a number, an object stays an object). See `variables.ts`.
export type VariableValue =
  | string
  | number
  | boolean
  | null
  | VariableValue[]
  | { [key: string]: VariableValue };

// `name → value` map. Names are identifier-ish (`[A-Za-z0-9_.-]+`, no spaces).
export type Variables = Record<string, VariableValue>;

// `StateFile` is the on-disk shape of `.vapi-state.<env>.json`. Each section
// carries `Record<string, ResourceState>` instead of bare strings.
// `loadState()` migrates legacy data automatically.
export interface StateFile {
  credentials: Record<string, ResourceState>;
  assistants: Record<string, ResourceState>;
  structuredOutputs: Record<string, ResourceState>;
  tools: Record<string, ResourceState>;
  squads: Record<string, ResourceState>;
  personalities: Record<string, ResourceState>;
  scenarios: Record<string, ResourceState>;
  simulations: Record<string, ResourceState>;
  simulationSuites: Record<string, ResourceState>;
  evals: Record<string, ResourceState>;
  // Hand-authored centralized values, referenced from resource files via
  // `{{name}}` placeholders. Unlike the other sections this is NOT a
  // `name → { uuid }` map — it carries raw values. push/pull never mutate it;
  // it round-trips verbatim. See `variables.ts` and `docs/learnings/variables.md`.
  variables: Variables;
}

export interface ResourceFile<T = Record<string, unknown>> {
  resourceId: string; // Path relative to resource type dir (e.g., "support/intake" or just "intake")
  filePath: string;
  data: T;
}

export interface VapiResponse {
  id: string;
  [key: string]: unknown;
}

export type ResourceType =
  | "assistants"
  | "structuredOutputs"
  | "tools"
  | "squads"
  | "personalities"
  | "scenarios"
  | "simulations"
  | "simulationSuites"
  | "evals";

// Any slug-like string: "dev", "prod", "roofr-production", etc.
export type Environment = string;

// Well-known names kept for backward-compatible npm scripts
export const VALID_ENVIRONMENTS: readonly string[] = ["dev", "stg", "prod"];

export const VALID_RESOURCE_TYPES: readonly ResourceType[] = [
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

export interface LoadedResources {
  tools: ResourceFile<Record<string, unknown>>[];
  structuredOutputs: ResourceFile<Record<string, unknown>>[];
  assistants: ResourceFile<Record<string, unknown>>[];
  squads: ResourceFile<Record<string, unknown>>[];
  personalities: ResourceFile<Record<string, unknown>>[];
  scenarios: ResourceFile<Record<string, unknown>>[];
  simulations: ResourceFile<Record<string, unknown>>[];
  simulationSuites: ResourceFile<Record<string, unknown>>[];
  evals: ResourceFile<Record<string, unknown>>[];
}

export interface OrphanedResource {
  resourceId: string;
  uuid: string;
}
