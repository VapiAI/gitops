import assert from "node:assert/strict";
import test from "node:test";

// validate.ts now imports from config.ts (matchesIgnore) for the
// reference-to-ignored validator; config.ts asserts argv[2] / VAPI_TOKEN at
// module load. Set both before importing — same trick used in
// tests/path-matching.test.ts and tests/vapi-ignore-push.test.ts.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { validateResources } = await import("../src/validate.ts");

import type { LoadedResources, ResourceFile } from "../src/types.ts";

// Stack D — validator regression coverage. Each spec exercises one rule
// against a minimal in-memory fixture so the validator's signal/noise can
// be pinned without filesystem fixtures.

function emptyResources(): LoadedResources {
  return {
    tools: [],
    structuredOutputs: [],
    assistants: [],
    squads: [],
    personalities: [],
    scenarios: [],
    simulations: [],
    simulationSuites: [],
    evals: [],
  };
}

function makeAssistant(
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile<Record<string, unknown>> {
  return { resourceId, filePath: `/fake/${resourceId}.md`, data };
}

function makeTool(
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile<Record<string, unknown>> {
  return { resourceId, filePath: `/fake/${resourceId}.yml`, data };
}

function makeSO(
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile<Record<string, unknown>> {
  return { resourceId, filePath: `/fake/${resourceId}.yml`, data };
}

function makeScenario(
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile<Record<string, unknown>> {
  return { resourceId, filePath: `/fake/${resourceId}.yml`, data };
}

function makeSquad(
  resourceId: string,
  data: Record<string, unknown>,
): ResourceFile<Record<string, unknown>> {
  return { resourceId, filePath: `/fake/${resourceId}.yml`, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: name-length (assistant + scenario evaluations[].structuredOutput.name)
// ─────────────────────────────────────────────────────────────────────────────

test("name-length: assistant name longer than 40 chars is flagged as error", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("ok-name", { name: "OK Name" }),
    makeAssistant("too-long", {
      name: "this-name-is-definitely-more-than-forty-characters-long",
    }),
  );

  const findings = validateResources(r).filter((f) => f.rule === "name-length");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "error");
  assert.equal(findings[0]!.resourceId, "too-long");
  assert.equal(findings[0]!.fieldPath, "name");
});

test("name-length: scenario evaluations[].structuredOutput.name >40 chars flagged", () => {
  const r = emptyResources();
  r.scenarios.push(
    makeScenario("scenario-1", {
      evaluations: [
        { structuredOutput: { name: "ok_short" } },
        {
          structuredOutput: {
            name: "assistant_attempted_live_conversation_after_voicemail",
          },
        },
      ],
    }),
  );

  const findings = validateResources(r).filter((f) => f.rule === "name-length");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fieldPath, "evaluations[1].structuredOutput.name");
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: SO ↔ assistant lockstep
// ─────────────────────────────────────────────────────────────────────────────

test("so-assistant-lockstep: SO declares assistant but assistant doesn't list SO", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("agent-a", {
      artifactPlan: { structuredOutputIds: [] },
    }),
  );
  r.structuredOutputs.push(
    makeSO("customer-data", { assistant_ids: ["agent-a"] }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "so-assistant-lockstep",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "warn");
  assert.equal(findings[0]!.type, "structuredOutputs");
});

test("so-assistant-lockstep: assistant declares SO but SO doesn't list assistant", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("agent-a", {
      artifactPlan: { structuredOutputIds: ["customer-data"] },
    }),
  );
  r.structuredOutputs.push(makeSO("customer-data", { assistant_ids: [] }));

  const findings = validateResources(r).filter(
    (f) => f.rule === "so-assistant-lockstep",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.type, "assistants");
});

test("so-assistant-lockstep: bidirectional declaration produces no findings", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("agent-a", {
      artifactPlan: { structuredOutputIds: ["customer-data"] },
    }),
  );
  r.structuredOutputs.push(
    makeSO("customer-data", { assistant_ids: ["agent-a"] }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "so-assistant-lockstep",
  );
  assert.equal(findings.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: prompt-duplicate-h1 / prompt-duplicate-block
// ─────────────────────────────────────────────────────────────────────────────

test("prompt-duplicate-h1: same H1 appearing twice flagged", () => {
  const r = emptyResources();
  const promptWithDup = `# Identity

You are foo.

# Identity

You are foo again.`;
  r.assistants.push(
    makeAssistant("dup-h1", {
      model: { messages: [{ role: "system", content: promptWithDup }] },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "prompt-duplicate-h1",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "warn");
});

test("prompt-duplicate-block: CONTINUITY ON ENTRY appearing twice flagged", () => {
  const r = emptyResources();
  const promptWithDup = `# Identity

CONTINUITY ON ENTRY: do X.

CONTINUITY ON ENTRY: do Y.`;
  r.assistants.push(
    makeAssistant("dup-block", {
      model: { messages: [{ role: "system", content: promptWithDup }] },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "prompt-duplicate-block",
  );
  assert.equal(findings.length, 1);
});

test("prompt-duplicate: clean prompt produces no findings", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("clean", {
      model: {
        messages: [{ role: "system", content: "# Identity\n\nYou are foo." }],
      },
    }),
  );

  const findings = validateResources(r).filter(
    (f) =>
      f.rule === "prompt-duplicate-h1" || f.rule === "prompt-duplicate-block",
  );
  assert.equal(findings.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: max-tokens-floor
// ─────────────────────────────────────────────────────────────────────────────

test("max-tokens-floor: assistant with maxTokens=1 and tool warns", () => {
  const r = emptyResources();
  r.tools.push(
    makeTool("end-call", {
      function: {
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "why ending" },
          },
          required: ["reason"],
        },
      },
    }),
  );
  r.assistants.push(
    makeAssistant("classifier", {
      model: { toolIds: ["end-call"], maxTokens: 1 },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "max-tokens-floor",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "warn");
});

test("max-tokens-floor: assistant with high maxTokens silent", () => {
  const r = emptyResources();
  r.tools.push(
    makeTool("end-call", {
      function: { parameters: { type: "object", properties: {} } },
    }),
  );
  r.assistants.push(
    makeAssistant("normal", {
      model: { toolIds: ["end-call"], maxTokens: 1000 },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "max-tokens-floor",
  );
  assert.equal(findings.length, 0);
});

test("max-tokens-floor: assistant without tools is silent", () => {
  const r = emptyResources();
  r.assistants.push(makeAssistant("toolless", { model: { maxTokens: 1 } }));

  const findings = validateResources(r).filter(
    (f) => f.rule === "max-tokens-floor",
  );
  assert.equal(findings.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: voice-provider-schema
// ─────────────────────────────────────────────────────────────────────────────

test("voice-provider-schema: cartesia rejects voice.speed at top level", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("cartesia-bad", {
      voice: { provider: "cartesia", speed: 1.0, voiceId: "x" },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "voice-provider-schema",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "error");
  assert.equal(findings[0]!.fieldPath, "voice.speed");
});

test("voice-provider-schema: cartesia rejects enableSsmlParsing", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("cartesia-ssml", {
      voice: { provider: "cartesia", enableSsmlParsing: true, voiceId: "x" },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "voice-provider-schema",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fieldPath, "voice.enableSsmlParsing");
});

test("voice-provider-schema: cartesia accepts generationConfig.speed", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("cartesia-good", {
      voice: {
        provider: "cartesia",
        voiceId: "x",
        generationConfig: { speed: 1.1 },
      },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "voice-provider-schema",
  );
  assert.equal(findings.length, 0);
});

test("voice-provider-schema: 11labs rejects generationConfig", () => {
  const r = emptyResources();
  r.assistants.push(
    makeAssistant("eleven-bad", {
      voice: {
        provider: "11labs",
        voiceId: "x",
        generationConfig: { speed: 1.0 },
      },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "voice-provider-schema",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fieldPath, "voice.generationConfig");
});

test("voice-provider-schema: cartesia membersOverrides.voice in squad checked", () => {
  const r = emptyResources();
  r.squads.push(
    makeSquad("squad-bad", {
      membersOverrides: { voice: { provider: "cartesia", speed: 1.0 } },
    }),
  );

  const findings = validateResources(r).filter(
    (f) => f.rule === "voice-provider-schema",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fieldPath, "membersOverrides.voice.speed");
});
