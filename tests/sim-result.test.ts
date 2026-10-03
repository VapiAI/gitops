import assert from "node:assert/strict";
import test from "node:test";
import {
  simRunItemTerminal,
  simRunVerdict,
  type SimRunItem,
  type SimRunItemCounts,
} from "../src/sim-result.ts";

// The verdict `npm run sim` and the PR check share. It must never report a
// pass unless every expected simulation ran, passed, and was actually
// scored — the old runner read a `results` field the API doesn't return and
// reported 0/0 as a pass.

function counts(overrides: Partial<SimRunItemCounts> = {}): SimRunItemCounts {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    running: 0,
    queued: 0,
    canceled: 0,
    ...overrides,
  };
}

function item(
  id: string,
  status: string,
  evaluations: NonNullable<SimRunItem["results"]>["evaluations"] = [
    { name: "goal-met", required: true, passed: status === "passed" },
  ],
): SimRunItem {
  return {
    id,
    status,
    results: { passed: status === "passed", evaluations },
    metadata: { simulation: { name: `sim ${id}` } },
  };
}

const ended = (itemCounts?: SimRunItemCounts) => ({
  id: "run-1",
  status: "ended",
  itemCounts,
});

test("simRunVerdict: passes when every expected item passed and was scored", () => {
  const verdict = simRunVerdict({
    run: ended(counts()),
    items: [item("a", "passed"), item("b", "passed")],
    expected: 2,
  });
  assert.equal(verdict.status, "passed");
});

test("simRunVerdict: the old false-green shape (ended, no results) is not a pass", () => {
  // What GET /eval/simulation/run/:id actually returns: no `results` field.
  // With no items fetched, the run can't be called passed.
  const verdict = simRunVerdict({ run: ended(counts()), items: [] });
  assert.equal(verdict.status, "incomplete");
  assert.match(verdict.reason, /fetched 0 of 2 items/);
});

test("simRunVerdict: 0 items is incomplete, never a pass", () => {
  const verdict = simRunVerdict({
    run: ended(counts({ total: 0, passed: 0 })),
    items: [],
  });
  assert.equal(verdict.status, "incomplete");
});

test("simRunVerdict: a failed item fails the run and lists the failing judge", () => {
  const verdict = simRunVerdict({
    run: ended(counts({ passed: 1, failed: 1 })),
    items: [
      item("a", "passed"),
      item("b", "failed", [
        {
          name: "booking-confirmed",
          required: true,
          passed: false,
          comparator: "=",
          expectedValue: true,
          extractedValue: false,
        },
      ]),
    ],
  });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.failures, [
    {
      item: "sim b",
      evaluation: "booking-confirmed",
      comparator: "=",
      expected: true,
      extracted: false,
      reason: undefined,
    },
  ]);
});

test("simRunVerdict: canceled items make the run incomplete", () => {
  const verdict = simRunVerdict({
    run: ended(counts({ passed: 1, canceled: 1 })),
    items: [item("a", "passed"), item("b", "canceled")],
  });
  assert.equal(verdict.status, "incomplete");
  assert.match(verdict.reason, /canceled/);
});

test("simRunVerdict: all required evaluations skipped is not a pass", () => {
  const skipped = [{ name: "audio-check", required: true, isSkipped: true }];
  const verdict = simRunVerdict({
    run: ended(counts()),
    items: [item("a", "passed"), item("b", "passed", skipped)],
  });
  assert.equal(verdict.status, "incomplete");
  assert.match(verdict.reason, /every required evaluation skipped/);
});

test("simRunVerdict: a skipped optional judge doesn't hide a scored required one", () => {
  const verdict = simRunVerdict({
    run: ended(counts({ total: 1, passed: 1 })),
    items: [
      item("a", "passed", [
        { name: "tone", required: false, isSkipped: true },
        { name: "goal-met", required: true, passed: true },
      ]),
    ],
  });
  assert.equal(verdict.status, "passed");
});

test("simRunVerdict: missing itemCounts is incomplete", () => {
  const verdict = simRunVerdict({
    run: ended(undefined),
    items: [item("a", "passed")],
  });
  assert.equal(verdict.status, "incomplete");
});

test("simRunVerdict: a count different from the expected one is incomplete", () => {
  const verdict = simRunVerdict({
    run: ended(counts()),
    items: [item("a", "passed"), item("b", "passed")],
    expected: 3,
  });
  assert.equal(verdict.status, "incomplete");
  assert.match(verdict.reason, /expected 3 items/);
});

test("simRunVerdict: a run that hasn't ended is incomplete", () => {
  const verdict = simRunVerdict({
    run: {
      id: "run-1",
      status: "running",
      itemCounts: counts({ passed: 1, running: 1 }),
    },
    items: [item("a", "passed")],
  });
  assert.equal(verdict.status, "incomplete");
});

test("simRunVerdict: a short item list is incomplete even when counts say passed", () => {
  const verdict = simRunVerdict({
    run: ended(counts()),
    items: [item("a", "passed")],
  });
  assert.equal(verdict.status, "incomplete");
});

test("simRunItemTerminal: passed or failed items need results; canceled doesn't", () => {
  assert.equal(simRunItemTerminal({ id: "a", status: "passed" }), false);
  assert.equal(simRunItemTerminal(item("a", "passed")), true);
  assert.equal(simRunItemTerminal({ id: "a", status: "canceled" }), true);
  assert.equal(simRunItemTerminal({ id: "a", status: "evaluating" }), false);
});
