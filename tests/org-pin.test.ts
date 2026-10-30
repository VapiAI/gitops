import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  keyOrgFetch,
  ORG_PIN_FILE,
  OrgPinMismatchError,
  type OrgProbeFetch,
  orgPinCheck,
  orgPinRead,
} from "../src/org-pin.ts";
import { VapiApiError } from "../src/vapi-client.ts";

// Nothing used to tie resources/<org>/ to a Vapi org, so a key for the wrong
// org read and wrote that org without a word. The folder now records its org
// in .vapi-org.json, and every command checks the key against it first.

// tests/no-vapi-api.ts turns the check off for the rest of the suite.
delete process.env.VAPI_GITOPS_ORG_PIN;

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONNECTION = { token: "test-token-not-used", baseUrl: "http://stub", userAgent: "test", vapiClient: "test" };
const SOURCE = "the VAPI_PRIVATE_API_KEY_ACME environment variable";

// A probe stub: endpoint (without the query) → response or error.
function probes(responses: Record<string, unknown>): {
  probeFetch: OrgProbeFetch;
  seen: string[];
} {
  const seen: string[] = [];
  const probeFetch: OrgProbeFetch = async (_connection, endpoint) => {
    seen.push(endpoint);
    const response = responses[endpoint.split("?")[0]!] ?? [];
    if (response instanceof Error) throw response;
    return response;
  };
  return { probeFetch, seen };
}

function orgDir(options: { folder: boolean; pin?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "org-pin-"));
  if (options.folder || options.pin !== undefined)
    mkdirSync(join(root, "resources", "acme"), { recursive: true });
  if (options.pin !== undefined)
    writeFileSync(join(root, "resources", "acme", ORG_PIN_FILE), options.pin);
  return root;
}

const serverError = new VapiApiError("GET", "/tool", 503, "unavailable", "");
const unauthorized = new VapiApiError("GET", "/assistant", 401, "Unauthorized", "");

// ── Finding the key's org ────────────────────────────────────────────────

test("keyOrgFetch reads orgId from the first resource listed", async () => {
  const { probeFetch, seen } = probes({ "/assistant": [{ id: "a1", orgId: "org-a" }] });
  assert.deepEqual(await keyOrgFetch(CONNECTION, probeFetch), { kind: "found", orgId: "org-a" });
  assert.deepEqual(seen, ["/assistant?limit=1"]);
});

test("keyOrgFetch moves on from empty lists and reads { results } pages", async () => {
  const { probeFetch, seen } = probes({
    "/structured-output": { results: [{ id: "s1", orgId: "org-a" }] },
  });
  assert.deepEqual(await keyOrgFetch(CONNECTION, probeFetch), { kind: "found", orgId: "org-a" });
  assert.equal(seen.length, 6);
});

test("keyOrgFetch reports an org that lists nothing as empty", async () => {
  assert.deepEqual(await keyOrgFetch(CONNECTION, probes({}).probeFetch), { kind: "empty" });
});

test("keyOrgFetch reports unknown when a probe fails and none finds an org", async () => {
  assert.deepEqual(
    await keyOrgFetch(CONNECTION, probes({ "/tool": serverError }).probeFetch),
    { kind: "unknown" },
  );
});

test("keyOrgFetch stops at a rejected key", async () => {
  const { probeFetch, seen } = probes({ "/assistant": unauthorized });
  assert.deepEqual(await keyOrgFetch(CONNECTION, probeFetch), { kind: "unknown" });
  assert.deepEqual(seen, ["/assistant?limit=1"]);
});

// ── Checking against the pin ─────────────────────────────────────────────

test("orgPinCheck pins an unpinned folder to the key's org", async () => {
  const root = orgDir({ folder: true });
  try {
    const { probeFetch } = probes({ "/assistant": [{ orgId: "org-a" }] });
    const outcome = await orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch });
    assert.deepEqual(outcome, { kind: "pinned", orgId: "org-a" });
    assert.equal(
      readFileSync(join(root, "resources", "acme", ORG_PIN_FILE), "utf8"),
      '{\n  "orgId": "org-a"\n}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinCheck makes no request for an org with no folder and no pin", async () => {
  const root = orgDir({ folder: false });
  try {
    const { probeFetch, seen } = probes({ "/assistant": [{ orgId: "org-a" }] });
    const outcome = await orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch });
    assert.deepEqual(outcome, { kind: "unpinned" });
    assert.deepEqual(seen, []);
    assert.equal(existsSync(join(root, "resources")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinCheck passes a key for the pinned org", async () => {
  const root = orgDir({ folder: true, pin: '{"orgId":"org-a"}' });
  try {
    const { probeFetch } = probes({ "/assistant": [{ orgId: "org-a" }] });
    assert.deepEqual(
      await orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch }),
      { kind: "match" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinCheck refuses a key for another org, naming both orgs and the source", async () => {
  const root = orgDir({ folder: true, pin: '{"orgId":"org-a"}' });
  try {
    const { probeFetch } = probes({ "/assistant": [{ orgId: "org-b" }] });
    await assert.rejects(
      orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch }),
      (error: Error) => {
        assert.ok(error instanceof OrgPinMismatchError);
        assert.match(error.message, /belongs to Vapi org org-b/);
        assert.match(error.message, /pinned to org org-a/);
        assert.match(error.message, /VAPI_PRIVATE_API_KEY_ACME environment variable/);
        assert.doesNotMatch(error.message, /test-token-not-used/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinCheck refuses a key whose org is empty when the folder is pinned", async () => {
  const root = orgDir({ folder: true, pin: '{"orgId":"org-a"}' });
  try {
    await assert.rejects(
      orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch: probes({}).probeFetch }),
      /belongs to an org with no resources/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinCheck can't verify when the probes fail, and says so", async () => {
  const root = orgDir({ folder: true, pin: '{"orgId":"org-a"}' });
  try {
    const { probeFetch } = probes({ "/assistant": serverError });
    assert.deepEqual(
      await orgPinCheck({ rootDir: root, org: "acme", connection: CONNECTION, keySource: SOURCE, probeFetch }),
      { kind: "unverified" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orgPinRead names the file when the pin is corrupt", () => {
  const root = orgDir({ folder: true, pin: "{not json" });
  try {
    assert.throws(() => orgPinRead(root, "acme"), /resources\/acme\/\.vapi-org\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A real command ───────────────────────────────────────────────────────

test("pull stops before listing anything when the key belongs to another org", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ id: "a1", orgId: "org-b", name: "x" }]));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const dir = mkdtempSync(join(tmpdir(), "org-pin-cli-"));
  try {
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    mkdirSync(join(dir, "resources", "acme"), { recursive: true });
    writeFileSync(join(dir, "resources", "acme", ORG_PIN_FILE), '{"orgId":"org-a"}\n');
    writeFileSync(join(dir, ".env.acme"), "VAPI_PRIVATE_API_KEY=wrong-org-key\n");
    const env: NodeJS.ProcessEnv = { ...process.env, VAPI_BASE_URL: `http://127.0.0.1:${port}` };
    delete env.VAPI_GITOPS_ORG_PIN;
    // Async spawn: the stub server runs in this process.
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/pull.ts", "acme"], { cwd: dir, env });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /belongs to Vapi org org-b, but resources\/acme\/ is pinned to org org-a/);
    assert.doesNotMatch(result.output, /wrong-org-key/);
    // Only the probe went out: no listing, no writes.
    assert.deepEqual(seen, ["/assistant?limit=1"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
