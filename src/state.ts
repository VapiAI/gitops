import { existsSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { STATE_FILE_PATH, VAPI_ENV } from "./config.ts";
import type { StateFile } from "./types.ts";

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
  // Merge with empty state to ensure all keys exist (for backwards compatibility)
  return {
    ...createEmptyState(),
    ...(content as Partial<StateFile>),
  } as StateFile;
}

export async function saveState(state: StateFile): Promise<void> {
  // Atomic write: emit to a sibling temp file, then rename over the target.
  // A crash or SIGINT mid-write leaves the original state intact rather than
  // truncating it. A truncated state file would silently wipe all UUID
  // mappings on the next load.
  const tmpPath = `${STATE_FILE_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n");
  await rename(tmpPath, STATE_FILE_PATH);
  console.log(`💾 Saved state file: ${STATE_FILE_PATH}`);
}
