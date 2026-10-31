import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rolloutMarkerParse } from "../src/rollout-marker.ts";
import { RolloutFake } from "./rollout-fake.ts";

// promote-cmd.ts binds its root at import, so one fixture repo serves the
// file; each test resets it.
const ROOT = mkdtempSync(join(tmpdir(), "promote-rollout-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { APPLIED_PATHS_FILE, promotionCommandRun } = await import(
  "../src/promote-cmd.ts"
);

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

const CHECK_FILES: Record<string, string> = {
  "structuredOutputs/ok.yml": "name: ok\nschema:\n  type: boolean\n",
  "simulations/scenarios/s1.yml":
    "name: S1\ninstructions: Hi.\nevaluations:\n  - structuredOutputId: ok\n    comparator: '='\n    value: true\n    required: true\n",
  "simulations/personalities/calm.yml": "name: Calm\n",
  "simulations/tests/t1.yml": "name: T1\npersonalityId: calm\nscenarioId: s1\n",
};

interface FixtureArgs {
  // promotion.yml's prod rollout: value; "" for none.
  rollout?: string;
  // Assistant IDs changed in staging, and whether prod's state maps each.
  assistants?: Record<string, { mapped: boolean }>;
  // Gate promotions out of staging on a check.
  gated?: boolean;
}

// staging → prod. Each assistant differs between the orgs, so the plan
// updates it (or creates it in prod when unmapped).
function fixtureReset(args: FixtureArgs = {}): void {
  const rollout = args.rollout ?? "{}";
  const assistants = args.assistants ?? { intake: { mapped: true } };
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const staging = args.gated ? "\n    check: staging-core" : " {}";
  const prod = rollout ? `\n    rollout: ${rollout}` : " {}";
  write(
    "promotion.yml",
    `version: 1\norgs:\n  staging:${staging}\n  prod:${prod}\npipelines:\n  release:\n    orgs: [staging, prod]\n    resources: ['**/*']\n`,
  );
  if (args.gated) {
    write(
      "vapi-checks.yml",
      "version: 1\nchecks:\n  staging-core:\n    org: staging\n    targets: [assistants/intake]\n    simulations: [t1]\n",
    );
    for (const [path, content] of Object.entries(CHECK_FILES)) {
      write(`resources/staging/${path}`, content);
      write(`resources/prod/${path}`, content);
    }
  }
  const state: Record<string, { uuid: string }> = {};
  for (const [id, { mapped }] of Object.entries(assistants)) {
    write(`resources/staging/assistants/${id}.yml`, `name: ${id} new\n`);
    if (!mapped) continue;
    write(`resources/prod/assistants/${id}.yml`, `name: ${id} old\n`);
    state[id] = { uuid: `${id}-prod` };
  }
  write(".vapi-state.staging.json", "{}\n");
  write(".vapi-state.prod.json", `${JSON.stringify({ assistants: state })}\n`);
  write(".gitignore", "tmp/\n.env.*\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
}

interface Run {
  error?: Error;
  scripts: string[];
  checks: number;
  output: string;
}

interface ApplyFake {
  // uuid → version the apply publishes.
  publishes?: Record<string, string>;
  // Throw after publishing.
  fail?: boolean;
  // Runs inside the apply, after publishing.
  during?: () => void;
}

async function promote(
  args: string[],
  fake: RolloutFake,
  apply: ApplyFake = {},
  gate?: () => void,
): Promise<Run> {
  const run: Run = { scripts: [], checks: 0, output: "" };
  // promote reads the tokens, then deletes the variable.
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({ staging: "t", prod: "t" });
  const log = console.log;
  const warn = console.warn;
  console.log = (...parts: unknown[]) => {
    run.output += `${parts.join(" ")}\n`;
  };
  console.warn = console.log;
  try {
    await promotionCommandRun(args, {
      childRun: (script, org) => {
        run.scripts.push(`${script}@${org}`);
        if (script !== "src/apply.ts") return;
        for (const [uuid, version] of Object.entries(apply.publishes ?? {}))
          fake.publish(uuid, version);
        apply.during?.();
        if (apply.fail) throw new Error(`${script} failed for ${org}`);
      },
      checkRun: async () => {
        run.checks++;
        gate?.();
        return { outcome: "passed", reason: "1 of 1 simulations passed" };
      },
      rolloutApi: () => fake.api(),
    });
  } catch (error) {
    run.error = error as Error;
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return run;
}

const ALL = ["--all", "--apply"];

// Each write as `command kind targets`, e.g. `rollout-pin pin v1:100`.
function writesOf(fake: RolloutFake, uuid: string): string[] {
  return fake.writes
    .filter((write) => write.allocation.assistantId === uuid)
    .map(({ command, allocation }) =>
      [
        command,
        rolloutMarkerParse(allocation.description)?.kind ??
          allocation.allocationIntent,
        allocation.targets
          .map((target) => `${target.assistantVersion}:${target.percentage}`)
          .join(","),
      ]
        .filter(Boolean)
        .join(" "),
    );
}

function appliedPaths(): string[] {
  const file = join(ROOT, APPLIED_PATHS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]!);
}

test("probe: a rollout org without traffic splitting stops the run before anything applies", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.splittingEnabled = false;
  const run = await promote(ALL, fake);
  assert.match(run.error?.message ?? "", /Traffic splitting is not enabled for prod/);
  assert.deepEqual(run.scripts, []);
});

test("probe: an org without rollout: is never probed", async () => {
  fixtureReset({ rollout: "" });
  const fake = new RolloutFake();
  const run = await promote(ALL, fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.probes, 0);
});

test("probe: a plan without --apply makes no API call", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  const run = await promote(["--all"], fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.probes + fake.reads, 0);
});

