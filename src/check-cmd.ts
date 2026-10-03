// CLI entry: `npm run check -- <check>|--all [options]`
//
// Builds each check target's inline simulation-run payload from the files
// on disk (check-payload.ts, check-mocks.ts) and, unless --dry-run, runs it
// in the check's run org and reports a strict verdict — as `Vapi Evals`
// commit statuses when the PR workflow's GitHub env is set, and always as
// a markdown report (the job summary in CI).
//
// Exit codes: 0 passed (or every payload built, with --dry-run), 1 failed,
// 2 usage, config or build error, 3 incomplete (timeout, interrupt, budget,
// billing, or API trouble).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckJob } from "./check-build.ts";
import { checkJobsBuild, checkTargetLabel } from "./check-build.ts";
import type { CheckDefinition, ChecksConfig } from "./check-config.ts";
import { CHECKS_CONFIG_FILE, checksConfigLoad } from "./check-config.ts";
import type { CheckReportSkipped } from "./check-report.ts";
import { checkReportJson, checkReportMarkdown } from "./check-report.ts";
import type { CheckTargetResult } from "./check-run.ts";
import { checkRunAll, outcomeState } from "./check-run.ts";
import { checkAffectedBy, changedFilesRead } from "./check-select.ts";
import type { CommitStatus, GitHubStatusEnv } from "./check-status.ts";
import {
  AGGREGATE_CONTEXT,
  commitStateWorst,
  commitStatusPost,
  githubStatusEnvRead,
  targetContext,
} from "./check-status.ts";
import type { OrgConnection } from "./org-connection.ts";
import { childRun, connectionLoad, tokensParse } from "./org-connection.ts";
import { userAgentGet } from "./user-agent.ts";
import type { VapiConnection } from "./vapi-client.ts";

const USAGE = [
  "Usage:",
  "  npm run check -- <check> [options]",
  "  npm run check -- --all [options]",
  "",
  "Options:",
  `  <check>                  A check name from ${CHECKS_CONFIG_FILE}`,
  "  --all                    Every check (also posts the aggregate Vapi Evals status)",
  "  --dry-run                Build the payloads offline; nothing is sent",
  "  --print-payload [dir]    Write each payload as JSON (default: tmp/check-payloads)",
  "  --changed-since <ref>    Only checks affected by changes since the merge base with <ref>",
  "  --budget-minutes <n>     Overall time budget; runs that can't fit aren't started (default: 60)",
  "  --refresh-bindings       Refresh each run org's credential bindings first (read-only pull)",
  "  --json <path>            Also write the report as JSON",
  "",
  'Keys (live runs): VAPI_CHECK_TOKENS ({"<org>":"<key>"}), then .env.<runOrg>,',
  "then VAPI_PRIVATE_API_KEY when every selected check runs in one org.",
  "",
  "Exit codes: 0 passed, 1 failed, 2 usage/config/build error, 3 incomplete",
].join("\n");

const DEFAULT_PAYLOAD_DIR = "tmp/check-payloads";
const DEFAULT_BUDGET_MINUTES = 60;
const DEFAULT_BASE_URL = "https://api.vapi.ai";
const TOKENS_ENV = "VAPI_CHECK_TOKENS";

interface CheckArgs {
  check?: string;
  all: boolean;
  dryRun: boolean;
  payloadDir?: string;
  changedSince?: string;
  budgetMinutes: number;
  refreshBindings: boolean;
  jsonPath?: string;
  help: boolean;
}

class UsageError extends Error {}

function valueTake(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new UsageError(`${flag} needs a value`);
  return value;
}

