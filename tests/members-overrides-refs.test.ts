import assert from "node:assert/strict";
import test from "node:test";
import { resolveReferencesToResourceIds } from "../src/canonical.ts";
import { extractReferencedIds, resolveReferences } from "../src/resolver.ts";
import type { StateFile } from "../src/types.ts";

// A squad's membersOverrides.artifactPlan.structuredOutputIds names structured
// outputs the same way an assistant's artifactPlan does (issue #8): push sends
// UUIDs, pull writes the names back, and the names count as references.

const SUMMARY_UUID = "3f2b1c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
const DASHBOARD_UUID = "a0000000-0000-4000-8000-000000000001";

function state(): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: { "call-summary": { uuid: SUMMARY_UUID } },
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

test("push resolves structured output names in membersOverrides.artifactPlan", () => {
  const squad = {
    name: "Team",
    members: [{ assistantId: "intake" }],
    membersOverrides: {
      artifactPlan: {
        structuredOutputIds: ["call-summary ## note", DASHBOARD_UUID],
        recordingEnabled: true,
      },
    },
  };
  const payload = resolveReferences(squad, state());
  assert.deepEqual(payload.membersOverrides, {
    artifactPlan: {
      structuredOutputIds: [SUMMARY_UUID, DASHBOARD_UUID],
      recordingEnabled: true,
    },
  });
  // The local data is not mutated.
  assert.deepEqual(squad.membersOverrides.artifactPlan.structuredOutputIds, [
    "call-summary ## note",
    DASHBOARD_UUID,
  ]);
});

test("pull writes membersOverrides.artifactPlan structured outputs back as names", () => {
  const platform = {
    name: "Team",
    members: [{ assistantId: DASHBOARD_UUID }],
    membersOverrides: {
      artifactPlan: { structuredOutputIds: [SUMMARY_UUID, DASHBOARD_UUID] },
    },
  };
  const local = resolveReferencesToResourceIds(platform, state());
  assert.deepEqual(local.membersOverrides, {
    artifactPlan: { structuredOutputIds: ["call-summary", DASHBOARD_UUID] },
  });
  // Round trip: pushing what pull wrote sends the platform's UUIDs again.
  const pushed = resolveReferences(local, state());
  assert.deepEqual(pushed.membersOverrides, platform.membersOverrides);
});

test("membersOverrides.artifactPlan structured outputs count as references", () => {
  const refs = extractReferencedIds({
    members: [{ assistantId: "intake" }],
    membersOverrides: {
      artifactPlan: { structuredOutputIds: ["call-summary ## note"] },
    },
  });
  assert.deepEqual(refs.structuredOutputs, ["call-summary"]);
  assert.deepEqual(refs.assistants, ["intake"]);
});

test("squads without membersOverrides.artifactPlan are unchanged", () => {
  const squad = {
    name: "Team",
    members: [{ assistantId: "intake" }],
    membersOverrides: { voice: { provider: "vapi", voiceId: "Elliot" } },
  };
  assert.deepEqual(resolveReferences(squad, state()), squad);
  assert.deepEqual(resolveReferencesToResourceIds(squad, state()), squad);
  assert.deepEqual(extractReferencedIds(squad).structuredOutputs, []);
});
