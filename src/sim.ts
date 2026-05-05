// Simulation runner — wraps `POST /eval/simulation/run`.
//
// Designed to be importable from `sim-cmd.ts` and from tests without
// triggering the CLI argument parser in `config.ts`. Mirrors the env-loading
// pattern used by `eval.ts` (lines 100-130) for the same reason.

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { StateFile } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

export interface SimEnv {
  env: string;
  token: string;
  baseUrl: string;
}

export interface SimTarget {
  type: "assistant" | "squad";
  id: string;             // platform UUID
  resourceName: string;   // local-name resolved from state
}

export interface SimSelection {
  // Either a suite (one entry, type "simulationSuite") or a list of
  // simulations (multiple entries, each type "simulation").
  entries: Array<
    | { type: "simulationSuite"; simulationSuiteId: string }
    | { type: "simulation"; simulationId: string }
  >;
  label: string; // human-friendly summary, e.g. "suite booking-tests" or "simulations a, b"
}

export interface SimRunOptions {
  watch?: boolean;
  iterations?: number;
  transport?: "voice" | "chat";
}

export interface SimRunSummary {
  runId: string;
  status: string;
  pass: number;
  fail: number;
  skipped: number;
  durationMs: number;
}

export function loadEnvFile(env: string): SimEnv {
  const envFiles = [
    join(BASE_DIR, `.env.${env}`),
    join(BASE_DIR, `.env.${env}.local`),
    join(BASE_DIR, ".env.local"),
  ];
  const envVars: Record<string, string> = {};
  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (envVars[key] === undefined) envVars[key] = value;
    }
  }
  const token = process.env.VAPI_TOKEN || envVars.VAPI_TOKEN;
  const baseUrl =
    process.env.VAPI_BASE_URL ||
    envVars.VAPI_BASE_URL ||
    "https://api.vapi.ai";
  if (!token) {
    throw new Error(
      `VAPI_TOKEN not found. Create .env.${env} with VAPI_TOKEN=your-token`,
    );
  }
  return { env, token, baseUrl };
}

export function loadStateFile(env: string): StateFile {
  const stateFile = join(BASE_DIR, `.vapi-state.${env}.json`);
  if (!existsSync(stateFile)) {
    throw new Error(
      `State file not found: .vapi-state.${env}.json. Run 'npm run pull -- ${env} --bootstrap' first.`,
    );
  }
  const state = JSON.parse(readFileSync(stateFile, "utf-8")) as StateFile;
  // Forward-compat: if a future state schema (Stack F) wraps strings as
  // {uuid: string}, surface the .uuid field; otherwise treat values as the
  // legacy bare string. The local function below handles both shapes.
  return state;
}

// Resolve a local resource name → platform UUID. Stack F migrates state
// values to ResourceState, so this helper accepts both shapes (string OR
// {uuid: string}) and returns just the UUID. Until F lands, it short-circuits
// on the string case.
function stateValueToUuid(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { uuid?: unknown }).uuid === "string"
  ) {
    return (value as { uuid: string }).uuid;
  }
  return undefined;
}

export function resolveTarget(
  state: StateFile,
  args: { assistant?: string; squad?: string },
): SimTarget {
  if (args.assistant && args.squad) {
    throw new Error("Specify --target as an assistant OR a squad, not both");
  }
  if (args.assistant) {
    const id = stateValueToUuid((state.assistants as Record<string, unknown>)[args.assistant]);
    if (!id) {
      throw new Error(
        `Assistant "${args.assistant}" not found in state. Run 'npm run pull -- ${"<env>"}' or check the resource name.`,
      );
    }
    return { type: "assistant", id, resourceName: args.assistant };
  }
  if (args.squad) {
    const id = stateValueToUuid((state.squads as Record<string, unknown>)[args.squad]);
    if (!id) {
      throw new Error(
        `Squad "${args.squad}" not found in state. Run 'npm run pull -- ${"<env>"}' or check the resource name.`,
      );
    }
    return { type: "squad", id, resourceName: args.squad };
  }
  throw new Error("Must specify --target <assistant-or-squad-name>");
}

