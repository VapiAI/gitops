import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computePushPlan, pushBlockingFindings } from "../src/push-plan.ts";
import type { LoadedResources, ResourceType, StateFile } from "../src/types.ts";
import { VALID_RESOURCE_TYPES } from "../src/types.ts";

process.argv = ["node", "test", "preflight"];
process.env.VAPI_TOKEN = "fake";
const { validateResources } = await import("../src/validate.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = "a0000000-0000-4000-8000-000000000001";
const BAD = "An assistant name that is far longer than forty characters";

function loaded(
  files: Partial<Record<ResourceType, Record<string, object>>> = {},
): LoadedResources {
  const list = (type: ResourceType) =>
    Object.entries(files[type] ?? {}).map(([resourceId, data]) => ({
      resourceId,
      data: data as Record<string, unknown>,
      filePath: `resources/preflight/${type}/${resourceId}.yml`,
    }));
  return {
    tools: list("tools"),
    structuredOutputs: list("structuredOutputs"),
    assistants: list("assistants"),
    squads: list("squads"),
    personalities: list("personalities"),
    scenarios: list("scenarios"),
    simulations: list("simulations"),
    simulationSuites: list("simulationSuites"),
    evals: list("evals"),
  };
}

function state(): StateFile {
  return {
    tools: {},
    structuredOutputs: {},
    assistants: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
    credentials: { unused: { uuid: UUID } },
  };
}

test("plan: empty selection, all resource types, and existing dependencies", () => {
  assert.deepEqual([...computePushPlan(loaded(), loaded(), state())], []);
  const all = loaded(
    Object.fromEntries(
      VALID_RESOURCE_TYPES.map((type) => [type, { item: {} }]),
    ),
  );
  assert.equal(
    computePushPlan(all, all, state()).size,
    VALID_RESOURCE_TYPES.length,
  );
  const local = loaded({
    assistants: {
      bot: {
        model: { toolIds: ["tool", UUID] },
        artifactPlan: { structuredOutputIds: ["output"] },
      },
    },
    tools: { tool: {} },
    structuredOutputs: { output: {} },
  });
  const selected = { ...loaded(), assistants: local.assistants };
  assert.deepEqual([...computePushPlan(selected, local, state())].sort(), [
    "assistants:bot",
    "structuredOutputs:output",
    "tools:tool",
  ]);
  const tracked = state();
  tracked.tools.tool = { uuid: UUID };
  tracked.structuredOutputs.output = { uuid: UUID };
  assert.deepEqual(
    [...computePushPlan(selected, local, tracked)],
    ["assistants:bot"],
  );
});

test("plan: squad auto-applied assistant errors block, including existing assistants updated for new dependencies", () => {
  const local = loaded({
    squads: { team: { members: [{ assistantId: "bot" }] } },
    assistants: { bot: { name: BAD, model: { toolIds: ["tool"] } } },
    tools: { tool: {} },
  });
  const selected = { ...loaded(), squads: local.squads };
  const tracked = state();
  for (const existing of [false, true]) {
    if (existing) tracked.assistants.bot = { uuid: UUID };
    const plan = computePushPlan(selected, local, tracked);
    assert.ok(plan.has("assistants:bot"));
    assert.ok(plan.has("tools:tool"));
    assert.equal(
      pushBlockingFindings(validateResources(local), plan, false).length,
      1,
    );
  }
  tracked.tools.tool = { uuid: UUID };
  assert.deepEqual(
    [...computePushPlan(selected, local, tracked)],
    ["squads:team"],
  );
  assert.equal(
    pushBlockingFindings(validateResources(local), new Set(), true).length,
    1,
  );
  assert.deepEqual(pushBlockingFindings([], new Set(), false), []);
});

async function runFixture(options: {
  scoped?: boolean;
  dryRun?: boolean;
  credential?: boolean;
  strict?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "push-preflight-"));
  const mutations: string[] = [];
  const good = { id: UUID, name: "Good" };
  const bad = {
    id: "b0000000-0000-4000-8000-000000000002",
    name: options.credential ? "Bad" : BAD,
    ...(options.credential
      ? { server: { url: "https://example.com", credentialId: "missing" } }
      : {}),
  };
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    if (["POST", "PATCH", "DELETE"].includes(method))
      mutations.push(`${method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    const path = req.url?.split("?")[0];
    res.end(
      JSON.stringify(
        path === "/assistant"
          ? [good, bad]
          : path?.startsWith("/assistant/")
            ? good
            : [],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const folder = join(dir, "resources/preflight/assistants");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "good.yml"), "name: Good\n");
    writeFileSync(
      join(folder, "zbad.yml"),
      `name: ${bad.name}\n${options.credential ? "server:\n  url: https://example.com\n  credentialId: missing\n" : ""}`,
    );
    const initial = state();
    initial.assistants.good = { uuid: good.id };
    initial.assistants.zbad = { uuid: bad.id };
    writeFileSync(
      join(dir, ".vapi-state.preflight.json"),
      JSON.stringify(initial),
    );
    writeFileSync(
      join(dir, ".env.preflight"),
      `VAPI_TOKEN=fake\nVAPI_BASE_URL=http://127.0.0.1:${addr.port}\n`,
    );
    const args = ["--import", "tsx", "src/push.ts", "preflight"];
    if (options.scoped) args.push("resources/preflight/assistants/good.yml");
    if (options.dryRun) args.push("--dry-run");
    if (options.strict) args.push("--strict");
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: dir,
          env: {
            ...process.env,
            VAPI_TOKEN: "fake",
            VAPI_BASE_URL: `http://127.0.0.1:${addr.port}`,
          },
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      },
    );
    return { ...result, mutations };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, options] of [
  ["full push", {}],
  ["dry-run", { dryRun: true }],
  ["unresolved credential", { credential: true }],
  ["strict scoped push", { scoped: true, strict: true }],
] as const) {
  test(`preflight blocks ${label} before any mutation`, async () => {
    const result = await runFixture(options);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Nothing was written to the remote API/);
    assert.deepEqual(result.mutations, []);
    if ("credential" in options)
      assert.match(result.output, /unresolved-credential/);
  });
}

test("scoped valid push writes despite unrelated validation error", async () => {
  const result = await runFixture({ scoped: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.mutations, [`PATCH /assistant/${UUID}`]);
  assert.match(result.output, /outside the push plan/);
});
