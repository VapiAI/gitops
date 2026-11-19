import "../engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A repository that doesn't use the engine's test sandbox has to behave as
// it did before the sandbox existed. Two things once did not.
//
// 1. The engine refused to start when NODE_TEST_CONTEXT was in its
//    environment and no sandbox was. Node's test runner sets
//    NODE_TEST_CONTEXT for every process it starts, so an engine command
//    started from a repository's own test exited 1.
//
// 2. The preload npm test adds, tests/no-vapi-api.ts, pointed the engine at
//    an empty temporary directory and made node:fs refuse every write inside
//    the repository, for every test file. A repository's own test under
//    tests/ that ran the engine on that repository, or wrote a file into it,
//    failed: the engine it started found no resources and no key.
//
// The sandbox is now a module the engine's own tests import
// (tests/engine-sandbox.ts), and the engine never looks at what a test
// runner leaves in the environment.
//
// Each case works in a throwaway copy in a folder of its own.

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// A small repository of a customer's: one org, one assistant, its state file
// and its key file, with the engine and its test preload as shipped.
function customerRepository(): { root: string; drop: () => void } {
  const box = mkdtempSync(join(tmpdir(), "own-tests-"));
  const root = join(box, "repo");
  mkdirSync(join(root, "tests"), { recursive: true });
  cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(root, "package.json"));
  cpSync(
    join(REPO, "tests", "no-vapi-api.ts"),
    join(root, "tests", "no-vapi-api.ts"),
  );
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  put(
    root,
    "resources/dev/assistants/riley.md",
    "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\nAnswer the phone.\n",
  );
  put(
    root,
    ".vapi-state.dev.json",
    JSON.stringify(
      {
        assistants: { riley: { uuid: "11111111-1111-4111-8111-111111111111" } },
      },
      null,
      2,
    ) + "\n",
  );
  put(root, ".env.dev", "VAPI_PRIVATE_API_KEY=not-a-real-key\n");
  return { root, drop: () => rmSync(box, { recursive: true, force: true }) };
}

// The environment of a shell that is not this test process: none of what the
// test runner and the preload put into ours.
function shellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.VAPI_GITOPS_TEST_ROOT;
  delete env.VAPI_GITOPS_TEST_REPO;
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  return { ...env, ...extra };
}

function validate(env: NodeJS.ProcessEnv): {
  exit: number | null;
  passed: boolean;
} {
  const repository = customerRepository();
  try {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/validate-cmd.ts", "dev"],
      { cwd: repository.root, encoding: "utf8", env },
    );
    return {
      exit: run.status,
      passed: /Validation passed/.test(run.stdout + run.stderr),
    };
  } finally {
    repository.drop();
  }
}

// Run one test file of the customer's own the way npm test runs it.
function ownTest(body: string): { exit: number | null; ran: boolean } {
  const repository = customerRepository();
  try {
    put(repository.root, "tests/our-own.test.ts", body);
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        "tests/our-own.test.ts",
      ],
      { cwd: repository.root, encoding: "utf8", env: shellEnv() },
    );
    return { exit: run.status, ran: /^# pass 1$/m.test(run.stdout) };
  } finally {
    repository.drop();
  }
}

const OWN_HEAD =
  'import assert from "node:assert/strict";\n' +
  'import { spawnSync } from "node:child_process";\n' +
  'import { mkdirSync, writeFileSync } from "node:fs";\n' +
  'import { join } from "node:path";\n' +
  'import test from "node:test";\n' +
  'import { fileURLToPath } from "node:url";\n' +
  'const REPO = fileURLToPath(new URL("..", import.meta.url));\n';

test("control: validate runs in a plain shell", () => {
  assert.deepEqual(validate(shellEnv()), { exit: 0, passed: true });
});

test("an engine command runs as on main when NODE_TEST_CONTEXT is in its environment", () => {
  assert.deepEqual(validate(shellEnv({ NODE_TEST_CONTEXT: "child-v8" })), {
    exit: 0,
    passed: true,
  });
});

test("a customer's own test that runs validate on its repository passes as on main", () => {
  assert.deepEqual(
    ownTest(
      OWN_HEAD +
        'test("our dev org validates", () => {\n' +
        '  const run = spawnSync(process.execPath, ["--import", "tsx", "src/validate-cmd.ts", "dev"], { cwd: REPO, encoding: "utf8" });\n' +
        "  assert.equal(run.status, 0, run.stdout + run.stderr);\n" +
        "  assert.match(run.stdout, /Validation passed/);\n" +
        "});\n",
    ),
    { exit: 0, ran: true },
  );
});

test("a customer's own test that writes a report into its repository passes as on main", () => {
  assert.deepEqual(
    ownTest(
      OWN_HEAD +
        'test("we keep a report of the run", () => {\n' +
        '  mkdirSync(join(REPO, "tmp"), { recursive: true });\n' +
        '  writeFileSync(join(REPO, "tmp/our-test-report.json"), "{}\\n");\n' +
        "});\n",
    ),
    { exit: 0, ran: true },
  );
});
