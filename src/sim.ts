// Simulation runner — wraps `POST /eval/simulation/run`.
//
// Designed to be importable from `sim-cmd.ts` and from tests without
// triggering the CLI argument parser in `config.ts`. Env-loading is inlined
// here (rather than importing from `config.ts`) for the same reason.

import { missingApiKeyMessage, resolveApiKey } from "./api-key.ts";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  simRunItemTerminal,
  simRunVerdict,
  type SimRun,
  type SimRunItem,
  type SimRunItemCounts,
  type SimRunVerdict,
} from "./sim-result.ts";
import type { StateFile } from "./types.ts";
import { userAgentGet } from "./user-agent.ts";
import {
  VapiApiError,
  vapiFetchJson,
  type VapiConnection,
} from "./vapi-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

export interface SimEnv {
  env: string;
  token: string;
  baseUrl: string;
}

export interface SimTarget {
  type: "assistant" | "squad";
  id: string; // platform UUID
  resourceName: string; // local-name resolved from state
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
  // Give up (and cancel the run) after this long. Default 20 minutes.
  timeoutMs?: number;
  // Aborting cancels the run and reports it as incomplete (Ctrl-C).
  signal?: AbortSignal;
  pollIntervalMs?: number;
  // How long to keep re-reading items after the run ends, while their
  // results are still being written. Default 2 minutes.
  hydrationMs?: number;
}

export interface SimRunSummary {
  runId: string;
  // Dashboard link from the create response (GET doesn't return it).
  url?: string;
  status: string;
  // Undefined when the run wasn't watched (`--no-watch`).
  verdict?: SimRunVerdict;
  counts?: SimRunItemCounts;
  // True when this command canceled the run (timeout or interrupt).
  canceled: boolean;
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
  const token = resolveApiKey(process.env, envVars);
  const baseUrl =
    process.env.VAPI_BASE_URL || envVars.VAPI_BASE_URL || "https://api.vapi.ai";
  if (!token) {
    throw new Error(missingApiKeyMessage(env));
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
  // Forward-compat: if the state schema wraps strings as {uuid: string},
  // surface the .uuid field; otherwise treat values as the legacy bare
  // string. The local function below handles both shapes.
  return state;
}

// Resolve a local resource name → platform UUID. The state schema may store
// values as either bare string UUIDs (legacy) or ResourceState objects
// ({uuid: string, ...}); this helper accepts both shapes and returns just
// the UUID.
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
    const id = stateValueToUuid(
      (state.assistants as Record<string, unknown>)[args.assistant],
    );
    if (!id) {
      throw new Error(
        `Assistant "${args.assistant}" not found in state. Run 'npm run pull -- ${"<env>"}' or check the resource name.`,
      );
    }
    return { type: "assistant", id, resourceName: args.assistant };
  }
  if (args.squad) {
    const id = stateValueToUuid(
      (state.squads as Record<string, unknown>)[args.squad],
    );
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
    const names = args.simulations
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error(
        "--simulations requires at least one comma-separated simulation name",
      );
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

// Fields of `POST /eval/simulation/run`'s response this runner reads. The
// create response is the only place `url` and `simulationRunItemIds` appear.
export interface SimRunCreated extends SimRun {
  url?: string;
  simulationRunItemIds?: string[];
}

const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_HYDRATION_MS = 2 * 60_000;
// The API's maximum page size; one page covers nearly every run.
const ITEM_PAGE_SIZE = 1000;

function connectionFor(cfg: SimEnv): VapiConnection {
  return {
    token: cfg.token,
    baseUrl: cfg.baseUrl,
    userAgent: userAgentGet("sim"),
  };
}

// Resolves after `ms`, or early (to "aborted") when the signal fires.
function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<"slept" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Reads every item of a run. Accepts both the paginated shape
// (`{ results, metadata }`, sent when `limit`/`page` are given) and a bare
// array. Items are deduped by id because the API orders pages only by
// creation time, and a run's items share it, so OFFSET pages can overlap.
export async function simRunItemsFetch(
  connection: VapiConnection,
  runId: string,
): Promise<SimRunItem[]> {
  const byId = new Map<string, SimRunItem>();
  for (let page = 1; page <= 100; page++) {
    const response = await vapiFetchJson<
      | SimRunItem[]
      | { results?: SimRunItem[]; metadata?: { totalItems?: number } }
    >(
      connection,
      "GET",
      `/eval/simulation/run/${runId}/item?page=${page}&limit=${ITEM_PAGE_SIZE}`,
    );
    if (Array.isArray(response)) {
      for (const item of response) byId.set(item.id, item);
      break;
    }
    const results = response?.results ?? [];
    for (const item of results) byId.set(item.id, item);
    const total = response?.metadata?.totalItems;
    if (results.length < ITEM_PAGE_SIZE) break;
    if (total !== undefined && byId.size >= total) break;
  }
  return [...byId.values()];
}

// Cancels a run. Returns false (instead of throwing) when the run had
// already ended or a concurrent cancel won the race (400 / 409).
export async function simRunCancel(
  connection: VapiConnection,
  runId: string,
): Promise<boolean> {
  try {
    await vapiFetchJson(connection, "PATCH", `/eval/simulation/run/${runId}`);
    return true;
  } catch (error) {
    if (
      error instanceof VapiApiError &&
      (error.statusCode === 400 || error.statusCode === 409)
    ) {
      return false;
    }
    throw error;
  }
}

export interface SimRunExecuteOptions extends SimRunOptions {
  // Called with the create response, before polling (prints the link, or
  // posts a pending commit status pointing at it).
  onCreated?: (created: SimRunCreated) => void | Promise<void>;
  // Rewrite a "Status: …" line on a TTY while polling. Off when several runs
  // poll at once.
  progress?: boolean;
}

export interface SimRunExecuted {
  summary: SimRunSummary;
  items: SimRunItem[];
}

// Create a run from `body`, poll it until it ends or the deadline passes
// (canceling it then, or on abort), wait for its items, and judge it with
// simRunVerdict. Shared by `npm run sim` and the PR check.
export async function simRunExecute(
  connection: VapiConnection,
  body: unknown,
  options: SimRunExecuteOptions = {},
): Promise<SimRunExecuted> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const progress = options.progress ?? true;
  const start = Date.now();
  // Creating a run queues paid work before the response returns, so a 5xx
  // here may still have started it: retry rate limits only.
  const created = await vapiFetchJson<SimRunCreated>(
    connection,
    "POST",
    "/eval/simulation/run",
    body,
    { retry: "rate-limit-only" },
  );
  const runId = created?.id;
  if (!runId) {
    throw new Error("POST /eval/simulation/run returned no run id");
  }
  await options.onCreated?.(created);

  const summary: SimRunSummary = {
    runId,
    url: created.url,
    status: created.status ?? "queued",
    counts: created.itemCounts,
    canceled: false,
    durationMs: 0,
  };
  if (!(options.watch ?? true)) {
    summary.durationMs = Date.now() - start;
    return { summary, items: [] };
  }

  const deadline = start + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let run: SimRun = created;
  let stopReason: string | undefined;
  while (run.status !== "ended") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      stopReason = `timed out after ${Math.round((Date.now() - start) / 1000)}s`;
      break;
    }
    const slept = await sleepUnlessAborted(
      Math.min(pollIntervalMs, remaining),
      options.signal,
    );
    if (slept === "aborted") {
      stopReason = "interrupted";
      break;
    }
    run = await vapiFetchJson<SimRun>(
      connection,
      "GET",
      `/eval/simulation/run/${runId}`,
    );
    if (progress && process.stdout.isTTY) {
      process.stdout.write(`\r   Status: ${run.status ?? "unknown"}     `);
    }
  }
  if (progress && process.stdout.isTTY) process.stdout.write("\n");

  if (stopReason) {
    summary.canceled = await simRunCancel(connection, runId);
    summary.status = run.status ?? "unknown";
    summary.counts = run.itemCounts;
    summary.verdict = {
      status: "incomplete",
      reason: `${stopReason}${summary.canceled ? "; run canceled" : ""}`,
      failures: [],
    };
    summary.durationMs = Date.now() - start;
    return { summary, items: [] };
  }

  // Items can lag the run: keep re-reading until every item is terminal and
  // carries its results, or the hydration window closes.
  const hydrationDeadline =
    Date.now() + (options.hydrationMs ?? DEFAULT_HYDRATION_MS);
  let items = await simRunItemsFetch(connection, runId);
  while (
    Date.now() < hydrationDeadline &&
    (items.length < (run.itemCounts?.total ?? 0) ||
      !items.every(simRunItemTerminal))
  ) {
    if (
      (await sleepUnlessAborted(pollIntervalMs, options.signal)) === "aborted"
    ) {
      break;
    }
    items = await simRunItemsFetch(connection, runId);
  }

  summary.status = run.status ?? "unknown";
  summary.counts = run.itemCounts;
  summary.verdict = simRunVerdict({
    run,
    items,
    expected: created.simulationRunItemIds?.length,
  });
  summary.durationMs = Date.now() - start;
  return { summary, items };
}

