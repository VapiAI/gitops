import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  blocksRecordPath,
  blockLayers,
  blocksChanged,
  blocksExpand,
  blocksRecordRead,
  blocksRecordUpdate,
  blocksUsedIn,
} from "../src/blocks.ts";
import {
  orgResourcesRead,
  parseResourceDataFromFile,
  resourceFileUsesBlocks,
} from "../src/resource-parse.ts";
import { migrateAll } from "../src/migrate-hash-store.ts";
import { commitStepAcknowledge } from "../src/state-paths.ts";
import { filesWrite, repoCreate } from "./blocks-helpers.ts";

// Blocks are looked up from an org's folder, so every test builds a small
// repository: templates/ at the root, and resources/<org>/templates/.

function withRepo<T>(files: Record<string, string>, run: (root: string) => T) {
  const root = repoCreate(files);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expand(root: string, data: unknown, org = "acme") {
  return blocksExpand(data, blockLayers(join(root, "resources", org)));
}

function prompt(content: string) {
  return { model: { messages: [{ role: "system", content }] } };
}

function promptOf(data: unknown): string {
  return (data as ReturnType<typeof prompt>).model.messages[0]!.content;
}

test("a prompt block replaces its marker line, and nothing else changes", () => {
  withRepo(
    { "templates/blocks/red-flags.md": "\nCall 999 for chest pain.\n\n" },
    (root) => {
      const { data, usage } = expand(
        root,
        prompt("You are the triage agent.\n\n@include red-flags\n\nBe brief."),
      );
      assert.equal(
        promptOf(data),
        "You are the triage agent.\n\nCall 999 for chest pain.\n\nBe brief.",
      );
      assert.deepEqual(Object.keys(usage), ["blocks/red-flags.md"]);
    },
  );
});

test("the org's block wins over the shared block of the same name", () => {
  withRepo(
    {
      "templates/blocks/red-flags.md": "shared wording",
      "resources/south/templates/blocks/red-flags.md": "South's wording",
    },
    (root) => {
      const data = prompt("@include red-flags");
      assert.equal(promptOf(expand(root, data, "acme").data), "shared wording");
      assert.equal(
        promptOf(expand(root, data, "south").data),
        "South's wording",
      );
    },
  );
});

test("an org block that includes its own name extends the shared block", () => {
  withRepo(
    {
      "templates/blocks/red-flags.md": "shared wording",
      "resources/south/templates/blocks/red-flags.md":
        "@include red-flags\nAlso mention the South walk-in centre.",
    },
    (root) => {
      const { data, usage } = expand(
        root,
        prompt("@include red-flags"),
        "south",
      );
      assert.equal(
        promptOf(data),
        "shared wording\nAlso mention the South walk-in centre.",
      );
      // Both files are behind the one name, so a change to either shows.
      const before = usage["blocks/red-flags.md"];
      filesWrite(root, { "templates/blocks/red-flags.md": "new shared" });
      const after = expand(root, prompt("@include red-flags"), "south").usage;
      assert.notEqual(after["blocks/red-flags.md"], before);
    },
  );
});

test("blocks nest, and every block reached is recorded", () => {
  withRepo(
    {
      "templates/blocks/safety/all.md":
        "@include safety/red-flags\n@include tone",
      "templates/blocks/safety/red-flags.md": "Call 999.",
      "templates/blocks/tone.md": "Stay calm.",
    },
    (root) => {
      const { data, usage } = expand(root, prompt("@include safety/all"));
      assert.equal(promptOf(data), "Call 999.\nStay calm.");
      assert.deepEqual(Object.keys(usage), [
        "blocks/safety/all.md",
        "blocks/safety/red-flags.md",
        "blocks/tone.md",
      ]);
    },
  );
});

test("a loop of blocks is an error that names the chain", () => {
  withRepo(
    {
      "templates/blocks/a.md": "@include b",
      "templates/blocks/b.md": "@include a",
      "templates/blocks/self.md": "@include self",
    },
    (root) => {
      assert.throws(
        () => expand(root, prompt("@include a")),
        /loop: templates\/blocks\/a\.md → templates\/blocks\/b\.md → templates\/blocks\/a\.md/,
      );
      assert.throws(() => expand(root, prompt("@include self")), /loop/);
    },
  );
});

test("an unknown block is an error that lists where it was looked for", () => {
  withRepo({}, (root) => {
    assert.throws(
      () => expand(root, prompt("@include red-flags")),
      (error: Error) =>
        error.message.includes('Unknown prompt block "red-flags"') &&
        error.message.includes(
          "resources/acme/templates/blocks/red-flags.md",
        ) &&
        error.message.includes("- templates/blocks/red-flags.md"),
    );
    assert.throws(
      () => expand(root, { voice: { $include: "voice" } }),
      /Unknown config block "voice"[\s\S]*templates\/config\/voice\.yml/,
    );
    assert.throws(
      () => expand(root, prompt("@include ../secrets")),
      /Invalid prompt block name/,
    );
  });
});

test("Liquid inside a block reaches the prompt exactly as written", () => {
  const block = [
    "Offer to connect them to {{practice_name}} reception.",
    "{% if anon_handover %}Do not ask for a name.{% endif %}",
    "{{ now | date: '%A' }} {{{raw}}} {%- comment -%}x{%- endcomment -%}",
  ].join("\n");
  withRepo({ "templates/blocks/red-flags.md": `${block}\n` }, (root) => {
    assert.equal(
      promptOf(expand(root, prompt("Hi {{name}}.\n@include red-flags")).data),
      `Hi {{name}}.\n${block}`,
    );
  });
});

test("only a whole-line marker in a system message is an include", () => {
  withRepo({ "templates/blocks/x.md": "X" }, (root) => {
    const data = {
      firstMessage: "@include x",
      model: {
        messages: [
          { role: "system", content: "Say @include x aloud.\n  @include x  " },
          { role: "user", content: "@include x" },
        ],
      },
    };
    assert.deepEqual(expand(root, data).data, {
      firstMessage: "@include x",
      model: {
        messages: [
          { role: "system", content: "Say @include x aloud.\nX" },
          { role: "user", content: "@include x" },
        ],
      },
    });
  });
});

test("a config block fills a mapping, and the file's own keys win", () => {
  withRepo(
    {
      "templates/config/voice.yml":
        "provider: 11labs\nvoiceId: burt\nchunkPlan:\n  enabled: true\n  minCharacters: 30\n",
    },
    (root) => {
      const { data, usage } = expand(root, {
        name: "Triage",
        voice: {
          $include: "voice",
          voiceId: "sarah",
          chunkPlan: { minCharacters: 10 },
        },
      });
      assert.deepEqual(data, {
        name: "Triage",
        voice: {
          provider: "11labs",
          voiceId: "sarah",
          chunkPlan: { enabled: true, minCharacters: 10 },
        },
      });
      assert.deepEqual(Object.keys(usage), ["config/voice.yml"]);
    },
  );
});

test("a list the file sets replaces the block's list whole", () => {
  withRepo(
    {
      "templates/config/model.yml":
        "provider: openai\ntoolIds:\n  - end-call\n  - transfer\n",
    },
    (root) => {
      assert.deepEqual(
        expand(root, { model: { $include: "model", toolIds: ["lookup"] } })
          .data,
        { model: { provider: "openai", toolIds: ["lookup"] } },
      );
    },
  );
});

test("config blocks work at the top level, in list items and inside each other", () => {
  withRepo(
    {
      "templates/config/base.yml":
        "voice:\n  $include: voice\nmodel:\n  provider: openai\n  messages:\n    - role: system\n      content: |-\n        Shared intro.\n        @include tone\n",
      "templates/config/voice.yml": "provider: 11labs\nvoiceId: burt\n",
      "templates/config/member.yml":
        "assistantOverrides:\n  voice:\n    $include: voice\n",
      "templates/blocks/tone.md": "Stay calm, {{caller_name}}.",
    },
    (root) => {
      const { data, usage } = expand(root, {
        $include: "base",
        name: "Triage",
        members: [{ $include: "member", assistantId: "triage" }],
      });
      assert.deepEqual(data, {
        name: "Triage",
        voice: { provider: "11labs", voiceId: "burt" },
        model: {
          provider: "openai",
          messages: [
            {
              role: "system",
              content: "Shared intro.\nStay calm, {{caller_name}}.",
            },
          ],
        },
        members: [
          {
            assistantId: "triage",
            assistantOverrides: {
              voice: { provider: "11labs", voiceId: "burt" },
            },
          },
        ],
      });
      assert.deepEqual(Object.keys(usage), [
        "blocks/tone.md",
        "config/base.yml",
        "config/member.yml",
        "config/voice.yml",
      ]);
    },
  );
});

test("the org's config block wins, and can extend the shared one", () => {
  withRepo(
    {
      "templates/config/voice.yml": "provider: 11labs\nvoiceId: burt\n",
      "resources/south/templates/config/voice.yml":
        "$include: voice\nvoiceId: sarah\n",
    },
    (root) => {
      const data = { voice: { $include: "voice" } };
      assert.deepEqual(expand(root, data, "acme").data, {
        voice: { provider: "11labs", voiceId: "burt" },
      });
      assert.deepEqual(expand(root, data, "south").data, {
        voice: { provider: "11labs", voiceId: "sarah" },
      });
    },
  );
});

test("a block that is a list can be included on its own", () => {
  withRepo(
    { "templates/config/tools.yml": "- end-call\n- transfer\n" },
    (root) => {
      assert.deepEqual(
        expand(root, { model: { toolIds: { $include: "tools" } } }).data,
        { model: { toolIds: ["end-call", "transfer"] } },
      );
      assert.throws(
        () => expand(root, { model: { $include: "tools", provider: "x" } }),
        /Config block "tools" is not a mapping/,
      );
    },
  );
});

test("two blocks in one place may not set the same field differently", () => {
  withRepo(
    {
      "templates/config/a.yml": "voice:\n  provider: 11labs\n  speed: 1\n",
      "templates/config/b.yml": "voice:\n  provider: 11labs\n  speed: 1.2\n",
      "templates/config/c.yml": "voice:\n  provider: 11labs\n  style: 0.4\n",
    },
    (root) => {
      assert.throws(
        () => expand(root, { $include: ["a", "b"] }),
        /Config blocks "a" and "b" both set "voice\.speed" to different values/,
      );
      // Still refused when the file settles it: the blocks stay ambiguous
      // for the next file that includes them.
      assert.throws(
        () => expand(root, { $include: ["a", "b"], voice: { speed: 1.1 } }),
        /both set "voice\.speed"/,
      );
      assert.deepEqual(expand(root, { $include: ["a", "c"] }).data, {
        voice: { provider: "11labs", speed: 1, style: 0.4 },
      });
    },
  );
});

test("unclear includes are refused", () => {
  withRepo({ "templates/config/a.yml": "x: 1\n" }, (root) => {
    assert.throws(
      () => expand(root, { $include: "a", "<<": { x: 2 } }),
      /uses both "\$include" and a YAML merge key/,
    );
    assert.throws(() => expand(root, { $include: 3 }), /takes a config block/);
    assert.throws(() => expand(root, { $include: [] }), /takes a config block/);
    assert.throws(
      () => expand(root, { $include: ["a", "a"] }),
      /lists the same config block twice/,
    );
  });
  withRepo({ "templates/config/empty.yml": "# nothing yet\n" }, (root) => {
    assert.throws(() => expand(root, { $include: "empty" }), /is empty/);
  });
});

test("a resource that uses no blocks is returned untouched", () => {
  withRepo({}, (root) => {
    const data = { name: "Plain", model: { messages: [] } };
    const result = expand(root, data);
    assert.equal(result.data, data);
    assert.deepEqual(result.usage, {});
    assert.equal(blocksUsedIn(data), false);
    assert.equal(blocksUsedIn({ members: [{ $include: "m" }] }), true);
    assert.equal(blocksUsedIn(prompt("a\n@include b\nc")), true);
  });
});

test("every loader expands blocks: Markdown body, YAML assistant, squad", async () => {
  const root = repoCreate({
    "templates/blocks/red-flags.md": "Call 999 for {{practice_name}}.\n",
    "templates/config/voice.yml": "provider: 11labs\nvoiceId: burt\n",
    "resources/acme/assistants/triage.md":
      "---\nname: Triage\nvoice:\n  $include: voice\n---\n\nYou triage.\n\n@include red-flags\n",
    "resources/acme/assistants/pharmacy.yml":
      "name: Pharmacy\nmodel:\n  messages:\n    - role: system\n      content: |-\n        You handle repeats.\n        @include red-flags\n",
    "resources/acme/squads/front-desk.yml":
      "name: Front desk\nmembers:\n  - assistantId: triage\n    assistantOverrides:\n      voice:\n        $include: voice\n        voiceId: sarah\n",
  });
  try {
    const resources = await orgResourcesRead(root, "acme");
    const triage = resources.get("assistants:triage")!;
    assert.deepEqual(triage.data, {
      name: "Triage",
      voice: { provider: "11labs", voiceId: "burt" },
      model: {
        messages: [
          {
            role: "system",
            content: "You triage.\n\nCall 999 for {{practice_name}}.",
          },
        ],
      },
    });
    assert.deepEqual(Object.keys(triage.blocks), [
      "blocks/red-flags.md",
      "config/voice.yml",
    ]);
    assert.equal(
      promptOf(resources.get("assistants:pharmacy")!.data),
      "You handle repeats.\nCall 999 for {{practice_name}}.",
    );
    assert.deepEqual(resources.get("squads:front-desk")!.data, {
      name: "Front desk",
      members: [
        {
          assistantId: "triage",
          assistantOverrides: {
            voice: { provider: "11labs", voiceId: "sarah" },
          },
        },
      ],
    });

    // The drift hash is computed from this parse, so it must expand too.
    const file = join(root, "resources/acme/assistants/triage.md");
    assert.deepEqual(
      parseResourceDataFromFile(file, join(root, "resources/acme")),
      triage.data,
    );
    assert.throws(() => parseResourceDataFromFile(file), /uses blocks/);
    assert.equal(resourceFileUsesBlocks(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a block error names the resource file", async () => {
  const root = repoCreate({
    "resources/acme/assistants/triage.md":
      "---\nname: Triage\n---\n\n@include missing\n",
  });
  try {
    await assert.rejects(
      orgResourcesRead(root, "acme"),
      /Failed to expand blocks in "assistants\/triage\.md": Unknown prompt block "missing"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resourceFileUsesBlocks reads the file as written", () => {
  withRepo(
    {
      "a.md": "---\nname: A\n---\n\nNo blocks here, @include is mid-line.\n",
      "b.yml": "name: B\nvoice:\n  $include: voice\n",
      "broken.md": "---\nname: [unclosed\n---\n\n@include red-flags\n",
    },
    (root) => {
      assert.equal(resourceFileUsesBlocks(join(root, "a.md")), false);
      assert.equal(resourceFileUsesBlocks(join(root, "b.yml")), true);
      // Unparseable, but it plainly uses a block: pull must leave it alone.
      assert.equal(resourceFileUsesBlocks(join(root, "broken.md")), true);
    },
  );
});

test("the blocks record is written where the org's state is committed, and migrate moves it", async () => {
  const current = new Map<string, Record<string, string>>([
    ["assistants/triage", { "blocks/red-flags.md": "aaaa" }],
  ]);
  const entry = { "assistants/triage": { "blocks/red-flags.md": "aaaa" } };
  withRepo({ "state/acme/state.json": "{}\n" }, (root) => {
    blocksRecordUpdate(root, "acme", current, ["assistants/triage"]);
    assert.equal(
      blocksRecordPath(root, "acme"),
      join(root, "state/acme/blocks.json"),
    );
    assert.equal(existsSync(join(root, "resources/acme")), false);
    assert.deepEqual(blocksRecordRead(root, "acme"), entry);
  });
  // The layout from before state/: beside the old org pin, which a commit
  // step written for that layout stages. Nothing goes under state/.
  withRepo({ ".vapi-state.acme.json": "{}\n" }, (root) => {
    blocksRecordUpdate(root, "acme", current, ["assistants/triage"]);
    assert.equal(
      blocksRecordPath(root, "acme"),
      join(root, "resources/acme/.vapi-blocks.json"),
    );
    assert.equal(existsSync(join(root, "state")), false);
    assert.deepEqual(blocksRecordRead(root, "acme"), entry);
  });
  const root = repoCreate({ ".vapi-state.acme.json": "{}\n" });
  try {
    blocksRecordUpdate(root, "acme", current, ["assistants/triage"]);
    commitStepAcknowledge(root);
    await migrateAll(root);
    assert.equal(existsSync(join(root, "resources/acme/.vapi-blocks.json")), false);
    assert.equal(
      blocksRecordPath(root, "acme"),
      join(root, "state/acme/blocks.json"),
    );
    assert.deepEqual(blocksRecordRead(root, "acme"), entry);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the blocks record marks only pushed resources as in sync", () => {
  withRepo({ "resources/acme/.keep": "", "state/acme/state.json": "{}\n" }, (root) => {
    const current = new Map<string, Record<string, string>>([
      ["assistants/triage", { "blocks/red-flags.md": "aaaa" }],
      ["assistants/pharmacy", { "blocks/red-flags.md": "aaaa" }],
      ["assistants/plain", {}],
    ]);
    blocksRecordUpdate(root, "acme", current, ["assistants/triage", "assistants/plain"]);
    assert.deepEqual(blocksRecordRead(root, "acme"), {
      "assistants/triage": { "blocks/red-flags.md": "aaaa" },
    });
    assert.match(
      readFileSync(blocksRecordPath(root, "acme"), "utf8"),
      /^\{\n {2}"assistants\/triage"/,
    );

    // The block changes; only pharmacy is pushed. Triage keeps its old entry,
    // which is what marks it as still running the old text.
    const changed = new Map<string, Record<string, string>>([
      ["assistants/triage", { "blocks/red-flags.md": "bbbb" }],
      ["assistants/pharmacy", { "blocks/red-flags.md": "bbbb" }],
    ]);
    blocksRecordUpdate(root, "acme", changed, ["assistants/pharmacy"]);
    const record = blocksRecordRead(root, "acme");
    assert.deepEqual(
      blocksChanged(changed.get("assistants/triage")!, record["assistants/triage"]),
      ["blocks/red-flags.md"],
    );
    assert.deepEqual(
      blocksChanged(
        changed.get("assistants/pharmacy")!,
        record["assistants/pharmacy"],
      ),
      [],
    );

    // A resource that is gone, or no longer uses blocks, drops out.
    blocksRecordUpdate(root, "acme", new Map([["assistants/pharmacy", {}]]), []);
    assert.deepEqual(blocksRecordRead(root, "acme"), {});
  });
});
