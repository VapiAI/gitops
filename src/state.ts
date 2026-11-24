import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { copyFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { BASE_DIR, VAPI_ENV } from "./config.ts";
import { assertStateMigrated } from "./migrate-hash-store.ts";
import {
  stateFileLeftover,
  stateFileRead,
  stateFileWrite,
  stateLayoutPrepare,
  stateNoticesPrint,
  stateSavedStampPath,
} from "./state-paths.ts";
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

export function createEmptyState(): StateFile {
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

/**
 * Run at the start of a command that writes state, before any request: stop
 * when the org's state can't be written safely where it is (state-paths.ts),
 * then refuse a state file still in the legacy per-resource-hash format.
 */
export function stateWritePrepare(options: { dryRun?: boolean } = {}): void {
  // A dry run writes nothing, so there is nothing to check or say.
  if (!options.dryRun)
    stateNoticesPrint(stateLayoutPrepare(BASE_DIR, VAPI_ENV));
  assertStateMigrated(stateFileRead(BASE_DIR, VAPI_ENV));
}

export function loadState(): StateFile {
  const statePath = stateFileRead(BASE_DIR, VAPI_ENV);
  if (!existsSync(statePath)) {
    console.log(`📄 Creating new state file for environment: ${VAPI_ENV}`);
    return createEmptyState();
  }

  let content: unknown;
  try {
    content = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch (error) {
    // Failing loudly here is deliberate. If we silently fall back to an empty
    // state on a corrupted file, a subsequent push would treat every remote
    // resource as new and create duplicates across the entire org.
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse state file at ${statePath}: ${msg}\n` +
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
    structuredOutputs: migrateSection(
      merged.structuredOutputs as Record<string, unknown>,
    ),
    tools: migrateSection(merged.tools as Record<string, unknown>),
    squads: migrateSection(merged.squads as Record<string, unknown>),
    personalities: migrateSection(
      merged.personalities as Record<string, unknown>,
    ),
    scenarios: migrateSection(merged.scenarios as Record<string, unknown>),
    simulations: migrateSection(merged.simulations as Record<string, unknown>),
    simulationSuites: migrateSection(
      merged.simulationSuites as Record<string, unknown>,
    ),
    evals: migrateSection(merged.evals as Record<string, unknown>),
  };
}

export async function saveState(state: StateFile): Promise<void> {
  // Atomic write: emit to a sibling temp file, then rename over the target.
  // A crash or SIGINT mid-write leaves the original state intact rather than
  // truncating it. A truncated state file would silently wipe all UUID
  // mappings on the next load.
  const statePath = stateFileWrite(BASE_DIR, VAPI_ENV);
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, sortedKeysReplacer, 2) + "\n");
  await rename(tmpPath, statePath);
  // An old copy left beside it is kept identical until migrate removes it.
  const leftover = stateFileLeftover(BASE_DIR, VAPI_ENV);
  if (leftover) await copyFile(statePath, leftover);
  // Pull compares a file against this moment when it has no baseline for it.
  const stamp = stateSavedStampPath(BASE_DIR, VAPI_ENV);
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  console.log(`💾 Saved state file: ${statePath}`);
}
