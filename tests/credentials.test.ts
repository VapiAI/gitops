import test from "node:test";
import assert from "node:assert/strict";
import { replaceCredentialRefs } from "../src/credentials.ts";
import type { StateFile } from "../src/types.ts";

// Regression tests for P0-1.
//
// The branch `feat/optimization-gitops-flow` shipped a `deepReplaceValues`
// helper that walked every string in a payload and swapped any value matching
// a credential slug. Combined with the auto-slugified credential names from
// `pullCredentials` (which slugifies provider names like `openai`, `11labs`,
// `langfuse`), that meant every `provider: openai`, `voice.provider: 11labs`,
// `observabilityPlan.provider: langfuse` got rewritten to a UUID, which the
// API then rejects on POST/PATCH. These tests lock in the scoped semantics
// (only swap at exactly `credentialId` / `credentialIds` keys).

function makeState(creds: Record<string, string>): StateFile {
  return {
    credentials: creds,
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

function reverseMap(state: StateFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, uuid] of Object.entries(state.credentials)) {
    m.set(uuid, name);
  }
  return m;
}

function forwardMap(state: StateFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, uuid] of Object.entries(state.credentials)) {
    m.set(name, uuid);
  }
  return m;
}

test("replaceCredentialRefs swaps at credentialId keys", () => {
  const state = makeState({
    "roofr-server-credential": "11111111-1111-1111-1111-111111111111",
  });
  const input = {
    server: {
      url: "https://example.com",
      credentialId: "roofr-server-credential",
    },
  };
  const out = replaceCredentialRefs(input, forwardMap(state));
  assert.equal(
    (out.server as { credentialId: string }).credentialId,
    "11111111-1111-1111-1111-111111111111",
  );
});

test("replaceCredentialRefs swaps each entry of credentialIds arrays", () => {
  const state = makeState({
    "cred-a": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "cred-b": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  });
  const input = {
    model: {
      credentialIds: ["cred-a", "cred-b", "unknown-cred"],
    },
  };
  const out = replaceCredentialRefs(input, forwardMap(state));
  assert.deepEqual((out.model as { credentialIds: string[] }).credentialIds, [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    "unknown-cred",
  ]);
});

test(
  "P0-1 regression: replaceCredentialRefs does NOT touch model.provider, " +
    "voice.provider, observabilityPlan.provider — even when the slug exactly " +
    "matches a credential name like `openai`",
  () => {
    const state = makeState({
      openai: "00000000-0000-4000-a000-000000000001",
      "11labs": "00000000-0000-4000-a000-000000000002",
      langfuse: "00000000-0000-4000-a000-000000000003",
      anthropic: "00000000-0000-4000-a000-000000000004",
      deepgram: "00000000-0000-4000-a000-000000000005",
    });
    const input = {
      model: {
        provider: "openai",
        model: "gpt-4o",
        credentialId: "openai",
      },
      voice: {
        provider: "11labs",
        voiceId: "rachel",
        credentialId: "11labs",
      },
      transcriber: {
        provider: "deepgram",
        model: "nova-2",
        credentialId: "deepgram",
      },
      observabilityPlan: {
        provider: "langfuse",
        credentialId: "langfuse",
      },
      analysisPlan: {
        provider: "anthropic",
        credentialId: "anthropic",
      },
    };
    const out = replaceCredentialRefs(input, forwardMap(state)) as typeof input;

    // Provider enums must NOT be swapped.
    assert.equal(out.model.provider, "openai");
    assert.equal(out.voice.provider, "11labs");
    assert.equal(out.transcriber.provider, "deepgram");
    assert.equal(out.observabilityPlan.provider, "langfuse");
    assert.equal(out.analysisPlan.provider, "anthropic");

    // credentialId values, on the other hand, MUST be swapped.
    assert.equal(out.model.credentialId, "00000000-0000-4000-a000-000000000001");
    assert.equal(out.voice.credentialId, "00000000-0000-4000-a000-000000000002");
    assert.equal(
      out.transcriber.credentialId,
      "00000000-0000-4000-a000-000000000005",
    );
    assert.equal(
      out.observabilityPlan.credentialId,
      "00000000-0000-4000-a000-000000000003",
    );
    assert.equal(
      out.analysisPlan.credentialId,
      "00000000-0000-4000-a000-000000000004",
    );
  },
);

test("replaceCredentialRefs is symmetric: reverse map restores original names", () => {
  const state = makeState({
    "my-langfuse": "99999999-9999-9999-9999-999999999999",
  });
  const fwd = forwardMap(state);
  const rev = reverseMap(state);

  const original = {
    observabilityPlan: {
      provider: "langfuse",
      credentialId: "my-langfuse",
    },
  };
  const pushed = replaceCredentialRefs(original, fwd);
  const pulled = replaceCredentialRefs(pushed, rev);
  assert.deepEqual(pulled, original);
});

test("replaceCredentialRefs walks deeply nested structures", () => {
  const state = makeState({ "deep-cred": "deadbeef-dead-beef-dead-beefdeadbeef" });
  const input = {
    members: [
      {
        assistant: {
          model: {
            tools: [
              { name: "transferCall", credentialId: "deep-cred" },
              { name: "endCall" },
            ],
          },
        },
      },
    ],
  };
  const out = replaceCredentialRefs(input, forwardMap(state)) as typeof input;
  assert.equal(
    out.members[0]!.assistant.model.tools[0]!.credentialId,
    "deadbeef-dead-beef-dead-beefdeadbeef",
  );
});

test("replaceCredentialRefs is a no-op when replacements map is empty", () => {
  const input = { credentialId: "openai", provider: "openai" };
  const out = replaceCredentialRefs(input, new Map());
  assert.deepEqual(out, input);
});

test("replaceCredentialRefs preserves non-plain-object values (Date, Buffer)", () => {
  const state = makeState({ x: "yyy" });
  const date = new Date("2026-04-20T00:00:00Z");
  const input = {
    credentialId: "x",
    createdAt: date,
    payload: Buffer.from("hello"),
  };
  const out = replaceCredentialRefs(input, forwardMap(state)) as typeof input;
  assert.equal(out.credentialId, "yyy");
  assert.equal(out.createdAt, date, "Date instance must pass through unchanged");
  assert.ok(
    Buffer.isBuffer(out.payload),
    "Buffer instance must pass through unchanged",
  );
});

test("replaceCredentialRefs handles cyclic structures without infinite recursion", () => {
  const state = makeState({ x: "yyy" });
  const a: Record<string, unknown> = { credentialId: "x" };
  const b: Record<string, unknown> = { partner: a };
  a.partner = b;
  // Should not stack-overflow.
  const out = replaceCredentialRefs(a, forwardMap(state)) as typeof a;
  assert.equal(out.credentialId, "yyy");
});
