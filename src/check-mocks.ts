// The fail-closed tool policy for inline PR checks: the last pass of
// checkPayloadBuild. A check runs the PR's agents in a real org with real
// conversations, so nothing in the payload may reach a real server unless
// the user turned mocks off for a dedicated CI org.
//
// - Every tool at a handled position is classified: left alone (no side
//   effect), mocked by name (function, apiRequest, transferCall), or a
//   build failure naming it. Unknown types fail.
// - Any tool-bearing key anywhere else fails ("unsupported tool position"),
//   so a new API field that carries tools can't slip through unclassified.
// - Servers are replaced with a dead address, never deleted: a deleted
//   server falls back to the phone number's or the org's server URL.
// - Default error mocks go in each scenario's toolMocks, never in assistant
//   metadata, because handoffs rebuild the assistant. Scenario toolMocks
//   apply on the LLM tool-call path; hook-fired tools bypass them, so for
//   those the dead server is the safeguard.

import type { CheckDefinition } from "./check-config.ts";
import { isObject } from "./check-payload-refs.ts";
import type { CheckRunBody } from "./check-payload.ts";

export const DEAD_SERVER_URL = "https://vapi-gitops-ci.invalid";

// Every default mock result starts with this, so a transcript scan can
// report "unmocked tool called".
export const MOCK_MARKER = "vapi-gitops-ci:";

// Keys that can carry tools in an assistant, squad or override. Only the
// handled positions below are allowed; anywhere else is a build error.
// Audit this list against the API's OpenAPI schema on each release.
export const TOOL_BEARING_KEYS: readonly string[] = [
  "tools", // handled: model.tools
  "tools:append", // handled: inside overrides
  "toolIds", // handled: model.toolIds (same-org knowledge bases only)
  "toolRefs",
  "functions",
  "skills",
  "declineToolId",
  "declineTool",
  "forwardingPhoneNumber",
  "forwardingPhoneNumbers",
  "assistantDestinations", // own rule: checked by the payload builder
];

// No external side effect: safe to send as written.
const SIDE_EFFECT_FREE = new Set(["endCall", "dtmf", "voicemail", "output"]);

// Free-form data, never tool positions: function parameters, judge
// schemas, metadata, variable values, and the mocks themselves.
const DATA_KEYS = new Set([
  "parameters",
  "schema",
  "metadata",
  "variableValues",
  "toolMocks",
  "evaluations",
  "messages",
]);

const ASSISTANT_KEYS = new Set(["assistant", "transferAssistant"]);
const OVERRIDE_KEYS = new Set([
  "assistantOverrides",
  "membersOverrides",
  "targetOverrides",
]);

interface MockWalk {
  errors: string[];
  warnings: string[];
  strict: boolean;
  stripWebhooks: boolean;
  crossOrg: boolean;
  members: Set<string>;
  mockNames: Set<string>;
}

type Where = "assistant" | "overrides" | "scenario" | "other";

interface WalkArgs {
  path: string;
  where: Where;
  personality: boolean;
  // The key this object sits under (`model`, `members`, …).
  key: string;
}

function deadServer(): Record<string, unknown> {
  return { url: DEAD_SERVER_URL, timeoutSeconds: 1 };
}

function serverReplace(node: Record<string, unknown>, always: boolean): void {
  if (always || node.server !== undefined || node.serverUrl !== undefined)
    node.server = deadServer();
  delete node.serverUrl;
  delete node.serverUrlSecret;
  if (always || node.serverMessages !== undefined) node.serverMessages = [];
}

function toolName(tool: Record<string, unknown>): string | undefined {
  const fn = isObject(tool.function) ? tool.function : undefined;
  return typeof fn?.name === "string" && fn.name !== "" ? fn.name : undefined;
}

function handoffCheck(
  w: MockWalk,
  tool: Record<string, unknown>,
  at: string,
): void {
  const destinations = Array.isArray(tool.destinations)
    ? tool.destinations
    : [];
  destinations.forEach((destination, index) => {
    const label = `${at}.destinations[${index}]`;
    if (!isObject(destination)) return;
    if (destination.type === "assistant" && isObject(destination.assistant))
      return;
    // By-ID destinations are the builder's rule; it has already failed them.
    if (destination.assistantId !== undefined) return;
    const name = destination.assistantName;
    if (
      destination.type === "assistant" &&
      typeof name === "string" &&
      w.members.has(name)
    )
      return;
    const kind =
      destination.type === "assistant"
        ? `assistant ${JSON.stringify(name ?? destination.assistantId)}`
        : String(destination.type);
    w.errors.push(
      `${label}: hands off outside the target (${kind}); only squad members and inline assistants are allowed`,
    );
  });
}

