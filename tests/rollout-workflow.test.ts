import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ROLLOUT_ORPHAN_AGE_MINUTES } from "../src/rollout-tick.ts";

// Runs the workflows' real shell steps with an `npm` stub that records its
// arguments, so the dispatch inputs are checked by what they run.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "rollout-workflow-"));

interface Step {
  name?: string;
  run?: string;
  "timeout-minutes"?: number;
}

function stepsRead(file: string, job: string): Step[] {
  const workflow = parseYaml(
    readFileSync(join(REPO, ".github/workflows", file), "utf8"),
  ) as { jobs: Record<string, { steps: Step[] }> };
  return workflow.jobs[job]!.steps;
}

const RECONCILE = stepsRead("promotion.yml", "promote").find(
  (step) => step.name === "Reconcile configured promotions",
)!;
const ROLLOUT_RUN = stepsRead("rollout.yml", "rollout").find(
  (step) => step.name === "Run the rollout",
)!.run!;

// Runs `script` with bash in a directory holding promotion.yml and an npm
// stub; returns the npm arguments, or the failure output.
function runStep(
  script: string,
  env: Record<string, string>,
): { args?: string; failure?: string } {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, "bin"), { recursive: true });
  writeFileSync(join(WORK, "promotion.yml"), "version: 1\n");
  const stub = join(WORK, "bin", "npm");
  writeFileSync(stub, `#!/bin/bash\necho "$*" > "${join(WORK, "npm-args")}"\n`);
  chmodSync(stub, 0o755);
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: WORK,
    encoding: "utf8",
    env: {
      PATH: `${join(WORK, "bin")}:${process.env.PATH}`,
      VAPI_PROMOTION_TOKENS: '{"prod":"t"}',
      ...env,
    },
  });
  if (result.status !== 0) return { failure: result.stdout + result.stderr };
  return { args: readFileSync(join(WORK, "npm-args"), "utf8").trim() };
}

// GitHub sets every variable in the step's env:, empty when no input was given.
const INPUTS = { PIPELINE: "", SOURCE_ORG: "", TARGET_ORG: "", ROLLOUT: "" };
const DISPATCH = { GITHUB_EVENT_NAME: "workflow_dispatch", ...INPUTS };
const ONE = { PIPELINE: "release", SOURCE_ORG: "staging", TARGET_ORG: "prod" };

for (const [label, env, expected] of [
  ["default ramps", { ROLLOUT: "default" }, "run promote -- --apply --all"],
  ["an empty input ramps", {}, "run promote -- --apply --all"],
  ["no-rollout publishes at once", { ROLLOUT: "no-rollout" }, "run promote -- --apply --no-rollout --all"],
  [
    "override pins over one transition's manual split",
    { ROLLOUT: "override", ...ONE },
    "run promote -- --apply --rollout-override --pipeline release --from staging --to prod",
  ],
] as const) {
  test(`promotion dispatch: ${label}`, () => {
    assert.deepEqual(runStep(RECONCILE.run!, { ...DISPATCH, ...env }), {
      args: expected,
    });
  });
}

test("promotion dispatch: override without pipeline, from and to is refused", () => {
  assert.match(
    runStep(RECONCILE.run!, { ...DISPATCH, ROLLOUT: "override" }).failure ?? "",
    /override needs pipeline, from and to/,
  );
});

test("a push-triggered promotion never passes a rollout flag", () => {
  assert.deepEqual(
    runStep(RECONCILE.run!, {
      ...INPUTS,
      GITHUB_EVENT_NAME: "push",
      ROLLOUT: "override",
    }),
    { args: "run promote -- --all --apply" },
  );
});

test("the orphan-pin age outlasts the promotion step's timeout", () => {
  // Pins exist only inside this step, so no running promotion owns a pin
  // older than its timeout; raising one means raising the other.
  assert.ok(RECONCILE["timeout-minutes"]! < ROLLOUT_ORPHAN_AGE_MINUTES);
});

for (const [label, env, expected] of [
  [
    "a scheduled tick advances",
    { ACTION: "", ORG: "", ASSISTANT: "" },
    "run rollout -- advance",
  ],
  [
    "an abort names its org and assistant",
    { ACTION: "abort", ORG: "prod", ASSISTANT: "intake" },
    "run rollout -- abort --org prod --assistant intake",
  ],
  ["status for one org", { ACTION: "status", ORG: "prod" }, "run rollout -- status --org prod"],
] as const) {
  test(`rollout workflow: ${label}`, () => {
    assert.deepEqual(runStep(ROLLOUT_RUN, env), { args: expected });
  });
}

test.after(() => rmSync(WORK, { recursive: true, force: true }));
