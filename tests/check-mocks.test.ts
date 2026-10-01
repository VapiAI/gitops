import assert from "node:assert/strict";
import test from "node:test";
import { checksConfigParse } from "../src/check-config.ts";
import {
  checkMocksApply,
  DEAD_SERVER_URL,
  MOCK_MARKER,
  TOOL_BEARING_KEYS,
} from "../src/check-mocks.ts";
import type {
  CheckRunBody,
  CheckSimulationEntry,
} from "../src/check-payload.ts";

const DEAD = { url: DEAD_SERVER_URL, timeoutSeconds: 1 };

interface ApplyArgs {
  target: CheckRunBody["target"];
  scenario?: Record<string, unknown>;
  personality?: Record<string, unknown>;
  entry?: Partial<CheckSimulationEntry> & Record<string, unknown>;
  check?: string;
}

function apply(args: ApplyArgs): {
  body: CheckRunBody;
  errors: string[];
  warnings: string[];
} {
  const check = checksConfigParse(
    `version: 1\nchecks:\n  core:\n    org: acme\n    targets: [squads/s]\n    suites: [core]\n${args.check ?? ""}`,
  ).checks.core!;
  const body: CheckRunBody = {
    simulations: [
      {
        type: "simulation",
        name: "S1",
        scenario: args.scenario ?? { name: "S1", toolMocks: [] },
        ...(args.personality
          ? { personality: args.personality }
          : { personalityId: "a0000000-0000-4000-8000-000000000001" }),
        ...args.entry,
      } as CheckSimulationEntry,
    ],
    target: args.target,
    transport: { provider: "vapi.webchat" },
    iterations: 1,
  };
  const errors: string[] = [];
  const warnings: string[] = [];
  checkMocksApply({ body, check, errors, warnings });
  return { body, errors, warnings };
}

function assistantTarget(
  assistant: Record<string, unknown>,
): CheckRunBody["target"] {
  return { type: "assistant", assistant };
}

function withTools(tools: unknown[]): CheckRunBody["target"] {
  return assistantTarget({ name: "A", model: { provider: "openai", tools } });
}

function toolsOf(body: CheckRunBody): unknown[] {
  const target = body.target;
  assert.ok(target.type === "assistant");
  return (target.assistant.model as { tools: unknown[] }).tools;
}

function errorFor(tool: Record<string, unknown>, check = ""): string[] {
  return apply({ target: withTools([tool]), check }).errors;
}

test("side-effect-free tools are sent as written", () => {
  const tools = [
    { type: "endCall" },
    { type: "dtmf" },
    { type: "voicemail" },
    { type: "output" },
  ];
  const result = apply({ target: withTools(structuredClone(tools)) });
  assert.deepEqual([result.errors, toolsOf(result.body)], [[], tools]);
});

test("function tools get the dead server and a default error mock in every scenario", () => {
  const result = apply({
    target: withTools([
      {
        type: "function",
        function: { name: "book" },
        server: { url: "https://crm.example.com/hook", secret: "s" },
        serverUrl: "https://legacy.example.com",
        serverUrlSecret: "x",
      },
    ]),
  });
  assert.deepEqual(
    [
      result.errors,
      toolsOf(result.body),
      result.body.simulations[0]!.scenario.toolMocks,
    ],
    [
      [],
      [{ type: "function", function: { name: "book" }, server: DEAD }],
      [
        {
          toolName: "book",
          result: JSON.stringify({
            error: `${MOCK_MARKER} book is not mocked in this scenario`,
          }),
          enabled: true,
        },
      ],
    ],
  );
});

test("scenario mocks are kept, disabled ones are replaced, and mocks for unknown tools warn", () => {
  const result = apply({
    target: withTools([
      { type: "function", function: { name: "book" } },
      { type: "function", function: { name: "lookup" } },
    ]),
    scenario: {
      name: "S1",
      toolMocks: [
        { toolName: "book", result: '{"ok":true}', enabled: true },
        { toolName: "lookup", result: '{"stale":true}', enabled: false },
        { toolName: "ghost", result: "{}" },
      ],
    },
  });
  assert.deepEqual(
    [result.body.simulations[0]!.scenario.toolMocks, result.warnings],
    [
      [
        { toolName: "book", result: '{"ok":true}', enabled: true },
        { toolName: "ghost", result: "{}" },
        {
          toolName: "lookup",
          result: JSON.stringify({
            error: `${MOCK_MARKER} lookup is not mocked in this scenario`,
          }),
          enabled: true,
        },
      ],
      [
        'simulations[0] (S1).scenario.toolMocks: "ghost" matches no mocked tool in the target',
      ],
    ],
  );
});

