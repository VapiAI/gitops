import "../engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// tests/engine-sandbox.test.ts fails when a test file doesn't import the
// sandbox first, in the engine's own repository and in no other: anywhere
// else such a file is that repository's own test. Each case below asks that
// check in a small repository that holds one test file without the import,
// named each way a repository can be.

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function importCheckIn(named: { runner?: string; origin?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "import-check-"));
  try {
    mkdirSync(join(root, "tests"));
    for (const file of [
      "engine-sandbox.test.ts",
      "engine-sandbox.ts",
      "engine-tests.ts",
    ])
      cpSync(join(REPO, "tests", file), join(root, "tests", file));
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, "tests/own.test.ts"),
      'import test from "node:test";\n\ntest("own", () => {});\n',
    );
    git(root, "init", "-q", "-b", "main");
    if (named.origin) git(root, "remote", "add", "origin", named.origin);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.GITHUB_REPOSITORY;
    if (named.runner) env.GITHUB_REPOSITORY = named.runner;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-name-pattern",
        "every test file imports the sandbox first",
        "tests/engine-sandbox.test.ts",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    if (/^# skipped 1$/m.test(run.stdout)) return "not asked";
    if (run.status === 0) return "passed";
    return /own\.test\.ts/.test(run.stdout)
      ? "own.test.ts lacks the import"
      : run.stdout + run.stderr;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the import check is asked in the engine's own repository, however it is named, and in no other", () => {
  const fork = "acme/voice-agents";
  assert.deepEqual(
    {
      "a runner in the engine's repository": importCheckIn({
        runner: "VapiAI/gitops",
        origin: "https://github.com/VapiAI/gitops",
      }),
      "a clone over https": importCheckIn({
        origin: "https://github.com/VapiAI/gitops.git",
      }),
      "a clone over https, typed in lower case and without .git": importCheckIn(
        { origin: "https://github.com/vapiai/gitops" },
      ),
      "a clone over ssh": importCheckIn({
        origin: "git@github.com:VapiAI/gitops.git",
      }),
      "a runner in a fork": importCheckIn({
        runner: fork,
        origin: `https://github.com/${fork}`,
      }),
      "a clone of a fork over https": importCheckIn({
        origin: `https://github.com/${fork}.git`,
      }),
      "a clone of a fork over ssh": importCheckIn({
        origin: `git@github.com:${fork}.git`,
      }),
      "a fork that kept the name": importCheckIn({
        origin: "https://github.com/acme/gitops.git",
      }),
      "a repository with no origin": importCheckIn({}),
    },
    {
      "a runner in the engine's repository": "own.test.ts lacks the import",
      "a clone over https": "own.test.ts lacks the import",
      "a clone over https, typed in lower case and without .git":
        "own.test.ts lacks the import",
      "a clone over ssh": "own.test.ts lacks the import",
      "a runner in a fork": "not asked",
      "a clone of a fork over https": "not asked",
      "a clone of a fork over ssh": "not asked",
      "a fork that kept the name": "not asked",
      "a repository with no origin": "not asked",
    },
  );
});
