import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

// ─────────────────────────────────────────────────────────────────────────────
// Regression test: a dashboard RENAME of an already-tracked resource must NOT
// rename or recreate the local file. The filename slug is a stable local
// handle, decoupled from the dashboard `name`.
//
// Scenario: state maps `call-transfer-test-c95f4c6b` → UUID X. On disk,
// `call-transfer-test-c95f4c6b.md` holds X's content. The dashboard renames
// the resource to "Call Transfer Test 1". A correct pull must:
//   1. Keep `call-transfer-test-c95f4c6b.md` (update its content in place).
//   2. NOT create a second file `call-transfer-test-1-c95f4c6b.md`.
//   3. Keep state keyed `call-transfer-test-c95f4c6b` → X.
//
// Before the fix, pull discarded the tracked resourceId on name mismatch,
// minted a name-derived slug, and wrote a duplicate file — leaving two files
// for one UUID.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

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

const ENV = "test-rename";
const UUID_X = "c95f4c6b-bfde-4e90-af7e-ea8870b9f2d6";
const TRACKED_SLUG = "call-transfer-test-c95f4c6b";
// The name-derived slug that the buggy behavior would have produced.
const NAME_DERIVED_SLUG = `call-transfer-test-1-${UUID_X.slice(0, 8)}`;

// Dashboard returns the resource under its NEW (renamed) name.
function renamedDashboardBody() {
  return {
    id: UUID_X,
    orgId: "org-test",
    name: "Call Transfer Test 1",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: "marker:renamed-on-dashboard" }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

const PREEXISTING_MD = `---
model:
  provider: openai
  model: gpt-4o
name: Call Transfer Test
voice:
  provider: 11labs
  voiceId: burt
---

marker:original-local
`;

test("pull: dashboard rename of tracked resource preserves the local filename (no duplicate)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-pull-rename-"));

  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );

  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });
  writeFileSync(join(assistantsDir, `${TRACKED_SLUG}.md`), PREEXISTING_MD);

  writeFileSync(
    join(dir, `.vapi-state.${ENV}.json`),
    JSON.stringify(
      {
        credentials: {},
        assistants: {
          [TRACKED_SLUG]: { uuid: UUID_X, lastPulledHash: "stale-hash-X" },
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

  const { worker, port } = await startStub([
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: [renamedDashboardBody()],
    },
  ]);

  writeFileSync(
    join(dir, `.env.${ENV}`),
    [
      "VAPI_TOKEN=fake-token-not-used",
      `VAPI_BASE_URL=http://127.0.0.1:${port}`,
      "",
    ].join("\n"),
  );

  try {
    // --force so the platform overwrite actually rewrites the file content;
    // the question under test is whether the filename stays put.
    const res = spawnSync(
      "node",
      ["--import", "tsx", "src/pull.ts", ENV, "--force"],
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

    assert.equal(
      res.status,
      0,
      `pull exit code ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // The original file must still exist and now hold the renamed content.
    const trackedPath = join(assistantsDir, `${TRACKED_SLUG}.md`);
    assert.ok(
      existsSync(trackedPath),
      `${TRACKED_SLUG}.md must still exist; dir: ${readdirSync(assistantsDir).join(", ")}`,
    );
    const content = readFileSync(trackedPath, "utf-8");
    assert.match(
      content,
      /marker:renamed-on-dashboard/,
      `${TRACKED_SLUG}.md must hold the updated content; got:\n${content}`,
    );

    // No name-derived duplicate may be created.
    const dupPath = join(assistantsDir, `${NAME_DERIVED_SLUG}.md`);
    assert.ok(
      !existsSync(dupPath),
      `must NOT create a name-derived duplicate ${NAME_DERIVED_SLUG}.md; dir: ${readdirSync(assistantsDir).join(", ")}`,
    );
    assert.equal(
      readdirSync(assistantsDir).length,
      1,
      `exactly one assistant file expected; dir: ${readdirSync(assistantsDir).join(", ")}`,
    );

    // State must remain keyed by the original slug → X.
    const finalState = JSON.parse(
      readFileSync(join(dir, `.vapi-state.${ENV}.json`), "utf-8"),
    );
    assert.equal(
      finalState.assistants[TRACKED_SLUG]?.uuid,
      UUID_X,
      `state[${TRACKED_SLUG}] must still map to X; got ${JSON.stringify(finalState.assistants)}`,
    );
    assert.equal(
      finalState.assistants[NAME_DERIVED_SLUG],
      undefined,
      `state must NOT contain a name-derived key ${NAME_DERIVED_SLUG}`,
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