test("apiRequest tools are mocked by their top-level name and point at the dead host", () => {
  const result = apply({
    target: withTools([
      {
        type: "apiRequest",
        name: "crm_lookup",
        method: "POST",
        url: "https://crm.example.com/api",
      },
    ]),
  });
  assert.deepEqual(
    [
      toolsOf(result.body),
      (
        result.body.simulations[0]!.scenario.toolMocks as Array<{
          toolName: string;
        }>
      ).map((m) => m.toolName),
    ],
    [
      [
        {
          type: "apiRequest",
          name: "crm_lookup",
          method: "POST",
          url: DEAD_SERVER_URL,
        },
      ],
      ["crm_lookup"],
    ],
  );
});

test("transferCall becomes a mocked dead-server function under its own name", () => {
  const result = apply({
    target: withTools([
      {
        type: "transferCall",
        function: { name: "transfer_to_billing" },
        destinations: [{ type: "number", number: "+14155550100" }],
      },
    ]),
  });
  assert.deepEqual(toolsOf(result.body), [
    {
      type: "function",
      function: {
        name: "transfer_to_billing",
        description: `${MOCK_MARKER} transfer replaced for the check`,
        parameters: { type: "object", properties: {} },
      },
      server: DEAD,
    },
  ]);
});

test("every tool that can't be mocked fails the build, naming it", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { type: "function" },
      "target.assistant.model.tools[0]: a function tool needs function.name to be mocked",
    ],
    [
      { type: "apiRequest", url: "https://x" },
      "target.assistant.model.tools[0]: an apiRequest tool needs a top-level name to be mocked",
    ],
    [
      { type: "knowledgeBase" },
      "target.assistant.model.tools[0]: inline knowledgeBase tools aren't accepted; reference it in model.toolIds",
    ],
    ...[
      "sms",
      "sipRequest",
      "code",
      "mcp",
      "bash",
      "computer",
      "textEditor",
      "transferCancel",
      "transferSuccessful",
      "google.calendar.event.create",
      "slack.message.send",
      "gohighlevel.contact.create",
      "ghl",
      "make",
      "brand-new-type",
    ].map((type): [Record<string, unknown>, string] => [
      { type },
      `target.assistant.model.tools[0]: ${type} tools can't be mocked; remove it, or set toolMocks: off with a dedicated CI org`,
    ]),
  ];
  assert.deepEqual(
    cases.map(([tool]) => errorFor(tool)),
    cases.map(([, message]) => [message]),
  );
});

test("query tools run only in their own org", () => {
  assert.deepEqual(
    [
      errorFor({ type: "query" }),
      errorFor({ type: "query" }, "    runOrg: acme-ci\n"),
    ],
    [
      [],
      [
        "target.assistant.model.tools[0]: query tools read the org's own knowledge bases and can't run in another org",
      ],
    ],
  );
});

test("knowledge bases kept in model.toolIds warn in the same org and fail in another", () => {
  const target = () =>
    assistantTarget({
      name: "A",
      model: {
        provider: "openai",
        toolIds: ["44444444-4444-4444-8444-444444444444"],
      },
    });
  const same = apply({ target: target() });
  const cross = apply({ target: target(), check: "    runOrg: acme-ci\n" });
  assert.deepEqual(
    [same.errors, same.warnings, cross.errors],
    [
      [],
      [
        "target.assistant.model.toolIds: knowledge base tools are kept by UUID and query the real knowledge base",
      ],
      [
        "target.assistant.model.toolIds: knowledge base tools are org-local and can't run in another org",
      ],
    ],
  );
});

test("a tool-bearing key outside a handled position fails, for every key", () => {
  const unhandled = TOOL_BEARING_KEYS.filter(
    (key) => key !== "assistantDestinations",
  );
  const errors = unhandled.map(
    (key) =>
      apply({ target: assistantTarget({ name: "A", [key]: [] }) }).errors,
  );
  assert.deepEqual(
    errors,
    unhandled.map((key) => [
      `target.assistant.${key}: unsupported tool position; move these tools to model.tools`,
    ]),
  );
});

test("model.functions, model.toolRefs and tools:append outside overrides fail; assistantDestinations outside a member fails", () => {
  const result = apply({
    target: assistantTarget({
      name: "A",
      model: { provider: "openai", functions: [], toolRefs: [] },
      assistantDestinations: [],
    }),
  });
  const squad = apply({
    target: {
      type: "squad",
      squad: {
        members: [{ assistant: { name: "A" }, assistantDestinations: [] }],
      },
    },
  });
  assert.deepEqual(
    [result.errors, squad.errors],
    [
      [
        "target.assistant.model.functions: unsupported tool position; move these tools to model.tools",
        "target.assistant.model.toolRefs: unsupported tool position; move these tools to model.tools",
        "target.assistant.assistantDestinations: unsupported tool position; move these tools to model.tools",
      ],
      [],
    ],
  );
});

