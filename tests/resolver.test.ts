import assert from "node:assert/strict";
import test from "node:test";
import { resolveReferencesToResourceIds } from "../src/canonical.ts";
import { extractReferencedIds, resolveReferences } from "../src/resolver.ts";
import type { StateFile } from "../src/types.ts";

const assistantUuid = "11111111-1111-4111-8111-111111111111";

function state(): StateFile {
  return {
    credentials: {},
    assistants: { nestedAssistant: { uuid: assistantUuid } },
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

function nestedSquad(assistantId: string) {
  return {
    members: [
      {
        assistantId,
        assistantOverrides: {
          metadata: { assistantId: "customer-metadata" },
          "tools:append": [
            {
              type: "handoff",
              destinations: [{ type: "assistant", assistantId }],
            },
            {
              type: "function",
              destinations: [
                { type: "metadata", assistantId: "function-payload" },
              ],
            },
          ],
        },
      },
    ],
  };
}

function nestedDestination(
  resource: Record<string, unknown>,
): Record<string, unknown> {
  const members = resource.members;
  assert.ok(Array.isArray(members));
  const member = members[0];
  assert.ok(member && typeof member === "object");
  assert.ok("assistantOverrides" in member);
  const overrides = member.assistantOverrides;
  assert.ok(overrides && typeof overrides === "object");
  assert.ok("tools:append" in overrides);
  const tools = overrides["tools:append"];
  assert.ok(Array.isArray(tools));
  const tool = tools[0];
  assert.ok(tool && typeof tool === "object");
  assert.ok("destinations" in tool);
  const destinations = tool.destinations;
  assert.ok(Array.isArray(destinations));
  const destination = destinations[0];
  assert.ok(destination && typeof destination === "object");
  return destination;
}

test("resolveReferences resolves nested squad handoff assistant IDs only", () => {
  const resolved = resolveReferences(nestedSquad("nestedAssistant"), state());
  const destination = nestedDestination(resolved);
  assert.equal(destination.assistantId, assistantUuid);

  const members = resolved.members;
  assert.ok(Array.isArray(members));
  const member = members[0];
  assert.ok(member && typeof member === "object");
  assert.equal(member.assistantId, assistantUuid);
  assert.ok("assistantOverrides" in member);
  const overrides = member.assistantOverrides;
  assert.ok(overrides && typeof overrides === "object");
  assert.ok("metadata" in overrides);
  const metadata = overrides.metadata;
  assert.ok(metadata && typeof metadata === "object");
  assert.ok("assistantId" in metadata);
  assert.equal(metadata.assistantId, "customer-metadata");
  assert.ok("tools:append" in overrides);
  const tools = overrides["tools:append"];
  assert.ok(Array.isArray(tools));
  const functionTool = tools[1];
  assert.ok(functionTool && typeof functionTool === "object");
  assert.ok("destinations" in functionTool);
  const functionDestinations = functionTool.destinations;
  assert.ok(Array.isArray(functionDestinations));
  const functionDestination = functionDestinations[0];
  assert.ok(functionDestination && typeof functionDestination === "object");
  assert.ok("assistantId" in functionDestination);
  assert.equal(functionDestination.assistantId, "function-payload");
});

test("extractReferencedIds finds nested squad handoff assistant IDs", () => {
  const references = extractReferencedIds(nestedSquad("nestedAssistant"));
  assert.deepEqual(references.assistants, [
    "nestedAssistant",
    "nestedAssistant",
  ]);
});

test("canonicalization converts nested squad handoff UUIDs to aliases", () => {
  const resolved = resolveReferencesToResourceIds(
    nestedSquad(assistantUuid),
    state(),
  );
  const destination = nestedDestination(resolved);
  assert.equal(destination.assistantId, "nestedAssistant");

  const members = resolved.members;
  assert.ok(Array.isArray(members));
  const member = members[0];
  assert.ok(member && typeof member === "object");
  assert.ok("assistantId" in member);
  assert.equal(member.assistantId, "nestedAssistant");
});
