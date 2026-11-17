// What each saved credential is a key for.
//
// The state file maps a credential's name to its UUID and nothing else. A
// `credentialIds` list can only be checked against the org's keys when the
// provider of each key is known too, and pull already fetches that. Pull
// records it in resources/<org>/.vapi-credential-providers.json, which is
// committed with the folder. It holds no secret: a provider name per key,
// and whether a storage bucket is set on it.
//
// Config-free so validate, push and tests can read any org.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sortedKeysReplacer } from "./state-serialize.ts";

export const CREDENTIAL_KINDS_FILE = ".vapi-credential-providers.json";

export interface CredentialKind {
  provider: string;
  // The key has a storage bucket configured. A gcp, azure or supabase key
  // only receives recordings when it does.
  bucket?: true;
}

// Credential name (as resource files write it) → what it is a key for.
export type CredentialKinds = Record<string, CredentialKind>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** What one credential from GET /credential is a key for. */
export function credentialKindOf(
  credential: Record<string, unknown>,
): CredentialKind | undefined {
  if (typeof credential.provider !== "string" || !credential.provider)
    return undefined;
  const plan = record(credential.bucketPlan);
  const bucket = plan?.name || plan?.containerName;
  return typeof bucket === "string" && bucket
    ? { provider: credential.provider, bucket: true }
    : { provider: credential.provider };
}

/** The org's recorded credential kinds, or undefined before its first pull. */
export function credentialKindsRead(
  resourcesDir: string,
): CredentialKinds | undefined {
  const path = join(resourcesDir, CREDENTIAL_KINDS_FILE);
  if (!existsSync(path)) return undefined;
  const raw = record(JSON.parse(readFileSync(path, "utf-8")));
  if (!raw) throw new Error(`${path} must hold a JSON object`);
  const kinds: CredentialKinds = {};
  for (const [name, value] of Object.entries(raw)) {
    const entry = record(value);
    if (typeof entry?.provider !== "string") continue;
    kinds[name] =
      entry.bucket === true
        ? { provider: entry.provider, bucket: true }
        : { provider: entry.provider };
  }
  return kinds;
}

/** Write the org's credential kinds. Returns false when nothing changed. */
export function credentialKindsWrite(
  resourcesDir: string,
  kinds: CredentialKinds,
): boolean {
  const path = join(resourcesDir, CREDENTIAL_KINDS_FILE);
  const content = `${JSON.stringify(kinds, sortedKeysReplacer, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return false;
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(path, content);
  return true;
}
