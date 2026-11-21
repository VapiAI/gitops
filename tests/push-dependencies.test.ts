import assert from "node:assert/strict";
import test from "node:test";
import { collectUnlinkedDependencies } from "../src/push-dependencies.ts";
import type { LoadedResources, ResourceFile, StateFile } from "../src/types.ts";
import { VALID_RESOURCE_TYPES } from "../src/types.ts";

const resource = (
  id: string,
  data: Record<string, unknown> = {},
): ResourceFile => ({
  resourceId: id,
  filePath: `${id}.yml`,
  data,
});
function fixture() {
  const resources = Object.fromEntries(
    VALID_RESOURCE_TYPES.map((type) => [type, []]),
  ) as unknown as LoadedResources;
  const state = Object.fromEntries(
    ["credentials", ...VALID_RESOURCE_TYPES].map((type) => [type, {}]),
  ) as unknown as StateFile;
  return { resources, state };
}

test("dependency planning follows squad members through linked assistants to tools and outputs", () => {
  const { resources, state } = fixture();
  resources.squads = [
    resource("team", { members: [{ assistantId: "agent" }] }),
  ];
  resources.assistants = [
    resource("agent", {
      model: { toolIds: ["stop", "stop"] },
      artifactPlan: { structuredOutputIds: ["result"] },
    }),
  ];
  resources.tools = [resource("stop")];
  resources.structuredOutputs = [resource("result")];
  state.assistants.agent = { uuid: "linked", origin: "pulled" };
  const found = collectUnlinkedDependencies(
    resources,
    { assistants: [], squads: resources.squads },
    state,
  );
  assert.deepEqual(
    found.map(({ type, resource, neededBy }) => [
      type,
      resource.resourceId,
      [...neededBy],
    ]),
    [
      ["tools", "stop", ["team.yml"]],
      ["structuredOutputs", "result", ["team.yml"]],
    ],
  );
});

test("each selected root is recorded once and unlinked squad members are included", () => {
  const { resources, state } = fixture();
  resources.squads = [
    resource("team", {
      members: [{ assistantId: "agent" }, { assistantId: "agent" }],
    }),
  ];
  resources.assistants = [
    resource("agent", { hooks: [{ do: [{ toolId: "stop" }] }] }),
  ];
  resources.tools = [resource("stop")];
  const found = collectUnlinkedDependencies(resources, resources, state);
  assert.deepEqual(
    found.find(({ type }) => type === "tools")?.neededBy,
    new Set(["agent.yml", "team.yml"]),
  );
  assert.deepEqual(
    found.find(({ type }) => type === "assistants")?.neededBy,
    new Set(["team.yml"]),
  );
});

test("linked and repo-owned reusable dependencies do not plan POSTs", () => {
  const { resources, state } = fixture();
  resources.assistants = [resource("agent", { toolIds: ["linked", "owned"] })];
  resources.tools = [resource("linked"), resource("owned", { name: "Owned" })];
  state.tools.linked = { uuid: "remote", origin: "pulled" };
  for (const origin of ["pushed", "adopted"] as const) {
    state.tools["owned-abcd1234"] = { uuid: "abcd1234", origin };
    assert.deepEqual(
      collectUnlinkedDependencies(resources, resources, state),
      [],
    );
  }
  state.tools["owned-abcd1234"] = { uuid: "abcd1234", origin: "pulled" };
  assert.deepEqual(
    collectUnlinkedDependencies(resources, resources, state).map(
      ({ resource }) => resource.resourceId,
    ),
    ["owned"],
  );
});

test("empty, unresolved, UUID and read-only references are not auto-created", () => {
  const { resources, state } = fixture();
  assert.deepEqual(
    collectUnlinkedDependencies(resources, resources, state),
    [],
  );
  const uuid = "aaaaaaaa-1111-4111-8111-111111111111";
  resources.assistants = [
    resource("agent", { model: { toolIds: ["missing", uuid, "default"] } }),
  ];
  resources.tools = [
    resource(uuid),
    resource("default", { _platformDefault: true }),
  ];
  assert.deepEqual(
    collectUnlinkedDependencies(resources, resources, state),
    [],
  );
});

test("squad assistant destinations are also auto-applied", () => {
  const { resources, state } = fixture();
  resources.squads = [
    resource("team", {
      members: [
        {
          assistantId: "external",
          assistantDestinations: [{ assistantId: "target" }],
        },
      ],
    }),
  ];
  resources.assistants = [resource("target")];
  const found = collectUnlinkedDependencies(
    resources,
    { assistants: [], squads: resources.squads },
    state,
  );
  assert.deepEqual(
    found.map(({ resource }) => resource.resourceId),
    ["target"],
  );
});

test("references without an engine auto-apply path do not expand the plan", () => {
  const { resources, state } = fixture();
  resources.assistants = [
    resource("agent", {
      toolIds: ["handoff"],
      artifactPlan: { structuredOutputIds: ["result"] },
    }),
    resource("other", { toolIds: ["unrelated"] }),
  ];
  resources.tools = [
    resource("handoff", { destinations: [{ assistantId: "other" }] }),
    resource("unrelated"),
  ];
  resources.structuredOutputs = [
    resource("result", { assistant_ids: ["other"] }),
  ];
  const found = collectUnlinkedDependencies(
    resources,
    { assistants: [resources.assistants[0]!], squads: [] },
    state,
  );
  assert.deepEqual(
    found.map(({ resource }) => resource.resourceId),
    ["handoff", "result"],
  );
});
