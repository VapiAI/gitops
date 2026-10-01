import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  childRun,
  connectionLoad,
  envValue,
  tokensParse,
} from "../src/org-connection.ts";

// childRun starts `node --import tsx` in rootDir, so child fixtures live
// under the repo (gitignored tmp/) where tsx resolves.
const REPO_TMP = fileURLToPath(new URL("../tmp/", import.meta.url));

function repoTempDir(): string {
  mkdirSync(REPO_TMP, { recursive: true });
  return mkdtempSync(join(REPO_TMP, "org-connection-"));
}

function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("envValue reads plain and quoted values and ignores other keys", () => {
  const content = [
    "VAPI_TOKEN_OTHER=nope",
    "  VAPI_PRIVATE_API_KEY='quoted-key'",
    'VAPI_BASE_URL="https://api.eu.vapi.ai"',
    "EMPTY=",
  ].join("\n");
  assert.deepEqual(
    [
      envValue(content, "VAPI_PRIVATE_API_KEY"),
      envValue(content, "VAPI_BASE_URL"),
      envValue(content, "EMPTY"),
      envValue(content, "MISSING"),
    ],
    ["quoted-key", "https://api.eu.vapi.ai", undefined, undefined],
  );
});

test("tokensParse reads the named variable", () => {
  const tokens = withEnv("TEST_TOKENS", '{"acme":"t1","acme-ci":"t2"}', () =>
    tokensParse("TEST_TOKENS"),
  );
  assert.deepEqual(
    [...tokens],
    [
      ["acme", "t1"],
      ["acme-ci", "t2"],
    ],
  );
});

test("tokensParse names the variable in every error", () => {
  const errors = ["not json", "[]", '{"acme":""}'].map((value) =>
    withEnv("TEST_TOKENS", value, () => {
      try {
        tokensParse("TEST_TOKENS");
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    }),
  );
  assert.deepEqual(errors, [
    "TEST_TOKENS must be valid JSON",
    "TEST_TOKENS must map org slugs to tokens",
    "TEST_TOKENS entry for acme must be a non-empty token string",
  ]);
});

test("tokensParse returns an empty map when the variable is unset", () => {
  assert.equal(
    withEnv("TEST_TOKENS", undefined, () => tokensParse("TEST_TOKENS")).size,
    0,
  );
});

test("connectionLoad prefers the token map, then .env.<org>", () => {
  const root = mkdtempSync(join(tmpdir(), "org-connection-"));
  try {
    writeFileSync(
      join(root, ".env.acme"),
      "VAPI_PRIVATE_API_KEY=env-key\nVAPI_BASE_URL=https://api.eu.vapi.ai\n",
    );
    const base = { rootDir: root, org: "acme", tokensEnvName: "TEST_TOKENS" };
    assert.deepEqual(
      [
        connectionLoad({ ...base, tokens: new Map([["acme", "map-key"]]) }),
        connectionLoad({ ...base, tokens: new Map() }),
        connectionLoad({
          ...base,
          tokens: new Map(),
          baseUrl: "https://configured.example",
        }),
      ],
      [
        { token: "map-key", baseUrl: "https://api.eu.vapi.ai" },
        { token: "env-key", baseUrl: "https://api.eu.vapi.ai" },
        { token: "env-key", baseUrl: "https://configured.example" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("connectionLoad names the token variable when no key is found", () => {
  const root = mkdtempSync(join(tmpdir(), "org-connection-"));
  try {
    assert.throws(
      () =>
        connectionLoad({
          rootDir: root,
          org: "acme",
          tokens: new Map(),
          tokensEnvName: "VAPI_CHECK_TOKENS",
        }),
      {
        message:
          "Missing token for org acme; set VAPI_CHECK_TOKENS or .env.acme",
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("childRun passes the org and its key to the child, and drops an inherited base URL", () => {
  const root = repoTempDir();
  try {
    const out = join(root, "out.json");
    writeFileSync(
      join(root, "child.ts"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  args: process.argv.slice(2),
  key: process.env.VAPI_PRIVATE_API_KEY,
  token: process.env.VAPI_TOKEN,
  baseUrl: process.env.VAPI_BASE_URL ?? null,
}));
`,
    );
    withEnv("VAPI_BASE_URL", "https://inherited.example", () =>
      childRun({
        rootDir: root,
        script: "child.ts",
        org: "acme",
        connection: { token: "secret" },
        args: ["--bootstrap"],
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
      args: ["acme", "--bootstrap"],
      key: "secret",
      token: "secret",
      baseUrl: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("childRun throws when the script fails", () => {
  const root = repoTempDir();
  try {
    writeFileSync(join(root, "fail.ts"), "process.exit(4);\n");
    assert.throws(
      () =>
        childRun({
          rootDir: root,
          script: "fail.ts",
          org: "acme",
          connection: { token: "secret", baseUrl: "https://api.vapi.ai" },
          args: [],
        }),
      { message: "fail.ts failed for acme" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
