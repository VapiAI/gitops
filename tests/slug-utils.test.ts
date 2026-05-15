import assert from "node:assert/strict";
import test from "node:test";

// slug-utils.ts is config-free by design — no need to prime process.argv /
// VAPI_TOKEN. That's the whole point of the module. This test imports it
// directly to prove that property.
import {
  extractBaseSlug,
  isEngineSuffixedSlug,
  slugify,
  UUID_SUFFIX_RE,
} from "../src/slug-utils.ts";

// ─────────────────────────────────────────────────────────────────────────────
// slugify
// ─────────────────────────────────────────────────────────────────────────────

test("slugify: lowercases, replaces non-alphanumeric, trims, collapses runs", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Foo  Bar  "), "foo-bar");
  assert.equal(slugify("Foo___Bar"), "foo-bar");
  assert.equal(slugify("--foo--bar--"), "foo-bar");
  assert.equal(slugify("End Call!"), "end-call");
  assert.equal(slugify("ALL CAPS NAME"), "all-caps-name");
});

test("slugify: preserves digits", () => {
  assert.equal(slugify("v2 API"), "v2-api");
  assert.equal(slugify("squad 7"), "squad-7");
});

test("slugify: collapses repeated separators into single dash", () => {
  assert.equal(slugify("foo!!bar"), "foo-bar");
  assert.equal(slugify("foo - - bar"), "foo-bar");
});

// ─────────────────────────────────────────────────────────────────────────────
// UUID_SUFFIX_RE
// ─────────────────────────────────────────────────────────────────────────────

test("UUID_SUFFIX_RE: matches exactly 8 hex chars after final dash", () => {
  assert.match("foo-12345678", UUID_SUFFIX_RE);
  assert.match("end-call-67aea057", UUID_SUFFIX_RE);
  assert.match("a-b-c-d-deadbeef", UUID_SUFFIX_RE);
});

test("UUID_SUFFIX_RE: rejects 7 or 9 hex chars (off-by-one boundaries)", () => {
  assert.doesNotMatch("foo-1234567", UUID_SUFFIX_RE);
  assert.doesNotMatch("foo-123456789", UUID_SUFFIX_RE);
});

test("UUID_SUFFIX_RE: rejects non-hex suffix", () => {
  assert.doesNotMatch("foo-xxxxxxxx", UUID_SUFFIX_RE);
  assert.doesNotMatch("foo-1234567g", UUID_SUFFIX_RE);
});

test("UUID_SUFFIX_RE: rejects empty base (regression guard for `.+` not `.*`)", () => {
  // An engine-generated state key always has a real slug before the
  // suffix. The synthetic `-deadbeef` shape (empty base) must not match
  // because there's no canonical slug to recanonicalize TO.
  assert.doesNotMatch("-deadbeef", UUID_SUFFIX_RE);
});

test("UUID_SUFFIX_RE: case-insensitive on hex", () => {
  assert.match("foo-ABCDEF12", UUID_SUFFIX_RE);
  assert.match("foo-AbCdEf12", UUID_SUFFIX_RE);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractBaseSlug — loose form
// ─────────────────────────────────────────────────────────────────────────────

test("extractBaseSlug: strips engine-shape suffix", () => {
  assert.equal(extractBaseSlug("end-call-67aea057"), "end-call");
  assert.equal(extractBaseSlug("foo-vmd-004c5108"), "foo-vmd");
});

test("extractBaseSlug: returns input unchanged when no suffix present", () => {
  assert.equal(extractBaseSlug("my-tool"), "my-tool");
  assert.equal(extractBaseSlug("plain"), "plain");
});

test("extractBaseSlug: returns input unchanged when suffix is non-hex", () => {
  assert.equal(extractBaseSlug("my-tool-xxxxxxxx"), "my-tool-xxxxxxxx");
});

test("extractBaseSlug: returns input unchanged when suffix is wrong length", () => {
  assert.equal(extractBaseSlug("my-tool-1234567"), "my-tool-1234567");
  assert.equal(extractBaseSlug("my-tool-123456789"), "my-tool-123456789");
});

test("extractBaseSlug: does NOT validate suffix against any UUID (intentional loose form)", () => {
  // This is the contract that separates the loose form from the strict
  // `isEngineSuffixedSlug`. Callers without a UUID handy still need a
  // best-effort canonical form. A user-named "my-tool-deadbeef" returns
  // "my-tool" — pull's `findExistingResourceId` and audit's
  // sibling-base-slug check both rely on this best-effort behavior.
  assert.equal(extractBaseSlug("my-tool-deadbeef"), "my-tool");
});

// ─────────────────────────────────────────────────────────────────────────────
// isEngineSuffixedSlug — strict form
// ─────────────────────────────────────────────────────────────────────────────

test("isEngineSuffixedSlug: returns {base, suffix} when captured 8-hex matches UUID prefix", () => {
  const result = isEngineSuffixedSlug(
    "end-call-67aea057",
    "67aea057-1234-5678-90ab-cdef01234567",
  );
  assert.deepEqual(result, { base: "end-call", suffix: "67aea057" });
});

test("isEngineSuffixedSlug: returns null when captured suffix doesn't match UUID prefix (the precondition-2 check)", () => {
  // User-named "my-tool-deadbeef" paired with an unrelated UUID — must
  // NOT be treated as engine-generated.
  const result = isEngineSuffixedSlug(
    "my-tool-deadbeef",
    "99999999-aaaa-bbbb-cccc-dddddddddddd",
  );
  assert.equal(result, null);
});

test("isEngineSuffixedSlug: returns null when key has no engine-shape suffix", () => {
  assert.equal(
    isEngineSuffixedSlug("plain-name", "67aea057-1234-5678-90ab-cdef01234567"),
    null,
  );
});

test("isEngineSuffixedSlug: rejects empty base (regression guard)", () => {
  // Same shape as the UUID_SUFFIX_RE empty-base guard, but reached
  // through the strict path. `-deadbeef` paired with `deadbeef-...` UUID
  // would technically satisfy the prefix-match but the regex itself
  // rejects empty bases.
  assert.equal(
    isEngineSuffixedSlug("-deadbeef", "deadbeef-1234-5678-90ab-cdef01234567"),
    null,
  );
});

test("isEngineSuffixedSlug: case-insensitive on captured suffix and UUID prefix", () => {
  const result = isEngineSuffixedSlug(
    "foo-AbCdEf12",
    "abcdef12-0000-0000-0000-000000000000",
  );
  assert.deepEqual(result, { base: "foo", suffix: "abcdef12" });
});

test("isEngineSuffixedSlug: strips UUID dashes defensively (malformed UUID with leading dashes)", () => {
  // Real UUIDs are `xxxxxxxx-xxxx-...` (dash starts at index 8), so the
  // first 8 chars contain no dashes. The dash-strip is defense against
  // malformed input — verify it does what the comment claims by feeding
  // a UUID with leading dashes that should still match.
  const result = isEngineSuffixedSlug(
    "foo-abcdef12",
    "abc-def-12-0000-0000-0000-000000000000",
  );
  assert.deepEqual(result, { base: "foo", suffix: "abcdef12" });
});

test("isEngineSuffixedSlug: handles multi-segment base", () => {
  const result = isEngineSuffixedSlug(
    "iform-voicemail-triage-squad-llm-only-vmd-004c5108",
    "004c5108-aaaa-bbbb-cccc-dddddddddddd",
  );
  assert.deepEqual(result, {
    base: "iform-voicemail-triage-squad-llm-only-vmd",
    suffix: "004c5108",
  });
});
