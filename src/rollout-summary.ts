// The rollout ticker's per-run report, for $GITHUB_STEP_SUMMARY. A green run
// with no summary was the only trace of a stuck ramp; this puts every ramp's
// state and the health gate's reading where the run's page shows them.

export interface RolloutSummaryRow {
  org: string;
  // The assistant's resource ID in the repo.
  assistant: string;
  // What the tick did, or why the ramp is waiting or stopped.
  state: string;
  // The ramp should have moved and has not; such a row fails the advance run.
  overdue: boolean;
  // What the health gate read; absent without a gate or before it runs.
  gate?: string;
}

// Table cells cannot hold a pipe or a line break.
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function rolloutSummaryMarkdown(
  action: string,
  rows: RolloutSummaryRow[],
): string {
  const title = `## Rollout ${action}`;
  if (rows.length === 0) return `${title}\n\nNo ramp in progress.\n`;
  const overdue = rows.filter((row) => row.overdue).length;
  const lines = [
    title,
    "",
    overdue > 0
      ? `⚠️ ${overdue} of ${rows.length} ramps overdue.`
      : `${rows.length} ramps, none overdue.`,
    "",
    "| Org | Assistant | State | Health gate |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${cell(row.org)} | ${cell(row.assistant)} | ${row.overdue ? "⚠️ overdue: " : ""}${cell(row.state)} | ${cell(row.gate ?? "")} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// The advance run's failure, naming each overdue ramp; null when none is.
export function rolloutOverdueMessage(rows: RolloutSummaryRow[]): string | null {
  const overdue = rows.filter((row) => row.overdue);
  if (overdue.length === 0) return null;
  return `${overdue.length} ramps overdue:\n${overdue.map((row) => `  - ${row.org}/${row.assistant}: ${row.state}`).join("\n")}`;
}
