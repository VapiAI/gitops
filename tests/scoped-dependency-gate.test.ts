import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "test-dep-gate";
const TOOL = "67aea057-1111-4111-8111-111111111111";
const ASSISTANT = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATED = "bbbbbbbb-2222-4222-8222-222222222222";
const SQUAD = "cccccccc-3333-4333-8333-333333333333";

for (const mode of [
  "unscoped",
  "scoped",
  "scoped-short",
  "dry-run",
  "json",
  "type",
  "allow",
  "allow-dry-run",
  "adopt",
  "linked",
  "owned",
  "transitive",
  "inventory-error",
]) {
  test(`scoped dependency gate: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-dep-gate-"));
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    const resources = join(dir, "resources", ORG);
    for (const folder of ["assistants", "tools", "squads", "structuredOutputs"])
      mkdirSync(join(resources, folder), { recursive: true });
    const assistantPath = `resources/${ORG}/assistants/receptionist.md`;
    const squadPath = `resources/${ORG}/squads/team.yml`;
    const assistantFile = `---
name: Receptionist
model:
  provider: openai
  model: gpt-4o
  toolIds: [my-end-call]
voice:
  provider: 11labs
  voiceId: burt
${mode === "transitive" ? "artifactPlan:\n  structuredOutputIds: [result]\n" : ""}---

You are the receptionist.
`;
    writeFileSync(join(dir, assistantPath), assistantFile);
    writeFileSync(
      join(resources, "tools/my-end-call.yml"),
      "name: End Call\ntype: endCall\n",
    );
    if (mode === "transitive") {
      writeFileSync(
        join(resources, "squads/team.yml"),
        "name: Team\nmembers:\n  - assistantId: receptionist\n",
      );
      writeFileSync(
        join(resources, "structuredOutputs/result.yml"),
        "name: Result\nschema:\n  type: object\n",
      );
    }
    const statePath = join(dir, `.vapi-state.${ORG}.json`);
    const initial = JSON.stringify({
      credentials: { fake: { uuid: "cred" } },
      assistants:
        mode === "transitive"
          ? {}
          : { receptionist: { uuid: ASSISTANT, origin: "pulled" } },
      tools:
        mode === "linked"
          ? { "my-end-call": { uuid: TOOL, origin: "pulled" } }
          : {
              "end-call-67aea057": {
                uuid: TOOL,
                origin: mode === "owned" ? "pushed" : "pulled",
              },
            },
      squads:
        mode === "transitive"
          ? { team: { uuid: SQUAD, origin: "pulled" } }
          : {},
    });
    writeFileSync(statePath, initial);
    const assistant = {
      id: ASSISTANT,
      name: "Receptionist",
      model: { provider: "openai", model: "gpt-4o", toolIds: [TOOL] },
      voice: { provider: "11labs", voiceId: "burt" },
    };
    const tool = { id: TOOL, name: "End Call", type: "endCall" };
    const requests: {
      method: string;
      path: string;
      body: Record<string, unknown>;
    }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = req.url!.split("?")[0]!;
      requests.push({
        method: req.method!,
        path,
        body: body ? JSON.parse(body) : {},
      });
      res.setHeader("Content-Type", "application/json");
      if (mode === "inventory-error" && path === "/tool") {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "Inventory denied" }));
        return;
      }
      let result: unknown = [];
      if (req.method === "GET" && path === "/tool") result = [tool];
      if (req.method === "GET" && path === "/assistant") result = [assistant];
      if (req.method === "GET" && path === `/assistant/${ASSISTANT}`)
        result = assistant;
      if (req.method === "GET" && path === `/tool/${TOOL}`) result = tool;
      if (req.method === "POST" && path === "/tool")
        result = { ...JSON.parse(body), id: CREATED };
      if (req.method === "PATCH")
        result = { ...JSON.parse(body), id: path.split("/")[2] };
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const args = [
        "--import",
        "tsx",
        "src/push.ts",
        ORG,
        ...(mode === "unscoped"
          ? []
          : mode === "type"
            ? ["--type", "assistants"]
            : [
                mode === "transitive"
                  ? squadPath
                  : mode === "scoped-short"
                    ? "assistants/receptionist.md"
                    : assistantPath,
              ]),
        ...(mode.startsWith("allow") ? ["--allow-new-files"] : []),
        ...(mode.includes("dry-run") ? ["--dry-run"] : []),
        ...(mode === "json" || mode === "transitive" ? ["--json"] : []),
        ...(mode === "adopt" ? ["--adopt", "my-end-call"] : []),
      ];
      const child = spawn(process.execPath, args, {
        cwd: dir,
        env: {
          ...process.env,
          VAPI_PRIVATE_API_KEY: "fake-token-not-used",
          VAPI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
      const code = await new Promise<number | null>((resolve) =>
        child.on("close", resolve),
      );
      clearTimeout(timeout);
      const blocked = ![
        "allow",
        "allow-dry-run",
        "adopt",
        "linked",
        "owned",
      ].includes(mode);
      assert.equal(code, blocked ? 1 : 0, stdout + stderr);
      const mutations = requests.filter((request) => request.method !== "GET");
      if (blocked || mode === "allow-dry-run") {
        assert.deepEqual(mutations, [], JSON.stringify(requests));
        assert.equal(readFileSync(statePath, "utf8"), initial);
        assert.equal(
          readFileSync(join(dir, assistantPath), "utf8"),
          assistantFile,
        );
        assert.equal(existsSync(join(dir, ".vapi-state-hash")), false);
        assert.equal(
          existsSync(join(dir, `.vapi-state.${ORG}.snapshots`)),
          false,
        );
      }
      if (blocked) {
        assert.match(stdout + stderr, /Not linked to any resource/);
        assert.match(
          stdout + stderr,
          /Needed by .*\/(receptionist.md|team.yml)/,
        );
        if (mode === "json" || mode === "transitive") {
          const issues = JSON.parse(stdout) as {
            file: string;
            problem: string;
            command: string;
          }[];
          assert.equal(issues.length, mode === "transitive" ? 3 : 1, stdout);
          assert.ok(
            issues.every((issue) =>
              issue.problem.includes(
                mode === "transitive" ? squadPath : assistantPath,
              ),
            ),
          );
          if (mode === "transitive")
            assert.deepEqual(
              issues.map((issue) => issue.file.split("/").at(-1)).sort(),
              ["my-end-call.yml", "receptionist.md", "result.yml"],
            );
        } else assert.equal(stderr.match(/Push stopped:/g)?.length, 1, stderr);
        if (mode === "inventory-error")
          assert.match(stderr, /Inventory unavailable/);
        if (mode === "scoped") {
          assert.match(
            stderr,
            new RegExp(`--allow-new-files ${assistantPath}`),
          );
          assert.match(
            stderr,
            new RegExp(`--adopt my-end-call ${assistantPath}`),
          );
        }
      } else if (mode === "allow-dry-run") {
        assert.match(stdout, /would POST \/tool/);
      } else {
        const creates = mutations.filter(
          (request) => request.method === "POST",
        );
        assert.equal(
          creates.length,
          mode === "allow" ? 1 : 0,
          JSON.stringify(mutations),
        );
        if (creates.length) assert.equal(creates[0]!.path, "/tool");
        const patch = mutations.find(
          (request) => request.path === `/assistant/${ASSISTANT}`,
        )!;
        assert.deepEqual((patch.body.model as { toolIds: string[] }).toolIds, [
          mode === "allow" ? CREATED : TOOL,
        ]);
        const saved = JSON.parse(readFileSync(statePath, "utf8"));
        assert.equal(
          saved.tools["my-end-call"].uuid,
          mode === "allow" ? CREATED : TOOL,
        );
        assert.equal(
          saved.tools["my-end-call"].origin,
          mode === "adopt"
            ? "adopted"
            : mode === "linked"
              ? "pulled"
              : "pushed",
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
