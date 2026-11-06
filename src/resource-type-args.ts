// How a `--type` argument maps to resource types. Config-free on purpose
// (like api-key.ts): config.ts parses argv and exits at import time, so the
// mapping lives here where setup.ts and tests can import it.

import type { ResourceType } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

// Group aliases: expand a shorthand into multiple resource types
const RESOURCE_GROUP_MAP: Record<string, ResourceType[]> = {
  simulations: [
    "personalities",
    "scenarios",
    "simulations",
    "simulationSuites",
  ],
};

// Path-based aliases: folder paths to resource types
const RESOURCE_PATH_MAP: Record<string, ResourceType> = {
  "simulations/personalities": "personalities",
  "simulations/scenarios": "scenarios",
  "simulations/tests": "simulations",
  "simulations/suites": "simulationSuites",
};

// Resolve a type argument into resource types (handles groups, paths, and direct types)
export function resolveResourceTypes(arg: string): ResourceType[] | null {
  // Check group aliases first (e.g., "simulations" → all 4 simulation types)
  if (RESOURCE_GROUP_MAP[arg]) {
    return RESOURCE_GROUP_MAP[arg];
  }
  // Check path-based aliases (e.g., "simulations/personalities" → ["personalities"])
  if (RESOURCE_PATH_MAP[arg]) {
    return [RESOURCE_PATH_MAP[arg]];
  }
  // Check direct resource type
  if (VALID_RESOURCE_TYPES.includes(arg as ResourceType)) {
    return [arg as ResourceType];
  }
  return null;
}

export const VALID_TYPE_ARGS = [
  ...VALID_RESOURCE_TYPES,
  ...Object.keys(RESOURCE_GROUP_MAP),
  ...Object.keys(RESOURCE_PATH_MAP),
];

/**
 * The `--type` argument that names exactly one resource type. Usually the
 * type itself, but `simulations` is also the group alias for all four
 * simulation types, so the single type is spelled by its folder path,
 * `simulations/tests`. Use this whenever a command builds a `--type` for one
 * type, e.g. a single-resource pull with `--id`.
 */
export function typeArgFor(type: string): string {
  if (!(type in RESOURCE_GROUP_MAP)) return type;
  const pathAlias = Object.keys(RESOURCE_PATH_MAP).find(
    (path) => RESOURCE_PATH_MAP[path] === type,
  );
  return pathAlias ?? type;
}
