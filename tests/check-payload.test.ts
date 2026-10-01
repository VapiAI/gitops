import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CheckDefinition, CheckTarget } from "../src/check-config.ts";
import { checksConfigParse } from "../src/check-config.ts";
import type { CheckPayloadResult } from "../src/check-payload.ts";
import { checkPayloadBuild } from "../src/check-payload.ts";
import { promotionStateParse } from "../src/promotion.ts";
import { orgResourcesRead } from "../src/resource-parse.ts";
import type { StateFile } from "../src/types.ts";

const PARITY_ROOT = fileURLToPath(
  new URL("./fixtures/check-parity/", import.meta.url),
);
const STOCK_PERSONALITY = "a0000000-0000-4000-8000-000000000001";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_CRED = "33333333-3333-4333-8333-333333333333";

// One passing scenario + simulation + suite, so tests only add what they test.
const BASE_TESTS: Record<string, string> = {
  "structuredOutputs/ok.yml": "name: ok\nschema:\n  type: boolean\n",
  "simulations/scenarios/s1.yml":
    "name: S1\ninstructions: Ask a question.\nevaluations:\n  - structuredOutputId: ok\n    comparator: '='\n    value: true\n    required: true\n",
  "simulations/tests/t1.yml": `name: T1\npersonalityId: ${STOCK_PERSONALITY}\nscenarioId: s1\n`,
  "simulations/suites/core.yml": "name: Core\nsimulationIds: [t1]\n",
};

interface BuildArgs {
  files: Record<string, string>;
  target?: string;
  check?: string;
  sourceState?: Partial<StateFile>;
  runState?: Partial<StateFile>;
}

function state(entries: Partial<StateFile> = {}): StateFile {
  return { ...promotionStateParse("{}"), ...entries };
}

function checkDefinition(target: string, extra = ""): CheckDefinition {
  return checksConfigParse(
    `version: 1\nchecks:\n  core:\n    org: acme\n    targets: [${target}]\n    suites: [core]\n${extra}`,
  ).checks.core!;
}

