// Where the engine keeps what it generates and tracks.
//
//   state/<org>/state.json          resource name → Vapi UUID (committed)
//   state/<org>/org.json            the Vapi org this folder is pinned to (committed)
//   state/<org>/local/baselines/    drift baselines, one file per UUID (this machine only)
//   state/<org>/local/snapshots/    push snapshots for rollback (this machine only)
//   state/commit-step.json          a person's word that their commit step stages state/ (committed)
//
// Everything under state/ is written by the engine. Hand-written files
// (.vapi-ignore and the resources themselves) stay under resources/<org>/.
//
// Until this folder existed the same files sat at the repository root and in
// resources/<org>/ under dot-names. This module is the only place that knows
// both layouts. An org is in one of them, decided by where its committed
// state file is. Every command reads the layout it finds and writes back to
// the same one. Only `npm run migrate` moves an org from the old layout to
// this one: a commit step that stages only the old place would otherwise
// leave moved state out of git, with every run still passing.
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
  writeFileSync,
} from "fs";
import { dirname, join, relative } from "path";
import { commitStepRead } from "./commit-step.ts";

export { commitStepRead };

export const STATE_DIR = "state";

/** The flag on `npm run migrate` by which a person says their commit step stages state/. */
export const COMMIT_STEP_FLAG = "--commit-step-stages-state";

/** Where that word is kept, so every later run on any machine can read it. */
export function commitStepFilePath(rootDir: string): string {
  return join(rootDir, STATE_DIR, "commit-step.json");
}

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

// ── Which layout an org is in ────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a person has said, with `npm run migrate -- --commit-step-stages-state`, that their commit step stages state/. */
export function commitStepAcknowledged(rootDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(commitStepFilePath(rootDir), "utf8"),
    );
    return isRecord(parsed) && parsed.stagesStateFolder === true;
  } catch {
    return false;
  }
}

export type StateLayout = "folder" | "root";

/**
 * The layout an org's engine files are in: "folder" for state/<org>/, "root"
 * for the files from before state/ existed.
 *
 * Where the org's state file is decides it, or its org pin when it has no
 * state file. An org with neither goes where the repository's other orgs
 * keep their state. In a repository with no
 * state at all, state/ is used only when the commit step is seen to stage it
 * or a person has said it does; otherwise the first state file is written
 * where every older commit step looks for it. That reading is of every
 * workflow, on any machine, so whoever writes first picks the same place.
 */
export function stateLayout(rootDir: string, org: string): StateLayout {
  if (existsSync(stateFilePath(rootDir, org))) return "folder";
  if (existsSync(stateFileLegacyPath(rootDir, org))) return "root";
  if (existsSync(orgPinFilePath(rootDir, org))) return "folder";
  if (existsSync(orgPinFileLegacyPath(rootDir, org))) return "root";
  const orgs = stateOrgsList(rootDir);
  if (orgs.some((other) => !existsSync(stateFilePath(rootDir, other))))
    return "root";
  if (orgs.length > 0) return "folder";
  const step = commitStepRead(rootDir, {});
  return step.kind === "seen" ||
    (step.kind !== "stale" && commitStepAcknowledged(rootDir))
    ? "folder"
    : "root";
}

// A file that exists is read and written where it is. A file that doesn't
// exist yet goes where the org's layout puts it.
function fileInLayout(
  next: string,
  legacy: string,
  rootDir: string,
  org: string,
): string {
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return stateLayout(rootDir, org) === "folder" ? next : legacy;
}

/** The org's state file: where it is, else where its first write goes. */
export function stateFileRead(rootDir: string, org: string): string {
  return fileInLayout(
    stateFilePath(rootDir, org),
    stateFileLegacyPath(rootDir, org),
    rootDir,
    org,
  );
}

/** The state file to write: the one that is read. */
export const stateFileWrite = stateFileRead;

/** The org pin: where it is, else beside the state file in the org's layout. */
export function orgPinFileRead(rootDir: string, org: string): string {
  return fileInLayout(
    orgPinFilePath(rootDir, org),
    orgPinFileLegacyPath(rootDir, org),
    rootDir,
    org,
  );
}

/** The org pin to write: the one that is read. */
export const orgPinFileWrite = orgPinFileRead;

