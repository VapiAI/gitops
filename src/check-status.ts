// GitHub commit statuses for PR checks. Plain fetch, no dependency.
//
// Per check and target: `Vapi Evals / <check> / <target>`, pending with the
// run link as soon as the run exists, then the verdict. The aggregate
// `Vapi Evals` (a stable, documented name) is what branch protection
// requires: per-target statuses only exist on PRs that touch a check.

export const AGGREGATE_CONTEXT = "Vapi Evals";

export type CommitState = "pending" | "success" | "failure" | "error";

export interface GitHubStatusEnv {
  token: string;
  repo: string;
  sha: string;
  apiUrl: string;
  // The workflow run page, for statuses that cover several runs.
  runUrl?: string;
}

export interface CommitStatus {
  context: string;
  state: CommitState;
  description: string;
  targetUrl?: string;
}

// GitHub caps status descriptions at 140 characters.
const MAX_DESCRIPTION = 140;
const STATE_RANK: Record<CommitState, number> = {
  success: 0,
  pending: 1,
  failure: 2,
  error: 3,
};

export function targetContext(check: string, target: string): string {
  return `${AGGREGATE_CONTEXT} / ${check} / ${target}`;
}

// Statuses post only when all three are set (the PR workflow sets them).
export function githubStatusEnvRead(
  env: NodeJS.ProcessEnv = process.env,
): GitHubStatusEnv | undefined {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !HEAD_SHA) return undefined;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return {
    token: GITHUB_TOKEN,
    repo: GITHUB_REPOSITORY,
    sha: HEAD_SHA,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    runUrl: env.GITHUB_RUN_ID
      ? `${server}/${GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
  };
}

// The worst state wins: error > failure > pending > success.
export function commitStateWorst(states: CommitState[]): CommitState {
  return states.reduce<CommitState>(
    (worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst),
    "success",
  );
}

// Posting a status never fails the check: a read-only token (fork PRs) or a
// GitHub outage only warns. Returns whether the status was accepted.
export async function commitStatusPost(
  env: GitHubStatusEnv,
  status: CommitStatus,
): Promise<boolean> {
  const description =
    status.description.length > MAX_DESCRIPTION
      ? `${status.description.slice(0, MAX_DESCRIPTION - 1)}…`
      : status.description;
  try {
    const response = await fetch(
      `${env.apiUrl}/repos/${env.repo}/statuses/${env.sha}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          context: status.context,
          state: status.state,
          description,
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        }),
      },
    );
    if (response.ok) return true;
    console.warn(
      `  ⚠️  Could not post status "${status.context}" (${response.status}); see the job summary instead`,
    );
  } catch (error) {
    console.warn(
      `  ⚠️  Could not post status "${status.context}": ${(error as Error).message}`,
    );
  }
  return false;
}
