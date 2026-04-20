import test from "node:test";
import assert from "node:assert/strict";

// Regression tests for P0-3.
//
// pull.ts depends on config.ts which calls process.exit(1) at module load
// time if VAPI_TOKEN is not set or if argv[2] is not a valid slug. Set both
// before dynamic-importing the module under test.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { cleanResource } = await import("../src/pull.ts");

test("cleanResource strips the EXCLUDED_FIELDS (id, orgId, createdAt, etc.)", () => {
  const out = cleanResource({
    id: "uuid-1234",
    orgId: "org-1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    isDeleted: false,
    name: "support-bot",
  });
  assert.equal(out.id, undefined);
  assert.equal(out.orgId, undefined);
  assert.equal(out.createdAt, undefined);
  assert.equal(out.updatedAt, undefined);
  assert.equal(out.isDeleted, undefined);
  assert.equal(out.name, "support-bot");
});

test("cleanResource strips undefined values", () => {
  const out = cleanResource({
    id: "uuid-1234",
    name: "support-bot",
    voicemailMessage: undefined,
  });
  assert.ok(!("voicemailMessage" in out));
});

test(
  "P0-3 regression: cleanResource MUST preserve null. The Vapi API uses null " +
    "to represent intentionally cleared fields (voicemailMessage, " +
    "endCallMessage, etc.). Stripping null on pull would cause the next push " +
    "to drop the clear and re-apply any prior value still on the server.",
  () => {
    const out = cleanResource({
      id: "uuid-1234",
      name: "support-bot",
      voicemailMessage: null,
      endCallMessage: null,
      analysisPlan: { summaryPlan: { messages: null } },
    });
    assert.equal(
      out.voicemailMessage,
      null,
      "voicemailMessage: null must be preserved",
    );
    assert.equal(
      out.endCallMessage,
      null,
      "endCallMessage: null must be preserved",
    );
    // null nested in objects is preserved by JS structural copy automatically;
    // we just verify the parent object is not stripped.
    assert.deepEqual(out.analysisPlan, { summaryPlan: { messages: null } });
  },
);

test("cleanResource preserves nested structures verbatim", () => {
  const out = cleanResource({
    id: "uuid-1234",
    name: "support-bot",
    voice: {
      provider: "cartesia",
      voiceId: "abc-123",
      generationConfig: { speed: 1.0 },
    },
    members: [
      { assistantId: "child-1" },
      { assistantId: "child-2" },
    ],
  });
  assert.deepEqual(out.voice, {
    provider: "cartesia",
    voiceId: "abc-123",
    generationConfig: { speed: 1.0 },
  });
  assert.deepEqual(out.members, [
    { assistantId: "child-1" },
    { assistantId: "child-2" },
  ]);
});
