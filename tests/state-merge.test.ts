import assert from "node:assert/strict";
import test from "node:test";
import { mergeScoped, type TouchedSets } from "../src/state-merge.ts";
import type { StateFile } from "../src/types.ts";

// Stack J — scoped state-merge coverage. The plan's #15 fix: a scoped push
// must NOT sweep pre-existing drift (state entries unrelated to the touched
// resources) into the commit-able state diff.

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

function emptyTouched(): TouchedSets {
  return {
    tools: new Set(),
    structuredOutputs: new Set(),
    assistants: new Set(),
    squads: new Set(),
    personalities: new Set(),
    scenarios: new Set(),
    simulations: new Set(),
    simulationSuites: new Set(),
    evals: new Set(),
    credentials: new Set(),
  };
}

test("mergeScoped: untouched entries copied from on-disk state", () => {
  const onDisk = emptyState();
  onDisk.assistants["unrelated-1"] = { uuid: "u-1", lastPulledHash: "h-1" };
  onDisk.assistants["unrelated-2"] = { uuid: "u-2", lastPulledHash: "h-2" };

  const inMemory = emptyState();
  // In-memory state has unrelated-1 with a different hash (drift) and a
  // newly-touched assistant. mergeScoped should copy unrelated-1 from disk
  // (untouched), and only take touched-agent from in-memory.
  inMemory.assistants["unrelated-1"] = { uuid: "u-1", lastPulledHash: "h-X" };
  inMemory.assistants["touched-agent"] = {
    uuid: "u-3",
    lastPushedHash: "fresh",
  };

  const touched = emptyTouched();
  touched.assistants.add("touched-agent");

  const merged = mergeScoped(onDisk, inMemory, touched);
  assert.equal(merged.assistants["unrelated-1"]!.lastPulledHash, "h-1");
  assert.equal(merged.assistants["unrelated-2"]!.lastPulledHash, "h-2");
  assert.equal(merged.assistants["touched-agent"]!.lastPushedHash, "fresh");
});

test("mergeScoped: touched entries take in-memory version", () => {
  const onDisk = emptyState();
  onDisk.assistants["agent-a"] = { uuid: "u-1", lastPulledHash: "old" };

  const inMemory = emptyState();
  inMemory.assistants["agent-a"] = {
    uuid: "u-1",
    lastPulledHash: "old",
    lastPushedHash: "new",
  };

  const touched = emptyTouched();
  touched.assistants.add("agent-a");

  const merged = mergeScoped(onDisk, inMemory, touched);
  assert.equal(merged.assistants["agent-a"]!.lastPushedHash, "new");
});

test("mergeScoped: credentials always refreshed from in-memory", () => {
  const onDisk = emptyState();
  onDisk.credentials["openai"] = { uuid: "old-cred-uuid" };

  const inMemory = emptyState();
  inMemory.credentials["openai"] = { uuid: "new-cred-uuid" };
  // Bootstrap pull also added a new credential
  inMemory.credentials["langfuse"] = { uuid: "lang-cred-uuid" };

  const touched = emptyTouched(); // credentials are NOT explicitly touched

  const merged = mergeScoped(onDisk, inMemory, touched);
  assert.equal(merged.credentials["openai"]!.uuid, "new-cred-uuid");
  assert.equal(merged.credentials["langfuse"]!.uuid, "lang-cred-uuid");
});

test("mergeScoped: empty touched preserves all on-disk state", () => {
  const onDisk = emptyState();
  onDisk.assistants["a"] = { uuid: "u-a" };
  onDisk.tools["t"] = { uuid: "u-t" };

  const inMemory = emptyState(); // empty (e.g., scoped to a missing path)

  const touched = emptyTouched();

  const merged = mergeScoped(onDisk, inMemory, touched);
  assert.deepEqual(merged.assistants, { a: { uuid: "u-a" } });
  assert.deepEqual(merged.tools, { t: { uuid: "u-t" } });
});

test("mergeScoped: cross-section isolation (touched assistants do NOT affect tools section)", () => {
  const onDisk = emptyState();
  onDisk.tools["unrelated-tool"] = {
    uuid: "u-tool",
    lastPulledHash: "tool-hash",
  };
  onDisk.assistants["agent-a"] = { uuid: "u-old" };

  const inMemory = emptyState();
  inMemory.assistants["agent-a"] = { uuid: "u-old", lastPushedHash: "fresh" };
  // In-memory has an unrelated drift in tools section that should NOT bleed in
  inMemory.tools["unrelated-tool"] = {
    uuid: "u-tool",
    lastPulledHash: "drifted",
  };

  const touched = emptyTouched();
  touched.assistants.add("agent-a"); // ONLY assistants touched

  const merged = mergeScoped(onDisk, inMemory, touched);
  // tools section preserved from disk
  assert.equal(merged.tools["unrelated-tool"]!.lastPulledHash, "tool-hash");
  // assistants section: touched entry takes in-memory
  assert.equal(merged.assistants["agent-a"]!.lastPushedHash, "fresh");
});
