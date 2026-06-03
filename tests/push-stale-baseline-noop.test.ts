import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// ─────────────────────────────────────────────────────────────────────────────
// Regression: a STALE `lastPulledHash` (written in an older hash basis) must
// NOT block a push when the local file and the dashboard are byte-identical.
//
// Real scenario (the phantom-drift class): a customer repo upgrades the engine,
// so every `lastPulledHash` in state was written by a prior basis and matches
// neither the new `hashLocalResource` nor the new canonicalized platform hash.
// On the next push, an UNTOUCHED resource computes:
//   localHash === platformHash  (local and dashboard agree)  ≠  lastPulledHash
// `classifyDrift` descriptively calls that `both-diverged`, but the push GATE
// must treat local==platform as a no-op and let the PATCH through. Before the
// fix, push exited 1 with "drift detected ... [both-diverged]" and applied 0.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const ENV = "test-stale-baseline";
const UUID = "c95f4c6b-bfde-4e90-af7e-ea8870b9f2d6";
const SLUG = "stale-baseline-bot-c95f4c6b";

// Dashboard payload. cleanResource strips id/orgId; the remaining shape must
// canonicalize to exactly what the local .md parses to (see LOCAL_MD).
function dashboardBody() {
  return {
    id: UUID,
    orgId: "org-test",
    name: "Stale Baseline Bot",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: "prompt body here" }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

// Local file. parseResourceDataFromFile reconstructs model.messages[system]
// from the body, yielding the same object the dashboard canonicalizes to.
const LOCAL_MD = `---
model:
  provider: openai
  model: gpt-4o
name: Stale Baseline Bot
voice:
  provider: 11labs
  voiceId: burt
---

prompt body here
`;

interface StubRoute {
  method: string;
  pathStartsWith: string;
  body: unknown;
}

function startStub(
  routes: StubRoute[],
): Promise<{ worker: Worker; port: number }> {
  return new Promise((resolveStart, rejectStart) => {
    const stubSource = `
      const http = require('node:http');
      const { parentPort, workerData } = require('node:worker_threads');
      const routes = workerData.routes;
      const server = http.createServer((req, res) => {
        const url = req.url || '';
        const method = (req.method || 'GET').toUpperCase();
        const match = routes.find(
          (r) => r.method === method && url.startsWith(r.pathStartsWith),
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(match ? match.body : []));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        parentPort.postMessage({ type: 'listening', port });
      });
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'shutdown') {
          server.close(() => process.exit(0));
        }
      });
    `;
    const worker = new Worker(stubSource, {
      eval: true,
      workerData: { routes },
    });
    worker.once("error", rejectStart);
    worker.on("message", (msg: { type: string; port?: number }) => {
      if (msg.type === "listening" && typeof msg.port === "number") {
        resolveStart({ worker, port: msg.port });
      }
    });
  });
}

test("push: stale lastPulledHash does not block when local and dashboard agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-push-stale-"));

  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");

  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });
  writeFileSync(join(assistantsDir, `${SLUG}.md`), LOCAL_MD);

  writeFileSync(
    join(dir, `.vapi-state.${ENV}.json`),
    JSON.stringify(
      {
        credentials: {},
        // The baseline is deliberately stale: it equals neither the local
        // file's hash nor the canonicalized dashboard hash.
        assistants: {
          [SLUG]: { uuid: UUID, lastPulledHash: "stale-older-basis-hash" },
        },
        structuredOutputs: {},
        tools: {},
        squads: {},
        personalities: {},
        scenarios: {},
        simulations: {},
        simulationSuites: {},
        evals: {},
      },
      null,
      2,
    ),
  );

  // Route order matters: the by-id GET must match before the list GET.
  const { worker, port } = await startStub([
    { method: "GET", pathStartsWith: `/assistant/${UUID}`, body: dashboardBody() },
    { method: "PATCH", pathStartsWith: `/assistant/${UUID}`, body: dashboardBody() },
    { method: "GET", pathStartsWith: "/assistant", body: [dashboardBody()] },
  ]);

  writeFileSync(
    join(dir, `.env.${ENV}`),
    ["VAPI_TOKEN=fake-token-not-used", `VAPI_BASE_URL=http://127.0.0.1:${port}`, ""].join(
      "\n",
    ),
  );

  try {
    const res = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "src/push.ts",
        ENV,
        `resources/${ENV}/assistants/${SLUG}.md`,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          VAPI_TOKEN: "fake-token-not-used",
          VAPI_BASE_URL: `http://127.0.0.1:${port}`,
        },
        encoding: "utf-8",
        timeout: 30_000,
      },
    );

    const out = `${res.stdout}\n${res.stderr}`;
    assert.equal(
      res.status,
      0,
      `push must exit 0 (no phantom block)\n${out}`,
    );
    assert.doesNotMatch(
      out,
      /drift detected|both-diverged/,
      `push must NOT report drift when local and dashboard agree\n${out}`,
    );
    assert.match(
      out,
      /Applied 1 resource/,
      `push must apply the resource (PATCH no-op)\n${out}`,
    );
  } finally {
    worker.postMessage({ type: "shutdown" });
    await new Promise<void>((resolveShutdown) => {
      worker.once("exit", () => resolveShutdown());
      setTimeout(() => {
        worker
          .terminate()
          .then(() => resolveShutdown())
          .catch(() => resolveShutdown());
      }, 1000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
