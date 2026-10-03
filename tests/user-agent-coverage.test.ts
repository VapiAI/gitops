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

// Each call is checked on its own, from `fetch(` to its closing `);`, so one
// call's header can't vouch for a neighbour's, and subfolders are scanned too.
// Every fetch in src/ is covered, the GitHub status call included: GitHub also
// asks clients to send a User-Agent.
test("every fetch in src/ sets the User-Agent", () => {
  const missing: string[] = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    readFileSync(join(SRC, file), "utf8")
      .split(/\bfetch\(/)
      .slice(1)
      .forEach((rest, i) => {
        const call = rest.slice(0, rest.indexOf(");") + 2);
        if (!call.includes('"User-Agent"'))
          missing.push(`${file} (fetch #${i + 1})`);
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
  delete process.env.VAPI_GITOPS_COMMAND;
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