function argsParse(args: string[]): CheckArgs {
  const parsed: CheckArgs = {
    all: false,
    dryRun: false,
    budgetMinutes: DEFAULT_BUDGET_MINUTES,
    refreshBindings: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--refresh-bindings") parsed.refreshBindings = true;
    else if (arg === "--print-payload") {
      const next = args[index + 1];
      parsed.payloadDir =
        next && !next.startsWith("--") ? args[++index] : DEFAULT_PAYLOAD_DIR;
    } else if (arg === "--changed-since")
      parsed.changedSince = valueTake(args, index++, arg);
    else if (arg === "--json") parsed.jsonPath = valueTake(args, index++, arg);
    else if (arg === "--budget-minutes") {
      const minutes = Number(valueTake(args, index++, arg));
      if (!(minutes > 0))
        throw new UsageError("--budget-minutes must be a positive number");
      parsed.budgetMinutes = minutes;
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function jobPrint(job: CheckJob, root: string, payloadDir?: string): void {
  const { result, check } = job;
  console.log(`\n${job.label}`);
  if (result.body) {
    console.log(
      `  ✅ ${plural(result.body.simulations.length, "simulation")} × ${plural(check.iterations, "iteration")} over ${check.transport}, ${(result.bytes / 1024).toFixed(1)} KB`,
    );
  } else {
    console.log(`  ❌ ${plural(result.errors.length, "problem")}`);
  }
  for (const warning of result.warnings) console.log(`  ⚠️  ${warning}`);
  for (const error of result.errors) console.log(`  ❌ ${error}`);
  if (!result.body || !payloadDir) return;
  const file = join(
    resolve(root, payloadDir),
    `${check.name}--${checkTargetLabel(job.target).replace(/\//g, "--")}.json`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result.body, null, 2)}\n`);
  console.log(`  📝 ${relative(root, file)}`);
}

function checksSelect(
  root: string,
  checks: CheckDefinition[],
  changedSince: string | undefined,
): { selected: CheckDefinition[]; skipped: CheckReportSkipped[] } {
  if (!changedSince) return { selected: checks, skipped: [] };
  const files = changedFilesRead(root, changedSince);
  if (!files) {
    console.warn(
      `⚠️  Couldn't diff against ${changedSince}; running every selected check`,
    );
    return { selected: checks, skipped: [] };
  }
  const selected: CheckDefinition[] = [];
  const skipped: CheckReportSkipped[] = [];
  for (const check of checks) {
    const file = checkAffectedBy(check, files);
    if (file) {
      console.log(`🔎 ${check.name}: affected by ${file}`);
      selected.push(check);
    } else {
      skipped.push({
        check: check.name,
        reason: `not affected by changes since ${changedSince}`,
      });
    }
  }
  return { selected, skipped };
}

// One connection per run org. Missing keys are a config error, found before
// any run starts.
function connectionsLoad(
  root: string,
  checks: CheckDefinition[],
): Map<string, OrgConnection> {
  const tokens = tokensParse(TOKENS_ENV);
  // Child processes (the bindings refresh) get one org's key, never the map.
  delete process.env[TOKENS_ENV];
  const runOrgs = [...new Set(checks.map((check) => check.runOrg))];
  const envKey = process.env.VAPI_PRIVATE_API_KEY ?? process.env.VAPI_TOKEN;
  const connections = new Map<string, OrgConnection>();
  for (const runOrg of runOrgs) {
    const baseUrl = checks.find(
      (check) => check.runOrg === runOrg && check.baseUrl,
    )?.baseUrl;
    let connection: OrgConnection;
    try {
      connection = connectionLoad({
        rootDir: root,
        org: runOrg,
        tokens,
        tokensEnvName: TOKENS_ENV,
        baseUrl,
      });
    } catch (error) {
      if (!envKey || runOrgs.length !== 1) throw error;
      connection = { token: envKey, baseUrl };
    }
    connections.set(runOrg, {
      token: connection.token,
      baseUrl:
        connection.baseUrl ?? process.env.VAPI_BASE_URL ?? DEFAULT_BASE_URL,
    });
  }
  return connections;
}

function exitCode(results: CheckTargetResult[]): number {
  const outcomes = new Set(results.map((result) => result.outcome));
  if (outcomes.has("error")) return 2;
  if (outcomes.has("failed")) return 1;
  if (outcomes.has("incomplete")) return 3;
  return 0;
}

function aggregateStatus(
  results: CheckTargetResult[],
  dryRun: boolean,
  statusEnv: GitHubStatusEnv,
): CommitStatus {
  if (results.length === 0)
    return {
      context: AGGREGATE_CONTEXT,
      state: "success",
      description: "No checks affected by this change",
      targetUrl: statusEnv.runUrl,
    };
  if (dryRun)
    return {
      context: AGGREGATE_CONTEXT,
      state: "error",
      description:
        "Not run: fork or Dependabot PR — a maintainer must dispatch the check",
      targetUrl: statusEnv.runUrl,
    };
  const counts = new Map<string, number>();
  for (const result of results)
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  const urls = results.map((result) => result.url).filter(Boolean);
  return {
    context: AGGREGATE_CONTEXT,
    state: commitStateWorst(
      results.map((result) => outcomeState(result.outcome)),
    ),
    description: [...counts]
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(", "),
    targetUrl:
      urls.length === 1 && results.length === 1 ? urls[0] : statusEnv.runUrl,
  };
}

