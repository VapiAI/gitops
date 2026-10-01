import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { CheckDefinition } from "../src/check-config.ts";
import type { PromotionGateResult } from "../src/promotion-gate.ts";
import {
  gateBudgetMinutes,
  gateDeadline,
  gateResultReduce,
} from "../src/promotion-gate.ts";
import { promotionConfigParse } from "../src/promotion.ts";

// promote-cmd.ts binds its root at import: one fixture repo for the file,
// rebuilt per test.
const ROOT = mkdtempSync(join(tmpdir(), "promotion-gate-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { promotionCommandRun } = await import("../src/promote-cmd.ts");

const CHECK_FILES: Record<string, string> = {
  "assistants/intake.yml": "name: Intake\nmodel:\n  provider: openai\n",
  "structuredOutputs/ok.yml": "name: ok\nschema:\n  type: boolean\n",
  "simulations/scenarios/s1.yml":
    "name: S1\ninstructions: Hi.\nevaluations:\n  - structuredOutputId: ok\n    comparator: '='\n    value: true\n    required: true\n",
  "simulations/personalities/calm.yml": "name: Calm\n",
  "simulations/tests/t1.yml": "name: T1\npersonalityId: calm\nscenarioId: s1\n",
};

function write(path: string, content: string): void {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), content);
}

interface FixtureArgs {
  orgs: Record<string, string | undefined>; // org → check name
  pipelines: Record<string, string[]>;
  files?: Record<string, string>; // repo-relative
  checks?: string; // vapi-checks.yml body after `checks:`
}

function fixture(args: FixtureArgs): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const orgs = Object.entries(args.orgs)
    .map(
      ([org, check]) => `  ${org}:${check ? `\n    check: ${check}` : " {}"}`,
    )
    .join("\n");
  const pipelines = Object.entries(args.pipelines)
    .map(
      ([name, list]) =>
        `  ${name}:\n    orgs: [${list.join(", ")}]\n    resources: ['**/*']`,
    )
    .join("\n");
  write(
    "promotion.yml",
    `version: 1\norgs:\n${orgs}\npipelines:\n${pipelines}\n`,
  );
  if (args.checks !== undefined)
    write("vapi-checks.yml", `version: 1\nchecks:\n${args.checks}`);
  for (const org of Object.keys(args.orgs))
    write(`.vapi-state.${org}.json`, "{}\n");
  for (const [path, content] of Object.entries(args.files ?? {}))
    write(path, content);
  write(".gitignore", "tmp/\n.env.*\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ROOT });
}

const checkFor = (org: string, name = `${org}-core`) =>
  `  ${name}:\n    org: ${org}\n    targets: [assistants/intake]\n    simulations: [t1]\n`;

function filesFor(org: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CHECK_FILES).map(([path, content]) => [
      `resources/${org}/${path}`,
      content,
    ]),
  );
}

interface Recorder {
  applies: string[];
  checks: string[];
  output: string;
}

async function promote(
  args: string[],
  gate: PromotionGateResult | ((check: CheckDefinition) => PromotionGateResult),
): Promise<Recorder & { error?: string }> {
  const recorder: Recorder = { applies: [], checks: [], output: "" };
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    a: "t",
    b: "t",
    c: "t",
    d: "t",
  });
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    recorder.output += `${parts.join(" ")}\n`;
  };
  try {
    await promotionCommandRun(args, {
      childRun: (script, org) => {
        if (script === "src/apply.ts") recorder.applies.push(org);
      },
      checkRun: async (check) => {
        recorder.checks.push(`${check.name}@${check.org}`);
        return typeof gate === "function" ? gate(check) : gate;
      },
    });
    return recorder;
  } catch (error) {
    return { ...recorder, error: (error as Error).message };
  } finally {
    console.log = log;
  }
}

const PASS: PromotionGateResult = {
  outcome: "passed",
  reason: "1 of 1 simulations passed",
  url: "https://run/pass",
};
const FAIL: PromotionGateResult = {
  outcome: "failed",
  reason: "1 of 1 simulations failed",
  url: "https://run/fail",
};
const ONE_STEP = ["--pipeline", "release", "--from", "a", "--to", "b"];

test("a passing gate lets the transition apply", async () => {
  fixture({
    orgs: { a: "a-core", b: undefined },
    pipelines: { release: ["a", "b"] },
    files: filesFor("a"),
    checks: checkFor("a"),
  });
  const result = await promote([...ONE_STEP, "--apply"], PASS);
  assert.deepEqual(
    [result.error, result.checks, result.applies],
    [undefined, ["a-core@a"], ["b"]],
  );
});

