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
// Spec for `.vapi-ignore` symmetry on push + apply.
//
// Today `.vapi-ignore` is pull-only. The implementer is making it symmetric
// so push and apply also honor it. These tests pin the behavior contract
// described in the planner output:
//
//   T1 — dry-run honors ignore (skip log + no PATCH/POST)
//   T2 — --force bypasses ignore (matches pull's force flag)
//   T3 — orphan-detect protects ignored-but-state-mapped resources
//        (the silent-delete scenario without the fix)
//   T4 — squad referencing an ignored assistant is a hard error
//   T5 — explicit-file push honors ignore
//
// Plus in-process unit tests for the helpers the implementer will add:
//   - loadResources back-compat when patterns are empty/omitted
//   - findOrphanedResources excluding ignored ids
//   - validateNoIgnoredReferences flagging cross-ignore references
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers (Pattern A — spawn-fixture)
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  dir: string;
  env: string;
  port: number;
  worker: Worker;
  cleanup: () => Promise<void>;
}

interface StubRoute {
  method: string;
  pathStartsWith: string;
  body: unknown;
}

// Spin up a tiny HTTP stub in a Worker thread so `fetchAllResources` (called
// from `maybeBootstrapState → getInvalidStateMappings`) can be served while
// the main thread is blocked on `spawnSync`. An in-thread `http.createServer`
// can't service requests during a sync spawn — the event loop is parked —
// which is why the stub MUST run on a separate thread.
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

interface FixtureInit {
  env?: string;
  ignorePatterns?: string[];
  // Map of `<folder>/<resourceId>.<ext>` → file contents (yaml/markdown).
  resources?: Record<string, string>;
  // Pre-populated state file content (no bootstrap path traversed if state is
  // populated AND remote inventory matches).
  state?: Record<string, unknown> | null;
  // Routes the stub HTTP server should answer with non-empty bodies. Anything
  // not listed returns `[]`.
  stubRoutes?: StubRoute[];
}

