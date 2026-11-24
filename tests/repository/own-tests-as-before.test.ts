import "../engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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

// A repository built from this one can hold tests of its own under tests/,
// and `npm test` runs them with the engine's. Such a test is not sandboxed:
// it doesn't import tests/engine-sandbox.ts, so the engine it starts or
// imports works in the repository, and it can write where it likes, exactly
// as before the sandbox existed.
//
// The case below is such a repository and such a test, run the way
// `npm test` runs it. The test runner leaves NODE_TEST_CONTEXT in the
// environment of the test and of every command the test starts, and the
// engine must not care.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const OWN_TEST = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import test from "node:test";
import { baseDir } from "../src/base-dir.ts";

test("an engine command started from here validates this repository's org", () => {
  const run = spawnSync("npm", ["run", "validate", "--", "dev"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Validation passed/);
});

test("a report can be written into the repository", () => {
  mkdirSync("tmp", { recursive: true });
  writeFileSync("tmp/own-report.json", '{"ok":true}\\n');
  assert.equal(readFileSync("tmp/own-report.json", "utf8"), '{"ok":true}\\n');
});

test("an engine module imported here works in this repository", () => {
  assert.equal(realpathSync(baseDir()), realpathSync(process.cwd()));
});
`;

test("a repository's own test runs as it did before the sandbox: its engine commands, its files, its imports", () => {
  const root = mkdtempSync(join(tmpdir(), "own-tests-"));
  try {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    mkdirSync(join(root, "tests"));
    for (const name of ["no-vapi-api.ts", "engine-sandbox.ts"])
      cpSync(join(REPO, "tests", name), join(root, "tests", name));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    mkdirSync(join(root, "resources/dev/assistants"), { recursive: true });
    writeFileSync(
      join(root, "resources/dev/assistants/riley.md"),
      "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\nYou are Riley.\n",
    );
    // validate needs a key to be configured, and sends nothing.
    writeFileSync(
      join(root, ".env.dev"),
      "VAPI_PRIVATE_API_KEY=not-a-real-key\n",
    );
    writeFileSync(join(root, "tests/own-flows.test.ts"), OWN_TEST);

    // As `npm test` starts it in that repository. Nothing of this test's own
    // sandbox goes along, and the runner inside sets NODE_TEST_CONTEXT again.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.VAPI_GITOPS_TEST_ROOT;
    delete env.VAPI_GITOPS_TEST_REPO;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        "tests/own-flows.test.ts",
      ],
      { cwd: root, env, encoding: "utf8", timeout: 120_000 },
    );
    assert.deepEqual(
      {
        exit: run.status,
        pass: /^# pass (\d+)/m.exec(run.stdout)?.[1],
        fail: /^# fail (\d+)/m.exec(run.stdout)?.[1],
        report: existsSync(join(root, "tmp/own-report.json")),
      },
      { exit: 0, pass: "3", fail: "0", report: true },
      run.stdout + run.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