test("a failed or incomplete gate blocks, naming the run, and leaves the target untouched", async () => {
  const outcomes: Array<[PromotionGateResult, string]> = [
    [
      FAIL,
      "Promotion out of a blocked: check a-core failed (https://run/fail)",
    ],
    [
      { outcome: "incomplete", reason: "timed out after 1200s; run canceled" },
      "Promotion out of a blocked: check a-core incomplete (timed out after 1200s; run canceled)",
    ],
  ];
  const seen = [];
  for (const [gate] of outcomes) {
    fixture({
      orgs: { a: "a-core", b: undefined },
      pipelines: { release: ["a", "b"] },
      files: filesFor("a"),
      checks: checkFor("a"),
    });
    const result = await promote([...ONE_STEP, "--apply"], gate);
    seen.push([
      result.error,
      result.applies,
      existsSync(join(ROOT, "resources/b/assistants/intake.yml")),
    ]);
  }
  assert.deepEqual(
    seen,
    outcomes.map(([, message]) => [message, [], false]),
  );
});

test("a plan-only run says what the gate would run and never runs it", async () => {
  fixture({
    orgs: { a: "a-core", b: undefined },
    pipelines: { release: ["a", "b"] },
    files: filesFor("a"),
    checks: checkFor("a"),
  });
  const result = await promote(ONE_STEP, FAIL);
  assert.deepEqual(
    [
      result.error,
      result.checks,
      result.output.includes(
        "  check  would run a-core in a (1 simulation × 1 target)",
      ),
    ],
    [undefined, [], true],
  );
});

test("a transition with no changes skips the gate", async () => {
  fixture({
    orgs: { a: "a-core", b: undefined },
    pipelines: { release: ["a", "b"] },
    files: { ...filesFor("a"), ...filesFor("b") },
    checks: checkFor("a"),
  });
  const result = await promote([...ONE_STEP, "--apply"], FAIL);
  assert.deepEqual(
    [result.error, result.checks, result.applies],
    [undefined, [], []],
  );
});