test("a parameter or schema property named tools is data, not a tool position", () => {
  const result = apply({
    target: withTools([
      {
        type: "function",
        function: {
          name: "f",
          parameters: {
            type: "object",
            properties: {
              tools: { type: "array" },
              toolIds: { type: "array" },
            },
          },
        },
      },
    ]),
    scenario: {
      name: "S1",
      evaluations: [
        {
          structuredOutput: {
            name: "j",
            schema: {
              type: "object",
              properties: { tools: { type: "string" } },
            },
          },
        },
      ],
      toolMocks: [],
    },
  });
  assert.deepEqual(result.errors, []);
});

test("handoffs: members and inline assistants pass, everything else fails, and inline assistants are walked", () => {
  const handoff = (destinations: unknown[]) => ({
    type: "handoff",
    destinations,
  });
  const result = apply({
    target: {
      type: "squad",
      squad: {
        members: [
          {
            assistant: {
              name: "A",
              model: {
                provider: "openai",
                tools: [
                  handoff([{ type: "assistant", assistantName: "B" }]),
                  handoff([
                    {
                      type: "assistant",
                      assistant: {
                        name: "Inline",
                        model: { provider: "openai", tools: [{ type: "sms" }] },
                      },
                    },
                  ]),
                  handoff([{ type: "assistant", assistantName: "Stranger" }]),
                  handoff([
                    {
                      type: "dynamic",
                      server: { url: "https://router.example.com" },
                    },
                  ]),
                  handoff([
                    {
                      type: "squad",
                      squadId: "55555555-5555-4555-8555-555555555555",
                    },
                  ]),
                ],
              },
            },
          },
          { assistant: { name: "B" } },
        ],
      },
    },
  });
  const squad =
    result.body.target.type === "squad" ? result.body.target.squad : {};
  const inline = (
    squad.members as Array<{
      assistant: {
        model: {
          tools: Array<{
            destinations: Array<{ assistant: { server: unknown } }>;
          }>;
        };
      };
    }>
  )[0]!.assistant.model.tools[1]!.destinations[0]!.assistant;
  assert.deepEqual(
    [result.errors, inline.server],
    [
      [
        "target.squad.members[0].assistant.model.tools[1].destinations[0].assistant.model.tools[0]: sms tools can't be mocked; remove it, or set toolMocks: off with a dedicated CI org",
        'target.squad.members[0].assistant.model.tools[2].destinations[0]: hands off outside the target (assistant "Stranger"); only squad members and inline assistants are allowed',
        "target.squad.members[0].assistant.model.tools[3].destinations[0]: hands off outside the target (dynamic); only squad members and inline assistants are allowed",
        "target.squad.members[0].assistant.model.tools[4].destinations[0]: hands off outside the target (squad); only squad members and inline assistants are allowed",
      ],
      DEAD,
    ],
  );
});

test("every assistant gets the dead server and no server messages; overrides only when they set one", () => {
  const result = apply({
    target: {
      type: "squad",
      squad: {
        members: [
          {
            assistant: {
              name: "A",
              server: { url: "https://real.example.com" },
              serverMessages: ["tool-calls"],
            },
            assistantOverrides: {
              server: { url: "https://override.example.com" },
              serverUrl: "https://x",
            },
          },
          {
            assistant: { name: "B" },
            assistantOverrides: { variableValues: { a: 1 } },
          },
        ],
      },
    },
  });
  const squad =
    result.body.target.type === "squad" ? result.body.target.squad : {};
  assert.deepEqual(squad.members, [
    {
      assistant: { name: "A", server: DEAD, serverMessages: [] },
      assistantOverrides: { server: DEAD },
    },
    {
      assistant: { name: "B", server: DEAD, serverMessages: [] },
      assistantOverrides: { variableValues: { a: 1 } },
    },
  ]);
});

