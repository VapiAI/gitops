import assert from "node:assert/strict";
import test from "node:test";

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { parseResourceFilePath, resolvePullScopeFromFilePaths } = await import(
  "../src/resources.ts"
);
const { mapWithConcurrency, preserveExplicitOursPaths } = await import(
  "../src/pull.ts"
);

test("parseResourceFilePath: long-form assistant path", () => {
  const parsed = parseResourceFilePath(
    "resources/test-fixture-org/assistants/call-transfer-test-c95f4c6b.md",
  );
  assert.deepEqual(parsed, {
    type: "assistants",
    resourceId: "call-transfer-test-c95f4c6b",
  });
});

test("parseResourceFilePath: short-form assistant path", () => {
  const parsed = parseResourceFilePath(
    "assistants/call-transfer-test-c95f4c6b.md",
  );
  assert.deepEqual(parsed, {
    type: "assistants",
    resourceId: "call-transfer-test-c95f4c6b",
  });
});

test("resolvePullScopeFromFilePaths: maps file paths to dashboard UUIDs by state", () => {
  const scope = resolvePullScopeFromFilePaths(
    ["resources/test-fixture-org/assistants/call-transfer-test-c95f4c6b.md"],
    {
      credentials: {},
      assistants: {
        "call-transfer-test-c95f4c6b": {
          uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
      },
      structuredOutputs: {},
      tools: {},
      squads: {},
      personalities: {},
      scenarios: {},
      simulations: {},
      simulationSuites: {},
      evals: {},
    },
  );

  assert.deepEqual(scope.types, ["assistants"]);
  assert.deepEqual(scope.idsByType.get("assistants"), [
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  ]);
  assert.equal(scope.skippedWithoutState.length, 0);
  assert.equal(scope.unrecognized.length, 0);
});

test("resolvePullScopeFromFilePaths: new resources without state skip pull", () => {
  const scope = resolvePullScopeFromFilePaths(
    ["resources/test-fixture-org/assistants/new-agent.md"],
    {
      credentials: {},
      assistants: {},
      structuredOutputs: {},
      tools: {},
      squads: {},
      personalities: {},
      scenarios: {},
      simulations: {},
      simulationSuites: {},
      evals: {},
    },
  );

  assert.deepEqual(scope.types, []);
  assert.equal(scope.idsByType.size, 0);
  assert.equal(scope.skippedWithoutState.length, 1);
  assert.equal(scope.skippedWithoutState[0]?.resourceId, "new-agent");
});

test("resolve ours preserves every scoped file when git misses a fresh rewrite", () => {
  const assistant =
    "resources/test-fixture-org/assistants/promotion-smoke-assistant.md";
  const tool = "resources/test-fixture-org/tools/promotion-smoke-lookup.yml";
  const output =
    "resources/test-fixture-org/structuredOutputs/promotion-smoke-result.yml";

  const preserved = preserveExplicitOursPaths(
    new Set([tool, output]),
    [assistant, tool, output],
    "test-fixture-org",
  );

  assert.deepEqual([...preserved].sort(), [assistant, output, tool].sort());
});

test("targeted fetch work is bounded by the requested concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = await mapWithConcurrency(
    Array.from({ length: 12 }, (_, index) => index),
    3,
    async (value) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    },
  );

  assert.equal(maximumActive, 3);
  assert.deepEqual(values, Array.from({ length: 12 }, (_, index) => index * 2));
});
