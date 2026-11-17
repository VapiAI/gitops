import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

test("API writes use the limiter burst and sustained rate without another gap", async () => {
  const seen: Array<{ method: string; time: number }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, time: performance.now() });
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"id":"stub-resource"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.argv = ["node", "src/push.ts", "write-pacing-test"];
  process.env.VAPI_TOKEN = "test-token-not-used";
  process.env.VAPI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.VAPI_MAX_GITOPS_RPM = "300";
  try {
    const { vapiRequest, vapiDelete } = await import("../src/api.ts");
    for (let i = 0; i < 23; i++) {
      if (i % 3 === 2) await vapiDelete("/assistant/stub-resource");
      else await vapiRequest(i % 3 === 0 ? "POST" : "PATCH", "/assistant", {});
    }
    assert.deepEqual(
      seen.map(({ method }) => method),
      Array.from({ length: 23 }, (_, i) => ["POST", "PATCH", "DELETE"][i % 3]),
    );
    assert.ok(
      seen[2]!.time - seen[0]!.time < 1000,
      "writes within the limiter burst must not wait for a second pacing policy",
    );
    assert.ok(
      seen[22]!.time - seen[0]!.time >= 500,
      "writes beyond the twenty-token burst must wait for the limiter",
    );
    assert.ok(
      seen[22]!.time - seen[21]!.time >= 140,
      "sustained writes must be spaced by the configured refill rate",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
