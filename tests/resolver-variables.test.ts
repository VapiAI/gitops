import assert from "node:assert/strict";
import test from "node:test";
import {
  extractReferencedIds,
  resolveReferences,
} from "../src/resolver.ts";
import type { StateFile, Variables } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// resolveReferences wiring: managed variables are substituted at push, and
// compose with the existing reference (resourceId → UUID) resolution.
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeState(variables: Variables): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: { "my-tool": { uuid: TOOL_UUID } },
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
    variables,
  };
}

test("resolveReferences: substitutes a whole-value variable, type-preserving", () => {
  const state = makeState({
    default_model: "gpt-4.1",
    max_tokens: 260,
    callback_url: "https://example.com/vapi/webhook",
  });

  const out = resolveReferences(
    {
      model: { model: "{{default_model}}", maxTokens: "{{max_tokens}}" },
      server: { url: "{{callback_url}}" },
    },
    state,
  ) as any;

  assert.strictEqual(out.model.model, "gpt-4.1");
  assert.strictEqual(out.model.maxTokens, 260); // number preserved
  assert.strictEqual(out.server.url, "https://example.com/vapi/webhook");
});

test("resolveReferences: variable yielding a resourceId composes into UUID resolution", () => {
  const state = makeState({ tool_ref: "my-tool" });

  // model.toolIds references a tool via a variable. Variable substitution runs
  // first (→ "my-tool"), then reference resolution maps it to the UUID.
  const out = resolveReferences(
    { model: { toolIds: ["{{tool_ref}}"] } },
    state,
  ) as any;

  assert.deepEqual(out.model.toolIds, [TOOL_UUID]);
});

test("resolveReferences: literal toolId reference still resolves alongside variables", () => {
  const state = makeState({ greeting: "Hello" });

  const out = resolveReferences(
    {
      firstMessage: "{{greeting}}",
      model: { toolIds: ["my-tool"] },
    },
    state,
  ) as any;

  assert.strictEqual(out.firstMessage, "Hello");
  assert.deepEqual(out.model.toolIds, [TOOL_UUID]);
});

test("resolveReferences: unknown variable is left verbatim (validate/push surfaces it)", () => {
  const state = makeState({});
  const out = resolveReferences({ server: { url: "{{ghost}}" } }, state) as any;
  assert.strictEqual(out.server.url, "{{ghost}}");
});

test("resolveReferences: no variables section behavior is unchanged", () => {
  const state = makeState({});
  const out = resolveReferences(
    { model: { model: "gpt-4.1", toolIds: ["my-tool"] } },
    state,
  ) as any;
  assert.strictEqual(out.model.model, "gpt-4.1");
  assert.deepEqual(out.model.toolIds, [TOOL_UUID]);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractReferencedIds must be variable-aware too, or dependency
// auto-creation / orphan-delete protection / ignored-ref validation would see
// the literal "{{...}}" instead of the real resourceId (review finding #1).
// ─────────────────────────────────────────────────────────────────────────────

test("extractReferencedIds: resolves a placeholder reference to the real resourceId", () => {
  const data = { model: { toolIds: ["{{tool_ref}}"] } };
  const refs = extractReferencedIds(data, { tool_ref: "my-tool" });
  assert.deepEqual(refs.tools, ["my-tool"]);
});

test("extractReferencedIds: without variables, a placeholder stays literal", () => {
  const data = { model: { toolIds: ["{{tool_ref}}"] } };
  const refs = extractReferencedIds(data);
  assert.deepEqual(refs.tools, ["{{tool_ref}}"]);
});

test("extractReferencedIds: literal references still extracted alongside placeholders", () => {
  const data = { model: { toolIds: ["literal-tool", "{{tool_ref}}"] } };
  const refs = extractReferencedIds(data, { tool_ref: "my-tool" });
  assert.deepEqual(refs.tools.sort(), ["literal-tool", "my-tool"]);
});
