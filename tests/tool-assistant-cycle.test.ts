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

const {
  cleanDestinationAssistantIds,
  omitUnresolvedDestinations,
  unresolvedDestinationSlugs,
  updateToolAssistantRefs,
} = await import("../src/push.ts");

import type { ResourceFile, StateFile } from "../src/types.ts";

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

test("an unresolved slug authored with a trailing YAML comment still drops the whole destinations key", async () => {
  // Resolution failure leaves the assistantId exactly as authored — comment
  // included — in the resolved payload, same as the original. The comparison
  // must clean both sides before checking equality, or the commented,
  // uncleaned resolved value never matches the cleaned original and the
  // destination is wrongly classified as resolved.
  const commented = "clinical-stage-1 ## stage one";
  const original = {
    destinations: [{ type: "assistant", assistantId: commented }],
  };
  const payload = {
    destinations: [{ type: "assistant", assistantId: commented }],
  };

  const result = omitUnresolvedDestinations(payload, original);

  assert.ok(
    !("destinations" in result),
    "the key must be absent so PATCH leaves the platform value untouched",
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// `updateToolAssistantRefs` runs AFTER every other resource has already
// applied — it is the linking pass, not the initial create. Today it
// unconditionally PATCHes `resolved.destinations`, so a destination whose
// assistant is genuinely absent (not in state, not in the local repo) still
// carries a raw slug and the API answers `400 Assistant with ID "<slug>" not
// found`, aborting the whole push at the very end. `unresolvedDestinationSlugs`
// is the guard: it reports which destinations still carry a slug post-
// resolution so the linking pass can skip that tool and warn instead of
// PATCHing garbage.
// ─────────────────────────────────────────────────────────────────────────────

test("unresolvedDestinationSlugs: a slug entry is reported", () => {
  const result = unresolvedDestinationSlugs([
    { type: "assistant", assistantId: "clinical-stage-1" },
  ]);
  assert.deepEqual(result, ["clinical-stage-1"]);
});

test("unresolvedDestinationSlugs: a trailing YAML comment is stripped before reporting", () => {
  const result = unresolvedDestinationSlugs([
    { type: "assistant", assistantId: "clinical-stage-1 ## stage one" },
  ]);
  assert.deepEqual(result, ["clinical-stage-1"]);
});

test("unresolvedDestinationSlugs: an array of only UUID assistantIds reports nothing", () => {
  // Raw UUIDs are never "unresolved" here — the CREATE path already strips
  // any destination whose resolved value equals the original, so a UUID that
  // reaches this helper is either a genuinely resolved reference or an
  // untracked-but-valid raw UUID the author wrote directly. Either way it must
  // flow to the PATCH, not get reported as unresolved.
  const result = unresolvedDestinationSlugs([
    { type: "assistant", assistantId: UUID },
  ]);
  assert.deepEqual(result, []);
});

test("unresolvedDestinationSlugs: non-assistant destinations are not reported", () => {
  const result = unresolvedDestinationSlugs([
    { type: "number", number: "+15550000000" },
  ]);
  assert.deepEqual(result, []);
});

test("unresolvedDestinationSlugs: non-array input returns an empty list", () => {
  assert.deepEqual(unresolvedDestinationSlugs(undefined), []);
  assert.deepEqual(unresolvedDestinationSlugs(null), []);
  assert.deepEqual(unresolvedDestinationSlugs("not-an-array"), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// `cleanDestinationAssistantIds` is the last line of defense before the
// linking-pass PATCH body goes out: an untracked-but-valid raw UUID destination
// authored with a trailing `## comment` fails resolution (left exactly as
// authored) and passes `unresolvedDestinationSlugs` (which cleans before the
// UUID check), so without this the comment would reach the API and 400.
// ─────────────────────────────────────────────────────────────────────────────

test("cleanDestinationAssistantIds: strips a trailing YAML comment from every destination's assistantId", () => {
  const untrackedUuid = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
  const result = cleanDestinationAssistantIds([
    {
      type: "assistant",
      assistantId: `${untrackedUuid} ## billing agent (unmanaged)`,
    },
    { type: "number", number: "+15550000000" },
  ]);

  assert.deepEqual(result, [
    { type: "assistant", assistantId: untrackedUuid },
    { type: "number", number: "+15550000000" },
  ]);
});

test("cleanDestinationAssistantIds: a destination with no comment is a no-op", () => {
  const result = cleanDestinationAssistantIds([
    { type: "assistant", assistantId: UUID },
  ]);
  assert.deepEqual(result, [{ type: "assistant", assistantId: UUID }]);
});

test("cleanDestinationAssistantIds: non-array input is returned unchanged", () => {
  assert.equal(cleanDestinationAssistantIds(undefined), undefined);
  assert.equal(cleanDestinationAssistantIds(null), null);
});

function emptyState(): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

test("updateToolAssistantRefs: skips the PATCH and warns when the referenced assistant is genuinely absent", async () => {
  const state = emptyState();
  state.tools["router"] = { uuid: UUID };
  // Deliberately no entry under state.assistants for "clinical-stage-1" — the
  // assistant is genuinely absent, not merely not-yet-applied.

  const tool: ResourceFile = {
    resourceId: "router",
    filePath: "/fake/tools/router.yml",
    data: {
      type: "transferCall",
      destinations: [{ type: "assistant", assistantId: "clinical-stage-1" }],
    },
  };

  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: UUID }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  try {
    await updateToolAssistantRefs([tool], state);

    assert.equal(
      fetchCalls.length,
      0,
      "no PATCH should be sent when the assistant is genuinely absent",
    );
    assert.ok(
      warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("router") &&
            arg.includes("clinical-stage-1"),
        ),
      ),
      "a warning naming the tool and the unresolved slug should be logged",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("updateToolAssistantRefs: PATCH body strips a trailing YAML comment from an untracked-but-valid raw UUID destination", async () => {
  // The UUID is untracked (no state.assistants entry) but still a valid UUID
  // shape, so it passes unresolvedDestinationSlugs and the linking pass
  // proceeds to PATCH — the comment must not ride along in the request body.
  const untrackedUuid = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
  const state = emptyState();
  state.tools["router"] = { uuid: UUID };

  const tool: ResourceFile = {
    resourceId: "router",
    filePath: "/fake/tools/router.yml",
    data: {
      type: "transferCall",
      destinations: [
        {
          type: "assistant",
          assistantId: `${untrackedUuid} ## billing agent (unmanaged)`,
        },
      ],
    },
  };

  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: UUID }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  try {
    await updateToolAssistantRefs([tool], state);

    assert.equal(fetchCalls.length, 1, "the PATCH should still be sent");
    const [, init] = fetchCalls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    assert.deepEqual(
      body.destinations,
      [{ type: "assistant", assistantId: untrackedUuid }],
      "the PATCH body's assistantId must be the bare UUID, no trailing comment",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
