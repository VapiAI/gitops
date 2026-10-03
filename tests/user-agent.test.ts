import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runSimulation } from "../src/sim.ts";
import { userAgentGet } from "../src/user-agent.ts";

// The User-Agent is how gitops-started simulation runs are counted in the
// platform's analytics (`user_agent` on the run-started event), so its
// format is a contract worth pinning.

const packageJsonPath = new URL("../package.json", import.meta.url);
const packageVersion = (
  JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string }
).version;

test("userAgentGet: names the product and the package version", () => {
  assert.equal(userAgentGet("sim"), `vapi-gitops-sim/${packageVersion}`);
  assert.equal(userAgentGet("check"), `vapi-gitops-check/${packageVersion}`);
});

test("runSimulation: sends the sim User-Agent on run create", async () => {
  const seen: { method?: string; url?: string; userAgent?: string } = {};
  const server = createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.userAgent = req.headers["user-agent"];
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "run-1", status: "queued" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const log = console.log;
  console.log = () => {};
  try {
    await runSimulation(
      {
        env: "test-org",
        token: "test-token",
        baseUrl: `http://127.0.0.1:${port}`,
      },
      {
        entries: [{ type: "simulationSuite", simulationSuiteId: "suite-1" }],
        label: "suite test",
      },
      { type: "assistant", id: "assistant-1", resourceName: "a" },
      { watch: false },
    );
  } finally {
    console.log = log;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/eval/simulation/run");
  assert.equal(seen.userAgent, `vapi-gitops-sim/${packageVersion}`);
});
