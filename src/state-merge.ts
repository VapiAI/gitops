// Scoped state writes.
//
// On a scoped push (`npm run push -- <env> assistants/foo.md`), the engine
// previously rewrote the entire state file even when only one assistant
// was applied. Pre-existing dashboard drift in unrelated state entries
// would silently sweep into the commit-able diff.
//
// `mergeScoped` produces a new state object where:
//   - Every entry NOT in `touched` is copied from `onDisk` (untouched —
//     leaves pre-existing drift alone).
//   - Every entry IN `touched` is taken from `inMemory` (the live state
//     after the push run).
//
// Untouched-on-platform entries that no longer have a local file are
// preserved AS-IS — they're outside the scope of this push and will be
// reconciled by a subsequent full push or pull.
//
// Credentials always refresh from `inMemory` because bootstrap pull
// rewrites them whether or not a partial filter targeted them.

import type { ResourceState, StateFile } from "./types.ts";

export interface TouchedSets {
  tools: Set<string>;
  structuredOutputs: Set<string>;
  assistants: Set<string>;
  squads: Set<string>;
  personalities: Set<string>;
  scenarios: Set<string>;
  simulations: Set<string>;
  simulationSuites: Set<string>;
  evals: Set<string>;
  credentials: Set<string>;
}

const SECTIONS: Array<keyof StateFile> = [
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

export function mergeScoped(
  onDisk: StateFile,
  inMemory: StateFile,
  touched: TouchedSets,
): StateFile {
  const merged: StateFile = {
    credentials: { ...inMemory.credentials }, // always refresh
    tools: {},
    structuredOutputs: {},
    assistants: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };

  for (const section of SECTIONS) {
    const touchedIds = touched[section];
    const out: Record<string, ResourceState> = {};

    // Copy all on-disk entries that weren't touched (leave them alone).
    for (const [id, entry] of Object.entries(onDisk[section])) {
      if (!touchedIds.has(id)) {
        out[id] = entry;
      }
    }
    // Overlay in-memory entries that WERE touched.
    for (const id of touchedIds) {
      const entry = inMemory[section][id];
      if (entry) out[id] = entry;
    }

    merged[section] = out;
  }

  return merged;
}
