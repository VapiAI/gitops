import assert from "node:assert/strict";
import test from "node:test";
import type { Allocation } from "../src/rollout-api.ts";
import { rolloutMarkerParse } from "../src/rollout-marker.ts";
import type { RolloutTickInput } from "../src/rollout-tick.ts";
import {
  ROLLOUT_ORPHAN_AGE_MINUTES,
  rolloutAbortWrite,
  rolloutTickDecide,
} from "../src/rollout-tick.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const ROLLOUT = { steps: [1, 5, 10, 25, 50, 100], intervalMinutes: 30 };

function allocation(
  description: string,
  minutesAgo: number,
  targets: Allocation["targets"] = [],
): Allocation {
  return {
    id: "alloc-1",
    assistantId: "asst",
    allocationIntent: targets.length > 0 ? "explicit" : "follow-latest",
    createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    description,
    targets,
  };
}

function decide(
  row: Allocation | null,
  latestVersion: string | null = "v2",
): ReturnType<typeof rolloutTickDecide> {
  const input: RolloutTickInput = {
    assistantId: "asst",
    allocation: row,
    latestVersion,
    rollout: ROLLOUT,
    now: NOW,
    runId: "run-1",
  };
  return rolloutTickDecide(input);
}

// The decided write as `command kind targets`, for one-line assertions.
function writeOf(decision: ReturnType<typeof rolloutTickDecide>): string | undefined {
  if (!decision.write) return undefined;
  const { command, write } = decision.write;
  return [
    command,
    rolloutMarkerParse(write.description)?.kind,
    (write.targets ?? [])
      .map((target) => `${target.assistantVersion}:${target.percentage}`)
      .join(","),
  ]
    .filter(Boolean)
    .join(" ");
}

const STEP_1 = "gitops-rollout step from=v1 to=v2 step=1/6";

test("tick: a step whose interval has passed moves to the next step", () => {
  assert.equal(writeOf(decide(allocation(STEP_1, 31))), "rollout-step step v1:95,v2:5");
});

test("tick: the next step's write is a compare-and-set on the current row", () => {
  assert.equal(
    decide(allocation(STEP_1, 31)).write?.write.expectedCurrentAllocationId,
    "alloc-1",
  );
});

test("tick: a step inside its interval waits", () => {
  assert.deepEqual(decide(allocation(STEP_1, 10)), {
    note: "step 1/6 at v2; next in 20 min",
  });
});

test("tick: the step before the last completes on an explicit 100%, not follow-latest", () => {
  assert.equal(
    writeOf(decide(allocation("gitops-rollout step from=v1 to=v2 step=5/6", 31))),
    "rollout-complete complete v2:100",
  );
});


test("tick: a complete ramp is released when no newer version exists", () => {
  assert.equal(
    writeOf(decide(allocation("gitops-rollout complete from=v1 to=v2", 1))),
    "rollout-release release",
  );
});

test("tick: a complete ramp is held when a newer, un-ramped version exists", () => {
  const decision = decide(allocation("gitops-rollout complete from=v1 to=v2", 1), "v3");
  assert.equal(writeOf(decision), "rollout-hold hold v2:100");
  assert.equal(rolloutMarkerParse(decision.write?.write.description)?.hold, "v3");
});

test("tick: a held ramp is left alone and flagged", () => {
  assert.deepEqual(decide(allocation("gitops-rollout hold from=v1 to=v2 hold=v3", 600), "v3"), {
    note: "held on v2; v3 has not been ramped",
    stale: true,
  });
});

test("tick: an abort is left alone", () => {
  assert.equal(decide(allocation("gitops-rollout abort from=v1 to=v2", 600)).write, undefined);
});

test("tick: a release is left alone", () => {
  assert.deepEqual(decide(allocation("gitops-rollout release", 600)), {});
});

test("tick: an unmarked row is ignored", () => {
  assert.deepEqual(decide(allocation("customer note", 600)), {});
});

test("tick: no allocation is ignored", () => {
  assert.deepEqual(decide(null), {});
});

