import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rolloutMarkerParse } from "../src/rollout-marker.ts";
import { ROLLOUT_ORPHAN_AGE_MINUTES } from "../src/rollout-tick.ts";
import { RolloutFake } from "./rollout-fake.ts";

// rollout-cmd.ts binds its root at import.
const ROOT = mkdtempSync(join(tmpdir(), "rollout-cmd-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { rolloutCommandRun } = await import("../src/rollout-cmd.ts");

function write(path: string, content: string): void {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), content);
}

function fixtureReset(rollout = "{steps: [10, 100], intervalMinutes: 30}"): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  write(
    "promotion.yml",
    `version: 1\norgs:\n  staging: {}\n  prod:${rollout ? `\n    rollout: ${rollout}` : " {}"}\npipelines:\n  release:\n    orgs: [staging, prod]\n    resources: ['**/*']\n`,
  );
  write(
    ".vapi-state.prod.json",
    `${JSON.stringify({ assistants: { intake: { uuid: "intake-prod" }, billing: { uuid: "billing-prod" } } })}\n`,
  );
}

interface Run {
  error?: Error;
  output: string;
}

interface RolloutOptions {
  // How long after intake's newest row the run happens.
  minutes?: number;
  // A step summary file; unset otherwise, so CI's own summary stays clean.
  summary?: string;
}

async function rollout(
  args: string[],
  fake: RolloutFake,
  { minutes = 31, summary }: RolloutOptions = {},
): Promise<Run> {
  const run: Run = { output: "" };
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({ staging: "t", prod: "t" });
  if (summary) process.env.GITHUB_STEP_SUMMARY = summary;
  else delete process.env.GITHUB_STEP_SUMMARY;
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    run.output += `${parts.join(" ")}\n`;
  };
  try {
    await rolloutCommandRun(args, {
      rolloutApi: () => fake.api(),
      now: () => Date.parse(fake.latest("intake-prod")?.createdAt ?? "2026-10-30T12:00:00Z") + minutes * 60_000,
    });
  } catch (error) {
    run.error = error as Error;
  } finally {
    console.log = log;
  }
  return run;
}

function stepFake(): RolloutFake {
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [
      { assistantVersion: "v1", percentage: 90 },
      { assistantVersion: "v2", percentage: 10 },
    ],
    description: "gitops-rollout step from=v1 to=v2 step=1/2",
  });
  return fake;
}

test("advance: an elapsed step moves on, with the rollout-complete label at 100%", async () => {
  fixtureReset();
  const fake = stepFake();
  const run = await rollout(["advance"], fake);
  assert.equal(run.error, undefined);
  assert.deepEqual(
    fake.writes.map((write) => write.command),
    ["manual", "rollout-complete"],
  );
  assert.deepEqual(fake.latest("intake-prod")?.targets, [
    { assistantVersion: "v2", percentage: 100 },
  ]);
});

test("advance: a split changed by someone else stops that ramp and fails the run once", async () => {
  fixtureReset();
  const fake = stepFake();
  fake.beforeCreate = () =>
    fake.manualWrite({
      assistantId: "intake-prod",
      targets: [{ assistantVersion: "v1", percentage: 100 }],
      description: "dashboard rollback",
    });
  const run = await rollout(["advance"], fake);
  assert.equal(fake.latest("intake-prod")?.description, "dashboard rollback");
  assert.match(run.output, /intake: the split changed meanwhile \(dashboard rollback\); left for a human/);
  assert.match(run.error?.message ?? "", /1 ramps overdue:\n  - prod\/intake: the split changed meanwhile/);
  // The next tick sees an unmarked row, so it no longer fails.
  fake.beforeCreate = undefined;
  assert.equal((await rollout(["advance"], fake)).error, undefined);
});

test("advance: writes each ramp's state to the step summary", async () => {
  fixtureReset();
  const fake = stepFake();
  const summary = join(ROOT, "summary.md");
  const run = await rollout(["advance"], fake, { summary });
  assert.equal(run.error, undefined);
  assert.equal(
    readFileSync(summary, "utf8"),
    "## Rollout advance\n\n1 ramps, none overdue.\n\n| Org | Assistant | State | Health gate |\n| --- | --- | --- | --- |\n| prod | intake | v2 at 100%, ramp complete |  |\n",
  );
});

