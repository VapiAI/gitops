import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ci.yml's "Validate resources" job runs `validate` on every org before
// merge, with no secrets. These tests run the job's real step (read from
// ci.yml, run with bash) against a copy of the engine and fixture orgs.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const STARTER = join(REPO, "examples", "starter", "resources", "starter");
const WORKFLOW_TEXT = readFileSync(
  join(REPO, ".github/workflows/ci.yml"),
  "utf8",
);

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
}

const JOB = (
  parseYaml(WORKFLOW_TEXT) as { jobs: { validate: { steps: Step[] } } }
).jobs.validate;
const FOUND = JOB.steps.find((s) => s.name === "Validate every org");
assert.ok(
  FOUND,
  'ci.yml has no "Validate every org" step; update this test if it was renamed',
);
const STEP: Step = FOUND;

// Run the step in a scratch repository holding the given org folders.
function validateStepRun(orgs: Record<string, (dir: string) => void>): {
  code: number | null;
  output: string;
} {
  const root = mkdtempSync(join(tmpdir(), "vapi-ci-validate-"));
  try {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    mkdirSync(join(root, "resources"));
    // A file at the top of resources/ is not an org.
    writeFileSync(join(root, "resources", ".vapi-ignore.example"), "");
    for (const [org, fill] of Object.entries(orgs)) {
      const dir = join(root, "resources", org);
      mkdirSync(dir);
      fill(dir);
    }
    // Only what the runner would have: no inherited Vapi keys.
    const result = spawnSync("bash", ["-c", STEP.run!], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...STEP.env },
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const starterCopy = (dir: string) => cpSync(STARTER, dir, { recursive: true });

const longNameAdd = (dir: string) => {
  starterCopy(dir);
  writeFileSync(
    join(dir, "assistants", "front-desk-overflow.yml"),
    "name: Front Desk Overflow Assistant For Weekend Calls\n",
  );
};

test("validate step passes when there are no org folders", () => {
  const run = validateStepRun({});
  assert.deepEqual(
    [run.code, run.output.includes("nothing to validate")],
    [0, true],
    run.output,
  );
});

test("validate step passes when every org is valid", () => {
  const run = validateStepRun({
    clinic: starterCopy,
    "clinic-dev": starterCopy,
  });
  assert.deepEqual(
    [
      run.code,
      /Validated 2 org\(s\): (clinic clinic-dev|clinic-dev clinic)\n/.test(
        run.output,
      ),
      // The starter is the file new users copy: no warnings either.
      run.output.split("No validation issues.").length - 1,
    ],
    [0, true, 2],
    run.output,
  );
});

test("validate step fails naming only the invalid org, after checking all of them", () => {
  const run = validateStepRun({
    clinic: longNameAdd,
    "clinic-dev": starterCopy,
  });
  assert.deepEqual(
    {
      code: run.code,
      bothValidated: [
        "::group::Validate clinic\n",
        "::group::Validate clinic-dev\n",
      ].every((group) => run.output.includes(group)),
      reason: run.output.includes("Vapi caps at 40"),
      error: run.output.includes("::error::Validation failed for: clinic."),
    },
    { code: 1, bothValidated: true, reason: true, error: true },
    run.output,
  );
});

test("validate step fails on an org folder that isn't a valid org name", () => {
  const run = validateStepRun({ Clinic_Prod: starterCopy });
  assert.deepEqual(
    [
      run.code,
      run.output.includes("::error::Validation failed for: Clinic_Prod."),
    ],
    [1, true],
    run.output,
  );
});

test("validate job gets no secrets and keeps no credentials", () => {
  const workflow = parseYaml(WORKFLOW_TEXT) as {
    on: Record<string, unknown>;
    jobs: { validate: Record<string, unknown> };
  };
  assert.deepEqual(
    {
      // Fork code runs in this job, so it must never get the privileged trigger.
      privilegedTrigger: "pull_request_target" in workflow.on,
      // Scoped to this job, and catches secrets.X, secrets['X'],
      // toJSON(secrets) and `secrets: inherit`.
      secrets: /\bsecrets\b/.test(JSON.stringify(workflow.jobs.validate)),
      permissions: workflow.jobs.validate.permissions,
      env: STEP.env,
      checkout: JOB.steps.find((s) => s.uses?.startsWith("actions/checkout"))
        ?.with,
    },
    {
      privilegedTrigger: false,
      secrets: false,
      permissions: undefined,
      // A placeholder key, and an unroutable host so nothing can be sent.
      env: {
        VAPI_PRIVATE_API_KEY: "validate-only-never-sent",
        VAPI_BASE_URL: "http://127.0.0.1:9",
      },
      checkout: { "persist-credentials": false },
    },
  );
});
