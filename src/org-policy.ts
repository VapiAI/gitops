// Rules an org's folder must hold, set by hand in
// resources/<org>/.vapi-policy.yml and committed with the folder.
//
//   customerKeysOnly: true
//
// marks an org whose calls must never run on Vapi's own provider keys. The
// credential-pin check is an error there and a warning everywhere else.
// Promotion skips dotfiles, so a policy never travels to another org.
//
// Config-free so validate, push and tests can read any org.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const ORG_POLICY_FILE = ".vapi-policy.yml";

export interface OrgPolicy {
  customerKeysOnly: boolean;
}

const ORG_POLICY_KEYS = ["customerKeysOnly"];

export function orgPolicyParse(content: string): OrgPolicy {
  const raw: unknown = parseYaml(content) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${ORG_POLICY_FILE} must be a mapping`);
  const policy = raw as Record<string, unknown>;
  // A typo (`customerKeyOnly:`) must not quietly turn a safety rule off.
  for (const key of Object.keys(policy))
    if (!ORG_POLICY_KEYS.includes(key))
      throw new Error(
        `${ORG_POLICY_FILE}: unknown key "${key}" (known: ${ORG_POLICY_KEYS.join(", ")})`,
      );
  const { customerKeysOnly = false } = policy;
  if (typeof customerKeysOnly !== "boolean")
    throw new Error(
      `${ORG_POLICY_FILE}: customerKeysOnly must be true or false`,
    );
  return { customerKeysOnly };
}

/** The org's policy; every rule is off when the file doesn't exist. */
export function orgPolicyRead(resourcesDir: string): OrgPolicy {
  const path = join(resourcesDir, ORG_POLICY_FILE);
  return orgPolicyParse(existsSync(path) ? readFileSync(path, "utf-8") : "");
}
