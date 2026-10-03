// Build the inline `POST /eval/simulation/run` body for one check target
// from the PR branch's files: the target assistant or squad with its tools,
// handoffs and structured outputs, plus every scenario, judge and
// personality the check's suites and simulations name. Nothing is looked up
// on the platform — what's in the files is what runs.
//
// Pure: inputs come from orgResourcesRead and promotionStateParse. Every
// problem is collected, so one dry run reports them all.

import type { CheckDefinition, CheckTarget } from "./check-config.ts";
import {
  assistantInline,
  assistantSelfRefs,
  overridesProcess,
} from "./check-payload-assistant.ts";
import type {
  CheckPayloadContext,
  SquadMembers,
} from "./check-payload-refs.ts";
import {
  clone,
  isObject,
  isUuid,
  linkedFieldsStrip,
  missingRef,
  refClean,
  refResolve,
  serverFieldsStrip,
} from "./check-payload-refs.ts";
import { credentialForwardMap, replaceCredentialRefs } from "./credentials.ts";
import type { PromotionBindingsResolved } from "./promotion.ts";
import { promotionBindingsApply } from "./promotion.ts";
import type { OrgResource } from "./resource-parse.ts";
import type { StateFile } from "./types.ts";

export interface CheckPayloadInput {
  check: CheckDefinition;
  target: CheckTarget;
  resources: Map<string, OrgResource>;
  sourceState: StateFile;
  runState: StateFile;
  // Phone-number bindings between the org and the run org (from
  // promotionBindingsResolve). Credentials resolve through the states.
  bindingsResolved?: PromotionBindingsResolved;
}

export interface CheckSimulationEntry {
  type: "simulation";
  name: string;
  scenario: Record<string, unknown>;
  personality?: Record<string, unknown>;
  personalityId?: string;
}

export interface CheckRunBody {
  simulations: CheckSimulationEntry[];
  target:
    | { type: "assistant"; assistant: Record<string, unknown> }
    | { type: "squad"; squad: Record<string, unknown> };
  transport: { provider: "vapi.webchat" | "vapi.websocket" };
  iterations: number;
}

export interface CheckPayloadResult {
  body?: CheckRunBody;
  errors: string[];
  warnings: string[];
  bytes: number;
}

export const MAX_PAYLOAD_BYTES = 4.5 * 1024 * 1024;
const MAX_ENTRY_NAME = 80;
const STOCK_PERSONALITY_RE = /^a0000000-0000-4000-8000-00000000000\d$/;
const AUDIO_TARGET = "messages-with-audio";

// Keys whose string values must be platform UUIDs once the body is built.
// A slug left in one of these means a reference the builder couldn't place;
// resolveReferences would silently drop it (improvements.md #31), so the
// check refuses instead.
const REFERENCE_KEYS = new Set([
  "toolId",
  "toolIds",
  "structuredOutputId",
  "structuredOutputIds",
  "assistantId",
  "assistantIds",
  "squadId",
  "personalityId",
  "scenarioId",
  "simulationId",
  "simulationIds",
  "credentialId",
  "credentialIds",
  "phoneNumberId",
]);

// Free-form data: a function parameter called `toolId` isn't a reference.
const FREE_FORM_KEYS = new Set([
  "parameters",
  "schema",
  "metadata",
  "variableValues",
]);

