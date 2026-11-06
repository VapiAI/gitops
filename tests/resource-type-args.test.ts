import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveResourceTypes,
  typeArgFor,
} from "../src/resource-type-args.ts";
import { VALID_RESOURCE_TYPES } from "../src/types.ts";

// The setup wizard downloads what you pick one type at a time, with
// `pull.ts <org> --type <type> --id …`, and a pull by --id accepts exactly one
// type. It passed the internal type name, and "simulations" is also the
// group alias for all four simulation types, so choosing simulations in the
// wizard failed with "Single-resource pull requires exactly one resource
// type" and stopped setup partway.

test("typeArgFor names exactly one type for every resource type", () => {
  for (const type of VALID_RESOURCE_TYPES) {
    assert.deepEqual(resolveResourceTypes(typeArgFor(type)), [type], type);
  }
});

test("typeArgFor spells simulations by its folder path", () => {
  assert.equal(typeArgFor("simulations"), "simulations/tests");
});

test("typeArgFor leaves other types unchanged", () => {
  assert.equal(typeArgFor("assistants"), "assistants");
});

test("--type simulations still selects every simulation type", () => {
  assert.deepEqual(resolveResourceTypes("simulations"), [
    "personalities",
    "scenarios",
    "simulations",
    "simulationSuites",
  ]);
});

test("resolveResourceTypes rejects an unknown type", () => {
  assert.equal(resolveResourceTypes("widgets"), null);
});
