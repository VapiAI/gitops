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

// Regression tests for P0-4.
//
// The branch `feat/optimization-gitops-flow` removed both pre-existing
// safety gates from cleanup.ts:
//   1. `--confirm <slug>` double-gate — so a stray `--force` from another
//      command can't go destructive.
//   2. Empty-state refusal — so a fresh clone or corrupted state file can't
//      be misread as "all remote resources are orphaned" → wipe the org.
//
// These integration tests spawn `tsx src/cleanup.ts` against a tmp working
// directory (with node_modules symlinked from the real repo) and confirm
// the safety gates short-circuit BEFORE any API call is made.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function setupFixture(stateContent: object | null): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vapi-cleanup-test-"));
  // Copy the source tree so cleanup.ts's relative imports work and BASE_DIR
  // points into the tmp dir (where we control the state file).
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  // node_modules is too big to copy; symlink it instead.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, ".env.test-cleanup-org"),
    "VAPI_TOKEN=fake-token-not-used\n",
  );
  if (stateContent !== null) {
    writeFileSync(
      join(dir, ".vapi-state.test-cleanup-org.json"),
      JSON.stringify(stateContent),
    );
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function emptyState() {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

function nonEmptyState() {
  return {
    ...emptyState(),
    assistants: { foo: "11111111-1111-1111-1111-111111111111" },
  };
}

function runCleanup(
  cwd: string,
  args: string[],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/cleanup.ts", "test-cleanup-org", ...args],
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
  "P0-4 regression: cleanup --force WITHOUT --confirm <slug> refuses to run",
  () => {
    const fx = setupFixture(nonEmptyState());
    try {
      const res = runCleanup(fx.dir, ["--force"]);
      assert.notEqual(res.code, 0, `must exit non-zero, got ${res.code}`);
      assert.match(
        res.stderr,
        /Refusing to run destructive cleanup without explicit confirmation/,
      );
      assert.doesNotMatch(
        res.stdout,
        /Deleting\.\.\./,
        "must NOT begin deletion",
      );
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "P0-4 regression: cleanup --force --confirm <wrong-slug> refuses to run",
  () => {
    const fx = setupFixture(nonEmptyState());
    try {
      const res = runCleanup(fx.dir, ["--force", "--confirm", "different-org"]);
      assert.notEqual(res.code, 0);
      assert.match(
        res.stderr,
        /Refusing to run destructive cleanup without explicit confirmation/,
      );
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "P0-4 regression: cleanup --force --confirm <slug> with EMPTY state refuses",
  () => {
    // Fresh-clone scenario: state file exists but is empty. Every remote
    // resource would be treated as orphaned. Must refuse.
    const fx = setupFixture(emptyState());
    try {
      const res = runCleanup(fx.dir, [
        "--force",
        "--confirm",
        "test-cleanup-org",
      ]);
      assert.notEqual(res.code, 0);
      assert.match(
        res.stderr,
        /Refusing to run destructive cleanup: state file has 0 tracked resources/,
      );
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "cleanup dry-run (default, no --force) is allowed without --confirm — it " +
    "never deletes anything regardless of state contents",
  () => {
    const fx = setupFixture(emptyState());
    try {
      const res = runCleanup(fx.dir, []);
      // Dry-run will fail when it tries to call the (fake) API, but the
      // safety refusal must NOT have triggered.
      assert.doesNotMatch(
        res.stderr,
        /Refusing to run destructive cleanup/,
        "dry-run must not be blocked by the destructive safety gates",
      );
    } finally {
      fx.cleanup();
    }
  },
);
