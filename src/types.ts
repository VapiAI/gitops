// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StateFile {
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
  resourceId: string; // Path relative to resource type dir (e.g., "healthcare/booking" or just "booking")
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

export type Environment = "dev" | "staging" | "prod";

export const VALID_ENVIRONMENTS: readonly Environment[] = ["dev", "staging", "prod"];

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

