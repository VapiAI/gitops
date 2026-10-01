import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { CheckJob } from "../src/check-build.ts";
import { checksConfigParse } from "../src/check-config.ts";
import { MOCK_MARKER } from "../src/check-mocks.ts";
import type { CheckRunBody } from "../src/check-payload.ts";
import type { CheckRunArgs, CheckTargetResult } from "../src/check-run.ts";
import { checkRunAll, MIN_START_MS } from "../src/check-run.ts";

// checkRunAll against a stateful stub of the simulations API. The target
// assistant's name picks the stub's behaviour for that run.

type Behaviour =
  "pass" | "fail" | "skipped" | "hang" | "slow" | "unmocked" | "402" | "502";

interface StubRun {
  id: string;
  behaviour: Behaviour;
  total: number;
  polls: number;
  canceled: boolean;
  ended: boolean;
}

interface Stub {
  baseUrl: string;
  requests: string[];
  userAgents: Set<string>;
  maxActive: number;
}

const DEADLINE_FAR = () => Date.now() + 60 * 60_000;

function item(run: StubRun, index: number): Record<string, unknown> {
  const failed = run.behaviour === "fail" && index === 0;
  const skipped = run.behaviour === "skipped";
  return {
    id: `${run.id}-item-${index}`,
    status: failed ? "failed" : "passed",
    metadata: {
      simulation: { name: `S${index + 1}` },
      // Items echo the scenario, default mocks included, called or not.
      scenario: {
        toolMocks: [
          {
            toolName: "lookup",
            result: JSON.stringify({
              error: `${MOCK_MARKER} lookup is not mocked in this scenario`,
            }),
          },
        ],
      },
      call: {
        messages:
          run.behaviour === "unmocked"
            ? [
                {
                  role: "tool_calls",
                  toolCalls: [{ id: "call_1", function: { name: "book" } }],
                },
                {
                  role: "tool_call_result",
                  name: "call_1",
                  result: JSON.stringify({
                    error: `${MOCK_MARKER} book is not mocked in this scenario`,
                  }),
                },
              ]
            : [],
      },
    },
    results: {
      passed: !failed,
      evaluations: [
        {
          name: "goal-met",
          required: true,
          comparator: "=",
          expectedValue: true,
          extractedValue: !failed,
          passed: !failed,
          isSkipped: skipped,
        },
      ],
    },
  };
}

