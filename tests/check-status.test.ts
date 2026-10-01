import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  commitStateWorst,
  commitStatusPost,
  githubStatusEnvRead,
  targetContext,
} from "../src/check-status.ts";

async function withGitHub(
  status: number,
  fn: (
    apiUrl: string,
    seen: Array<{ url: string; auth: string; body: unknown }>,
  ) => Promise<void>,
): Promise<void> {
  const seen: Array<{ url: string; auth: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({
        url: `${req.method} ${req.url}`,
        auth: String(req.headers.authorization),
        body: JSON.parse(raw),
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      seen,
    );
  } finally {
    console.warn = warn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("githubStatusEnvRead needs the token, repository and head SHA", () => {
  assert.deepEqual(
    [
      githubStatusEnvRead({
        GITHUB_TOKEN: "t",
        GITHUB_REPOSITORY: "acme/gitops",
      }),
      githubStatusEnvRead({
        GITHUB_TOKEN: "t",
        GITHUB_REPOSITORY: "acme/gitops",
        HEAD_SHA: "abc",
        GITHUB_RUN_ID: "42",
      }),
    ],
    [
      undefined,
      {
        token: "t",
        repo: "acme/gitops",
        sha: "abc",
        apiUrl: "https://api.github.com",
        runUrl: "https://github.com/acme/gitops/actions/runs/42",
      },
    ],
  );
});

test("statuses post to the head SHA with the run link, and long descriptions are cut to 140", async () => {
  await withGitHub(201, async (apiUrl, seen) => {
    const ok = await commitStatusPost(
      { token: "t", repo: "acme/gitops", sha: "abc", apiUrl },
      {
        context: targetContext("core", "squads/main"),
        state: "failure",
        description: "x".repeat(200),
        targetUrl: "https://run",
      },
    );
    const body = seen[0]!.body as { description: string };
    assert.deepEqual(
      [
        ok,
        seen[0]!.url,
        seen[0]!.auth,
        { ...body, description: body.description.length },
      ],
      [
        true,
        "POST /repos/acme/gitops/statuses/abc",
        "Bearer t",
        {
          context: "Vapi Evals / core / squads/main",
          state: "failure",
          description: 140,
          target_url: "https://run",
        },
      ],
    );
  });
});

test("a rejected status (read-only token) only warns", async () => {
  await withGitHub(403, async (apiUrl) => {
    assert.equal(
      await commitStatusPost(
        { token: "t", repo: "acme/gitops", sha: "abc", apiUrl },
        { context: "Vapi Evals", state: "success", description: "ok" },
      ),
      false,
    );
  });
});

test("the worst state wins: error > failure > pending > success", () => {
  assert.deepEqual(
    [
      commitStateWorst([]),
      commitStateWorst(["success", "pending"]),
      commitStateWorst(["failure", "pending", "success"]),
      commitStateWorst(["failure", "error"]),
    ],
    ["success", "pending", "failure", "error"],
  );
});