/** The state file as a person names it: its path from the repository root. */
export function stateFileLabel(rootDir: string, org: string): string {
  return relative(rootDir, stateFileRead(rootDir, org)).replaceAll("\\", "/");
}

/** Where this machine's baselines for the org are written. */
export function baselinesWriteDir(rootDir: string, org: string): string {
  return stateLayout(rootDir, org) === "folder"
    ? baselinesDir(rootDir, org)
    : baselinesLegacyDir(rootDir, org);
}

/** Where this machine's push snapshots for the org are written. */
export function snapshotsWriteDir(rootDir: string, org: string): string {
  return stateLayout(rootDir, org) === "folder"
    ? snapshotsDir(rootDir, org)
    : snapshotsLegacyDir(rootDir, org);
}

/**
 * A file the engine touches each time it saves the org's state file on this
 * machine. It sits with the baselines, so it is never committed and a fresh
 * clone has none. Pull reads "has the engine synced here since this file was
 * written" from it rather than from the state file's own timestamp, which
 * after a clone or a checkout is only the order git wrote the files in.
 */
export function stateSavedStampPath(rootDir: string, org: string): string {
  return join(baselinesWriteDir(rootDir, org), ".state-saved");
}

// ── The committed files, in both places ──────────────────────────────────

interface CommittedFile {
  legacy: string;
  next: string;
  legacyLabel: string;
  nextLabel: string;
}