async function build(args: BuildArgs): Promise<CheckPayloadResult> {
  const root = mkdtempSync(join(tmpdir(), "check-payload-"));
  try {
    for (const [path, content] of Object.entries({
      ...BASE_TESTS,
      ...args.files,
    })) {
      const full = join(root, "resources", "acme", path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const check = checkDefinition(
      args.target ?? "assistants/main",
      args.check ?? "",
    );
    const resources = await orgResourcesRead(root, "acme");
    const sourceState = state(args.sourceState);
    return checkPayloadBuild({
      check,
      target: check.targets[0] as CheckTarget,
      resources,
      sourceState,
      runState: args.runState ? state(args.runState) : sourceState,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assistantOf(result: CheckPayloadResult): Record<string, unknown> {
  const target = result.body?.target;
  assert.ok(target?.type === "assistant", result.errors.join("\n"));
  return target.assistant;
}

const MAIN = (model: string, extra = "") =>
  `name: Main\nmodel:\n  provider: openai\n  model: gpt-4o\n${model}${extra}`;

test("parity squad: builds from files with stored tool order, member handoffs and inline judges", async () => {
  const check = checksConfigParse(
    `version: 1\nchecks:\n  core:\n    org: parity\n    targets: [squads/dental]\n    suites: [core]\n`,
  ).checks.core!;
  const sourceState = state();
  const result = checkPayloadBuild({
    check,
    target: check.targets[0]!,
    resources: await orgResourcesRead(PARITY_ROOT, "parity"),
    sourceState,
    runState: sourceState,
  });
  const squad =
    result.body?.target.type === "squad" ? result.body.target.squad : {};
  const members = squad.members as Array<{
    assistant: {
      name: string;
      model: {
        tools: Array<Record<string, unknown>>;
        messages: Array<{ role: string; content: string }>;
      };
    };
  }>;
  const handoff = members[0]!.assistant.model.tools[2]!;
  assert.deepEqual(
    {
      errors: result.errors,
      warnings: result.warnings,
      tools: members.map((m) =>
        m.assistant.model.tools.map(
          (t) => (t.function as { name?: string } | undefined)?.name ?? t.type,
        ),
      ),
      handoff: handoff.destinations,
      prompt: members[1]!.assistant.model.messages[0]!.content.slice(0, 40),
      entries: result
        .body!.simulations.map((e) => [
          e.name,
          e.personality?.name,
          e.scenario.evaluations,
        ])
        .map(([name, personality, evaluations]) => [
          name,
          personality,
          (evaluations as Array<{ structuredOutput: { name: string } }>).map(
            (e) => e.structuredOutput.name,
          ),
        ]),
      transport: result.body!.transport,
    },
    {
      errors: [],
      warnings: [],
      // Runtime order: model.tools first, then toolIds in order.
      tools: [
        ["endCall", "lookup_patient", "handoff"],
        ["endCall", "check_availability"],
      ],
      handoff: [
        {
          type: "assistant",
          description: "Books and changes appointments, checks availability.",
          assistantName: "Scheduler",
        },
      ],
      prompt: "You are the scheduler for Bright Smile D",
      entries: [
        [
          "S1 book cleaning",
          "Dental caller",
          ["booking-confirmed", "only-real-slots"],
        ],
        ["S2 hours question", "Dental caller", ["hours-correct", "no-booking"]],
        [
          "S3 alternative slot",
          "Dental caller",
          ["offered-alternative", "booked-wednesday"],
        ],
      ],
      transport: { provider: "vapi.webchat" },
    },
  );
});

test("a .md assistant's body is its only system message, exactly as push loads it", async () => {
  const result = await build({
    files: {
      "assistants/main.md":
        "---\nname: Main\nmodel:\n  provider: openai\n  messages:\n    - role: system\n      content: stale\n---\n\nThe real prompt.\n",
    },
  });
  assert.deepEqual(assistantOf(result).model, {
    provider: "openai",
    messages: [{ role: "system", content: "The real prompt." }],
  });
});

test("toolIds that don't name a local file fail the build", async () => {
  const result = await build({
    files: { "assistants/main.yml": MAIN('  toolIds: ["missing ## gone"]\n') },
  });
  assert.deepEqual(result.errors, [
    'assistants/main.model.toolIds[0]: "missing" has no file in resources/acme/tools/',
  ]);
});

test("toolIds resolve by UUID through the source state, and server fields are stripped", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(`  toolIds: [${UUID_A}]\n`),
      "tools/lookup.yml": `id: ${UUID_A}\norgId: org\nassistant_ids: [main]\ntype: function\nfunction:\n  name: lookup\n`,
    },
    sourceState: { tools: { lookup: { uuid: UUID_A } } },
  });
  assert.deepEqual((assistantOf(result).model as { tools: unknown }).tools, [
    { type: "function", function: { name: "lookup" } },
  ]);
});

test("toolRefs are inlined after toolIds with a warning, and the pin wins over a toolIds duplicate", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(
        "  toolIds: [a, b]\n  toolRefs:\n    - toolId: a\n      version: 3\n",
      ),
      "tools/a.yml": "type: function\nfunction:\n  name: a\n",
      "tools/b.yml": "type: function\nfunction:\n  name: b\n",
    },
  });
  const model = assistantOf(result).model as {
    tools: Array<{ function: { name: string } }>;
    toolRefs?: unknown;
  };
  assert.deepEqual(
    [model.tools.map((t) => t.function.name), model.toolRefs, result.warnings],
    [
      ["b", "a"],
      undefined,
      [
        'assistants/main.model.toolRefs[0]: "a" is inlined from its file; the version pin is ignored',
      ],
    ],
  );
});

test("knowledgeBase tools stay in toolIds by their run-org UUID", async () => {
  const files = {
    "assistants/main.yml": MAIN("  toolIds: [kb, lookup]\n"),
    "tools/kb.yml": "type: knowledgeBase\nname: docs\n",
    "tools/lookup.yml": "type: function\nfunction:\n  name: lookup\n",
  };
  const kept = await build({
    files,
    sourceState: { tools: { kb: { uuid: UUID_B } } },
  });
  const missing = await build({ files });
  assert.deepEqual(
    [
      (assistantOf(kept).model as { toolIds: string[] }).toolIds,
      missing.errors,
    ],
    [
      [UUID_B],
      [
        `assistants/main.model.toolIds[0]: knowledgeBase tool "kb" can't be sent inline and has no UUID in the run org's state`,
      ],
    ],
  );
});

