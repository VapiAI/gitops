// CLI entry: `npm run validate -- <org>`
//
// Loads the same resource shape as `push.ts` would (so the validator runs
// against exactly what would ship), then runs all client-side validators
// and prints findings. Exit code 0 if no errors, 1 if any error-severity
// finding is present.

import { resolve } from "path";
import { fileURLToPath } from "url";
import { VAPI_BASE_URL, VAPI_ENV } from "./config.ts";
import { loadResources } from "./resources.ts";
import type { LoadedResources } from "./types.ts";
import { summarizeFindings, validateResources } from "./validate.ts";

async function main(): Promise<void> {
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🔎 Vapi GitOps Validate - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  console.log("📂 Loading resources...\n");
  const resources: LoadedResources = {
    tools: await loadResources("tools"),
    structuredOutputs: await loadResources("structuredOutputs"),
    assistants: await loadResources("assistants"),
    squads: await loadResources("squads"),
    personalities: await loadResources("personalities"),
    scenarios: await loadResources("scenarios"),
    simulations: await loadResources("simulations"),
    simulationSuites: await loadResources("simulationSuites"),
    evals: await loadResources("evals"),
  };

  const findings = validateResources(resources);
  console.log(`\n${summarizeFindings(findings)}\n`);

  const errorCount = findings.filter((f) => f.severity === "error").length;
  if (errorCount > 0) {
    console.error(
      `❌ Validation failed with ${errorCount} error(s). Fix the issues above before pushing.`,
    );
    process.exit(1);
  }
  console.log("✅ Validation passed.");
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(
      "\n❌ Validation failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
