// User-Agent for the API requests this tool makes, so simulation runs started
// from gitops can be told apart in the platform's analytics.
//
// Config-free on purpose (like api-key.ts): importing config.ts would parse
// argv and exit, which breaks importing this from sim.ts and tests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

function packageVersionRead(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(PACKAGE_JSON_PATH, "utf-8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof parsed.version === "string"
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through: a missing or unreadable package.json must never block
    // an API request.
  }
  return "unknown";
}

export function userAgentGet(product: "sim" | "check"): string {
  return `vapi-gitops-${product}/${packageVersionRead()}`;
}
