import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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

// ─────────────────────────────────────────────────────────────────────────────
// `pull --force` prunes stale TRACKED files — and nothing else.
//
// Before this behavior existed, a resource deleted on the dashboard dropped
// out of the rewritten state file while its local file stayed behind, with no
// output mentioning it. The file became an untracked orphan that later failed
// push's orphan gate (or got recreated by `--allow-new-files`).
//
// The contract these tests pin, per src/prune.ts:
//
//   A. force + tracked + gone (GET 404)        → file deleted, state + baseline gone
//   B. force + tracked + still returned by GET → retained, warned (listing was incomplete)
//   C. force + untracked local file            → retained, untouched
//   D. force + .vapi-ignore match              → retained, 🚫 logged
//   E. plain pull, same fixture                → everything retained + warned
//   F. --id-scoped force pull                  → prunes nothing
//   G. tracked TypeScript authoring file        → same rules as YAML/Markdown
//   H. malformed state path                     → cannot escape resource root
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface StubRoute {
  method: string;
  pathStartsWith: string;
  body: unknown;
  status?: number;
}

// Routes are matched in order by prefix, so `/assistant/<uuid>` entries must
// precede the `/assistant` list route.
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
        res.statusCode = match && match.status ? match.status : 200;
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

async function shutdownStub(worker: Worker): Promise<void> {
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
}

const ENV = "test-prune";

const UUID_STALE = "aaaaaaaa-1111-4111-8111-111111111111";
const UUID_LIVE = "bbbbbbbb-2222-4222-8222-222222222222";
const UUID_IGNORED = "cccccccc-3333-4333-8333-333333333333";
const UUID_UNCONFIRMED = "dddddddd-4444-4444-8444-444444444444";
const UUID_STALE_TS = "eeeeeeee-5555-4555-8555-555555555555";
const UUID_TRAVERSAL = "ffffffff-6666-4666-8666-666666666666";
const UUID_NO_FILE = "99999999-7777-4777-8777-777777777777";

const SLUG_STALE = "stale-agent-aaaaaaaa";
const SLUG_LIVE = "live-agent-bbbbbbbb";
const SLUG_IGNORED = "ignored-agent-cccccccc";
const SLUG_UNCONFIRMED = "unconfirmed-agent-dddddddd";
const SLUG_STALE_TS = "stale-ts-agent-eeeeeeee";
const SLUG_TRAVERSAL = "../../../outside-victim";
const SLUG_NO_FILE = "already-absent-agent-99999999";
const SLUG_UNTRACKED = "untracked-agent";

