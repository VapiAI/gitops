// One-time migration from the legacy fat state file to the slim
// `name → { uuid }` state file + `.vapi-state-hash/<org>/<uuid>` baseline store.
//
// This whole module is a REMOVABLE SEAM. When the migration is no longer
// needed, delete this file + `migrate-cmd.ts`, remove the `assertStateMigrated`
// calls from the pull/push/apply entry points, and drop the `migrate` npm
// script. Nothing else references it.
//
// CONFIG-FREE by design (no `config.ts` import): `migrate` runs without an org
// argument or a VAPI_TOKEN, across every `.vapi-state.<org>.json` in the repo
// at once.

import { existsSync, readdirSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { HASH_STORE_ROOT, readBaseline, writeBaseline } from "./hash-store.ts";
import { sortedKeysReplacer } from "./state-serialize.ts";

// Repo root, derived from the hash store's known location (single source).
const BASE_DIR = dirname(HASH_STORE_ROOT);

const STATE_FILE_RE = /^\.vapi-state\.(.+)\.json$/;

export interface OrgMigrationResult {
  org: string;
  stateFile: string;
  seeded: number; // baselines written into the hash store
  skipped: number; // legacy hashes ignored because a baseline already existed
  slimmed: boolean; // whether the state file was rewritten to slim form
}

export interface MigrationResult {
  orgs: OrgMigrationResult[];
}

// A legacy entry is anything that isn't already exactly `{ uuid: string }`:
// a bare string (oldest form) or an object carrying extra fields
// (lastPulledHash / lastPulledAt / lastPushedHash / platformVersionId).
function isLegacyEntry(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.some((k) => k !== "uuid");
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

function discoverStateFiles(baseDir: string): Array<{ org: string; path: string }> {
  const out: Array<{ org: string; path: string }> = [];
  for (const name of readdirSync(baseDir)) {
    const m = STATE_FILE_RE.exec(name);
    if (!m || !m[1]) continue;
    out.push({ org: m[1], path: join(baseDir, name) });
  }
  return out.sort((a, b) => a.org.localeCompare(b.org));
}

async function migrateOne(
  org: string,
  stateFilePath: string,
): Promise<OrgMigrationResult> {
  const raw = JSON.parse(readFileSync(stateFilePath, "utf-8")) as Record<
    string,
    unknown
  >;

  let seeded = 0;
  let skipped = 0;
  let needsSlim = false;
  const slim: Record<string, Record<string, { uuid: string }>> = {};

  for (const [sectionKey, section] of Object.entries(raw)) {
    if (!isSection(section)) {
      // Preserve any non-section top-level value verbatim (none expected,
      // but don't silently drop unknown shapes).
      (slim as Record<string, unknown>)[sectionKey] = section;
      continue;
    }
    const slimSection: Record<string, { uuid: string }> = {};
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
      slimSection[resourceId] = { uuid };
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

  return { org, stateFile: basename(stateFilePath), seeded, skipped, slimmed: needsSlim };
}

// Migrate every `.vapi-state.<org>.json` in the repo root: seed missing
// baselines from legacy hashes, then rewrite each state file to slim form.
// Idempotent — re-running on already-slim files seeds nothing and rewrites
// nothing.
export async function migrateAll(
  baseDir: string = BASE_DIR,
): Promise<MigrationResult> {
  const files = discoverStateFiles(baseDir);
  const orgs: OrgMigrationResult[] = [];
  for (const { org, path } of files) {
    orgs.push(await migrateOne(org, path));
  }
  return { orgs };
}

// Guard called at the entry of pull/push/apply. Throws if the given state file
// is still in the legacy format (any entry that isn't exactly `{ uuid }`). A
// missing or empty file is new-style by definition (fresh repos / --bootstrap
// must not be blocked). Shape-only check — never inspects the hash store.
//
// The path is passed in (rather than read from config) so this module stays
// config-free; org-scoped callers already have STATE_FILE_PATH loaded.
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
            `first to slim every state file and seed the .vapi-state-hash/ ` +
            `baseline store.`,
        );
      }
    }
  }
}
