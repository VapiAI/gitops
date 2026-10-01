import assert from "node:assert/strict";
import test from "node:test";
import type { CheckJob } from "../src/check-build.ts";
import { checksConfigParse } from "../src/check-config.ts";
import { checkReportJson, checkReportMarkdown } from "../src/check-report.ts";
import type { CheckTargetResult } from "../src/check-run.ts";

const check = checksConfigParse(
  "version: 1\nchecks:\n  core:\n    org: acme\n    targets: [squads/main, assistants/solo]\n    suites: [core]\n",
).checks.core!;

function job(
  index: number,
  errors: string[] = [],
  warnings: string[] = [],
): CheckJob {
  const target = check.targets[index]!;
  return {
    check,
    target,
    label: `core / ${target.type}/${target.id}`,
    result: { errors, warnings, bytes: 0 },
  };
}

const results: CheckTargetResult[] = [
  {
    job: job(0, [], ["a warning"]),
    outcome: "failed",
    reason: "1 of 3 simulations failed",
    url: "https://dashboard.vapi.ai/run-1",
    counts: {
      total: 3,
      passed: 2,
      failed: 1,
      running: 0,
      queued: 0,
      canceled: 0,
    },
    failures: [
      {
        item: "Books | calm",
        evaluation: "booked",
        comparator: "=",
        expected: true,
        extracted: false,
      },
    ],
    mockNotices: ["Books | calm: unmocked tool called: sms_send"],
    durationMs: 1,
  },
  {
    job: job(1, ["no file"]),
    outcome: "error",
    reason: "payload could not be built (1 problem)",
    failures: [],
    mockNotices: [],
    durationMs: 0,
  },
];

test("the markdown report has a summary row per target and detail for anything not clean", () => {
  assert.equal(
    checkReportMarkdown({
      results,
      skipped: [
        { check: "other", reason: "not affected by changes since origin/main" },
      ],
      dryRun: false,
    }),
    [
      "## Vapi Evals",
      "",
      "| Check | Target | Result | Simulations | Run |",
      "|---|---|---|---|---|",
      "| core | squads/main | ❌ failed | 2/3 | [open](https://dashboard.vapi.ai/run-1) |",
      "| core | assistants/solo | 🛑 not run |  |  |",
      "",
      "- ⏭️ other: not affected by changes since origin/main",
      "",
      "### ❌ failed: core / squads/main",
      "",
      "1 of 3 simulations failed",
      "",
      "| Simulation | Evaluation | Comparator | Expected | Got | Note |",
      "|---|---|---|---|---|---|",
      "| Books \\| calm | booked | = | true | false |  |",
      "",
      "- 🧪 Books | calm: unmocked tool called: sms_send",
      "- ⚠️ a warning",
      "",
      "### 🛑 not run: core / assistants/solo",
      "",
      "payload could not be built (1 problem)",
      "",
      "- ❌ no file",
      "",
    ].join("\n"),
  );
});

test("the JSON report carries every result field", () => {
  const json = checkReportJson({ results, skipped: [], dryRun: true }) as {
    dryRun: boolean;
    results: Array<{
      check: string;
      target: string;
      outcome: string;
      errors: string[];
    }>;
  };
  assert.deepEqual(
    [
      json.dryRun,
      json.results.map((r) => [r.check, r.target, r.outcome, r.errors]),
    ],
    [
      true,
      [
        ["core", "squads/main", "failed", []],
        ["core", "assistants/solo", "error", ["no file"]],
      ],
    ],
  );
});
