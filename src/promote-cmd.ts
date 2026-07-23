import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PromotionConfig,
  PromotionPipeline,
  PromotionPlan,
} from "./promotion.ts";
import {
  promotionConfigParse,
  promotionPlanApply,
  promotionPlanBuild,
  promotionStateParse,
  promotionTransitionValidate,
} from "./promotion.ts";

interface PromotionArguments {
  pipeline?: string;
  source?: string;
  target?: string;
  all: boolean;
  apply: boolean;
}

interface PromotionTransition {
  pipeline: string;
  source: string;
  target: string;
  definition: PromotionPipeline;
}

interface OrgConnection {
  token: string;
  baseUrl?: string;
}

const ROOT_DIR = resolve(
  process.env.VAPI_GITOPS_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
);

function argumentsParse(args: string[]): PromotionArguments {
  const parsed: PromotionArguments = { all: false, apply: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--all") {
      parsed.all = true;
      continue;
    }
    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (argument === "--pipeline" && args[index + 1]) {
      parsed.pipeline = args[++index];
      continue;
    }
    if (argument === "--from" && args[index + 1]) {
      parsed.source = args[++index];
      continue;
    }
    if (argument === "--to" && args[index + 1]) {
      parsed.target = args[++index];
      continue;
    }
    throw new Error(`Unrecognized or incomplete argument: ${argument}`);
  }
  if (parsed.all && (parsed.pipeline || parsed.source || parsed.target))
    throw new Error(
      "--all cannot be combined with --pipeline, --from, or --to",
    );
  if (!parsed.all && (!parsed.pipeline || !parsed.source || !parsed.target))
    throw new Error(
      "Usage: npm run promote -- --pipeline <name> --from <org> --to <org> [--apply]",
    );
  return parsed;
}

function transitionsBuild(
  config: PromotionConfig,
  args: PromotionArguments,
): PromotionTransition[] {
  if (!args.all) {
    const definition = promotionTransitionValidate(
      config,
      args.pipeline!,
      args.source!,
      args.target!,
    );
    return [
      {
        pipeline: args.pipeline!,
        source: args.source!,
        target: args.target!,
        definition,
      },
    ];
  }
  const transitions: PromotionTransition[] = [];
  for (const [pipeline, definition] of Object.entries(config.pipelines).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (let index = 0; index < definition.orgs.length - 1; index++) {
      const source = definition.orgs[index]!;
      const target = definition.orgs[index + 1]!;
      transitions.push({ pipeline, source, target, definition });
    }
  }
  return transitions;
}

function envValue(content: string, key: string): string | undefined {
  const line = content
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith(`${key}=`));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    return value.slice(1, -1);
  return value || undefined;
}

function tokensParse(): Map<string, string> {
  const configured = process.env.VAPI_PROMOTION_TOKENS;
  if (!configured) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(configured);
  } catch {
    throw new Error("VAPI_PROMOTION_TOKENS must be valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("VAPI_PROMOTION_TOKENS must map org slugs to tokens");
  const tokens = new Map<string, string>();
  for (const [org, token] of Object.entries(raw)) {
    if (typeof token !== "string" || token.length === 0)
      throw new Error(
        `VAPI_PROMOTION_TOKENS entry for ${org} must be a non-empty token string`,
      );
    tokens.set(org, token);
  }
  return tokens;
}

function connectionLoad(
  config: PromotionConfig,
  org: string,
  tokens: Map<string, string>,
): OrgConnection {
  const envPath = resolve(ROOT_DIR, `.env.${org}`);
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const envToken = envValue(envContent, "VAPI_TOKEN");
  const token = tokens.get(org) ?? envToken;
  if (!token)
    throw new Error(
      `Missing token for org ${org}; set VAPI_PROMOTION_TOKENS or .env.${org}`,
    );
  return {
    token,
    baseUrl: config.orgs[org]?.baseUrl ?? envValue(envContent, "VAPI_BASE_URL"),
  };
}

function childRun(
  script: string,
  org: string,
  connection: OrgConnection,
  args: string[],
): void {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    VAPI_TOKEN: connection.token,
  };
  if (connection.baseUrl) environment.VAPI_BASE_URL = connection.baseUrl;
  if (!connection.baseUrl) delete environment.VAPI_BASE_URL;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, org, ...args],
    { cwd: ROOT_DIR, env: environment, stdio: "inherit" },
  );
  if (result.error)
    throw new Error(
      `Failed to run ${script} for ${org}: ${result.error.message}`,
    );
  if (result.status !== 0) throw new Error(`${script} failed for ${org}`);
}

