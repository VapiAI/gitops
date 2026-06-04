import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeResourceByPathRules,
  parseDriftResolveSelection,
  resourceResolveKey,
} from "../src/drift-resolve.ts";

test("parseDriftResolveSelection: supports mixed global and per-resource modes", () => {
  const selection = parseDriftResolveSelection([
    "--resolve=fail",
    "--resolve=assistants/intake=ours",
    "--resolve=squads/main=theirs",
  ]);

  assert.equal(selection.defaultMode, "fail");
  assert.equal(selection.perResource.get("assistants/intake"), "ours");
  assert.equal(selection.perResource.get("squads/main"), "theirs");
});

test("parseDriftResolveSelection: supports per-path overrides", () => {
  const selection = parseDriftResolveSelection([
    "--resolve=assistants/intake=ours",
    "--resolve-path=assistants/intake:voice=theirs",
    "--resolve-path=assistants/intake:model.messages=ours",
  ]);

  const rules = selection.perPath.get(
    resourceResolveKey("assistants", "intake"),
  );
  assert.deepEqual(rules, [
    { path: "voice", mode: "theirs" },
    { path: "model.messages", mode: "ours" },
  ]);
});

test("parseDriftResolveSelection: rejects invalid path fail mode", () => {
  assert.throws(
    () =>
      parseDriftResolveSelection([
        "--resolve-path=assistants/intake:voice=fail",
      ]),
    /Invalid path resolve mode/,
  );
});

test("mergeResourceByPathRules: keeps local base and takes selected dashboard path", () => {
  const merged = mergeResourceByPathRules({
    baseMode: "ours",
    localData: {
      name: "Intake",
      voice: { provider: "11labs", voiceId: "old" },
      model: { messages: [{ role: "system", content: "local prompt" }] },
    },
    platformData: {
      name: "Intake",
      voice: { provider: "cartesia", voiceId: "new" },
      model: { messages: [{ role: "system", content: "dashboard prompt" }] },
    },
    rules: [{ path: "voice", mode: "theirs" }],
  });

  assert.deepEqual(merged, {
    name: "Intake",
    voice: { provider: "cartesia", voiceId: "new" },
    model: { messages: [{ role: "system", content: "local prompt" }] },
  });
});

test("mergeResourceByPathRules: handles array path segments for squad members", () => {
  const merged = mergeResourceByPathRules({
    baseMode: "theirs",
    localData: {
      members: [
        {
          assistantId: "local-assistant",
          assistantOverrides: { variableValues: { bucket: "git" } },
        },
      ],
    },
    platformData: {
      members: [
        {
          assistantId: "dashboard-assistant",
          assistantOverrides: { variableValues: { bucket: "dashboard" } },
        },
      ],
    },
    rules: [{ path: "members[0].assistantId", mode: "ours" }],
  });

  assert.deepEqual(merged, {
    members: [
      {
        assistantId: "local-assistant",
        assistantOverrides: { variableValues: { bucket: "dashboard" } },
      },
    ],
  });
});
