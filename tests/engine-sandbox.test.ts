import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX, SANDBOX_FROM_FOLDER, testFiles } from "./engine-tests.ts";

// Two things keep an engine test out of the repository it runs in. Both come
// from tests/engine-sandbox.ts, which every engine test imports first: the
// engine gets a temporary directory to work in, and every node:fs change
// inside the repository throws. They travel with the test file, so they hold
// however the file is started.
//
// `npm run test:repository` checks the result from the outside: it runs the
// suite inside copies of a repository and compares every file.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a test can't create, change or remove anything in the repository it runs in", async () => {
  const inside = /inside the repository it runs in/;
  assert.throws(() => writeFileSync(join(REPO, "x.txt"), "x"), inside);
  assert.throws(() => mkdirSync(join(REPO, "tmp")), inside);
  assert.throws(() => rmSync(REPO, { recursive: true, force: true }), inside);
  assert.throws(
    () => rmSync(join(REPO, "src", ".."), { recursive: true, force: true }),
    inside,
  );
  assert.throws(
    () => renameSync(join(REPO, "package.json"), join(tmpdir(), "p.json")),
    inside,
  );
  assert.throws(
    () => cpSync(join(REPO, "package.json"), join(REPO, "copy.json")),
    inside,
  );
  await assert.rejects(async () => writeFile(join(REPO, "x.txt"), "x"), inside);
  await assert.rejects(
    async () => rm(join(REPO, "src"), { recursive: true }),
    inside,
  );
  // Reading is fine, and so is anything under a temporary directory.
  assert.ok(readFileSync(join(REPO, "package.json"), "utf8").length > 0);
  const own = mkdtempSync(join(tmpdir(), "suite-guard-"));
  writeFileSync(join(own, "a"), "a");
  rmSync(own, { recursive: true });
});

// Where the engine says it works, asked from a new process in this
// repository.
function where(
  change: (env: NodeJS.ProcessEnv) => void,
  program = 'import { baseDir } from "./src/base-dir.ts"; console.log(baseDir());',
  cwd = REPO,
): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  change(env);
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", program],
    { cwd, env, encoding: "utf8" },
  );
  return run.status === 0 ? run.stdout.trim() : run.stderr;
}
const unsandboxed = (env: NodeJS.ProcessEnv) => {
  delete env.VAPI_GITOPS_TEST_ROOT;
  delete env.VAPI_GITOPS_TEST_REPO;
};

test("the engine works in a temporary directory for an engine test and what it starts, and in its repository for everything else", () => {
  const sandbox = process.env.VAPI_GITOPS_TEST_ROOT;
  assert.ok(sandbox && !sandbox.startsWith(REPO));
  // A copy of the engine somewhere else, as a test builds to run a command
  // in a repository of its own making.
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "engine-copy-")));
  mkdirSync(join(copy, "src"));
  cpSync(join(REPO, "src/base-dir.ts"), join(copy, "src/base-dir.ts"));
  cpSync(join(REPO, "package.json"), join(copy, "package.json"));
  symlinkSync(join(REPO, "node_modules"), join(copy, "node_modules"), "dir");
  const fromCopy = where(() => {}, undefined, copy);
  rmSync(copy, { recursive: true, force: true });
  assert.deepEqual(
    [
      // A command this test starts from that copy: the copy, though the
      // sandbox is in its environment.
      fromCopy,
      // A command this test starts: the temporary directory.
      where(() => {}),
      // A command nobody's test started: the repository that holds src/.
      where((env) => {
        unsandboxed(env);
        delete env.NODE_TEST_CONTEXT;
      }),
      // A command started under a test runner by a test that isn't the
      // engine's. The runner leaves this variable behind, and the engine
      // doesn't look at it.
      where((env) => {
        unsandboxed(env);
        env.NODE_TEST_CONTEXT = "child-v8";
      }),
    ],
    [copy, sandbox, REPO, REPO],
  );
});

test("an engine test started by hand, without the preload npm test adds, still works in a temporary directory", () => {
  // What a test file does at its top: the sandbox first, then the engine.
  // hash-store.ts settles its directory while it loads, so this fails if the
  // sandbox were not finished by then.
  const at = where((env) => {
    unsandboxed(env);
    delete env.NODE_TEST_CONTEXT;
  }, [
    'import "./tests/engine-sandbox.ts";',
    'import { hashStoreDir } from "./src/hash-store.ts";',
    'console.log(hashStoreDir("acme"));',
  ].join("\n"));
  assert.deepEqual(
    [at.startsWith(REPO), at.includes("vapi-gitops-test-"), /acme$/.test(at)],
    [false, true, true],
    at,
  );
});

// Whether this is CI for the engine's own repository, by the name GitHub
// gives the runner. Anywhere else, a person's machine included, a test file
// without the import is that repository's own test, whatever origin says: a
// repository cloned straight from the engine's keeps its origin.
function engineRepositoryCi(): boolean {
  return process.env.GITHUB_REPOSITORY?.toLowerCase() === "vapiai/gitops";
}

test("in CI for the engine's own repository, every test file imports the sandbox first", {
  skip: engineRepositoryCi()
    ? false
    : "not CI for the engine's own repository: a test file without the import is this repository's own",
}, () => {
  const other = [
    ...testFiles(join(REPO, "tests")).other,
    ...testFiles(join(REPO, "tests/repository"), SANDBOX_FROM_FOLDER).other.map(
      (name) => `repository/${name}`,
    ),
  ];
  assert.deepEqual(
    other,
    [],
    `Every engine test file starts with ${SANDBOX} (${SANDBOX_FROM_FOLDER} under tests/repository/) and these don't: ${other.join(", ")}. This is asked because GITHUB_REPOSITORY is VapiAI/gitops; anywhere else a test file without the import is left alone.`,
  );
});

// A suite inside a suite is slow, and reaches the time limits some tests
// give a command sooner. A test that starts a test runner of its own lives
// in tests/repository/ and runs with `npm run test:repository`, so `npm test`
// takes what it took before those tests existed.
test("no test that npm test runs starts a test runner of its own", () => {
  // Spelled in two halves so this file doesn't match itself.
  const runnerFlag = ["--", "test"].join("");
  assert.deepEqual(
    testFiles(join(REPO, "tests")).engine.filter((name) =>
      readFileSync(join(REPO, "tests", name), "utf8").includes(runnerFlag),
    ),
    [],
  );
});
