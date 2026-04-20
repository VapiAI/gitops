import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Regression tests for P0-7 (bare-id refusal half).
//
// The branch dropped a bare resource id like `npm run push -- <org> foo`
// silently — the arg didn't match any type, didn't have a `/` or extension,
// and was simply discarded. With nothing to filter, the engine then ran a
// FULL apply with full orphan-deletion check against the state. With
// `--force` that could wipe every state-tracked resource not on disk.
//
// These tests pin the new strict behavior: any unrecognized positional arg
// is rejected at parse time so the user can't accidentally trigger a full
// apply when they meant a partial.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vapi-cli-arg-test-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, ".env.test-cli-arg-org"),
    "VAPI_TOKEN=fake-token-not-used\n",
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runPush(
  cwd: string,
  extraArgs: string[],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/push.ts", "test-cli-arg-org", ...extraArgs],
    {
      cwd,
      env: { ...process.env, VAPI_TOKEN: "fake-token-not-used" },
      encoding: "utf-8",
      timeout: 20_000,
    },
  );
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

test(
  "P0-7 regression: bare resource id (no slash, no extension) is rejected " +
    "with an explicit error — must NOT silently fall through to a full apply",
  () => {
    const fx = setupFixture();
    try {
      const res = runPush(fx.dir, ["foo"]);
      assert.notEqual(res.code, 0, `must exit non-zero, got ${res.code}`);
      assert.match(res.stderr, /Unrecognized argument: foo/);
      // The push pipeline must NOT have started.
      assert.doesNotMatch(res.stdout, /Loading resources/);
    } finally {
      fx.cleanup();
    }
  },
);

test("misspelled resource type (e.g. assistnts) is rejected", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, ["assistnts"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unrecognized argument: assistnts/);
  } finally {
    fx.cleanup();
  }
});

test("recognized positional resource type is accepted (does not error at parse)", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, ["assistants", "--bootstrap"]);
    // Parse-time error would print "Unrecognized argument" to stderr. The
    // command may still fail later when it tries to talk to the (fake) API,
    // but the parse step must succeed.
    assert.doesNotMatch(
      res.stderr,
      /Unrecognized argument/,
      "valid type arg must not be flagged",
    );
  } finally {
    fx.cleanup();
  }
});

test("file-path arg (with extension) is accepted at parse time", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, ["assistants/foo.yml", "--bootstrap"]);
    assert.doesNotMatch(res.stderr, /Unrecognized argument/);
  } finally {
    fx.cleanup();
  }
});

test("file-path arg in long form is accepted at parse time", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, [
      "resources/test-cli-arg-org/assistants/foo.yml",
      "--bootstrap",
    ]);
    assert.doesNotMatch(res.stderr, /Unrecognized argument/);
  } finally {
    fx.cleanup();
  }
});

test(
  "--confirm <slug> is forwarded through parseFlags without tripping the " +
    "unrecognized-arg refusal (cleanup.ts consumes --confirm directly)",
  () => {
    const fx = setupFixture();
    try {
      const res = runPush(fx.dir, [
        "--confirm",
        "test-cli-arg-org",
        "--bootstrap",
      ]);
      // The slug after --confirm must be EATEN by parseFlags so it doesn't
      // get treated as a positional arg → "Unrecognized argument: test-cli-arg-org"
      assert.doesNotMatch(res.stderr, /Unrecognized argument/);
    } finally {
      fx.cleanup();
    }
  },
);
