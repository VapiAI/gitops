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
import { parseResourceDataFromFile } from "../src/resource-parse.ts";
import { hashPayload } from "../src/state-serialize.ts";

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
// Reproduces the "5 Rileys" customer scenario that will keep getting
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
      const requests = [];
      const server = http.createServer((req, res) => {
        const url = req.url || '';
        const method = (req.method || 'GET').toUpperCase();
        requests.push({ method, url });
        if (url === '/__requests') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(requests));
          return;
        }
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

// Run the full clobber scenario with a configurable dashboard-response
// ordering. Asserts the fix works regardless of which Riley the API
// returns first — this is the H1 case from code review: without merging
// the prior-pull state into the adoption guard, B-first ordering would
// clobber A's file because `newStateSection` is empty when B is
// processed.
async function runClobberScenario(
  testName: string,
  dashboardOrder: "A-first" | "B-first",
  untracked = false,
  bootstrap = false,
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

  // Seed the resource tree: existing `riley.md` holding A's content.
  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });
  writeFileSync(join(assistantsDir, "riley.md"), PREEXISTING_RILEY_MD);

  // Seed state: slug `riley` already maps to UUID A.
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
          ...(untracked ? {} : { riley: { uuid: UUID_A } }),
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

  // HTTP stub returns BOTH Rileys (A and B) for the /assistant list call,
  // in the configured order. The fix must produce the correct outcome
  // regardless of which one the dashboard returns first.
  const orderedBodies =
    dashboardOrder === "A-first"
      ? [
          rileyDashboardBody(UUID_A, "A-fresh-from-platform"),
          rileyDashboardBody(UUID_B, "B-new-twin"),
        ]
      : [
          rileyDashboardBody(UUID_B, "B-new-twin"),
          rileyDashboardBody(UUID_A, "A-fresh-from-platform"),
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
    // and short-circuit the platform overwrite of riley.md (we want pull
    // to actually try to write riley.md — the question is whether B's
    // content lands there or A's content stays).
    const res = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "src/pull.ts",
        ENV,
        "--force",
        ...(bootstrap ? ["--bootstrap"] : []),
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

    assert.equal(
      res.status,
      0,
      `[${testName}] pull exit code ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // ── Filesystem assertions ────────────────────────────────────────────
    // riley.md must still exist AND hold A's content (the platform's
    // A-fresh-from-platform marker, since --force overwrites with platform
    // state — but NOT B's content).
    const rileyPath = join(assistantsDir, "riley.md");
    assert.ok(existsSync(rileyPath), `[${testName}] riley.md must still exist`);
    const rileyContent = readFileSync(rileyPath, "utf-8");
    assert.match(
      rileyContent,
      untracked ? /marker:A-original/ : /marker:A-fresh-from-platform/,
      `[${testName}] riley.md must hold A's content (the file mapped to A in state); got:\n${rileyContent}`,
    );
    assert.doesNotMatch(
      rileyContent,
      /marker:B-new-twin/,
      `[${testName}] riley.md must NOT have been clobbered by B; got:\n${rileyContent}`,
    );

    if (bootstrap) {
      assert.deepEqual(readdirSync(assistantsDir), ["riley.md"]);
    } else {
      // B must have landed in its own file `riley-<B[:8]>.md`.
      const expectedBSlug = `riley-${UUID_B.slice(0, 8)}`;
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
    }

    // ── State assertions ─────────────────────────────────────────────────
    const finalState = JSON.parse(
      readFileSync(join(dir, `.vapi-state.${ENV}.json`), "utf-8"),
    );
    assert.equal(
      finalState.assistants.riley?.uuid,
      untracked ? undefined : UUID_A,
      `[${testName}] state[riley] must still map to A (${UUID_A}); got ${JSON.stringify(finalState.assistants.riley)}`,
    );
    const expectedBSlug = `riley-${UUID_B.slice(0, 8)}`;
    assert.equal(
      finalState.assistants[expectedBSlug]?.uuid,
      UUID_B,
      `[${testName}] state[${expectedBSlug}] must map to B (${UUID_B}); got ${JSON.stringify(finalState.assistants[expectedBSlug])}`,
    );
    assert.equal(finalState.assistants[expectedBSlug].origin, "pulled");
    if (!untracked)
      assert.deepEqual(finalState.assistants.riley, { uuid: UUID_A });
    else
      assert.equal(
        finalState.assistants[`riley-${UUID_A.slice(0, 8)}`].origin,
        "pulled",
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
  // sees `riley.md` as "unclaimed in flight" — but prior state has it).
  await runClobberScenario("B-first", "B-first");
});

