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

// End to end, through the commands a person runs: pull records what each
// saved key is for, and validate (which apply runs first) then catches a
// credentialIds list that hides one. The API is a local stub.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "clinic";

// The stub must live on its own thread: spawnSync parks this one.
function startStub(
  credentials: unknown[],
): Promise<{ worker: Worker; port: number }> {
  return new Promise((resolveStart, rejectStart) => {
    const source = `
      const http = require('node:http');
      const { parentPort, workerData } = require('node:worker_threads');
      const server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        const isCredentials = (req.url || '').startsWith('/credential');
        res.end(JSON.stringify(isCredentials ? workerData.credentials : []));
      });
      server.listen(0, '127.0.0.1', () => {
        parentPort.postMessage({ port: server.address().port });
      });
      parentPort.on('message', () => server.close(() => process.exit(0)));
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: { credentials },
    });
    worker.once("error", rejectStart);
    worker.once("message", (message: { port: number }) =>
      resolveStart({ worker, port: message.port }),
    );
  });
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// What GET /credential returns for the org. Secrets are made up, and none of
// them may reach a file.
const CREDENTIALS = [
  {
    id: id(1),
    orgId: "org-1",
    provider: "azure-openai",
    name: "azure-north",
    openAIKey: "secret-1",
  },
  {
    id: id(2),
    orgId: "org-1",
    provider: "azure-openai",
    name: "azure-south",
    openAIKey: "secret-2",
  },
  {
    id: id(3),
    orgId: "org-1",
    provider: "11labs",
    name: "elevenlabs",
    apiKey: "secret-3",
  },
  { id: id(4), orgId: "org-1", provider: "deepgram", apiKey: "secret-4" },
  {
    id: id(5),
    orgId: "org-1",
    provider: "azure",
    name: "recordings",
    bucketPlan: { containerName: "calls", connectionString: "secret-5" },
  },
  // Two keys with no name and the same provider end up with one name.
  { id: id(6), orgId: "org-1", provider: "deepgram", apiKey: "secret-6" },
];

const TRIAGE = `---
name: Triage
model:
  provider: openai
  model: gpt-4.1
voice:
  provider: 11labs
  voiceId: sarah
transcriber:
  provider: deepgram
  model: nova-3
---

You are the triage assistant.
`;

const squad = (credentialIds: string[]) =>
  `name: Front Desk
members:
  - assistantId: triage
membersOverrides:
  credentialIds:
${credentialIds.map((name) => `    - ${name}`).join("\n")}
`;

function run(dir: string, port: number, script: string, ...args: string[]) {
  return spawnSync("node", ["--import", "tsx", `src/${script}`, ORG, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      VAPI_TOKEN: "fake-token-not-used",
      VAPI_BASE_URL: `http://127.0.0.1:${port}`,
      GITHUB_ACTIONS: "",
    },
    encoding: "utf-8",
    timeout: 60_000,
  });
}

// Where the engine keeps the two files it writes, in each layout. A fresh
// fork of this repository has a workflow that stages state/, so its state
// starts there; a repository whose commit step can't be seen keeps the older
// places, which that step already stages.
const LAYOUTS = [
  {
    name: "state/<org>/",
    workflows: true,
    stateFile: `state/${ORG}/state.json`,
    kindsFile: `state/${ORG}/credential-providers.json`,
  },
  {
    name: "the older layout",
    workflows: false,
    stateFile: `.vapi-state.${ORG}.json`,
    kindsFile: `resources/${ORG}/.vapi-credential-providers.json`,
  },
];

for (const layout of LAYOUTS)
  test(`pull records each key's provider, and validate catches a list that hides one (${layout.name})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "vapi-credential-pins-"));
    if (layout.workflows)
      cpSync(join(REPO_ROOT, ".github"), join(dir, ".github"), {
        recursive: true,
      });
    cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    const orgDir = join(dir, "resources", ORG);
    mkdirSync(join(orgDir, "assistants"), { recursive: true });
    mkdirSync(join(orgDir, "squads"), { recursive: true });
    writeFileSync(join(orgDir, "assistants", "triage.md"), TRIAGE);
    const squadPath = join(orgDir, "squads", "front-desk.yml");
    // The practice's model key, the transcriber key and the bucket: no voice key.
    writeFileSync(squadPath, squad(["azure-south", "deepgram", "recordings"]));

    const { worker, port } = await startStub(CREDENTIALS);
    try {
      // Before any pull there is nothing to check the list against.
      const before = run(dir, port, "validate-cmd.ts");
      assert.equal(before.status, 0, before.stdout + before.stderr);
      assert.match(before.stdout, /credential-pin-unchecked/);
      assert.ok(
        before.stdout.includes(`${layout.kindsFile} doesn't exist yet`),
        before.stdout,
      );

      const pull = run(dir, port, "pull.ts", "--bootstrap");
      assert.equal(pull.status, 0, pull.stdout + pull.stderr);
      assert.match(
        pull.stdout + pull.stderr,
        new RegExp(
          `Credentials ${id(4)} and ${id(6)} are both named "deepgram"; only the second is kept`,
        ),
      );
      const kindsText = readFileSync(join(dir, layout.kindsFile), "utf-8");
      assert.deepEqual(JSON.parse(kindsText), {
        "azure-north": { provider: "azure-openai" },
        "azure-south": { provider: "azure-openai" },
        deepgram: { provider: "deepgram" },
        elevenlabs: { provider: "11labs" },
        recordings: { provider: "azure", bucket: true },
      });
      assert.doesNotMatch(kindsText, /secret/);
      // The state file is still a name → UUID map and nothing else.
      const state = JSON.parse(
        readFileSync(join(dir, layout.stateFile), "utf-8"),
      );
      assert.deepEqual(state.credentials.elevenlabs, { uuid: id(3) });

      // A warning by default: validate passes and says what is hidden.
      const warned = run(dir, port, "validate-cmd.ts");
      assert.equal(warned.status, 0, warned.stdout + warned.stderr);
      assert.match(warned.stdout, /0 error\(s\), 1 warning\(s\)/);
      assert.match(
        warned.stdout,
        /credential-pin-hides-key[\s\S]*the voice of member "triage" uses 11labs, and this org has "elevenlabs" saved for it/,
      );

      // An error once the org is marked customer-keys-only: validate fails,
      // which is the step apply runs before it pulls or pushes anything.
      writeFileSync(
        join(orgDir, ".vapi-policy.yml"),
        "customerKeysOnly: true\n",
      );
      const refused = run(dir, port, "validate-cmd.ts");
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /1 error\(s\), 0 warning\(s\)/);
      assert.match(refused.stderr, /Validation failed with 1 error/);

      // Naming the voice key on the list clears it.
      writeFileSync(
        squadPath,
        squad(["azure-south", "deepgram", "recordings", "elevenlabs"]),
      );
      const fixed = run(dir, port, "validate-cmd.ts");
      assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
      assert.match(fixed.stdout, /Validation passed/);

      // A misspelt policy key stops validate; it doesn't switch the rule off.
      writeFileSync(
        join(orgDir, ".vapi-policy.yml"),
        "customerKeyOnly: true\n",
      );
      const typo = run(dir, port, "validate-cmd.ts");
      assert.equal(typo.status, 1);
      assert.match(typo.stderr, /unknown key "customerKeyOnly"/);
    } finally {
      worker.postMessage("shutdown");
      rmSync(dir, { recursive: true, force: true });
    }
  });
