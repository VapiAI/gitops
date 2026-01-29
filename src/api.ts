import { VAPI_BASE_URL, VAPI_TOKEN } from "./config.ts";
import type { VapiResponse } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client for Vapi API
// ─────────────────────────────────────────────────────────────────────────────

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

    // Handle rate limit with retry
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      console.log(`  ⏳ Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    const errorText = await response.text();
    throw new Error(
      `API ${method} ${endpoint} failed (${response.status}): ${errorText}`
    );
  }

  throw new Error(`API ${method} ${endpoint} failed: max retries exceeded`);
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

    // Handle rate limit with retry
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      console.log(`  ⏳ Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    const errorText = await response.text();
    throw new Error(
      `API DELETE ${endpoint} failed (${response.status}): ${errorText}`
    );
  }

  throw new Error(`API DELETE ${endpoint} failed: max retries exceeded`);
}

