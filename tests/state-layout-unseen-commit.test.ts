import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrateAll } from "../src/migrate-hash-store.ts";
import {
  COMMIT_STEP_FLAG,
  StateLayoutError,
  commitStepFilePath,
  commitStepRead,
  orgPinFileLegacyPath,
  orgPinFileWrite,
  stateFileLegacyPath,
  stateFilePath,
  stateFileWrite,
  stateLayoutPrepare,
} from "../src/state-paths.ts";

// A promotion run writes the state file and leaves committing it to a later
// step. When that step stages the state file in a way the engine can't read
// (a helper script, a commit action with a file pattern, a pipeline outside
// GitHub Actions), a move into state/ would go unnoticed by it: every run
// would pass while state/<org>/state.json is never committed, and the next
// run would create every resource again.
//
// So the move fails closed. Committed state stays where it is until a
// workflow is seen to stage state/, or a person says their commit step does.
// A CI run never writes state in a place its commit step isn't seen to stage.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "acme";
const STATE = JSON.stringify({
  assistants: { a: { uuid: "11111111-1111-4111-8111-111111111111" } },
});
const OLD_STATE = ".vapi-state." + ORG + ".json";
const CI: NodeJS.ProcessEnv = { CI: "true" };

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "state-commit-step-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function workflow(commitLines: string[]): string {
  return [
    "name: Promote",
    "on: { push: { branches: [main] } }",
    "jobs:",
    "  promote:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run promote -- --all --apply",
    ...commitLines,
    "",
  ].join("\n");
}

// A commit step that stages the old state file through a script.
const HELPER_WORKFLOW = workflow([
  "      - run: |",
  "          ./scripts/stage-state.sh",
  "          git add -A -- resources",
  '          git commit -m "chore: record promoted Vapi state"',
  "          git push",
]);
const HELPER_SCRIPT =
  "#!/bin/bash\ngit add -A -- ':(glob).vapi-state.*.json' 2>/dev/null || true\n";

function helperRepo(files: Record<string, string> = {}): string {
  return repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": HELPER_WORKFLOW,
    "scripts/stage-state.sh": HELPER_SCRIPT,
    ...files,
  });
}

function moved(root: string): boolean {
  return (
    existsSync(stateFilePath(root, ORG)) &&
    !existsSync(stateFileLegacyPath(root, ORG))
  );
}

