// CLI entry: `npm run check -- <check>|--all --dry-run [--print-payload [dir]]`
//
// Builds each check target's inline simulation-run payload from the files
// on disk (see check-payload.ts) and reports what would run. Config-free:
// it needs no API key and makes no network calls in --dry-run.
//
// Exit codes: 0 every payload built, 2 usage, config or build error.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckDefinition } from "./check-config.ts";
import { CHECKS_CONFIG_FILE, checksConfigLoad } from "./check-config.ts";
import type { CheckPayloadResult } from "./check-payload.ts";
import { checkPayloadBuild } from "./check-payload.ts";
import { promotionBindingsResolve, promotionStateParse } from "./promotion.ts";
import { orgResourcesRead } from "./resource-parse.ts";
import type { StateFile } from "./types.ts";

const USAGE = [
  "Usage:",
  "  npm run check -- <check> --dry-run [--print-payload [dir]]",
  "  npm run check -- --all --dry-run [--print-payload [dir]]",
  "",
  "Options:",
  `  <check>                 A check name from ${CHECKS_CONFIG_FILE}`,
  "  --all                   Every check",
  "  --dry-run               Build the payloads offline; nothing is sent",
  "  --print-payload [dir]   Write each payload as JSON (default: tmp/check-payloads)",
  "",
  "Exit codes: 0 payloads built, 2 usage, config or build error",
].join("\n");

const DEFAULT_PAYLOAD_DIR = "tmp/check-payloads";

interface CheckArgs {
  check?: string;
  all: boolean;
  dryRun: boolean;
  payloadDir?: string;
  help: boolean;
}

class UsageError extends Error {}

function argsParse(args: string[]): CheckArgs {
  const parsed: CheckArgs = { all: false, dryRun: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--print-payload") {
      const next = args[index + 1];
      parsed.payloadDir =
        next && !next.startsWith("--") ? args[++index] : DEFAULT_PAYLOAD_DIR;
    } else if (arg.startsWith("-"))
      throw new UsageError(`Unknown option: ${arg}`);
    else if (parsed.check) throw new UsageError(`Unexpected argument: ${arg}`);
    else parsed.check = arg;
  }
  if (parsed.help) return parsed;
  if (parsed.all === Boolean(parsed.check))
    throw new UsageError("Name one check, or pass --all");
  return parsed;
}

function emptyState(): StateFile {
  return promotionStateParse("{}");
}

function stateRead(root: string, org: string, warnings: string[]): StateFile {
  const path = join(root, `.vapi-state.${org}.json`);
  if (!existsSync(path)) {
    warnings.push(
      `no .vapi-state.${org}.json: references by UUID and credential bindings can't resolve`,
    );
    return emptyState();
  }
  return promotionStateParse(readFileSync(path, "utf8"));
}

function payloadFileName(check: string, target: string): string {
  return `${check}--${target.replace(/\//g, "--")}.json`;
}

function resultPrint(
  label: string,
  result: CheckPayloadResult,
  check: CheckDefinition,
): void {
  console.log(`\n${label}`);
  if (result.body) {
    const count = result.body.simulations.length;
    console.log(
      `  ✅ ${count} simulation${count === 1 ? "" : "s"} × ${check.iterations} iteration${check.iterations === 1 ? "" : "s"} over ${check.transport}, ${(result.bytes / 1024).toFixed(1)} KB`,
    );
  } else {
    console.log(
      `  ❌ ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}`,
    );
  }
  for (const warning of result.warnings) console.log(`  ⚠️  ${warning}`);
  for (const error of result.errors) console.log(`  ❌ ${error}`);
}

async function checkDryRun(
  root: string,
  check: CheckDefinition,
  payloadDir: string | undefined,
): Promise<boolean> {
  if (!existsSync(join(root, "resources", check.org))) {
    console.log(`\n${check.name}\n  ❌ resources/${check.org}/ does not exist`);
    return false;
  }
  const warnings: string[] = [];
  const resources = await orgResourcesRead(root, check.org);
  const sourceState = stateRead(root, check.org, warnings);
  const runState =
    check.runOrg === check.org
      ? sourceState
      : stateRead(root, check.runOrg, warnings);
  const bindingsResolved = await promotionBindingsResolve(
    root,
    check.org,
    check.runOrg,
    sourceState,
  );
  let ok = true;
  for (const target of check.targets) {
    const targetLabel = `${target.type}/${target.id}`;
    const result = checkPayloadBuild({
      check,
      target,
      resources,
      sourceState,
      runState,
      bindingsResolved,
    });
    result.warnings.unshift(...warnings);
    resultPrint(`${check.name} / ${targetLabel}`, result, check);
    if (!result.body) {
      ok = false;
      continue;
    }
    if (payloadDir) {
      const dir = resolve(root, payloadDir);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, payloadFileName(check.name, targetLabel));
      writeFileSync(file, `${JSON.stringify(result.body, null, 2)}\n`);
      console.log(`  📝 ${relative(root, file)}`);
    }
  }
  return ok;
}

export async function checkCommandRun(
  args = process.argv.slice(2),
  root = resolve(
    process.env.VAPI_GITOPS_ROOT ??
      fileURLToPath(new URL("..", import.meta.url)),
  ),
): Promise<number> {
  let parsed: CheckArgs;
  try {
    parsed = argsParse(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`❌ ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  let config;
  try {
    config = checksConfigLoad(root);
  } catch (error) {
    console.error(`❌ ${CHECKS_CONFIG_FILE}: ${(error as Error).message}`);
    return 2;
  }
  if (!config) {
    console.log(
      `No ${CHECKS_CONFIG_FILE} at the repository root; nothing to check.`,
    );
    return 0;
  }
  const names = parsed.all ? Object.keys(config.checks) : [parsed.check!];
  const missing = names.filter((name) => !config.checks[name]);
  if (missing.length > 0) {
    console.error(
      `❌ No check named ${missing.join(", ")} in ${CHECKS_CONFIG_FILE} (checks: ${Object.keys(config.checks).join(", ")})`,
    );
    return 2;
  }
  if (!parsed.dryRun) {
    console.error(
      "❌ Live runs aren't available yet: pass --dry-run to build the payloads offline.",
    );
    return 2;
  }
  let ok = true;
  for (const name of names) {
    if (!(await checkDryRun(root, config.checks[name]!, parsed.payloadDir)))
      ok = false;
  }
  console.log(
    ok ? "\n✅ Every payload built." : "\n❌ Some payloads could not be built.",
  );
  return ok ? 0 : 2;
}

const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  checkCommandRun().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `❌ Check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    },
  );
}
