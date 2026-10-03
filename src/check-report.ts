// The PR check's report: markdown for $GITHUB_STEP_SUMMARY (and the
// terminal), JSON for --json. No PR comments — the commit status links the
// run, and the job summary carries the detail.

import type { CheckOutcome, CheckTargetResult } from "./check-run.ts";

export interface CheckReportSkipped {
  check: string;
  reason: string;
}

export interface CheckReportInput {
  results: CheckTargetResult[];
  skipped: CheckReportSkipped[];
  dryRun: boolean;
}

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  passed: "✅ passed",
  failed: "❌ failed",
  incomplete: "⚠️ incomplete",
  error: "🛑 not run",
  built: "📦 built, not run",
};

function cell(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== undefined) text = JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function countsCell(result: CheckTargetResult): string {
  const counts = result.counts;
  if (!counts) return "";
  return `${counts.passed}/${counts.total}`;
}

function detailLines(result: CheckTargetResult): string[] {
  const lines: string[] = [];
  const { job } = result;
  const quiet = result.outcome === "passed" || result.outcome === "built";
  if (
    quiet &&
    result.mockNotices.length === 0 &&
    job.result.warnings.length === 0
  )
    return lines;
  lines.push(`### ${OUTCOME_LABEL[result.outcome]}: ${job.label}`, "");
  lines.push(result.reason, "");
  if (result.failures.length > 0) {
    lines.push(
      "| Simulation | Evaluation | Comparator | Expected | Got | Note |",
      "|---|---|---|---|---|---|",
    );
    for (const failure of result.failures)
      lines.push(
        `| ${cell(failure.item)} | ${cell(failure.evaluation)} | ${cell(failure.comparator)} | ${cell(failure.expected)} | ${cell(failure.extracted)} | ${cell(failure.reason)} |`,
      );
    lines.push("");
  }
  for (const error of job.result.errors) lines.push(`- ❌ ${error}`);
  for (const notice of result.mockNotices) lines.push(`- 🧪 ${notice}`);
  for (const warning of job.result.warnings) lines.push(`- ⚠️ ${warning}`);
  if (lines[lines.length - 1] !== "") lines.push("");
  return lines;
}

export function checkReportMarkdown(input: CheckReportInput): string {
  const lines = [
    `## Vapi Evals${input.dryRun ? " (dry run: payloads built, nothing sent)" : ""}`,
    "",
  ];
  if (input.results.length > 0) {
    lines.push(
      "| Check | Target | Result | Simulations | Run |",
      "|---|---|---|---|---|",
    );
    for (const result of input.results)
      lines.push(
        `| ${cell(result.job.check.name)} | ${cell(`${result.job.target.type}/${result.job.target.id}`)} | ${OUTCOME_LABEL[result.outcome]} | ${countsCell(result)} | ${result.url ? `[open](${result.url})` : ""} |`,
      );
    lines.push("");
  }
  for (const skipped of input.skipped)
    lines.push(`- ⏭️ ${skipped.check}: ${skipped.reason}`);
  if (input.skipped.length > 0) lines.push("");
  for (const result of input.results) lines.push(...detailLines(result));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function checkReportJson(input: CheckReportInput): unknown {
  return {
    dryRun: input.dryRun,
    results: input.results.map((result) => ({
      check: result.job.check.name,
      target: `${result.job.target.type}/${result.job.target.id}`,
      outcome: result.outcome,
      reason: result.reason,
      runId: result.runId,
      url: result.url,
      counts: result.counts,
      failures: result.failures,
      mockNotices: result.mockNotices,
      errors: result.job.result.errors,
      warnings: result.job.result.warnings,
      durationMs: result.durationMs,
    })),
    skipped: input.skipped,
  };
}
