// User-Agent for every API request this tool makes, so gitops traffic can be
// told apart in the platform's request logs and analytics:
//
//   vapi-gitops-<command>/<package version>[ (ci)]
//
// `<command>` is the gitops command that started the run, from a fixed list
// (`cli` when it can't be told), so the label set stays bounded and never
// carries a name a user chose, such as a fork's own npm script. The first
// gitops process pins it in VAPI_GITOPS_COMMAND, which every process it
// spawns inherits: `npm run apply` labels the pull and push it runs as
// `apply`, and the PR check's bindings pull is labelled `check`.
//
// The `sim`, `check` and `promote` labels are fixed by their callers. Analytics
// counts simulation runs by the `vapi-gitops-sim/` and `vapi-gitops-check/`
// prefixes, so keep those prefixes stable; the version and the ` (ci)` suffix
// may vary.
//
// Every Vapi request also sends `x-vapi-client`, built by `vapiClientGet`:
//
//   gitops/<package version>; command=<command>; run=<run id>[; ci]
//
// It carries the same command, version and CI flag in the shape the platform
// parses for every first-party client, plus a run id shared by every request
// of one gitops run, so the platform can group them. The run id is pinned in
// VAPI_GITOPS_RUN_ID exactly as the command is pinned in VAPI_GITOPS_COMMAND.
// A gradual rollout's traffic-allocation writes override the command per
// request (`rollout-pin`, `rollout-step`, …; see RolloutCommand), so each
// write type is countable; the process's own reads keep its command.
//
// Config-free on purpose (like api-key.ts): importing config.ts would parse
// argv and exit, which breaks importing this from sim.ts and tests.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

export interface UserAgentContext {
  env: NodeJS.ProcessEnv;
  // The entry script, process.argv[1].
  scriptPath?: string;
}

function packageVersionRead(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(PACKAGE_JSON_PATH, "utf-8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof parsed.version === "string"
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through: a missing or unreadable package.json must never block
    // an API request.
  }
  return "unknown";
}

const PACKAGE_VERSION = packageVersionRead();

// A User-Agent product token allows few characters; keep to a safe subset.
function tokenClean(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The commands a label can name: this repo's npm scripts. Hard-coded, not
// read from package.json, because forks add their own scripts there.
const COMMANDS = new Set([
  "setup",
  "apply",
  "push",
  "pull",
  "migrate",
  "call",
  "cleanup",
  "validate",
  "audit",
  "sim",
  "check",
  "rollback",
  "promote",
  "rollout",
]);

export const COMMAND_ENV = "VAPI_GITOPS_COMMAND";

function commandKnown(value: string | undefined): string | undefined {
  const token = tokenClean(value ?? "");
  return COMMANDS.has(token) ? token : undefined;
}

// The pinned label, else the npm script, else the entry script, else `cli`.
// `npx tsx src/push-cmd.ts` sets npm_lifecycle_event=npx, which isn't a
// command, so it falls through to the entry script: `push`.
function commandNameGet(context: UserAgentContext): string {
  const script = context.scriptPath
    ? basename(context.scriptPath)
        .replace(/\.[cm]?[jt]s$/, "")
        .replace(/-cmd$/, "")
    : undefined;
  return (
    commandKnown(context.env[COMMAND_ENV]) ??
    commandKnown(context.env.npm_lifecycle_event) ??
    commandKnown(script) ??
    "cli"
  );
}

// Pin this process's label for every process it spawns.
process.env[COMMAND_ENV] ??= commandNameGet({
  env: process.env,
  scriptPath: process.argv[1],
});

function ciRun(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.toLowerCase();
  return (
    env.GITHUB_ACTIONS === "true" ||
    (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0")
  );
}

export function userAgentGet(
  product?: "sim" | "check" | "promote",
  context: UserAgentContext = {
    env: process.env,
    scriptPath: process.argv[1],
  },
): string {
  const command = product ?? commandNameGet(context);
  const ci = ciRun(context.env) ? " (ci)" : "";
  return `vapi-gitops-${command}/${PACKAGE_VERSION}${ci}`;
}

export const RUN_ID_ENV = "VAPI_GITOPS_RUN_ID";

// What the platform accepts as a run id; a UUID fits. An inherited value that
// doesn't match is replaced, so a stray variable can't drop the run id.
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Pin one run id for this process and every process it spawns.
if (!RUN_ID_PATTERN.test(process.env[RUN_ID_ENV] ?? "")) {
  process.env[RUN_ID_ENV] = randomUUID();
}

// The traffic-allocation writes a gradual rollout makes, one label each, so
// analytics can tell a pin from a step, a restore or an abort by command
// alone. A per-request label, never a process label: they are not in
// COMMANDS, so VAPI_GITOPS_COMMAND can't name one.
export type RolloutCommand =
  | "rollout-pin"
  | "rollout-step"
  | "rollout-restore"
  | "rollout-complete"
  | "rollout-hold"
  | "rollout-abort"
  | "rollout-release";

export function vapiClientGet(
  product?: "sim" | "check" | "promote" | RolloutCommand,
  context: UserAgentContext = {
    env: process.env,
    scriptPath: process.argv[1],
  },
): string {
  const command = product ?? commandNameGet(context);
  const runId = context.env[RUN_ID_ENV];
  const run = runId && RUN_ID_PATTERN.test(runId) ? `; run=${runId}` : "";
  const ci = ciRun(context.env) ? "; ci" : "";
  return `gitops/${PACKAGE_VERSION}; command=${command}${run}${ci}`;
}
