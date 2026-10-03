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
  for (const org of orgs) write(`.vapi-state.${org}.json`, "{}\n");
  write(".gitignore", "tmp/\n.env.*\n");
  for (const [path, content] of Object.entries(files)) write(path, content);
  git(CLONE, "add", "-A");
  git(CLONE, "commit", "-qm", "base");
  git(CLONE, "push", "-q", "origin", "main");
}

// promote --all --apply: every apply writes its org's state (as apply.ts
// does), and the `failAt`-th apply (1-based) then fails.
async function promote(failAt?: number): Promise<string | undefined> {
  let applies = 0;
  process.env.VAPI_PROMOTION_TOKENS = '{"a":"t","b":"t","c":"t"}';
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(["--all", "--apply"], {
      childRun: (script: string, org: string) => {
        if (script !== "src/apply.ts") return;
        write(
          `.vapi-state.${org}.json`,
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
      bState: originFile(".vapi-state.b.json"),
      cState: originFile(".vapi-state.c.json"),
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
      originFile(".vapi-state.b.json"),
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

test.after(() => rmSync(WORK, { recursive: true, force: true }));
