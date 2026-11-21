import assert from "node:assert/strict";
import test from "node:test";
import { NameCollisionReport } from "../src/name-collisions.ts";

test("empty or nonmatching POST plans report no collisions", async () => {
  const report = new NameCollisionReport(async () => [
    { id: "other", name: "Other" },
  ]);
  assert.equal(await report.format(), "Name collisions: none");
  report.recordPost("assistants", "reception", { name: "Reception" }, {});
  assert.equal(await report.format(), "Name collisions: none");
});

test("collision report includes state and live matches by slug, deduplicated per POST", async () => {
  let calls = 0;
  const report = new NameCollisionReport(async () => {
    calls++;
    return [
      { id: "shared", function: { name: "Call_Helper" } },
      { id: "live", name: "Call Helper" },
    ];
  });
  report.recordPost(
    "tools",
    "helper",
    { function: { name: "call-helper" } },
    {
      "call-helper-aaaaaaaa": { uuid: "shared", origin: "pulled" },
      "call-helper-bbbbbbbb": { uuid: "state-only" },
      "call-helper-cccccccc": { uuid: "dry-run-post-1" },
      "other-dddddddd": { uuid: "not-a-match" },
    },
  );
  report.recordPost("tools", "helper-two", { name: "Call Helper" }, {});
  const output = await report.format();
  assert.match(
    output,
    /tools "Call_Helper" \(shared\): helper would create a new resource; --adopt helper to take this over/,
  );
  assert.match(output, /\(state-only\)/);
  assert.match(output, /\(live\)/);
  assert.doesNotMatch(output, /dry-run-post|not-a-match/);
  assert.equal(output.match(/\(shared\): helper /g)?.length, 1);
  assert.equal(calls, 1);
});

test("failed inventory lookup reports an incomplete check rather than none", async () => {
  const report = new NameCollisionReport(async () => {
    throw new Error("lookup unavailable");
  });
  report.recordPost("squads", "triage", { name: "Triage" }, {});
  const output = await report.format();
  assert.match(output, /Inventory unavailable for squads: lookup unavailable/);
  assert.match(output, /Collision check incomplete/);
  assert.doesNotMatch(output, /Name collisions: none/);
});