test("advance: a stale pin from a killed run fails the run; a hold does not", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [{ assistantVersion: "v1", percentage: 100 }],
    description: "gitops-rollout pin from=v1 latest=v1 prev=marked run=r",
  });
  fake.assistantAdd("billing-prod", "v3");
  fake.manualWrite({
    assistantId: "billing-prod",
    targets: [{ assistantVersion: "v2", percentage: 100 }],
    description: "gitops-rollout hold from=v1 to=v2 hold=v3",
  });
  const run = await rollout(["advance"], fake, {
    minutes: ROLLOUT_ORPHAN_AGE_MINUTES + 1,
  });
  assert.match(run.error?.message ?? "", /^1 ramps overdue:\n  - prod\/intake: pinned on v1/);
  assert.doesNotMatch(run.error?.message ?? "", /billing/);
});

test("status: an overdue ramp is listed, not failed", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [{ assistantVersion: "v1", percentage: 100 }],
    description: "gitops-rollout pin from=v1 latest=v1 prev=marked run=r",
  });
  const run = await rollout(["status"], fake, {
    minutes: ROLLOUT_ORPHAN_AGE_MINUTES + 1,
  });
  assert.equal(run.error, undefined);
  assert.match(run.output, /intake: pinned on v1/);
});

test("advance: a 409 that is our own committed write counts as done", async () => {
  fixtureReset();
  const fake = stepFake();
  // The write commits, then the response is lost as a 409 on the retry path.
  fake.beforeCreate = (write) => {
    fake.beforeCreate = undefined;
    fake.manualWrite({ ...write, expectedCurrentAllocationId: undefined });
  };
  const run = await rollout(["advance"], fake);
  assert.equal(run.error, undefined);
  assert.match(run.output, /intake: v2 at 100%, ramp complete/);
});

test("advance: an org without traffic splitting is skipped, not failed", async () => {
  fixtureReset();
  const fake = stepFake();
  fake.splittingEnabled = false;
  const run = await rollout(["advance"], fake);
  assert.equal(run.error, undefined);
  assert.match(run.output, /skipped: traffic splitting is not enabled/);
  assert.equal(fake.writes.length, 1);
});

test("advance: with no org rolling out, it does nothing and succeeds", async () => {
  fixtureReset("");
  const fake = stepFake();
  const run = await rollout(["advance"], fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.probes, 0);
});

test("abort: puts an active ramp back on its old version", async () => {
  fixtureReset();
  const fake = stepFake();
  const run = await rollout(["abort", "--org", "prod", "--assistant", "intake"], fake);
  assert.equal(run.error, undefined);
  assert.deepEqual(
    [
      fake.writes.at(-1)?.command,
      rolloutMarkerParse(fake.latest("intake-prod")?.description)?.kind,
      fake.latest("intake-prod")?.targets,
    ],
    ["rollout-abort", "abort", [{ assistantVersion: "v1", percentage: 100 }]],
  );
});

test("abort: retries once when a tick lands first", async () => {
  fixtureReset();
  const fake = stepFake();
  fake.beforeCreate = () => {
    fake.beforeCreate = undefined;
    fake.manualWrite({
      assistantId: "intake-prod",
      targets: [{ assistantVersion: "v2", percentage: 100 }],
      description: "gitops-rollout complete from=v1 to=v2",
    });
  };
  const run = await rollout(["abort", "--org", "prod"], fake);
  assert.equal(run.error, undefined);
  assert.equal(rolloutMarkerParse(fake.latest("intake-prod")?.description)?.kind, "abort");
});

test("abort: needs --org", async () => {
  fixtureReset();
  const run = await rollout(["abort"], stepFake());
  assert.match(run.error?.message ?? "", /abort needs --org/);
});

test("status: lists a ramp without writing", async () => {
  fixtureReset();
  const fake = stepFake();
  const run = await rollout(["status"], fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.writes.length, 1);
  assert.match(run.output, /intake: v2 at 100%, ramp complete/);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("advance: a gated step reads its window's health once it is due", async () => {
  fixtureReset("{steps: [10, 100], intervalMinutes: 30, healthGate: {minCalls: 5}}");
  const fake = stepFake();
  fake.health = [
    { version: "v1", calls: 90, errors: 0 },
    { version: "v2", calls: 10, errors: 9 },
  ];
  const run = await rollout(["advance"], fake);
  assert.equal(run.error, undefined);
  assert.equal(rolloutMarkerParse(fake.latest("intake-prod")?.description)?.kind, "abort");
  assert.deepEqual(fake.healthWindows, [
    { from: "2026-10-30T12:00:00.000Z", to: "2026-10-30T12:31:00.000Z" },
  ]);
});
