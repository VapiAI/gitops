import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEYS_URL,
  missingApiKeyMessage,
  orgApiKeyVar,
  resolveApiKey,
  resolveOrgApiKey,
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
  assert.match(msg, /VAPI_PRIVATE_API_KEY_MY_ORG=/);
});

// ── Per-org keys ─────────────────────────────────────────────────────────
// An exported VAPI_PRIVATE_API_KEY applies to every org, so it silently
// replaced each org's .env.<org> key. VAPI_PRIVATE_API_KEY_<ORG> lets every
// org's key be exported at once, and a generic key that overrides a
// different .env.<org> key is reported.

test("orgApiKeyVar upper-cases the slug and turns hyphens into underscores", () => {
  assert.deepEqual(
    ["acme", "acme-dev", "team2-prod"].map(orgApiKeyVar),
    [
      "VAPI_PRIVATE_API_KEY_ACME",
      "VAPI_PRIVATE_API_KEY_ACME_DEV",
      "VAPI_PRIVATE_API_KEY_TEAM2_PROD",
    ],
  );
});

test("resolveOrgApiKey: the org's own variable beats the generic one and the file", () => {
  assert.deepEqual(
    resolveOrgApiKey(
      "acme-dev",
      { VAPI_PRIVATE_API_KEY_ACME_DEV: "org-key", VAPI_PRIVATE_API_KEY: "generic-key" },
      { VAPI_PRIVATE_API_KEY: "file-key" },
    ),
    { token: "org-key", source: "the VAPI_PRIVATE_API_KEY_ACME_DEV environment variable" },
  );
});

test("resolveOrgApiKey: another org's variable is ignored", () => {
  assert.deepEqual(
    resolveOrgApiKey(
      "acme-dev",
      { VAPI_PRIVATE_API_KEY_ACME_PROD: "prod-key" },
      { VAPI_PRIVATE_API_KEY: "file-key" },
    ),
    { token: "file-key", source: ".env.acme-dev" },
  );
});

test("resolveOrgApiKey: a generic key matching the file has no warning", () => {
  assert.deepEqual(
    resolveOrgApiKey("acme-dev", { VAPI_PRIVATE_API_KEY: "same" }, { VAPI_PRIVATE_API_KEY: "same" }),
    { token: "same", source: "the VAPI_PRIVATE_API_KEY environment variable" },
  );
});

test("resolveOrgApiKey: a generic key overriding a different file key warns", () => {
  const resolved = resolveOrgApiKey(
    "acme-prod",
    { VAPI_PRIVATE_API_KEY: "dev-key" },
    { VAPI_PRIVATE_API_KEY: "prod-key" },
  );
  assert.equal(resolved?.token, "dev-key");
  assert.match(resolved?.warning ?? "", /not the different key in \.env\.acme-prod/);
  assert.match(resolved?.warning ?? "", /export VAPI_PRIVATE_API_KEY_ACME_PROD/);
});

test("resolveOrgApiKey: the warning never contains either key", () => {
  const warning = resolveOrgApiKey(
    "acme-prod",
    { VAPI_TOKEN: "secret-one" },
    { VAPI_PRIVATE_API_KEY: "secret-two" },
  )?.warning;
  assert.match(warning ?? "", /VAPI_TOKEN environment variable/);
  assert.doesNotMatch(warning ?? "", /secret-one|secret-two/);
});

test("resolveOrgApiKey: .env.example placeholders count as no key", () => {
  assert.deepEqual(
    resolveOrgApiKey(
      "acme",
      { VAPI_PRIVATE_API_KEY_ACME: "your-vapi-private-key-here" },
      { VAPI_PRIVATE_API_KEY: "your-vapi-private-key-here" },
    ),
    undefined,
  );
});

test("resolveOrgApiKey: a placeholder in the file doesn't trigger the warning", () => {
  assert.deepEqual(
    resolveOrgApiKey(
      "acme",
      { VAPI_PRIVATE_API_KEY: "real-key" },
      { VAPI_PRIVATE_API_KEY: "your-vapi-private-key-here" },
    ),
    { token: "real-key", source: "the VAPI_PRIVATE_API_KEY environment variable" },
  );
});