test("a publish under follow-latest is pinned first, lands at 0%, then takes step 1", async () => {
  fixtureReset({ rollout: "{steps: [2, 100]}" });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  const run = await promote(ALL, fake, { publishes: { "intake-prod": "v2" } });
  assert.equal(run.error, undefined);
  // No system follow-latest row: the publish found the pin, not follow-latest.
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "rollout-pin pin v1:100",
    "rollout-step step v1:98,v2:2",
  ]);
  assert.deepEqual(rolloutMarkerParse(fake.latest("intake-prod")?.description), {
    kind: "step",
    from: "v1",
    to: "v2",
    step: 1,
    steps: 2,
    run: process.env.VAPI_GITOPS_RUN_ID,
  });
});

test("a promotion that publishes nothing undoes its pin back to follow-latest, with no targets", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  const run = await promote(ALL, fake);
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "rollout-pin pin v1:100",
    "rollout-restore follow-latest",
  ]);
});

test("when the apply fails after publishing one assistant, it still takes step 1 and the other's pin is undone", async () => {
  fixtureReset({
    assistants: { intake: { mapped: true }, billing: { mapped: true } },
  });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.assistantAdd("billing-prod", "v4");
  const run = await promote(ALL, fake, {
    publishes: { "intake-prod": "v2" },
    fail: true,
  });
  assert.match(run.error?.message ?? "", /src\/apply.ts failed for prod/);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "rollout-pin pin v1:100",
    "rollout-step step v1:99,v2:1",
  ]);
  assert.deepEqual(writesOf(fake, "billing-prod"), [
    "rollout-pin pin v4:100",
    "rollout-restore follow-latest",
  ]);
  // The failed transition's files aren't recorded as applied.
  assert.deepEqual(appliedPaths(), []);
});

test("a step-1 failure after a successful apply records the applied files, then fails", async () => {
  fixtureReset({
    assistants: { billing: { mapped: true }, intake: { mapped: true } },
  });
  const fake = new RolloutFake();
  fake.assistantAdd("billing-prod", "v4");
  fake.assistantAdd("intake-prod", "v1");
  // Writes: pin billing, pin intake, step billing, then intake's step fails.
  fake.failCreate = { nth: 4, status: 400, error: "bad request" };
  const run = await promote(ALL, fake, {
    publishes: { "billing-prod": "v5", "intake-prod": "v2" },
  });
  assert.match(run.error?.message ?? "", /Gradual rollout into prod:\n {2}- intake:/);
  assert.deepEqual(appliedPaths().sort(), [
    "resources/prod/assistants/billing.yml",
    "resources/prod/assistants/intake.yml",
  ]);
});

test("a split set outside gitops is refused before the gate, the apply and any write", async () => {
  fixtureReset({ gated: true });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [
      { assistantVersion: "v1", percentage: 95 },
      { assistantVersion: "v2", percentage: 5 },
    ],
  });
  const run = await promote(ALL, fake);
  assert.match(
    run.error?.message ?? "",
    /refused; nothing was promoted:\n {2}- intake: a split set outside gitops \(v1 95% \/ v2 5%\)/,
  );
  assert.equal(run.checks, 0);
  // Only the read-only bindings pulls ran.
  assert.deepEqual(run.scripts, ["src/pull.ts@staging", "src/pull.ts@prod"]);
  assert.deepEqual(writesOf(fake, "intake-prod"), ["manual explicit v1:95,v2:5"]);
  assert.equal(
    readFileSync(join(ROOT, "resources/prod/assistants/intake.yml"), "utf8"),
    "name: intake old\n",
  );
});

