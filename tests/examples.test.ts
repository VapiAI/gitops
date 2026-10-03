import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checksConfigParse } from "../src/check-config.ts";
import { checkPayloadBuild } from "../src/check-payload.ts";
import { promotionStateParse } from "../src/promotion.ts";
import { orgResourcesRead } from "../src/resource-parse.ts";

// The examples are what new users copy, so they must be valid: every org
// under examples/ passes `validate` and meets the API's minimum fields, the
// starter's PR check builds cleanly, and every doc snippet that names an
// example file is that file, byte for byte.

const REPO = fileURLToPath(new URL("..", import.meta.url));

// Every examples/<example>/resources/<org>/ directory.
function exampleOrgs(): Array<{ root: string; org: string }> {
  const orgs: Array<{ root: string; org: string }> = [];
  for (const example of readdirSync(join(REPO, "examples"))) {
    const resources = join(REPO, "examples", example, "resources");
    if (!existsSync(resources)) continue;
    for (const org of readdirSync(resources))
      orgs.push({ root: join(REPO, "examples", example), org });
  }
  return orgs;
}

function validateRun(
  resourcesDir: string,
  org: string,
): { code: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "vapi-examples-"));
  try {
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    mkdirSync(join(dir, "resources"));
    cpSync(resourcesDir, join(dir, "resources", org), { recursive: true });
    writeFileSync(join(dir, `.env.${org}`), "VAPI_TOKEN=fake-token-not-used\n");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/validate-cmd.ts", org],
      { cwd: dir, encoding: "utf8", timeout: 30_000 },
    );
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every example org passes validate", () => {
  const results = exampleOrgs().map(({ root, org }) => {
    const run = validateRun(join(root, "resources", org), org);
    return [org, run.code, run.code === 0 ? "" : run.output];
  });
  assert.deepEqual(
    results,
    results.map(([org]) => [org, 0, ""]),
  );
});

test("every example simulation resource has the fields the API requires", async () => {
  const problems: string[] = [];
  for (const { root, org } of exampleOrgs()) {
    const resources = await orgResourcesRead(root, org, { ignorePatterns: [] });
    for (const resource of resources.values()) {
      const at = `${org}/${resource.type}/${resource.id}`;
      const data = resource.data;
      if (
        resource.type === "personalities" &&
        typeof data.assistant !== "object"
      )
        problems.push(`${at}: needs an assistant`);
      if (resource.type === "scenarios") {
        if (typeof data.instructions !== "string" || data.instructions === "")
          problems.push(`${at}: needs instructions`);
        if (!Array.isArray(data.evaluations) || data.evaluations.length === 0)
          problems.push(`${at}: needs at least one evaluation`);
      }
      if (
        resource.type === "simulations" &&
        (!data.personalityId || !data.scenarioId)
      )
        problems.push(`${at}: needs personalityId and scenarioId`);
      if (
        resource.type === "simulationSuites" &&
        !Array.isArray(data.simulationIds)
      )
        problems.push(`${at}: needs simulationIds`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the starter example's PR check builds with no errors or warnings", async () => {
  const root = join(REPO, "examples/starter");
  const check = checksConfigParse(
    readFileSync(join(root, "vapi-checks.yml"), "utf8"),
  ).checks.core!;
  const state = promotionStateParse(
    readFileSync(join(root, ".vapi-state.starter.json"), "utf8"),
  );
  const result = checkPayloadBuild({
    check,
    target: check.targets[0]!,
    resources: await orgResourcesRead(root, "starter"),
    sourceState: state,
    runState: state,
  });
  assert.deepEqual(
    [result.errors, result.warnings, result.body?.simulations.length],
    [[], [], 1],
  );
});

// A fenced block whose first line is `# examples/<path>` (or
// `<!-- examples/<path> -->` in Markdown) must be that file exactly.
const SNIPPET_RE =
  /```[a-z]*\n(?:# |<!-- )(examples\/[^\s]+?)(?: -->)?\n([\s\S]*?)```/g;

function markdownFiles(): string[] {
  const files = ["README.md"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  return files;
}

test("doc snippets that name an example file match it exactly", () => {
  const snippets: Array<[string, string]> = [];
  const mismatched: string[] = [];
  for (const file of markdownFiles()) {
    for (const match of readFileSync(join(REPO, file), "utf8").matchAll(
      SNIPPET_RE,
    )) {
      const [, path, body] = match;
      snippets.push([file, path!]);
      const target = join(REPO, path!);
      if (!existsSync(target))
        mismatched.push(`${file}: ${path} does not exist`);
      else if (readFileSync(target, "utf8") !== body)
        mismatched.push(`${file}: snippet differs from ${path}`);
    }
  }
  assert.ok(
    snippets.length > 0,
    "expected at least one example snippet in the docs",
  );
  assert.deepEqual(mismatched, []);
});
