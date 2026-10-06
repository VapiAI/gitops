// Labels the assistant version a push publishes with who pushed it, from
// which commit, and which fields changed. The platform records no author on
// versions written with a private API key (createdBy is null), so without
// this a version published by gitops cannot be traced back to a person.
//
// Config-free on purpose (like user-agent.ts): importing config.ts would
// parse argv and exit, which breaks importing this from tests.

import { execFileSync } from "node:child_process";
import type { VersionActor, VersionMetadata } from "./types.ts";

// Limits enforced by PATCH /assistant/:id/versions/:version. Longer values
// are rejected with a 400, so the builder truncates instead.
const VERSION_NAME_MAX = 80;
const VERSION_DESCRIPTION_MAX = 500;

// Server-managed keys that differ between any two reads of the same
// resource. Comparing them would list a change on every push.
const IGNORED_KEYS = new Set([
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "latestVersion",
  "modelDeprecations",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Dotted paths of the fields that differ between two reads of a resource,
// descending into nested objects up to `maxDepth` levels (so a prompt edit
// reads `model.messages`, not just `model`). Arrays compare whole.
export function changedFieldPaths(
  before: unknown,
  after: unknown,
  maxDepth = 2,
  prefix = "",
): string[] {
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return sameValue(before, after) ? [] : [prefix || "(root)"];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const paths: string[] = [];
  for (const key of keys) {
    if (!prefix && IGNORED_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before[key];
    const b = after[key];
    if (sameValue(a, b)) continue;
    const depth = path.split(".").length;
    if (depth < maxDepth && isPlainObject(a) && isPlainObject(b)) {
      paths.push(...changedFieldPaths(a, b, maxDepth, path));
    } else {
      paths.push(path);
    }
  }
  return paths.sort();
}

function gitRead(args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Self-reported identity: git config and GITHUB_ACTOR are whatever the
// pusher's environment says. Good for an audit trail between colleagues,
// not proof against a pusher who sets them deliberately.
export function versionActorResolve(
  resourcesDir: string,
  env: NodeJS.ProcessEnv = process.env,
): VersionActor {
  const name =
    env.VAPI_GITOPS_ACTOR ||
    (env.GITHUB_ACTOR ? `github:${env.GITHUB_ACTOR}` : null) ||
    gitRead(["config", "user.email"]) ||
    gitRead(["config", "user.name"]) ||
    "unknown";
  const commit = gitRead(["rev-parse", "--short", "HEAD"]);
  const dirty =
    commit !== null &&
    gitRead(["status", "--porcelain", "--", resourcesDir]) !== null;
  return { name, commit, dirty };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// Lists as many changed paths as fit in the description limit, then
// "+N more" so a large change never pushes the actor line out.
function changedFieldsLine(paths: string[], budget: number): string {
  if (paths.length === 0) return "Changed: (no field-level change detected)";
  const head = "Changed: ";
  let line = head;
  for (let i = 0; i < paths.length; i++) {
    const remaining = paths.length - i - 1;
    const sep = i === 0 ? "" : ", ";
    const tail = remaining > 0 ? ` (+${remaining} more)` : "";
    const candidate = `${line}${sep}${paths[i]}`;
    if (candidate.length + tail.length > budget) {
      return `${line} (+${paths.length - i} more)`;
    }
    line = candidate;
  }
  return line;
}

export function versionMetadataBuild(args: {
  actor: VersionActor;
  changedPaths: string[];
  created: boolean;
}): VersionMetadata {
  const { actor, changedPaths, created } = args;
  const commit = actor.commit
    ? `${actor.commit}${actor.dirty ? "+dirty" : ""}`
    : "no-commit";
  const versionName = truncate(
    `gitops ${commit} by ${actor.name}`,
    VERSION_NAME_MAX,
  );
  const header = `Pushed by ${actor.name} from commit ${commit} via vapi-gitops.`;
  const body = created
    ? "Created by gitops."
    : changedFieldsLine(
        changedPaths,
        VERSION_DESCRIPTION_MAX - header.length - 1,
      );
  return {
    versionName,
    versionDescription: truncate(`${header}\n${body}`, VERSION_DESCRIPTION_MAX),
  };
}
