// Parser for `vapi-checks.yml`, the PR check configuration.
//
// Config-free and pure (apart from checksConfigLoad's one read), so the
// check CLI, the PR workflow and the promotion gate share it. It is a
// separate file from promotion.yml because promotionConfigParse requires a
// pipeline of two or more orgs, which single-org customers don't have.
//
// Every key is validated and unknown keys are rejected: a typo in a CI
// config should fail loudly, not silently run fewer tests.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PromotionBindings } from "./promotion.ts";
import { promotionBindingsParse, SLUG_RE } from "./promotion.ts";

export const CHECKS_CONFIG_FILE = "vapi-checks.yml";

// chat → vapi.webchat, voice → vapi.websocket.
export type CheckTransport = "chat" | "voice";

// strict: every tool is mocked or the build fails (see check-mocks.ts).
// off: tools are sent as written — only safe in a dedicated CI org.
export type CheckToolMocks = "strict" | "off";

export type CheckTargetType = "assistants" | "squads";

export interface CheckTarget {
  type: CheckTargetType;
  id: string;
}

export interface CheckRunSettings {
  transport: CheckTransport;
  iterations: number;
  timeoutMinutes: number;
  toolMocks: CheckToolMocks;
  stripWebhooks: boolean;
}

export interface CheckDefinition extends CheckRunSettings {
  name: string;
  // Resources are read from resources/<org>/ at the checked-out commit.
  org: string;
  // The org the run executes in; its state supplies credential UUIDs.
  runOrg: string;
  baseUrl?: string;
  targets: CheckTarget[];
  suites: string[];
  simulations: string[];
  bindings: PromotionBindings;
  // Extra globs (repo-relative) that mark this check affected.
  paths: string[];
}

export interface ChecksConfig {
  version: 1;
  checks: Record<string, CheckDefinition>;
}

export const CHECK_DEFAULTS: CheckRunSettings = {
  transport: "chat",
  iterations: 1,
  timeoutMinutes: 20,
  toolMocks: "strict",
  stripWebhooks: true,
};

const MAX_ITERATIONS = 10;
const MAX_TIMEOUT_MINUTES = 120;
const TOP_LEVEL_KEYS = ["version", "defaults", "checks"];
const SETTINGS_KEYS = Object.keys(CHECK_DEFAULTS);
const CHECK_KEYS = [
  "org",
  "runOrg",
  "baseUrl",
  "targets",
  "suites",
  "simulations",
  "bindings",
  "paths",
  ...SETTINGS_KEYS,
];
const TARGET_TYPES: readonly CheckTargetType[] = ["assistants", "squads"];

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return Object.fromEntries(Object.entries(value));
}

function keysAllowed(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (key === "mode")
      throw new Error(
        `${label}.mode is not supported: checks always build the target from the branch's files`,
      );
    if (!allowed.includes(key))
      throw new Error(
        `${label} has unknown key "${key}" (allowed: ${allowed.join(", ")})`,
      );
  }
}

function slug(value: unknown, label: string): string {
  if (typeof value !== "string" || !SLUG_RE.test(value))
    throw new Error(`${label} must be a lowercase slug (a-z, 0-9, -)`);
  return value;
}

// A resource ID as it appears in a file path under resources/<org>/<folder>/,
// without the extension. Nested IDs (`team/intake`) are allowed.
function resourceId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty resource ID`);
  if (/\.(ya?ml|md|ts)$/.test(value))
    throw new Error(`${label} must not include a file extension: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new Error(`${label} must be a relative resource ID: ${value}`);
  return value;
}

function stringList(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value;
}

function unique<T>(values: T[], key: (value: T) => string, label: string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new Error(`${label} lists ${id} twice`);
    seen.add(id);
  }
  return values;
}

function target(value: unknown, label: string): CheckTarget {
  if (typeof value !== "string")
    throw new Error(`${label} must be "assistants/<id>" or "squads/<id>"`);
  const slash = value.indexOf("/");
  const type = value.slice(0, slash);
  if (slash < 0 || !TARGET_TYPES.includes(type as CheckTargetType))
    throw new Error(
      `${label} must be "assistants/<id>" or "squads/<id>", got "${value}"`,
    );
  return {
    type: type as CheckTargetType,
    id: resourceId(value.slice(slash + 1), label),
  };
}