// Classify one tool at a handled position. Returns the tool to send.
function toolClassify(
  w: MockWalk,
  tool: unknown,
  at: string,
  personality: boolean,
): unknown {
  if (!isObject(tool)) return tool;
  const type = String(tool.type);
  if (SIDE_EFFECT_FREE.has(type)) return tool;
  if (personality) {
    w.errors.push(
      `${at}: a personality may only use ${[...SIDE_EFFECT_FREE].join("/")} tools, not ${type}`,
    );
    return tool;
  }
  if (type === "query") {
    if (w.crossOrg)
      w.errors.push(
        `${at}: query tools read the org's own knowledge bases and can't run in another org`,
      );
    return tool;
  }
  if (type === "handoff") {
    handoffCheck(w, tool, at);
    return tool;
  }
  if (type === "function") {
    const name = toolName(tool);
    if (!name) {
      w.errors.push(`${at}: a function tool needs function.name to be mocked`);
      return tool;
    }
    serverReplace(tool, true);
    delete tool.serverMessages;
    w.mockNames.add(name);
    return tool;
  }
  if (type === "apiRequest") {
    if (typeof tool.name !== "string" || tool.name === "") {
      w.errors.push(
        `${at}: an apiRequest tool needs a top-level name to be mocked`,
      );
      return tool;
    }
    tool.url = DEAD_SERVER_URL;
    w.mockNames.add(tool.name);
    return tool;
  }
  if (type === "transferCall") {
    // The transferCall mock name is unverified, so the transfer becomes a
    // dead-server function under its own name; it can never connect.
    const name = toolName(tool) ?? "transferCall";
    w.mockNames.add(name);
    return {
      type: "function",
      function: {
        name,
        description: `${MOCK_MARKER} transfer replaced for the check`,
        parameters: { type: "object", properties: {} },
      },
      server: deadServer(),
    };
  }
  if (type === "knowledgeBase") {
    w.errors.push(
      `${at}: inline knowledgeBase tools aren't accepted; reference it in model.toolIds`,
    );
    return tool;
  }
  w.errors.push(
    `${at}: ${type} tools can't be mocked; remove it, or set toolMocks: off with a dedicated CI org`,
  );
  return tool;
}

function toolListProcess(w: MockWalk, tools: unknown, args: WalkArgs): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool, index) => {
    const at = `${args.path}[${index}]`;
    const next = toolClassify(w, tool, at, args.personality);
    // Inline assistants inside handoff destinations are walked too.
    if (isObject(next))
      walkObject(w, next, { ...args, path: at, where: "other", key: "" });
    return next;
  });
}

function assistantHooksProcess(
  w: MockWalk,
  hooks: unknown[],
  args: WalkArgs,
): void {
  hooks.forEach((hook, hookIndex) => {
    if (!isObject(hook) || !Array.isArray(hook.do)) return;
    hook.do = hook.do.map((action, index) => {
      const at = `${args.path}[${hookIndex}].do[${index}]`;
      if (!isObject(action)) return action;
      if (action.type === "say" || action.type === "message.add") return action;
      if (action.type === "tool") {
        if (action.toolId !== undefined) {
          w.errors.push(`${at}.toolId: hook tools must be inline`);
          return action;
        }
        action.tool = toolClassify(
          w,
          action.tool,
          `${at}.tool`,
          args.personality,
        );
        return action;
      }
      if (action.type === "function") {
        serverReplace(action, true);
        delete action.serverMessages;
        return action;
      }
      w.errors.push(
        `${at}: ${String(action.type)} hook actions can't be made safe for a check; remove the hook or set toolMocks: off`,
      );
      return action;
    });
  });
}

function scenarioHooksProcess(hooks: unknown[]): void {
  for (const hook of hooks) {
    if (!isObject(hook) || !Array.isArray(hook.do)) continue;
    for (const action of hook.do)
      if (isObject(action) && action.type === "webhook")
        action.server = deadServer();
  }
}

function modelCheck(
  w: MockWalk,
  model: Record<string, unknown>,
  path: string,
): void {
  if (model.knowledgeBaseId !== undefined)
    w.errors.push(
      `${path}.knowledgeBaseId: use a knowledgeBase tool in model.toolIds instead`,
    );
  const kb = model.knowledgeBase;
  if (
    isObject(kb) &&
    (kb.provider === "custom-knowledge-base" || kb.server !== undefined)
  )
    w.errors.push(
      `${path}.knowledgeBase: a custom knowledge base calls your server; it can't run in a check`,
    );
}

function toolPositionHandle(
  w: MockWalk,
  node: Record<string, unknown>,
  key: string,
  args: WalkArgs,
): void {
  const at = `${args.path}.${key}`;
  const child = node[key];
  if (key === "tools" && args.key === "model") {
    node[key] = toolListProcess(w, child, { ...args, path: at });
    return;
  }
  if (key === "tools:append" && args.where === "overrides") {
    node[key] = toolListProcess(w, child, { ...args, path: at });
    return;
  }
  if (key === "toolIds" && args.key === "model") {
    // Only same-org knowledge bases survive the builder in toolIds.
    if (w.crossOrg)
      w.errors.push(
        `${at}: knowledge base tools are org-local and can't run in another org`,
      );
    else
      w.warnings.push(
        `${at}: knowledge base tools are kept by UUID and query the real knowledge base`,
      );
    return;
  }
  if (key === "assistantDestinations" && args.key === "members") return;
  w.errors.push(
    `${at}: unsupported tool position; move these tools to model.tools`,
  );
}

