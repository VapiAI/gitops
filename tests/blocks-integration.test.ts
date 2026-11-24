import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assistantFile,
  assistantPayload,
  cliRun,
  engineRepoCreate,
  stateFile,
  stubStart,
} from "./blocks-helpers.ts";

const ORG = "block-integration";
const UUID = "aaaaaaaa-1111-4111-8111-111111111111";

function scriptRun(root: string, script: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      process.argv = ["node", "test", "${ORG}"];
      process.env.VAPI_TOKEN = "fake";
      ${script}
    `,
    ],
    {
      cwd: root,
      env: { ...process.env },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("adoption expands block aliases before comparing baselines and refuses unsafe aliases", () => {
  const root = engineRepoCreate({
    "templates/blocks/greeting.md": "Hello.",
    [`resources/${ORG}/assistants/alias.md`]: assistantFile(
      "Triage",
      "@include greeting",
    ),
  });
  try {
    scriptRun(
      root,
      `
      const { existsSync, writeFileSync, unlinkSync } = await import("node:fs");
      const { prepareAliasCleanup } = await import("./src/adopt-alias-files.ts");
      const { writeBaseline, readBaseline } = await import("./src/hash-store.ts");
      const { canonicalizeForHash } = await import("./src/canonical.ts");
      const { hashPayload } = await import("./src/state-serialize.ts");
      const { createEmptyState } = await import("./src/state.ts");
      const { RESOURCES_DIR } = await import("./src/config.ts");
      const path = RESOURCES_DIR + "/assistants/alias.md";
      const resources = Object.fromEntries(Object.keys(createEmptyState()).filter(k => k !== "credentials").map(k => [k, []]));
      resources.assistants.push({ resourceId: "alias", filePath: path, data: {} });
      const aliases = [{ type: "assistants", resourceId: "alias", uuid: "${UUID}", adoptedAs: "triage" }];
      const hash = hashPayload(canonicalizeForHash(${JSON.stringify(assistantPayload(UUID, "Triage", "Hello."))}, createEmptyState(), new Map(), "assistants"));
      assert.deepEqual((await prepareAliasCleanup([], resources)).problems, []);
      assert.equal((await prepareAliasCleanup(aliases, resources)).problems.length, 1);
      await writeBaseline("${ORG}", "${UUID}", hash);
      writeFileSync("templates/blocks/greeting.md", "Edited locally.");
      assert.equal((await prepareAliasCleanup(aliases, resources)).problems.length, 1);
      assert.ok(existsSync(path));
      unlinkSync("templates/blocks/greeting.md");
      assert.equal((await prepareAliasCleanup(aliases, resources)).problems.length, 1);
      assert.ok(existsSync(path));
      writeFileSync("templates/blocks/greeting.md", "Hello.");
      const cleanup = await prepareAliasCleanup(aliases, resources);
      assert.deepEqual(cleanup.problems, []);
      await cleanup.run();
      assert.equal(existsSync(path), false);
      assert.deepEqual(resources.assistants, []);
      assert.equal(readBaseline("${ORG}", "${UUID}"), undefined);
    `,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local hashes expand blocks and ignore folder metadata only for assistants", () => {
  const data = {
    name: "Triage",
    model: { messages: [{ role: "system", content: "@include greeting" }] },
    metadata: {
      folderPath: "user",
      gitops: { owner: "repo", folderPath: "old" },
    },
  };
  const root = engineRepoCreate({
    "templates/blocks/greeting.md": "Hello.",
    [`resources/${ORG}/assistants/support/triage.yml`]: JSON.stringify(data),
    [`resources/${ORG}/squads/triage.yml`]: JSON.stringify(data),
    [`resources/${ORG}/assistants/empty.yml`]: "{}",
    [`resources/${ORG}/assistants/broken.md`]: assistantFile(
      "Broken",
      "@include missing",
    ),
  });
  try {
    scriptRun(
      root,
      `
      const { hashLocalResource } = await import("./src/resources.ts");
      const { hashPayload } = await import("./src/state-serialize.ts");
      const expanded = ${JSON.stringify({ ...data, model: { messages: [{ role: "system", content: "Hello." }] } })};
      assert.equal(hashLocalResource("squads", "triage"), hashPayload(expanded));
      delete expanded.metadata.gitops.folderPath;
      assert.equal(hashLocalResource("assistants", "support/triage"), hashPayload(expanded));
      assert.equal(hashLocalResource("assistants", "empty"), hashPayload({}));
      assert.equal(hashLocalResource("assistants", "missing"), null);
      assert.equal(hashLocalResource("assistants", "broken"), null);
    `,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated pull of a subfolder block assistant ignores derived folder metadata", async () => {
  const path = `resources/${ORG}/assistants/support/triage.md`;
  const authored = assistantFile("Triage", "@include greeting");
  const root = engineRepoCreate({
    "templates/blocks/greeting.md": "Hello.",
    [path]: authored,
    [`state/${ORG}/state.json`]: stateFile({ "support/triage": UUID }),
  });
  const stub = await stubStart([
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: [
        {
          ...assistantPayload(UUID, "Triage", "Hello."),
          metadata: { gitops: { folderPath: "support" } },
        },
      ],
    },
  ]);
  try {
    for (let i = 0; i < 2; i++) {
      const result = cliRun(root, "src/pull.ts", [ORG], stub.port);
      assert.equal(result.code, 0, result.output);
      assert.match(
        result.output,
        /support\/triage \(uses blocks, matches the dashboard/,
      );
      assert.doesNotMatch(
        result.output,
        /support\/triage:|support\/triage \(local ahead/,
      );
      assert.equal(readFileSync(join(root, path), "utf8"), authored);
      assert.deepEqual(
        readdirSync(join(root, `resources/${ORG}/assistants/support`)),
        ["triage.md"],
      );
    }
  } finally {
    await stub.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("block-expanded undefined variables block strict validate and push before mutations", async () => {
  const tracked = JSON.parse(stateFile({ triage: UUID }));
  tracked.squads.team = { uuid: "bbbbbbbb-2222-4222-8222-222222222222" };
  const root = engineRepoCreate({
    "templates/blocks/greeting.md": "Welcome to {{practice}}.",
    [`resources/${ORG}/assistants/triage.md`]: assistantFile(
      "Triage",
      "@include greeting",
    ),
    [`resources/${ORG}/squads/team.yml`]:
      "name: Team\nmembers:\n  - assistantId: triage\n",
    [`state/${ORG}/state.json`]: JSON.stringify(tracked),
  });
  const assistant = assistantPayload(
    UUID,
    "Triage",
    "Welcome to {{practice}}.",
  );
  const squad = {
    id: tracked.squads.team.uuid,
    name: "Team",
    members: [{ assistantId: UUID }],
  };
  const stub = await stubStart([
    { method: "GET", pathStartsWith: `/assistant/${UUID}`, body: assistant },
    { method: "GET", pathStartsWith: "/assistant", body: [assistant] },
    { method: "GET", pathStartsWith: `/squad/${squad.id}`, body: squad },
    { method: "GET", pathStartsWith: "/squad", body: [squad] },
  ]);
  try {
    for (const strict of [false, true]) {
      const result = cliRun(
        root,
        "src/validate-cmd.ts",
        [ORG, ...(strict ? ["--strict"] : [])],
        stub.port,
      );
      assert.equal(result.code, strict ? 1 : 0, result.output);
      assert.match(result.output, /variable-undefined/);
    }
    const advisory = cliRun(root, "src/push.ts", [ORG, "--dry-run"], stub.port);
    assert.equal(advisory.code, 0, advisory.output);
    assert.match(advisory.output, /variable-undefined/);
    for (const flags of [
      [],
      ["--dry-run"],
      [`resources/${ORG}/assistants/triage.md`],
    ]) {
      const result = cliRun(
        root,
        "src/push.ts",
        [ORG, "--strict", ...flags],
        stub.port,
      );
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /variable-undefined/);
      assert.match(result.output, /Nothing was written to the remote API/);
    }
    assert.deepEqual(
      (await stub.requests()).filter((request) =>
        /^(POST|PATCH|DELETE) /.test(request),
      ),
      [],
    );
  } finally {
    await stub.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("block integrations do not restore the removed recanonicalize module", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  assert.equal(existsSync(join(src, "recanonicalize.ts")), false);
  for (const file of readdirSync(src).filter((file) => file.endsWith(".ts"))) {
    const code = readFileSync(join(src, file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(
      code,
      /recanonicalizeStateKeys|formatRecanonicalizeReport|["\x27].*recanonicalize\.ts["\x27]/,
      file,
    );
  }
});
