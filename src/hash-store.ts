// Per-developer drift baseline store.
//
// The "last known platform state" content hash for each resource lives here,
// in `state/<org>/local/baselines/<uuid>` (`.vapi-state-hash/<org>/<uuid>`
// while the org's state is still in the old layout) — one file per resource,
// filename is the platform UUID, contents are the sha256 baseline hash. This is the hash a
// push compares against the live dashboard to decide whether someone changed
// the resource out of band since I last pulled or pushed it.
//
// Design constraints:
//   - GITIGNORED, per-developer. The baseline is "what *I* last saw on the
//     platform," not a shared fact — it must not be committed.
//   - CONFIG-FREE. This module must NOT import `config.ts`, which parses a
//     single org and `process.exit(1)`s at module load if no VAPI_TOKEN is
//     set. The migration command needs to operate on every org without a
//     token, so the org is always passed in explicitly and BASE_DIR is
//     computed here the same way `config.ts` computes it.
//   - The filename (UUID) is purely organizational. The hash is computed over
//     canonical resource CONTENT by callers; this module never inspects it.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { join } from "path";
import { baseDir } from "./base-dir.ts";
import {
  baselinesDir,
  baselinesLegacyDir,
  baselinesWriteDir,
} from "./state-paths.ts";

// Same expression as config.ts: the repo root is one level up from src/.
const BASE_DIR = baseDir();

// Exported so the migration works on the same repository root.
export const HASH_STORE_BASE_DIR = BASE_DIR;

// Guard against a UUID that would escape its org folder. Platform UUIDs never
// contain these, but reading them straight into a path warrants a check.
function assertSafeUuid(uuid: string): void {
  if (
    !uuid ||
    uuid.includes("/") ||
    uuid.includes("\\") ||
    uuid.includes("..")
  ) {
    throw new Error(
      `Refusing to use unsafe hash-store key: ${JSON.stringify(uuid)}`,
    );
  }
}

// Where baselines are written: state/<org>/local/baselines/, or
// .vapi-state-hash/<org>/ while the org's state is still in the old layout.
export function hashStoreDir(org: string): string {
  return baselinesWriteDir(BASE_DIR, org);
}

// Every place a baseline can be, the one that is written first.
function baselinePaths(org: string, uuid: string): string[] {
  assertSafeUuid(uuid);
  const dirs = new Set([
    hashStoreDir(org),
    baselinesDir(BASE_DIR, org),
    baselinesLegacyDir(BASE_DIR, org),
  ]);
  return [...dirs].map((dir) => join(dir, uuid));
}

// Read the baseline hash for a resource, or undefined if none has been
// recorded yet (fresh clone, never pulled/pushed). Undefined maps to the
// `no-baseline` drift direction — the caller proceeds without blocking.
//
// After `npm run migrate` on another machine, this machine's baselines still
// sit in .vapi-state-hash/<org>/ until its next pull, push or apply moves the
// folder. Read from both places, so a read-only command sees the same drift.
export function readBaseline(org: string, uuid: string): string | undefined {
  const path = baselinePaths(org, uuid).find((candidate) =>
    existsSync(candidate),
  );
  if (!path) return undefined;
  const contents = readFileSync(path, "utf-8").trim();
  return contents.length > 0 ? contents : undefined;
}

// Write (or overwrite) the baseline hash for a resource. Atomic: emit to a
// sibling temp file then rename over the target, so a crash mid-write can't
// leave a truncated hash that would manufacture phantom drift. Creates the
// org subfolder on demand.
export async function writeBaseline(
  org: string,
  uuid: string,
  hash: string,
): Promise<void> {
  const path = baselinePaths(org, uuid)[0]!;
  mkdirSync(hashStoreDir(org), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${hash}\n`);
  await rename(tmpPath, path);
}

// Remove a baseline. Used when a stale state mapping is dropped (the resource
// no longer exists on the platform), mirroring the existing
// `delete stateSection[resourceId]` recovery. Missing file is a no-op.
export async function deleteBaseline(org: string, uuid: string): Promise<void> {
  const { rm } = await import("fs/promises");
  for (const path of baselinePaths(org, uuid)) await rm(path, { force: true });
}
