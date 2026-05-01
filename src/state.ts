import { existsSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { STATE_FILE_PATH, VAPI_ENV } from "./config.ts";
import {
  asResourceState,
  hashPayload,
  sortedKeysReplacer,
  upsertState,
} from "./state-serialize.ts";
import type { ResourceState, StateFile } from "./types.ts";

// Re-export pure helpers so callers can import them from the same file as
// loadState / saveState (less import churn) but the helpers themselves stay
// config-free for testability.
export {
  asResourceState,
  hashPayload,
  sortedKeysReplacer,
  upsertState,
} from "./state-serialize.ts";

// Returns just the UUID for the most common call site (resolver, push,
// pull). Returns undefined if the value isn't a recognized shape.
export function stateUuid(
  section: Record<string, ResourceState>,
  resourceId: string,
): string | undefined {
  const entry = section[resourceId];
  return entry?.uuid;
}

// Migrate one section: wrap any legacy string values as { uuid: string }.
// Mutates in place — safe because the parent `loadState()` clones first via
// the empty-state spread.
function migrateSection(
  raw: Record<string, unknown> | undefined,
): Record<string, ResourceState> {
  const out: Record<string, ResourceState> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    const rs = asResourceState(value);
    if (rs) out[key] = rs;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

function createEmptyState(): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

export function loadState(): StateFile {
  if (!existsSync(STATE_FILE_PATH)) {
    console.log(`📄 Creating new state file for environment: ${VAPI_ENV}`);
    return createEmptyState();
  }

  let content: unknown;
  try {
    content = JSON.parse(readFileSync(STATE_FILE_PATH, "utf-8"));
  } catch (error) {
    // Failing loudly here is deliberate. If we silently fall back to an empty
    // state on a corrupted file, a subsequent push would treat every remote
    // resource as new and create duplicates across the entire org.
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse state file at ${STATE_FILE_PATH}: ${msg}\n` +
        `Refusing to continue — falling back to empty state would cause duplicate ` +
        `resources on next push. Restore the file from git, or delete it manually ` +
        `to start fresh after confirming the environment has no tracked resources.`,
    );
  }

  console.log(`📄 Loaded state file for environment: ${VAPI_ENV}`);
  // Merge with empty state to ensure all keys exist, then run the legacy
  // migration so old state files (Record<string, string>) become
  // Record<string, ResourceState> without rewriting on disk until the next
  // saveState(). A "deploy and immediately rollback" scenario therefore does
  // NOT corrupt state — the read path is purely additive.
  const merged = {
    ...createEmptyState(),
    ...(content as Partial<Record<keyof StateFile, unknown>>),
  };
  return {
    credentials: migrateSection(merged.credentials as Record<string, unknown>),
    assistants: migrateSection(merged.assistants as Record<string, unknown>),
    structuredOutputs: migrateSection(merged.structuredOutputs as Record<string, unknown>),
    tools: migrateSection(merged.tools as Record<string, unknown>),
    squads: migrateSection(merged.squads as Record<string, unknown>),
    personalities: migrateSection(merged.personalities as Record<string, unknown>),
    scenarios: migrateSection(merged.scenarios as Record<string, unknown>),
    simulations: migrateSection(merged.simulations as Record<string, unknown>),
    simulationSuites: migrateSection(merged.simulationSuites as Record<string, unknown>),
    evals: migrateSection(merged.evals as Record<string, unknown>),
  };
}

export async function saveState(state: StateFile): Promise<void> {
  // Atomic write: emit to a sibling temp file, then rename over the target.
  // A crash or SIGINT mid-write leaves the original state intact rather than
  // truncating it. A truncated state file would silently wipe all UUID
  // mappings on the next load.
  const tmpPath = `${STATE_FILE_PATH}.tmp`;
  await writeFile(
    tmpPath,
    JSON.stringify(state, sortedKeysReplacer, 2) + "\n",
  );
  await rename(tmpPath, STATE_FILE_PATH);
  console.log(`💾 Saved state file: ${STATE_FILE_PATH}`);
}
