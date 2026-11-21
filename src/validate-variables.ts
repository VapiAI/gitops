import type { LoadedResources } from "./types.ts";
import type { ValidationFinding } from "./validate.ts";

type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Vapi: libs/core/src/util/mergeUtil/{assistantDefaultOverridesBuild,variableUtil}.ts
// (assistantDefaultOverridesBuild and timeVariablesGet), via handoffVariableBagBuild.
const BUILT_INS = [
  "customer",
  "phoneNumber",
  "transport",
  "call",
  "now",
  "currentDateTime",
  "date",
  "time",
  "year",
  "month",
  "day",
];
const LITERALS = new Set([
  "true",
  "false",
  "nil",
  "null",
  "empty",
  "blank",
  "and",
  "or",
  "contains",
]);

function references(text: string): Set<string> {
  const found = new Set<string>();
  const locals = new Set<string>();
  const loops: Set<string>[] = [];
  const clean = text.replace(
    /{%-?\s*(raw|comment)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g,
    "",
  );
  const expression = (value: string) => {
    const bare = value.replace(
      /"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g,
      "''",
    );
    for (const match of bare.matchAll(
      /(?<![\w.])([A-Za-z_][\w-]*)(?:\.[\w-]+)*/g,
    )) {
      const name = match[1]!;
      const before = bare.slice(0, match.index).trimEnd();
      const after = bare.slice(match.index! + match[0].length);
      if (before.endsWith("|") || /^\s*:/.test(after)) continue;
      if (
        !LITERALS.has(name) &&
        !locals.has(name) &&
        !loops.some((scope) => scope.has(name))
      )
        found.add(name);
    }
  };
  for (const token of clean.matchAll(
    /{{-?([\s\S]*?)-?}}|{%-?([\s\S]*?)-?%}/g,
  )) {
    if (token[1] !== undefined) {
      expression(token[1]);
      continue;
    }
    const tag = token[2]!.trim();
    const assign = /^(assign|capture)\s+([\w-]+)(?:\s*=\s*([\s\S]*))?/.exec(
      tag,
    );
    if (assign) {
      if (assign[3]) expression(assign[3]);
      locals.add(assign[2]!);
    } else {
      const loop = /^for\s+([\w-]+)\s+in\s+([\s\S]*)/.exec(tag);
      if (loop) {
        expression(loop[2]!);
        loops.push(new Set([loop[1]!, "forloop"]));
      } else if (/^endfor\b/.test(tag)) loops.pop();
      else if (/^(if|unless|elsif|case|when|echo)\s/.test(tag))
        expression(tag.replace(/^\w+\s+/, ""));
    }
  }
  return found;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return Object.values(record(value)).flatMap(strings);
}

function merge(base: unknown, overrides: unknown): Data {
  const result = { ...record(base) };
  for (const [key, value] of Object.entries(record(overrides))) {
    result[key] = Object.keys(record(value)).length
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function extractionNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) extractionNames(child, names);
    return;
  }
  const data = record(value);
  const plan = record(data.variableExtractionPlan);
  for (const name of Object.keys(record(record(plan.schema).properties)))
    names.add(name);
  for (const alias of list(plan.aliases)) {
    const key = record(alias).key;
    if (typeof key === "string") names.add(key);
  }
  for (const [key, child] of Object.entries(data)) {
    if (key !== "variableExtractionPlan") extractionNames(child, names);
  }
}

function assistantTexts(assistant: Data): string[] {
  const model = record(assistant.model);
  return [
    assistant.firstMessage,
    assistant.voicemailMessage,
    assistant.endCallMessage,
    model.systemPrompt,
    ...list(model.messages)
      .filter((message) => record(message).role === "system")
      .map((message) => record(message).content),
  ].flatMap(strings);
}

function toolTexts(tool: unknown): string[] {
  // Code is executed, not Liquid-rendered; extraction aliases have their own result bag.
  const { code: _code, variableExtractionPlan: _plan, ...data } = record(tool);
  return Object.entries(data).flatMap(([key, value]) => {
    if (key === "destinations") return list(value).flatMap(toolTexts);
    return strings(value);
  });
}

export function validateVariables(
  resources: LoadedResources,
): ValidationFinding[] {
  const assistants = new Map(
    resources.assistants.map((file) => [file.resourceId, file.data]),
  );
  const tools = new Map(
    resources.tools.map((file) => [file.resourceId, file.data]),
  );
  const findings: ValidationFinding[] = [];
  for (const squadFile of resources.squads) {
    const squad = record(squadFile.data);
    const shared = record(squad.membersOverrides);
    const members = list(squad.members).map((value, index) => {
      const member = record(value);
      const own = record(member.assistantOverrides);
      const overrides = { ...own, ...shared };
      const base =
        typeof member.assistantId === "string"
          ? assistants.get(member.assistantId)
          : member.assistant;
      const assistant = merge(base, overrides);
      const model = record(assistant.model);
      const attached = [
        ...list(model.tools),
        ...list(model.toolIds).flatMap((id) =>
          typeof id === "string" && tools.has(id) ? [tools.get(id)] : [],
        ),
        ...list(own["tools:append"]),
        ...list(shared["tools:append"]),
      ];
      return { member, own, assistant, attached, index };
    });
    const runtime = new Set(BUILT_INS);
    for (const member of members) extractionNames(member.attached, runtime);
    for (const { member, own, assistant, attached, index } of members) {
      const defined = new Set([
        ...runtime,
        ...Object.keys(record(own.variableValues)),
        ...Object.keys(record(shared.variableValues)),
      ]);
      const missing = new Set<string>();
      for (const text of [
        ...assistantTexts(assistant),
        ...attached.flatMap(toolTexts),
      ]) {
        for (const name of references(text))
          if (!defined.has(name)) missing.add(name);
      }
      if (missing.size === 0) continue;
      const label =
        typeof member.assistantId === "string"
          ? member.assistantId
          : String(record(member.assistant).name ?? index);
      findings.push({
        severity: "warn",
        type: "squads",
        resourceId: squadFile.resourceId,
        rule: "variable-undefined",
        fieldPath: `members[${index}]`,
        message: `squad "${squadFile.resourceId}" member "${label}" uses undefined variables: ${[...missing].sort().join(", ")}. Set them in membersOverrides.variableValues or this member's assistantOverrides.variableValues.`,
      });
    }
  }
  return findings;
}