export async function runSimulation(
  cfg: SimEnv,
  selection: SimSelection,
  target: SimTarget,
  options: SimRunOptions = {},
): Promise<SimRunSummary> {
  const body: Record<string, unknown> = {
    simulations: selection.entries,
    target:
      target.type === "assistant"
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
  const { summary } = await simRunExecute(connectionFor(cfg), body, {
    ...options,
    onCreated: (created) => {
      console.log(`   Run ID: ${created.id}`);
      if (created.url) console.log(`   Run: ${created.url}`);
    },
  });
  return summary;
}

function valueFormat(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function formatSummary(summary: SimRunSummary): string {
  const lines = [`📊 Simulation summary (run ${summary.runId})`];
  if (summary.url) lines.push(`   Run: ${summary.url}`);
  lines.push(`   Status: ${summary.status}`);
  if (summary.counts) {
    const c = summary.counts;
    lines.push(
      `   Items: ${c.passed} passed, ${c.failed} failed, ${c.canceled} canceled, ${c.running + c.queued} unfinished (of ${c.total})`,
    );
  }
  if (summary.verdict) {
    lines.push(
      `   Verdict: ${summary.verdict.status} — ${summary.verdict.reason}`,
    );
    for (const failure of summary.verdict.failures) {
      const detail =
        failure.comparator !== undefined
          ? ` (expected ${failure.comparator} ${valueFormat(failure.expected)}, got ${valueFormat(failure.extracted)})`
          : "";
      lines.push(
        `   ✗ ${failure.item}: ${failure.evaluation}${detail}${failure.reason ? ` — ${failure.reason}` : ""}`,
      );
    }
  } else {
    lines.push("   Verdict: not watched (--no-watch)");
  }
  lines.push(`   Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}
