import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelection, resolveTarget } from "../src/sim.ts";
import type { StateFile } from "../src/types.ts";

// Stack E — sim-runner argument resolution coverage.
// Tests focus on resolveTarget / resolveSelection — the runtime fetch path
// against `POST /eval/simulation/run` is integration territory and is
// covered manually against a sandbox org.

function makeState(overrides: Partial<StateFile> = {}): StateFile {
  return {
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
    ...overrides,
  };
}

test("resolveTarget: resolves assistant by local name to UUID", () => {
  const state = makeState({
    assistants: { "intake-agent": "uuid-intake-001" },
  });
  const target = resolveTarget(state, { assistant: "intake-agent" });
  assert.equal(target.type, "assistant");
  assert.equal(target.id, "uuid-intake-001");
  assert.equal(target.resourceName, "intake-agent");
});

test("resolveTarget: resolves squad by local name", () => {
  const state = makeState({ squads: { "main-squad": "uuid-squad-001" } });
  const target = resolveTarget(state, { squad: "main-squad" });
  assert.equal(target.type, "squad");
  assert.equal(target.id, "uuid-squad-001");
});

test("resolveTarget: throws when assistant not in state", () => {
  const state = makeState();
  assert.throws(
    () => resolveTarget(state, { assistant: "missing" }),
    /Assistant "missing" not found in state/,
  );
});

test("resolveTarget: rejects both assistant and squad simultaneously", () => {
  const state = makeState({
    assistants: { a: "x" },
    squads: { b: "y" },
  });
  assert.throws(
    () => resolveTarget(state, { assistant: "a", squad: "b" }),
    /assistant OR a squad, not both/,
  );
});

test("resolveSelection: resolves suite by local name", () => {
  const state = makeState({
    simulationSuites: { "booking-tests": "uuid-s-1" },
  });
  const sel = resolveSelection(state, { suite: "booking-tests" });
  assert.equal(sel.entries.length, 1);
  assert.deepEqual(sel.entries[0], {
    type: "simulationSuite",
    simulationSuiteId: "uuid-s-1",
  });
  assert.match(sel.label, /booking-tests/);
});

test("resolveSelection: resolves comma-separated simulations", () => {
  const state = makeState({
    simulations: { "happy-path": "uuid-h", "edge-case": "uuid-e" },
  });
  const sel = resolveSelection(state, {
    simulations: "happy-path, edge-case",
  });
  assert.equal(sel.entries.length, 2);
  assert.deepEqual(sel.entries[0], {
    type: "simulation",
    simulationId: "uuid-h",
  });
  assert.deepEqual(sel.entries[1], {
    type: "simulation",
    simulationId: "uuid-e",
  });
});

test("resolveSelection: throws when suite not in state", () => {
  const state = makeState();
  assert.throws(
    () => resolveSelection(state, { suite: "missing" }),
    /Simulation suite "missing" not found in state/,
  );
});

test("resolveSelection: rejects both suite and simulations simultaneously", () => {
  const state = makeState({
    simulationSuites: { a: "x" },
    simulations: { b: "y" },
  });
  assert.throws(
    () => resolveSelection(state, { suite: "a", simulations: "b" }),
    /Specify --suite OR --simulations/,
  );
});

test("resolveTarget: handles forward-compat ResourceState shape (Stack F)", () => {
  // Stack F migrates state values from `string` to `{uuid: string, ...}`.
  // The resolver must accept both shapes so this stack lands cleanly
  // before F or after.
  const state = {
    credentials: {},
    assistants: {
      "future-agent": {
        uuid: "uuid-future",
        lastPulledHash: "abc123",
      } as unknown as string,
    },
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  } as StateFile;
  const target = resolveTarget(state, { assistant: "future-agent" });
  assert.equal(target.id, "uuid-future");
});