function committedFiles(rootDir: string, org: string): CommittedFile[] {
  return [
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
  ];
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

// Files that sit in both places. They must hold the same content: a copy
// that differs may carry an entry the other lacks, and reading either one
// alone would lose it.
function committedInBothPlaces(rootDir: string, org: string): CommittedFile[] {
  const both = committedFiles(rootDir, org).filter(
    (file) => existsSync(file.legacy) && existsSync(file.next),
  );
  for (const file of both)
    if (!sameJson(file.legacy, file.next))
      throw new StateLayoutError(
        `${file.legacyLabel} and ${file.nextLabel} both exist and disagree.\n` +
          `   Stopped before reading or changing anything.\n` +
          `   ${file.nextLabel} is the current location. Compare the two, copy across any entry\n` +
          `   only the old file has, then delete ${file.legacyLabel}.`,
      );
  return both;
}

/**
 * The old state file, when the org also has one in state/<org>/ with the same
 * content (a move cut short, or a merge that brought the old file back). The
 * engine keeps it identical to the one it reads, so whichever of the two the
 * commit step stages is complete, until `npm run migrate` removes it.
 */
export function stateFileLeftover(
  rootDir: string,
  org: string,
): string | undefined {
  const legacy = stateFileLegacyPath(rootDir, org);
  return existsSync(legacy) && existsSync(stateFilePath(rootDir, org))
    ? legacy
    : undefined;
}

// ── A command that writes state ──────────────────────────────────────────

export function stateRunIsCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

function notSeenReason(file: string | undefined): string {
  return file
    ? `${file} can commit to this repository and is not seen to stage ${STATE_DIR}/`
    : `no workflow in .github/workflows/ is seen to stage ${STATE_DIR}/`;
}

/** The one line a command prints while an org's state is still in the old layout. */
export const OLD_LAYOUT_NOTICE = `ℹ️  Engine state here is in the older layout (.vapi-state.<org>.json at the repository root). \`npm run migrate\` moves it into ${STATE_DIR}/ and says what the commit step has to stage first.`;

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
 * Move this machine's baselines and snapshots into state/<org>/local/, for an
 * org whose committed state is already in state/<org>/. They are gitignored
 * in both places, so no commit step can lose them.
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
 * Run before a command writes anything for an org. Moves no committed file:
 * the org stays in the layout it is in. Returns the lines to print.
 *
 * Throws StateLayoutError, before anything is read or changed, when the two
 * places hold a file and disagree, or when a CI run would write state where
 * the workflow running it is seen not to stage it.
 */
export function stateLayoutPrepare(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const both = committedInBothPlaces(rootDir, org);
  const layout = stateLayout(rootDir, org);
  const notices: string[] = [];

  if (stateRunIsCi(env)) {
    const step = commitStepRead(rootDir, env);
    const said = commitStepAcknowledged(rootDir);
    const stopped =
      "Stopped before reading or changing anything: UUIDs recorded by this run would be lost.";
    if (layout === "folder" && step.kind === "stale")
      throw new StateLayoutError(
        `${step.file} stages .vapi-state.*.json but not ${STATE_DIR}/, so it won't commit ${STATE_DIR}/${org}/.\n` +
          `   ${stopped}\n   Add \`git add -A -- ${STATE_DIR}\` to that step.`,
      );
    if (layout === "folder" && step.kind === "unseen" && !said)
      throw new StateLayoutError(
        `${notSeenReason(step.file)}, so ${STATE_DIR}/${org}/ may never be committed.\n` +
          `   ${stopped}\n` +
          `   Make the step that commits state stage \`${STATE_DIR}\`. If it already does, run \`npm run migrate -- ${COMMIT_STEP_FLAG}\` on your machine and commit ${STATE_DIR}/commit-step.json.`,
      );
    // The mirror case: state still at the old place, under a commit step
    // that has moved on to state/.
    if (layout === "root" && existsSync(stateFileLegacyPath(rootDir, org))) {
      const why =
        step.kind === "seen" && !step.stagesOld
          ? `this repository's workflow stages ${STATE_DIR}/ but not .vapi-state.*.json`
          : step.kind === "unseen" && said
            ? `${STATE_DIR}/commit-step.json says the commit step stages ${STATE_DIR}/`
            : undefined;
      if (why)
        throw new StateLayoutError(
          `.vapi-state.${org}.json is still at the repository root, and ${why}, so what this run records in it may never be committed.\n` +
            "   Stopped before reading or changing anything.\n" +
            "   Run `npm run migrate` on your machine and commit the result, so the file is where the commit step looks.",
        );
    }
    if (layout === "folder" && step.kind !== "seen" && said)
      notices.push(
        `ℹ️  ${STATE_DIR}/commit-step.json says this run's commit step stages ${STATE_DIR}/. The engine can't see that step: if it doesn't, what this run records in ${STATE_DIR}/${org}/ is lost.`,
      );
  }

  if (layout === "root") return [...notices, OLD_LAYOUT_NOTICE];

  const moved = stateLocalMove(rootDir, org);
  if (moved.length > 0)
    notices.push(
      `📦 Moved ${moved.join(", ")} into ${STATE_DIR}/${org}/local/. Both places are gitignored.`,
    );
  if (both.length > 0)
    notices.push(
      `ℹ️  ${both.map((file) => file.legacyLabel).join(" and ")} is still here beside its copy in ${STATE_DIR}/${org}/. \`npm run migrate\` removes it.`,
    );
  return notices;
}

/**
 * Print a command's layout notices. The older-layout line prints once per
 * command, also across the pull and push that apply and promote start.
 */
export function stateNoticesPrint(
  notices: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const notice of notices) {
    if (notice === OLD_LAYOUT_NOTICE) {
      if (env.VAPI_GITOPS_OLD_LAYOUT_NOTICE === "shown") continue;
      env.VAPI_GITOPS_OLD_LAYOUT_NOTICE = "shown";
    }
    console.log(notice);
  }
}

// ── npm run migrate: the only thing that moves committed state ──────────

export interface StateMoveRead {
  /** Whether `npm run migrate` moves committed state in this repository. */
  open: boolean;
  /** What it prints before anything moves. */
  lines: string[];
}

const COMMIT_STEP_NEEDS = [
  "   Once state is in state/, whatever commits state after a run has to stage both of these:",
  `     git add -A -- ${STATE_DIR}                       the new folder: each org's state.json, org.json and records`,
  "     git add -A -- ':(glob).vapi-state.*.json'   the old files, so the commit that moves them records their removal",
  `   A commit action or a script needs the same two paths: ${STATE_DIR} and .vapi-state.*.json.`,
  "   Upstream's .github/workflows/promotion.yml has both, guarded for a repository where one matches nothing.",
];

/**
 * Whether `npm run migrate` may move committed state, and what it says first.
 * It moves state when every commit step in .github/workflows/ is seen to
 * stage state/, or when a person has said theirs does. It never guesses that
 * nothing commits state: a pipeline the engine has no file for is not seen.
 */
