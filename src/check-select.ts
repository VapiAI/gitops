// Which checks a change affects. `--changed-since <ref>` diffs from the
// merge base (`<ref>...HEAD`), so commits that landed on the base branch
// after the PR branched don't count as the PR's changes.

import { execFileSync } from "node:child_process";
import type { CheckDefinition } from "./check-config.ts";
import { CHECKS_CONFIG_FILE } from "./check-config.ts";
import { compilePattern } from "./resource-parse.ts";

// Changes to any of these can change every check's payload or verdict.
const ENGINE_PATTERNS = [
  CHECKS_CONFIG_FILE,
  "promotion.yml",
  "src/**",
  "package.json",
  "package-lock.json",
];

// Files changed between the merge base of `ref` and HEAD, or undefined when
// git can't answer (shallow clone, unknown ref) — callers then run everything.
export function changedFilesRead(
  rootDir: string,
  ref: string,
): string[] | undefined {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${ref}...HEAD`],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output.split("\n").filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

export function checkPatterns(check: CheckDefinition): string[] {
  const orgs = [...new Set([check.org, check.runOrg])];
  return [
    ...ENGINE_PATTERNS,
    ...orgs.flatMap((org) => [
      `resources/${org}/**`,
      `.vapi-state.${org}.json`,
    ]),
    ...check.paths,
  ];
}

// The first changed file that affects the check, or undefined.
export function checkAffectedBy(
  check: CheckDefinition,
  files: string[],
): string | undefined {
  const patterns = checkPatterns(check).map(compilePattern);
  return files.find((file) => patterns.some((pattern) => pattern.test(file)));
}
