// CLI entry: `npm run sync-blocks [-- --org <org>] [--apply]`
//
// A block edit changes every resource that includes the block, in every org,
// without changing any of their files. This command finds those resources:
// the ones whose blocks differ from what the blocks record
// (state/<org>/blocks.json) says they were last pushed with.
//
// Without --apply it only lists them, reading files and nothing else. With
// --apply it runs `apply` for each org, scoped to those files, so the usual
// validate → pull → push path decides what reaches the platform: a resource
// that was edited in the dashboard is refused by the drift check there, and
// stays listed here.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseDir } from "./base-dir.ts";
import { blocksChanged, blocksRecordRead } from "./blocks.ts";
import { FOLDER_MAP, orgResourcesRead } from "./resource-parse.ts";

export interface BlocksStaleResource {
  org: string;
  // Path from the repository root.
  path: string;
  // The block files that changed since the resource was last pushed.
  blocks: string[];
}

export interface SyncBlocksDeps {
  rootDir: string;
  // Deploy the given files of one org; returns whether the run succeeded.
  applyRun: (org: string, paths: string[]) => boolean;
}

const USAGE = "Usage: npm run sync-blocks [-- --org <org>] [--apply]";

function orgsRead(rootDir: string): string[] {
  const resources = join(rootDir, "resources");
  if (!existsSync(resources)) return [];
  return readdirSync(resources)
    .filter(
      (entry) =>
        !entry.startsWith(".") &&
        statSync(join(resources, entry)).isDirectory(),
    )
    .sort();
}

// Every resource of one org whose blocks changed since it was last pushed.
export async function blocksStaleRead(
  rootDir: string,
  org: string,
): Promise<BlocksStaleResource[]> {
  const record = blocksRecordRead(rootDir, org);
  const stale: BlocksStaleResource[] = [];
  for (const resource of (await orgResourcesRead(rootDir, org)).values()) {
    if (Object.keys(resource.blocks).length === 0) continue;
    const blocks = blocksChanged(
      resource.blocks,
      record[`${FOLDER_MAP[resource.type]}/${resource.id}`],
    );
    if (blocks.length > 0)
      stale.push({ org, path: relative(rootDir, resource.filePath), blocks });
  }
  return stale.sort((left, right) => left.path.localeCompare(right.path));
}

function argumentsParse(args: string[]): { orgs: string[]; apply: boolean } {
  const parsed = { orgs: [] as string[], apply: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--apply") parsed.apply = true;
    else if (argument === "--org" && args[index + 1])
      parsed.orgs.push(args[++index]!);
    else
      throw new Error(
        `Unrecognized or incomplete argument: ${argument}\n${USAGE}`,
      );
  }
  return parsed;
}

function applyRun(rootDir: string, org: string, paths: string[]): boolean {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/apply.ts", org, ...paths],
    { cwd: rootDir, stdio: "inherit" },
  );
  return result.status === 0;
}

// Returns the process exit code: 1 when any resource that needs a sync was
// not synced, or an org's files could not be read.
export async function syncBlocksRun(
  args = process.argv.slice(2),
  overrides: Partial<SyncBlocksDeps> = {},
): Promise<number> {
  const rootDir =
    overrides.rootDir ?? resolve(process.env.VAPI_GITOPS_ROOT ?? baseDir());
  const deploy =
    overrides.applyRun ??
    ((org: string, paths: string[]) => applyRun(rootDir, org, paths));
  const parsed = argumentsParse(args);
  const known = orgsRead(rootDir);
  const unknown = parsed.orgs.filter((org) => !known.includes(org));
  if (unknown.length > 0)
    throw new Error(`No resources/${unknown[0]}/ folder in this repository`);
  const orgs = parsed.orgs.length > 0 ? parsed.orgs : known;

  console.log(
    `🧩 Blocks sync${parsed.apply ? "" : " (dry run: nothing is changed)"}`,
  );
  let failed = false;
  let pending = 0;
  for (const org of orgs) {
    let stale: BlocksStaleResource[];
    try {
      stale = await blocksStaleRead(rootDir, org);
    } catch (error) {
      console.error(
        `\n${org}\n  ❌ ${error instanceof Error ? error.message : error}`,
      );
      failed = true;
      continue;
    }
    if (stale.length === 0) continue;
    console.log(`\n${org}`);
    for (const resource of stale)
      console.log(
        `  ${relative(join("resources", org), resource.path)} (block changed: ${resource.blocks.join(", ")})`,
      );
    if (!parsed.apply) {
      pending += stale.length;
      continue;
    }
    console.log(`\n🚀 Applying ${stale.length} resource(s) to ${org}...\n`);
    const succeeded = deploy(
      org,
      stale.map((resource) => resource.path),
    );
    const left = await blocksStaleRead(rootDir, org);
    if (succeeded && left.length === 0) continue;
    failed = true;
    console.error(
      `\n❌ ${org}: ${left.length} resource(s) still run the old block text:`,
    );
    for (const resource of left) console.error(`     - ${resource.path}`);
    console.error(
      "   The output above says why: a resource edited in the dashboard is refused until that edit is resolved.",
    );
  }

  if (parsed.apply) {
    if (!failed) console.log("\n✅ Every resource is in sync with its blocks.");
    return failed ? 1 : 0;
  }
  if (pending === 0 && !failed)
    console.log("\n✅ Every resource is in sync with its blocks.");
  if (pending > 0)
    console.log(
      `\n${pending} resource(s) still run the old block text. To push them: npm run sync-blocks -- --apply`,
    );
  return failed ? 1 : 0;
}

const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  syncBlocksRun().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `❌ Blocks sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
