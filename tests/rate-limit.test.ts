import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maxGitopsRpmRead, orgLimiter, TokenBucket } from "../src/rate-limit.ts";
import { orgPinCheck } from "../src/org-pin.ts";
import { orgSettingsUrl } from "../src/vapi-fetch.ts";
import { vapiFetchJson } from "../src/vapi-client.ts";

test("token bucket allows a burst, then sustains the configured rate", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new TokenBucket(300, () => now, async (ms) => { waits.push(ms); now += ms; });
  assert.equal(limiter.capacity, 5);
  await Promise.all(Array.from({ length: 10 }, () => limiter.acquire()));
  assert.deepEqual(waits, [200, 200, 200, 200, 200]);
  now += 10_000;
  await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
  assert.equal(waits.length, 5);
});

test("low RPM and concurrent requests sustain the cap", async () => {
  let now = 0;
  const limiter = new TokenBucket(30, () => now, async (ms) => { now += ms; });
  assert.equal(limiter.capacity, 1);
  await Promise.all(Array.from({ length: 3 }, () => limiter.acquire()));
  assert.equal(now, 4000);
  assert.throws(() => new TokenBucket(Infinity), /positive integer/);
  assert.throws(() => new TokenBucket(1.5), /positive integer/);
});

test("default RPM has only a small burst across a minute", async () => {
  let now = 0;
  const limiter = new TokenBucket(100, () => now, async (ms) => { now += ms; });
  assert.equal(limiter.capacity, 2);
  await Promise.all(Array.from({ length: 102 }, () => limiter.acquire()));
  assert.equal(now, 60_000);
});

test("process registry shares an org but isolates other orgs", async () => {
  const a = orgLimiter("/registry-test", "a", 5);
  assert.equal(orgLimiter("/registry-test", "a", 5), a);
  const b = orgLimiter("/registry-test", "b", 5);
  assert.notEqual(a, b);
  await Promise.all([a.acquire(), b.acquire()]);
});

test("max GitOps RPM resolves defaults, committed settings and environment precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-config-"));
  const folder = join(root, "resources", "acme");
  mkdirSync(folder, { recursive: true });
  const pin = join(folder, ".vapi-org.json");
  try {
    assert.equal(maxGitopsRpmRead(root, "acme", {}), 100);
    writeFileSync(pin, JSON.stringify({ maxGitopsRpm: 12 }));
    assert.equal(maxGitopsRpmRead(root, "acme", {}), 12);
    writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM='8'\n");
    assert.equal(maxGitopsRpmRead(root, "acme", {}), 8);
    assert.equal(maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "5" }), 5);
    for (const value of [0, -1, 1.5, "bad", "", null, true, "Infinity"]) {
      writeFileSync(pin, JSON.stringify({ maxGitopsRpm: value }));
      assert.throws(() => maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "5" }), /❌.*resources\/acme\/\.vapi-org.json/);
    }
    writeFileSync(pin, "{}");
    for (const value of ["0", "-1", "1.5", "bad", "", "Infinity"]) {
      writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=8\n");
      assert.throws(() => maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: value }), /❌.*environment VAPI_MAX_GITOPS_RPM/);
      writeFileSync(join(root, ".env.acme"), `VAPI_MAX_GITOPS_RPM=${value}\n`);
      assert.throws(() => maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "5" }), /❌.*\.env.acme/);
    }
    writeFileSync(pin, "{");
    assert.throws(() => maxGitopsRpmRead(root, "acme", {}), /Restore it from git/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pinning a settings-only file preserves all existing fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-pin-"));
  const folder = join(root, "resources", "acme");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, ".vapi-org.json");
  writeFileSync(path, JSON.stringify({ maxGitopsRpm: 5, extra: { keep: true } }));
  const prior = process.env.VAPI_GITOPS_ORG_PIN;
  delete process.env.VAPI_GITOPS_ORG_PIN;
  try {
    const outcome = await orgPinCheck({
      rootDir: root, org: "acme", keySource: "test",
      connection: { token: "unused", baseUrl: "http://stub", userAgent: "test", limiter: new TokenBucket(100), vapiClient: "test" },
      probeFetch: async () => [{ orgId: "org-acme" }],
    });
    assert.equal(outcome.kind, "pinned");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { maxGitopsRpm: 5, extra: { keep: true }, orgId: "org-acme" });
  } finally {
    if (prior === undefined) delete process.env.VAPI_GITOPS_ORG_PIN;
    else process.env.VAPI_GITOPS_ORG_PIN = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("429 advice selects only the matching region dashboard", () => {
  assert.equal(orgSettingsUrl("https://api.eu.vapi.ai/assistant"), "https://dashboard.eu.vapi.ai/settings/organization");
  assert.equal(orgSettingsUrl("https://api.vapi.ai/assistant"), "https://dashboard.vapi.ai/settings/organization");
  assert.equal(orgSettingsUrl("http://localhost:123"), "https://dashboard.vapi.ai/settings/organization");
});

test("429 responses warn once per org and retries consume tokens", async () => {
  let requests = 0;
  let tokens = 0;
  const warnings: string[] = [];
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(requests % 2 ? 429 : 200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const limiter = new TokenBucket(2);
  limiter.acquire = async () => { tokens++; };
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const connection = { token: "unused", baseUrl: `http://127.0.0.1:${port}`, userAgent: "test", vapiClient: "test", limiter };
    for (let i = 0; i < 2; i++) await vapiFetchJson(connection, "GET", "/assistant", undefined, { sleep: async () => {} });
    assert.equal(requests, 4);
    assert.equal(tokens, 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /max GitOps RPM.*maxGitopsRpm \/ VAPI_MAX_GITOPS_RPM.*https:\/\/dashboard.vapi.ai\/settings\/organization/);
    assert.match(warnings[0]!, /requests per minute \(200 by default\)/);
  } finally {
    console.warn = warn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
