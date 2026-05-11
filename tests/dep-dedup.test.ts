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

test("findExistingResourceByName: assistant payload (top-level name only)", () => {
  // Assistants use top-level `name` and have no nested `function`. The
  // squad → assistant auto-apply path hits this shape via
  // ensureAssistantExists. Bootstrap may store the same dashboard assistant
  // under `<slug>-<uuid8>` (e.g., `support-bot-1234abcd`); a squad
  // referencing the original local key (`support-bot`) must adopt rather
  // than mint a duplicate.
  const m = findExistingResourceByName({
    localResourceId: "support-bot",
    localPayload: { name: "support-bot" },
    stateSection: {
      "support-bot-1234abcd": { uuid: "uuid-asst-aaa" },
    },
    remoteList: [{ id: "uuid-asst-aaa", name: "support-bot" }],
  });
  assert.equal(m?.uuid, "uuid-asst-aaa");
  assert.equal(m?.source, "both");
  assert.equal(m?.ambiguous, false);
});

test("findExistingResourceByName: state-only match", () => {
  const m = findExistingResourceByName({
    localResourceId: "b2b-invoice-end-call",
    localPayload: { function: { name: "end-call" } },
    stateSection: {
      "end-call-67aea057": { uuid: "uuid-aaa" },
    },
  });
  assert.deepEqual(m, {
    uuid: "uuid-aaa",
    source: "state",
    ambiguous: false,
    duplicateUuids: [],
  });
});

test("findExistingResourceByName: dashboard-only match", () => {
  const m = findExistingResourceByName({
    localResourceId: "end-call",
    localPayload: { function: { name: "end-call" } },
    stateSection: {},
    remoteList: [{ id: "uuid-bbb", function: { name: "end-call" } }],
  });
  assert.deepEqual(m, {
    uuid: "uuid-bbb",
    source: "dashboard",
    ambiguous: false,
    duplicateUuids: [],
  });
});

test("findExistingResourceByName: state and dashboard both match same uuid", () => {
  const m = findExistingResourceByName({
    localResourceId: "end-call",
    localPayload: { function: { name: "end-call" } },
    stateSection: { "end-call-67aea057": { uuid: "uuid-aaa" } },
    remoteList: [{ id: "uuid-aaa", function: { name: "end-call" } }],
  });
  assert.equal(m?.source, "both");
  assert.equal(m?.ambiguous, false);
});

test("findExistingResourceByName: ambiguous → lex-smallest UUID + duplicates surfaced", () => {
  const m = findExistingResourceByName({
    localResourceId: "end-call",
    localPayload: { function: { name: "end-call" } },
    stateSection: {
      "end-call-67aea057": { uuid: "uuid-zzz" },
      "end-call-16ff08ed": { uuid: "uuid-aaa" },
    },
  });
  assert.equal(m?.uuid, "uuid-aaa");
  assert.equal(m?.ambiguous, true);
  assert.deepEqual(m?.duplicateUuids, ["uuid-zzz"]);
});

test("findExistingResourceByName: no name on payload → undefined", () => {
  const m = findExistingResourceByName({
    localResourceId: "x",
    localPayload: {},
    stateSection: { "end-call-67aea057": { uuid: "uuid-aaa" } },
  });
  assert.equal(m, undefined);
});

test("findExistingResourceByName: localResourceId exact match excluded (caller's job)", () => {
  const m = findExistingResourceByName({
    localResourceId: "end-call-67aea057",
    localPayload: { function: { name: "end-call" } },
    stateSection: { "end-call-67aea057": { uuid: "uuid-aaa" } },
  });
  // Helper excludes the exact-key, leaving no match. Caller should have
  // short-circuited on the exact-key check before calling.
  assert.equal(m, undefined);
});

test("findExistingResourceByName: no match → undefined", () => {
  const m = findExistingResourceByName({
    localResourceId: "transfer-to-sales",
    localPayload: { function: { name: "transfer-to-sales" } },
    stateSection: { "end-call-67aea057": { uuid: "uuid-aaa" } },
    remoteList: [{ id: "uuid-bbb", function: { name: "voicemail" } }],
  });
  assert.equal(m, undefined);
});

test("findExistingResourceByName: ambiguous across state vs dashboard → lex-smallest, both surfaced", () => {
  // State has one UUID under a bootstrap-renamed key, dashboard has a
  // distinct UUID under the same canonical name (real on-dashboard
  // duplicate from a prior bug run). Both must surface in duplicateUuids
  // and the winner must be lex-smallest. Source must be "both" only when
  // the SAME uuid appears in both — here the winner appears in only one,
  // so source is whichever side it came from.
  const m = findExistingResourceByName({
    localResourceId: "b2b-invoice-end-call",
    localPayload: { function: { name: "end-call" } },
    stateSection: { "end-call-67aea057": { uuid: "uuid-zzz" } },
    remoteList: [{ id: "uuid-aaa", function: { name: "end-call" } }],
  });
  assert.equal(m?.uuid, "uuid-aaa");
  assert.equal(m?.ambiguous, true);
  assert.equal(m?.source, "dashboard");
  assert.deepEqual(m?.duplicateUuids, ["uuid-zzz"]);
});

test("findExistingResourceByName: empty stateSection AND empty remoteList → undefined", () => {
  // Defensive: a fresh push with no prior state and no dashboard population
  // must short-circuit to undefined so the auto-create path runs.
  const m = findExistingResourceByName({
    localResourceId: "anything",
    localPayload: { function: { name: "anything" } },
    stateSection: {},
    remoteList: [],
  });
  assert.equal(m, undefined);
});

test("findExistingResourceByName: remote payload uses top-level `name` (not function.name)", () => {
  // Pull-side / dashboard list payloads for non-tool resources (and some
  // tool list endpoints) expose `name` directly instead of nested in
  // `function.name`. The dedup helper must recognize both shapes.
  const m = findExistingResourceByName({
    localResourceId: "post-call-summary",
    localPayload: { name: "post-call-summary" },
    stateSection: {},
    remoteList: [{ id: "uuid-ccc", name: "post-call-summary" }],
  });
  assert.deepEqual(m, {
    uuid: "uuid-ccc",
    source: "dashboard",
    ambiguous: false,
    duplicateUuids: [],
  });
});
