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
// Integration test for the state-aware adoption fix in pull.ts.
//
// Scenario: dashboard has 2 assistants both named "Taylor" (UUID A and B).
// State already maps the slug `taylor` → A. On disk, `taylor.md` holds A's
// content. A bug-free pull must:
//   1. Preserve `taylor.md` unchanged (still A's content) — NOT clobber it.
//   2. Create a fresh `taylor-<B[:8]>.md` for the new resource B.
//   3. Persist both mappings in state: `taylor → A` AND `taylor-<B[:8]> → B`.
//
// Without the fix, B silently overwrites `taylor.md` and the state mapping
// for `taylor` flips to B — orphaning A's UUID with no on-disk artifact.
//
// Reproduces the "five same-name assistants" customer scenario that will keep getting
// triggered as Vapi auto-seeds same-named twins for new orgs.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface StubRoute {
  method: string;
  pathStartsWith: string;
  body: unknown;
}

// Mirrors the spawn-fixture / Worker-stub pattern in
// `tests/vapi-ignore-push.test.ts`. The HTTP stub MUST live on a separate
// thread so `fetchAllResources` can be served while `spawnSync` parks the
// main thread's event loop.
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

const ENV = "test-clobber";
const UUID_A = "aaaaaaaa-1111-1111-1111-111111111111";
const UUID_B = "bbbbbbbb-2222-2222-2222-222222222222";

// Minimal assistant body the API would return. Includes a distinctive
// marker so we can assert which body landed in each file.
function taylorDashboardBody(uuid: string, marker: string) {
  return {
    id: uuid,
    orgId: "org-test",
    name: "Taylor",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: `marker:${marker}` }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

// Pre-pull on-disk content for `taylor.md`. Uses A's marker so we can tell
// whether B clobbered it.
const PREEXISTING_TAYLOR_MD = `---
model:
  provider: openai
  model: gpt-4o
name: Taylor
voice:
  provider: 11labs
  voiceId: burt
---

marker:A-original
`;

// Run the full clobber scenario with a configurable dashboard-response
// ordering. Asserts the fix works regardless of which Taylor the API
// returns first — this is the H1 case from code review: without merging
// the prior-pull state into the adoption guard, B-first ordering would
// clobber A's file because `newStateSection` is empty when B is
// processed.
async function runClobberScenario(
  testName: string,
  dashboardOrder: "A-first" | "B-first",
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vapi-pull-clobber-"));

  // Copy source tree + package.json, symlink node_modules. Mirrors
  // vapi-ignore-push.test.ts's spawn-fixture setup.
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );

  // Seed the resource tree: existing `taylor.md` holding A's content.
  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });
  writeFileSync(join(assistantsDir, "taylor.md"), PREEXISTING_TAYLOR_MD);

  // Seed state: slug `taylor` already maps to UUID A.
  // The drift baseline lives in the hash store, not the state file. The
  // engine runs from the copied src/, so its store resolves under `dir`.
  const hashStore = join(dir, ".vapi-state-hash", ENV);
  mkdirSync(hashStore, { recursive: true });
  writeFileSync(join(hashStore, UUID_A), "stale-hash-A\n");

  writeFileSync(
    join(dir, `.vapi-state.${ENV}.json`),
    JSON.stringify(
      {
        credentials: {},
        assistants: {
          taylor: { uuid: UUID_A },
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

  // HTTP stub returns BOTH Taylors (A and B) for the /assistant list call,
  // in the configured order. The fix must produce the correct outcome
  // regardless of which one the dashboard returns first.
  const orderedBodies =
    dashboardOrder === "A-first"
      ? [
          taylorDashboardBody(UUID_A, "A-fresh-from-platform"),
          taylorDashboardBody(UUID_B, "B-new-twin"),
        ]
      : [
          taylorDashboardBody(UUID_B, "B-new-twin"),
          taylorDashboardBody(UUID_A, "A-fresh-from-platform"),
        ];
  const { worker, port } = await startStub([
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: orderedBodies,
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
    // Run pull via the CLI entrypoint (same path real customers exercise).
    // --force so the mtime-based "locally modified" guard does not kick in
    // and short-circuit the platform overwrite of taylor.md (we want pull
    // to actually try to write taylor.md — the question is whether B's
    // content lands there or A's content stays).
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
      `[${testName}] pull exit code ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // ── Filesystem assertions ────────────────────────────────────────────
    // taylor.md must still exist AND hold A's content (the platform's
    // A-fresh-from-platform marker, since --force overwrites with platform
    // state — but NOT B's content).
    const taylorPath = join(assistantsDir, "taylor.md");
    assert.ok(existsSync(taylorPath), `[${testName}] taylor.md must still exist`);
    const taylorContent = readFileSync(taylorPath, "utf-8");
    assert.match(
      taylorContent,
      /marker:A-fresh-from-platform/,
      `[${testName}] taylor.md must hold A's content (the file mapped to A in state); got:\n${taylorContent}`,
    );
    assert.doesNotMatch(
      taylorContent,
      /marker:B-new-twin/,
      `[${testName}] taylor.md must NOT have been clobbered by B; got:\n${taylorContent}`,
    );

    // B must have landed in its own file `taylor-<B[:8]>.md`.
    const expectedBSlug = `taylor-${UUID_B.slice(0, 8)}`;
    const bPath = join(assistantsDir, `${expectedBSlug}.md`);
    assert.ok(
      existsSync(bPath),
      `[${testName}] expected B's file at ${bPath}; assistants dir contents: ${readdirSync(assistantsDir).join(", ")}`,
    );
    const bContent = readFileSync(bPath, "utf-8");
    assert.match(
      bContent,
      /marker:B-new-twin/,
      `[${testName}] ${expectedBSlug}.md must hold B's content; got:\n${bContent}`,
    );

    // ── State assertions ─────────────────────────────────────────────────
    const finalState = JSON.parse(
      readFileSync(join(dir, `.vapi-state.${ENV}.json`), "utf-8"),
    );
    assert.equal(
      finalState.assistants.taylor?.uuid,
      UUID_A,
      `[${testName}] state[taylor] must still map to A (${UUID_A}); got ${JSON.stringify(finalState.assistants.taylor)}`,
    );
    assert.equal(
      finalState.assistants[expectedBSlug]?.uuid,
      UUID_B,
      `[${testName}] state[${expectedBSlug}] must map to B (${UUID_B}); got ${JSON.stringify(finalState.assistants[expectedBSlug])}`,
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
}

test("pull: 2 same-name resources (A-first ordering) — fix prevents clobber", async () => {
  await runClobberScenario("A-first", "A-first");
});

test("pull: 2 same-name resources (B-first ordering) — fix prevents clobber regardless of dashboard list order", async () => {
  // Regression guard for the H1 finding from code review: without merging
  // `state[resourceType]` into the adoption guard, B-first ordering would
  // clobber A's file (B is processed while `newStateSection` is still empty,
  // sees `taylor.md` as "unclaimed in flight" — but prior state has it).
  await runClobberScenario("B-first", "B-first");
});