const PIN = "gitops-rollout pin from=v1 latest=v1 prev=follow-latest run=r";

test("tick: a young pin may belong to a running promotion, so it waits", () => {
  assert.equal(decide(allocation(PIN, ROLLOUT_ORPHAN_AGE_MINUTES - 1)).write, undefined);
});

test("tick: an old pin whose run published is adopted at step 1", () => {
  assert.equal(
    writeOf(decide(allocation(PIN, ROLLOUT_ORPHAN_AGE_MINUTES + 1), "v2")),
    "rollout-step step v1:99,v2:1",
  );
});

test("tick: an old pin that replaced follow-latest, whose run never published, is released", () => {
  assert.equal(
    writeOf(decide(allocation(PIN, ROLLOUT_ORPHAN_AGE_MINUTES + 1), "v1")),
    "rollout-release release",
  );
});

for (const [label, prev, latest, current] of [
  ["over an abort", "marked", "v2", "v2"],
  ["over a hold", "marked", "v3", "v3"],
  ["over an override of a manual split", "manual", "v2", "v2"],
] as const) {
  test(`tick: an old pin ${label}, whose run never published, is not adopted`, () => {
    const decision = decide(
      allocation(
        `gitops-rollout pin from=v1 latest=${latest} prev=${prev} run=r`,
        ROLLOUT_ORPHAN_AGE_MINUTES + 1,
      ),
      current,
    );
    assert.equal(decision.write, undefined);
    assert.equal(decision.stale, true);
  });
}

test("abort: an active step goes back to its old version", () => {
  const tick = rolloutAbortWrite("asst", allocation("gitops-rollout step from=v1 to=v2 step=3/6", 5));
  assert.deepEqual(
    [tick?.command, tick?.write.targets, rolloutMarkerParse(tick?.write.description)?.kind],
    ["rollout-abort", [{ assistantVersion: "v1", percentage: 100 }], "abort"],
  );
});

for (const description of [
  "gitops-rollout pin from=v1 latest=v1 prev=follow-latest",
  "gitops-rollout abort from=v1 to=v2",
  "gitops-rollout release",
  "a customer note",
]) {
  test(`abort: nothing to abort for "${description}"`, () => {
    assert.equal(rolloutAbortWrite("asst", allocation(description, 5)), null);
  });
}

const GATED = {
  ...ROLLOUT,
  healthGate: { minCalls: 20, maxErrorRateDelta: 2 },
};

function decideGated(health: RolloutTickInput["health"]) {
  return rolloutTickDecide({
    assistantId: "asst",
    allocation: allocation(STEP_1, 31),
    latestVersion: "v2",
    rollout: GATED,
    now: NOW,
    health,
  });
}

test("health gate: waits until the new version has taken enough calls", () => {
  assert.deepEqual(
    decideGated([
      { version: "v1", calls: 900, errors: 0 },
      { version: "v2", calls: 12, errors: 0 },
    ]),
    { note: "step 1 at v2: 12 of 20 calls before the next step" },
  );
});

test("health gate: moves on when the new version's error rate is within the margin", () => {
  assert.equal(
    writeOf(
      decideGated([
        { version: "v1", calls: 1000, errors: 10 },
        { version: "v2", calls: 100, errors: 2 },
      ]),
    ),
    "rollout-step step v1:95,v2:5",
  );
});

test("health gate: aborts when the new version errors well above the old", () => {
  const decision = decideGated([
    { version: "v1", calls: 1000, errors: 10 },
    { version: "v2", calls: 100, errors: 5 },
  ]);
  assert.equal(writeOf(decision), "rollout-abort abort v1:100");
  assert.equal(
    rolloutMarkerParse(decision.write?.write.description)?.reason,
    "error-rate+4.0pp",
  );
});

test("health gate: no calls at all waits rather than aborting", () => {
  assert.deepEqual(decideGated([]), {
    note: "step 1 at v2: 0 of 20 calls before the next step",
  });
});
