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
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", userAgentGet());
  if (!headers.has("x-vapi-client"))
    headers.set("x-vapi-client", vapiClientGet());
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (response.status === 429 && !warned.has(limiter)) {
    warned.add(limiter);
    console.warn(
      `⚠️  Vapi returned 429 (rate limited) for org ${limiter.org}. maxGitopsRpm is ${limiter.rpm} requests per minute, which may be higher than your org's API rate limit (200 RPM by default). Check it at ${orgSettingsUrl(url)}, then lower maxGitopsRpm in resources/${limiter.org}/.vapi-org.json or set VAPI_MAX_GITOPS_RPM. This is a GitOps client limit, not a Vapi org limit.`,
    );
  }
  return response;
}