test("assistant hook actions: say and message.add pass, tools are classified, functions get the dead server, transfers fail", () => {
  const result = apply({
    target: assistantTarget({
      name: "A",
      hooks: [
        {
          on: "call.ending",
          do: [
            { type: "say", exact: "Bye" },
            { type: "message.add", message: { role: "system", content: "x" } },
            {
              type: "tool",
              tool: {
                type: "function",
                function: { name: "notify" },
                server: { url: "https://real" },
              },
            },
            { type: "tool", tool: { type: "sms" } },
            { type: "tool", toolId: "66666666-6666-4666-8666-666666666666" },
            {
              type: "function",
              function: { name: "legacy" },
              server: { url: "https://real" },
            },
            {
              type: "transfer",
              destination: { type: "number", number: "+14155550100" },
            },
          ],
        },
      ],
    }),
  });
  const target =
    result.body.target.type === "assistant" ? result.body.target.assistant : {};
  const actions = (
    target.hooks as Array<{ do: Array<Record<string, unknown>> }>
  )[0]!.do;
  assert.deepEqual(
    [
      result.errors,
      (actions[2]!.tool as { server: unknown }).server,
      actions[5]!.server,
    ],
    [
      [
        "target.assistant.hooks[0].do[3].tool: sms tools can't be mocked; remove it, or set toolMocks: off with a dedicated CI org",
        "target.assistant.hooks[0].do[4].toolId: hook tools must be inline",
        "target.assistant.hooks[0].do[6]: transfer hook actions can't be made safe for a check; remove the hook or set toolMocks: off",
      ],
      DEAD,
      DEAD,
    ],
  );
});

test("scenario webhook hooks point at the dead server", () => {
  const result = apply({
    target: withTools([]),
    scenario: {
      name: "S1",
      hooks: [
        {
          on: "call.ended",
          do: [
            { type: "webhook", server: { url: "https://real.example.com" } },
          ],
        },
      ],
      toolMocks: [],
    },
  });
  assert.deepEqual(result.body.simulations[0]!.scenario.hooks, [
    { on: "call.ended", do: [{ type: "webhook", server: DEAD }] },
  ]);
});

test("personalities may only use side-effect-free tools, and their assistant gets the dead server", () => {
  const result = apply({
    target: withTools([]),
    personality: {
      name: "Caller",
      assistant: {
        model: {
          provider: "openai",
          tools: [
            { type: "endCall" },
            { type: "function", function: { name: "x" } },
          ],
        },
      },
    },
  });
  const personality = result.body.simulations[0]!.personality as {
    assistant: { server: unknown };
  };
  assert.deepEqual(
    [result.errors, personality.assistant.server],
    [
      [
        "simulations[0] (S1).personality.assistant.model.tools[1]: a personality may only use endCall/dtmf/voicemail/output tools, not function",
      ],
      DEAD,
    ],
  );
});

test("knowledgeBaseId and custom knowledge bases on a model fail", () => {
  const result = apply({
    target: assistantTarget({
      name: "A",
      model: {
        provider: "openai",
        knowledgeBaseId: "77777777-7777-4777-8777-777777777777",
        knowledgeBase: {
          provider: "custom-knowledge-base",
          server: { url: "https://kb" },
        },
      },
    }),
  });
  assert.deepEqual(result.errors, [
    "target.assistant.model.knowledgeBaseId: use a knowledgeBase tool in model.toolIds instead",
    "target.assistant.model.knowledgeBase: a custom knowledge base calls your server; it can't run in a check",
  ]);
});

test("entries must carry their scenario inline and a stock or inline personality", () => {
  const result = apply({
    target: withTools([]),
    entry: {
      scenarioId: "88888888-8888-4888-8888-888888888888",
      personalityId: "99999999-9999-4999-8999-999999999999",
    },
  });
  assert.deepEqual(result.errors, [
    "simulations[0] (S1): scenarios must be inline, not by scenarioId",
    "simulations[0] (S1): personalities must be inline or stock, not 99999999-9999-4999-8999-999999999999",
  ]);
});

test("toolMocks off sends tools as written; stripWebhooks still replaces assistant servers", () => {
  const tools = [
    { type: "sms" },
    {
      type: "function",
      function: { name: "f" },
      server: { url: "https://real" },
    },
  ];
  const result = apply({
    target: assistantTarget({
      name: "A",
      server: { url: "https://real" },
      model: { provider: "openai", tools: structuredClone(tools) },
    }),
    check: "    toolMocks: off\n",
  });
  const target =
    result.body.target.type === "assistant" ? result.body.target.assistant : {};
  assert.deepEqual(
    [
      result.errors,
      (target.model as { tools: unknown }).tools,
      target.server,
      result.body.simulations[0]!.scenario.toolMocks,
    ],
    [[], tools, DEAD, []],
  );
});

test("stripWebhooks false keeps assistant servers but strict mocks still replace tool servers", () => {
  const result = apply({
    target: assistantTarget({
      name: "A",
      server: { url: "https://real" },
      model: {
        provider: "openai",
        tools: [
          {
            type: "function",
            function: { name: "f" },
            server: { url: "https://real" },
          },
        ],
      },
    }),
    check: "    stripWebhooks: false\n",
  });
  const target =
    result.body.target.type === "assistant" ? result.body.target.assistant : {};
  assert.deepEqual(
    [
      target.server,
      (target.model as { tools: Array<{ server: unknown }> }).tools[0]!.server,
    ],
    [{ url: "https://real" }, DEAD],
  );
});