function squadInline(
  ctx: CheckPayloadContext,
  squadFile: OrgResource,
): Record<string, unknown> | undefined {
  const squad = serverFieldsStrip(squadFile.data);
  const label = `squads/${squadFile.id}`;
  if (!Array.isArray(squad.members) || squad.members.length === 0) {
    ctx.errors.push(`${label}: a squad target needs at least one member`);
    return undefined;
  }
  // First pass: every member's name, so handoffs by ID can become names.
  const members: SquadMembers = new Map();
  const memberFiles: Array<OrgResource | undefined> = [];
  const names = new Set<string>();
  squad.members.forEach((member, index) => {
    const at = `${label}.members[${index}]`;
    let file: OrgResource | undefined;
    let data: Record<string, unknown> | undefined;
    if (isObject(member) && typeof member.assistantId === "string") {
      const resolved = refResolve(ctx, "assistants", member.assistantId);
      if (!resolved.resource)
        missingRef(ctx, `${at}.assistantId`, "assistants", member.assistantId);
      file = resolved.resource;
      data = file?.data;
    } else if (isObject(member) && isObject(member.assistant)) {
      data = member.assistant;
    }
    memberFiles.push(file);
    if (!data) {
      if (!isObject(member) || member.assistantId === undefined)
        ctx.errors.push(`${at}: needs an assistantId or an inline assistant`);
      return;
    }
    const name = data.name;
    if (typeof name !== "string" || name.trim() === "") {
      ctx.errors.push(
        `${at}: the member assistant needs a name (handoffs inside a squad target it by name)`,
      );
      return;
    }
    if (names.has(name))
      ctx.errors.push(
        `${at}: two members are named "${name}"; member names must be unique`,
      );
    names.add(name);
    if (file)
      for (const ref of assistantSelfRefs(ctx, file.id)) members.set(ref, name);
  });
  // Second pass: inline each member.
  squad.members = squad.members.map((member, index) => {
    if (!isObject(member)) return member;
    const at = `${label}.members[${index}]`;
    const file = memberFiles[index];
    const next: Record<string, unknown> = clone(member);
    const data =
      file?.data ?? (isObject(member.assistant) ? member.assistant : undefined);
    if (data)
      next.assistant = assistantInline(ctx, {
        data,
        label: file ? `assistants/${file.id}` : `${at}.assistant`,
        squad: members,
        selfRefs: file ? assistantSelfRefs(ctx, file.id) : [],
      });
    delete next.assistantId;
    if (next.assistantVersion !== undefined) {
      ctx.warnings.push(
        `${at}: assistantVersion is ignored; the member is built from its file`,
      );
      delete next.assistantVersion;
    }
    if (Array.isArray(next.assistantDestinations)) {
      next.assistantDestinations.forEach((destination, destIndex) => {
        if (isObject(destination) && destination.assistantId !== undefined)
          ctx.errors.push(
            `${at}.assistantDestinations[${destIndex}]: legacy assistantDestinations by ID aren't supported inline; convert it to a handoff tool`,
          );
      });
    }
    if (isObject(next.assistantOverrides))
      overridesProcess(
        ctx,
        next.assistantOverrides,
        `${at}.assistantOverrides`,
        members,
      );
    return next;
  });
  if (isObject(squad.membersOverrides))
    overridesProcess(
      ctx,
      squad.membersOverrides,
      `${label}.membersOverrides`,
      members,
    );
  ctx.targetMembers = members;
  return squad;
}

function targetBuild(
  ctx: CheckPayloadContext,
  target: CheckTarget,
): CheckRunBody["target"] | undefined {
  const file = ctx.resources.get(`${target.type}:${target.id}`);
  if (!file) {
    missingRef(
      ctx,
      `target ${target.type}/${target.id}`,
      target.type,
      target.id,
    );
    return undefined;
  }
  if (target.type === "assistants")
    return {
      type: "assistant",
      assistant: assistantInline(ctx, {
        data: file.data,
        label: `assistants/${file.id}`,
        selfRefs: assistantSelfRefs(ctx, file.id),
      }),
    };
  const squad = squadInline(ctx, file);
  return squad ? { type: "squad", squad } : undefined;
}

function simulationIdsCollect(
  ctx: CheckPayloadContext,
  check: CheckDefinition,
): string[] {
  const ids: string[] = [];
  const push = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const suiteId of check.suites) {
    const suite = ctx.resources.get(`simulationSuites:${suiteId}`);
    if (!suite) {
      missingRef(
        ctx,
        `checks.${check.name}.suites`,
        "simulationSuites",
        suiteId,
      );
      continue;
    }
    const simulationIds = suite.data.simulationIds;
    if (!Array.isArray(simulationIds) || simulationIds.length === 0) {
      ctx.errors.push(`simulations/suites/${suiteId}: lists no simulationIds`);
      continue;
    }
    for (const ref of simulationIds) {
      if (typeof ref !== "string") continue;
      push(refResolve(ctx, "simulations", ref).slug);
    }
  }
  for (const id of check.simulations) push(id);
  return ids;
}

