// Where the engine keeps what it generates and tracks.
//
//   state/<org>/state.json          resource name → Vapi UUID (committed)
//   state/<org>/org.json            the Vapi org this folder is pinned to (committed)
//   state/<org>/local/baselines/    drift baselines, one file per UUID (this machine only)
//   state/<org>/local/snapshots/    push snapshots for rollback (this machine only)
//
// Everything under state/ is written by the engine. Hand-written files
// (.vapi-ignore and the resources themselves) stay under resources/<org>/.
//
// Until this folder existed the same files sat at the repository root and in
// resources/<org>/ under dot-names. This module is the only place that knows
// both layouts: it reads the old one, and moves it when that is safe.
//
// Config-free on purpose, so `npm run migrate` and tests can import it
// without an org argument or a token.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "fs";
import { dirname, join } from "path";

export const STATE_DIR = "state";

export function stateOrgDir(rootDir: string, org: string): string {
  return join(rootDir, STATE_DIR, org);
}

export function stateFilePath(rootDir: string, org: string): string {
  return join(stateOrgDir(rootDir, org), "state.json");
}

export function stateFileLegacyPath(rootDir: string, org: string): string {
  return join(rootDir, `.vapi-state.${org}.json`);
}

export function orgPinFilePath(rootDir: string, org: string): string {
  return join(stateOrgDir(rootDir, org), "org.json");
}

export function orgPinFileLegacyPath(rootDir: string, org: string): string {
  return join(rootDir, "resources", org, ".vapi-org.json");
}

export function baselinesDir(rootDir: string, org: string): string {
  return join(stateOrgDir(rootDir, org), "local", "baselines");
}

export function baselinesLegacyDir(rootDir: string, org: string): string {
  return join(rootDir, ".vapi-state-hash", org);
}

export function snapshotsDir(rootDir: string, org: string): string {
  return join(stateOrgDir(rootDir, org), "local", "snapshots");
}

export function snapshotsLegacyDir(rootDir: string, org: string): string {
  return join(rootDir, `.vapi-state.${org}.snapshots`);
}

/** The state file as a person names it: its path from the repository root. */
export function stateFileLabel(rootDir: string, org: string): string {
  return existsSync(stateFilePath(rootDir, org)) ||
    !existsSync(stateFileLegacyPath(rootDir, org))
    ? `${STATE_DIR}/${org}/state.json`
    : `.vapi-state.${org}.json`;
}

function firstExisting(next: string, legacy: string): string {
  return existsSync(next) || !existsSync(legacy) ? next : legacy;
}

/** The state file to read: state/<org>/state.json, else the old root file. */
export function stateFileRead(rootDir: string, org: string): string {
  return firstExisting(
    stateFilePath(rootDir, org),
    stateFileLegacyPath(rootDir, org),
  );
}

/** The org pin to read: state/<org>/org.json, else the old file in resources/. */
export function orgPinFileRead(rootDir: string, org: string): string {
  return firstExisting(
    orgPinFilePath(rootDir, org),
    orgPinFileLegacyPath(rootDir, org),
  );
}

/** Orgs that have a state file in either layout, sorted. */
export function stateOrgsList(rootDir: string): string[] {
  const orgs = new Set<string>();
  for (const name of readdirSync(rootDir)) {
    const match = /^\.vapi-state\.(.+)\.json$/.exec(name);
    if (match?.[1]) orgs.add(match[1]);
  }
  const stateRoot = join(rootDir, STATE_DIR);
  if (existsSync(stateRoot))
    for (const entry of readdirSync(stateRoot, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(stateFilePath(rootDir, entry.name)))
        orgs.add(entry.name);
  return [...orgs].sort((a, b) => a.localeCompare(b));
}

export type StateMoveBlocker =
  | { kind: "workflow"; file: string }
  | { kind: "ci" };

// A workflow that stages .vapi-state.*.json but not state/ would commit the
// old file's removal without the new one, so the UUID map would leave git.
function staleWorkflowFind(rootDir: string): string | undefined {
  const dir = join(rootDir, ".github", "workflows");
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const adds = readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => /\bgit add\b/.test(line) && !/^\s*#/.test(line));
    const stagesOld = adds.some((line) => line.includes(".vapi-state."));
    const stagesNew = adds.some((line) =>
      /(?<![\w.$-])state(?![\w.-])/.test(
        line.replace(/\.vapi-state\.\S*/g, ""),
      ),
    );
    if (stagesOld && !stagesNew) return `.github/workflows/${name}`;
  }
  return undefined;
}

export function stateRunIsCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

/**
 * Why committed state must stay where it is for now. A CI run never moves it:
 * only a workflow that stages both places could commit the move, and the
 * engine can't see which workflow is running it.
 */
export function stateMoveBlocker(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): StateMoveBlocker | undefined {
  const file = staleWorkflowFind(rootDir);
  if (file) return { kind: "workflow", file };
  return stateRunIsCi(env) ? { kind: "ci" } : undefined;
}

// A file that exists is written in place. A file that doesn't exist yet goes
// to state/<org>/, except in a checkout that still follows the old layout.
function legacyLayoutKept(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (existsSync(stateFilePath(rootDir, org))) return false;
  if (existsSync(stateFileLegacyPath(rootDir, org))) return true;
  return stateMoveBlocker(rootDir, env)?.kind === "workflow";
}

/** The state file to write. Call stateLayoutPrepare first in a command that writes. */
export function stateFileWrite(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return legacyLayoutKept(rootDir, org, env)
    ? stateFileLegacyPath(rootDir, org)
    : stateFilePath(rootDir, org);
}

