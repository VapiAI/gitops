// What each saved credential is a key for.
//
// The state file maps a credential's name to its UUID and nothing else. A
// `credentialIds` list can only be checked against the org's keys when the
// provider of each key is known too, and pull already fetches that. Pull
// records it in state/<org>/credential-providers.json, which is committed
// with the state file. It holds no secret: a provider name per key, and
// whether a storage bucket is set on it.
//
// Config-free so validate, push and tests can read any org.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { stateRecordPath } from "./state-paths.ts";
import { sortedKeysReplacer } from "./state-serialize.ts";

// state/<org>/credential-providers.json, or
// resources/<org>/.vapi-credential-providers.json while the org's state is
// still in the old layout, where an older commit step stages it.
export function credentialKindsPath(rootDir: string, org: string): string {
  return stateRecordPath(rootDir, org, "credential-providers");
}

/** The file as a person names it: its path from the repository root. */
export function credentialKindsLabel(rootDir: string, org: string): string {
  return relative(rootDir, credentialKindsPath(rootDir, org)).replaceAll(
    "\\",
    "/",
  );
}

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
  rootDir: string,
  org: string,
): CredentialKinds | undefined {
  const path = credentialKindsPath(rootDir, org);
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
  rootDir: string,
  org: string,
  kinds: CredentialKinds,
): boolean {
  const path = credentialKindsPath(rootDir, org);
  const content = `${JSON.stringify(kinds, sortedKeysReplacer, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}
