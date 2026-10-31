import assert from "node:assert/strict";
import test from "node:test";
import { promotionConfigParse } from "../src/promotion.ts";

function configWithRollout(rollout: string): string {
  return `version: 1
orgs:
  staging: {}
  prod:
    rollout: ${rollout}
pipelines:
  release:
    orgs: [staging, prod]
    resources: [assistants/**]
`;
}

test("rollout: an empty mapping takes the default ramp and interval", () => {
  assert.deepEqual(promotionConfigParse(configWithRollout("{}")).orgs.prod, {
    baseUrl: undefined,
    bindings: {
      credentials: { default: "bind", aliases: {} },
      phoneNumbers: { default: "omit", aliases: {} },
    },
    rollout: { steps: [1, 5, 10, 25, 50, 100], intervalMinutes: 30 },
  });
});

test("rollout: custom steps and interval are kept", () => {
  assert.deepEqual(
    promotionConfigParse(
      configWithRollout("{steps: [0.5, 1.005, 20, 100], intervalMinutes: 60}"),
    ).orgs.prod?.rollout,
    { steps: [0.5, 1.005, 20, 100], intervalMinutes: 60 },
  );
});

test("rollout: an org without it has none", () => {
  assert.equal(
    promotionConfigParse(configWithRollout("{}")).orgs.staging?.rollout,
    undefined,
  );
});

for (const [label, rollout, message] of [
  ["steps that don't end at 100", "{steps: [1, 50]}", /must end at 100/],
  ["steps that don't increase", "{steps: [5, 5, 100]}", /must increase/],
  ["a step above 100", "{steps: [1, 101]}", /between 0.001 and 100/],
  ["a step of 0", "{steps: [0, 100]}", /between 0.001 and 100/],
  ["four decimal places", "{steps: [0.0005, 100]}", /three decimal places/],
  ["an empty list", "{steps: []}", /list of percentages/],
  ["a non-number step", "{steps: [ten, 100]}", /list of percentages/],
  ["an interval under 15 minutes", "{intervalMinutes: 10}", /at least 15/],
  ["a fractional interval", "{intervalMinutes: 20.5}", /whole number/],
  ["a misspelled key", "{step: [1, 100]}", /unknown key "step"/],
  ["a list instead of a mapping", "[1, 100]", /must be a mapping/],
] as const) {
  test(`rollout: rejects ${label}`, () => {
    assert.throws(
      () => promotionConfigParse(configWithRollout(rollout)),
      message,
    );
  });
}

test("rollout: healthGate: {} takes the default call floor and margin", () => {
  assert.deepEqual(
    promotionConfigParse(configWithRollout("{healthGate: {}}")).orgs.prod?.rollout
      ?.healthGate,
    { minCalls: 20, maxErrorRateDelta: 2 },
  );
});

for (const [label, gate, message] of [
  ["zero calls", "{minCalls: 0}", /minCalls must be a whole number/],
  ["a negative margin", "{maxErrorRateDelta: -1}", /between 0 and 100/],
  ["a misspelled key", "{minCall: 5}", /unknown key "minCall"/],
] as const) {
  test(`rollout: healthGate rejects ${label}`, () => {
    assert.throws(
      () => promotionConfigParse(configWithRollout(`{healthGate: ${gate}}`)),
      message,
    );
  });
}
