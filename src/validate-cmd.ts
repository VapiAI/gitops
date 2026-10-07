// CLI entry: `npm run validate -- <org>`
//
// Loads the same resource shape as `push.ts` would (so the validator runs
// against exactly what would ship), then runs all client-side validators
// and prints findings. Exit code 0 if no errors, 1 if any error-severity
// finding is present.

import { existsSync } from "fs";
import { relative, resolve } from "path";
import { fileURLToPath } from "url";
import {
  BASE_DIR,
  loadIgnorePatterns,
  STATE_FILE_PATH,
  VAPI_ENV,
} from "./config.ts";
import { loadResources } from "./resources.ts";
import { createEmptyState, loadState } from "./state.ts";
import type { LoadedResources, ResourceType } from "./types.ts";
import {
  findingAnnotation,
  summarizeFindings,
  validateNoIgnoredReferences,
  validateResources,
} from "./validate.ts";
import { validateReferences } from "./validate-refs.ts";

async function main(): Promise<void> {
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🔎 Vapi GitOps Validate - Environment: ${VAPI_ENV}`);
  console.log("   Offline: no API calls");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  console.log("📂 Loading resources...\n");
  // Ignored files are skipped, as push skips them: they're never deployed.
  const ignorePatterns = loadIgnorePatterns();
  const load = (type: ResourceType) =>
    loadResources<Record<string, unknown>>(type, { ignorePatterns });
  const resources: LoadedResources = {
    tools: await load("tools"),
    structuredOutputs: await load("structuredOutputs"),
    assistants: await load("assistants"),
    squads: await load("squads"),
    personalities: await load("personalities"),
    scenarios: await load("scenarios"),
    simulations: await load("simulations"),
    simulationSuites: await load("simulationSuites"),
    evals: await load("evals"),
  };

  // References resolve through the committed state file, as they do on push.
  const stateExists = existsSync(STATE_FILE_PATH);
  if (!stateExists)
    console.log("📄 No state file yet: references must name local files.");
  const state = stateExists ? loadState() : createEmptyState();
  const findings = [
    ...validateResources(resources),
    ...validateNoIgnoredReferences(resources, ignorePatterns),
    ...validateReferences({
      loaded: resources,
      org: VAPI_ENV,
      state,
      ignorePatterns,
    }),
  ];
  console.log(`\n${summarizeFindings(findings)}\n`);

  if (process.env.GITHUB_ACTIONS === "true") {
    for (const finding of findings) {
      const file = resources[finding.type].find(
        (r) => r.resourceId === finding.resourceId,
      )?.filePath;
      console.log(findingAnnotation(finding, file && relative(BASE_DIR, file)));
    }
  }

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
