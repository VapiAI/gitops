import assert from "node:assert/strict";
import test from "node:test";
import {
  asResourceState,
  canonicalize,
  hashPayload,
  upsertState,
} from "../src/state-serialize.ts";
import type { ResourceState } from "../src/types.ts";

// Stack F — state schema migration coverage.
//
// Each state value is a ResourceState — a pure `{ uuid }`. Drift baselines
// moved to the per-developer hash store (.vapi-state-hash/), so the helpers
// must strip any legacy hash/timestamp field rather than carry it forward:
// saveState must never re-emit one. These specs pin the behavior of the public
// helpers without importing the full state.ts module (which loads config.ts
// and exits).

test("asResourceState: wraps a bare string UUID as { uuid }", () => {
  const result = asResourceState("uuid-abc-123");
  assert.deepEqual(result, { uuid: "uuid-abc-123" });
});

test("asResourceState: keeps only the uuid of an object entry", () => {
  assert.deepEqual(asResourceState({ uuid: "u" }), { uuid: "u" });
});

test("asResourceState: strips legacy hash/timestamp fields", () => {
  const legacy = {
    uuid: "u",
    lastPulledHash: "h",
    lastPulledAt: "2026-04-30T12:00:00Z",
    lastPushedHash: "p",
  };
  assert.deepEqual(asResourceState(legacy), { uuid: "u" });
});

test("asResourceState: rejects non-string-non-object values", () => {
  assert.equal(asResourceState(null), undefined);
  assert.equal(asResourceState(42), undefined);
  assert.equal(asResourceState(undefined), undefined);
  assert.equal(asResourceState({}), undefined);
  assert.equal(asResourceState({ uuid: 42 }), undefined);
});

test("upsertState: creates a new entry when none exists", () => {
  const section: Record<string, ResourceState> = {};
  upsertState(section, "agent-a", { uuid: "u1" });
  assert.deepEqual(section["agent-a"], { uuid: "u1" });
});

test("upsertState: writes only the uuid, even when the patch carries legacy fields", () => {
  // A caller still holding an old-shaped object must not smuggle a hash back
  // into the state file; baselines belong to the hash store.
  const section: Record<string, ResourceState> = {};
  const legacyPatch = { uuid: "u1", lastPushedHash: "new-push-hash" };
  upsertState(section, "agent-a", legacyPatch);
  assert.deepEqual(section["agent-a"], { uuid: "u1" });
});

test("upsertState: overwrites uuid if it changes", () => {
  const section: Record<string, ResourceState> = {
    "agent-a": { uuid: "u-old" },
  };
  upsertState(section, "agent-a", { uuid: "u-new" });
  assert.equal(section["agent-a"]!.uuid, "u-new");
});

test("hashPayload: produces stable hash regardless of insertion order", () => {
  const a = { z: 1, a: { y: 2, x: 3 } };
  const b = { a: { x: 3, y: 2 }, z: 1 };
  assert.equal(hashPayload(a), hashPayload(b));
});

test("hashPayload: produces different hash for different content", () => {
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
});

test("hashPayload: drops null/undefined leaves so transient nullish doesn't churn", () => {
  // The Vapi API sometimes echoes back fields as `null` and sometimes drops
  // them entirely. We don't want this to register as drift.
  const a = { name: "X", voicemail: null };
  const b = { name: "X" };
  assert.equal(hashPayload(a), hashPayload(b));
});

test("canonicalize: sorts keys and drops nullish leaves", () => {
  const result = canonicalize({
    z: 1,
    a: undefined,
    b: { y: null, x: "v" },
  });
  // Sorted: { b: { x: "v" }, z: 1 } — `a` dropped, `b.y` dropped
  assert.deepEqual(result, { b: { x: "v" }, z: 1 });
});

test("canonicalize: preserves array order", () => {
  const result = canonicalize({ ids: ["c", "a", "b"] });
  assert.deepEqual(result, { ids: ["c", "a", "b"] });
});
