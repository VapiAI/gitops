// CLI entry: `npm run sim -- <org> --suite <name> --target <name>`
//
// Wraps `POST /eval/simulation/run` (the simulations API). See AGENTS.md for
// usage.
//
// Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 incomplete
// (timed out, interrupted, canceled, or results that never fully arrived).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSummary,
  loadEnvFile,
  loadStateFile,
  resolveSelection,
  resolveTarget,
  runSimulation,
} from "./sim.ts";

const USAGE = [
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
  "  --timeout <minutes>    Give up and cancel the run after this long (default: 20)",
  "  --no-watch             Start the run, print its link, and exit 0 without a verdict",
  "",
  "Exit codes: 0 passed, 1 failed, 2 usage error, 3 incomplete (timeout, interrupt, missing results)",
  "",
  "Examples:",
  "  npm run sim -- my-org --suite booking-tests --target intake-agent",
  "  npm run sim -- my-org --simulations happy-path,edge-case --target main-agent --transport chat",
].join("\n");

class UsageError extends Error {}

interface ParsedArgs {
  env: string;
  suite?: string;
  simulations?: string;
  assistant?: string;
  squad?: string;
  transport?: "voice" | "chat";
  iterations?: number;
  timeoutMinutes?: number;
  watch: boolean;
  help: boolean;
}

function argsParse(args: string[]): ParsedArgs {
  const env = args[0];
  if (!env || env === "--help" || env === "-h") {
    return { env: env ?? "", watch: true, help: true };
  }
  const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!SLUG_RE.test(env)) throw new UsageError(`Invalid org name: ${env}`);

  const parsed: ParsedArgs = { env, watch: true, help: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--suite") parsed.suite = args[++i];
    else if (arg === "--simulations") parsed.simulations = args[++i];
    else if (arg === "--target") {
      // We don't know yet whether target is an assistant or squad — defer
      // resolution to the state lookup (see simCommandRun).
      parsed.assistant = args[++i];
    } else if (arg === "--assistant") parsed.assistant = args[++i];
    else if (arg === "--squad") parsed.squad = args[++i];
    else if (arg === "--transport") {
      const v = args[++i];
      if (v !== "voice" && v !== "chat") {
        throw new UsageError(
          `--transport must be "voice" or "chat" (got "${v}")`,
        );
      }
      parsed.transport = v;
    } else if (arg === "--iterations") {
      parsed.iterations = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isNaN(parsed.iterations)) {
        throw new UsageError("--iterations requires a number");
      }
    } else if (arg === "--timeout") {
      parsed.timeoutMinutes = Number(args[++i]);
      if (
        !Number.isFinite(parsed.timeoutMinutes) ||
        parsed.timeoutMinutes <= 0
      ) {
        throw new UsageError("--timeout requires a positive number of minutes");
      }
    } else if (arg === "--no-watch") parsed.watch = false;
    else if (arg === "--watch") parsed.watch = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return parsed;
}

export async function simCommandRun(
  args = process.argv.slice(2),
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = argsParse(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`❌ ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return parsed.env ? 0 : 2;
  }

  const cfg = loadEnvFile(parsed.env);
  const state = loadStateFile(parsed.env);

  // Disambiguate --target: if the bare value matches a squad name in state
  // and not an assistant, treat it as a squad. Explicit --assistant / --squad
  // override the heuristic.
  let assistant = parsed.assistant;
  let squad = parsed.squad;
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
  console.log(`🧪 Vapi GitOps Sim Runner — Environment: ${parsed.env}`);
  console.log(`   API: ${cfg.baseUrl}`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  const selection = resolveSelection(state, {
    suite: parsed.suite,
    simulations: parsed.simulations,
  });
  const target = resolveTarget(state, { assistant, squad });

  // Ctrl-C / SIGTERM cancel the run instead of leaving it running unwatched.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let summary;
  try {
    summary = await runSimulation(cfg, selection, target, {
      watch: parsed.watch,
      iterations: parsed.iterations,
      transport: parsed.transport,
      timeoutMs:
        parsed.timeoutMinutes === undefined
          ? undefined
          : parsed.timeoutMinutes * 60_000,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  console.log(`\n${formatSummary(summary)}\n`);
  if (!summary.verdict) {
    console.log("▶️  Run started (not watched).");
    return 0;
  }
  if (summary.verdict.status === "passed") {
    console.log("✅ Simulation run passed.");
    return 0;
  }
  if (summary.verdict.status === "failed") {
    console.error(`❌ Simulation run failed: ${summary.verdict.reason}`);
    return 1;
  }
  console.error(`⚠️  Simulation run incomplete: ${summary.verdict.reason}`);
  return 3;
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  simCommandRun().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        "\n❌ Sim failed:",
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 2;
    },
  );
}
