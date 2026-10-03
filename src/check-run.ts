// Run built check payloads live: one simulation run per target, at most
// MAX_CONCURRENT at once, inside one overall budget. Reuses `npm run sim`'s
// create/poll/cancel/verdict loop (simRunExecute), so a check is judged by
// the same strict rules.

import type { CheckJob } from "./check-build.ts";
import { MOCK_MARKER } from "./check-mocks.ts";
import type { CommitState } from "./check-status.ts";
import type { SimRunExecuteOptions } from "./sim.ts";
import { simRunExecute } from "./sim.ts";
import type {
  SimRunFailure,
  SimRunItem,
  SimRunItemCounts,
} from "./sim-result.ts";
import type { VapiConnection } from "./vapi-client.ts";
import { VapiApiError } from "./vapi-client.ts";

// passed / failed / incomplete come from the run's verdict; error is a
// config or build problem (nothing was sent); built is a dry run's success.
export type CheckOutcome =
  "passed" | "failed" | "incomplete" | "error" | "built";

export interface CheckTargetResult {
  job: CheckJob;
  outcome: CheckOutcome;
  reason: string;
  runId?: string;
  url?: string;
  counts?: SimRunItemCounts;
  failures: SimRunFailure[];
  // "unmocked tool called" notices from the transcripts.
  mockNotices: string[];
  durationMs: number;
}

export interface CheckRunArgs {
  jobs: CheckJob[];
  connectionFor: (job: CheckJob) => VapiConnection;
  // Absolute time by which every run must have finished.
  deadline: number;
  signal?: AbortSignal;
  // Called once the run exists, with its canonical link.
  onRunCreated?: (job: CheckJob, url: string | undefined) => Promise<void>;
  onResult?: (result: CheckTargetResult) => Promise<void>;
  concurrency?: number;
  // Test seams for simRunExecute's polling.
  pollIntervalMs?: number;
  hydrationMs?: number;
}

export const MAX_CONCURRENT = 3;
// Don't start a run that couldn't plausibly finish before the deadline.
export const MIN_START_MS = 5 * 60_000;

export function outcomeState(outcome: CheckOutcome): CommitState {
  if (outcome === "passed") return "success";
  if (outcome === "failed") return "failure";
  return "error";
}

// Default mocks answer with MOCK_MARKER, so a tool result carrying it means
// the assistant called a tool its scenario didn't mock. Only the call's
// transcript is read: the item also echoes the scenario, default mocks and
// all, which would match whether or not they were called.
export function mockNoticesCollect(items: SimRunItem[]): string[] {
  const notices = new Set<string>();
  for (const item of items) {
    const label = item.metadata?.simulation?.name ?? item.id;
    const messages = item.metadata?.call?.messages ?? [];
    const names = new Map<string, string>();
    for (const message of messages)
      for (const call of message.toolCalls ?? [])
        if (call.id && call.function?.name)
          names.set(call.id, call.function.name);
    for (const message of messages) {
      if (message.role !== "tool_call_result") continue;
      if (!String(message.result ?? "").includes(MOCK_MARKER)) continue;
      const id = message.toolCallId ?? message.name ?? "";
      notices.add(`${label}: unmocked tool called: ${names.get(id) ?? id}`);
    }
  }
  return [...notices];
}

function errorReason(error: unknown): string {
  if (error instanceof VapiApiError && error.statusCode === 402)
    return `billing: the run org can't start simulations (402: ${error.apiMessage})`;
  return error instanceof Error ? error.message : String(error);
}

async function jobRun(
  args: CheckRunArgs,
  job: CheckJob,
): Promise<CheckTargetResult> {
  const start = Date.now();
  const base = { job, failures: [], mockNotices: [], durationMs: 0 };
  const body = job.result.body;
  if (!body)
    return {
      ...base,
      outcome: "error",
      reason: `payload could not be built (${job.result.errors.length} problem${job.result.errors.length === 1 ? "" : "s"})`,
    };
  if (args.signal?.aborted)
    return {
      ...base,
      outcome: "incomplete",
      reason: "not started: interrupted",
    };
  const remaining = args.deadline - Date.now();
  if (remaining < MIN_START_MS)
    return {
      ...base,
      outcome: "incomplete",
      reason: `not started: ${Math.max(0, Math.round(remaining / 60_000))} min of budget left`,
    };
  const options: SimRunExecuteOptions = {
    timeoutMs: Math.min(job.check.timeoutMinutes * 60_000, remaining),
    signal: args.signal,
    progress: false,
    pollIntervalMs: args.pollIntervalMs,
    hydrationMs: args.hydrationMs,
    onCreated: async (created) => {
      console.log(`  ▶ ${job.label}: ${created.url ?? created.id}`);
      await args.onRunCreated?.(job, created.url);
    },
  };
  try {
    const { summary, items } = await simRunExecute(
      args.connectionFor(job),
      body,
      options,
    );
    const verdict = summary.verdict;
    return {
      job,
      outcome: verdict?.status ?? "incomplete",
      reason: verdict?.reason ?? "no verdict",
      runId: summary.runId,
      url: summary.url,
      counts: summary.counts,
      failures: verdict?.failures ?? [],
      mockNotices: mockNoticesCollect(items),
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "incomplete",
      reason: errorReason(error),
      durationMs: Date.now() - start,
    };
  }
}

// Results come back in job order, whatever order the runs finish in.
export async function checkRunAll(
  args: CheckRunArgs,
): Promise<CheckTargetResult[]> {
  const results: CheckTargetResult[] = new Array(args.jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < args.jobs.length) {
      const index = next++;
      const result = await jobRun(args, args.jobs[index]!);
      results[index] = result;
      await args.onResult?.(result);
    }
  };
  const workers = Math.min(
    args.concurrency ?? MAX_CONCURRENT,
    args.jobs.length,
  );
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