function stateLoad(org: string) {
  const path = resolve(ROOT_DIR, `.vapi-state.${org}.json`);
  if (!existsSync(path))
    throw new Error(
      `Missing state for ${org}; run promotion with --apply to bootstrap bindings first`,
    );
  return promotionStateParse(readFileSync(path, "utf8"));
}

export function promotionApplyArguments(plan: PromotionPlan): string[] {
  const args = ["--resolve=ours"];
  if (plan.changes.some((change) => change.kind === "delete")) {
    args.push("--force");
  }
  if (plan.changes.some((change) => change.kind === "create")) {
    args.push("--allow-new-files");
  }
  args.push(
    ...plan.changes.map(
      (change) => `resources/${plan.target}/${change.path}`,
    ),
  );
  return args;
}

async function transitionRun(
  config: PromotionConfig,
  transition: PromotionTransition,
  apply: boolean,
  tokens: Map<string, string>,
  allowEmptySourceDeletion: boolean,
): Promise<boolean> {
  if (apply) {
    childRun(
      "src/pull.ts",
      transition.source,
      connectionLoad(config, transition.source, tokens),
      ["--bootstrap", "--bindings-only"],
    );
    childRun(
      "src/pull.ts",
      transition.target,
      connectionLoad(config, transition.target, tokens),
      ["--bootstrap", "--bindings-only"],
    );
  }
  const plan = await promotionPlanBuild({
    rootDir: ROOT_DIR,
    source: transition.source,
    target: transition.target,
    patterns: transition.definition.resources,
    sourceState: stateLoad(transition.source),
    targetState: stateLoad(transition.target),
    bindings: config.orgs[transition.target]!.bindings,
    allowEmptySourceDeletion,
  });
  console.log(
    `\n${transition.pipeline}: ${transition.source} → ${transition.target}`,
  );
  for (const change of plan.changes)
    console.log(`  ${change.kind.padEnd(6)} ${change.path}`);
  if (plan.changes.length === 0) console.log("  no changes");
  if (!apply || plan.changes.length === 0) return false;
  await promotionPlanApply(plan);
  childRun(
    "src/apply.ts",
    transition.target,
    connectionLoad(config, transition.target, tokens),
    promotionApplyArguments(plan),
  );
  return plan.changes.some((change) => change.kind === "delete");
}

export async function promotionCommandRun(
  args = process.argv.slice(2),
): Promise<void> {
  const parsed = argumentsParse(args);
  const configPath = resolve(ROOT_DIR, "promotion.yml");
  if (!existsSync(configPath))
    throw new Error("promotion.yml is required at the repository root");
  const config = promotionConfigParse(readFileSync(configPath, "utf8"));
  const tokens = parsed.apply ? tokensParse() : new Map<string, string>();
  delete process.env.VAPI_PROMOTION_TOKENS;
  // Applying a deletion removes the intermediate org's state entry. Carry the
  // reviewed authorization forward so the same deletion can reach later orgs.
  const deletionAuthorizedSources = new Set<string>();
  for (const transition of transitionsBuild(config, parsed)) {
    const sourceKey = `${transition.pipeline}:${transition.source}`;
    const deleted = await transitionRun(
      config,
      transition,
      parsed.apply,
      tokens,
      deletionAuthorizedSources.has(sourceKey),
    );
    if (deleted)
      deletionAuthorizedSources.add(
        `${transition.pipeline}:${transition.target}`,
      );
  }
}

const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  promotionCommandRun().catch((error: unknown) => {
    console.error(
      `❌ Promotion failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
