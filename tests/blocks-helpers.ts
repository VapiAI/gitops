// Shared by the blocks tests: a throwaway repository with the engine's own
// src/ in it, and a Vapi API stub on a worker thread (spawnSync parks this
// thread's event loop, so the stub can't live here).

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function filesWrite(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

// A repository root holding only the given files.
export function repoCreate(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vapi-blocks-"));
  filesWrite(root, files);
  return root;
}

// The same, plus what a spawned CLI needs to run from it.
export function engineRepoCreate(files: Record<string, string>): string {
  const root = repoCreate(files);
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(root, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  return root;
}

export function stateFile(assistants: Record<string, string>): string {
  return JSON.stringify(
    {
      // Non-empty, so push doesn't treat the state as uninitialized and
      // bootstrap-pull before the drift check.
      credentials: { "unused-credential": { uuid: "cred-uuid-unused" } },
      assistants: Object.fromEntries(
        Object.entries(assistants).map(([id, uuid]) => [id, { uuid }]),
      ),
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
  );
}

// An assistant file and the payload the platform returns for it. The two
// hash the same when the file's expanded body equals `prompt`.
export function assistantFile(name: string, body: string): string {
  return `---
model:
  provider: openai
  model: gpt-4o
name: ${name}
voice:
  provider: 11labs
  voiceId: burt
---

${body}
`;
}

export function assistantPayload(uuid: string, name: string, prompt: string) {
  return {
    id: uuid,
    orgId: "org-test",
    name,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
    },
    voice: { provider: "11labs", voiceId: "burt" },
  };
}

export interface StubRoute {
  method: string;
  pathStartsWith: string;
  body: unknown;
}

export interface Stub {
  port: number;
  // Every request served so far, as "METHOD /path".
  requests: () => Promise<string[]>;
  stop: () => Promise<void>;
}

// The first matching route answers; anything else gets an empty list.
export function stubStart(routes: StubRoute[]): Promise<Stub> {
  return new Promise((resolveStart, rejectStart) => {
    const source = `
      const http = require('node:http');
      const { parentPort, workerData } = require('node:worker_threads');
      const requests = [];
      const server = http.createServer((req, res) => {
        const method = (req.method || 'GET').toUpperCase();
        const url = req.url || '';
        requests.push(method + ' ' + url);
        const match = workerData.routes.find(
          (r) => r.method === method && url.startsWith(r.pathStartsWith),
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(match ? match.body : []));
      });
      server.listen(0, '127.0.0.1', () => {
        parentPort.postMessage({ type: 'listening', port: server.address().port });
      });
      parentPort.on('message', (msg) => {
        if (msg.type === 'requests') parentPort.postMessage({ type: 'requests', requests });
        if (msg.type === 'shutdown') server.close(() => process.exit(0));
      });
    `;
    const worker = new Worker(source, { eval: true, workerData: { routes } });
    worker.once("error", rejectStart);
    worker.once("message", (message: { port: number }) => {
      resolveStart({
        port: message.port,
        requests: () =>
          new Promise((resolveRequests) => {
            worker.once("message", (reply: { requests: string[] }) =>
              resolveRequests(reply.requests),
            );
            worker.postMessage({ type: "requests" });
          }),
        stop: () =>
          new Promise((resolveStop) => {
            worker.once("exit", () => resolveStop());
            worker.postMessage({ type: "shutdown" });
            setTimeout(() => void worker.terminate(), 1000);
          }),
      });
    });
  });
}

// Run one of the engine's CLIs from `root` against the stub.
export function cliRun(
  root: string,
  script: string,
  args: string[],
  port: number,
  // One command's worth. A call that starts further commands passes more.
  timeoutMs = 60_000,
): { code: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        VAPI_TOKEN: "fake-token-not-used",
        VAPI_BASE_URL: `http://127.0.0.1:${port}`,
      },
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}
