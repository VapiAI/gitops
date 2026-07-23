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
import { promotionApplyArguments } from "../src/promote-cmd.ts";
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
  } finally {
    await fx.cleanup();
  }
});

test("promotion comparison canonicalizes both orgs and ignores terminal Markdown newlines", async () => {
  const fx = await fixture();
  try {
    const sourceAssistant = "11111111-1111-4111-8111-111111111111";
    const targetAssistant = "22222222-2222-4222-8222-222222222222";
    await put(
      fx.root,
      "resources/source/squads/relay.yml",
      `members:\n  - assistantId: ${sourceAssistant}\n`,
    );
    await put(
      fx.root,
      "resources/target/squads/relay.yml",
      `members:\n  - assistantId: ${targetAssistant}\n`,
    );
    await put(
      fx.root,
      "resources/source/assistants/agent.md",
      "---\nname: Agent\n---\n# Prompt\n",
    );
    await put(
      fx.root,
      "resources/target/assistants/agent.md",
      "---\nname: Agent\n---\n# Prompt\n\n",
    );

    const plan = await promotionPlanBuild({
      rootDir: fx.root,
      source: "source",
      target: "target",
      patterns: ["assistants/**", "squads/**"],
      sourceState: state({
        assistants: { agent: { uuid: sourceAssistant } },
      }),
      targetState: state({
        assistants: { agent: { uuid: targetAssistant } },
      }),
    });

    assert.deepEqual(plan.changes, []);
  } finally {
    await fx.cleanup();
  }
});

test("promotion apply arguments reflect only reviewed plan actions", () => {
  assert.deepEqual(
    promotionApplyArguments(
      {
        rootDir: "/tmp",
        target: "target",
        changes: [
          { kind: "update", path: "assistants/existing.md", content: "x" },
        ],
      },
    ),
    ["--resolve=ours", "resources/target/assistants/existing.md"],
  );

  const createArgs = promotionApplyArguments(
    {
      rootDir: "/tmp",
      target: "target",
      changes: [{ kind: "create", path: "tools/new.yml", content: "x" }],
    },
  );
  assert.ok(createArgs.includes("--allow-new-files"));
  assert.ok(!createArgs.includes("--force"));

  const deleteArgs = promotionApplyArguments(
    {
      rootDir: "/tmp",
      target: "target",
      changes: [{ kind: "delete", path: "tools/old.yml" }],
    },
  );
  assert.ok(deleteArgs.includes("--force"));
  assert.ok(!deleteArgs.includes("--allow-new-files"));
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
      ".vapi-state.source.json",
      `${JSON.stringify(state(), null, 2)}\n`,
    );
    await put(
      fx.root,
      ".vapi-state.target.json",
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
