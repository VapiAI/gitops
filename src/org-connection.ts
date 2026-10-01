// Config-free org connection helpers: resolve an org's API key and base URL
// from a token map or `.env.<org>`, and run an engine script against that org
// in a child process. Shared by promotion and the PR check, which both work
// with several orgs in one process and so can't use config.ts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveApiKey } from "./api-key.ts";

export interface OrgConnection {
  token: string;
  baseUrl?: string;
}

export function envValue(content: string, key: string): string | undefined {
  const line = content
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith(`${key}=`));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    return value.slice(1, -1);
  return value || undefined;
}

// Parse a JSON `{ "<org>": "<token>" }` map from an env var. Promotion and the
// PR check use separate variables so each gets only the keys it needs.
export function tokensParse(envName: string): Map<string, string> {
  const configured = process.env[envName];
  if (!configured) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(configured);
  } catch {
    throw new Error(`${envName} must be valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${envName} must map org slugs to tokens`);
  const tokens = new Map<string, string>();
  for (const [org, token] of Object.entries(raw)) {
    if (typeof token !== "string" || token.length === 0)
      throw new Error(
        `${envName} entry for ${org} must be a non-empty token string`,
      );
    tokens.set(org, token);
  }
  return tokens;
}

export interface ConnectionLoadArgs {
  rootDir: string;
  org: string;
  tokens: Map<string, string>;
  // Named in the "missing token" error so it points at the right variable.
  tokensEnvName: string;
  // A configured base URL wins over `.env.<org>`'s VAPI_BASE_URL.
  baseUrl?: string;
}

export function connectionLoad(args: ConnectionLoadArgs): OrgConnection {
  const { rootDir, org, tokens, tokensEnvName } = args;
  const envPath = resolve(rootDir, `.env.${org}`);
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const envToken = resolveApiKey({
    VAPI_PRIVATE_API_KEY: envValue(envContent, "VAPI_PRIVATE_API_KEY"),
    VAPI_TOKEN: envValue(envContent, "VAPI_TOKEN"),
  });
  const token = tokens.get(org) ?? envToken;
  if (!token)
    throw new Error(
      `Missing token for org ${org}; set ${tokensEnvName} or .env.${org}`,
    );
  return {
    token,
    baseUrl: args.baseUrl ?? envValue(envContent, "VAPI_BASE_URL"),
  };
}

export interface ChildRunArgs {
  rootDir: string;
  script: string;
  org: string;
  connection: OrgConnection;
  args: string[];
}

// Run `node --import tsx <script> <org> ...args` with the org's key in the
// environment, so the child's config.ts binds that org.
export function childRun(run: ChildRunArgs): void {
  const { rootDir, script, org, connection, args } = run;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    VAPI_PRIVATE_API_KEY: connection.token,
    VAPI_TOKEN: connection.token,
  };
  if (connection.baseUrl) environment.VAPI_BASE_URL = connection.baseUrl;
  if (!connection.baseUrl) delete environment.VAPI_BASE_URL;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, org, ...args],
    { cwd: rootDir, env: environment, stdio: "inherit" },
  );
  if (result.error)
    throw new Error(
      `Failed to run ${script} for ${org}: ${result.error.message}`,
    );
  if (result.status !== 0) throw new Error(`${script} failed for ${org}`);
}
