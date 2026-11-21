import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBaseSlug,
  extractResourceName,
  findExistingResourceByName,
  slugify,
} from "../src/dep-dedup.ts";

// Dedup helper coverage. Verifies that bootstrap-renamed state entries and
// live dashboard duplicates are detected before the auto-apply path POSTs
// a fresh duplicate tool / SO / assistant.

test("slugify lowercases and dashes", () => {
  assert.equal(slugify("End Call Tool"), "end-call-tool");
  assert.equal(slugify("HandoffToSales"), "handofftosales");
});

test("extractBaseSlug strips uuid8 suffix", () => {
  assert.equal(extractBaseSlug("end-call-67aea057"), "end-call");
  assert.equal(extractBaseSlug("end-call"), "end-call"); // no suffix
  assert.equal(extractBaseSlug("foo-bar-12345678"), "foo-bar");
});

test("extractResourceName: tool uses function.name", () => {
  assert.equal(
    extractResourceName({ function: { name: "endCall" } }),
    "endCall",
  );
});

test("extractResourceName: SO uses top-level name", () => {
  assert.equal(
    extractResourceName({ name: "post-call-summary" }),
    "post-call-summary",
  );
});

test("extractResourceName: top-level name wins over function.name", () => {
  assert.equal(
    extractResourceName({ name: "outer", function: { name: "inner" } }),
    "outer",
  );
});

for (const origin of ["pushed", "adopted"] as const) {
  test(`owned ${origin} state match can be reused without dashboard authorization`, () => {
    const match = findExistingResourceByName({
      localResourceId: "stop",
      localPayload: { name: "Stop" },
      stateSection: { "stop-abcd1234": { uuid: "abcd1234", origin } },
      remoteList: [{ id: "different", name: "Stop" }],
    });
    assert.equal(match?.uuid, "abcd1234");
    assert.equal(match?.origin, origin);
    assert.equal(match?.source, "state");
  });
}
for (const origin of ["pulled", undefined] as const) {
  test(`unowned ${origin} state and dashboard name matches cannot be reused`, () => {
    assert.equal(
      findExistingResourceByName({
        localResourceId: "stop",
        localPayload: { name: "Stop" },
        stateSection: {
          "stop-abcd1234": { uuid: "abcd1234", ...(origin ? { origin } : {}) },
        },
        remoteList: [{ id: "abcd1234", name: "Stop" }],
      }),
      undefined,
    );
  });
}
test("dashboard alone never authorizes reuse", () => {
  assert.equal(
    findExistingResourceByName({
      localResourceId: "stop",
      localPayload: { function: { name: "Stop" } },
      stateSection: {},
      remoteList: [{ id: "remote", function: { name: "Stop" } }],
    }),
    undefined,
  );
});
test("no name, no match, and exact-key entries do not authorize alias reuse", () => {
  for (const localPayload of [{}, { name: "Other" }, { name: "Stop" }]) {
    assert.equal(
      findExistingResourceByName({
        localResourceId: "stop",
        localPayload,
        stateSection: { stop: { uuid: "uuid", origin: "pushed" } },
      }),
      undefined,
    );
  }
});
