import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPlaceholders,
  normalizeVariables,
  parsePlaceholder,
  resolveVariables,
  restoreVariablePlaceholders,
  valuesEqual,
} from "../src/variables.ts";
import type { Variables } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// parsePlaceholder — whole-value match only
// ─────────────────────────────────────────────────────────────────────────────

test("parsePlaceholder: matches a bare whole-value placeholder", () => {
  assert.equal(parsePlaceholder("{{callback_url}}"), "callback_url");
});

test("parsePlaceholder: tolerates inner and outer whitespace", () => {
  assert.equal(parsePlaceholder("{{ callback_url }}"), "callback_url");
  assert.equal(parsePlaceholder("  {{callback_url}}  "), "callback_url");
});

test("parsePlaceholder: allows dot/hyphen/underscore names", () => {
  assert.equal(parsePlaceholder("{{default.model}}"), "default.model");
  assert.equal(parsePlaceholder("{{call-back_url}}"), "call-back_url");
});

test("parsePlaceholder: rejects embedded (in-string) placeholders", () => {
  // Whole-value only — an embedded placeholder is NOT a match.
  assert.equal(parsePlaceholder("Hi {{name}}"), null);
  assert.equal(parsePlaceholder("{{a}}{{b}}"), null);
});

test("parsePlaceholder: rejects non-strings and names with spaces", () => {
  assert.equal(parsePlaceholder(42), null);
  assert.equal(parsePlaceholder(null), null);
  assert.equal(parsePlaceholder({}), null);
  assert.equal(parsePlaceholder("{{two words}}"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveVariables — forward (push), type-preserving
// ─────────────────────────────────────────────────────────────────────────────

const VARS: Variables = {
  callback_url: "https://example.com/vapi/webhook",
  default_model: "gpt-4.1",
  max_tokens: 260,
  flag: true,
  server_obj: { url: "https://example.com/srv", timeoutSeconds: 20 },
};

test("resolveVariables: replaces a whole-value placeholder with a string", () => {
  const out = resolveVariables(
    { server: { url: "{{callback_url}}" } },
    VARS,
  );
  assert.deepEqual(out, {
    server: { url: "https://example.com/vapi/webhook" },
  });
});

test("resolveVariables: preserves the native type (number, boolean, object)", () => {
  const out = resolveVariables(
    {
      model: { maxTokens: "{{max_tokens}}", stream: "{{flag}}" },
      server: "{{server_obj}}",
    },
    VARS,
  ) as Record<string, any>;
  assert.strictEqual(out.model.maxTokens, 260); // number, not "260"
  assert.strictEqual(out.model.stream, true); // boolean, not "true"
  assert.deepEqual(out.server, {
    url: "https://example.com/srv",
    timeoutSeconds: 20,
  });
});

test("resolveVariables: substitutes inside arrays", () => {
  const out = resolveVariables(
    { messages: ["{{default_model}}", "literal"] },
    VARS,
  );
  assert.deepEqual(out, { messages: ["gpt-4.1", "literal"] });
});

test("resolveVariables: leaves embedded placeholders untouched", () => {
  const out = resolveVariables({ prompt: "Use {{default_model}} now" }, VARS);
  assert.deepEqual(out, { prompt: "Use {{default_model}} now" });
});

test("resolveVariables: leaves unknown placeholders untouched", () => {
  const out = resolveVariables({ x: "{{nope}}" }, VARS);
  assert.deepEqual(out, { x: "{{nope}}" });
});

test("resolveVariables: does not mutate the input", () => {
  const input = { server: { url: "{{callback_url}}" } };
  const snapshot = JSON.parse(JSON.stringify(input));
  resolveVariables(input, VARS);
  assert.deepEqual(input, snapshot);
});

test("resolveVariables: object values are not aliased across sites", () => {
  const out = resolveVariables(
    { a: "{{server_obj}}", b: "{{server_obj}}" },
    VARS,
  ) as Record<string, any>;
  out.a.url = "mutated";
  assert.strictEqual(out.b.url, "https://example.com/srv");
});

// ─────────────────────────────────────────────────────────────────────────────
// restoreVariablePlaceholders — reverse (pull), guided by the local file
// ─────────────────────────────────────────────────────────────────────────────

test("restore: re-inserts the placeholder where local had one and value matches", () => {
  const platform = { server: { url: "https://example.com/vapi/webhook" } };
  const local = { server: { url: "{{callback_url}}" } };
  const out = restoreVariablePlaceholders(platform, local, VARS);
  assert.deepEqual(out, { server: { url: "{{callback_url}}" } });
});

test("restore: preserves the author's exact placeholder text (spacing)", () => {
  const platform = { url: "https://example.com/vapi/webhook" };
  const local = { url: "{{ callback_url }}" };
  const out = restoreVariablePlaceholders(platform, local, VARS) as any;
  assert.strictEqual(out.url, "{{ callback_url }}");
});

test("restore: type-preserving inverse of resolveVariables (number)", () => {
  const platform = { model: { maxTokens: 260 } };
  const local = { model: { maxTokens: "{{max_tokens}}" } };
  const out = restoreVariablePlaceholders(platform, local, VARS);
  assert.deepEqual(out, { model: { maxTokens: "{{max_tokens}}" } });
});

test("restore: does NOT templatize a literal that merely equals a value", () => {
  // local had a literal here (no placeholder) → must stay literal even though
  // it equals the managed value. This is the false-positive guard.
  const platform = { model: { model: "gpt-4.1" } };
  const local = { model: { model: "gpt-4.1" } };
  const out = restoreVariablePlaceholders(platform, local, VARS);
  assert.deepEqual(out, { model: { model: "gpt-4.1" } });
});

test("restore: drops the placeholder when the dashboard changed the value", () => {
  // local had {{callback_url}} but the platform value no longer matches →
  // write the literal (dashboard is now source of truth for that field).
  const platform = { server: { url: "https://CHANGED.example/hook" } };
  const local = { server: { url: "{{callback_url}}" } };
  const out = restoreVariablePlaceholders(platform, local, VARS);
  assert.deepEqual(out, { server: { url: "https://CHANGED.example/hook" } });
});

test("restore: no local file → platform values pass through verbatim", () => {
  const platform = { server: { url: "https://example.com/vapi/webhook" } };
  const out = restoreVariablePlaceholders(platform, undefined, VARS);
  assert.deepEqual(out, platform);
});

test("restore: round-trips resolveVariables (resolve→restore is identity)", () => {
  const local = {
    name: "Acme",
    server: { url: "{{callback_url}}" },
    model: { model: "{{default_model}}", maxTokens: "{{max_tokens}}" },
  };
  const rendered = resolveVariables(local, VARS);
  const restored = restoreVariablePlaceholders(rendered, local, VARS);
  assert.deepEqual(restored, local);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractPlaceholders + normalizeVariables
// ─────────────────────────────────────────────────────────────────────────────

test("extractPlaceholders: collects distinct names, sorted", () => {
  const names = extractPlaceholders({
    a: "{{zeta}}",
    b: ["{{alpha}}", "literal", "{{zeta}}"],
    c: { d: "{{beta}}", e: "Hi {{ignored}}" },
  });
  assert.deepEqual(names, ["alpha", "beta", "zeta"]);
});

test("normalizeVariables: passes a flat map through", () => {
  assert.deepEqual(normalizeVariables({ a: 1, b: "x" }), { a: 1, b: "x" });
});

test("normalizeVariables: coerces non-objects to {}", () => {
  assert.deepEqual(normalizeVariables(undefined), {});
  assert.deepEqual(normalizeVariables(null), {});
  assert.deepEqual(normalizeVariables([1, 2]), {});
  assert.deepEqual(normalizeVariables("nope"), {});
});

test("valuesEqual: order-insensitive structural equality", () => {
  assert.ok(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.ok(!valuesEqual({ a: 1 }, { a: 2 }));
  assert.ok(valuesEqual("gpt-4.1", "gpt-4.1"));
});

// Defensive: callers that bypass loadState() (cast raw JSON) can pass an
// undefined variables map — must degrade to a no-op, not throw.
test("resolveVariables: tolerates an undefined variables map", () => {
  assert.doesNotThrow(() =>
    resolveVariables({ x: "{{anything}}" }, undefined as unknown as Variables),
  );
  assert.deepEqual(
    resolveVariables({ x: "{{anything}}" }, undefined as unknown as Variables),
    { x: "{{anything}}" },
  );
});

test("restoreVariablePlaceholders: tolerates an undefined variables map", () => {
  assert.doesNotThrow(() =>
    restoreVariablePlaceholders(
      { x: "v" },
      { x: "{{a}}" },
      undefined as unknown as Variables,
    ),
  );
});