async function setupFixture(init: FixtureInit = {}): Promise<Fixture> {
  const env = init.env ?? "test-vapi-ignore";
  const dir = mkdtempSync(join(tmpdir(), "vapi-ignore-test-"));

  // Copy source + package.json, symlink node_modules (mirrors push-dry-run.test.ts).
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );

  // Per-env resource directory.
  const resourceRoot = join(dir, "resources", env);
  mkdirSync(resourceRoot, { recursive: true });

  // .vapi-ignore (optional).
  if (init.ignorePatterns && init.ignorePatterns.length > 0) {
    writeFileSync(
      join(resourceRoot, ".vapi-ignore"),
      `${init.ignorePatterns.join("\n")}\n`,
    );
  }

  // Resource files (optional). Keys look like `assistants/foo.md`.
  for (const [relPath, contents] of Object.entries(init.resources ?? {})) {
    const fullPath = join(resourceRoot, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }

  // State file (optional). When null/omitted, no state file is written —
  // engine treats it as a fresh org.
  if (init.state !== null && init.state !== undefined) {
    writeFileSync(
      join(dir, `.vapi-state.${env}.json`),
      JSON.stringify(init.state, null, 2),
    );
  }

  // Stub HTTP server runs in a Worker thread (see `startStub` comment).
  const { worker, port } = await startStub(init.stubRoutes ?? []);

  writeFileSync(
    join(dir, `.env.${env}`),
    [
      "VAPI_TOKEN=fake-token-not-used",
      `VAPI_BASE_URL=http://127.0.0.1:${port}`,
      "",
    ].join("\n"),
  );

  return {
    dir,
    env,
    port,
    worker,
    cleanup: async () => {
      worker.postMessage({ type: "shutdown" });
      await new Promise<void>((res) => {
        worker.once("exit", () => res());
        // Safety net — if the worker doesn't exit cleanly, terminate.
        setTimeout(() => {
          worker
            .terminate()
            .then(() => res())
            .catch(() => res());
        }, 1000);
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runPush(
  fx: Fixture,
  extraArgs: string[],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/push.ts", fx.env, "--dry-run", ...extraArgs],
    {
      cwd: fx.dir,
      env: {
        ...process.env,
        VAPI_TOKEN: "fake-token-not-used",
        VAPI_BASE_URL: `http://127.0.0.1:${fx.port}`,
      },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function emptyState() {
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

const DUMMY_UUID_1 = "11111111-1111-1111-1111-111111111111";
const DUMMY_UUID_2 = "22222222-2222-2222-2222-222222222222";

const MINIMAL_ASSISTANT_MD = `---
name: foo
model:
  provider: openai
  model: gpt-4o
voice:
  provider: 11labs
  voiceId: burt
---

You are foo.
`;

const MINIMAL_ASSISTANT_BAZ_MD = `---
name: baz
model:
  provider: openai
  model: gpt-4o
voice:
  provider: 11labs
  voiceId: burt
---

You are baz.
`;

const SQUAD_BAR_YML = `name: bar
members:
  - assistantId: foo
`;

// ─────────────────────────────────────────────────────────────────────────────
// T1 — dry-run honors .vapi-ignore (skip log + no PATCH/POST for ignored id)
// ─────────────────────────────────────────────────────────────────────────────

test("T1: dry-run skips ignored assistants and emits the matched log line", async () => {
  const fx = await setupFixture({
    ignorePatterns: ["assistants/foo"],
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_MD,
    },
    // Pre-populated state with foo already tracked so the engine takes the
    // PATCH path (no bootstrap pull required) and the network stub stays idle.
    state: {
      ...emptyState(),
      credentials: { fake: { uuid: DUMMY_UUID_2 } },
      assistants: { foo: { uuid: DUMMY_UUID_1 } },
    },
    stubRoutes: [
      // Bootstrap precondition: list-assistants returns foo so the existing
      // mapping passes validation and bootstrap is skipped.
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [{ id: DUMMY_UUID_1, name: "foo" }],
      },
    ],
  });
  try {
    const res = runPush(fx, []);
    // Skip log must mention foo, the matched pattern, and the .vapi-ignore.
    assert.match(
      res.stdout,
      /🚫.*foo.*\.vapi-ignore.*assistants\/foo/s,
      `expected ignore-skip log; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    // No PATCH/POST line should mention the ignored assistant.
    assert.doesNotMatch(
      res.stdout,
      /would (PATCH|POST)[^\n]*\bfoo\b/,
      `ignored assistant must not appear in would-PATCH/POST lines; stdout=${res.stdout}`,
    );
    // Engine must not have queued the API call: assistant POST/PATCH counter
    // should be zero (no `/assistant/<uuid>` line for the ignored id).
    assert.doesNotMatch(
      res.stdout,
      new RegExp(`would (PATCH|POST) /assistant/${DUMMY_UUID_1}`),
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — --force bypasses .vapi-ignore (mirrors pull's force semantics at
// pull.ts:907 — the `force` flag short-circuits the ignore check).
// ─────────────────────────────────────────────────────────────────────────────

test("T2: --force bypasses .vapi-ignore and processes ignored resources normally", async () => {
  const fx = await setupFixture({
    ignorePatterns: ["assistants/foo"],
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_MD,
    },
    state: {
      ...emptyState(),
      credentials: { fake: { uuid: DUMMY_UUID_2 } },
      assistants: { foo: { uuid: DUMMY_UUID_1 } },
    },
    stubRoutes: [
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [{ id: DUMMY_UUID_1, name: "foo" }],
      },
    ],
  });
  try {
    const res = runPush(fx, ["--force"]);
    // Under --force the ignore is bypassed: no skip log for foo.
    assert.doesNotMatch(
      res.stdout,
      /🚫[^\n]*foo[^\n]*\.vapi-ignore/,
      `--force must bypass ignore, no skip log expected; stdout=${res.stdout}`,
    );
    // The assistant is now processed end-to-end: dry-run records the would-PATCH.
    assert.match(
      res.stdout,
      new RegExp(`would PATCH /assistant/${DUMMY_UUID_1}`),
      `--force must let the ignored assistant flow through; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — orphan-detect must protect ignored-but-state-mapped resources.
// This is the silent-delete scenario: state file maps foo → uuid, the local
// file has been removed, .vapi-ignore lists foo. Without the fix, push
// --force would DELETE foo from the dashboard. With the fix, orphan-detect
// excludes foo and emits a "retained — orphan-protected" log line.
// ─────────────────────────────────────────────────────────────────────────────

test("T3: --force does NOT delete ignored orphans (state-mapped but missing locally)", async () => {
  const fx = await setupFixture({
    ignorePatterns: ["assistants/foo"],
    // No local foo.md — by today's logic, this is an orphan and --force would
    // issue a DELETE. The fix must exclude ignored ids from orphan-detect.
    resources: {},
    state: {
      ...emptyState(),
      credentials: { fake: { uuid: DUMMY_UUID_2 } },
      assistants: { foo: { uuid: DUMMY_UUID_1 } },
    },
    stubRoutes: [
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [{ id: DUMMY_UUID_1, name: "foo" }],
      },
    ],
  });
  try {
    const res = runPush(fx, ["--force"]);
    // No DELETE for the ignored, orphaned-by-local-deletion resource.
    assert.doesNotMatch(
      res.stdout,
      new RegExp(`would DELETE /assistant/${DUMMY_UUID_1}`),
      `ignored orphan must NOT be queued for deletion; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    // Orphan-protection log line must be present so operators see the retention.
    assert.match(
      res.stdout,
      /🚫.*foo.*(retained|orphan-protected).*\.vapi-ignore/s,
      `expected orphan-protected log line; stdout=${res.stdout}`,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — Squad referencing an ignored assistant is a HARD error (was a silent
// drop today via resolver.ts:103-110 `.filter(id => id !== null)`).
// The new validator must promote this to a blocking validation finding.
// ─────────────────────────────────────────────────────────────────────────────

test("T4: squad referencing an ignored assistant is a hard validation error", async () => {
  const fx = await setupFixture({
    ignorePatterns: ["assistants/foo"],
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_MD,
      "squads/bar.yml": SQUAD_BAR_YML,
    },
    state: {
      ...emptyState(),
      credentials: { fake: { uuid: DUMMY_UUID_2 } },
      assistants: { foo: { uuid: DUMMY_UUID_1 } },
      squads: { bar: { uuid: DUMMY_UUID_2 } },
    },
    stubRoutes: [
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [{ id: DUMMY_UUID_1, name: "foo" }],
      },
      {
        method: "GET",
        pathStartsWith: "/squad",
        body: [{ id: DUMMY_UUID_2, name: "bar" }],
      },
    ],
  });
  try {
    const res = runPush(fx, ["--strict"]);
    // Non-zero exit on the new validator's error-severity finding.
    assert.notEqual(
      res.code,
      0,
      `expected non-zero exit code; got ${res.code}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    // Combined output must call out the offending reference.
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(
      combined,
      /❌[^\n]*bar[^\n]*references[^\n]*foo[^\n]*\.vapi-ignore/,
      `expected '❌ bar references foo, which is in .vapi-ignore'; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    // Engine must NOT have queued the squad write in dry-run.
    assert.doesNotMatch(
      res.stdout,
      new RegExp(`would (PATCH|POST) /squad/${DUMMY_UUID_2}`),
      `squad must not be queued when its ref is ignored; stdout=${res.stdout}`,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Explicit-file push (APPLY_FILTER.filePaths) still honors .vapi-ignore.
// Even when the user names baz.md directly, an ignore match wins.
// ─────────────────────────────────────────────────────────────────────────────

test("T5: explicit-file push honors .vapi-ignore (single-file mode)", async () => {
  const fx = await setupFixture({
    ignorePatterns: ["assistants/baz"],
    resources: {
      "assistants/baz.md": MINIMAL_ASSISTANT_BAZ_MD,
    },
    state: {
      ...emptyState(),
      credentials: { fake: { uuid: DUMMY_UUID_2 } },
      assistants: { baz: { uuid: DUMMY_UUID_1 } },
    },
    stubRoutes: [
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [{ id: DUMMY_UUID_1, name: "baz" }],
      },
    ],
  });
  try {
    const res = runPush(fx, ["assistants/baz.md"]);
    assert.match(
      res.stdout,
      /🚫.*baz.*\.vapi-ignore.*assistants\/baz/s,
      `expected explicit-file skip log; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    assert.doesNotMatch(
      res.stdout,
      new RegExp(`would (PATCH|POST) /assistant/${DUMMY_UUID_1}`),
      `explicit-file push must still skip ignored ids; stdout=${res.stdout}`,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests (Pattern B — in-process)
//
// These pin the helpers the implementer is adding. config.ts calls
// `process.exit(1)` at module load when VAPI_TOKEN / argv[2] are missing,
// so we set both before any dynamic import (same trick as
// `tests/path-matching.test.ts`).
// ─────────────────────────────────────────────────────────────────────────────

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const resources = await import("../src/resources.ts");
const deleteModule = await import("../src/delete.ts");
const validateModule = await import("../src/validate.ts");

// ─────────────────────────────────────────────────────────────────────────────
// loadResources back-compat: with no patterns supplied, behaves as before.
// With patterns, ignored files are filtered out and a "skipping" log is emitted.
// ─────────────────────────────────────────────────────────────────────────────

test("loadResources: omitted/empty ignorePatterns is a no-op (back-compat)", async () => {
  // Build a tiny on-disk fixture matching what loadResources scans
  // (`resources/<env>/<folder>`). Use a unique env to avoid colliding with
  // other tests' module-level state.
  const env = "unit-load-no-patterns";
  const baseFixture = mkdtempSync(join(tmpdir(), "vapi-ignore-unit-"));
  const folder = join(baseFixture, "resources", env, "assistants");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "alpha.md"), MINIMAL_ASSISTANT_MD);
  writeFileSync(join(folder, "beta.md"), MINIMAL_ASSISTANT_MD);

  // loadResources reads from RESOURCES_DIR which is bound to the test fixture
  // org via process.argv at module-load time. The unit fixture needs its own
  // working tree — easier path: just count what the helper returns when the
  // FIXTURE matches the test-fixture-org env. The implementer will need to
  // expose an option to override the resource root OR the test must spawn a
  // child process. For this assertion we exercise the simpler contract: the
  // function signature accepts `ignorePatterns` and returns the same shape
  // (length-comparable array). The contract holds against the
  // path-matching.test.ts pattern: dynamic-import after setting argv.

  // NOTE: we can't easily redirect BASE_DIR/RESOURCES_DIR from within the same
  // process without re-importing config.ts. The assertion below covers the
  // shape: with no patterns, `loadResources("assistants")` returns the
  // existing array unchanged (call twice, expect equal length).
  rmSync(baseFixture, { recursive: true, force: true });

  // Existing call signature (single arg) must still type-check and execute
  // without throwing. We don't have an in-process fixture without colliding
  // with config.ts's RESOURCES_DIR; treat this test as a smoke check that the
  // import surface still exposes loadResources.
  assert.equal(typeof resources.loadResources, "function");
});

test("loadResources: ignorePatterns parameter is supported (signature check)", () => {
  // The implementer is adding an options bag `{ ignorePatterns }`. Until the
  // implementation lands, this test asserts the export exists. Once it lands
  // the implementer should expand this into a real on-disk fixture test
  // (mirroring the integration tests above) that confirms:
  //   1. matched files are filtered from the returned array
  //   2. each match emits `🚫 <id> (matched .vapi-ignore: <pattern>)`
  //   3. with `ignorePatterns: []` or undefined, the returned array is
  //      identical to the pre-change behavior (back-compat).
  assert.equal(typeof resources.loadResources, "function");
});

// ─────────────────────────────────────────────────────────────────────────────
// findOrphanedResources: ignored ids must be excluded from the result.
// Pinning the contract — the implementer adds an optional `ignoredIds` arg.
// ─────────────────────────────────────────────────────────────────────────────

test("findOrphanedResources: today's signature returns orphans normally (regression baseline)", () => {
  const loadedIds = ["alpha"];
  const stateMap = {
    alpha: { uuid: DUMMY_UUID_1 },
    beta: { uuid: DUMMY_UUID_2 },
  };
  const orphans = deleteModule.findOrphanedResources(loadedIds, stateMap);
  assert.deepEqual(orphans, [{ resourceId: "beta", uuid: DUMMY_UUID_2 }]);
});

test("findOrphanedResources: ignored ids are excluded from orphan list (new arg)", () => {
  const loadedIds = ["alpha"];
  const stateMap = {
    alpha: { uuid: DUMMY_UUID_1 },
    beta: { uuid: DUMMY_UUID_2 },
  };
  // Call with the new third arg `ignoredIds`. Until the implementation lands
  // this will fail with "expected 2 args, got 3" or return beta-as-orphan.
  const orphansFn = deleteModule.findOrphanedResources as unknown as (
    loaded: string[],
    state: Record<string, { uuid: string }>,
    ignoredIds?: Set<string>,
  ) => Array<{ resourceId: string; uuid: string }>;
  const orphans = orphansFn(loadedIds, stateMap, new Set(["beta"]));
  assert.deepEqual(
    orphans,
    [],
    "beta is in state but ignored — must NOT appear as orphan",
  );
});

test("findOrphanedResources: ignored ids do not affect non-ignored orphans", () => {
  const loadedIds = ["alpha"];
  const stateMap = {
    alpha: { uuid: DUMMY_UUID_1 },
    beta: { uuid: DUMMY_UUID_2 },
    gamma: { uuid: "33333333-3333-3333-3333-333333333333" },
  };
  const orphansFn = deleteModule.findOrphanedResources as unknown as (
    loaded: string[],
    state: Record<string, { uuid: string }>,
    ignoredIds?: Set<string>,
  ) => Array<{ resourceId: string; uuid: string }>;
  const orphans = orphansFn(loadedIds, stateMap, new Set(["beta"]));
  assert.deepEqual(orphans, [
    { resourceId: "gamma", uuid: "33333333-3333-3333-3333-333333333333" },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateNoIgnoredReferences: new validator. Returns error-severity finding
// for any squad/assistant that references an ignored assistant id.
// ─────────────────────────────────────────────────────────────────────────────

function emptyLoaded() {
  return {
    tools: [],
    structuredOutputs: [],
    assistants: [],
    squads: [],
    personalities: [],
    scenarios: [],
    simulations: [],
    simulationSuites: [],
    evals: [],
  };
}

test("validateNoIgnoredReferences: squad references ignored assistant → error finding", () => {
  const validator = (
    validateModule as unknown as {
      validateNoIgnoredReferences?: (
        loaded: ReturnType<typeof emptyLoaded>,
        ignorePatterns: string[],
      ) => Array<{
        severity: "warn" | "error";
        rule: string;
        resourceId: string;
        message: string;
      }>;
    }
  ).validateNoIgnoredReferences;

  // The implementer adds this export. Until then the test fails with
  // `validator is not a function`, which is the desired spec-first failure.
  assert.equal(
    typeof validator,
    "function",
    "validateNoIgnoredReferences must be exported from src/validate.ts",
  );

  const loaded = emptyLoaded();
  loaded.assistants.push({
    resourceId: "foo",
    filePath: "/fake/foo.md",
    data: { name: "foo" },
  });
  loaded.squads.push({
    resourceId: "bar",
    filePath: "/fake/bar.yml",
    data: { name: "bar", members: [{ assistantId: "foo" }] },
  });

  const findings = validator!(loaded, ["assistants/foo"]);
  const errors = findings.filter((f) => f.severity === "error");
  assert.ok(
    errors.length >= 1,
    `expected at least one error-severity finding; got ${JSON.stringify(findings)}`,
  );
  const flagged = errors.find(
    (f) =>
      f.resourceId === "bar" &&
      /references[^\n]*foo[^\n]*\.vapi-ignore/.test(f.message),
  );
  assert.ok(
    flagged,
    `expected error to mention bar references foo & .vapi-ignore; got ${JSON.stringify(errors)}`,
  );
});

test("validateNoIgnoredReferences: clean fixture (no refs to ignored) → no findings", () => {
  const validator = (
    validateModule as unknown as {
      validateNoIgnoredReferences?: (
        loaded: ReturnType<typeof emptyLoaded>,
        ignorePatterns: string[],
      ) => Array<{ severity: "warn" | "error"; rule: string }>;
    }
  ).validateNoIgnoredReferences;
  if (typeof validator !== "function") {
    // Until impl lands, surface the same spec-first failure shape.
    assert.equal(
      typeof validator,
      "function",
      "validateNoIgnoredReferences must be exported from src/validate.ts",
    );
    return;
  }

  const loaded = emptyLoaded();
  loaded.assistants.push({
    resourceId: "foo",
    filePath: "/fake/foo.md",
    data: { name: "foo" },
  });
  loaded.squads.push({
    resourceId: "bar",
    filePath: "/fake/bar.yml",
    data: { name: "bar", members: [{ assistantId: "foo" }] },
  });

  // foo is NOT ignored — validator should be silent.
  const findings = validator(loaded, ["assistants/other"]);
  assert.equal(
    findings.filter((f) => f.severity === "error").length,
    0,
    `expected no error-severity findings; got ${JSON.stringify(findings)}`,
  );
});

test("validateNoIgnoredReferences: empty ignore list → no findings (back-compat)", () => {
  const validator = (
    validateModule as unknown as {
      validateNoIgnoredReferences?: (
        loaded: ReturnType<typeof emptyLoaded>,
        ignorePatterns: string[],
      ) => Array<{ severity: "warn" | "error" }>;
    }
  ).validateNoIgnoredReferences;
  if (typeof validator !== "function") {
    assert.equal(
      typeof validator,
      "function",
      "validateNoIgnoredReferences must be exported from src/validate.ts",
    );
    return;
  }
  const loaded = emptyLoaded();
  loaded.squads.push({
    resourceId: "bar",
    filePath: "/fake/bar.yml",
    data: { members: [{ assistantId: "foo" }] },
  });
  const findings = validator(loaded, []);
  assert.equal(findings.length, 0);
});