export function resolveSelection(
  state: StateFile,
  args: { suite?: string; simulations?: string },
): SimSelection {
  if (args.suite && args.simulations) {
    throw new Error("Specify --suite OR --simulations, not both");
  }
  if (args.suite) {
    const id = stateValueToUuid(
      (state.simulationSuites as Record<string, unknown>)[args.suite],
    );
    if (!id) {
      throw new Error(
        `Simulation suite "${args.suite}" not found in state. Push the suite first or check the name.`,
      );
    }
    return {
      entries: [{ type: "simulationSuite", simulationSuiteId: id }],
      label: `suite ${args.suite}`,
    };
  }
  if (args.simulations) {
    const names = args.simulations.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error("--simulations requires at least one comma-separated simulation name");
    }
    const entries: SimSelection["entries"] = [];
    for (const name of names) {
      const id = stateValueToUuid(
        (state.simulations as Record<string, unknown>)[name],
      );
      if (!id) {
        throw new Error(
          `Simulation "${name}" not found in state. Push first or check the name.`,
        );
      }
      entries.push({ type: "simulation", simulationId: id });
    }
    return { entries, label: `simulations ${names.join(", ")}` };
  }
  throw new Error("Must specify --suite <name> or --simulations <name1,name2>");
}

interface SimRunResponse {
  id?: string;
  evalRunId?: string;
  status?: string;
  results?: Array<{ status?: string; isSkipped?: boolean }>;
  endedReason?: string;
  endedMessage?: string;
  cost?: number;
  [key: string]: unknown;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 600_000;

async function fetchJson(
  cfg: SimEnv,
  method: "GET" | "POST",
  endpoint: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${cfg.baseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${method} ${endpoint} → ${response.status}: ${text}`);
  }
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runSimulation(
  cfg: SimEnv,
  selection: SimSelection,
  target: SimTarget,
  options: SimRunOptions = {},
): Promise<SimRunSummary> {
  const body: Record<string, unknown> = {
    simulations: selection.entries,
    target: target.type === "assistant"
      ? { type: "assistant", assistantId: target.id }
      : { type: "squad", squadId: target.id },
    transport: {
      provider:
        options.transport === "chat" ? "vapi.webchat" : "vapi.websocket",
    },
  };
  if (options.iterations !== undefined) body.iterations = options.iterations;

  console.log(
    `🧪 Starting simulation run — ${selection.label} → ${target.type}/${target.resourceName}`,
  );
  const start = Date.now();
  const created = (await fetchJson(
    cfg,
    "POST",
    "/eval/simulation/run",
    body,
  )) as SimRunResponse;
  const runId = created.evalRunId ?? created.id;
  if (!runId) {
    throw new Error(
      `POST /eval/simulation/run returned no runId (keys: ${Object.keys(created).join(", ")})`,
    );
  }
  console.log(`   Run ID: ${runId}`);

  let last: SimRunResponse = created;
  if (options.watch ?? true) {
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      last = (await fetchJson(
        cfg,
        "GET",
        `/eval/simulation/run/${runId}`,
      )) as SimRunResponse;
      const status = last.status ?? "running";
      process.stdout.write(`\r   Status: ${status}     `);
      if (status === "ended" || status === "failed" || status === "completed") {
        process.stdout.write("\n");
        break;
      }
    }
    if (Date.now() - start >= POLL_TIMEOUT_MS) {
      throw new Error(
        `Simulation run ${runId} timed out after ${POLL_TIMEOUT_MS / 1000}s`,
      );
    }
  }

  const results = Array.isArray(last.results) ? last.results : [];
  const pass = results.filter((r) => r.status === "pass" && !r.isSkipped).length;
  const fail = results.filter((r) => r.status !== "pass" && !r.isSkipped).length;
  const skipped = results.filter((r) => r.isSkipped === true).length;

  return {
    runId,
    status: last.status ?? "unknown",
    pass,
    fail,
    skipped,
    durationMs: Date.now() - start,
  };
}

export function formatSummary(summary: SimRunSummary): string {
  const total = summary.pass + summary.fail + summary.skipped;
  return [
    `📊 Simulation summary (run ${summary.runId})`,
    `   Status: ${summary.status}`,
    `   Results: ${summary.pass}/${total} pass, ${summary.fail} fail${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}`,
    `   Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  ].join("\n");
}
