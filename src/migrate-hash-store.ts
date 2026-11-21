// One-time migration from the legacy fat state file to the slim
// `name → { uuid }` state file + the per-machine baseline store, and from
// the old file locations into `state/<org>/` (see state-paths.ts).
//
// This whole module is a REMOVABLE SEAM. When the migration is no longer
// needed, delete this file + `migrate-cmd.ts`, remove the `assertStateMigrated`
// calls from the pull/push/apply entry points, and drop the `migrate` npm
// script. Nothing else references it.
//
// CONFIG-FREE by design (no `config.ts` import): `migrate` runs without an org
// argument or a VAPI_TOKEN, across every org's state file in the repo at once.

import { existsSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { relative } from "path";
import {
  HASH_STORE_BASE_DIR,
  readBaseline,
  writeBaseline,
} from "./hash-store.ts";
import {
  commitStepAsk,
  STATE_DIR,
  stateFileRead,
  stateMove,
  stateMoveRead,
  stateOrgsList,
} from "./state-paths.ts";
import { asResourceState, sortedKeysReplacer } from "./state-serialize.ts";
import type { ResourceState } from "./types.ts";

// Repo root, shared with the hash store (single source).
const BASE_DIR = HASH_STORE_BASE_DIR;

export interface OrgMigrationResult {
  org: string;
  stateFile: string;
  seeded: number; // baselines written into the hash store
  skipped: number; // legacy hashes ignored because a baseline already existed
  slimmed: boolean; // whether the state file was rewritten to slim form
  moved: string[]; // what moved into state/<org>/; empty when nothing did
}

export interface MigrationResult {
  orgs: OrgMigrationResult[];
  /** Set when nothing moved: what the commit step has to stage first. */
  commitStepAsk?: string[];
}

// A legacy entry is anything that isn't already exactly `{ uuid: string }`:
// a bare string (oldest form) or an object carrying extra fields
// (lastPulledHash / lastPulledAt / lastPushedHash / platformVersionId).
function isLegacyEntry(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.some((k) => k !== "uuid" && k !== "origin");
  }
  return false;
}

function legacyHash(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const pulled = rec.lastPulledHash;
  if (typeof pulled === "string" && pulled.length > 0) return pulled;
  const pushed = rec.lastPushedHash;
  if (typeof pushed === "string" && pushed.length > 0) return pushed;
  return undefined;
}

function uuidOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const u = (value as { uuid?: unknown }).uuid;
    if (typeof u === "string") return u;
  }
  return undefined;
}

// Treat a top-level value as a "section" if it's a plain object whose values
// look like state entries (string or { uuid }). This avoids hard-coding the
// section list, so the migration keeps working if a section is added later.
function isSection(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function migrateOne(
  baseDir: string,
  org: string,
  move: boolean,
): Promise<OrgMigrationResult> {
  const stateFilePath = stateFileRead(baseDir, org);
  const raw = JSON.parse(readFileSync(stateFilePath, "utf-8")) as Record<
    string,
    unknown
  >;

  let seeded = 0;
  let skipped = 0;
  let needsSlim = false;
  const slim: Record<string, Record<string, ResourceState>> = {};

  for (const [sectionKey, section] of Object.entries(raw)) {
    if (!isSection(section)) {
      // Preserve any non-section top-level value verbatim (none expected,
      // but don't silently drop unknown shapes).
      (slim as Record<string, unknown>)[sectionKey] = section;
      continue;
    }
    const slimSection: Record<string, ResourceState> = {};
    for (const [resourceId, value] of Object.entries(section)) {
      if (isLegacyEntry(value)) needsSlim = true;
      const uuid = uuidOf(value);
      if (!uuid) continue; // unrecoverable entry — drop it

      // Seed the baseline from the legacy hash if we don't have one yet.
      const hash = legacyHash(value);
      if (hash) {
        if (readBaseline(org, uuid) === undefined) {
          await writeBaseline(org, uuid, hash);
          seeded++;
        } else {
          skipped++;
        }
      }
      slimSection[resourceId] = asResourceState(value)!;
    }
    slim[sectionKey] = slimSection;
  }

  if (needsSlim) {
    const tmpPath = `${stateFilePath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify(slim, sortedKeysReplacer, 2) + "\n",
    );
    await rename(tmpPath, stateFilePath);
  }

  // Slim first, in place, then move: each step leaves one complete state
  // file.
  const moved = move ? stateMove(baseDir, org) : [];
  return {
    org,
    stateFile: relative(baseDir, stateFileRead(baseDir, org)),
    seeded,
    skipped,
    slimmed: needsSlim,
    moved,
  };
}

// Migrate every org's state file, in either location: seed missing baselines
// from legacy hashes, rewrite the file to slim form, then move the org's
// engine files into `state/<org>/`. Idempotent — re-running on a migrated
// repo seeds nothing, rewrites nothing and moves nothing.
//
// This is the only place committed state moves. It moves when every commit
// step in .github/workflows/ is seen to stage state/, or when a person has
// said theirs does (commitStepAcknowledge). Otherwise files are slimmed in
// place and nothing moves.
export async function migrateAll(
  baseDir: string = BASE_DIR,
): Promise<MigrationResult> {
  const { open } = stateMoveRead(baseDir);
  const orgs: OrgMigrationResult[] = [];
  for (const org of stateOrgsList(baseDir)) {
    orgs.push(await migrateOne(baseDir, org, open));
  }
  return { orgs, commitStepAsk: commitStepAsk(baseDir) };
}

/** The line `npm run migrate` prints for what moved for one org. */
export function migrateMovedLine(org: OrgMigrationResult): string | undefined {
  if (org.moved.length === 0) return undefined;
  return (
    `📦 Moved ${org.moved.join(", ")} into ${STATE_DIR}/${org.org}/.` +
    (org.moved.some((label) => !label.endsWith("/"))
      ? " Commit the removal together with the new folder."
      : "")
  );
}

// Guard called at the entry of pull/push/apply. Throws if the given state file
// is still in the legacy format (any entry that isn't exactly `{ uuid }`). A
// missing or empty file is new-style by definition (fresh repos / --bootstrap
// must not be blocked). Shape-only check — never inspects the hash store.
//
// The path is passed in (rather than read from config) so this module stays
// config-free; callers pass stateFileRead(), which names the file in
// whichever layout the org is in.
export function assertStateMigrated(stateFilePath: string): void {
  if (!existsSync(stateFilePath)) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(stateFilePath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    // A parse failure is a separate problem handled by loadState's loud throw.
    // Don't mask it as a migration issue.
    return;
  }

  for (const section of Object.values(raw)) {
    if (!isSection(section)) continue;
    for (const value of Object.values(section)) {
      if (isLegacyEntry(value)) {
        throw new Error(
          `State file ${stateFilePath} is in the legacy format ` +
            `(carries per-resource hashes/timestamps). Run \`npm run migrate\` ` +
            `first to slim every state file and seed the drift baselines.`,
        );
      }
    }
  }
}
