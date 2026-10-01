// Inline an assistant from its file the way the runtime would assemble the
// stored one, so the check tests what push deploys:
//   - tools in runtime order: existing model.tools, then toolIds in order,
//     then toolRefs (callAssistantsGet appends toolIds tools after
//     model.tools — order changes which tool the model reaches for);
//   - knowledgeBase tools stay in toolIds by UUID (the API won't take them
//     inline);
//   - hook `do[].toolId` → `do[].tool`;
//   - artifactPlan.structuredOutputIds, plus structured outputs that link
//     the assistant from their own `assistant_ids`, → structuredOutputs;
//   - handoffs to squad members by ID → by member name.

import type {
  CheckPayloadContext,
  SquadMembers,
} from "./check-payload-refs.ts";
import {
  clone,
  isObject,
  linkedFieldsStrip,
  missingRef,
  refClean,
  refResolve,
  serverFieldsStrip,
  sourceUuid,
} from "./check-payload-refs.ts";

export interface AssistantInlineArgs {
  data: Record<string, unknown>;
  label: string;
  squad?: SquadMembers;
  // The assistant's own slug and UUID, for structured outputs that link it
  // through their `assistant_ids`. Empty for transient assistants.
  selfRefs?: string[];
}

function toolPrepare(data: Record<string, unknown>): Record<string, unknown> {
  return linkedFieldsStrip(data);
}

function toolKey(tool: Record<string, unknown>): string | undefined {
  const fn = isObject(tool.function) ? tool.function : undefined;
  const name = typeof fn?.name === "string" ? fn.name : tool.name;
  return typeof name === "string" ? `${String(tool.type)} ${name}` : undefined;
}

function toolsDuplicateCheck(
  ctx: CheckPayloadContext,
  tools: Record<string, unknown>[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    const key = toolKey(tool);
    if (!key) continue;
    if (seen.has(key))
      ctx.errors.push(
        `${label}: two tools named "${key.split(" ").slice(1).join(" ")}" (type ${String(tool.type)}); stored, both are kept, but inline the second is dropped — rename one`,
      );
    seen.add(key);
  }
}

// A toolIds / toolRefs entry: inlined, or kept as a run-org UUID for
// knowledge-base tools.
function toolRefInline(
  ctx: CheckPayloadContext,
  ref: string,
  label: string,
  inline: Record<string, unknown>[],
  keepIds: string[],
): void {
  const resolved = refResolve(ctx, "tools", ref);
  if (!resolved.resource) {
    missingRef(ctx, label, "tools", ref);
    return;
  }
  if (resolved.resource.data.type === "knowledgeBase") {
    const uuid = ctx.runState.tools[resolved.slug]?.uuid;
    if (!uuid)
      ctx.errors.push(
        `${label}: knowledgeBase tool "${resolved.slug}" can't be sent inline and has no UUID in the run org's state`,
      );
    else keepIds.push(uuid);
    return;
  }
  inline.push(toolPrepare(resolved.resource.data));
}

function modelToolsInline(
  ctx: CheckPayloadContext,
  model: Record<string, unknown>,
  label: string,
): void {
  const inline: Record<string, unknown>[] = Array.isArray(model.tools)
    ? model.tools.map((tool) =>
        isObject(tool) ? toolPrepare(tool) : (tool as Record<string, unknown>),
      )
    : [];
  const keepIds: string[] = [];
  const toolRefs = Array.isArray(model.toolRefs) ? model.toolRefs : [];
  // The toolRefs pin wins over a toolIds entry for the same tool.
  const pinned = new Set(
    toolRefs
      .filter(isObject)
      .map((ref) =>
        typeof ref.toolId === "string"
          ? refResolve(ctx, "tools", ref.toolId).slug
          : "",
      ),
  );
  (Array.isArray(model.toolIds) ? model.toolIds : []).forEach((ref, index) => {
    if (typeof ref !== "string") {
      ctx.errors.push(`${label}.model.toolIds[${index}] must be a string`);
      return;
    }
    if (pinned.has(refResolve(ctx, "tools", ref).slug)) return;
    toolRefInline(
      ctx,
      ref,
      `${label}.model.toolIds[${index}]`,
      inline,
      keepIds,
    );
  });
  toolRefs.forEach((ref, index) => {
    const at = `${label}.model.toolRefs[${index}]`;
    if (!isObject(ref) || typeof ref.toolId !== "string") {
      ctx.errors.push(`${at} must have a toolId`);
      return;
    }
    ctx.warnings.push(
      `${at}: "${refClean(ref.toolId)}" is inlined from its file; the version pin is ignored`,
    );
    toolRefInline(ctx, ref.toolId, at, inline, keepIds);
  });
  delete model.toolRefs;
  if (inline.length > 0) model.tools = inline;
  else delete model.tools;
  if (keepIds.length > 0) model.toolIds = keepIds;
  else delete model.toolIds;
  toolsDuplicateCheck(ctx, inline, `${label}.model.tools`);
}