async function withStub(fn: (stub: Stub) => Promise<void>): Promise<void> {
  const runs = new Map<string, StubRun>();
  const stub: Stub = {
    baseUrl: "",
    requests: [],
    userAgents: new Set(),
    maxActive: 0,
  };
  const active = () => [...runs.values()].filter((run) => !run.ended).length;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      stub.requests.push(`${req.method} ${req.url}`);
      stub.userAgents.add(String(req.headers["user-agent"]));
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/eval/simulation/run") {
        const body = JSON.parse(raw) as CheckRunBody;
        const behaviour = (
          body.target.type === "assistant" ? body.target.assistant.name : "pass"
        ) as Behaviour;
        if (behaviour === "402")
          return reply(402, { message: "Insufficient credits" });
        if (behaviour === "502") return reply(502, { message: "Bad gateway" });
        const id = `run-${runs.size + 1}`;
        const total = body.simulations.length * body.iterations;
        runs.set(id, {
          id,
          behaviour,
          total,
          polls: 0,
          canceled: false,
          ended: false,
        });
        stub.maxActive = Math.max(stub.maxActive, active());
        return reply(201, {
          id,
          url: `https://dashboard.vapi.ai/simulations/runs/${id}`,
          status: "queued",
          simulationRunItemIds: Array.from(
            { length: total },
            (_, i) => `${id}-item-${i}`,
          ),
        });
      }
      const match = url.match(/^\/eval\/simulation\/run\/(run-\d+)(\/item)?/);
      const run = match ? runs.get(match[1]!) : undefined;
      if (!run) return reply(404, { message: "not found" });
      if (req.method === "PATCH") {
        if (run.canceled)
          return reply(400, { message: "Run has already ended" });
        run.canceled = true;
        run.ended = true;
        return reply(200, { id: run.id, status: "ended" });
      }
      if (match![2]) {
        const items = Array.from({ length: run.total }, (_, i) => item(run, i));
        return reply(200, {
          results: items,
          metadata: { totalItems: items.length },
        });
      }
      run.polls++;
      const ended =
        run.behaviour !== "hang" &&
        (run.behaviour !== "slow" || run.polls >= 3);
      if (ended) run.ended = true;
      const failed = run.behaviour === "fail" ? 1 : 0;
      return reply(200, {
        id: run.id,
        status: ended ? "ended" : "running",
        itemCounts: ended
          ? {
              total: run.total,
              passed: run.total - failed,
              failed,
              running: 0,
              queued: 0,
              canceled: 0,
            }
          : {
              total: run.total,
              passed: 0,
              failed: 0,
              running: run.total,
              queued: 0,
              canceled: 0,
            },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const log = console.log;
  console.log = () => {};
  try {
    await fn(stub);
  } finally {
    console.log = log;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function job(name: string, extra = "", entries = 2): CheckJob {
  const check = checksConfigParse(
    `version: 1\nchecks:\n  core:\n    org: acme\n    targets: [assistants/${name.toLowerCase()}]\n    suites: [core]\n${extra}`,
  ).checks.core!;
  const body: CheckRunBody = {
    simulations: Array.from({ length: entries }, (_, i) => ({
      type: "simulation" as const,
      name: `S${i + 1}`,
      scenario: { name: `S${i + 1}` },
      personalityId: "a0000000-0000-4000-8000-000000000001",
    })),
    target: { type: "assistant", assistant: { name } },
    transport: { provider: "vapi.webchat" },
    iterations: 1,
  };
  return {
    check,
    target: check.targets[0]!,
    label: `core / assistants/${name.toLowerCase()}`,
    result: { body, errors: [], warnings: [], bytes: 0 },
  };
}

function runArgs(
  stub: Stub,
  jobs: CheckJob[],
  extra: Partial<CheckRunArgs> = {},
): CheckRunArgs {
  return {
    jobs,
    connectionFor: () => ({
      token: "t",
      baseUrl: stub.baseUrl,
      userAgent: "vapi-gitops-check/test",
    }),
    deadline: DEADLINE_FAR(),
    pollIntervalMs: 1,
    hydrationMs: 50,
    ...extra,
  };
}

const summary = (result: CheckTargetResult) => [
  result.outcome,
  result.reason,
  result.url,
];

test("a passing run passes, with its link", async () => {
  await withStub(async (stub) => {
    const [result] = await checkRunAll(runArgs(stub, [job("pass")]));
    assert.deepEqual(
      [...summary(result!), [...stub.userAgents]],
      [
        "passed",
        "2 of 2 simulations passed",
        "https://dashboard.vapi.ai/simulations/runs/run-1",
        ["vapi-gitops-check/test"],
      ],
    );
  });
});

test("two targets run, and the failing one names the evaluation", async () => {
  await withStub(async (stub) => {
    const results = await checkRunAll(
      runArgs(stub, [job("pass"), job("fail")]),
    );
    assert.deepEqual(
      [results.map((r) => r.outcome), results[1]!.failures],
      [
        ["passed", "failed"],
        [
          {
            item: "S1",
            evaluation: "goal-met",
            comparator: "=",
            expected: true,
            extracted: false,
            reason: undefined,
          },
        ],
      ],
    );
  });
});

test("every required evaluation skipped is incomplete, not a pass", async () => {
  await withStub(async (stub) => {
    const [result] = await checkRunAll(runArgs(stub, [job("skipped")]));
    assert.deepEqual(summary(result!).slice(0, 2), [
      "incomplete",
      "2 simulations had every required evaluation skipped (S1, S2)",
    ]);
  });
});

test("a run past its timeout is canceled and incomplete", async () => {
  await withStub(async (stub) => {
    const [result] = await checkRunAll(
      runArgs(stub, [job("hang", "    timeoutMinutes: 0.001\n")]),
    );
    assert.deepEqual(
      [
        result!.outcome,
        /timed out after \d+s; run canceled/.test(result!.reason),
        stub.requests.filter((r) => r.startsWith("PATCH")),
      ],
      ["incomplete", true, ["PATCH /eval/simulation/run/run-1"]],
    );
  });
});

test("an abort (SIGINT/SIGTERM) cancels in-flight runs and doesn't start new ones", async () => {
  await withStub(async (stub) => {
    const controller = new AbortController();
    const results = await checkRunAll(
      runArgs(stub, [job("hang"), job("pass")], {
        signal: controller.signal,
        concurrency: 1,
        onRunCreated: async () => {
          setTimeout(() => controller.abort(), 20);
        },
      }),
    );
    assert.deepEqual(
      [
        results.map((r) => [r.outcome, r.reason]),
        stub.requests.filter((r) => r.startsWith("POST")).length,
      ],
      [
        [
          ["incomplete", "interrupted; run canceled"],
          ["incomplete", "not started: interrupted"],
        ],
        1,
      ],
    );
  });
});

test("runs that can't fit in the remaining budget aren't started", async () => {
  await withStub(async (stub) => {
    const [result] = await checkRunAll(
      runArgs(stub, [job("pass")], {
        deadline: Date.now() + MIN_START_MS - 60_000,
      }),
    );
    assert.deepEqual(
      [result!.outcome, result!.reason, stub.requests],
      ["incomplete", "not started: 4 min of budget left", []],
    );
  });
});

test("402 is reported as a billing problem; a 5xx on create is never retried", async () => {
  await withStub(async (stub) => {
    const results = await checkRunAll(runArgs(stub, [job("402"), job("502")]));
    assert.deepEqual(
      [
        results.map((r) => [r.outcome, r.reason]),
        stub.requests.filter((r) => r.startsWith("POST")).length,
      ],
      [
        [
          [
            "incomplete",
            "billing: the run org can't start simulations (402: Insufficient credits)",
          ],
          [
            "incomplete",
            "API POST /eval/simulation/run failed (502): Bad gateway",
          ],
        ],
        2,
      ],
    );
  });
});

test("a payload that didn't build is an error and sends nothing", async () => {
  await withStub(async (stub) => {
    const broken = job("pass");
    broken.result = { errors: ["boom", "bang"], warnings: [], bytes: 0 };
    const [result] = await checkRunAll(runArgs(stub, [broken]));
    assert.deepEqual(
      [result!.outcome, result!.reason, stub.requests],
      ["error", "payload could not be built (2 problems)", []],
    );
  });
});

test("default-mock answers in transcripts are reported as unmocked tool calls; uncalled defaults aren't", async () => {
  await withStub(async (stub) => {
    const [clean, result] = await checkRunAll(
      runArgs(stub, [job("pass"), job("unmocked")]),
    );
    assert.deepEqual(clean!.mockNotices, []);
    assert.deepEqual(result!.mockNotices, [
      "S1: unmocked tool called: book",
      "S2: unmocked tool called: book",
    ]);
  });
});

test("at most three runs are in flight, and results come back in job order", async () => {
  await withStub(async (stub) => {
    const jobs = ["slow", "slow", "slow", "slow", "fail"].map((name) =>
      job(name),
    );
    const results = await checkRunAll(runArgs(stub, jobs));
    assert.deepEqual(
      [stub.maxActive, results.map((r) => r.outcome)],
      [3, ["passed", "passed", "passed", "passed", "failed"]],
    );
  });
});
