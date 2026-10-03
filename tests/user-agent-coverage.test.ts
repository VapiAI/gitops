import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every request gitops makes to the Vapi API must carry the gitops
// User-Agent, or that traffic is indistinguishable from any other Node
// script ("node"). api.ts carries push, pull, apply and promote, so it's
// checked against a real server; the other call sites are checked by
// reading them.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// GitHub's API, not Vapi's: the commit status client sets its own.
const NOT_VAPI = new Set(["check-status.ts"]);

test("every fetch to the Vapi API in src/ sets the User-Agent", () => {
  const missing: string[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    if (NOT_VAPI.has(file)) continue;
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/\bfetch\(/.test(line)) return;
      // The options object follows within a few lines.
      const call = lines.slice(index, index + 12).join("\n");
      if (!call.includes('"User-Agent"')) missing.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(missing, []);
});

test("api.ts requests carry the command's User-Agent", async () => {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["user-agent"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  // config.ts reads these at import.
  process.argv = ["node", "src/push.ts", "ua-test-org"];
  process.env.VAPI_TOKEN = "test-token-not-used";
  process.env.VAPI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.npm_lifecycle_event = "apply";
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  try {
    const { vapiGet } = await import("../src/api.ts");
    const { userAgentGet } = await import("../src/user-agent.ts");
    await vapiGet("/assistant");
    assert.deepEqual(seen, [userAgentGet()]);
    assert.match(seen[0] ?? "", /^vapi-gitops-apply\/[^ ]+$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
