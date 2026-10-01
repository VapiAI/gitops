import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEYS_URL,
  missingApiKeyMessage,
  resolveApiKey,
} from "../src/api-key.ts";

// VAPI_PRIVATE_API_KEY is the canonical name (it matches the dashboard's
// "Private API Keys" section). VAPI_TOKEN is the original name and must keep
// working so existing forks, .env files, and CI secrets don't break.

test("resolveApiKey: canonical VAPI_PRIVATE_API_KEY is read", () => {
  assert.equal(resolveApiKey({ VAPI_PRIVATE_API_KEY: "new" }), "new");
});

test("resolveApiKey: legacy VAPI_TOKEN still works on its own", () => {
  assert.equal(resolveApiKey({ VAPI_TOKEN: "old" }), "old");
});

test("resolveApiKey: canonical name wins within one source", () => {
  assert.equal(
    resolveApiKey({ VAPI_PRIVATE_API_KEY: "new", VAPI_TOKEN: "old" }),
    "new",
  );
});

test("resolveApiKey: earlier source wins regardless of variable name", () => {
  // process.env (legacy name) beats a .env file (canonical name), preserving
  // the engine's "real environment overrides .env files" rule.
  assert.equal(
    resolveApiKey({ VAPI_TOKEN: "from-env" }, { VAPI_PRIVATE_API_KEY: "from-file" }),
    "from-env",
  );
});

test("resolveApiKey: blank values are ignored", () => {
  assert.equal(
    resolveApiKey({ VAPI_PRIVATE_API_KEY: "  ", VAPI_TOKEN: "" }, { VAPI_TOKEN: "x" }),
    "x",
  );
  assert.equal(resolveApiKey({}, {}), undefined);
});

test("missingApiKeyMessage points at the dashboard and the canonical name", () => {
  const msg = missingApiKeyMessage("my-org");
  assert.match(msg, new RegExp(API_KEYS_URL.replace(/[.\/]/g, "\\$&")));
  assert.match(msg, /Private API Keys/);
  assert.match(msg, /VAPI_PRIVATE_API_KEY=/);
  assert.match(msg, /\.env\.my-org/);
});
