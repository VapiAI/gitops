import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

// validate.ts reaches config.ts, which reads argv and the token at import.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { validateResources } = await import("../src/validate.ts");

import type { LoadedResources } from "../src/types.ts";

// Two ways of sharing content that look right in a file and do nothing:
// validate points at blocks instead.

function resources(partial: Partial<LoadedResources>): LoadedResources {
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
    ...partial,
  };
}

test("a YAML merge key is reported, because the engine sends it as a field", () => {
  const findings = validateResources(
    resources({
      squads: [
        {
          resourceId: "front-desk",
          filePath: "/fake/front-desk.yml",
          data: {
            name: "Front Desk",
            members: [
              { assistantId: "a", assistantOverrides: { "<<": { x: 1 } } },
            ],
          },
        },
      ],
    }),
  );
  assert.deepEqual(
    findings.map((f) => [f.severity, f.type, f.rule, f.fieldPath]),
    [["warn", "squads", "yaml-merge-key", "members[0].assistantOverrides"]],
  );
  assert.match(findings[0]!.message, /\$include/);
});

test("a Liquid file tag in a system prompt is reported, because Vapi renders it as nothing", () => {
  const prompt = (content: string) => ({
    resourceId: "a",
    filePath: "/fake/a.md",
    data: { name: "A", model: { messages: [{ role: "system", content }] } },
  });
  const rules = (content: string) =>
    validateResources(resources({ assistants: [prompt(content)] })).map(
      (f) => f.rule,
    );
  assert.deepEqual(rules("Hi.\n{% include 'red-flags' %}"), ["liquid-file-tag"]);
  assert.deepEqual(rules("{%- render 'tone' -%}"), ["liquid-file-tag"]);
  // Ordinary Liquid, and the block marker, are fine.
  assert.deepEqual(
    rules("{% if vip %}Hello {{ name }}{% endif %}\n@include red-flags"),
    [],
  );
});
