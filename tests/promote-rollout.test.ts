import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RolloutFake } from "./rollout-fake.ts";

// promote-cmd.ts binds its root at import, so one fixture repo serves the
// file; each test resets it.
const ROOT = mkdtempSync(join(tmpdir(), "promote-rollout-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { promotionCommandRun } = await import("../src/promote-cmd.ts");

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), content);
}

// staging → prod, where prod rolls out gradually unless `rollout` is false.
function fixtureReset(rollout = "{}"): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  write(
    "promotion.yml",
    `version: 1\norgs:\n  staging: {}\n  prod:\n${rollout ? `    rollout: ${rollout}\n` : "    {}\n"}pipelines:\n  release:\n    orgs: [staging, prod]\n    resources: ['**/*']\n`,
  );
  write("resources/staging/assistants/intake.yml", "name: Intake v2\n");
  write("resources/prod/assistants/intake.yml", "name: Intake v1\n");
  write(".vapi-state.staging.json", "{}\n");
  write(
    ".vapi-state.prod.json",
    `${JSON.stringify({ assistants: { intake: { uuid: "intake-prod" } } })}\n`,
  );
  write(".gitignore", "tmp/\n.env.*\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
}

async function promote(
  args: string[],
  fake: RolloutFake,
  childRun: (script: string, org: string) => void = () => {},
): Promise<Error | undefined> {
  // promote reads the tokens, then deletes the variable.
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    staging: "t",
    prod: "t",
  });
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(args, { childRun, rolloutApi: () => fake.api() });
    return undefined;
  } catch (error) {
    return error as Error;
  } finally {
    console.log = log;
  }
}

test("probe: a rollout org without traffic splitting stops the run before anything applies", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.splittingEnabled = false;
  const scripts: string[] = [];
  const failure = await promote(["--all", "--apply"], fake, (script) => {
    scripts.push(script);
  });
  assert.match(
    failure?.message ?? "",
    /Traffic splitting is not enabled for prod/,
  );
  assert.deepEqual(scripts, []);
});

test("probe: an org without rollout: is never probed", async () => {
  fixtureReset("");
  const fake = new RolloutFake();
  const failure = await promote(["--all", "--apply"], fake);
  assert.equal(failure, undefined);
  assert.equal(fake.probes, 0);
});

test("probe: a plan without --apply makes no API call", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  const failure = await promote(["--all"], fake);
  assert.equal(failure, undefined);
  assert.equal(fake.probes, 0);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