function assistantBody(id: string, name: string, marker: string) {
  return {
    id,
    orgId: "org-test",
    name,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: marker }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

function localMd(name: string, marker: string): string {
  return `---
model:
  provider: openai
  model: gpt-4o
name: ${name}
voice:
  provider: 11labs
  voiceId: burt
---

${marker}
`;
}

interface Fixture {
  dir: string;
  assistantsDir: string;
  hashDir: string;
  outsideVictim: string;
}

// A repo copy with six in-tree local files, state entries for five of them,
// plus malformed-path and no-file state ghosts. Every state UUID has a
// baseline.
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vapi-pull-prune-"));

  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");

  const assistantsDir = join(dir, "resources", ENV, "assistants");
  mkdirSync(assistantsDir, { recursive: true });

  writeFileSync(
    join(assistantsDir, `${SLUG_STALE}.md`),
    localMd("Stale Agent", "marker:stale-local"),
  );
  writeFileSync(
    join(assistantsDir, `${SLUG_LIVE}.md`),
    localMd("Live Agent", "marker:live-local"),
  );
  writeFileSync(
    join(assistantsDir, `${SLUG_IGNORED}.md`),
    localMd("Ignored Agent", "marker:ignored-local"),
  );
  writeFileSync(
    join(assistantsDir, `${SLUG_UNCONFIRMED}.md`),
    localMd("Unconfirmed Agent", "marker:unconfirmed-local"),
  );
  writeFileSync(
    join(assistantsDir, `${SLUG_STALE_TS}.ts`),
    "export default { name: 'Stale TypeScript Agent' };\n",
  );
  // No state entry: a genuinely new / hand-copied file. Must never be touched.
  writeFileSync(
    join(assistantsDir, `${SLUG_UNTRACKED}.yml`),
    "name: Untracked Agent\n",
  );
  const outsideVictim = join(dir, "outside-victim.md");
  writeFileSync(outsideVictim, "must not be deleted\n");

  writeFileSync(
    join(dir, "resources", ENV, ".vapi-ignore"),
    `# protects a resource this repo does not manage\nassistants/${SLUG_IGNORED}\n`,
  );

  writeFileSync(
    join(dir, `.vapi-state.${ENV}.json`),
    JSON.stringify(
      {
        credentials: {},
        assistants: {
          [SLUG_STALE]: { uuid: UUID_STALE },
          [SLUG_LIVE]: { uuid: UUID_LIVE },
          [SLUG_IGNORED]: { uuid: UUID_IGNORED },
          [SLUG_UNCONFIRMED]: { uuid: UUID_UNCONFIRMED },
          [SLUG_STALE_TS]: { uuid: UUID_STALE_TS },
          [SLUG_TRAVERSAL]: { uuid: UUID_TRAVERSAL },
          [SLUG_NO_FILE]: { uuid: UUID_NO_FILE },
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

  const hashDir = join(dir, ".vapi-state-hash", ENV);
  mkdirSync(hashDir, { recursive: true });
  for (const uuid of [
    UUID_STALE,
    UUID_LIVE,
    UUID_IGNORED,
    UUID_UNCONFIRMED,
    UUID_STALE_TS,
    UUID_TRAVERSAL,
    UUID_NO_FILE,
  ]) {
    writeFileSync(join(hashDir, uuid), "seeded-baseline\n");
  }

  return { dir, assistantsDir, hashDir, outsideVictim };
}

// The dashboard only lists the live assistant. Direct GETs decide the rest:
// 404 for the genuinely-deleted one, 200 for the one the listing merely
// omitted.
function pruneRoutes(): StubRoute[] {
  return [
    {
      method: "GET",
      pathStartsWith: `/assistant/${UUID_STALE}`,
      status: 404,
      body: { message: "Assistant not found" },
    },
    {
      method: "GET",
      pathStartsWith: `/assistant/${UUID_UNCONFIRMED}`,
      body: assistantBody(
        UUID_UNCONFIRMED,
        "Unconfirmed Agent",
        "marker:unconfirmed-platform",
      ),
    },
    {
      method: "GET",
      pathStartsWith: `/assistant/${UUID_STALE_TS}`,
      status: 404,
      body: { message: "Assistant not found" },
    },
    {
      method: "GET",
      pathStartsWith: `/assistant/${UUID_TRAVERSAL}`,
      status: 404,
      body: { message: "Assistant not found" },
    },
    {
      method: "GET",
      pathStartsWith: `/assistant/${UUID_NO_FILE}`,
      status: 404,
      body: { message: "Assistant not found" },
    },
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: [assistantBody(UUID_LIVE, "Live Agent", "marker:live-platform")],
    },
    { method: "GET", pathStartsWith: "/credential", body: [] },
  ];
}

function runPull(dir: string, port: number, args: string[]) {
  return spawnSync(
    "node",
    ["--import", "tsx", "src/pull.ts", ENV, "--skip-bindings", ...args],
    {
      cwd: dir,
      env: {
        ...process.env,
        CI: "true", // skip the interactive 2s --force countdown
        VAPI_TOKEN: "fake-token-not-used",
        VAPI_BASE_URL: `http://127.0.0.1:${port}`,
      },
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
}

function readAssistantsState(dir: string): Record<string, { uuid: string }> {
  return JSON.parse(readFileSync(join(dir, `.vapi-state.${ENV}.json`), "utf-8"))
    .assistants;
}

test("pull --force deletes stale tracked files and leaves everything else alone", async () => {
  const { dir, assistantsDir, hashDir, outsideVictim } = makeFixture();
  const { worker, port } = await startStub(pruneRoutes());

  try {
    const res = runPull(dir, port, ["--force", "--type", "assistants"]);
    assert.equal(
      res.status,
      0,
      `pull exit ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // A — the confirmed-deleted resource loses its file, state entry, baseline.
    assert.ok(
      !existsSync(join(assistantsDir, `${SLUG_STALE}.md`)),
      `${SLUG_STALE}.md must be deleted\n${res.stdout}`,
    );
    assert.match(res.stdout, /🗑️\s+stale-agent-aaaaaaaa/);
    assert.equal(readAssistantsState(dir)[SLUG_STALE], undefined);
    assert.ok(
      !existsSync(join(hashDir, UUID_STALE)),
      "stale baseline must be removed so a later recreation cannot inherit it",
    );
    assert.ok(
      !existsSync(join(assistantsDir, `${SLUG_STALE_TS}.ts`)),
      "tracked TypeScript resources are part of the force-prune inventory",
    );
    assert.ok(!existsSync(join(hashDir, UUID_STALE_TS)));
    assert.ok(
      existsSync(outsideVictim),
      "a malformed state key must never escape the resource directory",
    );
    assert.equal(readAssistantsState(dir)[SLUG_NO_FILE], undefined);
    assert.ok(!existsSync(join(hashDir, UUID_NO_FILE)));

    // B — omitted from the listing but a direct GET found it: retained.
    assert.ok(
      existsSync(join(assistantsDir, `${SLUG_UNCONFIRMED}.md`)),
      `${SLUG_UNCONFIRMED}.md must be retained\n${res.stdout}`,
    );
    assert.match(res.stdout, /unconfirmed-agent-dddddddd retained/);
    assert.ok(
      existsSync(join(hashDir, UUID_UNCONFIRMED)),
      "a retained resource keeps its baseline",
    );
    assert.equal(
      readAssistantsState(dir)[SLUG_UNCONFIRMED]?.uuid,
      UUID_UNCONFIRMED,
      "an inconclusive listing must keep the state mapping for a later retry",
    );

    // C — untracked local file is never a prune candidate.
    assert.ok(
      existsSync(join(assistantsDir, `${SLUG_UNTRACKED}.yml`)),
      `${SLUG_UNTRACKED}.yml must be retained\n${res.stdout}`,
    );

    // D — .vapi-ignore outranks --force for deletions.
    assert.ok(
      existsSync(join(assistantsDir, `${SLUG_IGNORED}.md`)),
      `${SLUG_IGNORED}.md must be retained\n${res.stdout}`,
    );
    assert.match(res.stdout, /🚫 ignored-agent-cccccccc retained/);
    assert.equal(
      readAssistantsState(dir)[SLUG_IGNORED],
      undefined,
      "ignored resources remain outside managed state",
    );

    // The live resource is still written and tracked.
    const liveContent = readFileSync(
      join(assistantsDir, `${SLUG_LIVE}.md`),
      "utf-8",
    );
    assert.match(liveContent, /marker:live-platform/);
    assert.equal(readAssistantsState(dir)[SLUG_LIVE]?.uuid, UUID_LIVE);

    assert.match(res.stdout, /assistants: 0 new, 1 updated, 2 deleted/);
    assert.match(res.stdout, /Force reconciliation complete/);
  } finally {
    await shutdownStub(worker);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plain pull retains every stale tracked file and says so", async () => {
  const { dir, assistantsDir, hashDir } = makeFixture();
  const { worker, port } = await startStub(pruneRoutes());

  try {
    // The seeded baseline deliberately matches neither side, so the live
    // resource reads as 3-way drift. `defer` is apply's default and keeps the
    // run at exit 0 — the stale-file behavior is what this test is about.
    const res = runPull(dir, port, [
      "--type",
      "assistants",
      "--resolve=defer",
    ]);
    assert.equal(
      res.status,
      0,
      `pull exit ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    for (const [slug, extension] of [
      [SLUG_STALE, "md"],
      [SLUG_UNCONFIRMED, "md"],
      [SLUG_IGNORED, "md"],
      [SLUG_STALE_TS, "ts"],
    ] as const) {
      assert.ok(
        existsSync(join(assistantsDir, `${slug}.${extension}`)),
        `${slug}.${extension} must survive a plain pull\n${res.stdout}`,
      );
    }
    assert.ok(existsSync(join(hashDir, UUID_STALE)));
    const stateAfterPlainPull = readAssistantsState(dir);
    assert.equal(stateAfterPlainPull[SLUG_STALE]?.uuid, UUID_STALE);
    assert.equal(
      stateAfterPlainPull[SLUG_UNCONFIRMED]?.uuid,
      UUID_UNCONFIRMED,
    );
    assert.equal(stateAfterPlainPull[SLUG_IGNORED], undefined);
    assert.equal(
      stateAfterPlainPull[SLUG_NO_FILE],
      undefined,
      "plain pull keeps the historical cleanup behavior for state ghosts without files",
    );

    // The line that would have surfaced the orphan the first time.
    assert.match(
      res.stdout,
      /stale-agent-aaaaaaaa is no longer in the dashboard listing/,
    );
    assert.match(res.stdout, /tracked local file\(s\) are no longer in the/);
    assert.doesNotMatch(res.stdout, /Force reconciliation complete/);

    const forceRes = runPull(dir, port, ["--force", "--type", "assistants"]);
    assert.equal(
      forceRes.status,
      0,
      `follow-up force pull exit ${forceRes.status}\nstdout=${forceRes.stdout}\nstderr=${forceRes.stderr}`,
    );
    assert.ok(!existsSync(join(assistantsDir, `${SLUG_STALE}.md`)));
    assert.ok(!existsSync(join(assistantsDir, `${SLUG_STALE_TS}.ts`)));
  } finally {
    await shutdownStub(worker);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--id-scoped pull --force prunes nothing", async () => {
  const { dir, assistantsDir, hashDir } = makeFixture();
  const { worker, port } = await startStub(pruneRoutes());

  try {
    const res = runPull(dir, port, [
      "--force",
      "--type",
      "assistants",
      "--id",
      UUID_LIVE,
    ]);
    assert.equal(
      res.status,
      0,
      `pull exit ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );

    // A scoped response deliberately excludes unrelated resources; none of
    // them may be read as evidence of deletion.
    for (const [slug, extension] of [
      [SLUG_STALE, "md"],
      [SLUG_UNCONFIRMED, "md"],
      [SLUG_IGNORED, "md"],
      [SLUG_STALE_TS, "ts"],
    ] as const) {
      assert.ok(
        existsSync(join(assistantsDir, `${slug}.${extension}`)),
        `${slug}.${extension} must survive a scoped pull\n${res.stdout}`,
      );
    }
    assert.ok(existsSync(join(hashDir, UUID_STALE)));
    const state = readAssistantsState(dir);
    assert.equal(state[SLUG_STALE]?.uuid, UUID_STALE);
    assert.doesNotMatch(res.stdout, /🗑️\s+stale-agent-aaaaaaaa/);
  } finally {
    await shutdownStub(worker);
    rmSync(dir, { recursive: true, force: true });
  }
});
