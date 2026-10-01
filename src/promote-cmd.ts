import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrgConnection } from "./org-connection.ts";
import { childRun, connectionLoad, tokensParse } from "./org-connection.ts";
import type { PromotionConfig, PromotionPipeline } from "./promotion.ts";
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

const TOKENS_ENV = "VAPI_PROMOTION_TOKENS";

function orgConnection(
  config: PromotionConfig,
  org: string,
  tokens: Map<string, string>,
): OrgConnection {
  return connectionLoad({
    rootDir: ROOT_DIR,
    org,
    tokens,
    tokensEnvName: TOKENS_ENV,
    baseUrl: config.orgs[org]?.baseUrl,
  });
}

function orgScriptRun(
  script: string,
  org: string,
  connection: OrgConnection,
  args: string[],
): void {
  childRun({ rootDir: ROOT_DIR, script, org, connection, args });
}

function stateLoad(org: string) {
  const path = resolve(ROOT_DIR, `.vapi-state.${org}.json`);
  if (!existsSync(path))
    throw new Error(
      `Missing state for ${org}; run promotion with --apply to bootstrap bindings first`,
    );
  return promotionStateParse(readFileSync(path, "utf8"));
}

async function transitionRun(
  config: PromotionConfig,
  transition: PromotionTransition,
  apply: boolean,
  tokens: Map<string, string>,
  allowEmptySourceDeletion: boolean,
): Promise<boolean> {
  if (apply) {
    orgScriptRun(
      "src/pull.ts",
      transition.source,
      orgConnection(config, transition.source, tokens),
      ["--bootstrap", "--bindings-only"],
    );
    orgScriptRun(
      "src/pull.ts",
      transition.target,
      orgConnection(config, transition.target, tokens),
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
  const changedPaths = plan.changes.map(
    (change) => `resources/${transition.target}/${change.path}`,
  );
  orgScriptRun(
    "src/apply.ts",
    transition.target,
    orgConnection(config, transition.target, tokens),
    ["--force", "--allow-new-files", "--resolve=ours", ...changedPaths],
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
  const tokens = parsed.apply
    ? tokensParse(TOKENS_ENV)
    : new Map<string, string>();
  delete process.env[TOKENS_ENV];
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
