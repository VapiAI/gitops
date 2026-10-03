import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runSimulation } from "../src/sim.ts";
import { userAgentGet } from "../src/user-agent.ts";

// The User-Agent is how gitops traffic is counted in the platform's request
// logs and analytics (simulation runs by `user_agent` on the run-started
// event), so its format is a contract worth pinning.

const packageJsonPath = new URL("../package.json", import.meta.url);
const packageVersion = (
  JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string }
).version;

const at = (
  env: NodeJS.ProcessEnv,
  scriptPath?: string,
  product?: "sim" | "check",
) => userAgentGet(product, { env, scriptPath });

test("userAgentGet: sim and check keep their fixed labels", () => {
  assert.deepEqual(
    [
      at({}, "/repo/src/sim-cmd.ts", "sim"),
      at(
        { npm_lifecycle_event: "promote" },
        "/repo/src/promote-cmd.ts",
        "check",
      ),
    ],
    [
      `vapi-gitops-sim/${packageVersion}`,
      `vapi-gitops-check/${packageVersion}`,
    ],
  );
});

test("userAgentGet: names the npm script, else the entry script", () => {
  assert.deepEqual(
    [
      // `npm run apply` runs pull.ts and push.ts as children: still apply.
      at({ npm_lifecycle_event: "apply" }, "/repo/src/push.ts"),
      at({}, "/repo/src/check-cmd.ts"),
      at({}, "/repo/src/pull.ts"),
      at({ npm_lifecycle_event: "check:All" }),
      at({}),
    ],
    [
      `vapi-gitops-apply/${packageVersion}`,
      `vapi-gitops-check/${packageVersion}`,
      `vapi-gitops-pull/${packageVersion}`,
      `vapi-gitops-check-all/${packageVersion}`,
      `vapi-gitops-cli/${packageVersion}`,
    ],
  );
});

test("userAgentGet: marks runs in CI", () => {
  const marked = (env: NodeJS.ProcessEnv) =>
    at({ npm_lifecycle_event: "push", ...env }).endsWith(" (ci)");
  assert.deepEqual(
    [
      { GITHUB_ACTIONS: "true" },
      { CI: "true" },
      { CI: "1" },
      { CI: "false" },
      { CI: "0" },
      { CI: "" },
      {},
    ].map(marked),
    [true, true, true, false, false, false, false],
  );
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
  assert.equal(seen.userAgent, userAgentGet("sim"));
});