test("two inlined tools with the same type and name fail the build", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(
        "  tools:\n    - type: function\n      function:\n        name: lookup\n  toolIds: [lookup]\n",
      ),
      "tools/lookup.yml": "type: function\nfunction:\n  name: lookup\n",
    },
  });
  assert.deepEqual(result.errors, [
    'assistants/main.model.tools: two tools named "lookup" (type function); stored, both are kept, but inline the second is dropped — rename one',
  ]);
});

test("hook do[].toolId becomes an inline tool", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(
        "",
        "hooks:\n  - on: call.ending\n    do:\n      - type: tool\n        toolId: notify\n",
      ),
      "tools/notify.yml": "type: function\nfunction:\n  name: notify\n",
    },
  });
  assert.deepEqual(assistantOf(result).hooks, [
    {
      on: "call.ending",
      do: [
        {
          type: "tool",
          tool: { type: "function", function: { name: "notify" } },
        },
      ],
    },
  ]);
});

test("structured outputs from artifactPlan and from their own assistant_ids are inlined once", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(
        "",
        "artifactPlan:\n  structuredOutputIds: [summary]\n",
      ),
      "structuredOutputs/summary.yml":
        "name: summary\nassistant_ids: [main]\nschema:\n  type: string\n",
      "structuredOutputs/sentiment.yml": `name: sentiment\nassistant_ids: [${UUID_A}]\nschema:\n  type: string\n`,
      "structuredOutputs/other.yml":
        "name: other\nassistant_ids: [someone-else]\nschema:\n  type: string\n",
    },
    sourceState: { assistants: { main: { uuid: UUID_A } } },
  });
  assert.deepEqual(assistantOf(result).artifactPlan, {
    structuredOutputs: [
      { name: "summary", schema: { type: "string" } },
      { name: "sentiment", schema: { type: "string" } },
    ],
  });
});

test("an assistant target that hands off to another assistant fails the build", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN("  toolIds: [to-other]\n"),
      "tools/to-other.yml":
        "type: handoff\ndestinations:\n  - type: assistant\n    assistantId: other\n",
    },
  });
  assert.deepEqual(result.errors, [
    'assistants/main.model.tools[0].destinations[0]: an assistant target can\'t hand off to "other"; make the target a squad of those assistants',
  ]);
});

test("squad members are inlined by file, UUID or inline assistant, and handoffs become member names", async () => {
  const result = await build({
    target: "squads/team",
    files: {
      "squads/team.yml": `name: Team\nmembers:\n  - assistantId: a\n    assistantVersion: 4\n  - assistantId: ${UUID_B}\n  - assistant:\n      name: C\n      model:\n        provider: openai\n        tools:\n          - type: handoff\n            destinations:\n              - type: assistant\n                assistantId: a\n`,
      "assistants/a.yml":
        "name: A\nmodel:\n  provider: openai\n  toolIds: [to-b]\n",
      "assistants/b.yml": "name: B\nmodel:\n  provider: openai\n",
      "tools/to-b.yml": `type: handoff\ndestinations:\n  - type: assistant\n    assistantId: ${UUID_B}\n`,
    },
    sourceState: { assistants: { b: { uuid: UUID_B } } },
  });
  const squad =
    result.body?.target.type === "squad" ? result.body.target.squad : {};
  const members = squad.members as Array<{
    assistant: {
      name: string;
      model: { tools?: Array<{ destinations: unknown }> };
    };
    assistantId?: string;
    assistantVersion?: number;
  }>;
  assert.deepEqual(
    {
      errors: result.errors,
      warnings: result.warnings,
      names: members.map((m) => m.assistant.name),
      ids: members.map((m) => m.assistantId ?? m.assistantVersion),
      handoffs: [
        members[0]!.assistant.model.tools![0]!.destinations,
        members[2]!.assistant.model.tools![0]!.destinations,
      ],
    },
    {
      errors: [],
      warnings: [
        "squads/team.members[0]: assistantVersion is ignored; the member is built from its file",
      ],
      names: ["A", "B", "C"],
      ids: [undefined, undefined, undefined],
      handoffs: [
        [{ type: "assistant", assistantName: "B" }],
        [{ type: "assistant", assistantName: "A" }],
      ],
    },
  );
});

