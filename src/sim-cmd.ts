// CLI entry: `npm run sim -- <org> --suite <name> --target <name>`
//
// Distinct from `npm run eval` (legacy /evals endpoint). See AGENTS.md and
// improvements.md #16 for the rationale.

import {
  formatSummary,
  loadEnvFile,
  loadStateFile,
  resolveSelection,
  resolveTarget,
  runSimulation,
} from "./sim.ts";

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  npm run sim -- <org> --suite <suite-name> --target <assistant-or-squad-name>",
      "  npm run sim -- <org> --simulations <name1>,<name2> --target <assistant-name>",
      "",
      "Options:",
      "  --suite <name>         Run an entire simulation suite by local resource name",
      "  --simulations <list>   Run one or more simulations by comma-separated local names",
      "  --target <name>        Local assistant or squad name (resolves to UUID via state)",
      "  --transport voice|chat Transport (default: voice; chat is faster/cheaper)",
      "  --iterations N         Override default iteration count",
      "  --watch                Tail status until completion (default: on)",
      "",
      "Examples:",
      "  npm run sim -- my-org --suite booking-tests --target intake-agent",
      "  npm run sim -- my-org --simulations happy-path,edge-case --target main-agent --transport chat",
    ].join("\n"),
  );
}

interface ParsedArgs {
  env: string;
  suite?: string;
  simulations?: string;
  assistant?: string;
  squad?: string;
  transport?: "voice" | "chat";
  iterations?: number;
  watch: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const env = args[0];
  if (!env) {
    printUsage();
    process.exit(1);
  }
  const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!SLUG_RE.test(env)) {
    console.error(`❌ Invalid org name: ${env}`);
    process.exit(1);
  }

  const parsed: ParsedArgs = { env, watch: true };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--suite") parsed.suite = args[++i];
    else if (arg === "--simulations") parsed.simulations = args[++i];
    else if (arg === "--target") {
      // We don't know yet whether target is an assistant or squad — defer
      // resolution to the state lookup. Try assistant first; resolveTarget()
      // accepts either argument key, so we set the candidate in `assistant`
      // and let `resolveTarget` fall through to `squad` if not found.
      // For clarity, we accept --assistant / --squad as explicit alternatives.
      parsed.assistant = args[++i];
    } else if (arg === "--assistant") parsed.assistant = args[++i];
    else if (arg === "--squad") parsed.squad = args[++i];
    else if (arg === "--transport") {
      const v = args[++i];
      if (v === "voice" || v === "chat") parsed.transport = v;
      else {
        console.error(`❌ --transport must be "voice" or "chat" (got "${v}")`);
        process.exit(1);
      }
    } else if (arg === "--iterations") {
      parsed.iterations = parseInt(args[++i] ?? "", 10);
      if (Number.isNaN(parsed.iterations)) {
        console.error("❌ --iterations requires a number");
        process.exit(1);
      }
    } else if (arg === "--no-watch") parsed.watch = false;
    else if (arg === "--watch") parsed.watch = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadEnvFile(args.env);
  const state = loadStateFile(args.env);

  // Disambiguate --target: if the bare value matches a squad name in state
  // and not an assistant, treat it as a squad. Explicit --assistant / --squad
  // override the heuristic.
  let assistant = args.assistant;
  let squad = args.squad;
  if (assistant && !squad) {
    const isSquad =
      typeof state.squads[assistant] !== "undefined" &&
      typeof state.assistants[assistant] === "undefined";
    if (isSquad) {
      squad = assistant;
      assistant = undefined;
    }
  }

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🧪 Vapi GitOps Sim Runner — Environment: ${args.env}`);
  console.log(`   API: ${cfg.baseUrl}`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  const selection = resolveSelection(state, {
    suite: args.suite,
    simulations: args.simulations,
  });
  const target = resolveTarget(state, { assistant, squad });

  const summary = await runSimulation(cfg, selection, target, {
    watch: args.watch,
    iterations: args.iterations,
    transport: args.transport,
  });

  console.log(`\n${formatSummary(summary)}\n`);

  if (summary.fail > 0) {
    console.error(
      `❌ Simulation run failed (${summary.fail} fail / ${summary.pass} pass)`,
    );
    process.exit(1);
  }
  console.log("✅ Simulation run passed.");
}

main().catch((error) => {
  console.error("\n❌ Sim failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