function assertHeldBack(root: string): void {
  try {
    stateLayoutPrepare(root, ORG, {});
    assert.ok(
      existsSync(stateFileLegacyPath(root, ORG)),
      "the old state file must stay: this workflow would not commit state/",
    );
    assert.ok(!existsSync(stateFilePath(root, ORG)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Whether a command on a person's machine moves the old state file.
function movesByItself(files: Record<string, string>): boolean {
  const root = repo({ [OLD_STATE]: STATE, ...files });
  try {
    stateLayoutPrepare(root, ORG, {});
    return moved(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function thrown(run: () => unknown): string {
  try {
    run();
    return "ran";
  } catch (error) {
    return error instanceof StateLayoutError ? error.message : "other error";
  }
}

// ── A commit step the engine can't read holds the move back ──────────────

test("staging the state file in a helper script holds the move back", () => {
  assertHeldBack(
    repo({
      [".vapi-state." + ORG + ".json"]: STATE,
      ".github/workflows/promotion.yml": workflow([
        "      - run: |",
        "          ./scripts/stage-state.sh",
        "          git add -A -- resources",
        '          git commit -m "chore: record promoted Vapi state"',
        "          git push",
      ]),
      "scripts/stage-state.sh":
        "#!/bin/bash\ngit add -A -- ':(glob).vapi-state.*.json' 2>/dev/null || true\n",
    }),
  );
});

test("a commit action with a file pattern for the state file holds the move back", () => {
  assertHeldBack(
    repo({
      [".vapi-state." + ORG + ".json"]: STATE,
      ".github/workflows/promotion.yml": workflow([
        "      - uses: stefanzweifel/git-auto-commit-action@v5",
        "        with:",
        '          commit_message: "chore: record promoted Vapi state"',
        '          file_pattern: ".vapi-state.*.json resources"',
      ]),
    }),
  );
});

test("promotion set up with no workflow in the repository holds the move back", () => {
  // promotion.yml at the root means some pipeline runs promotion, and one
  // outside GitHub Actions can't be read at all.
  assert.deepEqual(
    [
      movesByItself({ "promotion.yml": "version: 1\n" }),
      // No promotion and no workflow: nothing commits state after a run.
      movesByItself({}),
    ],
    [false, true],
  );
  // With state already in state/, a CI run of that pipeline stops. A person
  // promoting from their own machine is not warned on every command.
  const root = repo({
    ["state/" + ORG + "/state.json"]: STATE,
    "promotion.yml": "version: 1\n",
  });
  try {
    assert.deepEqual(
      [
        /promotion\.yml is set up and no workflow in \.github\/workflows\/ is seen to stage state\//.test(
          thrown(() => stateLayoutPrepare(root, ORG, CI)),
        ),
        stateLayoutPrepare(root, ORG, {}),
      ],
      [true, []],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a git add line that stages state/ or everything counts as seen", () => {
  const seen = (line: string) =>
    movesByItself({
      ".github/workflows/promotion.yml": workflow([
        "      - run: |",
        `          ${line}`,
        "          git commit -m state && git push",
      ]),
    });
  assert.deepEqual(
    {
      folder: seen("git add -A -- state"),
      folderSlash: seen("git add state/"),
      folderGlob: seen("git add -A -- ':(glob)state/**'"),
      both: seen("git add -A -- state ':(glob).vapi-state.*.json' resources"),
      everything: seen("git add -A"),
      everythingLong: seen("git add --all"),
      dot: seen("git add ."),
      chained: seen("git add resources && git add -A -- state"),
      // Not seen: something else, one org only, a variable, tracked files only.
      resources: seen("git add -A -- resources"),
      oneOrg: seen("git add -A -- state/acme"),
      variable: seen('git add -A -- "$STATE_PATHS"'),
      tracked: seen("git add -u"),
      commented: seen("# git add -A -- state"),
      lookalike: seen("git add -A -- estate statement"),
    },
    {
      folder: true,
      folderSlash: true,
      folderGlob: true,
      both: true,
      everything: true,
      everythingLong: true,
      dot: true,
      chained: true,
      resources: false,
      oneOrg: false,
      variable: false,
      tracked: false,
      commented: false,
      lookalike: false,
    },
  );
});

test("a workflow that can't write to the repository is not a commit step", () => {
  const withWorkflow = (lines: string[]) =>
    movesByItself({ ".github/workflows/ci.yml": `${lines.join("\n")}\n` });
  const job = ["jobs:", "  test:", "    steps:", "      - run: npm test"];
  assert.deepEqual(
    {
      readOnly: withWorkflow(["permissions:", "  contents: read", ...job]),
      noContents: withWorkflow(["permissions:", "  statuses: write", ...job]),
      readAll: withWorkflow(["permissions: read-all", ...job]),
      // Anything that may be able to commit is not ruled out.
      noPermissions: withWorkflow(job),
      writes: withWorkflow(["permissions:", "  contents: write", ...job]),
      writeAll: withWorkflow(["permissions: write-all", ...job]),
      jobWrites: withWorkflow([
        "permissions:",
        "  contents: read",
        ...job,
        "    permissions:",
        "      contents: write",
      ]),
      pushesAnyway: withWorkflow([
        "permissions:",
        "  contents: read",
        ...job,
        "      - run: git push https://example.invalid/repo.git",
      ]),
      unreadable: withWorkflow(["jobs: [", "  not yaml"]),
    },
    {
      readOnly: true,
      noContents: true,
      readAll: true,
      noPermissions: false,
      writes: false,
      writeAll: false,
      jobWrites: false,
      pushesAnyway: false,
      unreadable: false,
    },
  );
});

test("the workflows this repository ships are read as staging both places", () => {
  const root = repo({});
  try {
    cpSync(join(REPO, ".github/workflows"), join(root, ".github/workflows"), {
      recursive: true,
    });
    assert.deepEqual(commitStepRead(root, {}), {
      kind: "seen",
      stagesOld: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── npm run migrate ──────────────────────────────────────────────────────

test("migrate says what the commit step has to stage and moves nothing until the person says it does", async () => {
  const root = helperRepo({
    ["resources/" + ORG + "/.vapi-org.json"]: '{"orgId":"org-a"}\n',
  });
  try {
    const first = await migrateAll(root);
    const afterFirst = [moved(root), existsSync(commitStepFilePath(root))];
    const second = await migrateAll(root, { commitStepStagesState: true });
    assert.deepEqual(
      {
        ask: first.commitStepAsk?.filter((line) =>
          /git add|npm run migrate|Nothing moved/.test(line),
        ),
        afterFirst,
        acknowledged: second.acknowledged,
        secondAsk: second.commitStepAsk,
        moved: moved(root),
        pinMoved: !existsSync(orgPinFileLegacyPath(root, ORG)),
        file: readFileSync(commitStepFilePath(root), "utf8"),
        // From here on a command on a person's machine has nothing to say.
        later: stateLayoutPrepare(root, ORG, {}),
      },
      {
        ask: [
          "⚠️  Nothing moved into state/: .github/workflows/promotion.yml can commit to this repository and is not seen to stage state/.",
          "     git add -A -- state                       the new folder: each org's state.json, org.json and records",
          "     git add -A -- ':(glob).vapi-state.*.json'   the old files, so the commit that moves them records their removal",
          "     npm run migrate -- --commit-step-stages-state",
        ],
        afterFirst: [false, false],
        acknowledged:
          "✍️  Wrote state/commit-step.json: you said the commit step stages state/. Commit it together with the move.",
        secondAsk: undefined,
        moved: true,
        pinMoved: true,
        file: '{\n  "stagesStateFolder": true\n}\n',
        later: [],
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the flag is refused while a workflow is seen to stage only the old file", async () => {
  const root = repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": workflow([
      "      - run: |",
      "          git add -A -- ':(glob).vapi-state.*.json'",
      "          git commit -m state && git push",
    ]),
  });
  try {
    const message = await migrateAll(root, {
      commitStepStagesState: true,
    }).then(
      () => "ran",
      (error: unknown) =>
        error instanceof StateLayoutError ? error.message : "other error",
    );
    assert.deepEqual(
      [
        /promotion\.yml stages \.vapi-state\.\*\.json but not state\/, so --commit-step-stages-state is not true yet/.test(
          message,
        ),
        existsSync(commitStepFilePath(root)),
        moved(root),
      ],
      [true, false, false],
      message,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the flag writes nothing where the engine can see for itself", async () => {
  const root = repo({ [OLD_STATE]: STATE });
  try {
    const result = await migrateAll(root, { commitStepStagesState: true });
    assert.deepEqual(
      [result.acknowledged, existsSync(commitStepFilePath(root)), moved(root)],
      [
        "ℹ️  --commit-step-stages-state is not needed here: nothing in this repository commits state after a run.",
        false,
        true,
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm run migrate prints the two paths, exits 0, and rejects an option it doesn't know", () => {
  const root = helperRepo();
  try {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    const run = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/migrate-cmd.ts", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
        },
      );
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const plain = run();
    const heldAfterPlain = !moved(root);
    const typo = run("--commit-step-stages-stat");
    const heldAfterTypo = !moved(root);
    const told = run(COMMIT_STEP_FLAG);
    assert.deepEqual(
      {
        plain: [
          plain.code,
          plain.out.includes("git add -A -- state "),
          plain.out.includes("git add -A -- ':(glob).vapi-state.*.json'"),
          plain.out.includes("npm run migrate -- --commit-step-stages-state"),
          heldAfterPlain,
        ],
        typo: [
          typo.code,
          typo.out.includes("Unrecognized argument: --commit-step-stages-stat"),
          heldAfterTypo,
        ],
        told: [told.code, told.out.includes("📦 Moved"), moved(root)],
      },
      {
        plain: [0, true, true, true, true],
        typo: [1, true, true],
        told: [0, true, true],
      },
      plain.out + typo.out + told.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A CI run ─────────────────────────────────────────────────────────────

test("a CI run on the old layout keeps working under a commit step the engine can't read", () => {
  const root = helperRepo();
  try {
    const notices = stateLayoutPrepare(root, ORG, CI);
    assert.deepEqual(
      {
        notices,
        moved: moved(root),
        writes: stateFileWrite(root, ORG, CI),
        // An org this run creates goes where the commit step already looks.
        newOrg: stateFileWrite(root, "new-org", CI),
        newOrgPin: orgPinFileWrite(root, "new-org", CI),
      },
      {
        notices: [
          "ℹ️  .vapi-state.acme.json stays where it is: .github/workflows/promotion.yml can commit to this repository and is not seen to stage state/. `npm run migrate` says what the commit step has to stage before it can move.",
        ],
        moved: false,
        writes: stateFileLegacyPath(root, ORG),
        newOrg: stateFileLegacyPath(root, "new-org"),
        newOrgPin: orgPinFileLegacyPath(root, "new-org"),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CI run stops before it writes state/ that nothing is seen to commit", () => {
  const root = repo({
    ["state/" + ORG + "/state.json"]: STATE,
    ".github/workflows/promotion.yml": HELPER_WORKFLOW,
  });
  try {
    const stopped = thrown(() => stateLayoutPrepare(root, ORG, CI));
    // An org with no state yet would be written into state/ too.
    const newOrg = thrown(() => stateLayoutPrepare(root, "new-org", CI));
    const onAMachine = stateLayoutPrepare(root, ORG, {});
    writeFileSync(commitStepFilePath(root), '{"stagesStateFolder":true}\n');
    assert.deepEqual(
      {
        stopped: [
          /promotion\.yml can commit to this repository and is not seen to stage state\/, so state\/acme\/ may never be committed/.test(
            stopped,
          ),
          /Stopped before reading or changing anything/.test(stopped),
          stopped.includes("npm run migrate -- --commit-step-stages-state"),
        ],
        newOrg: /so state\/new-org\/ may never be committed/.test(newOrg),
        // The same checkout on a person's machine is warned, not stopped.
        onAMachine: onAMachine.map((line) => line.slice(0, 2)),
        // Once a person has said the step stages state/, the run goes ahead
        // and says whose word it is taking.
        acknowledged: stateLayoutPrepare(root, ORG, CI),
      },
      {
        stopped: [true, true, true],
        newOrg: true,
        onAMachine: ["⚠️"],
        acknowledged: [
          "ℹ️  state/commit-step.json says this run's commit step stages state/. The engine can't see that step: if it doesn't, what this run records in state/acme/ is lost.",
        ],
      },
      stopped,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CI run stops when the old file it would write is no longer what the commit step stages", () => {
  const newOnly = repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": workflow([
      "      - run: |",
      "          git add -A -- state",
      "          git commit -m state && git push",
    ]),
  });
  const saidSo = helperRepo({
    "state/commit-step.json": '{"stagesStateFolder":true}\n',
  });
  try {
    const first = thrown(() => stateLayoutPrepare(newOnly, ORG, CI));
    const second = thrown(() => stateLayoutPrepare(saidSo, ORG, CI));
    assert.deepEqual(
      [
        /\.vapi-state\.acme\.json is still at the repository root, and this repository's workflow stages state\/ but not \.vapi-state\.\*\.json/.test(
          first,
        ),
        /state\/commit-step\.json says the commit step stages state\//.test(
          second,
        ),
        existsSync(stateFileLegacyPath(newOnly, ORG)),
        existsSync(stateFileLegacyPath(saidSo, ORG)),
        // On a person's machine both simply move.
        stateLayoutPrepare(newOnly, ORG, {}).length,
        moved(newOnly),
        stateLayoutPrepare(saidSo, ORG, {}).length,
        moved(saidSo),
      ],
      [true, true, true, true, 1, true, 1, true],
      first + second,
    );
  } finally {
    rmSync(newOnly, { recursive: true, force: true });
    rmSync(saidSo, { recursive: true, force: true });
  }
});

test("in GitHub Actions the run is judged by the workflow that is running it", () => {
  const root = repo({
    ["state/" + ORG + "/state.json"]: STATE,
    ".github/workflows/promotion.yml": workflow([
      "      - run: |",
      "          git add -A -- state ':(glob).vapi-state.*.json'",
      "          git commit -m state && git push",
    ]),
    // Another workflow that can commit and stages nothing the engine reads.
    ".github/workflows/deploy.yml": workflow(["      - run: ./deploy.sh"]),
  });
  const actions = (file: string): NodeJS.ProcessEnv => ({
    GITHUB_ACTIONS: "true",
    GITHUB_WORKFLOW_REF: `acme/repo/.github/workflows/${file}@refs/heads/main`,
  });
  try {
    assert.deepEqual(
      [
        thrown(() => stateLayoutPrepare(root, ORG, actions("promotion.yml"))),
        /deploy\.yml can commit to this repository and is not seen to stage state\//.test(
          thrown(() => stateLayoutPrepare(root, ORG, actions("deploy.yml"))),
        ),
        // With no workflow named, every workflow has to be seen.
        /deploy\.yml/.test(
          thrown(() =>
            stateLayoutPrepare(root, ORG, { GITHUB_ACTIONS: "true" }),
          ),
        ),
      ],
      ["ran", true, true],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
