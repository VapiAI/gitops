import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A test's cleanup once removed the repository it ran in. tests/drift.test.ts
// cleaned up with
//
//   rmSync(dirname(dirname(hashStoreDir(env))), { recursive: true, force: true })
//
// which assumed hashStoreDir was state/<org>/local/baselines. With any
// .vapi-state.<org>.json at the root, hashStoreDir is .vapi-state-hash/<org>,
// and two folders up from that is the repository root: src/, resources/,
// .git and every .env file. The run still reported every test as passed.
//
// Each case below runs tests/drift.test.ts inside a throwaway copy, in a
// folder of its own, so nothing outside the copy can be removed.
// tests/suite-leaves-the-repository.test.ts does the same with the whole
// suite and compares every file.

const REPO = fileURLToPath(new URL("..", import.meta.url));

function suiteLeavesRepository(stateFiles: Record<string, string>): {
  exit: number | null;
  ran: boolean;
  kept: boolean;
} {
  const box = mkdtempSync(join(tmpdir(), "suite-keeps-repo-"));
  const root = join(box, "repo");
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    for (const name of ["drift.test.ts", "no-vapi-api.ts"])
      cpSync(join(REPO, "tests", name), join(root, "tests", name));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    for (const [path, content] of Object.entries(stateFiles)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    // A test runner started from inside another one runs nothing unless this
    // is cleared, and the case would pass without having run.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        "tests/drift.test.ts",
      ],
      { cwd: root, encoding: "utf8", env },
    );
    return {
      exit: run.status,
      ran: /^# pass [1-9]/m.test(run.stdout),
      kept:
        existsSync(join(root, "package.json")) && existsSync(join(root, "src")),
    };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

const STATE = '{\n  "assistants": {}\n}\n';

test("the drift tests leave the repository in place, wherever its state is", () => {
  assert.deepEqual(
    {
      "no state at all": suiteLeavesRepository({}),
      "state in state/acme/": suiteLeavesRepository({
        "state/acme/state.json": STATE,
      }),
      "state at the root (.vapi-state.acme.json)": suiteLeavesRepository({
        ".vapi-state.acme.json": STATE,
      }),
    },
    {
      "no state at all": { exit: 0, ran: true, kept: true },
      "state in state/acme/": { exit: 0, ran: true, kept: true },
      "state at the root (.vapi-state.acme.json)": {
        exit: 0,
        ran: true,
        kept: true,
      },
    },
  );
});
