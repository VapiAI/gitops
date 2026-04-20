import { VAPI_BASE_URL, VAPI_TOKEN } from "./config.ts";
import type { VapiResponse } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client for Vapi API
// ─────────────────────────────────────────────────────────────────────────────

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

function parseApiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string") return parsed.message;
    if (Array.isArray(parsed.message)) return parsed.message.join("; ");
  } catch { /* not JSON, use raw body */ }
  return body;
}

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 2000;
const REQUEST_DELAY_MS = 700; // Delay between requests to avoid rate limits

let lastRequestTime = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
}

// 429 = rate limit. 5xx = transient server error (gateway timeout, upstream
// hiccup, deploy in progress). Both are worth retrying with backoff; surfacing
// a 502 as a hard failure forces the operator to re-run the entire push.
function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export async function vapiRequest<T = VapiResponse>(
  method: "POST" | "PATCH",
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${VAPI_BASE_URL}${endpoint}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VAPI_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response.json() as Promise<T>;
    }

    if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      const reason = response.status === 429 ? "Rate limited" : `Server error ${response.status}`;
      console.log(`  ⏳ ${reason}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    const errorText = await response.text();
    throw new VapiApiError(method, endpoint, response.status, parseApiMessage(errorText), errorText);
  }

  throw new VapiApiError(method, endpoint, 429, "max retries exceeded", "");
}

export async function vapiDelete(endpoint: string): Promise<void> {
  const url = `${VAPI_BASE_URL}${endpoint}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${VAPI_TOKEN}`,
      },
    });

    if (response.ok) {
      return;
    }

    if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      const reason = response.status === 429 ? "Rate limited" : `Server error ${response.status}`;
      console.log(`  ⏳ ${reason}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    const errorText = await response.text();
    throw new VapiApiError("DELETE", endpoint, response.status, parseApiMessage(errorText), errorText);
  }

  throw new VapiApiError("DELETE", endpoint, 429, "max retries exceeded", "");
}

