// Where the engine finds the Vapi private API key.
//
// The canonical variable is VAPI_PRIVATE_API_KEY, matching the dashboard's
// "Private API Keys" section and making it obvious a public key won't work.
// VAPI_TOKEN was this repo's original name; it keeps working so existing
// forks and CI secrets don't break.
//
// Config-free on purpose: config.ts exits at import time when no key is
// set, and several commands (call, sim, rollback, promote, interactive)
// resolve keys for orgs other than argv[2].

export const API_KEY_VAR = "VAPI_PRIVATE_API_KEY";
export const LEGACY_API_KEY_VAR = "VAPI_TOKEN";
export const API_KEYS_URL = "https://dashboard.vapi.ai/org/api-keys";

type Vars = Record<string, string | undefined>;

function pick(vars: Vars): string | undefined {
  const value = vars[API_KEY_VAR]?.trim() || vars[LEGACY_API_KEY_VAR]?.trim();
  return value || undefined;
}

/**
 * Resolve the private API key. Sources are checked in order, so pass
 * `process.env` first to keep "environment beats .env file" precedence.
 * Within each source VAPI_PRIVATE_API_KEY wins over the legacy VAPI_TOKEN.
 */
export function resolveApiKey(...sources: Vars[]): string | undefined {
  for (const source of sources) {
    const value = pick(source);
    if (value) return value;
  }
  return undefined;
}

/** Placeholder values copied from .env.example should not count as a token. */
export function isPlaceholderToken(token: string): boolean {
  return /^your-.*-here$/i.test(token) || token === "<your-key>";
}

/**
 * The org's own key variable: `acme-dev` → VAPI_PRIVATE_API_KEY_ACME_DEV.
 * Org slugs are lowercase letters, digits and hyphens, so the mapping can't
 * collide. Unlike the generic name, one of these per org can be exported from
 * a shell profile without one org's key leaking into another org's commands.
 */
export function orgApiKeyVar(org: string): string {
  return `${API_KEY_VAR}_${org.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface OrgApiKey {
  token: string;
  /** Where the key came from, for logs: a variable name or `.env.<org>`. */
  source: string;
  /** Set when an exported generic key overrides a different key in `.env.<org>`. */
  warning?: string;
}

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !isPlaceholderToken(trimmed) ? trimmed : undefined;
}

/**
 * Resolve one org's key. In order: VAPI_PRIVATE_API_KEY_<ORG> in the
 * environment, then the generic VAPI_PRIVATE_API_KEY / VAPI_TOKEN in the
 * environment (how CI passes a secret), then the org's .env file values.
 *
 * The generic exported name applies to every org, so when it overrides a
 * different key in `.env.<org>` that is almost always a key for another org.
 * The result carries a warning naming both sources (never the values).
 */
export function resolveOrgApiKey(
  org: string,
  env: Vars,
  file: Vars,
): OrgApiKey | undefined {
  const orgVar = orgApiKeyVar(org);
  const fromOrgVar = usable(env[orgVar]);
  if (fromOrgVar) return { token: fromOrgVar, source: `the ${orgVar} environment variable` };

  const fromFile = usable(file[API_KEY_VAR]) ?? usable(file[LEGACY_API_KEY_VAR]);
  for (const name of [API_KEY_VAR, LEGACY_API_KEY_VAR]) {
    const fromEnv = usable(env[name]);
    if (!fromEnv) continue;
    const resolved: OrgApiKey = { token: fromEnv, source: `the ${name} environment variable` };
    if (fromFile && fromFile !== fromEnv) {
      resolved.warning =
        `Using the key in the ${name} environment variable, not the different key in .env.${org}.\n` +
        `   An exported ${name} applies to every org, so it may belong to another org.\n` +
        `   Unset it, or export ${orgVar} to choose this org's key explicitly.`;
    }
    return resolved;
  }

  if (fromFile) return { token: fromFile, source: `.env.${org}` };
  return undefined;
}

/** Human-readable fix-it text for a missing key. */
export function missingApiKeyMessage(org: string): string {
  return [
    `No Vapi private API key found for org "${org}".`,
    `   Copy a private key from ${API_KEYS_URL} (Private API Keys section),`,
    `   then add it to .env.${org} as: ${API_KEY_VAR}=<your private API key>`,
    `   or export ${orgApiKeyVar(org)}=<your private API key> in your shell.`,
    `   (${LEGACY_API_KEY_VAR} is still accepted for existing setups.)`,
  ].join("\n");
}