/** The org pin to write: beside the state file, in whichever layout it uses. */
export function orgPinFileWrite(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const next = orgPinFilePath(rootDir, org);
  const legacy = orgPinFileLegacyPath(rootDir, org);
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return legacyLayoutKept(rootDir, org, env) ? legacy : next;
}

export class StateLayoutError extends Error {}

function jsonStable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(jsonStable);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, jsonStable(record[key])]),
  );
}

function sameJson(a: string, b: string): boolean {
  const left = readFileSync(a, "utf8");
  const right = readFileSync(b, "utf8");
  if (left === right) return true;
  try {
    return (
      JSON.stringify(jsonStable(JSON.parse(left))) ===
      JSON.stringify(jsonStable(JSON.parse(right)))
    );
  } catch {
    return false;
  }
}

// Move a folder of machine-local files. Where both sides hold an entry the
// new one wins: it was written after the old layout stopped being written.
function localDirMove(legacy: string, next: string): boolean {
  if (!existsSync(legacy)) return false;
  mkdirSync(dirname(next), { recursive: true });
  if (!existsSync(next)) {
    renameSync(legacy, next);
    return true;
  }
  for (const name of readdirSync(legacy)) {
    if (existsSync(join(next, name)))
      rmSync(join(legacy, name), { recursive: true, force: true });
    else renameSync(join(legacy, name), join(next, name));
  }
  rmdirSync(legacy);
  return true;
}

/**
 * Move this machine's baselines and snapshots into state/<org>/local/.
 * They are gitignored in both places, so no workflow can lose them.
 */
export function stateLocalMove(rootDir: string, org: string): string[] {
  const moved: string[] = [];
  if (
    localDirMove(baselinesLegacyDir(rootDir, org), baselinesDir(rootDir, org))
  ) {
    moved.push(`.vapi-state-hash/${org}/`);
    const root = join(rootDir, ".vapi-state-hash");
    if (readdirSync(root).length === 0) rmdirSync(root);
  }
  if (
    localDirMove(snapshotsLegacyDir(rootDir, org), snapshotsDir(rootDir, org))
  )
    moved.push(`.vapi-state.${org}.snapshots/`);
  return moved;
}

/**
 * Bring one org's engine files into state/<org>/ when that is safe, before a
 * command writes anything. Returns the lines to print.
 *
 * Each committed file moves by one rename, so the full state is always in
 * exactly one of the two places. Throws StateLayoutError, before anything is
 * read or changed, when both places hold a file and they disagree, or when a
 * CI run would write state its workflow won't commit.
 */
export function stateLayoutPrepare(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files = [
    {
      legacy: stateFileLegacyPath(rootDir, org),
      next: stateFilePath(rootDir, org),
      legacyLabel: `.vapi-state.${org}.json`,
      nextLabel: `${STATE_DIR}/${org}/state.json`,
    },
    {
      legacy: orgPinFileLegacyPath(rootDir, org),
      next: orgPinFilePath(rootDir, org),
      legacyLabel: `resources/${org}/.vapi-org.json`,
      nextLabel: `${STATE_DIR}/${org}/org.json`,
    },
  ].filter((file) => existsSync(file.legacy));

  for (const file of files)
    if (existsSync(file.next) && !sameJson(file.legacy, file.next))
      throw new StateLayoutError(
        `${file.legacyLabel} and ${file.nextLabel} both exist and disagree.\n` +
          `   Stopped before reading or changing anything.\n` +
          `   ${file.nextLabel} is the current location. Compare the two, copy across any entry\n` +
          `   only the old file has, then delete ${file.legacyLabel}.`,
      );

  const notices: string[] = [];
  const blocker = stateMoveBlocker(rootDir, env);
  if (blocker?.kind === "workflow" && existsSync(stateFilePath(rootDir, org))) {
    const problem = `${blocker.file} stages .vapi-state.*.json but not ${STATE_DIR}/, so it won't commit ${STATE_DIR}/${org}/.`;
    const fix = `Add \`git add -A -- ${STATE_DIR}\` to that step.`;
    if (stateRunIsCi(env))
      throw new StateLayoutError(
        `${problem}\n   Stopped before reading or changing anything: UUIDs recorded by this run would be lost.\n   ${fix}`,
      );
    notices.push(`⚠️  ${problem} ${fix}`);
  }

  const moved = stateLocalMove(rootDir, org);
  // Same content in both places: an earlier move was cut short, or a merge
  // brought the old file back unchanged. The old copy carries nothing.
  for (const file of files.filter((entry) => existsSync(entry.next))) {
    unlinkSync(file.legacy);
    moved.push(file.legacyLabel);
  }
  const pending = files.filter((file) => !existsSync(file.next));
  const committedMoved = pending.length > 0 && !blocker;
  if (committedMoved)
    for (const file of pending) {
      mkdirSync(dirname(file.next), { recursive: true });
      renameSync(file.legacy, file.next);
      moved.push(file.legacyLabel);
    }
  if (moved.length > 0)
    notices.push(
      `📦 Moved ${moved.join(", ")} into ${STATE_DIR}/${org}/.` +
        (moved.some((label) => !label.endsWith("/"))
          ? " Commit the removal together with the new folder."
          : ""),
    );
  if (pending.length > 0 && blocker) {
    const where = pending.map((file) => file.legacyLabel).join(" and ");
    notices.push(
      blocker.kind === "ci"
        ? `ℹ️  ${where} stays where it is: a CI run never moves state. Run \`npm run migrate\` on your machine and commit the result to move it into ${STATE_DIR}/${org}/.`
        : `⚠️  ${where} stays where it is: ${blocker.file} stages .vapi-state.*.json but not ${STATE_DIR}/. Add \`git add -A -- ${STATE_DIR}\` to that step, then run \`npm run migrate\`.`,
    );
  }
  return notices;
}
