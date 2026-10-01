// Config-free HTTP client for the Vapi API.
//
// api.ts is the engine's client, but it imports config.ts, which parses
// argv and exits at import time and binds a single org. Code that must run
// for several orgs, without a token, or from tests (sim.ts, the check
// runner) uses this client instead.

export interface VapiConnection {
  token: string;
  baseUrl: string;
  userAgent: string;
}

// "transient": retry 429 and 5xx. "rate-limit-only": retry 429 only — for
// requests that aren't safe to repeat after a 5xx, because the server may
// have acted before failing (creating a simulation run queues paid work).
export type VapiRetryPolicy = "transient" | "rate-limit-only" | "none";

export interface VapiFetchOptions {
  retry?: VapiRetryPolicy;
  maxRetries?: number;
  initialDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class VapiApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly endpoint: string,
    public readonly statusCode: number,
    public readonly apiMessage: string,
    public readonly rawBody: string,
  ) {
    super(`API ${method} ${endpoint} failed (${statusCode}): ${apiMessage}`);
    this.name = "VapiApiError";
  }
}

export function parseApiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string") return parsed.message;
    if (Array.isArray(parsed.message)) return parsed.message.join("; ");
  } catch {
    /* not JSON, use raw body */
  }
  return body;
}

// 429 = rate limit. 5xx = transient server error (gateway timeout, upstream
// hiccup, deploy in progress).
export function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export const MAX_RETRIES = 5;
export const INITIAL_DELAY_MS = 2000;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(policy: VapiRetryPolicy, status: number): boolean {
  if (policy === "none") return false;
  if (policy === "rate-limit-only") return status === 429;
  return shouldRetry(status);
}

export async function vapiFetchJson<T>(
  connection: VapiConnection,
  method: "GET" | "POST" | "PATCH",
  endpoint: string,
  body?: unknown,
  options: VapiFetchOptions = {},
): Promise<T> {
  const policy = options.retry ?? "transient";
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
  const sleep = options.sleep ?? sleepDefault;

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${connection.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
        "User-Agent": connection.userAgent,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    }
    if (attempt < maxRetries && retryable(policy, response.status)) {
      await sleep(initialDelayMs * 2 ** attempt);
      continue;
    }
    const rawBody = await response.text();
    throw new VapiApiError(
      method,
      endpoint,
      response.status,
      parseApiMessage(rawBody),
      rawBody,
    );
  }
}