test("an override pins a manual split on the version with the most traffic, not the canary", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [
      { assistantVersion: "v1", percentage: 95 },
      { assistantVersion: "v2", percentage: 5 },
    ],
  });
  const run = await promote(
    [
      "--pipeline",
      "release",
      "--from",
      "staging",
      "--to",
      "prod",
      "--apply",
      "--rollout-override",
    ],
    fake,
    { publishes: { "intake-prod": "v3" } },
  );
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "manual explicit v1:95,v2:5",
    "rollout-pin pin v1:100",
    "rollout-step step v1:99,v3:1",
  ]);
  assert.match(run.output, /replacing v1 95% \/ v2 5% with v1 100%/);
});

test("--rollout-override is refused with --all", async () => {
  fixtureReset();
  const run = await promote(["--all", "--apply", "--rollout-override"], new RolloutFake());
  assert.match(run.error?.message ?? "", /cannot be combined with --all/);
});

test("a pin that keeps failing on the second of three assistants undoes the first and never applies", async () => {
  fixtureReset({
    assistants: {
      a1: { mapped: true },
      a2: { mapped: true },
      a3: { mapped: true },
    },
  });
  const fake = new RolloutFake();
  for (const id of ["a1", "a2", "a3"]) fake.assistantAdd(`${id}-prod`, "v1");
  fake.failCreate = { nth: 2, status: 400, error: "bad request" };
  const run = await promote(ALL, fake);
  assert.match(run.error?.message ?? "", /stopped before publishing/);
  assert.deepEqual(run.scripts.filter((script) => script.startsWith("src/apply")), []);
  assert.deepEqual(writesOf(fake, "a1-prod"), [
    "rollout-pin pin v1:100",
    "rollout-restore follow-latest",
  ]);
  assert.deepEqual(writesOf(fake, "a2-prod"), []);
});

test("a pin that loses a race is retried once against a fresh read", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.manualWrite({ assistantId: "intake-prod", allocationIntent: "follow-latest" });
  let raced = false;
  fake.beforeCreate = () => {
    if (raced) return;
    raced = true;
    fake.manualWrite({ assistantId: "intake-prod", allocationIntent: "follow-latest" });
  };
  const run = await promote(ALL, fake, { publishes: { "intake-prod": "v2" } });
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "manual follow-latest",
    "manual follow-latest",
    "rollout-pin pin v1:100",
    "rollout-step step v1:99,v2:1",
  ]);
});

test("an assistant managed by Vapi for CX is refused in preflight", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1", true);
  const run = await promote(ALL, fake);
  assert.match(run.error?.message ?? "", /intake: managed by Vapi for CX/);
  assert.deepEqual(run.scripts.filter((script) => script.startsWith("src/apply")), []);
});

test("an abort written during the apply is left in place", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  const run = await promote(ALL, fake, {
    publishes: { "intake-prod": "v2" },
    during: () =>
      fake.manualWrite({
        assistantId: "intake-prod",
        targets: [{ assistantVersion: "v1", percentage: 100 }],
        description: "gitops-rollout abort from=v1 to=v2 step=1/6",
      }),
  });
  assert.equal(run.error, undefined);
  assert.equal(rolloutMarkerParse(fake.latest("intake-prod")?.description)?.kind, "abort");
  assert.match(run.output, /aborted meanwhile; left aborted/);
});

test("a deleted assistant gets no pin and the run succeeds", async () => {
  fixtureReset();
  // The source state's mapping is the tombstone that authorizes the deletion.
  write(".vapi-state.staging.json", `${JSON.stringify({ assistants: { gone: { uuid: "gone-staging" } } })}\n`);
  write(
    ".vapi-state.prod.json",
    `${JSON.stringify({ assistants: { intake: { uuid: "intake-prod" }, gone: { uuid: "gone-prod" } } })}\n`,
  );
  write("resources/prod/assistants/gone.yml", "name: gone\n");
  git("add", "-A");
  git("commit", "-qm", "gone deleted from staging");
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.assistantAdd("gone-prod", "v3");
  const run = await promote(ALL, fake, { publishes: { "intake-prod": "v2" } });
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "gone-prod"), []);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "rollout-pin pin v1:100",
    "rollout-step step v1:99,v2:1",
  ]);
});

test("an assistant with no state UUID goes live on create and isn't pinned", async () => {
  fixtureReset({ assistants: { fresh: { mapped: false } } });
  const fake = new RolloutFake();
  const run = await promote(ALL, fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.writes.length, 0);
  assert.match(run.output, /fresh: new in prod, live on create/);
});

test("an assistant deleted in the dashboard is skipped with a message", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  const run = await promote(ALL, fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.writes.length, 0);
  assert.match(run.output, /intake: not found/);
});

