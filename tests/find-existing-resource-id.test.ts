import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceState } from "../src/types.ts";

// pull.ts depends on config.ts which calls process.exit(1) at module load
// time if VAPI_TOKEN is not set or if argv[2] is not a valid slug. Set both
// before dynamic-importing the module under test. Same pattern as
// `clean-resource.test.ts`.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { findExistingResourceId } = await import("../src/pull.ts");

// Helper: build a minimal resource shape with the id+name fields the function
// reads. Other fields are irrelevant for adoption logic.
function resource(id: string, name: string) {
  return { id, name };
}

function stateEntry(uuid: string): ResourceState {
  return { uuid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adoption: positive cases (the function reuses an on-disk file's slug)
// ─────────────────────────────────────────────────────────────────────────────

test("adoption: state empty, one file matches name → adopt (cross-env pull)", () => {
  // Classic cross-env pull: dev shipped a file `riley-8102e715.md`, prod is
  // a fresh clone with no state entry for it. Pull should reuse the file
  // even though the UUID-suffix on disk differs from prod's UUID.
  const onDisk = ["riley-8102e715"];
  const newState: Record<string, ResourceState> = {};
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-prod-aaaa", "Riley"),
    newState,
  );
  assert.equal(result, "riley-8102e715");
});

test("adoption: file claimed in state by the SAME UUID → adopt (re-pull is idempotent)", () => {
  // Second pull of an already-tracked resource. State maps the slug to
  // THIS resource's UUID, so reusing the slug is correct.
  const onDisk = ["riley"];
  const newState: Record<string, ResourceState> = {
    riley: stateEntry("uuid-aaaa"),
  };
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-aaaa", "Riley"),
    newState,
  );
  assert.equal(result, "riley");
});

test("adoption: two matches but only one is adoptable (the unclaimed one) → adopt it", () => {
  // The dashboard has 2 same-named resources. The first was already
  // processed earlier in this same pull loop and adopted `riley.md`.
  // Now a different file `riley-deadbeef.md` (e.g. from cross-env pull
  // history) is on disk, unclaimed in state, and the current resource
  // can adopt it without conflict.
  const onDisk = ["riley", "riley-deadbeef"];
  const newState: Record<string, ResourceState> = {
    riley: stateEntry("uuid-aaaa"),
  };
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-bbbb", "Riley"),
    newState,
  );
  assert.equal(result, "riley-deadbeef");
});

// ─────────────────────────────────────────────────────────────────────────────
// No adoption: the fix's core case + the existing 0-or-2+ behavior
// ─────────────────────────────────────────────────────────────────────────────

test("no adoption: file claimed by DIFFERENT UUID → undefined (the fix's main case)", () => {
  // This is the clobber scenario the fix prevents: state already maps
  // `riley` to UUID A; a new resource with the same name but a NEW UUID
  // (B) must NOT adopt `riley.md` — doing so would overwrite A's content.
  const onDisk = ["riley"];
  const newState: Record<string, ResourceState> = {
    riley: stateEntry("uuid-aaaa"),
  };
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-bbbb", "Riley"),
    newState,
  );
  assert.equal(result, undefined);
});

test("no adoption: N+ matches with mixed claims → undefined", () => {
  // Two on-disk files both name-match. One is unclaimed (adoptable),
  // one is claimed by a different UUID (NOT adoptable). But ALSO a
  // third match exists, claimed by yet another different UUID. With
  // multiple adoptable candidates the 1:1 ambiguity guard still kicks
  // in. Here we test a related shape: 2 adoptable matches → ambiguous.
  const onDisk = ["riley", "riley-aaaa1111", "riley-bbbb2222"];
  const newState: Record<string, ResourceState> = {
    riley: stateEntry("uuid-other"),
    // riley-aaaa1111 and riley-bbbb2222 are both unclaimed → 2 adoptable
  };
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-cccc", "Riley"),
    newState,
  );
  assert.equal(result, undefined);
});

test("no adoption: N+ matches but all claimed by other UUIDs → undefined", () => {
  // Every name-matching file is claimed by some other UUID. No file is
  // adoptable for the current resource; fall through to
  // generateResourceId in the caller.
  const onDisk = ["riley", "riley-aaaa1111"];
  const newState: Record<string, ResourceState> = {
    riley: stateEntry("uuid-aaaa"),
    "riley-aaaa1111": stateEntry("uuid-bbbb"),
  };
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-cccc", "Riley"),
    newState,
  );
  assert.equal(result, undefined);
});

test("no adoption: no name-matching files on disk → undefined", () => {
  const onDisk = ["alex", "morgan-1234abcd"];
  const newState: Record<string, ResourceState> = {};
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-aaaa", "Riley"),
    newState,
  );
  assert.equal(result, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases (regression guards, unchanged behavior)
// ─────────────────────────────────────────────────────────────────────────────

test("regression: resource without a name → undefined (unchanged)", () => {
  // Tools store their name under function.name (see extractName). A
  // resource with neither a top-level name nor a function.name is
  // un-adoptable by design — no slug to compute.
  const onDisk = ["riley"];
  const newState: Record<string, ResourceState> = {};
  const result = findExistingResourceId(
    onDisk,
    { id: "uuid-aaaa" }, // no name
    newState,
  );
  assert.equal(result, undefined);
});

test("regression: two same-name files, state empty → undefined (unchanged ambiguity)", () => {
  // Pre-fix behavior: 2+ matches without a state discriminator → ambiguous,
  // refuse adoption. Fix should preserve this — both files are adoptable
  // (unclaimed), so `adoptable.length === 2` and the 1:1 guard fires.
  const onDisk = ["riley", "riley-deadbeef"];
  const newState: Record<string, ResourceState> = {};
  const result = findExistingResourceId(
    onDisk,
    resource("uuid-aaaa", "Riley"),
    newState,
  );
  assert.equal(result, undefined);
});
