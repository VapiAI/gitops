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

/** Human-readable fix-it text for a missing key. */
export function missingApiKeyMessage(org: string): string {
  return [
    `No Vapi private API key found for org "${org}".`,
    `   Copy a private key from ${API_KEYS_URL} (Private API Keys section),`,
    `   then add it to .env.${org} as: ${API_KEY_VAR}=<your private API key>`,
    `   (${LEGACY_API_KEY_VAR} is still accepted for existing setups.)`,
  ].join("\n");
}
