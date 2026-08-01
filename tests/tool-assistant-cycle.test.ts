import assert from "node:assert/strict";
import test from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Tools are applied before assistants because assistants reference tools. But a
// handoff/transfer tool references an assistant, so that subset inverts the
// dependency — a genuine cycle.
//
// The engine already resolves it in two passes: the CREATE path strips
// unresolved assistant destinations, and `updateToolAssistantRefs` links them
// once every assistant exists. The UPDATE path had no equivalent, so a first
// push into an empty org sent the raw slug and the API answered:
//
//   PATCH /tool/<uuid> → 400 Assistant with ID "clinical-stage-1-a4598432" not found
//
// which aborted the push before the linking pass could run.
// ─────────────────────────────────────────────────────────────────────────────

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { omitUnresolvedDestinations } = await import("../src/push.ts");

const UUID = "8f14e45f-ceea-467a-9f1b-1a1b2c3d4e5f";

test("an unresolved assistant destination drops the whole destinations key", async () => {
  // Unresolved = resolution left the slug exactly as written, because the
  // assistant is not in state yet.
  const original = {
    type: "transferCall",
    destinations: [{ type: "assistant", assistantId: "clinical-stage-1" }],
  };
  const payload = {
    type: "transferCall",
    destinations: [{ type: "assistant", assistantId: "clinical-stage-1" }],
  };

  const result = omitUnresolvedDestinations(payload, original);

  assert.ok(
    !("destinations" in result),
    "the key must be absent so PATCH leaves the platform value untouched",
  );
  assert.equal(result.type, "transferCall", "the rest of the payload survives");
});

test("a resolved destination is sent unchanged", async () => {
  const original = {
    destinations: [{ type: "assistant", assistantId: "clinical-stage-1" }],
  };
  const payload = {
    destinations: [{ type: "assistant", assistantId: UUID }],
  };

  const result = omitUnresolvedDestinations(payload, original);

  assert.deepEqual(result.destinations, [
    { type: "assistant", assistantId: UUID },
  ]);
});

test("a trailing YAML comment on the reference still counts as resolved", async () => {
  // `assistantId: clinical-stage-1 ## human note` — the comment is part of the
  // authored string, so the comparison has to strip it or every reference would
  // look unresolved.
  const original = {
    destinations: [
      { type: "assistant", assistantId: "clinical-stage-1 ## stage one" },
    ],
  };
  const payload = { destinations: [{ type: "assistant", assistantId: UUID }] };

  const result = omitUnresolvedDestinations(payload, original);

  assert.ok("destinations" in result, "a resolved reference is still sent");
});

test("one unresolved destination among several omits the key, not just that entry", async () => {
  // Sending a filtered array would PATCH-replace `destinations` and drop the
  // resolved sibling from the dashboard. The linking pass rewrites the whole
  // array afterwards, so omitting is both safe and complete.
  const original = {
    destinations: [
      { type: "assistant", assistantId: "stage-one" },
      { type: "assistant", assistantId: "stage-two" },
    ],
  };
  const payload = {
    destinations: [
      { type: "assistant", assistantId: UUID },
      { type: "assistant", assistantId: "stage-two" },
    ],
  };

  const result = omitUnresolvedDestinations(payload, original);

  assert.ok(
    !("destinations" in result),
    "a partially resolved array must not be sent",
  );
});

test("a tool with no destinations is untouched", async () => {
  const payload = { type: "function", function: { name: "lookup" } };
  const result = omitUnresolvedDestinations(payload, payload);
  assert.deepEqual(result, payload);
});

test("non-assistant destinations never block the update", async () => {
  // Number/SIP destinations carry no assistantId, so they are always sendable.
  const payload = {
    destinations: [{ type: "number", number: "+15550000000" }],
  };
  const result = omitUnresolvedDestinations(payload, payload);
  assert.ok("destinations" in result);
});
