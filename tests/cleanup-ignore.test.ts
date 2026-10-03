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
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `npm run cleanup` deletes platform resources that aren't in the state
// file. Resources excluded by .vapi-ignore are never written to state, so
// cleanup must keep them, as push's orphan-protection does.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "test-cleanup-org";
const TRACKED = "11111111-1111-4111-8111-111111111111";
const IGNORED_ASSISTANT = "22222222-2222-4222-8222-222222222222";
const IGNORED_TOOL = "33333333-3333-4333-8333-333333333333";
const ORPHAN = "44444444-4444-4444-8444-444444444444";

const PLATFORM: Record<string, unknown[]> = {
  "/assistant": [
    { id: TRACKED, name: "Front Desk" },
    { id: IGNORED_ASSISTANT, name: "Legacy Bot" },
    { id: ORPHAN, name: "Old Experiment" },
  ],
  "/tool": [
    // An empty `name` with a function name: pull names it by the function name.
    {
      id: IGNORED_TOOL,
      type: "function",
      name: "",
      function: { name: "legacy_lookup" },
    },
  ],
};

async function cleanupRun(
  args: string[],
): Promise<{ code: number | null; output: string; deletes: string[] }> {
  const deletes: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "DELETE") {
      deletes.push(req.url ?? "");
      res.end("{}");
      return;
    }
    const path = (req.url ?? "").split("?")[0]!;
    res.end(JSON.stringify(PLATFORM[path] ?? []));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "vapi-cleanup-ignore-"));
  try {
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, `.env.${ORG}`), "VAPI_TOKEN=fake-token-not-used\n");
    writeFileSync(
      join(dir, `.vapi-state.${ORG}.json`),
      JSON.stringify({ assistants: { "front-desk": { uuid: TRACKED } } }),
    );
    mkdirSync(join(dir, "resources", ORG), { recursive: true });
    writeFileSync(
      join(dir, "resources", ORG, ".vapi-ignore"),
      "# owned by another team\nassistants/legacy-*\ntools/legacy-*\n",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cleanup.ts", ORG, ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          VAPI_BASE_URL: baseUrl,
          VAPI_TOKEN: "fake-token-not-used",
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    return { code, output, deletes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test(
  "a destructive cleanup deletes only true orphans and keeps .vapi-ignore matches",
  { timeout: 60_000 },
  async () => {
    const result = await cleanupRun(["--force", "--confirm", ORG]);
    assert.deepEqual(
      {
        code: result.code,
        deletes: result.deletes,
        retainedAssistant: result.output.includes(
          "Legacy Bot retained (matched .vapi-ignore: assistants/legacy-*)",
        ),
        retainedTool: result.output.includes(
          "legacy_lookup retained (matched .vapi-ignore: tools/legacy-*)",
        ),
      },
      {
        code: 0,
        deletes: [`/assistant/${ORPHAN}`],
        retainedAssistant: true,
        retainedTool: true,
      },
    );
  },
);

test(
  "a dry run lists ignored resources as kept, not as orphans",
  { timeout: 60_000 },
  async () => {
    const result = await cleanupRun([]);
    assert.deepEqual(
      {
        code: result.code,
        deletes: result.deletes,
        orphanListed: result.output.includes(
          `assistants: Old Experiment (${ORPHAN})`,
        ),
        ignoredListed:
          result.output.includes(IGNORED_ASSISTANT) &&
          result.output.includes("🗑️  assistants: Legacy Bot"),
        keptSummary: result.output.includes(
          "2 resource(s) not in state were kept because they match .vapi-ignore",
        ),
      },
      {
        code: 0,
        deletes: [],
        orphanListed: true,
        ignoredListed: false,
        keptSummary: true,
      },
    );
  },
);
