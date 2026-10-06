import assert from "node:assert/strict";
import test from "node:test";
import {
  changedFieldPaths,
  versionActorResolve,
  versionMetadataBuild,
} from "../src/version-metadata.ts";

const BASE = {
  id: "a1",
  orgId: "o1",
  name: "Support agent",
  updatedAt: "2026-10-01T00:00:00.000Z",
  latestVersion: "v7",
  model: {
    provider: "openai",
    model: "gpt-4.1",
    messages: [{ role: "system", content: "old prompt" }],
  },
  voice: { provider: "11labs", voiceId: "abc" },
};

test("changedFieldPaths names the nested field a prompt edit touched", () => {
  const after = {
    ...BASE,
    model: {
      ...BASE.model,
      messages: [{ role: "system", content: "new prompt" }],
    },
  };
  assert.deepEqual(changedFieldPaths(BASE, after), ["model.messages"]);
});

test("changedFieldPaths ignores server-managed keys that move on every write", () => {
  const after = {
    ...BASE,
    updatedAt: "2026-10-06T00:00:00.000Z",
    latestVersion: "v8",
  };
  assert.deepEqual(changedFieldPaths(BASE, after), []);
});

test("changedFieldPaths lists added and removed keys", () => {
  const { voice: _voice, ...withoutVoice } = BASE;
  const after = { ...withoutVoice, firstMessage: "Hi" };
  assert.deepEqual(changedFieldPaths(BASE, after), ["firstMessage", "voice"]);
});

test("changedFieldPaths stops descending at maxDepth", () => {
  const after = {
    ...BASE,
    model: { ...BASE.model, provider: "anthropic", model: "claude-sonnet" },
  };
  assert.deepEqual(changedFieldPaths(BASE, after, 1), ["model"]);
});

test("versionMetadataBuild puts the actor and commit in the name and description", () => {
  const metadata = versionMetadataBuild({
    actor: { name: "dev@example.com", commit: "abc1234", dirty: false },
    changedPaths: ["model.messages", "voice.voiceId"],
    created: false,
  });
  assert.deepEqual(metadata, {
    versionName: "gitops abc1234 by dev@example.com",
    versionDescription:
      "Pushed by dev@example.com from commit abc1234 via vapi-gitops.\n" +
      "Changed: model.messages, voice.voiceId",
  });
});

test("versionMetadataBuild marks a push with uncommitted edits as dirty", () => {
  const metadata = versionMetadataBuild({
    actor: { name: "dev@example.com", commit: "abc1234", dirty: true },
    changedPaths: ["name"],
    created: false,
  });
  assert.equal(metadata.versionName, "gitops abc1234+dirty by dev@example.com");
});

test("versionMetadataBuild fits a large change in the API limits with a +N more tail", () => {
  const changedPaths = Array.from(
    { length: 60 },
    (_, i) => `analysisPlan.field${i}`,
  );
  const metadata = versionMetadataBuild({
    actor: { name: "x".repeat(120), commit: "abc1234", dirty: false },
    changedPaths,
    created: false,
  });
  assert.ok(metadata.versionName.length <= 80);
  assert.ok(metadata.versionDescription.length <= 500);
  assert.match(metadata.versionDescription, /\(\+\d+ more\)$/);
});

test("versionMetadataBuild says created for a first push", () => {
  const metadata = versionMetadataBuild({
    actor: { name: "dev@example.com", commit: null, dirty: false },
    changedPaths: [],
    created: true,
  });
  assert.equal(
    metadata.versionDescription,
    "Pushed by dev@example.com from commit no-commit via vapi-gitops.\n" +
      "Created by gitops.",
  );
});

test("versionActorResolve prefers an explicit actor over the CI and git identity", () => {
  const actor = versionActorResolve("resources", {
    VAPI_GITOPS_ACTOR: "release-bot",
    GITHUB_ACTOR: "someone",
  });
  assert.equal(actor.name, "release-bot");
});

test("versionActorResolve uses the GitHub actor in CI", () => {
  const actor = versionActorResolve("resources", { GITHUB_ACTOR: "someone" });
  assert.equal(actor.name, "github:someone");
});
