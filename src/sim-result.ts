// Strict pass/fail verdict for a simulation run.
//
// Pure (no I/O, no config.ts) so `npm run sim` and the PR check share it and
// tests can pin every case. The API shapes it reads:
//   - GET /eval/simulation/run/:id → a run with `status` (queued | running |
//     ended) and `itemCounts` (total, passed, failed, running, queued,
//     canceled). There is no `results` field on the run.
//   - GET /eval/simulation/run/:id/item → items with `status` (queued |
//     running | evaluating | passed | failed | canceled) and, once
//     evaluated, `results.evaluations[]`.
//
// A run only passes when every expected item exists, passed, and had at
// least one required evaluation that was actually scored. "All evaluations
// skipped" is not a pass (see docs/learnings/simulations.md).

export interface SimRunItemCounts {
  total: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  canceled: number;
}

export interface SimRun {
  id: string;
  status?: string;
  itemCounts?: SimRunItemCounts;
}

export interface SimRunEvaluation {
  name?: string;
  comparator?: string;
  expectedValue?: unknown;
  extractedValue?: unknown;
  passed?: boolean;
  required?: boolean;
  isSkipped?: boolean;
  skipReason?: string;
  error?: string;
}

export interface SimRunItem {
  id: string;
  status?: string;
  results?: { passed?: boolean; evaluations?: SimRunEvaluation[] };
  metadata?: { simulation?: { name?: string } };
}

export type SimRunVerdictStatus = "passed" | "failed" | "incomplete";

export interface SimRunFailure {
  item: string;
  evaluation: string;
  comparator?: string;
  expected?: unknown;
  extracted?: unknown;
  reason?: string;
}

export interface SimRunVerdict {
  status: SimRunVerdictStatus;
  reason: string;
  failures: SimRunFailure[];
}

const TERMINAL_ITEM_STATUSES = new Set(["passed", "failed", "canceled"]);

export function simRunItemTerminal(item: SimRunItem): boolean {
  if (!TERMINAL_ITEM_STATUSES.has(item.status ?? "")) return false;
  // A passed/failed item without results is still being written.
  return item.status === "canceled" || item.results !== undefined;
}

function itemLabel(item: SimRunItem): string {
  return item.metadata?.simulation?.name ?? item.id;
}

function requiredScored(item: SimRunItem): boolean {
  return (item.results?.evaluations ?? []).some(
    (evaluation) =>
      evaluation.required !== false && evaluation.isSkipped !== true,
  );
}

function failuresList(items: SimRunItem[]): SimRunFailure[] {
  const failures: SimRunFailure[] = [];
  for (const item of items) {
    if (item.status !== "failed") continue;
    const failed = (item.results?.evaluations ?? []).filter(
      (evaluation) =>
        evaluation.required !== false &&
        (evaluation.passed === false || evaluation.error !== undefined),
    );
    if (failed.length === 0) {
      failures.push({
        item: itemLabel(item),
        evaluation: "(no evaluation detail)",
      });
    }
    for (const evaluation of failed) {
      failures.push({
        item: itemLabel(item),
        evaluation: evaluation.name ?? "(unnamed)",
        comparator: evaluation.comparator,
        expected: evaluation.expectedValue,
        extracted: evaluation.extractedValue,
        reason: evaluation.error ?? evaluation.skipReason,
      });
    }
  }
  return failures;
}

// `expected` is the number of items the run should have (simulations ×
// iterations). Pass `undefined` when it can't be known up front (a suite run
// by ID); the verdict then requires at least one item.
export function simRunVerdict(input: {
  run: SimRun;
  items: SimRunItem[];
  expected?: number;
}): SimRunVerdict {
  const { run, items, expected } = input;
  const failures = failuresList(items);
  const counts = run.itemCounts;

  if (counts && (counts.failed > 0 || failures.length > 0)) {
    return {
      status: "failed",
      reason: `${counts.failed} of ${counts.total} simulations failed`,
      failures,
    };
  }
  if (run.status !== "ended") {
    return {
      status: "incomplete",
      reason: `run did not end (status: ${run.status ?? "unknown"})`,
      failures,
    };
  }
  if (!counts) {
    return { status: "incomplete", reason: "run has no item counts", failures };
  }
  if (counts.total === 0) {
    return { status: "incomplete", reason: "run has no items", failures };
  }
  if (expected !== undefined && counts.total !== expected) {
    return {
      status: "incomplete",
      reason: `expected ${expected} items, run has ${counts.total}`,
      failures,
    };
  }
  if (counts.canceled > 0) {
    return {
      status: "incomplete",
      reason: `${counts.canceled} of ${counts.total} simulations were canceled`,
      failures,
    };
  }
  if (
    counts.queued > 0 ||
    counts.running > 0 ||
    counts.passed !== counts.total
  ) {
    return {
      status: "incomplete",
      reason: `only ${counts.passed} of ${counts.total} simulations finished`,
      failures,
    };
  }
  if (items.length !== counts.total) {
    return {
      status: "incomplete",
      reason: `fetched ${items.length} of ${counts.total} items`,
      failures,
    };
  }
  const notPassed = items.filter((item) => item.status !== "passed");
  if (notPassed.length > 0) {
    return {
      status: "incomplete",
      reason: `${notPassed.length} items are not marked passed`,
      failures,
    };
  }
  const unscored = items.filter((item) => !requiredScored(item));
  if (unscored.length > 0) {
    return {
      status: "incomplete",
      reason: `${unscored.length} simulations had every required evaluation skipped (${unscored
        .map(itemLabel)
        .join(", ")})`,
      failures,
    };
  }
  return {
    status: "passed",
    reason: `${counts.passed} of ${counts.total} simulations passed`,
    failures,
  };
}
