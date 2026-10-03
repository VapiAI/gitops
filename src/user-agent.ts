// User-Agent for every API request this tool makes, so gitops traffic can be
// told apart in the platform's request logs and analytics:
//
//   vapi-gitops-<command>/<package version>[ (ci)]
//
// `<command>` is the npm script that started the process (`npm run apply`
// labels the pull and push it runs as `apply`), or the entry script's name
// when it was run directly, as the PR check workflow does. The `sim` and
// `check` labels are fixed by their callers, because analytics already counts
// simulation runs by those prefixes; keep them stable.
//
// Config-free on purpose (like api-key.ts): importing config.ts would parse
// argv and exit, which breaks importing this from sim.ts and tests.

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

function commandNameGet(context: UserAgentContext): string {
  const npmScript = context.env.npm_lifecycle_event;
  if (npmScript && tokenClean(npmScript)) return tokenClean(npmScript);
  const script = context.scriptPath
    ? basename(context.scriptPath).replace(/\.[cm]?[jt]s$/, "")
    : "";
  return tokenClean(script.replace(/-cmd$/, "")) || "cli";
}

function ciRun(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.toLowerCase();
  return (
    env.GITHUB_ACTIONS === "true" ||
    (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0")
  );
}

export function userAgentGet(
  product?: "sim" | "check",
  context: UserAgentContext = {
    env: process.env,
    scriptPath: process.argv[1],
  },
): string {
  const command = product ?? commandNameGet(context);
  const ci = ciRun(context.env) ? " (ci)" : "";
  return `vapi-gitops-${command}/${PACKAGE_VERSION}${ci}`;
}
