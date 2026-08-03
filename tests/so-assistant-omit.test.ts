import assert from "node:assert/strict";
import test from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Structured outputs link to assistants via `assistant_ids` (snake_case,
// slugs), resolved to camelCase `assistantIds` (UUIDs) at push time.
// `resolveAssistantIds` (src/resolver.ts:103) silently drops any ref it can't
// resolve, so a structured output referencing an untracked assistant (a
// `--type structuredOutputs` push, say, or an assistant that simply hasn't
// been pushed yet) ends up with a shorter `assistantIds` array than what was
// authored.
//
// PATCH replaces the keys it receives, so sending that shorter array wipes
// whichever assistant links are already live on the dashboard:
//
//   PATCH /structured-output/<uuid> { assistantIds: [] }  // "resolved" nothing
//
// silently un-links every assistant the dashboard had, even though the file
// still authors every one of them. `omitUnresolvedAssistantIds` is the same
// omit-not-filter guard Task 1 added for tool destinations
// (`omitUnresolvedDestinations`), applied to the update path; the
// `updateStructuredOutputAssistantRefs` linking pass gets the analogous
// skip-and-warn instead of PATCHing a partial list.
// ─────────────────────────────────────────────────────────────────────────────

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { omitUnresolvedAssistantIds, updateStructuredOutputAssistantRefs } =
  await import("../src/push.ts");

import type { ResourceFile, StateFile } from "../src/types.ts";

const UUID = "8f14e45f-ceea-467a-9f1b-1a1b2c3d4e5f";
const UUID_2 = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";

test("one unresolved ref among the authored assistant_ids drops the whole assistantIds key", () => {
  const original = {
    assistant_ids: ["front-desk", "clinical-stage-1"],
  };
  const payload = {
    name: "intake-schema",
    assistantIds: [UUID], // only one of the two resolved
  };

  const result = omitUnresolvedAssistantIds(payload, original);

  assert.ok(
    !("assistantIds" in result),
    "the key must be absent so PATCH leaves the platform value untouched",
  );
  assert.equal(result.name, "intake-schema", "the rest of the payload survives");
});

test("a fully resolved assistantIds array is sent unchanged", () => {
  const original = { assistant_ids: ["front-desk", "clinical-stage-1"] };
  const payload = { assistantIds: [UUID, UUID_2] };

  const result = omitUnresolvedAssistantIds(payload, original);

  assert.deepEqual(result.assistantIds, [UUID, UUID_2]);
});

test("an authored ref with a trailing YAML comment still counts as one authored ref", () => {
  // `assistant_ids: [front-desk ## front desk bot]` — the comment is part of
  // the authored string, so the count has to strip it before comparing
  // lengths, or a fully resolved single ref would look like a partial one.
  const original = { assistant_ids: ["front-desk ## front desk bot"] };
  const payload = { assistantIds: [UUID] };

  const result = omitUnresolvedAssistantIds(payload, original);

  assert.ok(
    "assistantIds" in result,
    "one authored ref, one resolved ref — nothing to omit",
  );
});

test("no assistant_ids on the original payload leaves the update untouched", () => {
  const payload = { name: "intake-schema", assistantIds: [] };
  const result = omitUnresolvedAssistantIds(payload, {});
  assert.deepEqual(result, payload);
});

test("assistant_ids: [] on the original payload leaves the update untouched", () => {
  const original = { assistant_ids: [] };
  const payload = { name: "intake-schema", assistantIds: [] };

  const result = omitUnresolvedAssistantIds(payload, original);

  assert.deepEqual(result, payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// `updateStructuredOutputAssistantRefs` runs after every other resource has
// applied — the linking pass, not the initial create. Before this change it
// PATCHed `resolveAssistantIds(...)` unconditionally whenever the result was
// non-empty, so a structured output with two authored refs where only one
// resolved would silently PATCH `assistantIds: [<one-uuid>]` and wipe the
// other link on the dashboard — with no warning at all, since the "all
// refs unresolved" case was the only one that skipped silently. Now any
// shortfall skips the PATCH and warns, naming which authored refs failed.
// ─────────────────────────────────────────────────────────────────────────────

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

async function withFetchAndWarnRecorders<T>(
  fn: (recorders: {
    fetchCalls: unknown[];
    warnings: unknown[][];
  }) => Promise<T>,
): Promise<T> {
  const fetchCalls: unknown[] = [];
  const warnings: unknown[][] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
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
    return await fn({ fetchCalls, warnings });
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

test("updateStructuredOutputAssistantRefs: skips the PATCH and warns when the single authored ref is absent from state", async () => {
  const state = emptyState();
  state.structuredOutputs["intake-schema"] = { uuid: UUID };
  // Deliberately no entry under state.assistants for "front-desk" — the
  // assistant is genuinely absent, not merely not-yet-applied.

  const so: ResourceFile = {
    resourceId: "intake-schema",
    filePath: "/fake/structured-outputs/intake-schema.yml",
    data: { assistant_ids: ["front-desk"] },
  };

  await withFetchAndWarnRecorders(async ({ fetchCalls, warnings }) => {
    await updateStructuredOutputAssistantRefs([so], state);

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
            arg.includes("intake-schema") &&
            arg.includes("front-desk"),
        ),
      ),
      "a warning naming the structured output and the unresolved ref should be logged",
    );
  });
});

test("updateStructuredOutputAssistantRefs: a partial resolution (one of two) skips the PATCH and names only the failing ref", async () => {
  const state = emptyState();
  state.structuredOutputs["intake-schema"] = { uuid: UUID };
  state.assistants["front-desk"] = { uuid: UUID_2 };
  // "clinical-stage-1" is deliberately untracked.

  const so: ResourceFile = {
    resourceId: "intake-schema",
    filePath: "/fake/structured-outputs/intake-schema.yml",
    data: { assistant_ids: ["front-desk", "clinical-stage-1"] },
  };

  await withFetchAndWarnRecorders(async ({ fetchCalls, warnings }) => {
    await updateStructuredOutputAssistantRefs([so], state);

    assert.equal(
      fetchCalls.length,
      0,
      "sending the partial array would wipe the resolved link on the dashboard",
    );
    assert.ok(
      warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("intake-schema") &&
            arg.includes("clinical-stage-1") &&
            !arg.includes("clinical-stage-1, front-desk"),
        ),
      ),
      "the warning should name the unresolved ref but not the resolved one",
    );
  });
});

test("updateStructuredOutputAssistantRefs: an untracked raw UUID counts as unresolved and skips the PATCH", async () => {
  // A raw UUID that isn't in state resolves to null (resolveAssistantId
  // treats it as "possibly deleted") — for structured outputs that must
  // trigger the same skip-and-warn as an unresolved slug, since there is no
  // later pass to repair a wiped link.
  const state = emptyState();
  state.structuredOutputs["intake-schema"] = { uuid: UUID };

  const so: ResourceFile = {
    resourceId: "intake-schema",
    filePath: "/fake/structured-outputs/intake-schema.yml",
    data: { assistant_ids: [UUID_2] },
  };

  await withFetchAndWarnRecorders(async ({ fetchCalls, warnings }) => {
    await updateStructuredOutputAssistantRefs([so], state);

    assert.equal(fetchCalls.length, 0);
    assert.ok(
      warnings.some((args) =>
        args.some(
          (arg) => typeof arg === "string" && arg.includes(UUID_2),
        ),
      ),
      "the untracked UUID should be named in the warning",
    );
  });
});
