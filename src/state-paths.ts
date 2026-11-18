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
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";

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

// ── Who commits state after a run ────────────────────────────────────────
//
// A run in CI writes the state file and leaves committing it to a later step
// the engine can't watch. If that step stages only the place state used to
// be, moving state takes the UUID map out of git: every run still passes, and
// the next one creates every resource again. So state moves by itself only
// when a workflow is seen to stage state/, or when nothing in the repository
// can commit state after a run. A step the engine can't read is not seen.

interface WorkflowRead {
  file: string;
  /** A `git add` line stages state/. */
  stagesNew: boolean;
  /** A `git add` line stages .vapi-state.*.json. */
  stagesOld: boolean;
  /** False only when the file is read as unable to write to the repository. */
  canCommit: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What a workflow's `git add` lines stage. A pathspec the engine can't read
// (a variable, one org's folder) counts for nothing.
function gitAddsRead(text: string): { stagesNew: boolean; stagesOld: boolean } {
  let stagesNew = false;
  let stagesOld = false;
  for (const line of text.replace(/\\\r?\n/g, " ").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const command of line.replace(/\s#.*$/, "").split(/&&|\|\||;/)) {
      const at = command.search(/\bgit add\b/);
      if (at < 0) continue;
      const args = command
        .slice(at + "git add".length)
        .split(/\s+/)
        .filter(Boolean)
        .map((arg) => arg.replace(/^["']|["']$/g, ""));
      const paths = args
        .filter((arg) => !arg.startsWith("-"))
        .map((path) => path.replace(/^:\([a-z,]*\)/, "").replace(/^\.\//, ""));
      const everything =
        paths.length === 0
          ? args.some((arg) => arg === "--all" || /^-[a-zA-Z]*A/.test(arg))
          : paths.some((path) => path === "." || path === ":/");
      if (everything || paths.some((path) => /^state(\/\**)?$/.test(path)))
        stagesNew = true;
      if (everything || paths.some((path) => path.includes(".vapi-state.")))
        stagesOld = true;
    }
  }
  return { stagesNew, stagesOld };
}

// Only a workflow whose permissions keep `contents` read-only in every job,
// and that never runs `git commit` or `git push`, is read as unable to commit.
// A file that doesn't parse, or sets no permissions, can.
function workflowCanCommit(text: string): boolean {
  if (/\bgit\s+(commit|push)\b/.test(text)) return true;
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return true;
  }
  if (!isRecord(doc) || !isRecord(doc.jobs)) return true;
  const writes = (permissions: unknown): boolean | undefined =>
    permissions === undefined
      ? undefined
      : permissions === "write-all" ||
        (isRecord(permissions) && permissions.contents === "write");
  const top = writes(doc.permissions);
  return Object.values(doc.jobs).some(
    (job) =>
      (isRecord(job) ? writes(job.permissions) : undefined) ?? top ?? true,
  );
}

function workflowsRead(rootDir: string): WorkflowRead[] {
  const dir = join(rootDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      return {
        file: `.github/workflows/${name}`,
        ...gitAddsRead(text),
        canCommit: workflowCanCommit(text),
      };
    });
}

export type CommitStep =
  /** A workflow is seen to stage the old state file and not state/. */
  | { kind: "stale"; file: string }
  /** Something may commit state after a run, and it isn't seen to stage state/. */
  | { kind: "unseen"; file?: string }
  /** Every workflow that can commit is seen to stage state/. */
  | { kind: "seen"; stagesOld: boolean }
  /** Nothing here commits state after a run. */
  | { kind: "none" };

/**
 * What is seen of the step that commits state after a run. In GitHub Actions
 * the engine knows which workflow is running it and reads that one alone;
 * anywhere else it reads every workflow in .github/workflows/. With no
 * workflow that can commit, a root promotion.yml still means some pipeline
 * runs promotion and commits what it records.
 */
export function commitStepRead(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CommitStep {
  const every = workflowsRead(rootDir);
  const running =
    env.GITHUB_ACTIONS === "true"
      ? /\.github\/workflows\/[^@]+/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[0]
      : undefined;
  const own = every.filter((workflow) => workflow.file === running);
  const workflows = own.length > 0 ? own : every;
  const stale = workflows.find((w) => w.stagesOld && !w.stagesNew);
  if (stale) return { kind: "stale", file: stale.file };
  const unseen = workflows.find((w) => w.canCommit && !w.stagesNew);
  if (unseen) return { kind: "unseen", file: unseen.file };
  if (workflows.some((w) => w.stagesNew))
    return { kind: "seen", stagesOld: workflows.some((w) => w.stagesOld) };
  return own.length === 0 && existsSync(join(rootDir, "promotion.yml"))
    ? { kind: "unseen" }
    : { kind: "none" };
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

function unseenReason(file: string | undefined): string {
  return file
    ? `${file} can commit to this repository and is not seen to stage ${STATE_DIR}/`
    : `promotion.yml is set up and no workflow in .github/workflows/ is seen to stage ${STATE_DIR}/`;
}

export type StateMoveBlocker =
  | { kind: "workflow"; file: string }
  | { kind: "unseen"; file?: string }
  | { kind: "ci" };

export function stateRunIsCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

/**
 * Why committed state must stay where it is for now. A workflow seen to stage
 * only the old file holds it, and so does a commit step that isn't seen to
 * stage state/ until a person says it does. A CI run never moves state: only
 * the person who changes the commit step can commit the move with it.
 */
export function stateMoveBlocker(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): StateMoveBlocker | undefined {
  const step = commitStepRead(rootDir, env);
  if (step.kind === "stale") return { kind: "workflow", file: step.file };
  if (step.kind === "unseen" && !commitStepAcknowledged(rootDir))
    return { kind: "unseen", file: step.file };
  return stateRunIsCi(env) ? { kind: "ci" } : undefined;
}

/**
 * What the commit step has to stage before state can move, when nothing is
 * seen to stage state/ and nobody has said it does. For `npm run migrate`.
 */
export function commitStepAsk(rootDir: string): string[] | undefined {
  const blocker = stateMoveBlocker(rootDir, {});
  if (blocker?.kind !== "unseen") return undefined;
  return [
    `⚠️  Nothing moved into ${STATE_DIR}/: ${unseenReason(blocker.file)}.`,
    "   Whatever commits state after a run in this repository has to stage both of these:",
    `     git add -A -- ${STATE_DIR}                       the new folder: each org's state.json, org.json and records`,
    "     git add -A -- ':(glob).vapi-state.*.json'   the old files, so the commit that moves them records their removal",
    `   A commit action or a script needs the same two paths: ${STATE_DIR} and .vapi-state.*.json.`,
    "   Upstream's .github/workflows/promotion.yml has both, guarded for a repository where one matches nothing.",
    "   When your step does that, say so. This writes that down and moves every org:",
    `     npm run migrate -- ${COMMIT_STEP_FLAG}`,
    `   The engine can't check a step it can't read. From then on it takes your word, kept in ${STATE_DIR}/commit-step.json.`,
  ];
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
  if (step.kind !== "unseen")
    return `ℹ️  ${COMMIT_STEP_FLAG} is not needed here: ${step.kind === "seen" ? `a workflow is seen to stage ${STATE_DIR}/` : "nothing in this repository commits state after a run"}.`;
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

// A repository that has any old root state file still follows the old layout.
function legacyStateExists(rootDir: string): boolean {
  return readdirSync(rootDir).some((name) =>
    /^\.vapi-state\..+\.json$/.test(name),
  );
}

// A file that exists is written in place. A file that doesn't exist yet goes
// to state/<org>/, except where the commit step is seen to stage only the old
// place, or isn't seen at all in a repository that still has old state files.
function legacyLayoutKept(
  rootDir: string,
  org: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (existsSync(stateFilePath(rootDir, org))) return false;
  if (existsSync(stateFileLegacyPath(rootDir, org))) return true;
  const blocker = stateMoveBlocker(rootDir, env);
  if (blocker?.kind === "workflow") return true;
  return blocker?.kind === "unseen" && legacyStateExists(rootDir);
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
 * CI run would write state in a place its commit step isn't seen to stage.
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
  const ci = stateRunIsCi(env);
  const step = commitStepRead(rootDir, env);
  const inFolder =
    stateFileWrite(rootDir, org, env) === stateFilePath(rootDir, org);
  if (
    inFolder &&
    (blocker?.kind === "workflow" || blocker?.kind === "unseen")
  ) {
    const problem =
      blocker.kind === "workflow"
        ? `${blocker.file} stages .vapi-state.*.json but not ${STATE_DIR}/, so it won't commit ${STATE_DIR}/${org}/.`
        : `${unseenReason(blocker.file)}, so ${STATE_DIR}/${org}/ may never be committed.`;
    const fix =
      blocker.kind === "workflow"
        ? `Add \`git add -A -- ${STATE_DIR}\` to that step.`
        : `Make the step that commits state stage \`${STATE_DIR}\`. If it already does, run \`npm run migrate -- ${COMMIT_STEP_FLAG}\` on your machine and commit ${STATE_DIR}/commit-step.json.`;
    if (ci)
      throw new StateLayoutError(
        `${problem}\n   Stopped before reading or changing anything: UUIDs recorded by this run would be lost.\n   ${fix}`,
      );
    // With only a promotion.yml to go on there may be no pipeline at all, so
    // a person's machine isn't warned on every command. A CI run still stops.
    if (blocker.kind === "workflow" || blocker.file)
      notices.push(`⚠️  ${problem} ${fix}`);
  }
  // The mirror case: state still at the old place, under a commit step that
  // has moved on to state/.
  if (ci && !inFolder && existsSync(stateFileLegacyPath(rootDir, org))) {
    const why =
      step.kind === "seen" && !step.stagesOld
        ? `this repository's workflow stages ${STATE_DIR}/ but not .vapi-state.*.json`
        : step.kind === "unseen" && commitStepAcknowledged(rootDir)
          ? `${STATE_DIR}/commit-step.json says the commit step stages ${STATE_DIR}/`
          : undefined;
    if (why)
      throw new StateLayoutError(
        `.vapi-state.${org}.json is still at the repository root, and ${why}, so what this run records in it may never be committed.\n` +
          "   Stopped before reading or changing anything.\n" +
          "   Run `npm run migrate` on your machine and commit the result, so the file is where the commit step looks.",
      );
  }
  if (ci && inFolder && step.kind === "unseen")
    notices.push(
      `ℹ️  ${STATE_DIR}/commit-step.json says this run's commit step stages ${STATE_DIR}/. The engine can't see that step: if it doesn't, what this run records in ${STATE_DIR}/${org}/ is lost.`,
    );

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
        : blocker.kind === "workflow"
          ? `⚠️  ${where} stays where it is: ${blocker.file} stages .vapi-state.*.json but not ${STATE_DIR}/. Add \`git add -A -- ${STATE_DIR}\` to that step, then run \`npm run migrate\`.`
          : `ℹ️  ${where} stays where it is: ${unseenReason(blocker.file)}. \`npm run migrate\` says what the commit step has to stage before it can move.`,
    );
  }
  return notices;
}
