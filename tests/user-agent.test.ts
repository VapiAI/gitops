import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runSimulation } from "../src/sim.ts";
import { RUN_ID_ENV, userAgentGet, vapiClientGet } from "../src/user-agent.ts";

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

test("userAgentGet: names a known command only: pinned, npm script, entry script, else cli", () => {
  assert.deepEqual(
    [
      // `npm run apply` runs pull.ts and push.ts as children: still apply.
      at({ npm_lifecycle_event: "apply" }, "/repo/src/push.ts"),
      // The PR check runs check-cmd.ts directly; its bindings pull inherits
      // the pinned label.
      at({ VAPI_GITOPS_COMMAND: "check" }, "/repo/src/pull.ts"),
      at({}, "/repo/src/check-cmd.ts"),
      at({}, "/repo/src/pull.ts"),
      // npx isn't a command, so the entry script names it.
      at({ npm_lifecycle_event: "npx" }, "/repo/src/push-cmd.ts"),
      // A fork's own script name is never sent.
      at({ npm_lifecycle_event: "deploy:acme-prod" }, "/repo/src/apply-cmd.ts"),
      at({ npm_lifecycle_event: "check:All" }),
      at({}),
    ],
    [
      `vapi-gitops-apply/${packageVersion}`,
      `vapi-gitops-check/${packageVersion}`,
      `vapi-gitops-check/${packageVersion}`,
      `vapi-gitops-pull/${packageVersion}`,
      `vapi-gitops-push/${packageVersion}`,
      `vapi-gitops-apply/${packageVersion}`,
      `vapi-gitops-cli/${packageVersion}`,
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
  const seen: {
    method?: string;
    url?: string;
    userAgent?: string;
    vapiClient?: string | string[];
  } = {};
  const server = createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.userAgent = req.headers["user-agent"];
    seen.vapiClient = req.headers["x-vapi-client"];
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
  assert.equal(seen.vapiClient, vapiClientGet("sim"));
});

// x-vapi-client is the shape the platform parses for every first-party client
// (`<client>/<version>; command=…; run=…[; ci]`), so its format is pinned too.
const RUN_ID = "3f2b6c1e-9d4a-4c7e-8a1b-0e5f6a7b8c9d";

test("vapiClientGet: names the command, run and CI flag", () => {
  assert.deepEqual(
    [
      vapiClientGet(undefined, {
        env: { npm_lifecycle_event: "apply", [RUN_ID_ENV]: RUN_ID },
        scriptPath: "/repo/src/push.ts",
      }),
      vapiClientGet("sim", {
        env: { [RUN_ID_ENV]: RUN_ID, GITHUB_ACTIONS: "true" },
      }),
    ],
    [
      `gitops/${packageVersion}; command=apply; run=${RUN_ID}`,
      `gitops/${packageVersion}; command=sim; run=${RUN_ID}; ci`,
    ],
  );
});

test("vapiClientGet: labels a rollout write by its own command", () => {
  assert.equal(
    vapiClientGet("rollout-pin", { env: { [RUN_ID_ENV]: RUN_ID } }),
    `gitops/${packageVersion}; command=rollout-pin; run=${RUN_ID}`,
  );
});

test("vapiClientGet: leaves out a run id the platform would reject", () => {
  assert.equal(
    vapiClientGet("check", { env: { [RUN_ID_ENV]: "bad id; ci" } }),
    `gitops/${packageVersion}; command=check`,
  );
});

test("user-agent.ts pins one valid run id for the process", () => {
  assert.match(process.env[RUN_ID_ENV] ?? "", /^[0-9a-f-]{36}$/);
});
