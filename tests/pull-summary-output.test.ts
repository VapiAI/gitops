import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV = "test-pull-summary";
const UUID = "aaaaaaaa-1111-1111-1111-111111111111";

function assistant(marker: string) {
  return {
    id: UUID,
    orgId: "org-test",
    name: "Summary Test Assistant",
    model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: "marker:" + marker }] },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

async function startStub(initialBody: unknown) {
  const source = [
    "const http = require('node:http');",
    "const { parentPort, workerData } = require('node:worker_threads');",
    "let body = workerData.body;",
    "const server = http.createServer((req, res) => {",
    "  res.statusCode = 200;",
    "  res.setHeader('Content-Type', 'application/json');",
    "  res.end(JSON.stringify((req.url || '').startsWith('/assistant') ? [body] : []));",
    "});",
    "server.listen(0, '127.0.0.1', () => parentPort.postMessage({ type: 'listening', port: server.address().port }));",
    "parentPort.on('message', (msg) => {",
    "  if (msg && msg.type === 'set-body') { body = msg.body; parentPort.postMessage({ type: 'body-updated' }); }",
    "  if (msg && msg.type === 'shutdown') server.close(() => process.exit(0));",
    "});",
  ].join("\n");
  const worker = new Worker(source, { eval: true, workerData: { body: initialBody } });
  const port = await new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (msg: { type: string; port?: number }) => {
      if (msg.type === "listening" && typeof msg.port === "number") resolve(msg.port);
    });
  });
  return { worker, port };
}

function setAssistant(worker: Worker, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const listener = (msg: { type: string }) => {
      if (msg.type !== "body-updated") return;
      worker.off("message", listener);
      resolve();
    };
    worker.on("message", listener);
    worker.postMessage({ type: "set-body", body });
  });
}

function runPull(dir: string, port: number) {
  return spawnSync("node", ["--import", "tsx", "src/pull.ts", ENV], {
    cwd: dir,
    env: { ...process.env, VAPI_TOKEN: "fake-token", VAPI_BASE_URL: "http://127.0.0.1:" + port },
    encoding: "utf-8",
    timeout: 30_000,
  });
}

test("pull: dashboard-ahead reports sync-down and identical writes are not counted as updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-pull-summary-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const { worker, port } = await startStub(assistant("v1"));

  try {
    const first = runPull(dir, port);
    assert.equal(first.status, 0, "first pull failed: " + first.stderr);
    const assistantDir = join(dir, "resources", ENV, "assistants");
    const file = readdirSync(assistantDir).find((name) => name.endsWith(".md"));
    assert.ok(file, "first pull should write an assistant markdown file");
    const filePath = join(assistantDir, file);
    assert.match(readFileSync(filePath, "utf-8"), /marker:v1/);

    await setAssistant(worker, assistant("v2"));
    const dashboardAhead = runPull(dir, port);
    assert.equal(dashboardAhead.status, 0, "dashboard-ahead pull failed: " + dashboardAhead.stderr);
    assert.match(dashboardAhead.stdout, /⬇️\s+summary-test-assistant-[a-f0-9]{8} \(dashboard ahead, local unchanged — syncing down\)/);
    assert.match(dashboardAhead.stdout, /⬇️\s+dashboard-ahead\s*:\s*1\s+\(dashboard changes synced down to local\)/);
    assert.match(dashboardAhead.stdout, /assistants: 0 new, 1 updated/);
    assert.doesNotMatch(dashboardAhead.stdout, /dashboard-ahead.*preserved locally/);
    assert.match(readFileSync(filePath, "utf-8"), /marker:v2/);

    const before = statSync(filePath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const identical = runPull(dir, port);
    assert.equal(identical.status, 0, "identical pull failed: " + identical.stderr);
    assert.match(identical.stdout, /assistants: 0 new, 0 updated/);
    assert.match(identical.stdout, /📝\s+summary-test-assistant-[a-f0-9]{8} -> .*summary-test-assistant-[a-f0-9]{8}\.md/);
    assert.ok(statSync(filePath).mtimeMs > before, "pull should still write identical serialized content");
  } finally {
    worker.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      setTimeout(() => worker.terminate().then(() => resolve()).catch(() => resolve()), 1000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