test("the gate's window is re-read: a split set during the gate is refused with nothing pinned", async () => {
  fixtureReset({ gated: true });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  const run = await promote(ALL, fake, {}, () =>
    fake.manualWrite({
      assistantId: "intake-prod",
      targets: [
        { assistantVersion: "v1", percentage: 50 },
        { assistantVersion: "v0", percentage: 50 },
      ],
    }),
  );
  assert.equal(run.checks, 1);
  assert.match(run.error?.message ?? "", /a split set outside gitops/);
  assert.deepEqual(writesOf(fake, "intake-prod"), ["manual explicit v1:50,v0:50"]);
  assert.equal(
    readFileSync(join(ROOT, "resources/prod/assistants/intake.yml"), "utf8"),
    "name: intake old\n",
  );
});

test("an abort written during the gate survives a promotion that publishes nothing", async () => {
  fixtureReset({ gated: true });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  const abort = "gitops-rollout abort from=v1 to=v2 step=3/6";
  const run = await promote(ALL, fake, {}, () =>
    fake.manualWrite({
      assistantId: "intake-prod",
      targets: [{ assistantVersion: "v1", percentage: 100 }],
      description: abort,
    }),
  );
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "manual abort v1:100",
    "rollout-pin pin v1:100",
    "rollout-restore abort v1:100",
  ]);
  assert.equal(fake.latest("intake-prod")?.description, abort);
});

test("without a gate, preflight reads each assistant once", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  await promote(ALL, fake);
  // Preflight 2 (assistant, allocation), the pin's read-back 1 (no prior row
  // to compare-and-set against), finish 1. A gate adds a second round of 2.
  assert.equal(fake.reads, 4);
});

test("--no-rollout releases a published gitops-held assistant and leaves an unpublished abort alone", async () => {
  fixtureReset({
    assistants: { intake: { mapped: true }, billing: { mapped: true } },
  });
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.assistantAdd("billing-prod", "v7");
  for (const [uuid, from] of [
    ["intake-prod", "v1"],
    ["billing-prod", "v6"],
  ] as const)
    fake.manualWrite({
      assistantId: uuid,
      targets: [{ assistantVersion: from, percentage: 100 }],
      description: `gitops-rollout abort from=${from}`,
    });
  const run = await promote([...ALL, "--no-rollout"], fake, {
    publishes: { "intake-prod": "v3" },
  });
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "manual abort v1:100",
    "rollout-release release",
  ]);
  assert.deepEqual(writesOf(fake, "billing-prod"), ["manual abort v6:100"]);
  assert.equal(fake.probes, 0);
});

test("--no-rollout over a finished ramp publishes and writes nothing", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.manualWrite({
    assistantId: "intake-prod",
    allocationIntent: "follow-latest",
    description: "gitops-rollout release",
  });
  const run = await promote([...ALL, "--no-rollout"], fake, {
    publishes: { "intake-prod": "v3" },
  });
  assert.equal(run.error, undefined);
  assert.deepEqual(writesOf(fake, "intake-prod"), [
    "manual release",
    "system follow-latest",
  ]);
});

test("--no-rollout keeps a split set outside gitops and says the publish landed at 0%", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v2");
  fake.manualWrite({
    assistantId: "intake-prod",
    targets: [
      { assistantVersion: "v1", percentage: 50 },
      { assistantVersion: "v2", percentage: 50 },
    ],
  });
  const run = await promote([...ALL, "--no-rollout"], fake, {
    publishes: { "intake-prod": "v3" },
  });
  assert.equal(run.error, undefined);
  assert.equal(fake.writes.length, 1);
  assert.match(run.output, /kept the split set outside gitops .* v3 was published at 0%/);
});

test("--no-rollout skips an assistant that 404s", async () => {
  fixtureReset();
  const fake = new RolloutFake();
  const run = await promote([...ALL, "--no-rollout"], fake);
  assert.equal(run.error, undefined);
  assert.equal(fake.writes.length, 0);
});

test("an assistant the apply publishes without a pin is reported", async () => {
  fixtureReset();
  write(
    ".vapi-state.prod.json",
    `${JSON.stringify({ assistants: { intake: { uuid: "intake-prod" }, member: { uuid: "member-prod" } } })}\n`,
  );
  git("add", "-A");
  git("commit", "-qm", "squad member");
  const fake = new RolloutFake();
  fake.assistantAdd("intake-prod", "v1");
  fake.assistantAdd("member-prod", "v8");
  const run = await promote(ALL, fake, {
    publishes: { "intake-prod": "v2", "member-prod": "v9" },
  });
  assert.equal(run.error, undefined);
  assert.match(run.output, /member: published v9 without a pin, so it went live at 100%/);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
