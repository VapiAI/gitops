import test from "node:test";
import assert from "node:assert/strict";
import { sortedKeysReplacer } from "../src/state-serialize.ts";

// Stack B regression test — pin deterministic key ordering on state file
// serialization. Two semantically equal state objects with different
// insertion orders MUST serialize byte-identically. Without this, the state
// file accumulates pure-reordering diffs that hide real changes.

test("sortedKeysReplacer emits top-level keys alphabetically", () => {
  const insertedABC = { c: 3, a: 1, b: 2 };
  const insertedCBA = { a: 1, b: 2, c: 3 };

  const serializedABC = JSON.stringify(insertedABC, sortedKeysReplacer, 2);
  const serializedCBA = JSON.stringify(insertedCBA, sortedKeysReplacer, 2);

  assert.equal(serializedABC, serializedCBA);
  assert.equal(
    serializedABC,
    `{
  "a": 1,
  "b": 2,
  "c": 3
}`,
  );
});

test("sortedKeysReplacer recursively sorts nested objects", () => {
  const a = {
    assistants: { z: "uuid-z", a: "uuid-a" },
    tools: { y: "uuid-y", b: "uuid-b" },
  };
  const b = {
    tools: { b: "uuid-b", y: "uuid-y" },
    assistants: { a: "uuid-a", z: "uuid-z" },
  };

  assert.equal(
    JSON.stringify(a, sortedKeysReplacer, 2),
    JSON.stringify(b, sortedKeysReplacer, 2),
  );
});

test("sortedKeysReplacer leaves array order intact", () => {
  // Array order is semantic for resource lists like `assistant_ids` —
  // sorting them would corrupt squad member ordering, tool destination
  // priority, etc. The replacer MUST NOT reorder arrays.
  const obj = { tags: ["zebra", "apple", "mango"] };
  const result = JSON.parse(JSON.stringify(obj, sortedKeysReplacer));
  assert.deepEqual(result.tags, ["zebra", "apple", "mango"]);
});

test("sortedKeysReplacer handles deeply nested mixed structures", () => {
  const insertion1 = {
    z: { y: { x: 1, w: 2 }, v: [{ b: 1, a: 2 }, { d: 1, c: 2 }] },
    a: 0,
  };
  const insertion2 = {
    a: 0,
    z: { v: [{ b: 1, a: 2 }, { d: 1, c: 2 }], y: { w: 2, x: 1 } },
  };

  assert.equal(
    JSON.stringify(insertion1, sortedKeysReplacer, 2),
    JSON.stringify(insertion2, sortedKeysReplacer, 2),
  );
});

test("sortedKeysReplacer preserves null and primitive values", () => {
  const obj = {
    voicemailMessage: null,
    name: "test",
    count: 42,
    enabled: true,
    nothing: undefined, // JSON.stringify drops undefined naturally
  };
  const serialized = JSON.stringify(obj, sortedKeysReplacer, 2);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.voicemailMessage, null);
  assert.equal(parsed.name, "test");
  assert.equal(parsed.count, 42);
  assert.equal(parsed.enabled, true);
  assert.equal("nothing" in parsed, false);
});

test("sortedKeysReplacer is stable: serializing twice yields identical output", () => {
  const state = {
    credentials: { c: "1", a: "2" },
    assistants: { z: "3", b: "4" },
    tools: { y: "5", x: "6" },
  };

  const first = JSON.stringify(state, sortedKeysReplacer, 2);
  const second = JSON.stringify(JSON.parse(first), sortedKeysReplacer, 2);
  assert.equal(first, second);
});
