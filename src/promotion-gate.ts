// The promotion check gate: `orgs.<slug>.check: <name>` in promotion.yml
// names a vapi-checks.yml check that must pass in that org before any
// transition promotes out of it. The gate runs the same check as the PR
// workflow, built from the source org's files at the promoted commit.

import type { CheckDefinition } from "./check-config.ts";
import { CHECKS_CONFIG_FILE, checksConfigLoad } from "./check-config.ts";
import { checkJobsBuild } from "./check-build.ts";
import type { CheckOutcome, CheckTargetResult } from "./check-run.ts";
import { checkRunAll, MAX_CONCURRENT, MIN_START_MS } from "./check-run.ts";
import type { OrgConnection } from "./org-connection.ts";
import type { PromotionConfig } from "./promotion.ts";
import { userAgentGet } from "./user-agent.ts";

export interface PromotionGateResult {
  outcome: CheckOutcome;
  reason: string;
  url?: string;
}

const DEFAULT_BASE_URL = "https://api.vapi.ai";
// Gate checks must fit well inside the promotion step's timeout, so a check
// that can't finish is rejected when the config loads, not killed mid-run.
export const GATE_BUDGET_MINUTES = 300;
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
  // An org that is last in every pipeline is never promoted out of.
  const sources = new Set(
    Object.values(config.pipelines).flatMap((pipeline) =>
      pipeline.orgs.slice(0, -1),
    ),
  );
  let budgetMinutes = 0;
  for (const [slug, org] of gated) {
    if (!sources.has(slug))
      throw new Error(
        `orgs.${slug}.check: nothing is promoted out of ${slug} (it is last in every pipeline), so this check would never run; gate the org before it instead`,
      );
    const check = checksConfig.checks[org.check!];
    if (!check)
      throw new Error(
        `orgs.${slug}.check: no check named ${org.check} in ${CHECKS_CONFIG_FILE}`,
      );
    if (check.org !== slug || check.runOrg !== slug)
      throw new Error(
        `orgs.${slug}.check: check ${check.name} must read and run in ${slug} (it reads ${check.org} and runs in ${check.runOrg})`,
      );
    // A gate runs in the real org, never a CI org, so it must not reach real
    // systems: no live tools, and no webhooks to the org's own servers.
    if (check.toolMocks === "off")
      throw new Error(
        `orgs.${slug}.check: check ${check.name} sets toolMocks: off, which runs real tools; a gate runs in ${slug} itself, so it must use toolMocks: strict`,
      );
    if (!check.stripWebhooks)
      throw new Error(
        `orgs.${slug}.check: check ${check.name} sets stripWebhooks: false, which sends simulated calls' webhooks to ${slug}'s real servers; a gate must keep the default`,
      );
    // The org's token goes only to the host promotion uses for that org.
    if (check.baseUrl && check.baseUrl !== org.baseUrl?.replace(/\/+$/, ""))
      throw new Error(
        `orgs.${slug}.check: check ${check.name} uses ${check.baseUrl}, but promotion.yml uses ${org.baseUrl ?? "the default API"} for ${slug}; set the same baseUrl in both`,
      );
    budgetMinutes += gateBudgetMinutes(check);
    checks.set(slug, check);
  }
  if (budgetMinutes > GATE_BUDGET_MINUTES)
    throw new Error(
      `promotion.yml's gated checks can take up to ${budgetMinutes} minutes in one run, more than the ${GATE_BUDGET_MINUTES} the promotion step allows; lower their timeoutMinutes or targets`,
    );
  return checks;
}

// The longest a gate check can run: targets run MAX_CONCURRENT at a time,
// and each batch gets a full timeoutMinutes.
export function gateBudgetMinutes(
  check: Pick<CheckDefinition, "timeoutMinutes"> & {
    targets: readonly unknown[];
  },
): number {
  return (
    Math.ceil(check.targets.length / MAX_CONCURRENT) * check.timeoutMinutes +
    MIN_START_MS / 60_000
  );
}

export function gateDeadline(
  check: Pick<CheckDefinition, "timeoutMinutes"> & {
    targets: readonly unknown[];
  },
  now: number,
): number {
  return now + gateBudgetMinutes(check) * 60_000;
}

// Anything short of every target passing blocks: the worst target wins.
export function gateResultReduce(
  results: Array<Pick<CheckTargetResult, "outcome" | "reason" | "url">>,
): PromotionGateResult {
  const worst = results.reduce((a, b) =>
    OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a,
  );
  return { outcome: worst.outcome, reason: worst.reason, url: worst.url };
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
        baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
        // Gate runs are counted apart from PR check runs.
        userAgent: userAgentGet("promote"),
      }),
      deadline: gateDeadline(check, Date.now()),
      signal: controller.signal,
    });
    for (const result of results)
      console.log(
        `  check  ${result.job.label}: ${result.outcome} — ${result.reason}${result.url ? ` (${result.url})` : ""}`,
      );
    return gateResultReduce(results);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
