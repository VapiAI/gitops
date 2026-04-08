// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StateFile {
  credentials: Record<string, string>;
  assistants: Record<string, string>;
  structuredOutputs: Record<string, string>;
  tools: Record<string, string>;
  squads: Record<string, string>;
  personalities: Record<string, string>;
  scenarios: Record<string, string>;
  simulations: Record<string, string>;
  simulationSuites: Record<string, string>;
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
  | "simulationSuites";

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
}

export interface OrphanedResource {
  resourceId: string;
  uuid: string;
}
