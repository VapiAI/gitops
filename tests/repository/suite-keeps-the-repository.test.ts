import "../engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A test's cleanup once removed the repository it ran in. tests/drift.test.ts
// and tests/tool-assistant-cycle.test.ts cleaned up with
//
//   rmSync(dirname(dirname(hashStoreDir(env))), { recursive: true, force: true })
//
// which assumed hashStoreDir was state/<org>/local/baselines. With any
// .vapi-state.<org>.json at the root, hashStoreDir is .vapi-state-hash/<org>,
// and two folders up from that is the repository root: src/, resources/,
// .git and every .env file. The run still reported every test as passed.
//
// Each case below runs one of those test files inside a throwaway copy, in a
// folder of its own, so nothing outside the copy can be removed, and compares
// every path in the copy before and after.
// suite-leaves-the-repository.test.ts, beside this file, does the same with
// the whole suite and compares every file's content.

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function paths(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((p) => !p.startsWith("node_modules"))
    .sort();
}

function fileLeavesRepository(
  file: string,
  stateFiles: Record<string, string>,
): { exit: number | null; ran: boolean; kept: boolean; same: boolean } {
  const box = mkdtempSync(join(tmpdir(), "suite-keeps-repo-"));
  const root = join(box, "repo");
  try {
    mkdirSync(root, { recursive: true });
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "tests"), join(root, "tests"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    for (const [path, content] of Object.entries(stateFiles)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    writeFileSync(join(root, ".env.acme"), "VAPI_PRIVATE_API_KEY=not-a-key\n");
    const before = paths(root);
    // A test runner started from inside another one runs nothing unless this
    // is cleared, and the case would pass without having run. The two names
    // this file's sandbox set are cleared too, so the copy's test sets its own.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.VAPI_GITOPS_TEST_ROOT;
    delete env.VAPI_GITOPS_TEST_REPO;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/no-vapi-api.ts",
        "--test",
        "tests/" + file,
      ],
      { cwd: root, encoding: "utf8", env },
    );
    const kept =
      existsSync(join(root, "package.json")) && existsSync(join(root, "src"));
    return {
      exit: run.status,
      ran: /^# pass [1-9]/m.test(run.stdout),
      kept,
      same: kept && JSON.stringify(paths(root)) === JSON.stringify(before),
    };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

const STATE = '{\n  "assistants": {}\n}\n';
const LAYOUTS: Record<string, Record<string, string>> = {
  "no state at all": {},
  "state in state/acme/": { "state/acme/state.json": STATE },
  "state at the root (.vapi-state.acme.json)": {
    ".vapi-state.acme.json": STATE,
  },
};
const GOOD = { exit: 0, ran: true, kept: true, same: true };

for (const file of ["drift.test.ts", "tool-assistant-cycle.test.ts"])
  test(
    file +
      " leaves every file of the repository it runs in, wherever its state is",
    () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const [name, files] of Object.entries(LAYOUTS)) {
        seen[name] = fileLeavesRepository(file, files);
        want[name] = GOOD;
      }
      assert.deepEqual(seen, want);
    },
  );