function walkValue(w: MockWalk, value: unknown, args: WalkArgs): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkValue(w, item, { ...args, path: `${args.path}[${index}]` }),
    );
    return;
  }
  if (isObject(value)) walkObject(w, value, args);
}

function walkObject(
  w: MockWalk,
  node: Record<string, unknown>,
  args: WalkArgs,
): void {
  for (const key of Object.keys(node)) {
    const child = node[key];
    const at = `${args.path}.${key}`;
    if (DATA_KEYS.has(key)) continue;
    if (TOOL_BEARING_KEYS.includes(key)) {
      if (w.strict) toolPositionHandle(w, node, key, args);
      continue;
    }
    if (key === "hooks" && Array.isArray(child)) {
      if (args.where === "scenario") scenarioHooksProcess(child);
      else if (w.strict) assistantHooksProcess(w, child, { ...args, path: at });
      continue;
    }
    if (ASSISTANT_KEYS.has(key) && isObject(child)) {
      if (w.stripWebhooks) serverReplace(child, true);
      walkObject(w, child, { ...args, path: at, where: "assistant", key });
      continue;
    }
    if (OVERRIDE_KEYS.has(key) && isObject(child)) {
      if (w.stripWebhooks) serverReplace(child, false);
      walkObject(w, child, { ...args, path: at, where: "overrides", key });
      continue;
    }
    if (key === "model" && isObject(child) && w.strict)
      modelCheck(w, child, at);
    walkValue(w, child, { ...args, path: at, key });
  }
}

function defaultMocksAdd(
  w: MockWalk,
  scenario: Record<string, unknown>,
  label: string,
): void {
  const existing = Array.isArray(scenario.toolMocks) ? scenario.toolMocks : [];
  const mocks = existing.filter(
    (mock) =>
      !(
        isObject(mock) &&
        mock.enabled === false &&
        w.mockNames.has(String(mock.toolName))
      ),
  );
  const mocked = new Set(
    mocks.filter(isObject).map((mock) => String(mock.toolName)),
  );
  for (const name of mocked)
    if (!w.mockNames.has(name))
      w.warnings.push(
        `${label}.toolMocks: "${name}" matches no mocked tool in the target`,
      );
  for (const name of w.mockNames) {
    if (mocked.has(name)) continue;
    mocks.push({
      toolName: name,
      result: JSON.stringify({
        error: `${MOCK_MARKER} ${name} is not mocked in this scenario`,
      }),
      enabled: true,
    });
  }
  scenario.toolMocks = mocks;
}

export interface CheckMocksArgs {
  body: CheckRunBody;
  check: CheckDefinition;
  errors: string[];
  warnings: string[];
}

const STOCK_PERSONALITY_RE = /^a0000000-0000-4000-8000-00000000000\d$/;

export function checkMocksApply(args: CheckMocksArgs): void {
  const { body, check } = args;
  const squad = body.target.type === "squad" ? body.target.squad : undefined;
  const members = new Set<string>();
  for (const member of Array.isArray(squad?.members) ? squad.members : [])
    if (
      isObject(member) &&
      isObject(member.assistant) &&
      typeof member.assistant.name === "string"
    )
      members.add(member.assistant.name);
  const w: MockWalk = {
    errors: args.errors,
    warnings: args.warnings,
    strict: check.toolMocks === "strict",
    stripWebhooks: check.stripWebhooks,
    crossOrg: check.runOrg !== check.org,
    members,
    mockNames: new Set(),
  };
  const base: WalkArgs = {
    path: "target",
    where: "other",
    personality: false,
    key: "",
  };
  walkObject(w, body.target, base);
  body.simulations.forEach((entry, index) => {
    const label = `simulations[${index}] (${entry.name})`;
    if ("scenarioId" in entry)
      w.errors.push(`${label}: scenarios must be inline, not by scenarioId`);
    if (
      entry.personalityId !== undefined &&
      !STOCK_PERSONALITY_RE.test(entry.personalityId)
    )
      w.errors.push(
        `${label}: personalities must be inline or stock, not ${entry.personalityId}`,
      );
    walkObject(w, entry.scenario, {
      ...base,
      path: `${label}.scenario`,
      where: "scenario",
    });
    if (entry.personality)
      walkObject(w, entry.personality, {
        ...base,
        path: `${label}.personality`,
        personality: true,
      });
  });
  if (!w.strict) return;
  body.simulations.forEach((entry, index) =>
    defaultMocksAdd(
      w,
      entry.scenario,
      `simulations[${index}] (${entry.name}).scenario`,
    ),
  );
}
