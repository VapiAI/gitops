import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ignorePatternsRead,
  markdownResourceParse,
  matchesIgnore,
  orgResourcesRead,
  parseResourceDataFromFile,
  resourceDirLoad,
} from "../src/resource-parse.ts";

// resource-parse.ts is config-free: importing it must not parse argv or
// exit, which is why this file can import it directly with no org argument.

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "resource-parse-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

async function silenced<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

test("markdownResourceParse makes the body the only system message", () => {
  const config = markdownResourceParse(
    [
      "---",
      "name: Intake",
      "model:",
      "  provider: openai",
      "  messages:",
      "    - role: system",
      "      content: old prompt",
      "    - role: assistant",
      "      content: hi",
      "---",
      "",
      "You are the intake agent.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(config, {
    name: "Intake",
    model: {
      provider: "openai",
      messages: [
        { role: "system", content: "You are the intake agent." },
        { role: "assistant", content: "hi" },
      ],
    },
  });
});

test("markdownResourceParse leaves the config alone when the body is empty", () => {
  assert.deepEqual(markdownResourceParse("---\nname: Empty\n---\n\n"), {
    name: "Empty",
  });
});

test("markdownResourceParse rejects a file with no frontmatter", () => {
  assert.throws(
    () => markdownResourceParse("just a prompt"),
    /Invalid frontmatter format/,
  );
});

test("parseResourceDataFromFile parses .md the same way the loader does", async () => {
  const root = fixture({
    "assistants/a.md": "---\nname: A\n---\nPrompt A\n",
  });
  try {
    const file = join(root, "assistants/a.md");
    const [loaded] = await silenced(() => resourceDirLoad("assistants", root));
    assert.deepEqual(parseResourceDataFromFile(file), loaded!.data);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resourceDirLoad loads every format in sorted order and skips hidden and backup files", async () => {
  const root = fixture({
    "tools/b-tool.yml": "type: function\nfunction:\n  name: b\n",
    "tools/a-tool.ts":
      "export default { type: 'function', function: { name: 'a' } };\n",
    "tools/nested/c-tool.yaml": "type: endCall\n",
    "tools/.hidden.yml": "type: endCall\n",
    "tools/b-tool.bkp.yml": "type: endCall\n",
    "tools/notes.txt": "not a resource\n",
  });
  try {
    const loaded = await silenced(() => resourceDirLoad("tools", root));
    assert.deepEqual(
      loaded.map((file) => [file.resourceId, file.data]),
      [
        ["a-tool", { type: "function", function: { name: "a" } }],
        ["b-tool", { type: "function", function: { name: "b" } }],
        ["nested/c-tool", { type: "endCall" }],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resourceDirLoad refuses two files with the same resource ID", async () => {
  const root = fixture({
    "tools/dup.yml": "type: endCall\n",
    "tools/dup.yaml": "type: endCall\n",
  });
  try {
    await assert.rejects(
      silenced(() => resourceDirLoad("tools", root)),
      /Duplicate resource ID "dup" found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resourceDirLoad rejects YAML that isn't an object", async () => {
  const root = fixture({ "tools/list.yml": "- a\n- b\n" });
  try {
    await assert.rejects(
      silenced(() => resourceDirLoad("tools", root)),
      /Failed to parse YAML resource "list.yml": Error: YAML must be an object, got array/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resourceDirLoad returns nothing for a missing directory", async () => {
  const root = fixture({});
  try {
    assert.deepEqual(await silenced(() => resourceDirLoad("squads", root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignorePatternsRead drops comments, blanks and reserved negations", () => {
  const root = fixture({
    ".vapi-ignore":
      "# comment\n\nassistants/legacy-*\n!assistants/keep\n  tools/** \n",
  });
  try {
    assert.deepEqual(ignorePatternsRead(root), [
      "assistants/legacy-*",
      "tools/**",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignorePatternsRead treats a missing file as no patterns", () => {
  const root = fixture({});
  try {
    assert.deepEqual(ignorePatternsRead(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchesIgnore: * stays in one segment, ** crosses segments", () => {
  assert.deepEqual(
    [
      matchesIgnore("assistants", "legacy-a", ["assistants/legacy-*"]),
      matchesIgnore("assistants", "team/legacy-a", ["assistants/legacy-*"]),
      matchesIgnore("assistants", "team/legacy-a", ["assistants/**"]),
      matchesIgnore("assistants", "a.b", ["assistants/a?b"]),
      matchesIgnore("assistants", "anything", []),
    ],
    ["assistants/legacy-*", null, "assistants/**", "assistants/a?b", null],
  );
});

test("orgResourcesRead reads every type for one org and applies its .vapi-ignore", async () => {
  const root = fixture({
    "resources/acme/.vapi-ignore": "assistants/legacy-*\n",
    "resources/acme/assistants/main.md": "---\nname: Main\n---\nHello\n",
    "resources/acme/assistants/legacy-old.yml": "name: Old\n",
    "resources/acme/tools/lookup.yml": "type: function\n",
    "resources/acme/simulations/suites/core.yml": "name: Core\n",
    "resources/other/tools/elsewhere.yml": "type: endCall\n",
  });
  try {
    const resources = await silenced(() => orgResourcesRead(root, "acme"));
    assert.deepEqual(
      [...resources.entries()].map(([key, value]) => [
        key,
        value.type,
        value.id,
      ]),
      [
        ["tools:lookup", "tools", "lookup"],
        ["assistants:main", "assistants", "main"],
        ["simulationSuites:core", "simulationSuites", "core"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgResourcesRead lets the caller override the ignore patterns", async () => {
  const root = fixture({
    "resources/acme/.vapi-ignore": "assistants/**\n",
    "resources/acme/assistants/main.yml": "name: Main\n",
  });
  try {
    const resources = await silenced(() =>
      orgResourcesRead(root, "acme", { ignorePatterns: [] }),
    );
    assert.deepEqual([...resources.keys()], ["assistants:main"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
