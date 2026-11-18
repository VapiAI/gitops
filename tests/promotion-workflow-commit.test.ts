import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { StateLayoutError, stateLayoutPrepare } from "../src/state-paths.ts";

// Runs the promotion workflow's real "Commit reconciled files and UUID
// state" step (read from .github/workflows/promotion.yml, run with bash -e)
// against a clone of a bare origin, after a promotion driven through
// promote-cmd with a fake child runner. An edit to the step that brings back
// "a failed promotion pushes nothing" — or commits a failed transition's
// rewrite — fails here.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "promotion-workflow-"));
const ORIGIN = join(WORK, "origin.git");
const CLONE = join(WORK, "clone");
// promote-cmd.ts binds its root at import.
process.env.VAPI_GITOPS_ROOT = CLONE;
const { promotionCommandRun } = await import("../src/promote-cmd.ts");

interface Workflow {
  jobs: { promote: { steps: Array<{ name?: string; run?: string }> } };
}

const COMMIT_STEP = (
  parseYaml(
    readFileSync(join(REPO, ".github/workflows/promotion.yml"), "utf8"),
  ) as Workflow
).jobs.promote.steps.find(
  (step) => step.name === "Commit reconciled files and UUID state",
)!.run!;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(CLONE, path)), { recursive: true });
  writeFileSync(join(CLONE, path), content);
}

// A fresh bare origin and clone holding `files`, with every org's state.
function repoReset(
  orgs: string[],
  pipelines: Record<string, string[]>,
  files: Record<string, string>,
): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", ORIGIN]);
  execFileSync("git", ["clone", "-q", ORIGIN, CLONE], { stdio: "ignore" });
  const pipelineYaml = Object.entries(pipelines)
    .map(
      ([name, list]) =>
        `  ${name}:\n    orgs: [${list.join(", ")}]\n    resources: ['**/*']`,
    )
    .join("\n");
  write(
    "promotion.yml",
    `version: 1\norgs:\n${orgs.map((org) => `  ${org}: {}`).join("\n")}\npipelines:\n${pipelineYaml}\n`,
  );
  for (const org of orgs) write(`state/${org}/state.json`, "{}\n");
  // The repository carries the workflow whose commit step runs here: the
  // engine moves state only under a commit step it can see stages state/.
  write(
    ".github/workflows/promotion.yml",
    readFileSync(join(REPO, ".github/workflows/promotion.yml"), "utf8"),
  );
  write(".gitignore", "tmp/\n.env.*\n");
  for (const [path, content] of Object.entries(files)) write(path, content);
  git(CLONE, "add", "-A");
  git(CLONE, "commit", "-qm", "base");
  git(CLONE, "push", "-q", "origin", "main");
}

// promote --all --apply: every apply writes its org's state (as apply.ts
// does), and the `failAt`-th apply (1-based) then fails.
async function promote(
  failAt?: number,
  statePath = (org: string) => `state/${org}/state.json`,
): Promise<string | undefined> {
  let applies = 0;
  process.env.VAPI_PROMOTION_TOKENS = '{"a":"t","b":"t","c":"t"}';
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(["--all", "--apply"], {
      childRun: (script: string, org: string) => {
        if (script !== "src/apply.ts") return;
        write(
          statePath(org),
          `{"assistants":{"intake":{"uuid":"uuid-${org}"}}}\n`,
        );
        if (++applies === failAt)
          throw new Error(`${script} failed for ${org}`);
      },
    });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    console.log = log;
  }
}

