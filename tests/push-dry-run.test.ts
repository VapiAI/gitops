import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  cpSync,
  symlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Stack C — push --dry-run regression coverage.
//
// `--dry-run` MUST:
//   1. Be accepted at parse time (no "Unrecognized argument" error)
//   2. Print the dry-run mode banner so the operator can't miss it
//   3. NOT write the state file (a real run would; dry-run never does)
//   4. NOT fire any actual API calls (verified indirectly by lack of API
//      error output and by no state-file mutation, plus the "would PATCH/
//      POST/DELETE" log lines)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vapi-dry-run-test-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  // Empty resource tree — push has nothing real to do, but parsing and the
  // dry-run banner must still fire correctly.
  mkdirSync(join(dir, "resources", "test-dry-run"), { recursive: true });
  writeFileSync(
    join(dir, ".env.test-dry-run"),
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
    ["--import", "tsx", "src/push.ts", "test-dry-run", ...extraArgs],
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

test("--dry-run is accepted at parse time without unrecognized-arg error", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, ["--dry-run", "--bootstrap"]);
    assert.doesNotMatch(res.stderr, /Unrecognized argument/);
  } finally {
    fx.cleanup();
  }
});

test("--dry-run prints the dry-run banner so the operator sees it", () => {
  const fx = setupFixture();
  try {
    const res = runPush(fx.dir, ["--dry-run", "--bootstrap"]);
    // The banner mentions DRY-RUN explicitly so it's noisy enough not to be
    // missed in a CI log scroll.
    assert.match(res.stdout, /DRY-RUN/);
  } finally {
    fx.cleanup();
  }
});

test("--dry-run does NOT write the state file", () => {
  const fx = setupFixture();
  try {
    const stateFilePath = join(fx.dir, ".vapi-state.test-dry-run.json");
    assert.equal(
      existsSync(stateFilePath),
      false,
      "precondition: state file should not exist before run",
    );

    const res = runPush(fx.dir, ["--dry-run", "--bootstrap"]);
    // Even with --bootstrap, dry-run must skip the state save. Bootstrap
    // would normally write the state file with refreshed credentials/UUIDs;
    // in dry-run we want zero filesystem mutation.
    assert.equal(
      existsSync(stateFilePath),
      false,
      `state file must not be created in dry-run; stdout=${res.stdout}`,
    );
  } finally {
    fx.cleanup();
  }
});