function settings(
  raw: Record<string, unknown>,
  base: CheckRunSettings,
  label: string,
): CheckRunSettings {
  const result = { ...base };
  if (raw.transport !== undefined) {
    if (raw.transport !== "chat" && raw.transport !== "voice")
      throw new Error(`${label}.transport must be "chat" or "voice"`);
    result.transport = raw.transport;
  }
  if (raw.iterations !== undefined) {
    const iterations = raw.iterations;
    if (
      typeof iterations !== "number" ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > MAX_ITERATIONS
    )
      throw new Error(
        `${label}.iterations must be an integer from 1 to ${MAX_ITERATIONS}`,
      );
    result.iterations = iterations;
  }
  if (raw.timeoutMinutes !== undefined) {
    const timeout = raw.timeoutMinutes;
    if (
      typeof timeout !== "number" ||
      !(timeout > 0) ||
      timeout > MAX_TIMEOUT_MINUTES
    )
      throw new Error(
        `${label}.timeoutMinutes must be a number above 0 and at most ${MAX_TIMEOUT_MINUTES}`,
      );
    result.timeoutMinutes = timeout;
  }
  if (raw.toolMocks !== undefined) {
    if (raw.toolMocks !== "strict" && raw.toolMocks !== "off")
      throw new Error(`${label}.toolMocks must be "strict" or "off"`);
    result.toolMocks = raw.toolMocks;
  }
  if (raw.stripWebhooks !== undefined) {
    if (typeof raw.stripWebhooks !== "boolean")
      throw new Error(`${label}.stripWebhooks must be true or false`);
    result.stripWebhooks = raw.stripWebhooks;
  }
  return result;
}

function baseUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^https?:\/\/[^\s/]+/.test(value))
    throw new Error(`${label}.baseUrl must be an http(s) URL`);
  return value.replace(/\/+$/, "");
}

function check(
  name: string,
  value: unknown,
  defaults: CheckRunSettings,
): CheckDefinition {
  const label = `checks.${name}`;
  const raw = mapping(value, label);
  keysAllowed(raw, CHECK_KEYS, label);
  const org = slug(raw.org, `${label}.org`);
  const runOrg =
    raw.runOrg === undefined ? org : slug(raw.runOrg, `${label}.runOrg`);
  const targets = unique(
    stringList(raw.targets, `${label}.targets`).map((item, index) =>
      target(item, `${label}.targets[${index}]`),
    ),
    (item) => `${item.type}/${item.id}`,
    `${label}.targets`,
  );
  if (targets.length === 0)
    throw new Error(`${label}.targets must list at least one target`);
  const suites = unique(
    stringList(raw.suites, `${label}.suites`).map((item, index) =>
      resourceId(item, `${label}.suites[${index}]`),
    ),
    (item) => item,
    `${label}.suites`,
  );
  const simulations = unique(
    stringList(raw.simulations, `${label}.simulations`).map((item, index) =>
      resourceId(item, `${label}.simulations[${index}]`),
    ),
    (item) => item,
    `${label}.simulations`,
  );
  if (suites.length === 0 && simulations.length === 0)
    throw new Error(`${label} must list at least one suite or simulation`);
  const paths = stringList(raw.paths, `${label}.paths`).map((item, index) => {
    if (typeof item !== "string" || item.length === 0)
      throw new Error(`${label}.paths[${index}] must be a non-empty glob`);
    return item;
  });
  return {
    name,
    org,
    runOrg,
    baseUrl: baseUrl(raw.baseUrl, label),
    targets,
    suites,
    simulations,
    bindings: promotionBindingsParse(raw.bindings),
    paths,
    ...settings(raw, defaults, label),
  };
}

export function checksConfigParse(content: string): ChecksConfig {
  const raw = mapping(parseYaml(content), CHECKS_CONFIG_FILE);
  keysAllowed(raw, TOP_LEVEL_KEYS, CHECKS_CONFIG_FILE);
  if (raw.version !== 1)
    throw new Error(`${CHECKS_CONFIG_FILE} version must be 1`);
  const defaultsRaw =
    raw.defaults === undefined ? {} : mapping(raw.defaults, "defaults");
  keysAllowed(defaultsRaw, SETTINGS_KEYS, "defaults");
  const defaults = settings(defaultsRaw, CHECK_DEFAULTS, "defaults");
  const checksRaw = mapping(raw.checks, "checks");
  if (Object.keys(checksRaw).length === 0)
    throw new Error(`${CHECKS_CONFIG_FILE} must declare at least one check`);
  const checks: Record<string, CheckDefinition> = {};
  for (const [name, value] of Object.entries(checksRaw)) {
    slug(name, `check name "${name}"`);
    checks[name] = check(name, value, defaults);
  }
  return { version: 1, checks };
}

// Returns null when the repo has no vapi-checks.yml: checks are opt-in.
export function checksConfigLoad(rootDir: string): ChecksConfig | null {
  const path = join(rootDir, CHECKS_CONFIG_FILE);
  if (!existsSync(path)) return null;
  return checksConfigParse(readFileSync(path, "utf8"));
}
