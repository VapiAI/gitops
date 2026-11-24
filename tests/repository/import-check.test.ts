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
// sandbox first, in CI for the engine's own repository and nowhere else:
// anywhere else such a file is that repository's own test. That includes a
// person's clone of the engine's repository, which keeps its origin and may
// hold a test of its owner's. Each case below asks that check in a small
// repository that holds one test file without the import, named each way a
// repository can be.

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

test("the import check is asked in CI for the engine's own repository, and nowhere else", () => {
  const fork = "acme/voice-agents";
  assert.deepEqual(
    {
      "a runner in the engine's repository": importCheckIn({
        runner: "VapiAI/gitops",
        origin: "https://github.com/VapiAI/gitops",
      }),
      "a runner in the engine's repository, named in lower case": importCheckIn(
        { runner: "vapiai/gitops", origin: "https://github.com/vapiai/gitops" },
      ),
      "a clone of the engine's repository over https": importCheckIn({
        origin: "https://github.com/VapiAI/gitops.git",
      }),
      "a clone of the engine's repository over ssh": importCheckIn({
        origin: "git@github.com:VapiAI/gitops.git",
      }),
      "a runner in a fork": importCheckIn({
        runner: fork,
        origin: `https://github.com/${fork}`,
      }),
      "a runner in a repository that kept the engine's origin": importCheckIn({
        runner: fork,
        origin: "https://github.com/VapiAI/gitops.git",
      }),
      "a runner in a fork that kept the name": importCheckIn({
        runner: "acme/gitops",
        origin: "https://github.com/acme/gitops.git",
      }),
      "a clone of a fork": importCheckIn({
        origin: `git@github.com:${fork}.git`,
      }),
      "a repository with no origin": importCheckIn({}),
    },
    {
      "a runner in the engine's repository": "own.test.ts lacks the import",
      "a runner in the engine's repository, named in lower case":
        "own.test.ts lacks the import",
      "a clone of the engine's repository over https": "not asked",
      "a clone of the engine's repository over ssh": "not asked",
      "a runner in a fork": "not asked",
      "a runner in a repository that kept the engine's origin": "not asked",
      "a runner in a fork that kept the name": "not asked",
      "a clone of a fork": "not asked",
      "a repository with no origin": "not asked",
    },
  );
});
