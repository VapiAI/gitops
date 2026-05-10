// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// Per-resource state metadata. State values are a structured ResourceState
// carrying content hashes, timestamps, and an optional platform version ID
// for ETag-based optimistic concurrency.
//
// Backwards compatibility: legacy state files loaded with bare string values
// are migrated at load time in `loadState()` — each string becomes
// { uuid: <string> } with no other fields. The first push or pull after
// migration populates the hash fields. Until then, drift detection
// short-circuits cleanly because `lastPulledHash` is undefined.
//
// Why preserve backwards-compat instead of doing a flag-day migration:
//   - Customer state files are committed to git. A breaking schema change
//     would require a coordinated merge across every customer fork.
//   - The fields are all optional except `uuid`, so existing loaders that
//     only need the UUID work unchanged after going through the helpers
//     in this module.
export interface ResourceState {
  uuid: string;
  // sha256 of the canonicalized platform payload at last pull. Set by
  // `pull.ts` after `cleanResource()` + canonical sort. Used by drift
  // detection.
  lastPulledHash?: string;
  // ISO-8601 timestamp of the last pull. Useful for triage when investigating
  // "when did this drift?".
  lastPulledAt?: string;
  // sha256 of the canonicalized payload that was last sent on PATCH/POST.
  // Distinct from `lastPulledHash` because we may push without pulling.
  lastPushedHash?: string;
  // Platform-provided ETag / version identifier for optimistic concurrency.
  // Engine populates it from response headers when the platform exposes one.
  platformVersionId?: string;
}

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
