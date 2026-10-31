import assert from "node:assert/strict";
import test from "node:test";
import {
  rolloutOverdueMessage,
  rolloutSummaryMarkdown,
} from "../src/rollout-summary.ts";

const STEPPED = {
  org: "prod",
  assistant: "intake",
  state: "v1 → v2 at 5% (step 2/6)",
  overdue: false,
  gate: "v2: 40 calls, 0.0% errors; v1: 900 calls, 1.0% errors",
};
const STUCK = {
  org: "prod",
  assistant: "billing",
  state: "step 1 at v4: 3 of 20 calls before the next step",
  overdue: true,
};

test("summary: no ramp says so", () => {
  assert.equal(
    rolloutSummaryMarkdown("advance", []),
    "## Rollout advance\n\nNo ramp in progress.\n",
  );
});

test("summary: an overdue ramp is counted and marked", () => {
  assert.equal(
    rolloutSummaryMarkdown("advance", [STEPPED, STUCK]),
    [
      "## Rollout advance",
      "",
      "⚠️ 1 of 2 ramps overdue.",
      "",
      "| Org | Assistant | State | Health gate |",
      "| --- | --- | --- | --- |",
      "| prod | intake | v1 → v2 at 5% (step 2/6) | v2: 40 calls, 0.0% errors; v1: 900 calls, 1.0% errors |",
      "| prod | billing | ⚠️ overdue: step 1 at v4: 3 of 20 calls before the next step |  |",
      "",
    ].join("\n"),
  );
});

test("summary: a pipe in a state cannot break the table", () => {
  assert.match(
    rolloutSummaryMarkdown("status", [{ ...STEPPED, state: "a | b" }]),
    /\| a \\\| b \|/,
  );
});

test("overdue message: names each overdue ramp", () => {
  assert.equal(
    rolloutOverdueMessage([STEPPED, STUCK]),
    "1 ramps overdue:\n  - prod/billing: step 1 at v4: 3 of 20 calls before the next step",
  );
});

test("overdue message: none when nothing is overdue", () => {
  assert.equal(rolloutOverdueMessage([STEPPED]), null);
});
