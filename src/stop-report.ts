export interface StopIssue {
  file: string;
  resourceType: string;
  problem: string;
  fix: string;
  command: string;
  args?: string[];
  needsChoice?: boolean;
}

export const shellQuote = (value: string): string =>
  /^[a-zA-Z0-9_./=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

export function formatStopReport(issues: StopIssue[], org: string): string {
  const lines = [
    `Push stopped: review ${issues.length} file(s) for ${org}. Exit code: 1.`,
    "The engine cannot tell new / renamed / stale files apart; pushing an unlinked file would create a new resource.",
    "Nothing has been changed by this preflight check.",
    "",
  ];
  for (const issue of issues)
    lines.push(
      `- ${issue.file} (${issue.resourceType})`,
      `  ${issue.problem}`,
      `  Fix: ${issue.fix}`,
      `  Command: ${issue.command}`,
    );
  const choices = issues.filter((issue) => issue.needsChoice || !issue.args);
  if (choices.length)
    lines.push(
      "",
      `Human choice needed: ${choices.map((issue) => issue.file).join(", ")}`,
    );
  else {
    const args = [...new Set(issues.flatMap((issue) => issue.args!))];
    lines.push(
      "",
      `Suggested command (review and approve first): npm run push -- ${shellQuote(org)} ${args.join(" ")}`,
    );
  }
  lines.push(
    "",
    "Do not auto-pass --adopt or --allow-new-files; get explicit approval.",
  );
  return lines.join("\n");
}

export function jsonStopReport(issues: StopIssue[]): string {
  return JSON.stringify(
    issues.map(({ file, resourceType, problem, fix, command }) => ({
      file,
      resourceType,
      problem,
      fix,
      command,
    })),
  );
}
