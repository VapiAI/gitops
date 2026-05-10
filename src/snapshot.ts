// ─────────────────────────────────────────────────────────────────────────────
// Snapshot-on-push
//
// Before each PATCH, write the *outgoing* (local) payload AND the *current
// platform* payload to a per-push directory:
//
//   .vapi-state.<env>.snapshots/<ISO-timestamp>/<resource-type>/<id>.json
//
// `npm run rollback -- <env> --to <timestamp>` re-applies each
// `platform` payload as a PATCH, restoring the dashboard to its state at
// the moment of the snapshot.
//
// Reuses the drift-detection fetch path: when drift detection ran for this
// PATCH, the GET'd platform payload is passed in here so we don't pay a
// second GET. Snapshots are local-operator state and are gitignored.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { sortedKeysReplacer } from "./state-serialize.ts";

export function snapshotsRoot(baseDir: string, env: string): string {
  return join(baseDir, `.vapi-state.${env}.snapshots`);
}

let activeRunDir: string | null = null;

// Pin a single timestamp per push run. All resources written during the run
// share one directory so rollback can target an entire push, not individual
// PATCHes.
export function getRunSnapshotDir(baseDir: string, env: string): string {
  if (!activeRunDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    activeRunDir = join(snapshotsRoot(baseDir, env), timestamp);
  }
  return activeRunDir;
}

// Test-only: reset the in-process timestamp so successive pushes within a
// single test produce distinct snapshot dirs.
export function _resetRunSnapshotDir(): void {
  activeRunDir = null;
}

export interface SnapshotPayload {
  // What WE were about to push.
  outgoing: unknown;
  // What was on the dashboard right before our push (drift baseline).
  platform: unknown;
}

export async function writeSnapshot(options: {
  baseDir: string;
  env: string;
  resourceType: string;
  resourceId: string;
  payload: SnapshotPayload;
}): Promise<string> {
  const dir = join(getRunSnapshotDir(options.baseDir, options.env), options.resourceType);
  await mkdir(dir, { recursive: true });
  const fileName = `${options.resourceId.replace(/\//g, "__")}.json`;
  const filePath = join(dir, fileName);
  await writeFile(
    filePath,
    JSON.stringify(options.payload, sortedKeysReplacer, 2) + "\n",
  );
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback support
// ─────────────────────────────────────────────────────────────────────────────

export async function listSnapshotTimestamps(
  baseDir: string,
  env: string,
): Promise<string[]> {
  const root = snapshotsRoot(baseDir, env);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export interface SnapshotEntry {
  resourceType: string;
  resourceId: string;
  payload: SnapshotPayload;
}

export async function loadSnapshot(
  baseDir: string,
  env: string,
  timestamp: string,
): Promise<SnapshotEntry[]> {
  const dir = join(snapshotsRoot(baseDir, env), timestamp);
  if (!existsSync(dir)) {
    throw new Error(`Snapshot not found: ${dir}`);
  }
  const types = await readdir(dir, { withFileTypes: true });
  const entries: SnapshotEntry[] = [];
  for (const t of types) {
    if (!t.isDirectory()) continue;
    const typeDir = join(dir, t.name);
    const files = await readdir(typeDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const content = await readFile(join(typeDir, f), "utf-8");
      const payload = JSON.parse(content) as SnapshotPayload;
      const resourceId = f.replace(/\.json$/, "").replace(/__/g, "/");
      entries.push({
        resourceType: t.name,
        resourceId,
        payload,
      });
    }
  }
  return entries;
}