function reportWrite(
  root: string,
  parsed: CheckArgs,
  results: CheckTargetResult[],
  skipped: CheckReportSkipped[],
): void {
  const input = { results, skipped, dryRun: parsed.dryRun };
  const markdown = checkReportMarkdown(input);
  console.log(`\n${markdown}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown}\n`);
  if (parsed.jsonPath) {
    const path = resolve(root, parsed.jsonPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(checkReportJson(input), null, 2)}\n`);
  }
}

async function liveRun(
  parsed: CheckArgs,
  jobs: CheckJob[],
  connections: Map<string, OrgConnection>,
  statusEnv: GitHubStatusEnv | undefined,
): Promise<CheckTargetResult[]> {
  const controller = new AbortController();
  const abort = () => {
    console.log("\n⏹  Interrupted: canceling in-flight runs…");
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const userAgent = userAgentGet("check");
  const vapi = (job: CheckJob): VapiConnection => {
    const connection = connections.get(job.check.runOrg)!;
    return { token: connection.token, baseUrl: connection.baseUrl!, userAgent };
  };
  const post = async (status: CommitStatus) => {
    if (statusEnv) await commitStatusPost(statusEnv, status);
  };
  try {
    console.log(
      `\n🧪 Running ${plural(jobs.filter((job) => job.result.body).length, "target")}…`,
    );
    return await checkRunAll({
      jobs,
      connectionFor: vapi,
      deadline: Date.now() + parsed.budgetMinutes * 60_000,
      signal: controller.signal,
      onRunCreated: (job, url) =>
        post({
          context: targetContext(job.check.name, checkTargetLabel(job.target)),
          state: "pending",
          description: "Simulations running",
          targetUrl: url,
        }),
      onResult: (result) =>
        post({
          context: targetContext(
            result.job.check.name,
            checkTargetLabel(result.job.target),
          ),
          state: outcomeState(result.outcome),
          description: result.reason,
          targetUrl: result.url ?? statusEnv?.runUrl,
        }),
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function checksRun(
  root: string,
  parsed: CheckArgs,
  config: ChecksConfig,
  statusEnv: GitHubStatusEnv | undefined,
): Promise<{ code: number; results?: CheckTargetResult[] }> {
  const names = parsed.all ? Object.keys(config.checks) : [parsed.check!];
  const missing = names.filter((name) => !config.checks[name]);
  if (missing.length > 0) {
    console.error(
      `❌ No check named ${missing.join(", ")} in ${CHECKS_CONFIG_FILE} (checks: ${Object.keys(config.checks).join(", ")})`,
    );
    return { code: 2 };
  }
  const { selected, skipped } = checksSelect(
    root,
    names.map((name) => config.checks[name]!),
    parsed.changedSince,
  );
  let connections = new Map<string, OrgConnection>();
  if (!parsed.dryRun && selected.length > 0) {
    try {
      connections = connectionsLoad(root, selected);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      return { code: 2 };
    }
    if (parsed.refreshBindings)
      for (const [org, connection] of connections)
        childRun({
          rootDir: root,
          script: "src/pull.ts",
          org,
          connection,
          args: ["--bootstrap", "--bindings-only"],
        });
  }
  const jobs: CheckJob[] = [];
  for (const check of selected)
    jobs.push(...(await checkJobsBuild(root, check)));
  for (const job of jobs) jobPrint(job, root, parsed.payloadDir);
  const results: CheckTargetResult[] = parsed.dryRun
    ? jobs.map((job) => ({
        job,
        outcome: job.result.body ? "built" : "error",
        reason: job.result.body
          ? "payload built; not run (--dry-run)"
          : `${plural(job.result.errors.length, "problem")} building the payload`,
        failures: [],
        mockNotices: [],
        durationMs: 0,
      }))
    : await liveRun(parsed, jobs, connections, statusEnv);
  reportWrite(root, parsed, results, skipped);
  return { code: exitCode(results), results };
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
  const statusEnv = githubStatusEnvRead();
  let aggregate: CommitStatus | undefined = {
    context: AGGREGATE_CONTEXT,
    state: "error",
    description: "The check failed before it could report",
    targetUrl: statusEnv?.runUrl,
  };
  try {
    let config: ChecksConfig | null;
    try {
      config = checksConfigLoad(root);
    } catch (error) {
      console.error(`❌ ${CHECKS_CONFIG_FILE}: ${(error as Error).message}`);
      aggregate.description = `${CHECKS_CONFIG_FILE} is invalid`;
      return 2;
    }
    if (!config) {
      console.log(
        `No ${CHECKS_CONFIG_FILE} at the repository root; nothing to check.`,
      );
      aggregate = undefined;
      return 0;
    }
    const { code, results } = await checksRun(root, parsed, config, statusEnv);
    if (results && statusEnv)
      aggregate = aggregateStatus(results, parsed.dryRun, statusEnv);
    return code;
  } finally {
    // Only an --all run speaks for the whole PR.
    if (parsed.all && statusEnv && aggregate)
      await commitStatusPost(statusEnv, aggregate);
  }
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
