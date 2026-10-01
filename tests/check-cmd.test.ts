import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommandRun } from "../src/check-cmd.ts";

// Never reach a real org from a developer shell that has a key exported.
for (const name of [
  "VAPI_PRIVATE_API_KEY",
  "VAPI_TOKEN",
  "VAPI_CHECK_TOKENS",
  "VAPI_BASE_URL",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "HEAD_SHA",
  "GITHUB_STEP_SUMMARY",
])
  delete process.env[name];

const PARITY_ROOT = fileURLToPath(
  new URL("./fixtures/check-parity/", import.meta.url),
);

async function run(
  args: string[],
  root: string,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    return { code: await checkCommandRun(args, root), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function parityCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "check-cmd-"));
  cpSync(PARITY_ROOT, root, { recursive: true });
  return root;
}

test("a dry run of the parity fixture builds the payload and writes it with --print-payload", async () => {
  const root = parityCopy();
  try {
    const result = await run(["core", "--dry-run", "--print-payload"], root);
    const file = join(root, "tmp/check-payloads/core--squads--dental.json");
    const body = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(
      [
        result.code,
        result.out.includes("✅ 3 simulations × 1 iteration over chat"),
        body.simulations.length,
      ],
      [0, true, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--all runs every check; a build error exits 2 and names the problem", async () => {
  const root = parityCopy();
  try {
    writeFileSync(
      join(root, "vapi-checks.yml"),
      "version: 1\nchecks:\n  core:\n    org: parity\n    targets: [squads/dental]\n    suites: [core]\n  broken:\n    org: parity\n    targets: [assistants/receptionist]\n    suites: [core]\n",
    );
    const result = await run(["--all", "--dry-run"], root);
    assert.deepEqual(
      [
        result.code,
        result.out.includes("core / squads/dental\n  ✅"),
        result.out.includes(
          `❌ assistants/receptionist.model.tools[2].destinations[0]: an assistant target can't hand off to "scheduler"`,
        ),
      ],
      [2, true, true],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no vapi-checks.yml means nothing to check, and exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "check-cmd-"));
  try {
    assert.deepEqual(await run(["--all", "--dry-run"], root), {
      code: 0,
      out: "No vapi-checks.yml at the repository root; nothing to check.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage, config and selection errors exit 2", async () => {
  const root = parityCopy();
  try {
    const codes = [
      (await run([], root)).code,
      (await run(["core", "--all", "--dry-run"], root)).code,
      (await run(["core", "--bogus"], root)).code,
      (await run(["nope", "--dry-run"], root)).code,
      // A live run with no key for the run org.
      (await run(["core"], root)).code,
    ];
    writeFileSync(join(root, "vapi-checks.yml"), "version: 2\n");
    codes.push((await run(["core", "--dry-run"], root)).code);
    assert.deepEqual(codes, [2, 2, 2, 2, 2, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing state file is a warning, not an error", async () => {
  const root = parityCopy();
  try {
    rmSync(join(root, ".vapi-state.parity.json"));
    const result = await run(["core", "--dry-run"], root);
    assert.deepEqual(
      [
        result.code,
        result.out.includes("⚠️  no .vapi-state.parity.json"),
        existsSync(join(root, "tmp")),
      ],
      [0, true, false],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Live runs against a stub serving both the simulations API and GitHub ──

interface LiveStub {
  baseUrl: string;
  mode: { failFirstItem: boolean };
  vapiPosts: number;
  statuses: Array<{
    context: string;
    state: string;
    target_url?: string;
    description: string;
  }>;
}

async function withLiveStub(
  fn: (stub: LiveStub) => Promise<void>,
): Promise<void> {
  const { createServer } = await import("node:http");
  const stub: LiveStub = {
    baseUrl: "",
    mode: { failFirstItem: false },
    vapiPosts: 0,
    statuses: [],
  };
  let total = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const url = req.url ?? "";
      if (url.startsWith("/repos/")) {
        stub.statuses.push(JSON.parse(raw));
        return reply(201, {});
      }
      const failed = stub.mode.failFirstItem ? 1 : 0;
      if (req.method === "POST") {
        stub.vapiPosts++;
        total = (JSON.parse(raw) as { simulations: unknown[] }).simulations
          .length;
        return reply(201, {
          id: "run-1",
          url: "https://dashboard.vapi.ai/run-1",
          status: "queued",
          simulationRunItemIds: Array.from(
            { length: total },
            (_, i) => `i${i}`,
          ),
        });
      }
      if (url.includes("/item"))
        return reply(200, {
          results: Array.from({ length: total }, (_, i) => ({
            id: `i${i}`,
            status: i < failed ? "failed" : "passed",
            metadata: { simulation: { name: `S${i + 1}` } },
            results: {
              evaluations: [
                {
                  name: "j",
                  required: true,
                  passed: i >= failed,
                  comparator: "=",
                  expectedValue: true,
                  extractedValue: i >= failed,
                },
              ],
            },
          })),
          metadata: { totalItems: total },
        });
      return reply(200, {
        id: "run-1",
        status: "ended",
        itemCounts: {
          total,
          passed: total - failed,
          failed,
          running: 0,
          queued: 0,
          canceled: 0,
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    await fn(stub);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withGitHubEnv<T>(
  stub: LiveStub,
  summary: string,
  fn: () => Promise<T>,
): Promise<T> {
  Object.assign(process.env, {
    GITHUB_TOKEN: "gh",
    GITHUB_REPOSITORY: "acme/gitops",
    HEAD_SHA: "abc123",
    GITHUB_API_URL: stub.baseUrl,
    GITHUB_RUN_ID: "7",
    GITHUB_STEP_SUMMARY: summary,
  });
  try {
    return await fn();
  } finally {
    for (const name of [
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "HEAD_SHA",
      "GITHUB_API_URL",
      "GITHUB_RUN_ID",
      "GITHUB_STEP_SUMMARY",
    ])
      delete process.env[name];
  }
}

function liveCopy(stub: LiveStub): string {
  const root = parityCopy();
  writeFileSync(
    join(root, ".env.parity"),
    `VAPI_PRIVATE_API_KEY=test-key\nVAPI_BASE_URL=${stub.baseUrl}\n`,
  );
  return root;
}

test("a live --all run posts pending then success per target, the aggregate, the job summary and JSON", async () => {
  await withLiveStub(async (stub) => {
    const root = liveCopy(stub);
    try {
      const summary = join(root, "summary.md");
      const result = await withGitHubEnv(stub, summary, () =>
        run(["--all", "--json", "tmp/report.json"], root),
      );
      const report = JSON.parse(
        readFileSync(join(root, "tmp/report.json"), "utf8"),
      );
      assert.deepEqual(
        {
          code: result.code,
          statuses: stub.statuses.map((s) => [
            s.context,
            s.state,
            s.target_url,
          ]),
          summary: readFileSync(summary, "utf8").includes(
            "| core | squads/dental | ✅ passed | 3/3 | [open](https://dashboard.vapi.ai/run-1) |",
          ),
          json: report.results.map((r: { outcome: string }) => r.outcome),
        },
        {
          code: 0,
          statuses: [
            [
              "Vapi Evals / core / squads/dental",
              "pending",
              "https://dashboard.vapi.ai/run-1",
            ],
            [
              "Vapi Evals / core / squads/dental",
              "success",
              "https://dashboard.vapi.ai/run-1",
            ],
            ["Vapi Evals", "success", "https://dashboard.vapi.ai/run-1"],
          ],
          summary: true,
          json: ["passed"],
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a failing live run exits 1 and turns the aggregate red", async () => {
  await withLiveStub(async (stub) => {
    stub.mode.failFirstItem = true;
    const root = liveCopy(stub);
    try {
      const result = await withGitHubEnv(stub, join(root, "summary.md"), () =>
        run(["--all"], root),
      );
      assert.deepEqual(
        [result.code, stub.statuses.at(-1)],
        [
          1,
          {
            context: "Vapi Evals",
            state: "failure",
            description: "1 failed",
            target_url: "https://dashboard.vapi.ai/run-1",
          },
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a single named check never posts the aggregate", async () => {
  await withLiveStub(async (stub) => {
    const root = liveCopy(stub);
    try {
      await withGitHubEnv(stub, join(root, "summary.md"), () =>
        run(["core"], root),
      );
      assert.deepEqual(
        stub.statuses.map((s) => s.context),
        [
          "Vapi Evals / core / squads/dental",
          "Vapi Evals / core / squads/dental",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("an unaffected change runs nothing and posts a green aggregate", async () => {
  await withLiveStub(async (stub) => {
    const root = liveCopy(stub);
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
          { cwd: root, stdio: "pipe" },
        );
      writeFileSync(join(root, ".gitignore"), ".env.*\ntmp/\nsummary.md\n");
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "base");
      git("switch", "-qc", "feature");
      writeFileSync(join(root, "NOTES.md"), "unrelated\n");
      git("add", "-A");
      git("commit", "-qm", "docs");
      const result = await withGitHubEnv(stub, join(root, "summary.md"), () =>
        run(["--all", "--changed-since", "main"], root),
      );
      assert.deepEqual(
        [
          result.code,
          stub.vapiPosts,
          stub.statuses.map((s) => [s.context, s.state, s.description]),
        ],
        [
          0,
          0,
          [["Vapi Evals", "success", "No checks affected by this change"]],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a dry run of an affected PR (fork or Dependabot) posts an error aggregate and sends nothing", async () => {
  await withLiveStub(async (stub) => {
    const root = liveCopy(stub);
    try {
      const result = await withGitHubEnv(stub, join(root, "summary.md"), () =>
        run(["--all", "--dry-run"], root),
      );
      assert.deepEqual(
        [
          result.code,
          stub.vapiPosts,
          stub.statuses.map((s) => [s.context, s.state]),
        ],
        [0, 0, [["Vapi Evals", "error"]]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("an invalid vapi-checks.yml still posts an error aggregate", async () => {
  await withLiveStub(async (stub) => {
    const root = liveCopy(stub);
    try {
      writeFileSync(join(root, "vapi-checks.yml"), "version: 2\n");
      const result = await withGitHubEnv(stub, join(root, "summary.md"), () =>
        run(["--all"], root),
      );
      assert.deepEqual(
        [
          result.code,
          stub.statuses.map((s) => [s.context, s.state, s.description]),
        ],
        [2, [["Vapi Evals", "error", "vapi-checks.yml is invalid"]]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
