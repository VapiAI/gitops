import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  promotionConfigParse,
  promotionPlanApply,
  promotionPlanBuild,
  promotionTransitionValidate,
} from "../src/promotion.ts";
import type { StateFile } from "../src/types.ts";

function state(entries: Partial<StateFile> = {}): StateFile {
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
    ...entries,
  };
}

async function fixture(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "vapi-promotion-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function put(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

const configText = `version: 1
orgs:
  source: {}
  target: {}
pipelines:
  release:
    orgs: [source, target]
    resources: [assistants/**, tools/**]
`;

test("promotion config validates pipelines and forward-only transitions", () => {
  const config = promotionConfigParse(configText);
  assert.equal(
    promotionTransitionValidate(config, "release", "source", "target").orgs[0],
    "source",
  );
  assert.throws(
    () => promotionTransitionValidate(config, "release", "target", "source"),
    /forward/i,
  );
  assert.throws(
    () => promotionConfigParse("version: 1\norgs: {one: {}}\npipelines: {}\n"),
    /pipeline/i,
  );
  assert.throws(
    () =>
      promotionConfigParse(
        "version: 1\norgs: {a: {}, b: {}}\npipelines: {x: {orgs: [a, a], resources: []}}\n",
      ),
    /unique|resource/i,
  );
  assert.throws(
    () =>
      promotionConfigParse(
        "version: 1\norgs: {a: {}, b: {bindings: {credentials: {default: copy}}}}\npipelines: {x: {orgs: [a, b], resources: [tools/**]}}\n",
      ),
    /bind|omit/,
  );
  assert.doesNotThrow(() =>
    promotionConfigParse(
      "version: 1\norgs:\n  a:\n  b:\npipelines: {x: {orgs: [a, b], resources: [tools/**]}}\n",
    ),
  );
});

test("promotion plans creates, updates, deletes, and preserves unrelated target files", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/source/assistants/new.md",
      "---\nname: New\n---\n# Prompt\n",
    );
    await put(fx.root, "resources/source/tools/shared.yml", "name: source\n");
    await put(
      fx.root,
      "resources/target/assistants/old.md",
      "---\nname: Old\n---\nold\n",
    );
    await put(fx.root, "resources/target/tools/shared.yml", "name: target\n");
    await put(fx.root, "resources/target/squads/keep.yml", "name: keep\n");
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**", "tools/**"],
      sourceState: state(),
      targetState: state(),
    });
    assert.deepEqual(
      plan.changes.map((change) => [change.kind, change.path]),
      [
        ["create", "assistants/new.md"],
        ["delete", "assistants/old.md"],
        ["update", "tools/shared.yml"],
      ],
    );
    await promotionPlanApply(plan);
    await assert.rejects(
      readFile(join(fx.root, "resources/target/assistants/old.md")),
    );
    assert.equal(
      await readFile(join(fx.root, "resources/target/squads/keep.yml"), "utf8"),
      "name: keep\n",
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion includes managed dependencies and preserves markdown bodies", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/source/assistants/agent.md",
      "---\nname: Agent\nmodel:\n  toolIds: ['book ## dependency note']\nartifactPlan:\n  structuredOutputIds: ['result ## output note']\n---\n# Keep this prompt exactly\n\nNo changes.\n",
    );
    await put(
      fx.root,
      "resources/source/tools/book.yml",
      "type: function\nfunction: { name: book }\n",
    );
    await put(
      fx.root,
      "resources/source/structuredOutputs/result.yml",
      "name: Result\nschema: { type: object }\n",
    );
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**"],
      sourceState: state(),
      targetState: state(),
    });
    assert.deepEqual(
      plan.changes.map((change) => change.path),
      ["assistants/agent.md", "structuredOutputs/result.yml", "tools/book.yml"],
    );
    await promotionPlanApply(plan);
    assert.match(
      await readFile(
        join(fx.root, "resources/target/assistants/agent.md"),
        "utf8",
      ),
      /# Keep this prompt exactly\n\nNo changes\./,
    );
    assert.doesNotMatch(
      await readFile(
        join(fx.root, "resources/target/assistants/agent.md"),
        "utf8",
      ),
      /dependency note|output note/,
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion inspects TypeScript resources for managed dependencies", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/source/assistants/agent.ts",
      'export default { name: "Agent", model: { toolIds: ["book"] } };\n',
    );
    await put(
      fx.root,
      "resources/source/tools/book.yml",
      "type: function\nfunction: { name: book }\n",
    );
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**"],
      sourceState: state(),
      targetState: state(),
    });
    assert.deepEqual(
      plan.changes.map((change) => change.path),
      ["assistants/agent.ts", "tools/book.yml"],
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion honors target ignore rules for selected dependencies", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/source/assistants/agent.md",
      "---\nname: Agent\nmodel:\n  toolIds: [book]\n---\nprompt\n",
    );
    await put(fx.root, "resources/source/tools/book.yml", "type: function\n");
    await put(fx.root, "resources/target/.vapi-ignore", "tools/book\n");
    await assert.rejects(
      promotionPlanBuild({
        rootDir: fx.root,
        source: "source",
        target: "target",
        patterns: ["assistants/**"],
        sourceState: state(),
        targetState: state(),
      }),
      /ignored by target \.vapi-ignore/i,
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion canonicalizes source UUIDs and applies credential and phone policies", async () => {
  const fx = await fixture();
  try {
    const sourceTool = "11111111-1111-1111-1111-111111111111";
    const sourceCredential = "22222222-2222-2222-2222-222222222222";
    await put(
      fx.root,
      "resources/source/assistants/a.md",
      `---\nname: A\nmodel:\n  toolIds: [${sourceTool}]\n  credentialIds: [${sourceCredential}, unknown]\nserver:\n  credentialId: ${sourceCredential}\nphoneNumberIds: [source-phone, unknown-phone]\n---\nprompt\n`,
    );
    await put(fx.root, "resources/source/tools/t.yml", "type: function\n");
    await put(
      fx.root,
      ".env.source",
      "# BEGIN VAPI MANAGED BINDINGS\nVAPI_PHONE_NUMBER_MAIN=source-phone\n# END VAPI MANAGED BINDINGS\n",
    );
    await put(
      fx.root,
      ".env.target",
      "VAPI_PHONE_NUMBER_MAIN=target-phone\n\n# BEGIN VAPI MANAGED BINDINGS\n# END VAPI MANAGED BINDINGS\n",
    );
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**"],
      sourceState: state({
        tools: { t: { uuid: sourceTool } },
        credentials: { crm: { uuid: sourceCredential } },
      }),
      targetState: state({
        credentials: { crm: { uuid: "target-credential" } },
      }),
      bindings: {
        credentials: { default: "bind", aliases: { unknown: "omit" } },
        phoneNumbers: { default: "omit", aliases: { main: "bind" } },
      },
    });
    const content = plan.changes[0]?.content ?? "";
    assert.match(content, /toolIds:\n\s+- t/);
    assert.match(content, /credentialId: crm/);
    assert.match(content, /credentialIds:\n\s+- crm/);
    assert.doesNotMatch(content, /unknown/);
    assert.match(content, /phoneNumberIds:\n\s+- target-phone/);
    assert.doesNotMatch(content, new RegExp(sourceTool));
    assert.doesNotMatch(content, new RegExp(sourceCredential));
    // The entry left out of the list is named, with the file it was in.
    assert.equal(plan.warnings.length, 1);
    assert.match(
      plan.warnings[0]!,
      /^assistants\/a\.md: credentialIds entry "unknown" is left out in target \(binding policy "omit"\)/,
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion warns about a credentialIds entry it leaves out, and only then", async () => {
  const fx = await fixture();
  try {
    const sourceVoice = "33333333-3333-3333-3333-333333333333";
    await put(
      fx.root,
      "resources/source/squads/front-desk.yml",
      `name: Front Desk\nmembers: []\nmembersOverrides:\n  credentialIds: [${sourceVoice}, llm]\n  server:\n    url: https://example.com\n    credentialId: hooks\n`,
    );
    const build = (aliases: Record<string, "bind" | "omit">) =>
      promotionPlanBuild({
        rootDir: fx.root,
        source: "source",
        target: "target",
        patterns: ["squads/**"],
        sourceState: state({
          credentials: {
            voice: { uuid: sourceVoice },
            llm: { uuid: "source-llm" },
            hooks: { uuid: "source-hooks" },
          },
        }),
        targetState: state({
          credentials: {
            voice: { uuid: "target-voice" },
            llm: { uuid: "target-llm" },
            hooks: { uuid: "target-hooks" },
          },
        }),
        bindings: {
          credentials: { default: "bind", aliases },
          phoneNumbers: { default: "omit", aliases: {} },
        },
      });

    // Every entry bound: nothing to say.
    assert.deepEqual((await build({})).warnings, []);
    // A single credentialId left out is what "omit" is for: no warning.
    assert.deepEqual((await build({ hooks: "omit" })).warnings, []);
    // A list entry left out narrows what the call may use: warn, by name,
    // even though the source wrote it as a UUID.
    const plan = await build({ voice: "omit" });
    assert.match(plan.changes[0]?.content ?? "", /credentialIds:\n\s+- llm\n/);
    assert.deepEqual(plan.warnings, [
      'squads/front-desk.yml: credentialIds entry "voice" is left out in target (binding policy "omit"). Calls there can use only the keys still on the list, so that provider would run on Vapi\'s own key.',
    ]);

    // Once the target file holds the promoted content there is no change,
    // and no warning to repeat.
    await promotionPlanApply(plan);
    const again = await build({ voice: "omit" });
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.warnings, []);
  } finally {
    await fx.cleanup();
  }
});

test("promotion plan is dry until explicitly applied", async () => {
  const fx = await fixture();
  try {
    await put(fx.root, "resources/source/tools/t.yml", "type: function\n");
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["tools/**"],
      sourceState: state(),
      targetState: state(),
    });
    assert.equal(plan.changes.length, 1);
    await assert.rejects(
      readFile(join(fx.root, "resources/target/tools/t.yml")),
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion refuses an untracked empty-source wipe", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/target/assistants/agent.md",
      "---\nname: Agent\n---\nprompt\n",
    );
    await assert.rejects(
      promotionPlanBuild({
        rootDir: fx.root,
        source: "source",
        target: "target",
        patterns: ["assistants/**"],
        sourceState: state(),
        targetState: state(),
      }),
      /empty-source mirror deletion/i,
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion carries a reviewed empty-source deletion to the next org", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/target/assistants/agent.md",
      "---\nname: Agent\n---\nprompt\n",
    );
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**"],
      sourceState: state(),
      targetState: state({
        assistants: {
          agent: { uuid: "aaaaaaaa-1111-1111-1111-111111111111" },
        },
      }),
      allowEmptySourceDeletion: true,
    });

    assert.deepEqual(
      plan.changes.map((change) => [change.kind, change.path]),
      [["delete", "assistants/agent.md"]],
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotion replaces a destination UUID-suffixed file without duplicating it", async () => {
  const fx = await fixture();
  try {
    await put(
      fx.root,
      "resources/source/assistants/agent.md",
      "---\nname: Agent\n---\nnew prompt\n",
    );
    await put(
      fx.root,
      "resources/target/assistants/agent-aaaaaaaa.md",
      "---\nname: Agent\n---\nold prompt\n",
    );
    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**"],
      sourceState: state(),
      targetState: state({
        assistants: {
          "agent-aaaaaaaa": {
            uuid: "aaaaaaaa-1111-1111-1111-111111111111",
          },
        },
      }),
    });
    assert.deepEqual(
      plan.changes.map((change) => [change.kind, change.path]),
      [
        ["delete", "assistants/agent-aaaaaaaa.md"],
        ["create", "assistants/agent.md"],
      ],
    );
  } finally {
    await fx.cleanup();
  }
});

test("promote CLI dry run uses the reviewed config without writing target files", async () => {
  const fx = await fixture();
  try {
    await put(fx.root, "promotion.yml", configText);
    await put(
      fx.root,
      "state/source/state.json",
      `${JSON.stringify(state(), null, 2)}\n`,
    );
    await put(
      fx.root,
      "state/target/state.json",
      `${JSON.stringify(state(), null, 2)}\n`,
    );
    await put(fx.root, "resources/source/tools/t.yml", "type: function\n");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/promote-cmd.ts"),
        "--pipeline",
        "release",
        "--from",
        "source",
        "--to",
        "target",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, VAPI_GITOPS_ROOT: fx.root },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create\s+tools\/t.yml/);
    await assert.rejects(
      readFile(join(fx.root, "resources/target/tools/t.yml")),
    );
  } finally {
    await fx.cleanup();
  }
});

test("promotionConfigParse reads an org's optional check gate and rejects a non-slug", () => {
  const config = (check: string) =>
    `version: 1\norgs:\n  dev:\n    check: ${check}\n  prod: {}\npipelines:\n  release:\n    orgs: [dev, prod]\n    resources: ['**/*']\n`;
  let error = "";
  try {
    promotionConfigParse(config("Not A Slug"));
  } catch (caught) {
    error = (caught as Error).message;
  }
  const parsed = promotionConfigParse(config("dev-core"));
  assert.deepEqual(
    [parsed.orgs.dev?.check, parsed.orgs.prod?.check, error],
    [
      "dev-core",
      undefined,
      "org dev.check must be a check name from vapi-checks.yml",
    ],
  );
});
