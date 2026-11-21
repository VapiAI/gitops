import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedResources, ResourceFile } from "../src/types.ts";

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN ||= "test-token-not-used";
const { validateResources } = await import("../src/validate.ts");

const file = (data: Record<string, unknown>): ResourceFile => ({
  resourceId: "example",
  filePath: "/fake/example.yml",
  data,
});
const tool = (number: unknown = "{{handover_number}}", extra = {}) => ({
  type: "transferCall",
  destinations: [{ type: "number", number, ...extra }],
});
const loaded = (): LoadedResources => ({
  tools: [],
  assistants: [],
  squads: [],
  structuredOutputs: [],
  personalities: [],
  scenarios: [],
  simulations: [],
  simulationSuites: [],
  evals: [],
});
const findings = (resources: LoadedResources) =>
  validateResources(resources).filter(
    (f) => f.rule === "transfer-number-liquid",
  );

for (const placement of [
  "standalone",
  "model",
  "inline-member",
  "member",
  "squad",
] as const) {
  test(`Liquid transfer number rejected in ${placement}`, () => {
    const resources = loaded();
    let type: "tools" | "assistants" | "squads" = "squads";
    let fieldPath: string;
    if (placement === "standalone") {
      type = "tools";
      resources.tools = [file(tool())];
      fieldPath = "destinations[0].number";
    } else if (placement === "model") {
      type = "assistants";
      resources.assistants = [file({ model: { tools: [tool()] } })];
      fieldPath = "model.tools[0].destinations[0].number";
    } else if (placement === "inline-member") {
      resources.squads = [
        file({ members: [{ assistant: { model: { tools: [tool()] } } }] }),
      ];
      fieldPath = "members[0].assistant.model.tools[0].destinations[0].number";
    } else if (placement === "member") {
      resources.squads = [
        file({
          members: [{ assistantOverrides: { "tools:append": [tool()] } }],
        }),
      ];
      fieldPath =
        "members[0].assistantOverrides.tools:append[0].destinations[0].number";
    } else {
      resources.squads = [
        file({ membersOverrides: { "tools:append": [tool()] } }),
      ];
      fieldPath = "membersOverrides.tools:append[0].destinations[0].number";
    }
    const result = findings(resources);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      severity: "error",
      type,
      resourceId: "example",
      rule: "transfer-number-liquid",
      fieldPath,
      message:
        "The API rejects Liquid in transfer numbers: E.164 validation applies, and numberE164CheckEnabled:false still requires ^\\+?[a-zA-Z0-9]+$. Use a per-practice literal number, e.g. an inline tool in the squad's membersOverrides['tools:append']; see examples/nhs-shared-squads.",
    });
  });
}

test("Liquid tags and disabled E.164 checks still produce errors", () => {
  const resources = loaded();
  resources.tools = [
    file(
      tool("{% assign number = '123' %}", { numberE164CheckEnabled: false }),
    ),
  ];
  assert.equal(findings(resources).length, 1);
});

test("literal, empty and malformed destinations do not trigger the Liquid rule", () => {
  const resources = loaded();
  resources.tools = [
    file(tool("+442079460101")),
    file(tool(null)),
    file({ type: "transferCall", destinations: [null, {}, "text"] }),
    file({ type: "transferCall" }),
  ];
  resources.assistants = [file({ model: { tools: [tool("+442079460201")] } })];
  resources.squads = [
    file({ membersOverrides: { "tools:append": [tool("+442079460202")] } }),
  ];
  assert.deepEqual(findings(resources), []);
  assert.deepEqual(findings(loaded()), []);
});

test("other tool types and Liquid descriptions are not transfer numbers", () => {
  const resources = loaded();
  resources.tools = [
    file({ ...tool(), type: "handoff" }),
    file({ ...tool("+442079460101"), description: "{{practice}}" }),
  ];
  assert.deepEqual(findings(resources), []);
});
