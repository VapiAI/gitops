import assert from "node:assert/strict";
import test from "node:test";

// config.ts parses the command-line environment at import time.
const originalArgv = process.argv;
const originalPrivateKey = process.env.VAPI_PRIVATE_API_KEY;
const originalLegacyToken = process.env.VAPI_TOKEN;
process.argv = [...originalArgv.slice(0, 2), "test-org"];
process.env.VAPI_PRIVATE_API_KEY = "test-only";
const { removeExcludedKeys } = await import("../src/config.ts");
process.argv = originalArgv;
if (originalPrivateKey === undefined) delete process.env.VAPI_PRIVATE_API_KEY;
else process.env.VAPI_PRIVATE_API_KEY = originalPrivateKey;
if (originalLegacyToken === undefined) delete process.env.VAPI_TOKEN;
else process.env.VAPI_TOKEN = originalLegacyToken;

test("tool update payloads exclude latestVersion", () => {
  const payload = {
    id: "tool-id",
    type: "apiRequest",
    latestVersion: "v1",
    name: "lookup_customer",
  };

  assert.deepEqual(removeExcludedKeys(payload, "tools"), {
    id: "tool-id",
    name: "lookup_customer",
  });
  assert.equal(payload.latestVersion, "v1");
});

test("assistant update payloads exclude latestVersion", () => {
  const payload = {
    id: "assistant-id",
    latestVersion: "v1",
    name: "Support Assistant",
  };

  assert.deepEqual(removeExcludedKeys(payload, "assistants"), {
    id: "assistant-id",
    name: "Support Assistant",
  });
  assert.equal(payload.latestVersion, "v1");
});

test("squad update payloads exclude latestVersion", () => {
  const payload = {
    id: "squad-id",
    latestVersion: "v1",
    name: "Support Squad",
  };

  assert.deepEqual(removeExcludedKeys(payload, "squads"), {
    id: "squad-id",
    name: "Support Squad",
  });
  assert.equal(payload.latestVersion, "v1");
});