test("squad problems are all reported: unnamed and duplicate members, outside handoffs, legacy destinations", async () => {
  const result = await build({
    target: "squads/team",
    files: {
      "squads/team.yml":
        "name: Team\nmembers:\n  - assistantId: a\n  - assistantId: a2\n  - assistantId: nameless\n  - assistantId: b\n    assistantDestinations:\n      - assistantId: a\n",
      "assistants/a.yml":
        "name: A\nmodel:\n  provider: openai\n  toolIds: [to-outside]\n",
      "assistants/a2.yml": "name: A\nmodel:\n  provider: openai\n",
      "assistants/nameless.yml": "model:\n  provider: openai\n",
      "assistants/b.yml": "name: B\nmodel:\n  provider: openai\n",
      "assistants/outside.yml": "name: Outside\n",
      "tools/to-outside.yml":
        "type: handoff\ndestinations:\n  - type: assistant\n    assistantId: outside\n",
    },
  });
  assert.deepEqual(result.errors, [
    'squads/team.members[1]: two members are named "A"; member names must be unique',
    "squads/team.members[2]: the member assistant needs a name (handoffs inside a squad target it by name)",
    'assistants/a.model.tools[0].destinations[0]: hands off to "outside", which isn\'t a member of the squad; add it as a member',
    "squads/team.members[3].assistantDestinations[0]: legacy assistantDestinations by ID aren't supported inline; convert it to a handoff tool",
  ]);
});

test("under strict mocks, tools referenced by ID inside overrides fail; with toolMocks off they pass", async () => {
  const files = {
    "squads/team.yml":
      "name: Team\nmembers:\n  - assistantId: a\nmembersOverrides:\n  model:\n    toolIds: [lookup]\n",
    "assistants/a.yml": "name: A\nmodel:\n  provider: openai\n",
    "tools/lookup.yml": "type: function\nfunction:\n  name: lookup\n",
  };
  const strict = await build({ target: "squads/team", files });
  const off = await build({
    target: "squads/team",
    files,
    check: "    toolMocks: off\n",
  });
  assert.deepEqual(
    [strict.errors, off.errors.filter((e) => !e.includes("still a name"))],
    [
      [
        "squads/team.membersOverrides.model.toolIds: tools inside overrides must be inline (model.tools or tools:append)",
      ],
      [],
    ],
  );
});

test("credentials bind by name to the run org's UUIDs; omit drops them; a missing bind fails", async () => {
  const files = {
    "assistants/main.yml": MAIN(
      "",
      "voice:\n  provider: 11labs\n  credentialId: eleven\n",
    ),
  };
  const bound = await build({
    files,
    runState: { credentials: { eleven: { uuid: UUID_CRED } } },
  });
  const omitted = await build({
    files,
    check: "    bindings:\n      credentials:\n        default: omit\n",
  });
  const missing = await build({ files });
  assert.deepEqual(
    [assistantOf(bound).voice, assistantOf(omitted).voice, missing.errors],
    [
      { provider: "11labs", credentialId: UUID_CRED },
      { provider: "11labs" },
      [
        'run org acme: Credential binding "eleven" is required in the target state',
      ],
    ],
  );
});

test("a reference left as a name anywhere fails the build; free-form parameters are ignored", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(
        "  tools:\n    - type: function\n      function:\n        name: f\n        parameters:\n          type: object\n          properties:\n            toolId: { type: string }\n",
        "transferPlan:\n  assistantId: somewhere\n",
      ),
    },
  });
  assert.deepEqual(result.errors, [
    'body.target.assistant.transferPlan.assistantId: "somewhere" is still a name, not a UUID; it couldn\'t be resolved for the run org',
  ]);
});

