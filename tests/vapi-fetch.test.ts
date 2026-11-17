import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { TokenBucket } from "../src/rate-limit.ts";
import { limitedVapiFetch } from "../src/vapi-fetch.ts";
import { userAgentGet, vapiClientGet } from "../src/user-agent.ts";

test("Headers objects and header arrays preserve authorization and caller client headers", async () => {
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (const headers of [
      new Headers({ Authorization: "Bearer object" }),
      [["Authorization", "Bearer array"]],
      new Headers({
        Authorization: "Bearer custom",
        "User-Agent": "caller-agent",
        "x-vapi-client": "caller-client",
      }),
      [
        ["Authorization", "Bearer custom-array"],
        ["User-Agent", "array-agent"],
        ["x-vapi-client", "array-client"],
      ],
    ] as Array<NonNullable<RequestInit["headers"]>>) {
      const response = await limitedVapiFetch(
        new TokenBucket(100),
        `http://127.0.0.1:${port}`,
        { headers },
      );
      await response.text();
    }
    assert.deepEqual(
      seen.map((headers) => headers.authorization),
      ["Bearer object", "Bearer array", "Bearer custom", "Bearer custom-array"],
    );
    assert.deepEqual(
      seen.map((headers) => headers["user-agent"]),
      [userAgentGet(), userAgentGet(), "caller-agent", "array-agent"],
    );
    assert.deepEqual(
      seen.map((headers) => headers["x-vapi-client"]),
      [vapiClientGet(), vapiClientGet(), "caller-client", "array-client"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an already aborted request never reaches fetch", async () => {
  await assert.rejects(
    limitedVapiFetch(new TokenBucket(100), "http://127.0.0.1:1", {
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
});