function judgesInline(
  ctx: CheckPayloadContext,
  scenario: Record<string, unknown>,
  label: string,
): void {
  if (!Array.isArray(scenario.evaluations)) return;
  scenario.evaluations.forEach((evaluation, index) => {
    if (
      !isObject(evaluation) ||
      typeof evaluation.structuredOutputId !== "string"
    )
      return;
    const at = `${label}.evaluations[${index}].structuredOutputId`;
    const resolved = refResolve(
      ctx,
      "structuredOutputs",
      evaluation.structuredOutputId,
    );
    if (!resolved.resource) {
      missingRef(ctx, at, "structuredOutputs", evaluation.structuredOutputId);
      return;
    }
    evaluation.structuredOutput = linkedFieldsStrip(resolved.resource.data);
    delete evaluation.structuredOutputId;
  });
}

// Chat transport has no audio and runs no scenario hooks.
function chatRulesCheck(
  ctx: CheckPayloadContext,
  scenario: Record<string, unknown>,
  label: string,
): void {
  const evaluations = Array.isArray(scenario.evaluations)
    ? scenario.evaluations
    : [];
  const isAudio = (evaluation: unknown) =>
    isObject(evaluation) &&
    isObject(evaluation.structuredOutput) &&
    evaluation.structuredOutput.target === AUDIO_TARGET;
  evaluations.forEach((evaluation, index) => {
    if (isAudio(evaluation))
      ctx.errors.push(
        `${label}.evaluations[${index}]: a ${AUDIO_TARGET} judge needs transport: voice`,
      );
  });
  const textRequired = evaluations.some(
    (evaluation) =>
      isObject(evaluation) &&
      evaluation.required !== false &&
      !isAudio(evaluation),
  );
  if (!textRequired)
    ctx.errors.push(
      `${label}: needs at least one required text judge (a scenario with none can't fail)`,
    );
  if (Array.isArray(scenario.hooks) && scenario.hooks.length > 0)
    ctx.errors.push(
      `${label}: scenario hooks don't run over chat; remove them or use transport: voice`,
    );
}

