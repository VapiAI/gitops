// The promotion check gate: `orgs.<slug>.check: <name>` in promotion.yml
// names a vapi-checks.yml check that must pass in that org before any
// transition promotes out of it. The gate runs the same check as the PR
// workflow, built from the source org's files at the promoted commit.

import type { CheckDefinition } from "./check-config.ts";
import { CHECKS_CONFIG_FILE, checksConfigLoad } from "./check-config.ts";
import { checkJobsBuild } from "./check-build.ts";
import type { CheckOutcome } from "./check-run.ts";
import { checkRunAll, MIN_START_MS } from "./check-run.ts";
import type { OrgConnection } from "./org-connection.ts";
import type { PromotionConfig } from "./promotion.ts";
import { userAgentGet } from "./user-agent.ts";

export interface PromotionGateResult {
  outcome: CheckOutcome;
  reason: string;
  url?: string;
}

const DEFAULT_BASE_URL = "https://api.vapi.ai";
const OUTCOME_RANK: Record<CheckOutcome, number> = {
  passed: 0,
  built: 0,
  incomplete: 1,
  failed: 2,
  error: 3,
};

// The gated orgs' checks, validated up front so a typo fails before any
// transition applies.
export function promotionChecksLoad(
  rootDir: string,
  config: PromotionConfig,
): Map<string, CheckDefinition> {
  const gated = Object.entries(config.orgs).filter(([, org]) => org.check);
  const checks = new Map<string, CheckDefinition>();
  if (gated.length === 0) return checks;
  const checksConfig = checksConfigLoad(rootDir);
  if (!checksConfig)
    throw new Error(
      `promotion.yml gates ${gated.map(([slug]) => slug).join(", ")} on checks, but there is no ${CHECKS_CONFIG_FILE}`,
    );
  for (const [slug, org] of gated) {
    const check = checksConfig.checks[org.check!];
    if (!check)
      throw new Error(
        `orgs.${slug}.check: no check named ${org.check} in ${CHECKS_CONFIG_FILE}`,
      );
    if (check.org !== slug || check.runOrg !== slug)
      throw new Error(
        `orgs.${slug}.check: check ${check.name} must read and run in ${slug} (it reads ${check.org} and runs in ${check.runOrg})`,
      );
    checks.set(slug, check);
  }
  return checks;
}

// The plan-only line: what the gate would run, built offline.
export async function promotionGatePlanLine(
  rootDir: string,
  check: CheckDefinition,
): Promise<string> {
  const jobs = await checkJobsBuild(rootDir, check);
  const broken = jobs.find((job) => !job.result.body);
  if (broken)
    return `  check  would run ${check.name} in ${check.org}, but its payload doesn't build: ${broken.result.errors[0]}`;
  const simulations = jobs[0]?.result.body?.simulations.length ?? 0;
  return `  check  would run ${check.name} in ${check.org} (${simulations} simulation${simulations === 1 ? "" : "s"} × ${jobs.length} target${jobs.length === 1 ? "" : "s"})`;
}

// Run the check live in the source org and reduce it to one result: the
// worst target wins, so anything short of every target passing blocks.
export async function promotionGateRun(
  rootDir: string,
  check: CheckDefinition,
  connection: OrgConnection,
): Promise<PromotionGateResult> {
  const jobs = await checkJobsBuild(rootDir, check);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const results = await checkRunAll({
      jobs,
      connectionFor: () => ({
        token: connection.token,
        baseUrl: check.baseUrl ?? connection.baseUrl ?? DEFAULT_BASE_URL,
        userAgent: userAgentGet("check"),
      }),
      deadline: Date.now() + check.timeoutMinutes * 60_000 + MIN_START_MS,
      signal: controller.signal,
    });
    const worst = results.reduce((a, b) =>
      OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a,
    );
    for (const result of results)
      console.log(
        `  check  ${result.job.label}: ${result.outcome} — ${result.reason}${result.url ? ` (${result.url})` : ""}`,
      );
    return { outcome: worst.outcome, reason: worst.reason, url: worst.url };
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