// Handoff destinations that name an assistant by ID become member names in
// a squad. Anything else that leaves the target is a build error.
export function handoffsResolve(
  ctx: CheckPayloadContext,
  tools: unknown,
  label: string,
  squad?: SquadMembers,
): void {
  if (!Array.isArray(tools)) return;
  tools.forEach((tool, toolIndex) => {
    if (!isObject(tool) || tool.type !== "handoff") return;
    if (!Array.isArray(tool.destinations)) return;
    tool.destinations.forEach((destination, index) => {
      const at = `${label}[${toolIndex}].destinations[${index}]`;
      if (!isObject(destination)) return;
      if (isObject(destination.assistant))
        destination.assistant = assistantInline(ctx, {
          data: destination.assistant,
          label: `${at}.assistant`,
          squad,
        });
      if (isObject(destination.assistantOverrides))
        overridesProcess(
          ctx,
          destination.assistantOverrides,
          `${at}.assistantOverrides`,
          squad,
        );
      if (typeof destination.assistantId !== "string") return;
      const resolved = refResolve(ctx, "assistants", destination.assistantId);
      const name =
        squad?.get(resolved.slug) ??
        squad?.get(refClean(destination.assistantId));
      if (name !== undefined) {
        destination.assistantName = name;
        delete destination.assistantId;
        return;
      }
      ctx.errors.push(
        squad
          ? `${at}: hands off to "${resolved.slug}", which isn't a member of the squad; add it as a member`
          : `${at}: an assistant target can't hand off to "${resolved.slug}"; make the target a squad of those assistants`,
      );
    });
  });
}

function hooksInline(
  ctx: CheckPayloadContext,
  hooks: unknown,
  label: string,
): void {
  if (!Array.isArray(hooks)) return;
  hooks.forEach((hook, hookIndex) => {
    if (!isObject(hook) || !Array.isArray(hook.do)) return;
    hook.do.forEach((action, index) => {
      if (!isObject(action) || typeof action.toolId !== "string") return;
      const at = `${label}[${hookIndex}].do[${index}].toolId`;
      const resolved = refResolve(ctx, "tools", action.toolId);
      if (!resolved.resource) {
        missingRef(ctx, at, "tools", action.toolId);
        return;
      }
      action.tool = toolPrepare(resolved.resource.data);
      delete action.toolId;
    });
  });
}

function structuredOutputsInline(
  ctx: CheckPayloadContext,
  assistant: Record<string, unknown>,
  label: string,
  selfRefs: string[],
): void {
  const plan = isObject(assistant.artifactPlan) ? assistant.artifactPlan : {};
  const inline: Record<string, unknown>[] = Array.isArray(
    plan.structuredOutputs,
  )
    ? [...plan.structuredOutputs]
    : [];
  const added = new Set<string>();
  const add = (slug: string, data: Record<string, unknown>) => {
    if (added.has(slug)) return;
    added.add(slug);
    inline.push(linkedFieldsStrip(data));
  };
  (Array.isArray(plan.structuredOutputIds)
    ? plan.structuredOutputIds
    : []
  ).forEach((ref, index) => {
    if (typeof ref !== "string") return;
    const resolved = refResolve(ctx, "structuredOutputs", ref);
    if (!resolved.resource)
      missingRef(
        ctx,
        `${label}.artifactPlan.structuredOutputIds[${index}]`,
        "structuredOutputs",
        ref,
      );
    else add(resolved.slug, resolved.resource.data);
  });
  if (selfRefs.length > 0) {
    for (const resource of ctx.resources.values()) {
      if (resource.type !== "structuredOutputs") continue;
      const links = resource.data.assistant_ids ?? resource.data.assistantIds;
      if (!Array.isArray(links)) continue;
      const linked = links.some(
        (link) => typeof link === "string" && selfRefs.includes(refClean(link)),
      );
      if (linked) add(resource.id, resource.data);
    }
  }
  if (inline.length === 0 && plan.structuredOutputIds === undefined) return;
  delete plan.structuredOutputIds;
  if (inline.length > 0) plan.structuredOutputs = inline;
  assistant.artifactPlan = plan;
}

// assistantOverrides, membersOverrides and scenario targetOverrides. The
// runtime merges override tools differently (it ignores
// membersOverrides.model.toolIds and rejects toolRefs in overrides), so under
// strict mocks their tools must already be inline.
export function overridesProcess(
  ctx: CheckPayloadContext,
  overrides: Record<string, unknown>,
  label: string,
  squad?: SquadMembers,
): void {
  const model = isObject(overrides.model) ? overrides.model : undefined;
  if (ctx.strict) {
    for (const key of ["toolIds", "toolRefs"]) {
      if (model?.[key] !== undefined)
        ctx.errors.push(
          `${label}.model.${key}: tools inside overrides must be inline (model.tools or tools:append)`,
        );
    }
    if (Array.isArray(overrides.hooks)) {
      overrides.hooks.forEach((hook, hookIndex) => {
        if (!isObject(hook) || !Array.isArray(hook.do)) return;
        hook.do.forEach((action, index) => {
          if (isObject(action) && action.toolId !== undefined)
            ctx.errors.push(
              `${label}.hooks[${hookIndex}].do[${index}].toolId: tools inside overrides must be inline`,
            );
        });
      });
    }
  }
  handoffsResolve(ctx, model?.tools, `${label}.model.tools`, squad);
  handoffsResolve(
    ctx,
    overrides["tools:append"],
    `${label}.tools:append`,
    squad,
  );
}

export function assistantInline(
  ctx: CheckPayloadContext,
  args: AssistantInlineArgs,
): Record<string, unknown> {
  const assistant = serverFieldsStrip(clone(args.data));
  const { label, squad } = args;
  if (isObject(assistant.model)) {
    modelToolsInline(ctx, assistant.model, label);
    handoffsResolve(ctx, assistant.model.tools, `${label}.model.tools`, squad);
  }
  hooksInline(ctx, assistant.hooks, `${label}.hooks`);
  structuredOutputsInline(ctx, assistant, label, args.selfRefs ?? []);
  return assistant;
}

// The slug and source UUID an assistant file is known by.
export function assistantSelfRefs(
  ctx: CheckPayloadContext,
  slug: string,
): string[] {
  const uuid = sourceUuid(ctx, "assistants", slug);
  return uuid ? [slug, uuid] : [slug];
}
