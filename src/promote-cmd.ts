import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

// Files that transitions which finished applying left changed, one
// `<blob>\t<path>` line each: the content as it stood when that transition
// finished, stored in git's object store (`-` for a deleted file). When a
// later transition fails, the promotion workflow commits exactly these blobs
// (plus state) and discards everything else, so git records what reached the
// platform — even if the failed transition rewrote one of the same files.
export const APPLIED_PATHS_FILE = "tmp/promotion-applied.txt";

export interface PromotionDeps {
  childRun: typeof orgScriptRun;
}

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

// The paths git reports changed under resources/<org>/, including new and
// deleted files. Read from git rather than the plan because apply's pull and
// push can rewrite files the plan didn't name.
function changedPathsRead(org: string): string[] {
  const output = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      `resources/${org}`,
    ],
    { cwd: ROOT_DIR, encoding: "utf8" },
  );
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its original path.
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

// The content a path has right now, written to git's object store so it
// survives later rewrites; "-" when the path no longer exists.
function blobWrite(path: string): string {
  if (!existsSync(resolve(ROOT_DIR, path))) return "-";
  return execFileSync("git", ["hash-object", "-w", "--", path], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
}

function appliedPathsRecord(org: string): void {
  const file = resolve(ROOT_DIR, APPLIED_PATHS_FILE);
  // path → blob; a later successful transition's snapshot replaces an
  // earlier one for the same path.
  const recorded = new Map<string, string>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) recorded.set(line.slice(tab + 1), line.slice(0, tab));
    }
  try {
    for (const path of changedPathsRead(org))
      recorded.set(path, blobWrite(path));
  } catch (error) {
    // The org already has these changes, so carrying on would let the commit
    // step save its state without its files: the drift this record prevents.
    throw new Error(
      `Applied to ${org}, but couldn't record its changed files (${error instanceof Error ? error.message : String(error)}). Stopping: the state committed for ${org} won't have its files, so reconcile resources/${org}/ by hand with npm run pull -- ${org}.`,
    );
  }
  const lines = [...recorded].map(([path, blob]) => `${blob}\t${path}`);
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
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
  deps: PromotionDeps,
): Promise<boolean> {
  const run = deps.childRun;
  if (apply) {
    run(
      "src/pull.ts",
      transition.source,
      orgConnection(config, transition.source, tokens),
      ["--bootstrap", "--bindings-only"],
    );
    run(
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
  run(
    "src/apply.ts",
    transition.target,
    orgConnection(config, transition.target, tokens),
    ["--force", "--allow-new-files", "--resolve=ours", ...changedPaths],
  );
  appliedPathsRecord(transition.target);
  return plan.changes.some((change) => change.kind === "delete");
}

export async function promotionCommandRun(
  args = process.argv.slice(2),
  deps: PromotionDeps = { childRun: orgScriptRun },
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
  if (parsed.apply) {
    const file = resolve(ROOT_DIR, APPLIED_PATHS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
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
      deps,
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
