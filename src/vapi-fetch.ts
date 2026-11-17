import type { TokenBucket } from "./rate-limit.ts";
import { userAgentGet, vapiClientGet } from "./user-agent.ts";

export function orgSettingsUrl(baseUrl: string): string {
  return new URL(baseUrl).hostname === "api.eu.vapi.ai"
    ? "https://dashboard.eu.vapi.ai/settings/organization"
    : "https://dashboard.vapi.ai/settings/organization";
}

const warned = new WeakSet<TokenBucket>();

export async function limitedVapiFetch(
  limiter: TokenBucket,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  await limiter.acquire();
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": userAgentGet(),
      "x-vapi-client": vapiClientGet(),
      ...init.headers,
    },
  });
  if (response.status === 429 && !warned.has(limiter)) {
    warned.add(limiter);
    console.warn(
      `⚠️  max GitOps RPM (maxGitopsRpm / VAPI_MAX_GITOPS_RPM) may be configured too high. This is a GitOps client limit, not a Vapi org limit. Compare it with your org-level API rate limit in requests per minute (200 by default): ${orgSettingsUrl(url)}`,
    );
  }
  return response;
}
