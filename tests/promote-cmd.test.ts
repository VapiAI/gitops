import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// promote-cmd.ts binds its root at import, so one fixture repo serves the
// file; each test resets it.
const ROOT = mkdtempSync(join(tmpdir(), "promote-cmd-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { APPLIED_PATHS_FILE, promotionCommandRun } =
  await import("../src/promote-cmd.ts");

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), content);
}

function fixtureReset(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  write(
    "promotion.yml",
    "version: 1\norgs:\n  a: {}\n  b: {}\n  c: {}\npipelines:\n  release:\n    orgs: [a, b, c]\n    resources: ['**/*']\n",
  );
  write("resources/a/assistants/intake.yml", "name: Intake\n");
  for (const org of ["a", "b", "c"]) write(`.vapi-state.${org}.json`, "{}\n");
  write(".gitignore", "tmp/\n.env.*\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
}

interface ChildCall {
  script: string;
  org: string;
}

// Stands in for pull.ts and apply.ts: apply into `failOrg` fails, and every
// other apply also rewrites one file the plan didn't name, as apply's own
// pull can.
function childRunFake(calls: ChildCall[], failOrg?: string) {
  return (script: string, org: string) => {
    calls.push({ script, org });
    if (script !== "src/apply.ts") return;
    if (org === failOrg) throw new Error(`${script} failed for ${org}`);
    write(`resources/${org}/assistants/pulled-by-apply.yml`, "name: Pulled\n");
  };
}

// The recorded `<blob>\t<path>` lines, as [path, blob].
function appliedEntries(): Array<[string, string]> {
  const file = join(ROOT, APPLIED_PATHS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [blob, path] = line.split("\t");
      return [path!, blob!];
    });
}

function appliedPaths(): string[] {
  return appliedEntries().map(([path]) => path);
}

process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({ a: "t", b: "t", c: "t" });

test("after one transition applies and the next fails, only the applied transition's files are recorded", async () => {
  fixtureReset();
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    a: "t",
    b: "t",
    c: "t",
  });
  const calls: ChildCall[] = [];
  const log = console.log;
  console.log = () => {};
  let failure: unknown;
  try {
    await promotionCommandRun(["--all", "--apply"], {
      childRun: childRunFake(calls, "c"),
    });
  } catch (error) {
    failure = error;
  } finally {
    console.log = log;
  }
  assert.deepEqual(
    {
      failure: (failure as Error | undefined)?.message,
      applies: calls
        .filter((c) => c.script === "src/apply.ts")
        .map((c) => c.org),
      recorded: appliedPaths(),
      // The failed transition's rewrites are on disk but not recorded.
      cRewritten: existsSync(join(ROOT, "resources/c/assistants/intake.yml")),
    },
    {
      failure: "src/apply.ts failed for c",
      applies: ["b", "c"],
      recorded: [
        "resources/b/assistants/intake.yml",
        "resources/b/assistants/pulled-by-apply.yml",
      ],
      cRewritten: true,
    },
  );
});

test("if an applied transition's files can't be recorded, the run stops and says which org to reconcile", async () => {
  fixtureReset();
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    a: "t",
    b: "t",
    c: "t",
  });
  const calls: ChildCall[] = [];
  const log = console.log;
  console.log = () => {};
  let failure: unknown;
  try {
    await promotionCommandRun(["--all", "--apply"], {
      // Apply into b succeeds, then git can't be read, so recording fails.
      childRun: (script: string, org: string) => {
        calls.push({ script, org });
        if (script === "src/apply.ts" && org === "b")
          rmSync(join(ROOT, ".git"), { recursive: true, force: true });
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    console.log = log;
  }
  const message = (failure as Error | undefined)?.message ?? "";
  assert.deepEqual(
    {
      names: message.startsWith(
        "Applied to b, but couldn't record its changed files",
      ),
      reconcile: message.includes("npm run pull -- b"),
      applies: calls
        .filter((c) => c.script === "src/apply.ts")
        .map((c) => c.org),
    },
    { names: true, reconcile: true, applies: ["b"] },
  );
});

test("each --apply run starts a fresh record; a plan-only run leaves it alone", async () => {
  fixtureReset();
  write(APPLIED_PATHS_FILE, "-\tresources/stale/assistants/old.yml\n");
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(["--all"], { childRun: childRunFake([]) });
    const afterPlan = appliedPaths();
    process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
      a: "t",
      b: "t",
      c: "t",
    });
    await promotionCommandRun(
      ["--pipeline", "release", "--from", "a", "--to", "b", "--apply"],
      {
        childRun: childRunFake([]),
      },
    );
    assert.deepEqual(
      [afterPlan, appliedPaths()],
      [
        ["resources/stale/assistants/old.yml"],
        [
          "resources/b/assistants/intake.yml",
          "resources/b/assistants/pulled-by-apply.yml",
        ],
      ],
    );
  } finally {
    console.log = log;
  }
});

test("a deleted or renamed file is recorded by its current path", async () => {
  fixtureReset();
  write("resources/b/assistants/old-name.yml", "name: Old\n");
  write("resources/b/assistants/gone.yml", "name: Gone\n");
  git("add", "-A");
  git("commit", "-qm", "b files");
  git(
    "mv",
    "resources/b/assistants/old-name.yml",
    "resources/b/assistants/new-name.yml",
  );
  rmSync(join(ROOT, "resources/b/assistants/gone.yml"));
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    a: "t",
    b: "t",
    c: "t",
  });
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(
      ["--pipeline", "release", "--from", "a", "--to", "b", "--apply"],
      {
        childRun: childRunFake([]),
      },
    );
  } finally {
    console.log = log;
  }
  assert.deepEqual(appliedPaths().sort(), [
    "resources/b/assistants/gone.yml",
    "resources/b/assistants/intake.yml",
    "resources/b/assistants/new-name.yml",
    "resources/b/assistants/pulled-by-apply.yml",
  ]);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("each applied file is recorded with its content at apply time, and a deletion as -", async () => {
  fixtureReset();
  write("resources/b/assistants/gone.yml", "name: Gone\n");
  git("add", "-A");
  git("commit", "-qm", "b files");
  process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({
    a: "t",
    b: "t",
    c: "t",
  });
  const log = console.log;
  console.log = () => {};
  try {
    await promotionCommandRun(
      ["--pipeline", "release", "--from", "a", "--to", "b", "--apply"],
      { childRun: childRunFake([]) },
    );
  } finally {
    console.log = log;
  }
  // A later rewrite of the file doesn't change what was recorded.
  write("resources/b/assistants/intake.yml", "name: Rewritten later\n");
  const entries = Object.fromEntries(appliedEntries());
  assert.deepEqual(
    [
      git("cat-file", "-p", entries["resources/b/assistants/intake.yml"]!),
      entries["resources/b/assistants/gone.yml"],
    ],
    ["name: Intake\n", "-"],
  );
});