test("pull: untracked same-name remote leaves local file alone", async () => {
  await runClobberScenario("untracked", "A-first", true);
});

test("bootstrap pull: records pulled origin without linking local file", async () => {
  await runClobberScenario("bootstrap", "A-first", true, true);
});

test("push POST records pushed provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-post-origin-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  const { worker, port } = await startStub([
    {
      method: "POST",
      pathStartsWith: "/tool",
      body: { id: UUID_A, type: "endCall" },
    },
  ]);
  try {
    const script = `
      process.argv = ["node", "test", "test-origin"];
      const { applyTool } = await import("./src/push.ts");
      const { createEmptyState } = await import("./src/state.ts");
      const state = createEmptyState();
      await applyTool({ resourceId: "stop", data: { type: "endCall" } }, state);
      console.log("STATE:" + JSON.stringify(state.tools.stop));
    `;
    const result = spawnSync(
      "node",
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          VAPI_TOKEN: "fake-token-not-used",
          VAPI_BASE_URL: `http://127.0.0.1:${port}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /STATE:{"uuid":"aaaaaaaa-1111-1111-1111-111111111111","origin":"pushed"}/,
    );
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["push", "dry-run", "apply"]) {
  const dryRun = mode === "dry-run";
  test(`push --adopt integrates lookup, scoped PATCH, provenance in ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-adopt-cli-"));
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    const assistantsDir = join(dir, "resources", ENV, "assistants");
    mkdirSync(assistantsDir, { recursive: true });
    writeFileSync(join(assistantsDir, "riley.md"), PREEXISTING_RILEY_MD);
    const statePath = join(dir, `.vapi-state.${ENV}.json`);
    const initial = JSON.stringify({
      assistants: { "riley-aaaaaaaa": { uuid: UUID_A, origin: "pulled" } },
      credentials: { fake: { uuid: "cred" } },
    });
    writeFileSync(statePath, initial);
    const { worker, port } = await startStub([
      {
        method: "GET",
        pathStartsWith: `/assistant/${UUID_A}`,
        body: rileyDashboardBody(UUID_A, "A"),
      },
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [rileyDashboardBody(UUID_A, "A")],
      },
      {
        method: "PATCH",
        pathStartsWith: `/assistant/${UUID_A}`,
        body: rileyDashboardBody(UUID_A, "patched"),
      },
    ]);
    try {
      const res = spawnSync(
        "node",
        [
          "--import",
          "tsx",
          mode === "apply" ? "src/apply.ts" : "src/push.ts",
          ENV,
          ...(dryRun ? ["--dry-run", "--adopt=riley"] : ["--adopt", "riley"]),
          "assistants/riley.md",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            VAPI_PRIVATE_API_KEY: "fake-token-not-used",
            VAPI_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, dryRun ? /would adopt riley/ : /Adopting riley/);
      assert.match(res.stdout, /Updating assistant: riley/);
      assert.doesNotMatch(res.stdout, /Creating assistant|Push refused/);
      if (dryRun) {
        assert.equal(readFileSync(statePath, "utf8"), initial);
        assert.match(res.stdout, /would PATCH/);
      } else {
        const saved = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(saved.assistants.riley, {
          uuid: UUID_A,
          origin: "adopted",
        });
        assert.equal(saved.assistants["riley-aaaaaaaa"], undefined);
      }
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const origin of ["pulled", undefined, "pushed", "dashboard"] as const) {
  test(`dependency auto-apply with ${origin} name match uses only owned UUIDs`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-dep-origin-"));
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    const { worker, port } = await startStub([
      {
        method: "POST",
        pathStartsWith: "/tool",
        body: { id: UUID_B, type: "endCall" },
      },
      {
        method: "GET",
        pathStartsWith: `/tool/${UUID_A}`,
        body: { id: UUID_A, type: "endCall" },
      },
      {
        method: "PATCH",
        pathStartsWith: `/tool/${UUID_A}`,
        body: { id: UUID_A, type: "endCall" },
      },
    ]);
    try {
      const script = `
        process.argv = ["node", "test", "test-origin"];
        const { applyTool } = await import("./src/push.ts");
        const { reconcileStateKeyForResource } = await import("./src/reconcile-state-key.ts");
        const { createEmptyState } = await import("./src/state.ts");
        const state = createEmptyState();
        ${origin === "dashboard" ? "" : `state.tools["stop-aaaaaaaa"] = ${JSON.stringify({ uuid: UUID_A, ...(origin ? { origin } : {}) })};`}
        const touched = Object.fromEntries(Object.keys(state).map(k => [k, new Set()]));
        const applied = Object.fromEntries(Object.keys(state).map(k => [k, 0]));
        await reconcileStateKeyForResource({
          resourceType: "tools", resource: { resourceId: "stop", filePath: "tools/stop.yml", data: { type: "endCall", function: { name: "stop" } } },
          state, touched, applied, autoApplied: new Set(), pushToAutoAppliedList: () => {},
          getRemoteList: async () => [{ id: "${UUID_A}", function: { name: "stop" } }],
          applyFn: applyTool, vapiEnv: "test-origin", formatError: (_,e) => String(e),
        });
        console.log("FINAL:" + JSON.stringify(state.tools.stop));
      `;
      const res = spawnSync(
        "node",
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            VAPI_PRIVATE_API_KEY: "fake-token-not-used",
            VAPI_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(
        res.stdout,
        origin === "pushed" ? /Updating tool: stop/ : /Creating tool: stop/,
      );
      assert.match(
        res.stdout,
        new RegExp(origin === "pushed" ? UUID_A : UUID_B),
      );
      if (origin !== "pushed") {
        assert.match(
          res.stderr,
          /tools.*stop.*aaaaaaaa-1111-1111-1111-111111111111.*--adopt stop/,
        );
      }
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const command of ["push", "apply"]) {
  test(`${command} dry-run lists top-level and dependency collisions without writes or mutations`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-collisions-"));
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    const assistantsDir = join(dir, "resources", ENV, "assistants");
    const toolsDir = join(dir, "resources", ENV, "tools");
    mkdirSync(assistantsDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });
    const local = PREEXISTING_RILEY_MD.replace(
      "model:\n",
      "model:\n  toolIds:\n    - stop\n",
    );
    writeFileSync(join(assistantsDir, "riley.md"), local);
    writeFileSync(
      join(toolsDir, "stop.yml"),
      "type: endCall\nfunction:\n  name: stop\n",
    );
    const statePath = join(dir, `.vapi-state.${ENV}.json`);
    const initial = JSON.stringify({
      assistants: { "riley-aaaaaaaa": { uuid: UUID_A, origin: "pulled" } },
      tools: { "stop-aaaaaaaa": { uuid: UUID_A, origin: "pulled" } },
      credentials: { fake: { uuid: "cred" } },
    });
    writeFileSync(statePath, initial);
    const { worker, port } = await startStub([
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [rileyDashboardBody(UUID_A, "existing")],
      },
      {
        method: "GET",
        pathStartsWith: "/tool",
        body: [{ id: UUID_B, type: "endCall", function: { name: "stop" } }],
      },
    ]);
    try {
      const res = spawnSync(
        "node",
        [
          "--import",
          "tsx",
          `src/${command}.ts`,
          ENV,
          "--dry-run",
          "--allow-new-files",
          "assistants/riley.md",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            VAPI_PRIVATE_API_KEY: "fake-token-not-used",
            VAPI_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const section = res.stdout.slice(
        res.stdout.lastIndexOf("Name collisions:"),
      );
      assert.match(
        section,
        new RegExp(
          `assistants "Riley" \\(${UUID_A}\\).*would create a new resource; --adopt riley to take this over`,
        ),
      );
      assert.match(
        section,
        new RegExp(`tools "stop" \\(${UUID_A}\\).*--adopt stop`),
      );
      assert.match(
        section,
        new RegExp(`tools "stop" \\(${UUID_B}\\).*--adopt stop`),
      );
      assert.equal(readFileSync(statePath, "utf8"), initial);
      assert.equal(
        readFileSync(join(assistantsDir, "riley.md"), "utf8"),
        local,
      );
      const requests = (await (
        await fetch(`http://127.0.0.1:${port}/__requests`)
      ).json()) as { method: string; url: string }[];
      assert.ok(requests.some((r) => r.url.startsWith("/tool")));
      assert.ok(requests.some((r) => r.url.startsWith("/assistant")));
      assert.ok(
        requests.every((r) => r.method === "GET"),
        JSON.stringify(requests),
      );
      assert.equal(existsSync(join(dir, ".vapi-state-hash")), false);
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const mode of ["push", "apply", "dry-run", "edited", "missing-baseline"]) {
  test(`adoption cleans alias files safely: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-alias-"));
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    const assistants = join(dir, "resources", ENV, "assistants");
    mkdirSync(assistants, { recursive: true });
    writeFileSync(join(assistants, "riley.md"), PREEXISTING_RILEY_MD);
    const alias = join(assistants, "riley-aaaaaaaa.md");
    writeFileSync(alias, PREEXISTING_RILEY_MD.replace("A-original", "A"));
    const hashes = join(dir, ".vapi-state-hash", ENV);
    mkdirSync(hashes, { recursive: true });
    if (mode !== "missing-baseline")
      writeFileSync(
        join(hashes, UUID_A),
        hashPayload(parseResourceDataFromFile(alias)),
      );
    if (mode === "edited")
      writeFileSync(
        alias,
        PREEXISTING_RILEY_MD.replace("A-original", "edited"),
      );
    const originalAlias = readFileSync(alias, "utf8");
    const statePath = join(dir, `.vapi-state.${ENV}.json`);
    const initial = JSON.stringify({
      assistants: { "riley-aaaaaaaa": { uuid: UUID_A, origin: "pulled" } },
      credentials: { fake: { uuid: "cred" } },
    });
    writeFileSync(statePath, initial);
    const { worker, port } = await startStub([
      {
        method: "GET",
        pathStartsWith: `/assistant/${UUID_A}`,
        body: rileyDashboardBody(UUID_A, "A"),
      },
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [rileyDashboardBody(UUID_A, "A")],
      },
      {
        method: "PATCH",
        pathStartsWith: "/assistant",
        body: rileyDashboardBody(UUID_A, "A-original"),
      },
    ]);
    const run = (command: string, args: string[]) =>
      spawnSync(
        "node",
        ["--import", "tsx", `src/${command}.ts`, ENV, ...args],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            VAPI_PRIVATE_API_KEY: "fake-token-not-used",
            VAPI_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
    try {
      const res = run(mode === "apply" ? "apply" : "push", [
        "--adopt",
        "riley",
        ...(mode === "dry-run" ? ["--dry-run"] : []),
      ]);
      const blocked = mode === "edited" || mode === "missing-baseline";
      assert.equal(res.status, blocked ? 1 : 0, res.stdout + res.stderr);
      if (blocked || mode === "dry-run") {
        assert.equal(readFileSync(alias, "utf8"), originalAlias);
        assert.equal(readFileSync(statePath, "utf8"), initial);
        assert.match(
          res.stdout + res.stderr,
          blocked ? /Delete it by hand/ : /would delete .*riley-aaaaaaaa.md/,
        );
        const requests = (await (
          await fetch(`http://127.0.0.1:${port}/__requests`)
        ).json()) as { method: string }[];
        assert.ok(requests.every((r) => r.method === "GET"));
      } else {
        assert.equal(existsSync(alias), false);
        assert.match(
          res.stdout,
          /Deleted .*riley-aaaaaaaa.md: same remote resource, now adopted as riley/,
        );
        assert.deepEqual(
          JSON.parse(readFileSync(statePath, "utf8")).assistants,
          { riley: { uuid: UUID_A, origin: "adopted" } },
        );
        const next = run("push", []);
        assert.doesNotMatch(
          next.stdout + next.stderr,
          /Push refused|Files without state entry/,
        );
        assert.equal(existsSync(alias), false);
      }
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
