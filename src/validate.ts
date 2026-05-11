// ─────────────────────────────────────────────────────────────────────────────
// Client-side validators — fail-fast schema / lockstep / shape checks
//
// Designed to catch the classes of errors that would otherwise only surface
// when the Vapi API returns a 400 mid-push. The push pipeline runs these in
// warning-only mode by default; `--strict` promotes warnings to blocking
// errors that abort before any API call.
//
// Sources for each check are documented in `improvements.md`:
//   - Name length cap (40 chars)              → improvements #18
//   - SO ↔ assistant lockstep                  → improvements #11
//   - Prompt duplication heuristics            → improvements #8, #20
//   - maxTokens floor for tool-using assistants → improvements #19
//   - Per-provider voice schema                → improvements #9
// ─────────────────────────────────────────────────────────────────────────────

import type { LoadedResources, ResourceFile, ResourceType } from "./types.ts";

export type ValidationSeverity = "warn" | "error";

export interface ValidationFinding {
  severity: ValidationSeverity;
  type: ResourceType;
  resourceId: string;
  rule: string;
  message: string;
  fieldPath?: string;
}

const NAME_MAX_LEN = 40;

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Name length cap (40 chars)
// ─────────────────────────────────────────────────────────────────────────────

function checkNameLengths(resources: LoadedResources): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const assistant of resources.assistants) {
    const name = (assistant.data as { name?: unknown }).name;
    if (typeof name === "string" && name.length > NAME_MAX_LEN) {
      findings.push({
        severity: "error",
        type: "assistants",
        resourceId: assistant.resourceId,
        rule: "name-length",
        message: `assistant name "${name}" is ${name.length} chars; Vapi caps at ${NAME_MAX_LEN}`,
        fieldPath: "name",
      });
    }
  }

  for (const scenario of resources.scenarios) {
    const evals = (scenario.data as { evaluations?: unknown }).evaluations;
    if (!Array.isArray(evals)) continue;
    evals.forEach((evalEntry, idx) => {
      const so = (evalEntry as { structuredOutput?: unknown }).structuredOutput;
      if (!so || typeof so !== "object") return;
      const soName = (so as { name?: unknown }).name;
      if (typeof soName === "string" && soName.length > NAME_MAX_LEN) {
        findings.push({
          severity: "error",
          type: "scenarios",
          resourceId: scenario.resourceId,
          rule: "name-length",
          message: `evaluations[${idx}].structuredOutput.name "${soName}" is ${soName.length} chars; Vapi caps at ${NAME_MAX_LEN}`,
          fieldPath: `evaluations[${idx}].structuredOutput.name`,
        });
      }
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: SO ↔ assistant bidirectional lockstep
//
// Each edge is declared on both sides:
//   structured-output.assistant_ids[] = [assistantA, assistantB]
//   assistantA.artifactPlan.structuredOutputIds[] = [SO]
//
// A one-sided declaration is a silent inconsistency.
// ─────────────────────────────────────────────────────────────────────────────

function getAssistantStructuredOutputIds(assistant: ResourceFile): string[] {
  const ap = (assistant.data as { artifactPlan?: unknown }).artifactPlan;
  if (!ap || typeof ap !== "object") return [];
  const ids = (ap as { structuredOutputIds?: unknown }).structuredOutputIds;
  return Array.isArray(ids)
    ? ids.filter((s): s is string => typeof s === "string")
    : [];
}

function getStructuredOutputAssistantIds(so: ResourceFile): string[] {
  const ids = (so.data as { assistant_ids?: unknown }).assistant_ids;
  return Array.isArray(ids)
    ? ids.filter((s): s is string => typeof s === "string")
    : [];
}

function checkLockstep(resources: LoadedResources): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  const assistantById = new Map(
    resources.assistants.map((a) => [a.resourceId, a]),
  );
  const soById = new Map(
    resources.structuredOutputs.map((s) => [s.resourceId, s]),
  );

  // Forward: SO declares assistantA — assistantA must list SO.
  for (const so of resources.structuredOutputs) {
    const assistantIds = getStructuredOutputAssistantIds(so);
    for (const aid of assistantIds) {
      const assistant = assistantById.get(aid);
      if (!assistant) continue; // missing-reference is a different class
      const assistantSOs = getAssistantStructuredOutputIds(assistant);
      if (!assistantSOs.includes(so.resourceId)) {
        findings.push({
          severity: "warn",
          type: "structuredOutputs",
          resourceId: so.resourceId,
          rule: "so-assistant-lockstep",
          message:
            `structured output "${so.resourceId}" lists assistant "${aid}" in assistant_ids ` +
            `but assistant "${aid}" does NOT list this SO in artifactPlan.structuredOutputIds`,
          fieldPath: "assistant_ids",
        });
      }
    }
  }

  // Reverse: assistant declares SO — SO must list assistant.
  for (const assistant of resources.assistants) {
    const soIds = getAssistantStructuredOutputIds(assistant);
    for (const sid of soIds) {
      const so = soById.get(sid);
      if (!so) continue;
      const soAssistants = getStructuredOutputAssistantIds(so);
      if (!soAssistants.includes(assistant.resourceId)) {
        findings.push({
          severity: "warn",
          type: "assistants",
          resourceId: assistant.resourceId,
          rule: "so-assistant-lockstep",
          message:
            `assistant "${assistant.resourceId}" lists SO "${sid}" in artifactPlan.structuredOutputIds ` +
            `but SO "${sid}" does NOT list this assistant in assistant_ids`,
          fieldPath: "artifactPlan.structuredOutputIds",
        });
      }
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: Prompt duplication heuristics
//
// Catches the dashboard "paste-on-top" footgun (improvements #8) and the
// "tool-arg name leaks into TTS" risk (improvements #20).
// ─────────────────────────────────────────────────────────────────────────────

function getSystemPrompt(assistant: ResourceFile): string | null {
  const model = (assistant.data as { model?: unknown }).model;
  if (!model || typeof model !== "object") return null;
  const messages = (model as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const sys = messages.find(
    (m): m is { role: string; content: string } =>
      typeof m === "object" &&
      m !== null &&
      (m as { role?: unknown }).role === "system" &&
      typeof (m as { content?: unknown }).content === "string",
  );
  return sys?.content ?? null;
}

const RISKY_HEADINGS = ["CONTINUITY ON ENTRY", "CLOSEOUT FLOW STRUCTURE"];

function checkPromptDuplications(
  resources: LoadedResources,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const assistant of resources.assistants) {
    const prompt = getSystemPrompt(assistant);
    if (!prompt) continue;

    // Same H1 heading appearing twice
    const h1Matches = prompt.match(/^# .+$/gm) ?? [];
    const seenH1 = new Set<string>();
    for (const h1 of h1Matches) {
      if (seenH1.has(h1)) {
        findings.push({
          severity: "warn",
          type: "assistants",
          resourceId: assistant.resourceId,
          rule: "prompt-duplicate-h1",
          message:
            `system prompt contains duplicate H1 heading "${h1.trim()}" — ` +
            `likely a paste-on-top duplication from the dashboard prompt editor`,
        });
        break; // one warning per assistant is enough
      }
      seenH1.add(h1);
    }

    // Risky keywords appearing more than once
    for (const heading of RISKY_HEADINGS) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      const occurrences = prompt.match(re)?.length ?? 0;
      if (occurrences > 1) {
        findings.push({
          severity: "warn",
          type: "assistants",
          resourceId: assistant.resourceId,
          rule: "prompt-duplicate-block",
          message:
            `system prompt has ${occurrences} occurrences of "${heading}" — ` +
            `block likely duplicated`,
        });
      }
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: maxTokens floor for tool-using assistants
//
// `maxTokens` < length of (tool argument schema JSON) means the model can't
// emit a complete tool call payload — push succeeds, the assistant bricks at
// runtime. Compute a soft floor and warn under it.
// ─────────────────────────────────────────────────────────────────────────────

function getAssistantMaxTokens(assistant: ResourceFile): number | undefined {
  const model = (assistant.data as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  const mt = (model as { maxTokens?: unknown }).maxTokens;
  return typeof mt === "number" ? mt : undefined;
}

function getAssistantToolIds(assistant: ResourceFile): string[] {
  const model = (assistant.data as { model?: unknown }).model;
  if (!model || typeof model !== "object") return [];
  const ids = (model as { toolIds?: unknown }).toolIds;
  return Array.isArray(ids)
    ? ids.filter((s): s is string => typeof s === "string")
    : [];
}

function getToolParametersSize(tool: ResourceFile): number {
  const fn = (tool.data as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") return 0;
  const params = (fn as { parameters?: unknown }).parameters;
  if (params === undefined) return 0;
  try {
    return JSON.stringify(params).length;
  } catch {
    return 0;
  }
}

function checkMaxTokensFloor(resources: LoadedResources): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const toolById = new Map(resources.tools.map((t) => [t.resourceId, t]));

  for (const assistant of resources.assistants) {
    const maxTokens = getAssistantMaxTokens(assistant);
    if (maxTokens === undefined) continue;

    const toolIds = getAssistantToolIds(assistant);
    if (toolIds.length === 0) continue;

    let argsBudget = 0;
    for (const tid of toolIds) {
      const tool = toolById.get(tid);
      if (tool) argsBudget += getToolParametersSize(tool);
    }
    if (argsBudget === 0) continue;

    const floor = 25 + argsBudget;
    if (maxTokens < floor) {
      findings.push({
        severity: "warn",
        type: "assistants",
        resourceId: assistant.resourceId,
        rule: "max-tokens-floor",
        message:
          `model.maxTokens=${maxTokens} may truncate tool-call args; ` +
          `recommended floor for attached tools is ${floor} ` +
          `(25 + sum of tool parameter schema sizes)`,
        fieldPath: "model.maxTokens",
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 5: Per-provider voice schema
//
// See docs/learnings/voice-providers.md for the full layout.
// ─────────────────────────────────────────────────────────────────────────────

const CARTESIA_FORBIDDEN_TOP_LEVEL = new Set([
  "speed",
  "stability",
  "similarityBoost",
  "enableSsmlParsing",
]);
const ELEVENLABS_FORBIDDEN_TOP_LEVEL = new Set(["generationConfig"]);

function checkVoiceBlock(
  type: ResourceType,
  resourceId: string,
  voice: unknown,
  fieldPath: string,
): ValidationFinding[] {
  if (!voice || typeof voice !== "object") return [];
  const findings: ValidationFinding[] = [];
  const v = voice as Record<string, unknown>;
  const provider = v.provider;

  if (provider === "cartesia") {
    for (const key of Object.keys(v)) {
      if (CARTESIA_FORBIDDEN_TOP_LEVEL.has(key)) {
        findings.push({
          severity: "error",
          type,
          resourceId,
          rule: "voice-provider-schema",
          message:
            `Cartesia voice rejects top-level "${key}" — ` +
            (key === "speed"
              ? "use voice.generationConfig.speed (0.6–1.5) instead"
              : key === "enableSsmlParsing"
                ? "Cartesia parses SSML natively; remove the field"
                : `field is 11labs-only; remove for Cartesia`),
          fieldPath: `${fieldPath}.${key}`,
        });
      }
    }
  } else if (provider === "11labs") {
    for (const key of Object.keys(v)) {
      if (ELEVENLABS_FORBIDDEN_TOP_LEVEL.has(key)) {
        findings.push({
          severity: "error",
          type,
          resourceId,
          rule: "voice-provider-schema",
          message:
            `11labs voice rejects "${key}" — that's a Cartesia path. ` +
            `Move speed to top-level voice.speed (0.7–1.2)`,
          fieldPath: `${fieldPath}.${key}`,
        });
      }
    }
  }

  return findings;
}

function checkVoiceSchemas(resources: LoadedResources): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const assistant of resources.assistants) {
    findings.push(
      ...checkVoiceBlock(
        "assistants",
        assistant.resourceId,
        (assistant.data as { voice?: unknown }).voice,
        "voice",
      ),
    );
  }

  for (const squad of resources.squads) {
    const overrides = (squad.data as { membersOverrides?: unknown })
      .membersOverrides;
    if (overrides && typeof overrides === "object") {
      findings.push(
        ...checkVoiceBlock(
          "squads",
          squad.resourceId,
          (overrides as { voice?: unknown }).voice,
          "membersOverrides.voice",
        ),
      );
    }

    const members = (squad.data as { members?: unknown }).members;
    if (Array.isArray(members)) {
      members.forEach((m, idx) => {
        if (!m || typeof m !== "object") return;
        const mo = (m as { assistantOverrides?: unknown }).assistantOverrides;
        if (!mo || typeof mo !== "object") return;
        findings.push(
          ...checkVoiceBlock(
            "squads",
            squad.resourceId,
            (mo as { voice?: unknown }).voice,
            `members[${idx}].assistantOverrides.voice`,
          ),
        );
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: run all checks
// ─────────────────────────────────────────────────────────────────────────────

export function validateResources(
  resources: LoadedResources,
): ValidationFinding[] {
  return [
    ...checkNameLengths(resources),
    ...checkLockstep(resources),
    ...checkPromptDuplications(resources),
    ...checkMaxTokensFloor(resources),
    ...checkVoiceSchemas(resources),
  ];
}

// Format a single finding as a human-friendly line for the CLI output.
export function formatFinding(f: ValidationFinding): string {
  const icon = f.severity === "error" ? "❌" : "⚠️ ";
  const where = f.fieldPath
    ? `${f.type}/${f.resourceId} (${f.fieldPath})`
    : `${f.type}/${f.resourceId}`;
  return `  ${icon} [${f.rule}] ${where}: ${f.message}`;
}

// Group findings into a summary block. Returns the formatted text.
export function summarizeFindings(findings: ValidationFinding[]): string {
  if (findings.length === 0) return "✅ No validation issues.";
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  const lines: string[] = [];
  lines.push(
    `📋 Validation: ${errors.length} error(s), ${warns.length} warning(s)`,
  );
  for (const f of findings) lines.push(formatFinding(f));
  return lines.join("\n");
}
