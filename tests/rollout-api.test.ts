import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { allocationConflictGet, rolloutApiCreate } from "../src/rollout-api.ts";
import { vapiClientGet } from "../src/user-agent.ts";
import { VapiApiError } from "../src/vapi-client.ts";

interface Seen {
  method?: string;
  url?: string;
  vapiClient?: string;
  body?: string;
}

// A local stand-in for the API: answers every request with `status` and
// `body`, and records the last request.
async function withServer<T>(
  status: number,
  body: unknown,
  fn: (baseUrl: string, seen: Seen, count: () => number) => Promise<T>,
): Promise<T> {
  const seen: Seen = {};
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests++;
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.vapiClient = String(req.headers["x-vapi-client"]);
      seen.body = data;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, seen, () => requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ASSISTANT = "9d1d2f6e-3b0a-4c7b-9f4e-1a2b3c4d5e6f";

test("rolloutApi: an allocation write carries its own command label", async () => {
  await withServer(201, { id: "a1" }, async (baseUrl, seen) => {
    const api = rolloutApiCreate({ token: "t", baseUrl });
    await api.allocationCreate(
      {
        assistantId: ASSISTANT,
        targets: [{ assistantVersion: "v7", percentage: 100 }],
        description: "gitops-rollout pin from=v7",
      },
      "rollout-pin",
    );
    assert.deepEqual(seen, {
      method: "POST",
      url: "/traffic-allocations",
      vapiClient: vapiClientGet("rollout-pin"),
      body: JSON.stringify({
        assistantId: ASSISTANT,
        targets: [{ assistantVersion: "v7", percentage: 100 }],
        description: "gitops-rollout pin from=v7",
      }),
    });
  });
});

test("rolloutApi: a write is not retried after a 5xx", async () => {
  await withServer(
    502,
    { message: "bad gateway" },
    async (baseUrl, _seen, count) => {
      const api = rolloutApiCreate({ token: "t", baseUrl });
      await assert.rejects(
        api.allocationCreate({ assistantId: ASSISTANT }, "rollout-release"),
        VapiApiError,
      );
      assert.equal(count(), 1);
    },
  );
});

test("rolloutApi: reads the latest version and the Vapi for CX lock", async () => {
  await withServer(
    200,
    {
      latestVersion: "v8",
      metadata: { vapiAgentId: "0b8f1a52-4c2e-4f6a-9d3b-7e1c5a9f2d40" },
    },
    async (baseUrl, seen) => {
      const api = rolloutApiCreate({ token: "t", baseUrl });
      assert.deepEqual(await api.assistantGet(ASSISTANT), {
        latestVersion: "v8",
        managed: true,
      });
      assert.equal(seen.url, `/assistant/${ASSISTANT}`);
    },
  );
});

test("rolloutApi: a non-UUID vapiAgentId is not a lock", async () => {
  await withServer(
    200,
    { latestVersion: null, metadata: { vapiAgentId: "my-agent" } },
    async (baseUrl) => {
      const api = rolloutApiCreate({ token: "t", baseUrl });
      assert.deepEqual(await api.assistantGet(ASSISTANT), {
        latestVersion: null,
        managed: false,
      });
    },
  );
});

test("rolloutApi: a deleted assistant reads as null", async () => {
  await withServer(404, { message: "not found" }, async (baseUrl) => {
    const api = rolloutApiCreate({ token: "t", baseUrl });
    assert.equal(await api.assistantGet(ASSISTANT), null);
  });
});

test("rolloutApi: no allocation ever configured reads as null", async () => {
  await withServer(200, {}, async (baseUrl, seen) => {
    const api = rolloutApiCreate({ token: "t", baseUrl });
    assert.equal(await api.allocationLatestGet(ASSISTANT), null);
    assert.equal(
      seen.url,
      `/traffic-allocations/latest?assistantId=${ASSISTANT}`,
    );
  });
});

test("rolloutApi: the probe reports a 403 as traffic splitting off", async () => {
  await withServer(403, { message: "not enabled" }, async (baseUrl, seen) => {
    const api = rolloutApiCreate({ token: "t", baseUrl });
    assert.equal(await api.allocationsProbe(), false);
    assert.equal(seen.url, "/traffic-allocations?limit=1");
  });
});

test("rolloutApi: the probe reports a 200 as traffic splitting on", async () => {
  await withServer(200, { results: [] }, async (baseUrl) => {
    const api = rolloutApiCreate({ token: "t", baseUrl });
    assert.equal(await api.allocationsProbe(), true);
  });
});

for (const [label, status, body, expected] of [
  ["a stale write", 409, { error: "stale_allocation" }, "stale_allocation"],
  [
    "a managed assistant",
    409,
    { error: "assistant_managed_by_vapi_agents" },
    "assistant_managed_by_vapi_agents",
  ],
  ["an unknown 409", 409, { error: "something_else" }, "other"],
  ["a 400", 400, { error: "stale_allocation" }, null],
] as const) {
  test(`allocationConflictGet: classifies ${label}`, () => {
    const error = new VapiApiError(
      "POST",
      "/traffic-allocations",
      status,
      "conflict",
      JSON.stringify(body),
    );
    assert.equal(allocationConflictGet(error), expected);
  });
}
