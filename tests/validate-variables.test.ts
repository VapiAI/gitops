import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { blockLayers, blocksExpand } from "../src/blocks.ts";
import type { LoadedResources, ResourceFile } from "../src/types.ts";
import { engineRepoCreate, repoCreate } from "./blocks-helpers.ts";

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN ||= "test-token-not-used";
const { validateResources } = await import("../src/validate.ts");

const file = (
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile => ({ resourceId, data, filePath: `/fake/${resourceId}.yml` });
const prompt = (content: string) => ({
  model: { messages: [{ role: "system", content }] },
});
function resources(
  text = "{{practice}}",
  overrides: object = {},
): LoadedResources {
  return {
    assistants: [file("desk", prompt(text))],
    squads: [
      file("north", { members: [{ assistantId: "desk" }], ...overrides }),
    ],
    tools: [],
    structuredOutputs: [],
    personalities: [],
    scenarios: [],
    simulations: [],
    simulationSuites: [],
    evals: [],
  };
}
const findings = (loaded: LoadedResources) =>
  validateResources(loaded).filter((f) => f.rule === "variable-undefined");

test("variables defined at squad or member level, including empty values", () => {
  assert.deepEqual(
    findings(
      resources(undefined, {
        membersOverrides: { variableValues: { practice: "" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    findings(
      resources(undefined, {
        members: [
          {
            assistantId: "desk",
            assistantOverrides: { variableValues: { practice: "North" } },
          },
        ],
      }),
    ),
    [],
  );
});

test("built-in roots, property access, filters and literals", () => {
  assert.deepEqual(
    findings(
      resources(
        "{{customer.number | default: 'unknown'}} {{phoneNumber.number}} {{transport}} {{call.id}} {{now}} {{currentDateTime}} {{date}} {{time}} {{year}} {{month}} {{day}}",
      ),
    ),
    [],
  );
});

test("one finding per member, isolated between two practice squads", () => {
  const loaded = resources("{{practice}} {{mailbox}} {{practice}}");
  loaded.squads.push(
    file("south", {
      members: [{ assistantId: "desk" }],
      membersOverrides: {
        variableValues: { practice: "South", mailbox: "hello" },
      },
    }),
  );
  const result = findings(loaded);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, "warn");
  assert.equal(result[0]!.resourceId, "north");
  assert.match(
    result[0]!.message,
    /member "desk".*mailbox, practice.*membersOverrides.variableValues.*assistantOverrides.variableValues/,
  );
});

test("extraction schemas and aliases on tools and handoff destinations in any member", () => {
  const loaded = resources("{{patient}} {{alias}} {{destination}}");
  loaded.squads[0] = file("north", {
    members: [
      { assistantId: "desk" },
      {
        assistant: {
          model: {
            tools: [
              {
                variableExtractionPlan: {
                  schema: { properties: { patient: { type: "string" } } },
                  aliases: [{ key: "alias", value: "{{response.name}}" }],
                },
                destinations: [
                  {
                    variableExtractionPlan: {
                      schema: { properties: { destination: {} } },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  });
  assert.deepEqual(findings(loaded), []);
});

test("Liquid assigns, capture and loop locals are local to each text", () => {
  assert.deepEqual(
    findings(
      resources(
        "{% assign name = 'North' %}{{name}} {% capture greeting %}Hello{% endcapture %}{{greeting}} {% for x in customer.items %}{{x.name}}{{forloop.index}}{% endfor %}",
      ),
    ),
    [],
  );
  const result = findings(
    resources(
      "{% assign name = missing %}{{name}} {% for x in customer.items %}{{x}}{% endfor %}{{x}}",
    ),
  );
  assert.match(result[0]!.message, /missing, x/);
  const loaded = resources("{% assign local = 'yes' %}{{local}}");
  loaded.assistants[0] = file("desk", {
    ...prompt("{% assign local = 'yes' %}{{local}}"),
    firstMessage: "{{local}}",
  });
  assert.match(findings(loaded)[0]!.message, /local/);
});

test("raw, whitespace-control raw and comment blocks are ignored", () => {
  assert.deepEqual(
    findings(
      resources(
        "{% raw %}{{missing}}{% endraw %}{%- raw -%}{{other}}{%- endraw -%}{% comment %}{{hidden}}{% endcomment %}",
      ),
    ),
    [],
  );
});

test("tool file destinations and member/squad appended tools are checked", () => {
  const loaded = resources("Hello", {
    membersOverrides: {
      "tools:append": [{ destinations: [{ number: "{{shared}}" }] }],
    },
    members: [
      {
        assistantId: "desk",
        assistantOverrides: {
          "tools:append": [{ function: { description: "{{own}}" } }],
        },
      },
    ],
  });
  loaded.assistants[0] = file("desk", { model: { toolIds: ["transfer"] } });
  loaded.tools = [
    file("transfer", {
      type: "transferCall",
      destinations: [{ number: "{{handover_number}}" }],
    }),
  ];
  assert.match(findings(loaded)[0]!.message, /handover_number, own, shared/);
});

test("inline assistant messages and effective override prompts are checked", () => {
  const loaded = resources("{{replaced}}", {
    members: [
      {
        assistant: {
          ...prompt("{{old}}"),
          firstMessage: "{{first}}",
          voicemailMessage: "{{voicemail}}",
          endCallMessage: "{{end}}",
        },
        assistantOverrides: prompt("{{override}}"),
      },
    ],
  });
  assert.match(findings(loaded)[0]!.message, /end, first, override, voicemail/);
  assert.doesNotMatch(findings(loaded)[0]!.message, /old|replaced/);
});

test("standalone assistants, unused tools and non-rendered code are not checked", () => {
  const loaded = resources("Hello");
  loaded.assistants.push(file("standalone", prompt("{{call_time}}")));
  loaded.tools.push(
    file("unused", { function: { description: "{{unused}}" } }),
  );
  loaded.squads[0] = file("north", {
    members: [
      {
        assistantId: "desk",
        assistantOverrides: {
          "tools:append": [{ type: "code", code: "return '{{javascript}}'" }],
        },
      },
    ],
  });
  assert.deepEqual(findings(loaded), []);
  assert.deepEqual(findings({ ...loaded, squads: [] }), []);
});

test("variables introduced by expanded blocks are checked", () => {
  const root = repoCreate({
    "templates/blocks/practice.md": "Welcome to {{practice}}",
  });
  try {
    const loaded = resources();
    loaded.assistants[0] = file(
      "desk",
      blocksExpand(
        prompt("@include practice"),
        blockLayers(join(root, "resources", "north")),
      ).data,
    );
    assert.match(findings(loaded)[0]!.message, /practice/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate warns normally and blocks undefined variables with --strict", () => {
  const root = engineRepoCreate({
    "resources/north/assistants/desk.yml":
      "name: Desk\nmodel:\n  provider: openai\n  model: gpt-4o\n  messages:\n    - role: system\n      content: 'Welcome to {{practice}}'\n",
    "resources/north/squads/practice.yml":
      "name: Practice\nmembers:\n  - assistantId: desk\n",
  });
  try {
    for (const strict of [false, true]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/validate-cmd.ts",
          "north",
          ...(strict ? ["--strict"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            VAPI_GITOPS_ROOT: root,
            VAPI_TOKEN: "test-token-not-used",
            VAPI_PRIVATE_API_KEY: "test-token-not-used",
          },
          encoding: "utf8",
        },
      );
      assert.match(result.stdout, /variable-undefined/);
      assert.equal(
        result.status,
        strict ? 1 : 0,
        result.stdout + result.stderr,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty or malformed optional fields do not crash validation", () => {
  const loaded = resources("Hello", {
    members: [
      null,
      {},
      {
        assistant: { model: { tools: [null], messages: null } },
        assistantOverrides: { variableValues: null },
      },
    ],
  });
  assert.deepEqual(findings(loaded), []);
});
