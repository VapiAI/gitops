import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runSimulation, simRunItemsFetch } from "../src/sim.ts";

// runSimulation against a local stub of the simulations API. Each stub
// route returns a canned response; requests are recorded so tests can
// assert on what was sent (cancel, retries).

type Handler = (
  req: IncomingMessage,
  body: string,
) => {
  status?: number;
  json?: unknown;
};

async function withServer(
  routes: Array<{ method: string; path: RegExp; handle: Handler }>,
  fn: (baseUrl: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      const route = routes.find(
        (r) => r.method === req.method && r.path.test(req.url ?? ""),
      );
      const out = route ? route.handle(req, body) : { status: 404, json: {} };
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const log = console.log;
  console.log = () => {};
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    console.log = log;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const cfg = (baseUrl: string) => ({ env: "test-org", token: "t", baseUrl });
const selection = {
  entries: [{ type: "simulationSuite" as const, simulationSuiteId: "suite-1" }],
  label: "suite test",
};
const target = { type: "squad" as const, id: "squad-1", resourceName: "s" };
const fast = { pollIntervalMs: 1, hydrationMs: 50 };

const endedRun = (passed: number, failed: number) => ({
  id: "run-1",
  status: "ended",
  itemCounts: {
    total: passed + failed,
    passed,
    failed,
    running: 0,
    queued: 0,
    canceled: 0,
  },
});

const scoredItem = (id: string, status: "passed" | "failed") => ({
  id,
  status,
  results: {
    passed: status === "passed",
    evaluations: [
      {
        name: "goal-met",
        required: true,
        passed: status === "passed",
        comparator: "=",
        expectedValue: true,
        extractedValue: status === "passed",
      },
    ],
  },
  metadata: { simulation: { name: `sim ${id}` } },
});

test("runSimulation: passes when the ended run's items all passed", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: {
            id: "run-1",
            status: "queued",
            url: "https://dashboard.vapi.ai/simulations/run/run-1",
            simulationRunItemIds: ["a", "b"],
          },
        }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({ json: endedRun(2, 0) }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1\/item/,
        handle: () => ({
          json: {
            results: [scoredItem("a", "passed"), scoredItem("b", "passed")],
            metadata: { totalItems: 2, itemsPerPage: 1000, currentPage: 1 },
          },
        }),
      },
    ],
    async (baseUrl) => {
      const summary = await runSimulation(
        cfg(baseUrl),
        selection,
        target,
        fast,
      );
      assert.equal(summary.verdict?.status, "passed");
      assert.equal(
        summary.url,
        "https://dashboard.vapi.ai/simulations/run/run-1",
      );
    },
  );
});

test("runSimulation: a failed item fails the run (the old runner reported a pass)", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: { id: "run-1", status: "queued" },
        }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({ json: endedRun(1, 1) }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1\/item/,
        // The bare-array shape the API returns without page/limit.
        handle: () => ({
          json: [scoredItem("a", "passed"), scoredItem("b", "failed")],
        }),
      },
    ],
    async (baseUrl) => {
      const summary = await runSimulation(
        cfg(baseUrl),
        selection,
        target,
        fast,
      );
      assert.equal(summary.verdict?.status, "failed");
      assert.equal(summary.verdict?.failures[0]?.item, "sim b");
    },
  );
});

test("runSimulation: waits for item results that arrive after the run ends", async () => {
  let reads = 0;
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: { id: "run-1", status: "queued" },
        }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({ json: endedRun(1, 0) }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1\/item/,
        handle: () => {
          reads++;
          // First read: the item is passed but its results aren't written yet.
          return {
            json:
              reads === 1
                ? [{ id: "a", status: "passed" }]
                : [scoredItem("a", "passed")],
          };
        },
      },
    ],
    async (baseUrl) => {
      const summary = await runSimulation(cfg(baseUrl), selection, target, {
        pollIntervalMs: 1,
        hydrationMs: 5_000,
      });
      assert.equal(summary.verdict?.status, "passed");
      assert.ok(reads >= 2);
    },
  );
});

test("runSimulation: a timeout cancels the run and reports incomplete", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: { id: "run-1", status: "queued" },
        }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({ json: { id: "run-1", status: "running" } }),
      },
      {
        method: "PATCH",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({ json: { id: "run-1", status: "ended" } }),
      },
    ],
    async (baseUrl, seen) => {
      const summary = await runSimulation(cfg(baseUrl), selection, target, {
        pollIntervalMs: 5,
        timeoutMs: 30,
      });
      assert.equal(summary.verdict?.status, "incomplete");
      assert.match(summary.verdict?.reason ?? "", /timed out/);
      assert.equal(summary.canceled, true);
      assert.ok(seen.includes("PATCH /eval/simulation/run/run-1"));
    },
  );
});

test("runSimulation: an interrupt cancels; a 400 'already ended' is swallowed", async () => {
  const controller = new AbortController();
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: { id: "run-1", status: "queued" },
        }),
      },
      {
        method: "GET",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => {
          controller.abort();
          return { json: { id: "run-1", status: "running" } };
        },
      },
      {
        method: "PATCH",
        path: /^\/eval\/simulation\/run\/run-1$/,
        handle: () => ({
          status: 400,
          json: { message: "Run has already ended" },
        }),
      },
    ],
    async (baseUrl) => {
      const summary = await runSimulation(cfg(baseUrl), selection, target, {
        pollIntervalMs: 1,
        signal: controller.signal,
      });
      assert.equal(summary.verdict?.status, "incomplete");
      assert.match(summary.verdict?.reason ?? "", /interrupted/);
      assert.equal(summary.canceled, false);
    },
  );
});

test("runSimulation: a 5xx on run create is not retried (it may already have queued the run)", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({ status: 502, json: { message: "Bad Gateway" } }),
      },
    ],
    async (baseUrl, seen) => {
      await assert.rejects(
        runSimulation(cfg(baseUrl), selection, target, fast),
        /failed \(502\)/,
      );
      assert.equal(seen.filter((s) => s.startsWith("POST")).length, 1);
    },
  );
});

test("runSimulation: --no-watch returns after create with the link and no verdict", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: /^\/eval\/simulation\/run$/,
        handle: () => ({
          status: 201,
          json: { id: "run-1", status: "queued", url: "https://x/run-1" },
        }),
      },
    ],
    async (baseUrl, seen) => {
      const summary = await runSimulation(cfg(baseUrl), selection, target, {
        watch: false,
      });
      assert.equal(summary.verdict, undefined);
      assert.equal(summary.url, "https://x/run-1");
      assert.deepEqual(seen, ["POST /eval/simulation/run"]);
    },
  );
});

test("simRunItemsFetch: pages until totalItems and dedupes overlapping pages", async () => {
  const page = (ids: string[]) => ids.map((id) => ({ id, status: "passed" }));
  const first = page(Array.from({ length: 1000 }, (_, i) => `i${i}`));
  await withServer(
    [
      {
        method: "GET",
        path: /\/item\?page=1&/,
        handle: () => ({
          json: { results: first, metadata: { totalItems: 1002 } },
        }),
      },
      {
        method: "GET",
        path: /\/item\?page=2&/,
        // Overlaps the first page by one item (OFFSET drift).
        handle: () => ({
          json: {
            results: page(["i999", "i1000", "i1001"]),
            metadata: { totalItems: 1002 },
          },
        }),
      },
    ],
    async (baseUrl) => {
      const items = await simRunItemsFetch(
        { token: "t", baseUrl, userAgent: "test" },
        "run-1",
      );
      assert.equal(items.length, 1002);
    },
  );
});
