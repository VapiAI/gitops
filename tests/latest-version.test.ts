import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { hashPayload } from "../src/state-serialize.ts";
import {
  assistantFile,
  assistantPayload,
  engineRepoCreate,
  filesWrite,
  stateFile,
} from "./blocks-helpers.ts";

const exec = promisify(execFile);

type Payload = Record<string, unknown>;
type Stored = Payload & { id: string; orgId: string };

async function fixture(
  t: TestContext,
  files: Record<string, string>,
  resources: Record<string, Stored[]>,
) {
  const root = engineRepoCreate({
    ...files,
    "loopback-only.mjs": `
      const fetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (new URL(input instanceof Request ? input.url : input).origin !== process.env.FIXTURE_API_ORIGIN)
          throw new Error("GitOps fixture tried to reach a non-stub URL");
        return fetch(input, { ...init, redirect: "error" });
      };
    `,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writes: Array<{ method: string; path: string; data: Payload }> = [];
  const server = createServer(async (req, res) => {
    const method = req.method!;
    const path = new URL(req.url!, "http://localhost").pathname;
    const [, type, id, subresource] = path.split("/");
    const records = resources[type!] ?? [];
    const existing = records.find((record) => record.id === id);
    res.setHeader("content-type", "application/json");
    if (method === "GET") {
      if (!resources[type!]) {
        res.end("[]");
        return;
      }
      if (id && !existing) res.statusCode = 404;
      res.end(JSON.stringify(id ? (existing ?? {}) : records));
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const data = JSON.parse(body) as Payload;
    writes.push({ method, path, data });
    if (subresource === "versions") {
      res.end("{}");
      return;
    }
    const record = {
      ...existing,
      ...data,
      id: id ?? `created-${type}`,
      orgId: "org-test",
      latestVersion: "v-published",
    };
    if (existing) Object.assign(existing, record);
    else records.push(record);
    res.end(JSON.stringify(record));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cli = async (script: string, ...args: string[]) => {
    const options = {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(root, "loopback-only.mjs"))}`,
        FIXTURE_API_ORIGIN: baseUrl,
        VAPI_PRIVATE_API_KEY: "test-key",
        VAPI_BASE_URL: baseUrl,
        VAPI_GITOPS_ORG_PIN: "off",
        VAPI_GITOPS_ACTOR: "fixture-actor",
        VAPI_PROMOTION_TOKENS: JSON.stringify({
          dev: "test-key",
          prod: "test-key",
        }),
      },
      timeout: 30_000,
    };
    try {
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--import", "tsx", `src/${script}-cmd.ts`, ...args],
        options,
      );
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as {
        code: number;
        stdout: string;
        stderr: string;
      };
      return { code, output: stdout + stderr };
    }
  };
  return {
    root,
    baseUrl,
    cli,
    writes,
    read: (path: string) => readFileSync(join(root, path), "utf8"),
  };
}

for (const extension of ["yml", "ts"]) {
  test(`handoff linking respects drift and stores a stripped baseline (${extension})`, async (t) => {
    const intakeId = "00000000-0000-4000-8000-000000000001";
    const otherId = "00000000-0000-4000-8000-000000000002";
    const tool = {
      type: "handoff",
      function: { name: "handoff", description: "Base description." },
      destinations: [{ type: "assistant", assistantId: "intake" }],
    };
    const state = {
      ...JSON.parse(stateFile({ intake: intakeId, other: otherId })),
      tools: { handoff: { uuid: "tool-id" } },
    };
    const baselinePath = "state/dev/local/baselines/tool-id";
    const baseline = hashPayload({ ...tool, latestVersion: "v1" });
    const local = {
      ...tool,
      destinations: [{ type: "assistant", assistantId: "other" }],
    };
    const dashboard = {
      ...tool,
      id: "tool-id",
      orgId: "org-test",
      latestVersion: "v2",
      function: { ...tool.function, description: "Dashboard edit." },
      destinations: [{ type: "assistant", assistantId: intakeId }],
    };
    const path = `resources/dev/tools/handoff.${extension}`;
    const config = { ...local, latestVersion: "v1" };
    const loadMarker = "handoff-loaded";
    const f = await fixture(
      t,
      {
        "state/dev/state.json": JSON.stringify(state),
        [baselinePath]: baseline,
        [path]:
          extension === "ts"
            ? `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(loadMarker)}, "loaded\\n");\nexport default ${JSON.stringify(config)};\n`
            : stringify(config),
      },
      { tool: [dashboard] },
    );
    if (extension === "ts") {
      await f.cli("audit", "dev", "--type", "tools");
      assert.equal(existsSync(join(f.root, loadMarker)), false);
    }
    const { code, output } = await f.cli("push", "dev", path);
    assert.equal(code, 1, output);
    assert.match(output, /drift detected on tool handoff \[both-diverged\]/);
    assert.deepEqual(f.writes.slice(), [], output);
    assert.equal(f.read(baselinePath).trim(), baseline);

    dashboard.function = tool.function;
    const allowed = await f.cli("push", "dev", path);
    assert.equal(allowed.code, 0, allowed.output);
    assert.equal(f.writes.length, 2, allowed.output);
    assert.deepEqual(f.writes.at(-1)?.data, {
      destinations: [{ type: "assistant", assistantId: otherId }],
    });
    assert.match(
      allowed.output,
      /Linking tool handoff to assistant destinations/,
    );
    assert.equal(f.read(baselinePath).trim(), hashPayload(local));
    if (extension === "ts") {
      assert.equal(f.read(loadMarker), "loaded\nloaded\n");
    }
  });
}

for (const mode of ["legacy", "normalized", "edited"]) {
  test(`adoption still checks versioned aliases for real edits (${mode})`, async (t) => {
    const uuid = "aaaaaaaa-0000-4000-8000-000000000000";
    const file = "resources/dev/assistants/riley.md";
    const alias = "resources/dev/assistants/riley-aaaaaaaa.md";
    const {
      id: _id,
      orgId: _orgId,
      ...config
    } = assistantPayload(uuid, "riley", "Base.");
    const content = assistantFile(
      "riley",
      mode === "edited" ? "Local edit." : "Base.",
    ).replace("name:", "latestVersion: v1\nname:");
    const f = await fixture(
      t,
      {
        "state/dev/state.json": stateFile({ "riley-aaaaaaaa": uuid }),
        [`state/dev/local/baselines/${uuid}`]: hashPayload(
          mode === "legacy" ? { ...config, latestVersion: "v1" } : config,
        ),
        [file]: assistantFile("riley", "Base."),
        [alias]: content,
      },
      {
        assistant: [
          { ...assistantPayload(uuid, "riley", "Base."), latestVersion: "v2" },
        ],
      },
    );
    const { code, output } = await f.cli(
      "push",
      "dev",
      "--dry-run",
      "--adopt",
      "riley",
      file,
    );
    assert.equal(code, mode === "edited" ? 1 : 0, output);
    assert.match(
      output,
      mode === "edited"
        ? /local edits or no baseline/
        : /would delete .*riley-aaaaaaaa\.md/,
    );
    assert.equal(f.read(alias), content);
    assert.deepEqual(f.writes, []);
  });
}

for (const mode of ["apply", "promote"]) {
  test(`${mode} strips the pointer on creates and updates but preserves nested config`, async (t) => {
    const org = mode === "apply" ? "dev" : "prod";
    const oldTool = {
      type: "function",
      function: {
        name: "existing_tool",
        description: "Before.",
        parameters: {
          type: "object",
          properties: { latestVersion: { type: "string" } },
        },
      },
    };
    const oldAssistant = {
      name: "Existing Assistant",
      model: { provider: "openai", model: "gpt-4o" },
      firstMessage: "Before.",
      metadata: { latestVersion: "authored" },
    };
    const oldSquad = {
      name: "Existing Squad",
      members: [
        {
          assistantId: "existing-assistant",
          assistantOverrides: { variableValues: { latestVersion: "authored" } },
        },
      ],
    };
    const endpoints = [
      [
        "tool",
        "tools",
        oldTool,
        {
          ...oldTool,
          function: { ...oldTool.function, description: "After." },
        },
        { ...oldTool, function: { ...oldTool.function, name: "new_tool" } },
      ],
      [
        "assistant",
        "assistants",
        oldAssistant,
        { ...oldAssistant, firstMessage: "After." },
        { ...oldAssistant, name: "New Assistant" },
      ],
      [
        "squad",
        "squads",
        oldSquad,
        { ...oldSquad, name: "Updated Squad" },
        { ...oldSquad, name: "New Squad" },
      ],
    ] as const;
    const files: Record<string, string> = {};
    const resources: Record<string, Stored[]> = {
      credential: [
        {
          id: "cred-uuid-unused",
          orgId: "org-test",
          name: "unused-credential",
        },
      ],
    };
    const state = JSON.parse(stateFile({}));
    for (const [endpoint, type, before, update, create] of endpoints) {
      const id = `existing-${endpoint}`;
      state[type] = { [id]: { uuid: id } };
      resources[endpoint] = [
        { ...before, id, orgId: "org-test", latestVersion: "v-live" },
      ];
      const base = `resources/${org}/${type}`;
      if (mode === "promote") files[`${base}/${id}.yml`] = stringify(before);
      files[`resources/dev/${type}/${id}.yml`] = stringify({
        ...update,
        latestVersion: "v-file",
      });
      files[`resources/dev/${type}/new-${endpoint}.yml`] = stringify({
        ...create,
        latestVersion: "v-file",
      });
    }
    files[`state/${org}/state.json`] = JSON.stringify(state);
    const f = await fixture(t, files, resources);

    let args = ["dev", "--allow-new-files"];
    if (mode === "promote") {
      await exec("git", ["init", "--quiet"], { cwd: f.root });
      filesWrite(f.root, {
        "state/dev/state.json": "{}",
        "promotion.yml": stringify({
          version: 1,
          orgs: { dev: { baseUrl: f.baseUrl }, prod: { baseUrl: f.baseUrl } },
          pipelines: {
            release: { orgs: ["dev", "prod"], resources: ["**/*"] },
          },
        }),
      });
      args = [
        "--pipeline",
        "release",
        "--from",
        "dev",
        "--to",
        "prod",
        "--apply",
      ];
    }
    const result = await f.cli(mode, ...args);
    assert.equal(result.code, 0, result.output);

    for (const [endpoint, , , update, create] of endpoints) {
      for (const [method, path, desired] of [
        ["PATCH", `/${endpoint}/existing-${endpoint}`, update],
        ["POST", `/${endpoint}`, create],
      ] as const) {
        const request = f.writes.find(
          (w) => w.method === method && w.path === path,
        );
        assert.ok(request, result.output);
        assert.ok(
          !Object.hasOwn(request.data, "latestVersion"),
          JSON.stringify(request),
        );
        const nestedKey =
          endpoint === "tool"
            ? "function"
            : endpoint === "assistant"
              ? "metadata"
              : "members";
        const nested = (desired as Payload)[nestedKey];
        if (endpoint === "assistant") {
          assert.equal(
            (request.data.metadata as Payload).latestVersion,
            (nested as Payload).latestVersion,
          );
        } else {
          assert.deepEqual(request.data[nestedKey], nested);
        }
      }
    }
    const labels = f.writes.filter(({ path }) =>
      path.endsWith("/versions/v-published"),
    );
    assert.equal(labels.length, 2, result.output);
    assert.ok(
      labels.every(({ data }) =>
        String(data.versionName).includes("fixture-actor"),
      ),
    );
    assert.doesNotMatch(f.read(`state/${org}/state.json`), /latestVersion/);
    const pulled = await f.cli("pull", org);
    assert.equal(pulled.code, 0, pulled.output);
    for (const [endpoint, type] of endpoints) {
      const config = parse(
        f.read(`resources/${org}/${type}/existing-${endpoint}.yml`),
      ) as Payload;
      assert.ok(!Object.hasOwn(config, "latestVersion"));
      assert.match(JSON.stringify(config), /"latestVersion"/);
    }
  });
}

for (const layout of ["legacy", "state directory"]) {
  test(`version pointers and old baselines across pull, audit and push (${layout})`, async (t) => {
    const statePath =
      layout === "legacy" ? ".vapi-state.dev.json" : "state/dev/state.json";
    const baselineDir =
      layout === "legacy"
        ? ".vapi-state-hash/dev"
        : "state/dev/local/baselines";
    const cases = [
      { id: "advance", baseline: "v1", local: "v1", remote: "v2" },
      { id: "rollback", baseline: "v2", local: "v2", remote: "v1" },
      {
        id: "local",
        baseline: "v1",
        local: "v1",
        remote: "v2",
        localBody: "Local.",
      },
      {
        id: "dashboard",
        baseline: "v1",
        local: "v1",
        remote: "v2",
        remoteBody: "Remote.",
      },
      {
        id: "conflict",
        baseline: "v1",
        local: "v1",
        remote: "v2",
        localBody: "Local.",
        remoteBody: "Remote.",
      },
      { id: "ambiguous", baseline: "v1", remote: "v2", localBody: "Local." },
      { id: "block", baseline: "v1", local: "v1", remote: "v2", block: true },
      { id: "normalized", remote: "v2", localBody: "Local." },
    ];
    const config = (id: string, body: string, version?: string) => {
      const { id: _id, orgId: _org, ...data } = assistantPayload(id, id, body);
      return version === undefined ? data : { ...data, latestVersion: version };
    };
    const filePath = (id: string) => `resources/dev/assistants/${id}.md`;
    const original = Object.fromEntries(
      cases.map((c) => [
        c.id,
        assistantFile(
          c.id,
          c.block ? "@include shared" : (c.localBody ?? "Base."),
        ).replace(
          "name:",
          c.local ? `latestVersion: ${c.local}\nname:` : "name:",
        ),
      ]),
    );
    const baselines = Object.fromEntries(
      cases.map((c) => [c.id, hashPayload(config(c.id, "Base.", c.baseline))]),
    );
    const remote = cases.map((c) => ({
      ...assistantPayload(c.id, c.id, c.remoteBody ?? "Base."),
      latestVersion: c.remote,
    }));
    const f = await fixture(
      t,
      {
        [statePath]: stateFile(
          Object.fromEntries(cases.map(({ id }) => [id, id])),
        ),
        "templates/blocks/shared.md": "Base.",
        ...Object.fromEntries(
          cases.map(({ id }) => [filePath(id), original[id]!]),
        ),
        ...Object.fromEntries(
          cases.map(({ id }) => [`${baselineDir}/${id}`, `${baselines[id]}\n`]),
        ),
      },
      {
        assistant: remote,
        credential: [
          {
            id: "cred-uuid-unused",
            orgId: "org-test",
            name: "unused-credential",
          },
        ],
      },
    );

    await t.test(
      "audit distinguishes config edits from version movement",
      async () => {
        const { output } = await f.cli("audit", "dev", "--type", "assistants");
        const directions = Object.fromEntries(
          [
            ...output.matchAll(
              /\[content-drift\] assistants\/(\S+)\n\s+[^\n]+ \[(local-ahead|dashboard-ahead|both-diverged)\]/g,
            ),
          ].map(([, id, direction]) => [id, direction]),
        );
        assert.deepEqual(
          directions,
          {
            ambiguous: "both-diverged",
            conflict: "both-diverged",
            dashboard: "dashboard-ahead",
            local: "local-ahead",
            normalized: "local-ahead",
          },
          output,
        );
      },
    );

    await t.test(
      "push gates real and ambiguous conflicts and accepts a proven local edit",
      async () => {
        const { code, output } = await f.cli(
          "push",
          "dev",
          ...["local", "dashboard", "conflict", "ambiguous"].map(filePath),
        );
        assert.equal(code, 0, output);
        for (const [id, direction] of [
          ["dashboard", "dashboard-ahead"],
          ["conflict", "both-diverged"],
          ["ambiguous", "both-diverged"],
        ]) {
          assert.ok(
            output.includes(`drift detected on assistant ${id} [${direction}]`),
            output,
          );
        }
        assert.deepEqual(
          f.writes.map(({ path }) => path),
          ["/assistant/local", "/assistant/local/versions/v-published"],
          output,
        );
        assert.doesNotMatch(JSON.stringify(f.writes[0]?.data), /latestVersion/);
        assert.match(
          String(f.writes[1]?.data.versionDescription),
          /Changed: [^\n]*\bmodel\.messages\b/,
        );
        assert.equal(
          f.read(`${baselineDir}/local`).trim(),
          hashPayload(config("local", "Local.")),
        );
      },
    );

    await t.test(
      "pull accepts real dashboard edits and keeps conflicts and block markers",
      async () => {
        const { code, output } = await f.cli(
          "pull",
          "dev",
          "--type",
          "assistants",
        );
        assert.equal(code, 1, output);
        assert.match(output, /2 resource\(s\) have 3-way drift/);
        assert.doesNotMatch(output, /block.*dashboard version differs/);
        for (const id of ["advance", "rollback", "dashboard"]) {
          assert.doesNotMatch(f.read(filePath(id)), /^latestVersion:/m, output);
        }
        assert.match(f.read(filePath("dashboard")), /Remote\./);
        for (const id of ["ambiguous", "conflict", "block", "normalized"]) {
          assert.equal(f.read(filePath(id)), original[id]);
        }
        for (const id of ["ambiguous", "conflict"]) {
          assert.equal(f.read(`${baselineDir}/${id}`).trim(), baselines[id]);
        }
        for (const id of ["advance", "rollback", "block"]) {
          assert.equal(
            f.read(`${baselineDir}/${id}`).trim(),
            hashPayload(config(id, "Base.")),
          );
        }
        assert.doesNotMatch(f.read(statePath), /latestVersion/);
      },
    );

    await t.test(
      "automatic push bootstrap keeps unresolved baseline evidence",
      async () => {
        const state = JSON.parse(f.read(statePath));
        filesWrite(f.root, {
          [statePath]: JSON.stringify({ ...state, credentials: {} }),
        });
        f.writes.length = 0;
        const { code, output } = await f.cli(
          "push",
          "dev",
          filePath("ambiguous"),
        );
        assert.match(output, /Bootstrap state sync required/);
        assert.equal(code, 1, output);
        assert.match(
          output,
          /drift detected on assistant ambiguous \[both-diverged\]/,
        );
        assert.deepEqual(f.writes, []);
        assert.equal(
          f.read(`${baselineDir}/ambiguous`).trim(),
          baselines.ambiguous,
        );
      },
    );
  });
}
