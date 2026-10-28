// Pins each org folder to the Vapi org it was set up from.
//
// Nothing else ties resources/<org>/ to an org: the key alone decides where a
// command reads and writes. A key for the wrong org (an exported variable, a
// copied .env file, a mislabelled CI secret) would pull another org's
// resources into the folder, or push this folder into another org. The first
// command that can see the key's org records it in resources/<org>/.vapi-org.json,
// which is committed with the folder. Every later command checks the key
// against it and refuses a mismatch before any request.
//
// A private key can't ask which org it belongs to (/org and /org/me reject
// private keys), so the org ID comes from the first resource the key can
// list. Promotion skips dotfiles, so the pin never travels to another org.
//
// Config-free so rollback and tests can check any org.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgApiKeyVar } from "./api-key.ts";
import {
  type VapiConnection,
  VapiApiError,
  vapiFetchJson,
} from "./vapi-client.ts";

export const ORG_PIN_FILE = ".vapi-org.json";

// Cheap one-item list calls, most likely non-empty first. Every item carries
// the orgId it belongs to.
export const ORG_PROBE_ENDPOINTS = [
  "/assistant",
  "/tool",
  "/squad",
  "/phone-number",
  "/credential",
  "/structured-output",
];

export type OrgProbeFetch = (
  connection: VapiConnection,
  endpoint: string,
) => Promise<unknown>;

/** What the key's resources say about its org. */
export type KeyOrg =
  | { kind: "found"; orgId: string }
  // Every probe answered and none listed anything: the key's org is empty.
  | { kind: "empty" }
  // A probe failed (network, 5xx, 401), so the org can't be told.
  | { kind: "unknown" };

export type OrgPinOutcome =
  | { kind: "match" }
  | { kind: "pinned"; orgId: string }
  | { kind: "unverified" }
  | { kind: "unpinned" };

export class OrgPinMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgPinMismatchError";
  }
}

// A probe is a safety check, not the command: don't spend a minute of
// backoff on a flaky endpoint before the real requests start.
const probeFetchDefault: OrgProbeFetch = (connection, endpoint) =>
  vapiFetchJson(connection, "GET", endpoint, undefined, {
    retry: "rate-limit-only",
    maxRetries: 2,
  });

export function orgPinPath(rootDir: string, org: string): string {
  return join(rootDir, "resources", org, ORG_PIN_FILE);
}

/** The org ID this folder is pinned to, if any. A corrupt pin file throws. */
export function orgPinRead(rootDir: string, org: string): string | undefined {
  const path = orgPinPath(rootDir, org);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Can't read resources/${org}/${ORG_PIN_FILE}: ${reason}. Restore it from git.`,
    );
  }
  const orgId = (parsed as { orgId?: unknown } | null)?.orgId;
  return typeof orgId === "string" && orgId ? orgId : undefined;
}

function itemsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const results = (data as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

/** Find the key's org from the first resource it can list. */
export async function keyOrgFetch(
  connection: VapiConnection,
  probeFetch: OrgProbeFetch = probeFetchDefault,
): Promise<KeyOrg> {
  let failed = false;
  for (const endpoint of ORG_PROBE_ENDPOINTS) {
    let data: unknown;
    try {
      data = await probeFetch(connection, `${endpoint}?limit=1`);
    } catch (error) {
      // A rejected key fails every probe; the command reports it properly.
      if (error instanceof VapiApiError && error.statusCode === 401)
        return { kind: "unknown" };
      failed = true;
      continue;
    }
    for (const item of itemsOf(data)) {
      const orgId = (item as { orgId?: unknown } | null)?.orgId;
      if (typeof orgId === "string" && orgId) return { kind: "found", orgId };
    }
  }
  return failed ? { kind: "unknown" } : { kind: "empty" };
}

export interface OrgPinCheckArgs {
  rootDir: string;
  /** The org slug: the folder under resources/. */
  org: string;
  connection: VapiConnection;
  /** Where the key came from, for the error message (never the key). */
  keySource: string;
  probeFetch?: OrgProbeFetch;
}

/**
 * Check the key against resources/<org>/.vapi-org.json. Pins an unpinned
 * folder to the key's org on first sight. Throws OrgPinMismatchError when the
 * key belongs to another org, or to an empty org while the folder is pinned
 * to one that had resources.
 */
export async function orgPinCheck(args: OrgPinCheckArgs): Promise<OrgPinOutcome> {
  const { rootDir, org, connection, keySource } = args;
  // Set only by tests/no-vapi-api.ts: tests that stub fetch count requests.
  if (process.env.VAPI_GITOPS_ORG_PIN === "off") return { kind: "unpinned" };
  const pinned = orgPinRead(rootDir, org);
  // No folder and no pin: nothing to protect or record (a CI run org, or an
  // org whose first pull hasn't created the folder yet). Skip the probes.
  const folderExists = existsSync(join(rootDir, "resources", org));
  if (!pinned && !folderExists) return { kind: "unpinned" };
  const keyOrg = await keyOrgFetch(connection, args.probeFetch);
  const folder = `resources/${org}/`;
  const fix =
    `   Use ${org}'s own key, for example by exporting ${orgApiKeyVar(org)}.\n` +
    `   If this folder really moved to another org, delete ${folder}${ORG_PIN_FILE}\n` +
    `   in a reviewed commit and run the command again.`;

  if (keyOrg.kind === "found") {
    if (pinned === keyOrg.orgId) return { kind: "match" };
    if (pinned)
      throw new OrgPinMismatchError(
        `The API key from ${keySource} belongs to Vapi org ${keyOrg.orgId}, but ${folder} is pinned to org ${pinned} (${ORG_PIN_FILE}).\n` +
          `   Stopped before reading or changing anything.\n${fix}`,
      );
    if (!folderExists) return { kind: "unpinned" };
    writeFileSync(
      orgPinPath(rootDir, org),
      `${JSON.stringify({ orgId: keyOrg.orgId }, null, 2)}\n`,
    );
    return { kind: "pinned", orgId: keyOrg.orgId };
  }

  if (!pinned) return { kind: "unpinned" };
  // The folder was pinned from an org that listed resources. A key whose org
  // lists none is far more likely a fresh, different org than the same org
  // emptied out, and pushing would fill it with this folder's resources.
  if (keyOrg.kind === "empty")
    throw new OrgPinMismatchError(
      `The API key from ${keySource} belongs to an org with no resources, but ${folder} is pinned to org ${pinned} (${ORG_PIN_FILE}).\n` +
        `   Stopped before reading or changing anything.\n${fix}`,
    );
  return { kind: "unverified" };
}
