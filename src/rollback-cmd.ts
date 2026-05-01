// CLI entry: `npm run rollback -- <org> --to <ISO-timestamp>` |
//             `npm run rollback -- <org> --list`
//
// Reads .vapi-state.<env>.snapshots/<timestamp>/<resource-type>/<id>.json
// and re-applies the captured *platform* payload via PATCH, restoring the
// dashboard to its state at that snapshot moment.
//
// Self-contained (does not import config.ts) so it can run in isolation
// without triggering the global CLI parser.

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  listSnapshotTimestamps,
  loadSnapshot,
} from "./snapshot.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

interface RollbackEnv {
  env: string;
  token: string;
  baseUrl: string;
}

function loadEnvFile(env: string): RollbackEnv {
  const envFiles = [
    join(BASE_DIR, `.env.${env}`),
    join(BASE_DIR, `.env.${env}.local`),
    join(BASE_DIR, ".env.local"),
  ];
  const envVars: Record<string, string> = {};
  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (envVars[key] === undefined) envVars[key] = value;
    }
  }
  const token = process.env.VAPI_TOKEN || envVars.VAPI_TOKEN;
  const baseUrl =
    process.env.VAPI_BASE_URL ||
    envVars.VAPI_BASE_URL ||
    "https://api.vapi.ai";
  if (!token) {
    console.error(`❌ VAPI_TOKEN not found. Create .env.${env} with VAPI_TOKEN=your-token`);
    process.exit(1);
  }
  return { env, token, baseUrl };
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  npm run rollback -- <org> --list",
      "  npm run rollback -- <org> --to <ISO-timestamp>",
      "",
      "Snapshots are written automatically before each `npm run push` operation",
      "to .vapi-state.<env>.snapshots/<timestamp>/. Use --list to inspect available",
      "timestamps; use --to <ts> to re-apply the platform payloads from that snapshot.",
    ].join("\n"),
  );
}

const ENDPOINT_MAP: Record<string, string> = {
  tools: "/tool",
  structuredOutputs: "/structured-output",
  assistants: "/assistant",
  squads: "/squad",
  personalities: "/eval/simulation/personality",
  scenarios: "/eval/simulation/scenario",
  simulations: "/eval/simulation",
  simulationSuites: "/eval/simulation/suite",
  evals: "/eval",
};

interface ParsedArgs {
  env: string;
  list: boolean;
  to?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const env = args[0];
  if (!env) {
    printUsage();
    process.exit(1);
  }
  const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!SLUG_RE.test(env)) {
    console.error(`❌ Invalid org name: ${env}`);
    process.exit(1);
  }
  const parsed: ParsedArgs = { env, list: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") parsed.list = true;
    else if (a === "--to") parsed.to = args[++i];
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!parsed.list && !parsed.to) {
    console.error("❌ Specify --list or --to <timestamp>");
    printUsage();
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.list) {
    const timestamps = await listSnapshotTimestamps(BASE_DIR, args.env);
    if (timestamps.length === 0) {
      console.log(`No snapshots found for ${args.env}.`);
      return;
    }
    console.log(`Snapshots for ${args.env}:`);
    for (const t of timestamps) console.log(`  ${t}`);
    return;
  }

  const cfg = loadEnvFile(args.env);
  const entries = await loadSnapshot(BASE_DIR, args.env, args.to!);
  if (entries.length === 0) {
    console.log("Snapshot directory exists but contains no resources.");
    return;
  }

  // We need state so we can resolve resourceId → UUID for the PATCH path.
  // Snapshot files don't store the UUID directly because the snapshot is
  // keyed by resourceId; the same resourceId points at the same UUID across
  // pushes (unless renamed, in which case the snapshot is stale anyway).
  const stateFile = join(BASE_DIR, `.vapi-state.${args.env}.json`);
  if (!existsSync(stateFile)) {
    console.error(`❌ State file not found: ${stateFile}`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<
    string,
    Record<string, { uuid: string }>
  >;

  console.log(`🔁 Rollback ${args.env} → snapshot ${args.to}`);
  console.log(`   ${entries.length} resource(s) to restore\n`);

  let restored = 0;
  let skipped = 0;
  for (const entry of entries) {
    const endpoint = ENDPOINT_MAP[entry.resourceType];
    if (!endpoint) {
      console.warn(`   ⚠️  Unknown resource type: ${entry.resourceType}, skipping`);
      skipped++;
      continue;
    }
    const section = state[entry.resourceType];
    const uuid = section?.[entry.resourceId]?.uuid;
    if (!uuid) {
      console.warn(
        `   ⚠️  No UUID in state for ${entry.resourceType}/${entry.resourceId} — skipping`,
      );
      skipped++;
      continue;
    }
    process.stdout.write(`   🔁 ${entry.resourceType}/${entry.resourceId} ... `);
    const response = await fetch(`${cfg.baseUrl}${endpoint}/${uuid}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry.payload.platform),
    });
    if (!response.ok) {
      const text = await response.text();
      console.log(`❌ ${response.status}`);
      console.error(`      ${text}`);
      skipped++;
      continue;
    }
    console.log("✅");
    restored++;
  }

  console.log(
    `\n📊 Rollback summary: ${restored} restored, ${skipped} skipped`,
  );
  if (skipped > 0) process.exit(1);
}

main().catch((error) => {
  console.error("\n❌ Rollback failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
