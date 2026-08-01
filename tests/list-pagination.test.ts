import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Vapi list endpoints cap a response at 100 items and expose no page cursor,
// only `createdAt` comparison filters. These tests pin the resulting pager.
//
// They assert on the REQUESTS the engine makes, not only on what it does with
// responses. That distinction matters: the original implementation omitted
// `limit` from its first request and decided completeness by comparing the
// response length against its own page size — so it was really comparing against
// the API's default. Every response-only test passed, because the stub happened
// to answer the way the author assumed the API did.
// ─────────────────────────────────────────────────────────────────────────────

// config.ts exits at module load without a token and a slug-shaped argv[2].
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

interface StubReply {
  status?: number;
  body: unknown;
}

const requests: string[] = [];
let reply: (url: string) => StubReply = () => ({ body: [] });

const server = createServer((req, res) => {
  requests.push(req.url ?? "");
  const answer = reply(req.url ?? "");
  res.statusCode = answer.status ?? 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(answer.body));
});
await new Promise<void>((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve()),
);
server.unref();
const { port } = server.address() as AddressInfo;

// Must be set before importing pull.ts — config.ts freezes the base URL at load.
process.env.VAPI_BASE_URL = `http://127.0.0.1:${port}`;
const { fetchAllResources } = await import("../src/pull.ts");

const BASE = Date.parse("2026-06-01T00:00:00.000Z");

/** `count` tools, newest first, one minute apart — the shape a real page has. */
function page(count: number, startIndex = 0, createdAt?: string) {
  return Array.from({ length: count }, (_, i) => {
    const index = startIndex + i;
    return {
      id: `tool-${index}`,
      name: `tool ${index}`,
      createdAt: createdAt ?? new Date(BASE - index * 60_000).toISOString(),
    };
  });
}

async function capturingWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string }> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { result: await run(), warnings: lines.join("\n") };
  } finally {
    console.warn = original;
  }
}

function reset(next: (url: string) => StubReply) {
  requests.length = 0;
  reply = next;
}

test("the first request carries ?limit, so the page size is ours not the API's", async () => {
  // The regression this pins. If `limit` is omitted, the engine compares a
  // response capped at the API's default against its own LIST_PAGE_SIZE — a
  // comparison that is only correct while those two numbers happen to match.
  reset(() => ({ body: page(3) }));
  await fetchAllResources("tools");

  assert.equal(requests.length, 1, "a short listing costs exactly one request");
  assert.match(requests[0] as string, /^\/tool\?limit=100$/);
});

test("a short first page is complete: no second request, no warning", async () => {
  reset(() => ({ body: page(7) }));
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  assert.equal(result.length, 7);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(warnings, /incomplete/);
});

test("a full first page is paged through until a short page arrives", async () => {
  reset((url) =>
    url.includes("createdAtLe")
      ? { body: page(4, 100) }
      : { body: page(100) },
  );
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  assert.equal(result.length, 104, "both pages are returned");
  assert.equal(requests.length, 2);
  assert.match(requests[1] as string, /createdAtLe=/);
  assert.doesNotMatch(warnings, /incomplete/);
});

test("the cursor is inclusive, so items sharing the boundary timestamp survive", async () => {
  // `createdAtLt` would exclude every item stamped exactly at the boundary.
  // Resources created in bulk do collide on `createdAt`, and a dropped item then
  // looks deleted to anything that infers absence.
  const shared = new Date(BASE - 99 * 60_000).toISOString();
  const firstPage = [...page(99), { id: "boundary-a", name: "a", createdAt: shared }];
  const secondPage = [
    { id: "boundary-a", name: "a", createdAt: shared }, // re-read, deduped
    { id: "boundary-b", name: "b", createdAt: shared }, // would be lost by `Lt`
  ];
  reset((url) =>
    url.includes("createdAtLe") ? { body: secondPage } : { body: firstPage },
  );
  const result = await fetchAllResources("tools");

  const ids = result.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "the boundary item is not duplicated");
  assert.ok(ids.includes("boundary-b"), "the co-timestamped item is not dropped");
});

test("an endpoint that ignores the cursor is reported, not looped on", async () => {
  // Returning the same full page forever must terminate and be flagged, rather
  // than spinning to the page cap or silently claiming completeness.
  reset(() => ({ body: page(100) }));
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  assert.equal(result.length, 100);
  assert.equal(requests.length, 2, "one probe past the first page is enough");
  assert.match(warnings, /listing may be incomplete/);
});

test("a page with no usable createdAt cannot be paged, and says so", async () => {
  reset(() => ({
    body: Array.from({ length: 100 }, (_, i) => ({ id: `x-${i}`, name: `x ${i}` })),
  }));
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  assert.equal(result.length, 100);
  assert.equal(requests.length, 1, "no cursor is guessable, so no second request");
  assert.match(warnings, /listing may be incomplete/);
});

test("an endpoint that rejects ?limit falls back to a bare request", async () => {
  // Degrade rather than fail the whole pull — but never claim completeness,
  // because without a known page size there is nothing to compare against.
  reset((url) =>
    url.includes("limit=")
      ? { status: 400, body: { message: "limit is not supported" } }
      : { body: page(3) },
  );
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  assert.equal(result.length, 3, "the bare request's items are still returned");
  assert.match(requests[0] as string, /limit=100/);
  assert.equal(requests[1], "/tool");
  assert.match(warnings, /rejected \?limit/);
});

test("the { results } wrapper shape is unwrapped and paged like a bare array", async () => {
  // structured-output wraps its list; the pager must see through it on both the
  // first request and the cursor requests.
  reset((url) =>
    url.includes("createdAtLe")
      ? { body: { results: page(2, 100), metadata: {} } }
      : { body: { results: page(100), metadata: {} } },
  );
  const result = await fetchAllResources("structuredOutputs");

  assert.equal(result.length, 102);
  assert.match(requests[0] as string, /^\/structured-output\?limit=100$/);
});

test("the cursor advances across several pages, not just one", async () => {
  // Two-page walks can pass by accident: a stub that answers any cursor with the
  // same second page looks identical to a working walk. Serving strictly older
  // slices per cursor proves the engine is threading the timestamp through.
  reset((url) => {
    const match = url.match(/createdAtLe=([^&]+)/);
    if (!match) return { body: page(100) };
    const cursor = decodeURIComponent(match[1] as string);
    const index = Math.round((BASE - Date.parse(cursor)) / 60_000);
    // Everything strictly older than the cursor, capped at a page.
    const remaining = 250 - index;
    return { body: page(Math.min(100, Math.max(0, remaining)), index) };
  });
  const { result, warnings } = await capturingWarnings(() =>
    fetchAllResources("tools"),
  );

  const ids = new Set(result.map((r) => r.id));
  assert.equal(ids.size, result.length, "no duplicates across pages");
  assert.equal(result.length, 250, "every item across three pages is returned");
  assert.ok(requests.length >= 3, `expected a multi-page walk, made ${requests.length}`);
  assert.doesNotMatch(warnings, /incomplete/);
});
