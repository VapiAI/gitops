import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { StateFile } from "../src/types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const environment = "pull-bootstrap-test";

interface AssistantResource {
  id: string;
  name: string;
  orgId: string;
}

function emptyState(): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

function assistant(index: number): AssistantResource {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    name: `Assistant ${index}`,
    orgId: "org-test",
  };
}

function startStub(options: {
  list: AssistantResource[];
  direct?: AssistantResource;
}): Promise<{ worker: Worker; port: number }> {
  return new Promise((resolveStart, rejectStart) => {
    const source = `
      const http = require("node:http");
      const { parentPort, workerData } = require("node:worker_threads");
      const server = http.createServer((req, res) => {
        const url = req.url || "";
        let body = [];
        if (url === "/assistant?limit=1000") {
          body = workerData.list;
        } else if (url === "/assistant") {
          body = workerData.list.slice(0, 100);
        } else if (
          workerData.direct &&
          url === "/assistant/" + workerData.direct.id
        ) {
          body = workerData.direct;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          typeof address === "object" && address ? address.port : 0;
        parentPort.postMessage({ type: "listening", port });
      });
      parentPort.on("message", (message) => {
        if (message && message.type === "shutdown") {
          server.close(() => process.exit(0));
        }
      });
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: options,
    });
    worker.once("error", rejectStart);
    worker.on("message", (message: { type: string; port?: number }) => {
      if (message.type === "listening" && typeof message.port === "number") {
        resolveStart({ worker, port: message.port });
      }
    });
  });
}

async function stopStub(worker: Worker): Promise<void> {
  worker.postMessage({ type: "shutdown" });
  await new Promise<void>((resolveStop) => {
    worker.once("exit", resolveStop);
    setTimeout(() => {
      worker
        .terminate()
        .then(() => resolveStop())
        .catch(() => resolveStop());
    }, 1000);
  });
}

async function runPull(options: {
  list: AssistantResource[];
  direct?: AssistantResource;
  state?: StateFile;
  ignore?: string;
  args: string[];
}): Promise<{ state: StateFile; stdout: string; stderr: string }> {
  const directory = mkdtempSync(join(tmpdir(), "vapi-pull-bootstrap-"));
  cpSync(join(repoRoot, "src"), join(directory, "src"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(directory, "package.json"));
  symlinkSync(
    join(repoRoot, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const resourceRoot = join(directory, "resources", environment);
  mkdirSync(resourceRoot, { recursive: true });
  if (options.ignore) {
    writeFileSync(join(resourceRoot, ".vapi-ignore"), options.ignore);
  }
  writeFileSync(
    join(directory, `.vapi-state.${environment}.json`),
    `${JSON.stringify(options.state ?? emptyState(), null, 2)}\n`,
  );

  const { worker, port } = await startStub({
    list: options.list,
    direct: options.direct,
  });
  writeFileSync(
    join(directory, `.env.${environment}`),
    `VAPI_TOKEN=test-token\nVAPI_BASE_URL=http://127.0.0.1:${port}\n`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/pull.ts", environment, ...options.args],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          VAPI_TOKEN: "test-token",
          VAPI_BASE_URL: `http://127.0.0.1:${port}`,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `pull failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    return {
      state: JSON.parse(
        readFileSync(
          join(directory, `.vapi-state.${environment}.json`),
          "utf8",
        ),
      ),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await stopStub(worker);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("bootstrap requests the complete assistant inventory", async () => {
  const result = await runPull({
    list: Array.from({ length: 101 }, (_, index) => assistant(index + 1)),
    args: ["--bootstrap", "--skip-bindings", "--type", "assistants"],
  });

  assert.equal(Object.keys(result.state.assistants).length, 101);
});

test("targeted assistant pull uses direct GET instead of the list response", async () => {
  const direct = assistant(301);
  const result = await runPull({
    list: [],
    direct,
    args: [
      "--skip-bindings",
      "--type",
      "assistants",
      "--id",
      direct.id,
    ],
  });

  assert.equal(
    Object.values(result.state.assistants)[0]?.uuid,
    direct.id,
  );
});

test("bootstrap excludes resources matched by .vapi-ignore from state", async () => {
  const ignored = assistant(401);
  const state = emptyState();
  state.assistants["dashboard-only"] = { uuid: ignored.id };

  const result = await runPull({
    list: [ignored],
    state,
    ignore: "assistants/dashboard-only\n",
    args: ["--bootstrap", "--skip-bindings", "--type", "assistants"],
  });

  assert.deepEqual(result.state.assistants, {});
  assert.match(result.stdout, /matched \.vapi-ignore/);
});