function commitStep(outcome: "success" | "failure"): {
  code: number | null;
  output: string;
} {
  const result = spawnSync("bash", ["-e", "-c", COMMIT_STEP], {
    cwd: CLONE,
    encoding: "utf8",
    env: { ...process.env, PROMOTION_OUTCOME: outcome },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function originFile(path: string): string | undefined {
  try {
    return git(ORIGIN, "show", `main:${path}`);
  } catch {
    return undefined;
  }
}

const INTAKE = (who: string) => `name: Intake (${who})\n`;

test("a failed promotion still pushes state and the files of transitions that applied, not the failed rewrite", async () => {
  repoReset(
    ["a", "b", "c"],
    { release: ["a", "b", "c"] },
    {
      "resources/a/assistants/intake.yml": INTAKE("a"),
      // c already tracks a file, so the failed b → c rewrite leaves a tracked
      // modification behind — what made the rebase refuse before.
      "resources/c/assistants/intake.yml": INTAKE("old c"),
    },
  );
  const failure = await promote(2);
  const step = commitStep("failure");
  assert.deepEqual(
    {
      failure,
      code: step.code,
      b: originFile("resources/b/assistants/intake.yml"),
      c: originFile("resources/c/assistants/intake.yml"),
      bState: originFile("state/b/state.json"),
      cState: originFile("state/c/state.json"),
    },
    {
      failure: "src/apply.ts failed for c",
      code: 0,
      b: INTAKE("a"),
      c: INTAKE("old c"),
      bState: '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
      cState: '{"assistants":{"intake":{"uuid":"uuid-c"}}}\n',
    },
  );
});

test("when a later transition into the same org fails, the earlier transition's content is what gets committed", async () => {
  // p1: a → c applies; p2: b → c rewrites the same file, then fails.
  repoReset(
    ["a", "b", "c"],
    { p1: ["a", "c"], p2: ["b", "c"] },
    {
      "resources/a/assistants/intake.yml": INTAKE("a"),
      "resources/b/assistants/intake.yml": INTAKE("b"),
    },
  );
  const failure = await promote(2);
  const step = commitStep("failure");
  assert.deepEqual(
    [failure, step.code, originFile("resources/c/assistants/intake.yml")],
    ["src/apply.ts failed for c", 0, INTAKE("a")],
  );
});

test("a successful promotion commits every resource change and the state", async () => {
  repoReset(
    ["a", "b"],
    { release: ["a", "b"] },
    {
      "resources/a/assistants/intake.yml": INTAKE("a"),
    },
  );
  const failure = await promote();
  const step = commitStep("success");
  assert.deepEqual(
    [
      failure,
      step.code,
      originFile("resources/b/assistants/intake.yml"),
      originFile("state/b/state.json"),
    ],
    [
      undefined,
      0,
      INTAKE("a"),
      '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
    ],
  );
});

test("a promotion that changed nothing pushes nothing", async () => {
  repoReset(
    ["a", "b"],
    { release: ["a", "b"] },
    {
      "resources/a/assistants/intake.yml": INTAKE("a"),
      "resources/b/assistants/intake.yml": INTAKE("a"),
    },
  );
  const head = git(ORIGIN, "rev-parse", "main");
  const failure = await promote();
  const step = commitStep("success");
  assert.deepEqual(
    [
      failure,
      step.code,
      step.output.includes("Promotion produced no Git changes."),
      git(ORIGIN, "rev-parse", "main"),
    ],
    [undefined, 0, true, head],
  );
});

// ── Repositories that still keep state at the root ───────────────────────

const OLD_STATE = (org: string) => `.vapi-state.${org}.json`;

// The fixture as a repository looked before state/ existed.
function repoResetOldLayout(): void {
  repoReset(
    ["a", "b"],
    { release: ["a", "b"] },
    { "resources/a/assistants/intake.yml": INTAKE("a") },
  );
  for (const org of ["a", "b"])
    git(CLONE, "mv", `state/${org}/state.json`, OLD_STATE(org));
  git(CLONE, "commit", "-qm", "old layout");
  git(CLONE, "push", "-q", "origin", "main");
}

test("a repository that has not moved its state still commits the root state file", async () => {
  repoResetOldLayout();
  // A CI run writes state in place (tests/state-layout.test.ts).
  const failure = await promote(undefined, OLD_STATE);
  const step = commitStep("success");
  assert.deepEqual(
    [
      failure,
      step.code,
      originFile(OLD_STATE("b")),
      originFile("state/b/state.json"),
      originFile("resources/b/assistants/intake.yml"),
    ],
    [
      undefined,
      0,
      '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
      undefined,
      INTAKE("a"),
    ],
    step.output,
  );
});

test("a move is committed whole: the old file's removal and the new file in one commit", async () => {
  repoResetOldLayout();
  const base = git(ORIGIN, "rev-parse", "main").trim();
  // What `npm run migrate` does before the promotion in the same run.
  for (const org of ["a", "b"]) stateLayoutPrepare(CLONE, org, {});
  const failure = await promote();
  const step = commitStep("success");
  assert.deepEqual(
    {
      failure,
      code: step.code,
      commits: git(ORIGIN, "rev-list", "--count", `${base}..main`).trim(),
      old: [originFile(OLD_STATE("a")), originFile(OLD_STATE("b"))],
      a: originFile("state/a/state.json"),
      b: originFile("state/b/state.json"),
    },
    {
      failure: undefined,
      code: 0,
      commits: "1",
      old: [undefined, undefined],
      a: "{}\n",
      b: '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
    },
    step.output,
  );
});

test("a failed promotion after a move still commits the move whole", async () => {
  repoResetOldLayout();
  for (const org of ["a", "b"]) stateLayoutPrepare(CLONE, org, {});
  const failure = await promote(1);
  const step = commitStep("failure");
  assert.deepEqual(
    [
      failure,
      step.code,
      originFile(OLD_STATE("b")),
      originFile("state/b/state.json"),
      originFile("state/a/state.json"),
    ],
    [
      "src/apply.ts failed for b",
      0,
      undefined,
      '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
      "{}\n",
    ],
    step.output,
  );
});

// The step as it was before state/ existed. It stages only the root files,
// so on a moved repository it would commit their removal and nothing else.
const OLD_COMMIT_STEP = [
  "set -euo pipefail",
  "git add -A -- ':(glob).vapi-state.*.json'",
  "git add -A -- resources",
  'git commit -qm "chore: record promoted Vapi state [skip promotion]"',
].join("\n");

test("the step from before state/ can't commit a moved repository, so the engine refuses to run under it", async () => {
  repoReset(
    ["a", "b"],
    { release: ["a", "b"] },
    { "resources/a/assistants/intake.yml": INTAKE("a") },
  );
  const head = git(ORIGIN, "rev-parse", "main");
  await promote();
  const old = spawnSync("bash", ["-e", "-c", OLD_COMMIT_STEP], {
    cwd: CLONE,
    encoding: "utf8",
  });
  write(
    ".github/workflows/promotion.yml",
    `jobs:\n  promote:\n    steps:\n      - run: |\n${OLD_COMMIT_STEP.replace(/^/gm, "          ")}\n`,
  );
  assert.deepEqual(
    [
      // git add fails on a pathspec that matches no file: nothing is
      // committed, and the UUIDs this run recorded never reach git.
      old.status,
      git(ORIGIN, "rev-parse", "main"),
      (() => {
        try {
          stateLayoutPrepare(CLONE, "b", { CI: "true" });
          return "ran";
        } catch (error) {
          return error instanceof StateLayoutError ? "stopped" : "other";
        }
      })(),
    ],
    [128, head, "stopped"],
    `${old.stdout}${old.stderr}`,
  );
});

// A repository whose own commit step stages the old state file through a
// script. The engine can't read that, so it must leave state where that
// script looks for it, on a person's machine and in the run.
const HELPER_COMMIT_STEP = [
  "set -euo pipefail",
  "./scripts/stage-state.sh",
  "git add -A -- resources",
  'git commit -qm "chore: record promoted Vapi state [skip promotion]"',
  "git push -q origin main",
].join("\n");

test("under a commit step the engine can't read, state stays at the root and keeps being committed", async () => {
  repoResetOldLayout();
  write(
    ".github/workflows/promotion.yml",
    `jobs:\n  promote:\n    steps:\n      - run: |\n${HELPER_COMMIT_STEP.replace(/^/gm, "          ")}\n`,
  );
  write(
    "scripts/stage-state.sh",
    "#!/bin/bash\ngit add -A -- ':(glob).vapi-state.*.json'\n",
  );
  spawnSync("chmod", ["+x", join(CLONE, "scripts/stage-state.sh")]);
  git(CLONE, "add", "-A");
  git(CLONE, "commit", "-qm", "ci: our own commit step");
  git(CLONE, "push", "-q", "origin", "main");
  // A command on a person's machine, then the run in CI.
  const local = ["a", "b"].flatMap((org) => stateLayoutPrepare(CLONE, org, {}));
  const run = ["a", "b"].flatMap((org) =>
    stateLayoutPrepare(CLONE, org, { CI: "true" }),
  );
  const failure = await promote(undefined, OLD_STATE);
  const step = spawnSync(
    "bash",
    [
      "-e",
      "-c",
      `git config user.name t && git config user.email t@example.com\n${HELPER_COMMIT_STEP}`,
    ],
    { cwd: CLONE, encoding: "utf8" },
  );
  assert.deepEqual(
    {
      held: [...local, ...run].every((line) => /stays where it is/.test(line)),
      notices: [local.length, run.length],
      failure,
      code: step.status,
      b: originFile(OLD_STATE("b")),
      folder: originFile("state/b/state.json"),
      // Nothing the run wrote is left uncommitted.
      leftovers: git(CLONE, "status", "--porcelain"),
    },
    {
      held: true,
      notices: [2, 2],
      failure: undefined,
      code: 0,
      b: '{"assistants":{"intake":{"uuid":"uuid-b"}}}\n',
      folder: undefined,
      leftovers: "",
    },
    `${step.stdout}${step.stderr}`,
  );
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
