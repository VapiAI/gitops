import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { orgPinCheck } from "../src/org-pin.ts";
import {
  maxGitopsRpmRead,
  orgLimiter,
  TokenBucket,
} from "../src/rate-limit.ts";
import { vapiFetchJson } from "../src/vapi-client.ts";
import { orgSettingsUrl } from "../src/vapi-fetch.ts";

test("token bucket allows a burst, then sustains the configured rate", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new TokenBucket(
    300,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  assert.equal(limiter.capacity, 20);
  await Promise.all(Array.from({ length: 25 }, () => limiter.acquire()));
  assert.deepEqual(waits, [200, 200, 200, 200, 200]);
  now += 10_000;
  await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
  assert.equal(waits.length, 5);
});

test("low RPM and concurrent requests sustain the cap", async () => {
  let now = 0;
  const limiter = new TokenBucket(
    1,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  assert.equal(limiter.capacity, 1);
  await Promise.all(Array.from({ length: 3 }, () => limiter.acquire()));
  assert.equal(now, 120000);
  assert.throws(() => new TokenBucket(Infinity), /positive integer/);
  assert.throws(() => new TokenBucket(1.5), /positive integer/);
});

test("default RPM has only a small burst across a minute", async () => {
  let now = 0;
  const limiter = new TokenBucket(
    100,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  assert.equal(limiter.capacity, 20);
  await Promise.all(Array.from({ length: 120 }, () => limiter.acquire()));
  assert.equal(now, 60_000);
});

test("process registry shares an org but isolates other orgs", async () => {
  const a = orgLimiter("/registry-test", "a", 5);
  assert.equal(orgLimiter("/registry-test", "a", 5), a);
  const b = orgLimiter("/registry-test", "b", 5);
  assert.notEqual(a, b);
  await Promise.all([a.acquire(), b.acquire()]);
});

test("org limiter cache does not re-read changed configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-cache-"));
  const folder = join(root, "resources", "acme");
  mkdirSync(folder, { recursive: true });
  const pin = join(folder, ".vapi-org.json");
  try {
    writeFileSync(pin, '{"maxGitopsRpm":75}');
    const first = orgLimiter(root, "acme");
    writeFileSync(pin, "{");
    writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=invalid");
    assert.equal(orgLimiter(root, "acme"), first);
    assert.equal(first.rpm, 75);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the winning RPM source is validated", () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-winner-"));
  const folder = join(root, "resources", "acme");
  mkdirSync(folder, { recursive: true });
  try {
    writeFileSync(join(folder, ".vapi-org.json"), '{"maxGitopsRpm":0}');
    writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=90");
    writeFileSync(join(root, ".env.acme.local"), "VAPI_MAX_GITOPS_RPM=invalid");
    assert.equal(maxGitopsRpmRead(root, "acme", {}), 90);
    writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=invalid");
    assert.equal(
      maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "80" }),
      80,
    );
    assert.throws(
      () => maxGitopsRpmRead(root, "acme", {}),
      /\.env.acme VAPI_MAX_GITOPS_RPM/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("burst capacity is floored, bounded below by one and capped at twenty", () => {
  for (const [rpm, capacity] of [
    [1, 1],
    [9, 1],
    [10, 2],
    [99, 19],
    [100, 20],
    [1000, 20],
  ]) {
    assert.equal(new TokenBucket(rpm!).capacity, capacity);
  }
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
    assert.equal(
      maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "5" }),
      5,
    );
    for (const value of [0, -1, 1.5, "bad", "", null, true, "Infinity"]) {
      writeFileSync(pin, JSON.stringify({ maxGitopsRpm: value }));
      assert.equal(
        maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "5" }),
        5,
      );
      rmSync(join(root, ".env.acme"));
      assert.throws(
        () => maxGitopsRpmRead(root, "acme", {}),
        /❌.*resources\/acme\/\.vapi-org.json/,
      );
      writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=8\n");
    }
    writeFileSync(pin, "{}");
    for (const value of ["0", "-1", "1.5", "bad", "", "Infinity"]) {
      writeFileSync(join(root, ".env.acme"), "VAPI_MAX_GITOPS_RPM=8\n");
      assert.throws(
        () => maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: value }),
        /❌.*environment VAPI_MAX_GITOPS_RPM/,
      );
      writeFileSync(join(root, ".env.acme"), `VAPI_MAX_GITOPS_RPM=${value}\n`);
      assert.throws(() => maxGitopsRpmRead(root, "acme", {}), /❌.*\.env.acme/);
    }
    rmSync(join(root, ".env.acme"));
    writeFileSync(pin, "{");
    assert.throws(
      () => maxGitopsRpmRead(root, "acme", {}),
      /Restore it from git/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinning a settings-only file preserves all existing fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-pin-"));
  const folder = join(root, "resources", "acme");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, ".vapi-org.json");
  writeFileSync(
    path,
    JSON.stringify({ maxGitopsRpm: 5, extra: { keep: true } }),
  );
  const prior = process.env.VAPI_GITOPS_ORG_PIN;
  delete process.env.VAPI_GITOPS_ORG_PIN;
  try {
    const outcome = await orgPinCheck({
      rootDir: root,
      org: "acme",
      keySource: "test",
      connection: {
        token: "unused",
        baseUrl: "http://stub",
        userAgent: "test",
        limiter: new TokenBucket(100),
        vapiClient: "test",
      },
      probeFetch: async () => [{ orgId: "org-acme" }],
    });
    assert.equal(outcome.kind, "pinned");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      maxGitopsRpm: 5,
      extra: { keep: true },
      orgId: "org-acme",
    });
  } finally {
    if (prior === undefined) delete process.env.VAPI_GITOPS_ORG_PIN;
    else process.env.VAPI_GITOPS_ORG_PIN = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("429 advice selects only the matching region dashboard", () => {
  assert.equal(
    orgSettingsUrl("https://api.eu.vapi.ai/assistant"),
    "https://dashboard.eu.vapi.ai/settings/organization",
  );
  assert.equal(
    orgSettingsUrl("https://api.vapi.ai/assistant"),
    "https://dashboard.vapi.ai/settings/organization",
  );
  assert.equal(
    orgSettingsUrl("http://localhost:123"),
    "https://dashboard.vapi.ai/settings/organization",
  );
});

test("429 responses warn once per org and retries consume tokens", async () => {
  let requests = 0;
  let tokens = 0;
  const warnings: string[] = [];
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(requests % 2 ? 429 : 200, {
      "Content-Type": "application/json",
    });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const limiter = new TokenBucket(2, undefined, undefined, "acme");
  limiter.acquire = async () => {
    tokens++;
  };
  const warn = console.warn;
  console.warn = (message: string) => {
    warnings.push(message);
  };
  try {
    const connection = {
      token: "unused",
      baseUrl: `http://127.0.0.1:${port}`,
      userAgent: "test",
      vapiClient: "test",
      limiter,
    };
    for (let i = 0; i < 2; i++)
      await vapiFetchJson(connection, "GET", "/assistant", undefined, {
        sleep: async () => {},
      });
    assert.equal(requests, 4);
    assert.equal(tokens, 4);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /Vapi returned 429 \(rate limited\) for org acme\. maxGitopsRpm is 2 requests per minute/,
    );
    assert.match(warnings[0]!, /200 RPM by default/);
    assert.match(
      warnings[0]!,
      /https:\/\/dashboard.vapi.ai\/settings\/organization/,
    );
    assert.match(
      warnings[0]!,
      /resources\/acme\/\.vapi-org.json or set VAPI_MAX_GITOPS_RPM/,
    );
  } finally {
    console.warn = warn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("invalid RPM exits a command cleanly before any request", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const script of ["src/pull-cmd.ts", "src/setup.ts"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, "invalid-rpm-test"],
      {
        cwd: root,
        env: {
          ...process.env,
          VAPI_MAX_GITOPS_RPM: "invalid",
          VAPI_PRIVATE_API_KEY: "unused",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /❌ Invalid max GitOps RPM in environment VAPI_MAX_GITOPS_RPM/,
    );
    assert.doesNotMatch(result.stderr, /\n\s+at |Error:|node:internal/);
  }
});

test("invalid committed RPM exits config-free callers without a stack", () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-exit-"));
  mkdirSync(join(root, "resources", "acme"), { recursive: true });
  writeFileSync(
    join(root, "resources", "acme", ".vapi-org.json"),
    JSON.stringify({ maxGitopsRpm: 0 }),
  );
  try {
    const module = new URL("../src/rate-limit.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { orgLimiterOrExit } from ${JSON.stringify(module)}; orgLimiterOrExit(${JSON.stringify(root)}, "acme");`,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /❌ Invalid max GitOps RPM in resources\/acme\/\.vapi-org.json/,
    );
    assert.doesNotMatch(result.stderr, /\n\s+at |Error:|node:internal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared env parsing handles exports, comments and org file precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "rpm-env-"));
  try {
    writeFileSync(
      join(root, ".env.acme"),
      'export VAPI_MAX_GITOPS_RPM = "90" # client ceiling\n',
    );
    writeFileSync(
      join(root, ".env.acme.local"),
      "VAPI_MAX_GITOPS_RPM=80 # fallback\n",
    );
    writeFileSync(join(root, ".env.local"), "VAPI_MAX_GITOPS_RPM=70\n");
    assert.equal(maxGitopsRpmRead(root, "acme", {}), 90);
    assert.equal(maxGitopsRpmRead(root, "other", {}), 70);
    assert.equal(
      maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "60" }),
      60,
    );
    writeFileSync(
      join(root, ".env.acme"),
      "export VAPI_MAX_GITOPS_RPM=invalid # ignored when overridden\n",
    );
    assert.equal(
      maxGitopsRpmRead(root, "acme", { VAPI_MAX_GITOPS_RPM: "60" }),
      60,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
