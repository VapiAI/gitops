import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

// Running the test suite must not change the repository it runs in: not a
// tracked file, not an untracked one, not an ignored one, not .git.
//
// Each case below builds a repository shaped like a customer's (resources, a
// gitignored .env file with a key in it, engine state, this machine's
// baselines and snapshots, a commit), runs the whole suite inside it, and
// compares every file and folder before and after. The three cases are the
// three places engine state can be: the layout from before state/, state/,
// and nowhere yet.
//
// The copies live in temporary directories of their own, so a suite that did
// remove its repository would remove a copy.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// The suite run inside a copy includes this file. It must not start again.
const NESTED = "VAPI_GITOPS_SUITE_IN_A_COPY";

const UUID = "11111111-1111-4111-8111-111111111111";
const STATE = `${JSON.stringify({ assistants: { riley: { uuid: UUID } } }, null, 2)}\n`;
const PIN = `${JSON.stringify({ orgId: "org-acme" }, null, 2)}\n`;

const CUSTOMER: Record<string, string> = {
  "resources/acme/assistants/riley.md":
    "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\nYou are Riley.\n",
  "resources/acme/.vapi-ignore": "assistants/scratch-*\n",
  // Gitignored, and the one file here a person can't get back from git.
  ".env.acme": "VAPI_PRIVATE_API_KEY=not-a-real-key\n",
};

const LAYOUTS: Record<string, Record<string, string>> = {
  "state in the layout from before state/": {
    ".vapi-state.acme.json": STATE,
    "resources/acme/.vapi-org.json": PIN,
    [`.vapi-state-hash/acme/${UUID}`]: "0123456789abcdef\n",
    ".vapi-state.acme.snapshots/2026-01-01T00-00-00-000Z/riley.json": "{}\n",
  },
  "state in state/": {
    "state/acme/state.json": STATE,
    "state/acme/org.json": PIN,
    [`state/acme/local/baselines/${UUID}`]: "0123456789abcdef\n",
    "state/acme/local/snapshots/2026-01-01T00-00-00-000Z/riley.json": "{}\n",
  },
  "no state at all": {},
};

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

// What the suite needs from this repository: every file git doesn't ignore.
// Outside a git checkout, everything but dependencies and env files.
function engineFiles(): string[] {
  try {
    return git(
      REPO,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    )
      .split("\0")
      .filter(
        (path) =>
          // node_modules can be a link, which an ignore rule for the folder
          // doesn't match. A tracked file can be missing from the checkout.
          !/^node_modules(\/|$)/.test(path) &&
          (lstatSync(join(REPO, path), { throwIfNoEntry: false })?.isFile() ??
            false),
      );
  } catch {
    return readdirSync(REPO, { recursive: true, encoding: "utf8" }).filter(
      (path) =>
        !/^(node_modules|\.git)(\/|$)/.test(path) &&
        !/(^|\/)\.env/.test(path) &&
        lstatSync(join(REPO, path)).isFile(),
    );
  }
}

// Every file's content and every folder's existence under root, .git and
// ignored files included. node_modules is a link to this repository's own.
function tree(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === "node_modules") continue;
      if (entry.isDirectory()) {
        seen.set(`${path}/`, "folder");
        walk(path);
      } else
        seen.set(
          path,
          createHash("sha256")
            .update(readFileSync(join(root, path)))
            .digest("hex"),
        );
    }
  };
  walk("");
  return seen;
}

function changes(before: Map<string, string>, after: Map<string, string>) {
  const out: string[] = [];
  for (const [path, hash] of before)
    if (!after.has(path)) out.push(`removed ${path}`);
    else if (after.get(path) !== hash) out.push(`changed ${path}`);
  for (const path of after.keys())
    if (!before.has(path)) out.push(`added ${path}`);
  return out.sort();
}

async function suiteRunIn(state: Record<string, string>) {
  const box = mkdtempSync(join(tmpdir(), "suite-in-a-copy-"));
  const root = join(box, "repo");
  try {
    for (const path of engineFiles()) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(REPO, path), join(root, path));
    }
    for (const [path, content] of Object.entries({ ...CUSTOMER, ...state })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "a customer's repository");

    const before = tree(root);
    // A test runner started from inside another one runs nothing unless
    // NODE_TEST_CONTEXT is cleared.
    const env: NodeJS.ProcessEnv = { ...process.env, [NESTED]: "1" };
    delete env.NODE_TEST_CONTEXT;
    const files = readdirSync(join(root, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `tests/${name}`);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        ...files,
      ],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    const exit = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    return {
      exit,
      // The copy's suite ran this many test files' worth of tests and none failed.
      passed: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0) > 100,
      failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]),
      changes: changes(before, tree(root)),
    };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

test("the whole suite, run inside a customer's repository, leaves every file as it was", {
  skip: process.env[NESTED] === "1",
}, async () => {
  const names = Object.keys(LAYOUTS);
  // One copy at a time. Three suites at once, beside the one running this
  // test, starve the tests that give a CLI twenty seconds to answer.
  const results: Awaited<ReturnType<typeof suiteRunIn>>[] = [];
  for (const name of names) results.push(await suiteRunIn(LAYOUTS[name]!));
  assert.deepEqual(
    Object.fromEntries(names.map((name, i) => [name, results[i]])),
    Object.fromEntries(
      names.map((name) => [
        name,
        { exit: 0, passed: true, failed: [], changes: [] },
      ]),
    ),
  );
});

// Two things keep a test out of the repository before that comparison has
// anything to find. tests/no-vapi-api.ts gives the engine a temporary
// directory to work in and makes every node:fs change inside the repository
// throw; src/base-dir.ts refuses to work in a test that was started without
// it.

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

test("the engine works in the temporary directory a test run gives it, and refuses a test run that gives it none", () => {
  const where = (change: (env: NodeJS.ProcessEnv) => void) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    change(env);
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { baseDir } from "./src/base-dir.ts"; console.log(baseDir());',
      ],
      { cwd: REPO, env, encoding: "utf8" },
    );
    return run.status === 0 ? run.stdout.trim() : run.stderr;
  };
  const sandbox = process.env.VAPI_GITOPS_TEST_ROOT;
  assert.ok(sandbox && !sandbox.startsWith(REPO));
  assert.deepEqual(
    [
      // In a test run: the temporary directory.
      where(() => {}),
      // Outside one: the repository that holds src/.
      where((env) => {
        delete env.VAPI_GITOPS_TEST_ROOT;
        delete env.NODE_TEST_CONTEXT;
      }),
      // A test started without tests/no-vapi-api.ts.
      /without tests\/no-vapi-api\.ts/.test(
        where((env) => {
          delete env.VAPI_GITOPS_TEST_ROOT;
          env.NODE_TEST_CONTEXT = "child-v8";
        }),
      ),
    ],
    [sandbox, REPO, true],
  );
});