export function stateMoveRead(rootDir: string): StateMoveRead {
  const step = commitStepRead(rootDir, {});
  if (step.kind === "stale")
    return {
      open: false,
      lines: [
        ...COMMIT_STEP_NEEDS,
        `⚠️  Nothing moves into ${STATE_DIR}/: ${step.file} stages .vapi-state.*.json but not ${STATE_DIR}/.`,
        `   Add \`git add -A -- ${STATE_DIR}\` to that step, then run \`npm run migrate\` again.`,
      ],
    };
  if (step.kind === "seen")
    return {
      open: true,
      lines: [
        ...COMMIT_STEP_NEEDS,
        `✅ Every commit step in .github/workflows/ is seen to stage ${STATE_DIR}/. A pipeline the engine has no file for (another CI system, a script that commits with its own token) is not read and needs the same two lines.`,
      ],
    };
  if (commitStepAcknowledged(rootDir))
    return {
      open: true,
      lines: [
        ...COMMIT_STEP_NEEDS,
        `✍️  ${STATE_DIR}/commit-step.json says the commit step stages ${STATE_DIR}/. The engine can't check a step it can't read, so it takes that word.`,
      ],
    };
  return {
    open: false,
    lines: [
      `⚠️  Nothing moves into ${STATE_DIR}/ yet: ${notSeenReason(step.kind === "unseen" ? step.file : undefined)}.`,
      ...COMMIT_STEP_NEEDS,
      "   When your step does that, say so. This writes that down and moves every org:",
      `     npm run migrate -- ${COMMIT_STEP_FLAG}`,
      `   The engine can't check a step it can't read. From then on it takes your word, kept in ${STATE_DIR}/commit-step.json.`,
    ],
  };
}

/**
 * What the commit step has to stage before state can move, when nothing is
 * seen to stage state/ and nobody has said it does. Undefined when
 * `npm run migrate` would move state, or when a workflow is seen to stage
 * only the old file.
 */
export function commitStepAsk(rootDir: string): string[] | undefined {
  const step = commitStepRead(rootDir, {});
  if (step.kind === "stale" || step.kind === "seen") return undefined;
  return commitStepAcknowledged(rootDir)
    ? undefined
    : stateMoveRead(rootDir).lines;
}

/**
 * Record a person's word that their commit step stages state/. Refused while
 * a workflow is seen to stage only the old file: that is seen to be untrue.
 * Returns the line to print.
 */
export function commitStepAcknowledge(rootDir: string): string {
  const step = commitStepRead(rootDir, {});
  if (step.kind === "stale")
    throw new StateLayoutError(
      `${step.file} stages .vapi-state.*.json but not ${STATE_DIR}/, so ${COMMIT_STEP_FLAG} is not true yet.\n` +
        `   Add \`git add -A -- ${STATE_DIR}\` to that step first. Nothing was changed.`,
    );
  if (step.kind === "seen")
    return `ℹ️  ${COMMIT_STEP_FLAG} is not needed here: every commit step in .github/workflows/ is seen to stage ${STATE_DIR}/.`;
  if (commitStepAcknowledged(rootDir))
    return `ℹ️  ${STATE_DIR}/commit-step.json already says the commit step stages ${STATE_DIR}/.`;
  const path = commitStepFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ stagesStateFolder: true }, null, 2)}\n`,
  );
  return `✍️  Wrote ${STATE_DIR}/commit-step.json: you said the commit step stages ${STATE_DIR}/. Commit it together with the move.`;
}

/**
 * Move one org's engine files into state/<org>/. Only `npm run migrate` calls
 * this, after stateMoveRead says the move is open. Returns what moved.
 *
 * Each committed file moves by one rename, so the full state is always in
 * exactly one of the two places. Throws StateLayoutError before changing
 * anything when both places hold a file and they disagree.
 */
export function stateMove(rootDir: string, org: string): string[] {
  const moved: string[] = [];
  // Same content in both places: the old copy carries nothing.
  for (const file of committedInBothPlaces(rootDir, org)) {
    unlinkSync(file.legacy);
    moved.push(file.legacyLabel);
  }
  for (const file of committedFiles(rootDir, org)) {
    if (!existsSync(file.legacy)) continue;
    mkdirSync(dirname(file.next), { recursive: true });
    renameSync(file.legacy, file.next);
    moved.push(file.legacyLabel);
  }
  return [...moved, ...stateLocalMove(rootDir, org)];
}
