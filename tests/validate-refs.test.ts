import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedResources, ResourceType, StateFile } from "../src/types.ts";
import { validateReferences } from "../src/validate-refs.ts";

// Reference checks: every name a file uses must match a local file or a
// state entry, overrides can't name tools, UUIDs warn, and credential names
// must be in state.

const STOCK = "a0000000-0000-4000-8000-000000000001";
const UUID = "3f2b1c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";

function loaded(
  files: Partial<Record<ResourceType, Record<string, object>>>,
): LoadedResources {
  const list = (type: ResourceType) =>
    Object.entries(files[type] ?? {}).map(([resourceId, data]) => ({
      resourceId,
      filePath: `/repo/resources/clinic/${type}/${resourceId}.yml`,
      data: data as Record<string, unknown>,
    }));
  return {
    tools: list("tools"),
    structuredOutputs: list("structuredOutputs"),
    assistants: list("assistants"),
    squads: list("squads"),
    personalities: list("personalities"),
    scenarios: list("scenarios"),
    simulations: list("simulations"),
    simulationSuites: list("simulationSuites"),
    evals: list("evals"),
  };
}

function state(
  entries: Partial<Record<keyof StateFile, string[]>> = {},
): StateFile {
  const section = (ids: string[] = []) =>
    Object.fromEntries(ids.map((id) => [id, { uuid: UUID }]));
  return {
    credentials: section(entries.credentials),
    assistants: section(entries.assistants),
    structuredOutputs: section(entries.structuredOutputs),
    tools: section(entries.tools),
    squads: section(entries.squads),
    personalities: section(entries.personalities),
    scenarios: section(entries.scenarios),
    simulations: section(entries.simulations),
    simulationSuites: section(entries.simulationSuites),
    evals: section(entries.evals),
  };
}

// [rule, resource, the quoted name or path in the message]
function findings(args: {
  files: Partial<Record<ResourceType, Record<string, object>>>;
  stateEntries?: Partial<Record<keyof StateFile, string[]>>;
  ignorePatterns?: string[];
}): Array<[string, string, string]> {
  return validateReferences({
    loaded: loaded(args.files),
    org: "clinic",
    state: state(args.stateEntries),
    ignorePatterns: args.ignorePatterns ?? [],
  }).map((f) => [
    `${f.severity}:${f.rule}`,
    `${f.type}/${f.resourceId}`,
    f.message
      .match(/references (\S+?),? |tool "([^"]+)"|credential "([^"]+)"/)!
      .slice(1)
      .find(Boolean)!,
  ]);
}

test("references to local files and state entries pass", () => {
  assert.deepEqual(
    findings({
      files: {
        tools: { "book-appointment": {} },
        assistants: {
          receptionist: {
            model: {
              toolIds: ["book-appointment ## books it", "lookup-patient"],
            },
          },
        },
      },
      stateEntries: { tools: ["lookup-patient"] },
    }),
    [],
  );
});

test("a name that matches nothing is an error in every reference field", () => {
  assert.deepEqual(
    findings({
      files: {
        assistants: {
          receptionist: {
            model: { toolIds: ["book-apointment"] },
            artifactPlan: { structuredOutputIds: ["call-sumary"] },
            hooks: [{ do: [{ toolId: "end-call-tool" }] }],
          },
        },
        squads: { "front-desk": { members: [{ assistantId: "schedular" }] } },
        scenarios: {
          "books-cleaning": {
            evaluations: [{ structuredOutputId: "booking-confirmd" }],
          },
        },
        simulations: {
          "books-cleaning-calm": {
            personalityId: "calm-calller",
            scenarioId: "books-cleaning",
          },
        },
        simulationSuites: {
          core: { simulationIds: ["books-cleaning-calm", "gone"] },
        },
      },
    }),
    [
      [
        "error:dangling-reference",
        "assistants/receptionist",
        "tools/book-apointment",
      ],
      [
        "error:dangling-reference",
        "assistants/receptionist",
        "tools/end-call-tool",
      ],
      [
        "error:dangling-reference",
        "assistants/receptionist",
        "structuredOutputs/call-sumary",
      ],
      ["error:dangling-reference", "squads/front-desk", "assistants/schedular"],
      [
        "error:dangling-reference",
        "scenarios/books-cleaning",
        "structuredOutputs/booking-confirmd",
      ],
      [
        "error:dangling-reference",
        "simulations/books-cleaning-calm",
        "simulations/personalities/calm-calller",
      ],
      [
        "error:dangling-reference",
        "simulationSuites/core",
        "simulations/tests/gone",
      ],
    ],
  );
});

test("a reference to an ignored resource is left to the reference-to-ignored rule", () => {
  assert.deepEqual(
    findings({
      files: { assistants: { receptionist: { toolIds: ["legacy-lookup"] } } },
      ignorePatterns: ["tools/legacy-*"],
    }),
    [],
  );
});

test("UUID references warn, except Vapi's stock personalities", () => {
  assert.deepEqual(
    findings({
      files: {
        assistants: { receptionist: { model: { toolIds: [UUID] } } },
        simulations: { calm: { personalityId: STOCK, scenarioId: UUID } },
      },
    }),
    [
      ["warn:reference-by-uuid", "assistants/receptionist", `tools/${UUID}`],
      [
        "warn:reference-by-uuid",
        "simulations/calm",
        `simulations/scenarios/${UUID}`,
      ],
    ],
  );
});

test("a tool named inside an override is an error; a UUID there is not", () => {
  assert.deepEqual(
    findings({
      files: {
        tools: { "book-appointment": {} },
        squads: {
          "front-desk": {
            members: [
              {
                assistantId: "receptionist",
                assistantOverrides: {
                  model: { toolIds: ["book-appointment", UUID] },
                },
              },
            ],
            membersOverrides: { model: { toolIds: ["lookup-patient"] } },
          },
        },
        assistants: { receptionist: {} },
        scenarios: {
          s: { targetOverrides: { model: { toolIds: ["transfer-tool"] } } },
        },
      },
    }),
    [
      ["error:override-tool-by-name", "squads/front-desk", "book-appointment"],
      ["error:override-tool-by-name", "squads/front-desk", "lookup-patient"],
      ["error:override-tool-by-name", "scenarios/s", "transfer-tool"],
    ],
  );
});

test("credential names must be in state; UUIDs and known names pass", () => {
  assert.deepEqual(
    findings({
      files: {
        tools: {
          lookup: { server: { credentialId: "crm-api" } },
          other: { credentialIds: ["crm-api", "billing-api", UUID] },
          raw: { server: { credentialId: UUID } },
        },
      },
      stateEntries: { credentials: ["crm-api"] },
    }),
    [["warn:unresolved-credential", "tools/other", "billing-api"]],
  );
});

test("the credential warning names the org's bootstrap pull", () => {
  const [finding] = validateReferences({
    loaded: loaded({ tools: { t: { server: { credentialId: "crm-api" } } } }),
    org: "clinic",
    state: state(),
    ignorePatterns: [],
  });
  assert.equal(
    finding?.message.includes("`npm run pull -- clinic --bootstrap`"),
    true,
  );
});