function entryName(name: string, used: Set<string>): string {
  let candidate = name.slice(0, MAX_ENTRY_NAME);
  for (let n = 2; used.has(candidate); n++) {
    const suffix = ` (${n})`;
    candidate = name.slice(0, MAX_ENTRY_NAME - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function personalityBuild(
  ctx: CheckPayloadContext,
  ref: unknown,
  label: string,
): Pick<CheckSimulationEntry, "personality" | "personalityId"> | undefined {
  if (typeof ref !== "string") {
    ctx.errors.push(`${label}: needs a personalityId`);
    return undefined;
  }
  const resolved = refResolve(ctx, "personalities", ref);
  if (resolved.resource) {
    const personality = serverFieldsStrip(resolved.resource.data);
    if (isObject(personality.assistant))
      personality.assistant = assistantInline(ctx, {
        data: personality.assistant,
        label: `simulations/personalities/${resolved.slug}.assistant`,
      });
    return { personality };
  }
  if (STOCK_PERSONALITY_RE.test(refClean(ref)))
    return { personalityId: refClean(ref) };
  missingRef(ctx, label, "personalities", ref);
  return undefined;
}

function entriesBuild(
  ctx: CheckPayloadContext,
  check: CheckDefinition,
): CheckSimulationEntry[] {
  const entries: CheckSimulationEntry[] = [];
  const used = new Set<string>();
  for (const id of simulationIdsCollect(ctx, check)) {
    const label = `simulations/tests/${id}`;
    const simulation = ctx.resources.get(`simulations:${id}`);
    if (!simulation) {
      missingRef(ctx, `checks.${check.name}`, "simulations", id);
      continue;
    }
    const scenarioRef = simulation.data.scenarioId;
    const scenarioFile =
      typeof scenarioRef === "string"
        ? refResolve(ctx, "scenarios", scenarioRef).resource
        : undefined;
    if (!scenarioFile) {
      if (typeof scenarioRef === "string")
        missingRef(ctx, `${label}.scenarioId`, "scenarios", scenarioRef);
      else ctx.errors.push(`${label}: needs a scenarioId`);
      continue;
    }
    const scenarioLabel = `simulations/scenarios/${scenarioFile.id}`;
    const scenario = serverFieldsStrip(scenarioFile.data);
    judgesInline(ctx, scenario, scenarioLabel);
    if (isObject(scenario.targetOverrides))
      overridesProcess(
        ctx,
        scenario.targetOverrides,
        `${scenarioLabel}.targetOverrides`,
        ctx.targetMembers,
      );
    if (check.transport === "chat")
      chatRulesCheck(ctx, scenario, scenarioLabel);
    const personality = personalityBuild(
      ctx,
      simulation.data.personalityId,
      `${label}.personalityId`,
    );
    if (!personality) continue;
    const name =
      typeof simulation.data.name === "string" ? simulation.data.name : id;
    entries.push({
      type: "simulation",
      name: entryName(name, used),
      scenario,
      ...personality,
    });
  }
  if (entries.length === 0 && ctx.errors.length === 0)
    ctx.errors.push(`checks.${check.name}: selects no simulations`);
  return entries;
}

function credentialsBind(
  ctx: CheckPayloadContext,
  input: CheckPayloadInput,
  value: unknown,
): unknown {
  const resolved: PromotionBindingsResolved = input.bindingsResolved ?? {
    credentialReverse: new Map(
      Object.entries(ctx.sourceState.credentials).map(([alias, entry]) => [
        entry.uuid,
        alias,
      ]),
    ),
    sourcePhones: new Map(),
    targetPhones: new Map(),
  };
  try {
    const bound = promotionBindingsApply(
      value,
      input.check.bindings,
      resolved,
      ctx.runState,
    );
    return replaceCredentialRefs(bound, credentialForwardMap(ctx.runState));
  } catch (error) {
    ctx.errors.push(
      `run org ${input.check.runOrg}: ${(error as Error).message}`,
    );
    return value;
  }
}

function leftoverReferencesCheck(
  ctx: CheckPayloadContext,
  value: unknown,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      leftoverReferencesCheck(ctx, item, `${path}[${index}]`),
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FREE_FORM_KEYS.has(key)) continue;
    const at = `${path}.${key}`;
    if (REFERENCE_KEYS.has(key)) {
      const values = Array.isArray(child) ? child : [child];
      for (const item of values) {
        if (typeof item === "string" && !isUuid(item))
          ctx.errors.push(
            `${at}: "${item}" is still a name, not a UUID; it couldn't be resolved for the run org`,
          );
      }
      continue;
    }
    leftoverReferencesCheck(ctx, child, at);
  }
}

function autoHandoffNamesWarn(
  ctx: CheckPayloadContext,
  body: CheckRunBody,
): void {
  const serialized = JSON.stringify(body);
  if (!serialized.includes("handoff_to_")) return;
  let autoNamed = false;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    const fn = isObject(value.function) ? value.function : undefined;
    if (value.type === "handoff" && typeof fn?.name !== "string")
      autoNamed = true;
    Object.values(value).forEach(visit);
  };
  visit(body.target);
  if (autoNamed)
    ctx.warnings.push(
      'text mentions "handoff_to_…", but a handoff tool has no explicit function.name; generated names differ inline (handoff_to_<assistantName>) and stored (handoff_to_<uuid>), so give it an explicit function.name',
    );
}

export function checkPayloadBuild(
  input: CheckPayloadInput,
): CheckPayloadResult {
  const ctx: CheckPayloadContext = {
    org: input.check.org,
    resources: input.resources,
    sourceState: input.sourceState,
    runState: input.runState,
    strict: input.check.toolMocks === "strict",
    errors: [],
    warnings: [],
  };
  const target = targetBuild(ctx, input.target);
  const simulations = entriesBuild(ctx, input.check);
  if (!target) return { errors: ctx.errors, warnings: ctx.warnings, bytes: 0 };
  const body: CheckRunBody = {
    simulations: credentialsBind(
      ctx,
      input,
      simulations,
    ) as CheckSimulationEntry[],
    target: credentialsBind(ctx, input, target) as CheckRunBody["target"],
    transport: {
      provider:
        input.check.transport === "voice" ? "vapi.websocket" : "vapi.webchat",
    },
    iterations: input.check.iterations,
  };
  // A backstop for reference fields the builder doesn't handle; run only
  // when nothing else failed, so a known problem isn't reported twice.
  if (ctx.errors.length === 0) leftoverReferencesCheck(ctx, body, "body");
  autoHandoffNamesWarn(ctx, body);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > MAX_PAYLOAD_BYTES)
    ctx.errors.push(
      `payload is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 4.5 MB`,
    );
  if (ctx.errors.length > 0)
    return { errors: ctx.errors, warnings: ctx.warnings, bytes };
  return { body, errors: [], warnings: ctx.warnings, bytes };
}
