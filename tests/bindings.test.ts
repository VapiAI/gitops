import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchAllPhoneNumbers,
  updateEnvConnection,
  updateBindingEnv,
} from "../src/bindings.ts";

test("updateEnvConnection replaces auth settings without clobbering bindings", () => {
  const existing = [
    "VAPI_TOKEN=old-token",
    "VAPI_BASE_URL=https://api.eu.vapi.ai",
    "CUSTOM_SETTING=keep-me",
    "",
    "# BEGIN VAPI MANAGED BINDINGS",
    "VAPI_PHONE_NUMBER_SUPPORT_LINE=phone-1",
    "# END VAPI MANAGED BINDINGS",
    "",
  ].join("\n");

  const result = updateEnvConnection(existing, "new-token");

  assert.match(result, /^VAPI_TOKEN=new-token$/m);
  assert.doesNotMatch(result, /^VAPI_BASE_URL=/m);
  assert.match(result, /^CUSTOM_SETTING=keep-me$/m);
  assert.match(result, /^VAPI_PHONE_NUMBER_SUPPORT_LINE=phone-1$/m);
});

test("updateBindingEnv preserves manual env values and exports org-local bindings", () => {
  const existing = [
    "VAPI_TOKEN=secret",
    "CUSTOM_SETTING=keep-me",
    "",
    "# BEGIN VAPI MANAGED BINDINGS",
    "VAPI_PHONE_NUMBER_OLD_NAME=phone-1",
    "# END VAPI MANAGED BINDINGS",
    "",
  ].join("\n");

  const result = updateBindingEnv(
    existing,
    { "crm-api": { uuid: "credential-1" } },
    [
      { id: "phone-1", name: "Renamed Support Line" },
      { id: "phone-2" },
    ],
  );

  assert.match(result.content, /^VAPI_TOKEN=secret$/m);
  assert.match(result.content, /^CUSTOM_SETTING=keep-me$/m);
  assert.match(
    result.content,
    /^VAPI_CREDENTIAL_CRM_API=credential-1$/m,
  );
  assert.match(
    result.content,
    /^VAPI_PHONE_NUMBER_OLD_NAME=phone-1$/m,
    "the generated block preserves a confirmed alias by UUID",
  );
  assert.equal(result.count, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /phone-2.*has no name/i);
});

test("manual bindings outside the generated block win without duplication", () => {
  const result = updateBindingEnv(
    "VAPI_TOKEN=secret\nVAPI_CREDENTIAL_CRM_API=manual-id\n",
    { "crm-api": { uuid: "discovered-id" } },
    [],
  );

  assert.equal(
    result.content.match(/^VAPI_CREDENTIAL_CRM_API=/gm)?.length,
    1,
  );
  assert.match(result.content, /^VAPI_CREDENTIAL_CRM_API=manual-id$/m);
  assert.match(result.warnings[0]!, /keeping the manually managed value/i);
});

test("ambiguous new phone-number names are omitted instead of guessed", () => {
  const result = updateBindingEnv("VAPI_TOKEN=secret\n", {}, [
    { id: "phone-a", name: "Support Line" },
    { id: "phone-b", name: "Support Line" },
  ]);

  assert.doesNotMatch(result.content, /VAPI_PHONE_NUMBER_SUPPORT_LINE=/);
  assert.match(result.warnings[0]!, /ambiguous/i);
});

test("a previously confirmed phone alias wins over a new duplicate name", () => {
  const result = updateBindingEnv(
    [
      "VAPI_TOKEN=secret",
      "",
      "# BEGIN VAPI MANAGED BINDINGS",
      "VAPI_PHONE_NUMBER_SUPPORT_LINE=phone-a",
      "# END VAPI MANAGED BINDINGS",
      "",
    ].join("\n"),
    {},
    [
      { id: "phone-a", name: "Support Line" },
      { id: "phone-b", name: "Support Line" },
    ],
  );

  assert.match(
    result.content,
    /^VAPI_PHONE_NUMBER_SUPPORT_LINE=phone-a$/m,
  );
  assert.doesNotMatch(result.content, /=phone-b$/m);
  assert.match(result.warnings[0]!, /already confirmed/i);
});

test("fetchAllPhoneNumbers follows v2 pagination", async () => {
  const requested: string[] = [];
  const pages = new Map<number, unknown>([
    [
      1,
      {
        results: [{ id: "phone-1", name: "One" }],
        metadata: { currentPage: 1, totalItems: 2, itemsPerPage: 1 },
      },
    ],
    [
      2,
      {
        results: [{ id: "phone-2", name: "Two" }],
        metadata: { currentPage: 2, totalItems: 2, itemsPerPage: 1 },
      },
    ],
  ]);

  const result = await fetchAllPhoneNumbers(async (endpoint) => {
    requested.push(endpoint);
    const page = Number(new URL(endpoint, "https://example.test").searchParams.get("page"));
    return pages.get(page);
  }, 1);

  assert.deepEqual(
    result.map((phone) => phone.id),
    ["phone-1", "phone-2"],
  );
  assert.deepEqual(requested, [
    "/v2/phone-number?limit=1&page=1",
    "/v2/phone-number?limit=1&page=2",
  ]);
});

test("fetchAllPhoneNumbers rejects a malformed success response", async () => {
  await assert.rejects(
    fetchAllPhoneNumbers(async () => ({ message: "unexpected envelope" })),
    /missing a results array/i,
  );
});