test("over chat: audio judges, scenarios without a required text judge, and scenario hooks fail", async () => {
  const files = {
    "assistants/main.yml": MAIN(""),
    "structuredOutputs/audio.yml":
      "name: audio\ntarget: messages-with-audio\nschema:\n  type: boolean\n",
    "simulations/scenarios/s1.yml":
      "name: S1\ninstructions: Hi.\nevaluations:\n  - structuredOutputId: audio\n    comparator: '='\n    value: true\n  - structuredOutputId: ok\n    comparator: '='\n    value: true\n    required: false\nhooks:\n  - on: call.started\n    do: []\n",
  };
  const chat = await build({ files });
  const voice = await build({ files, check: "    transport: voice\n" });
  assert.deepEqual(
    [chat.errors, voice.errors, voice.body?.transport],
    [
      [
        "simulations/scenarios/s1.evaluations[0]: a messages-with-audio judge needs transport: voice",
        "simulations/scenarios/s1: needs at least one required text judge (a scenario with none can't fail)",
        "simulations/scenarios/s1: scenario hooks don't run over chat; remove them or use transport: voice",
      ],
      [],
      { provider: "vapi.websocket" },
    ],
  );
});

test("simulations: stock personalities pass by ID, local ones inline, names stay unique within 80 characters", async () => {
  const long = "x".repeat(90);
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(""),
      "simulations/personalities/calm.yml":
        "name: Calm\nassistant:\n  model:\n    provider: openai\n",
      "simulations/tests/t1.yml": `name: ${long}\npersonalityId: ${STOCK_PERSONALITY}\nscenarioId: s1\n`,
      "simulations/tests/t2.yml": `name: ${long}\npersonalityId: calm\nscenarioId: s1 ## same scenario\n`,
      "simulations/suites/core.yml":
        "name: Core\nsimulationIds: [t1, t2, t1]\n",
    },
  });
  const entries = result.body!.simulations;
  assert.deepEqual(
    entries.map((e) => [
      e.name.length,
      e.name.slice(-4),
      e.personalityId,
      e.personality?.name,
    ]),
    [
      [80, "xxxx", STOCK_PERSONALITY, undefined],
      [80, " (2)", undefined, "Calm"],
    ],
  );
});

test("missing suites, simulations, scenarios and personalities are each named", async () => {
  const result = await build({
    files: {
      "assistants/main.yml": MAIN(""),
      "simulations/tests/t2.yml":
        "name: T2\npersonalityId: nobody\nscenarioId: s1\n",
      "simulations/tests/t3.yml": `name: T3\npersonalityId: ${STOCK_PERSONALITY}\nscenarioId: nowhere\n`,
      "simulations/suites/core.yml":
        "name: Core\nsimulationIds: [t2, t3, ghost]\n",
    },
    check: "    simulations: [t1]\n",
  });
  assert.deepEqual(result.errors, [
    'simulations/tests/t2.personalityId: "nobody" has no file in resources/acme/simulations/personalities/',
    'simulations/tests/t3.scenarioId: "nowhere" has no file in resources/acme/simulations/scenarios/',
    'checks.core: "ghost" has no file in resources/acme/simulations/tests/',
  ]);
});

test("a missing target is named", async () => {
  const result = await build({ files: {}, target: "squads/nope" });
  assert.deepEqual(result.errors, [
    'target squads/nope: "nope" has no file in resources/acme/squads/',
  ]);
});

test("auto-named handoffs warn when text mentions handoff_to_", async () => {
  const result = await build({
    target: "squads/team",
    files: {
      "squads/team.yml":
        "name: Team\nmembers:\n  - assistantId: a\n  - assistantId: b\n",
      "assistants/a.md":
        "---\nname: A\nmodel:\n  provider: openai\n  toolIds: [to-b]\n---\nCall handoff_to_B when booking.\n",
      "assistants/b.yml": "name: B\nmodel:\n  provider: openai\n",
      "tools/to-b.yml":
        "type: handoff\ndestinations:\n  - type: assistant\n    assistantId: b\n",
    },
  });
  assert.deepEqual(result.warnings, [
    'text mentions "handoff_to_…", but a handoff tool has no explicit function.name; generated names differ inline (handoff_to_<assistantName>) and stored (handoff_to_<uuid>), so give it an explicit function.name',
  ]);
});

test("payloads above 4.5 MB fail", async () => {
  const result = await build({
    files: {
      "assistants/main.md": `---\nname: Main\nmodel:\n  provider: openai\n---\n${"p".repeat(5 * 1024 * 1024)}\n`,
    },
  });
  assert.deepEqual(result.errors, ["payload is 5.0 MB; the limit is 4.5 MB"]);
});
