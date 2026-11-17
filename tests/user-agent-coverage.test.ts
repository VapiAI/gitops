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
        const call =
          file === "vapi-fetch.ts"
            ? readFileSync(join(SRC, file), "utf8")
            : rest.slice(0, rest.indexOf(");") + 2);
        if (!call.includes('"User-Agent"'))
          missing.push(`${file} (fetch #${i + 1})`);
      });
  }
  assert.deepEqual(missing, []);
});

// The Vapi API also gets x-vapi-client on every request. The GitHub status
// call is the one fetch that must not send it: it isn't a Vapi request.
test("every Vapi fetch in src/ sets x-vapi-client", () => {
  const missing: string[] = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    readFileSync(join(SRC, file), "utf8")
      .split(/\bfetch\(/)
      .slice(1)
      .forEach((rest, i) => {
        const call =
          file === "vapi-fetch.ts"
            ? readFileSync(join(SRC, file), "utf8")
            : rest.slice(0, rest.indexOf(");") + 2);
        const github = call.includes('"X-GitHub-Api-Version"');
        if (!github && !call.includes('"x-vapi-client"'))
          missing.push(`${file} (fetch #${i + 1})`);
      });
  }
  assert.deepEqual(missing, []);
});

test("api.ts requests carry the command's User-Agent", async () => {
  const seen: Array<string | undefined> = [];
  const times: number[] = [];
  const seenClient: Array<string | string[] | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["user-agent"]);
    times.push(performance.now());
    seenClient.push(req.headers["x-vapi-client"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  // config.ts reads these at import.
  process.argv = ["node", "src/push.ts", "ua-test-org"];
  process.env.VAPI_TOKEN = "test-token-not-used";
  process.env.VAPI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.VAPI_MAX_GITOPS_RPM = "300";
  process.env.npm_lifecycle_event = "apply";
  delete process.env.VAPI_GITOPS_COMMAND;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  try {
    const { vapiGet } = await import("../src/api.ts");
    const { userAgentGet, vapiClientGet } = await import("../src/user-agent.ts");
    await vapiGet("/assistant");
    assert.deepEqual(seen, [userAgentGet()]);
    assert.match(seen[0] ?? "", /^vapi-gitops-apply\/[^ ]+$/);
    assert.deepEqual(seenClient, [vapiClientGet()]);
    assert.match(
      String(seenClient[0]),
      /^gitops\/[^;]+; command=apply; run=[0-9a-f-]{36}$/,
    );
    await Promise.all(Array.from({ length: 24 }, () => vapiGet("/assistant")));
    assert.equal(times.length, 25);
    assert.ok(
      times[24]! - times[0]! >= 850,
      "requests beyond the initial burst must wait for tokens",
    );
    assert.ok(
      times[24]! - times[23]! >= 140,
      "sustained requests must be spaced by the cap",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("every Vapi fetch uses the shared limiter and warning path", () => {
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    if (/\bfetch\s*\(/.test(source))
      assert.ok(
        ["vapi-fetch.ts", "check-status.ts"].includes(file),
        `${file} must use limitedVapiFetch`,
      );
  }
  const shared = readFileSync(join(SRC, "vapi-fetch.ts"), "utf8");
  assert.match(shared, /await limiter\.acquire\(\)/);
  assert.ok(
    shared.indexOf("await limiter.acquire()") < shared.indexOf("await fetch("),
  );
});