test("gate configuration errors stop the run before anything applies", async () => {
  const cases: Array<[FixtureArgs, string]> = [
    [
      {
        orgs: { a: "a-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
      },
      "promotion.yml gates a on checks, but there is no vapi-checks.yml",
    ],
    [
      {
        orgs: { a: "nope", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: checkFor("a"),
      },
      "orgs.a.check: no check named nope in vapi-checks.yml",
    ],
    [
      {
        orgs: { a: "b-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: checkFor("b"),
      },
      "orgs.a.check: check b-core must read and run in a (it reads b and runs in b)",
    ],
    [
      {
        orgs: { a: "a-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: `${checkFor("a")}    toolMocks: off\n`,
      },
      "orgs.a.check: check a-core sets toolMocks: off, which runs real tools; a gate runs in a itself, so it must use toolMocks: strict",
    ],
    [
      {
        orgs: { a: "a-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: `${checkFor("a")}    stripWebhooks: false\n`,
      },
      "orgs.a.check: check a-core sets stripWebhooks: false, which sends simulated calls' webhooks to a's real servers; a gate must keep the default",
    ],
    [
      {
        orgs: { a: "a-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: `${checkFor("a")}    baseUrl: https://api.eu.vapi.ai\n`,
      },
      "orgs.a.check: check a-core uses https://api.eu.vapi.ai, but promotion.yml uses the default API for a; set the same baseUrl in both",
    ],
    [
      {
        // b is last in its only pipeline: nothing is ever promoted out of it.
        orgs: { a: undefined, b: "b-core" },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: checkFor("b"),
      },
      "orgs.b.check: nothing is promoted out of b (it is last in every pipeline), so this check would never run; gate the org before it instead",
    ],
    [
      {
        // 7 targets at 120 minutes: 3 batches, 365 minutes.
        orgs: { a: "a-core", b: undefined },
        pipelines: { release: ["a", "b"] },
        files: filesFor("a"),
        checks: `  a-core:\n    org: a\n    timeoutMinutes: 120\n    targets: [${Array.from({ length: 7 }, (_, i) => `assistants/t${i}`).join(", ")}]\n    simulations: [t1]\n`,
      },
      "promotion.yml's gated checks can take up to 365 minutes in one run, more than the 300 the promotion step allows; lower their timeoutMinutes or targets",
    ],
  ];
  const seen = [];
  for (const [args] of cases) {
    fixture(args);
    const result = await promote([...ONE_STEP, "--apply"], PASS);
    seen.push([result.error, result.applies]);
  }
  assert.deepEqual(
    seen,
    cases.map(([, message]) => [message, []]),
  );
});

test("a typo'd org key is rejected, so a misspelled check: can't silently drop the gate", () => {
  const errors = ["checks", "Check", "gate"].map((key) => {
    try {
      promotionConfigParse(
        `version: 1\norgs:\n  a:\n    ${key}: a-core\n  b: {}\npipelines:\n  release:\n    orgs: [a, b]\n    resources: ['**/*']\n`,
      );
      return "parsed";
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.deepEqual(
    errors,
    ["checks", "Check", "gate"].map(
      (key) =>
        `org a has unknown key "${key}" (allowed: baseUrl, bindings, check)`,
    ),
  );
});

test("each batch of 3 targets gets a full timeout, so a 4th target isn't squeezed", () => {
  const targets = (n: number) => Array.from({ length: n }, () => ({}));
  assert.deepEqual(
    {
      three: gateBudgetMinutes({ timeoutMinutes: 20, targets: targets(3) }),
      four: gateBudgetMinutes({ timeoutMinutes: 20, targets: targets(4) }),
      deadline: gateDeadline(
        { timeoutMinutes: 20, targets: targets(4) },
        1_000,
      ),
    },
    { three: 25, four: 45, deadline: 1_000 + 45 * 60_000 },
  );
});

test("the gate's result is its worst target: error over failed over incomplete over passed", () => {
  const result = (outcome: PromotionGateResult["outcome"]) => ({
    outcome,
    reason: outcome,
    url: `https://dashboard.vapi.ai/${outcome}`,
  });
  assert.deepEqual(
    [
      ["passed", "passed"],
      ["passed", "incomplete"],
      ["incomplete", "failed", "passed"],
      ["failed", "error", "passed"],
    ].map(
      (outcomes) =>
        gateResultReduce(
          outcomes.map((o) => result(o as PromotionGateResult["outcome"])),
        ).outcome,
    ),
    ["passed", "incomplete", "failed", "error"],
  );
});

test("a pass is reused for the same org until something applies into it", async () => {
  // p1: b→c (gate on b), p2: a→b (changes b), p3: b→d (gate on b again).
  fixture({
    orgs: { a: undefined, b: "b-core", c: undefined, d: undefined },
    pipelines: { p1: ["b", "c"], p2: ["a", "b"], p3: ["b", "d"] },
    files: {
      ...filesFor("b"),
      ...filesFor("a"),
      "resources/a/assistants/extra.yml": "name: Extra\n",
    },
    checks: checkFor("b"),
  });
  const reused = await promote(["--all", "--apply"], PASS);
  // Two pipelines out of a gated org with nothing applied into it in between.
  fixture({
    orgs: { a: "a-core", b: undefined, c: undefined },
    pipelines: { p1: ["a", "b"], p2: ["a", "c"] },
    files: filesFor("a"),
    checks: checkFor("a"),
  });
  const cached = await promote(["--all", "--apply"], PASS);
  assert.deepEqual(
    [
      reused.error,
      reused.checks,
      reused.applies,
      cached.checks,
      cached.applies,
    ],
    [
      undefined,
      ["b-core@b", "b-core@b"],
      ["c", "b", "d"],
      ["a-core@a"],
      ["b", "c"],
    ],
  );
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// With no `check:` in promotion.yml the gate must be invisible: the same
// plan output as before gates existed, no check run, and vapi-checks.yml
// never read (here it is invalid, so reading it would throw).
const UNGATED_PLAN_OUTPUT = [
  "",
  "release: a → b",
  "  create assistants/intake.yml",
  "  create simulations/personalities/calm.yml",
  "  create simulations/scenarios/s1.yml",
  "  create simulations/tests/t1.yml",
  "  create structuredOutputs/ok.yml",
  "",
].join("\n");

test("with no gate configured, promotion is unchanged: same plan output, no check, checks config never read", async () => {
  const ungated: FixtureArgs = {
    orgs: { a: undefined, b: undefined },
    pipelines: { release: ["a", "b"] },
    files: filesFor("a"),
  };
  fixture(ungated);
  write("vapi-checks.yml", "version: 999\nnot: [valid\n");
  const plan = await promote(ONE_STEP, FAIL);
  fixture(ungated);
  write("vapi-checks.yml", "version: 999\nnot: [valid\n");
  const applied = await promote([...ONE_STEP, "--apply"], FAIL);
  assert.deepEqual(
    [
      plan.error,
      plan.output,
      plan.checks,
      applied.error,
      applied.checks,
      applied.applies,
    ],
    [undefined, UNGATED_PLAN_OUTPUT, [], undefined, [], ["b"]],
  );
});
