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
// Scenario: dashboard has 2 assistants both named "Riley" (UUID A and B).
// State already maps the slug `riley` → A. On disk, `riley.md` holds A's
// content. A bug-free pull must:
//   1. Preserve `riley.md` unchanged (still A's content) — NOT clobber it.
//   2. Create a fresh `riley-<B[:8]>.md` for the new resource B.
//   3. Persist both mappings in state: `riley → A` AND `riley-<B[:8]> → B`.
//
// Without the fix, B silently overwrites `riley.md` and the state mapping
// for `riley` flips to B — orphaning A's UUID with no on-disk artifact.
//
// Reproduces the mudflap "5 Rileys" customer scenario that will keep getting
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
function rileyDashboardBody(uuid: string, marker: string) {
  return {
    id: uuid,
    orgId: "org-test",
    name: "Riley",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: `marker:${marker}` }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

// Pre-pull on-disk content for `riley.md`. Uses A's marker so we can tell
// whether B clobbered it.
const PREEXISTING_RILEY_MD = `---
model:
  provider: openai
  model: gpt-4o
name: Riley
voice:
  provider: 11labs
  voiceId: burt
---

marker:A-original
`;

test("pull: 2 dashboard resources with same name (A in state, B new) — fix prevents clobber", async () => {
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

  // Seed the resource tree: existing `riley.md` holding A's content.
  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });
  writeFileSync(join(assistantsDir, "riley.md"), PREEXISTING_RILEY_MD);

  // Seed state: slug `riley` already maps to UUID A.
  writeFileSync(
    join(dir, `.vapi-state.${ENV}.json`),
    JSON.stringify(
      {
        credentials: {},
        assistants: {
          riley: { uuid: UUID_A, lastPulledHash: "stale-hash-A" },
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

  // HTTP stub returns BOTH Rileys (A and B) for the /assistant list call.
  // Other endpoints return [] (no credentials, no other resource types).
  const { worker, port } = await startStub([
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: [
        rileyDashboardBody(UUID_A, "A-fresh-from-platform"),
        rileyDashboardBody(UUID_B, "B-new-twin"),
      ],
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
    // and short-circuit the platform overwrite of riley.md (we want pull
    // to actually try to write riley.md — the question is whether B's
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
      `pull exit code ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // ── Filesystem assertions ────────────────────────────────────────────
    // riley.md must still exist AND hold A's content (the platform's
    // A-fresh-from-platform marker, since --force overwrites with platform
    // state — but NOT B's content).
    const rileyPath = join(assistantsDir, "riley.md");
    assert.ok(existsSync(rileyPath), "riley.md must still exist");
    const rileyContent = readFileSync(rileyPath, "utf-8");
    assert.match(
      rileyContent,
      /marker:A-fresh-from-platform/,
      `riley.md must hold A's content (the file mapped to A in state); got:\n${rileyContent}`,
    );
    assert.doesNotMatch(
      rileyContent,
      /marker:B-new-twin/,
      `riley.md must NOT have been clobbered by B; got:\n${rileyContent}`,
    );

    // B must have landed in its own file `riley-<B[:8]>.md`.
    const expectedBSlug = `riley-${UUID_B.slice(0, 8)}`;
    const bPath = join(assistantsDir, `${expectedBSlug}.md`);
    assert.ok(
      existsSync(bPath),
      `expected B's file at ${bPath}; assistants dir contents: ${readdirSync(assistantsDir).join(", ")}`,
    );
    const bContent = readFileSync(bPath, "utf-8");
    assert.match(
      bContent,
      /marker:B-new-twin/,
      `${expectedBSlug}.md must hold B's content; got:\n${bContent}`,
    );

    // ── State assertions ─────────────────────────────────────────────────
    const finalState = JSON.parse(
      readFileSync(join(dir, `.vapi-state.${ENV}.json`), "utf-8"),
    );
    assert.equal(
      finalState.assistants.riley?.uuid,
      UUID_A,
      `state[riley] must still map to A (${UUID_A}); got ${JSON.stringify(finalState.assistants.riley)}`,
    );
    assert.equal(
      finalState.assistants[expectedBSlug]?.uuid,
      UUID_B,
      `state[${expectedBSlug}] must map to B (${UUID_B}); got ${JSON.stringify(finalState.assistants[expectedBSlug])}`,
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
