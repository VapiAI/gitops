import "../engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testFiles } from "../engine-tests.ts";

// Running the test suite must not change the repository it runs in: not a
// tracked file, not an untracked one, not an ignored one, not .git.
//
// Each case below builds a repository shaped like a customer's (resources, a
// gitignored .env file with a key in it, a test of their own, engine state,
// this machine's baselines and snapshots, a commit), runs the engine's whole
// suite inside it, and compares every file and folder before and after. The
// three cases are the three places engine state can be: the layout from
// before state/, state/, and nowhere yet.
//
// The copies live in temporary directories of their own, so a suite that did
// remove its repository would remove a copy.
//
// This file is not part of `npm test`. It runs the suite three more times,
// which is slow, and a suite inside a suite reaches the time limits some
// tests give a command sooner. `npm run test:repository` runs it, by itself,
// and so does a CI job in the engine's own repository.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const UUID = "11111111-1111-4111-8111-111111111111";
const STATE = `${JSON.stringify({ assistants: { riley: { uuid: UUID } } }, null, 2)}\n`;
const PIN = `${JSON.stringify({ orgId: "org-acme" }, null, 2)}\n`;

const CUSTOMER: Record<string, string> = {
  "resources/acme/assistants/riley.md":
    "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\nYou are Riley.\n",
  "resources/acme/.vapi-ignore": "assistants/scratch-*\n",
  // Gitignored, and the one file here a person can't get back from git.
  ".env.acme": "VAPI_PRIVATE_API_KEY=not-a-real-key\n",
  // A test of the customer's own. It is not the engine's, so the run below
  // leaves it out; if it ran, the report it writes would show up as a change.
  "tests/own-report.test.ts":
    'import { mkdirSync, writeFileSync } from "node:fs";\nimport test from "node:test";\n\ntest("writes a report", () => {\n  mkdirSync("tmp", { recursive: true });\n  writeFileSync("tmp/own-report.json", "{}\\n");\n});\n',
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // The copy is a customer's repository, on a runner too.
      GITHUB_REPOSITORY: "acme/voice-agents",
    };
    delete env.NODE_TEST_CONTEXT;
    const files = testFiles(join(root, "tests")).engine.map(
      (name) => `tests/${name}`,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        // Half the cores: the copy's suite is not the only thing running,
        // and its tests give a command twenty seconds to answer.
        `--test-concurrency=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
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

test("the whole suite, run inside a customer's repository, leaves every file as it was", async () => {
  const names = Object.keys(LAYOUTS);
  // One copy at a time. Three suites at once starve the tests that give a
  // CLI twenty seconds to answer.
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
