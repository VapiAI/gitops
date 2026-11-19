import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  OLD_LAYOUT_NOTICE,
  StateLayoutError,
  commitStepAcknowledge,
  commitStepAsk,
  commitStepFilePath,
  commitStepRead,
  orgPinFileLegacyPath,
  orgPinFileWrite,
  stateFileLegacyPath,
  stateFilePath,
  stateFileWrite,
  stateLayoutPrepare,
  stateMoveRead,
} from "../src/state-paths.ts";

// A promotion run writes the state file and leaves committing it to a later
// step. When that step stages the state file in a way the engine can't read
// (a helper script, a commit action with a file pattern, a pipeline outside
// GitHub Actions), a move into state/ would go unnoticed by it: every run
// would pass while state/<org>/state.json is never committed, and the next
// run would create every resource again.
//
// So no command moves committed state by itself, and the reader of commit
// steps fails closed. `npm run migrate` moves state only when every commit
// step it can read is seen to stage state/, or when a person says theirs
// does. A `git add` counts as seen only where the reader can place it: a
// plain command, run from the repository root, that names `state` or stages
// everything.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "acme";
const STATE = JSON.stringify({
  assistants: { a: { uuid: "11111111-1111-4111-8111-111111111111" } },
});
const OLD_STATE = ".vapi-state." + ORG + ".json";
const CI: NodeJS.ProcessEnv = { CI: "true" };
const WORD = '{\n  "stagesStateFolder": true\n}\n';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "state-commit-step-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    if (path.endsWith(".sh")) chmodSync(join(root, path), 0o755);
  }
  return root;
}

function workflow(commitLines: string[], permissions?: string): string {
  return [
    "name: Promote",
    "on: { push: { branches: [main] } }",
    ...(permissions ? ["permissions:", "  contents: " + permissions] : []),
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

test("no command moves state by itself, whatever is or isn't in the repository", () => {
  assert.deepEqual(
    [
      // A promotion pipeline outside GitHub Actions can't be read at all.
      movesByItself({ "promotion.yml": "version: 1\n" }),
      // No promotion and no workflow: an apply job in another CI system
      // still commits state after a run.
      movesByItself({}),
      // Even a commit step that is seen to stage state/ doesn't move it.
      movesByItself({
        ".github/workflows/promotion.yml": workflow(
          ["      - run: git add -A && git commit -m state && git push"],
          "write",
        ),
      }),
    ],
    [false, false, false],
  );
});

// ── What the reader counts as staging state/ ─────────────────────────────

const OLD_GLOB = "git add -A -- ':(glob).vapi-state.*.json'";
const TAIL = [
  "if git diff --cached --quiet; then exit 0; fi",
  'git commit -q -m "chore: record promoted Vapi state"',
];

// Each commit step, and how the reader has to read it.
const STEPS: Array<[kind: string, name: string, run: string[]]> = [
  [
    "seen",
    "upstream's step: both places, each guarded",
    [
      "if [ -d state ]; then git add -A -- state; fi",
      'if compgen -G ".vapi-state.*.json" > /dev/null; then ' +
        OLD_GLOB +
        "; fi",
      "git add -A -- resources",
    ],
  ],
  ["seen", "git add -A", ["git add -A"]],
  ["seen", "git add .", ["git add ."]],
  ["seen", "git add --all", ["git add --all"]],
  ["seen", "git add -A -- state", ["git add -A -- state"]],
  ["seen", "git add ./state/ resources", ["git add ./state/ resources"]],
  [
    "seen",
    "git add with a redirect and || true",
    ["git add -A . 2>/dev/null || true"],
  ],
  ["seen", "git add after &&", ["true && git add -A"]],
  [
    "stale",
    "the step from before state/",
    [OLD_GLOB, "git add -A -- resources"],
  ],
  ["unseen", "git add -u", ["git add -u"]],
  ["unseen", "git add -u .", ["git add -u ."]],
  ["unseen", "git add --dry-run -A", ["git add --dry-run -A"]],
  ["unseen", "no git add at all", []],
  [
    "unseen",
    "state files named one by one",
    ["git add state/*/state.json resources"],
  ],
  ["unseen", "one org's folder", ["git add -A -- state/acme resources"]],
  ["unseen", "a variable", ['PATHS="state resources"', "git add -A -- $PATHS"]],
  ["unseen", "paths from a command", ["git add -A -- $(cat paths.txt)"]],
  ["unseen", "git -C", ['git -C "$PWD" add -A']],
  ["unseen", "a helper script", ["./scripts/stage-state.sh"]],
  ["unseen", "everything but state/", ["git add -A -- . ':!state'"]],
  [
    "unseen",
    "git add . after cd",
    [OLD_GLOB, "cd resources && git add . && cd .."],
  ],
  [
    "unseen",
    "git add -A after pushd",
    ["pushd resources", "git add -A", "popd"],
  ],
  [
    "unseen",
    "git add -A in a subshell that changed directory",
    ["(cd resources; git add -A)"],
  ],
  [
    "unseen",
    "git add -A after sourcing a script",
    ["source ./scripts/stage-state.sh", "git add -A"],
  ],
  [
    "unseen",
    "git add -A against another repository",
    ["GIT_DIR=/tmp/elsewhere/.git git add -A"],
  ],
  ["unseen", "git add -A after ||", ["true || git add -A"]],
  [
    "unseen",
    "git add -A inside an if",
    ['if [ "${DEPLOY:-}" = yes ]; then git add -A; fi'],
  ],
  [
    "unseen",
    "git add -A as the if's own test",
    ["if git add -A -- nothing-here; then true; fi"],
  ],
  [
    "unseen",
    "git add as part of an if's test",
    ["if false && git add -A -- state; then true; fi"],
  ],
  [
    "unseen",
    "a loop that may not run",
    ["for org in $ORGS; do git add -A -- state; done"],
  ],
  ["unseen", "a function nobody calls", ["stage() { git add -A -- state; }"]],
  [
    "unseen",
    "inside an echo",
    [
      'echo "staged by the helper, not by: git add -A -- state"',
      "./scripts/stage-state.sh",
    ],
  ],
  [
    "unseen",
    "inside a here-document",
    ["cat > /dev/null <<'EOF'", "git add -A -- state", "EOF"],
  ],
];

// Run the commit step for real, after a run changed state/<org>/state.json,
// and report whether the commit it makes holds the new state.
function stepCommitsStateFolder(run: string[]): boolean {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  const root = repo({
    ["state/" + ORG + "/state.json"]: STATE,
    "resources/acme/assistants/a.md": "one\n",
    "scripts/stage-state.sh": HELPER_SCRIPT,
  });
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const next = STATE.replace("1111", "2222");
    writeFileSync(stateFilePath(root, ORG), next);
    writeFileSync(join(root, "resources/acme/assistants/a.md"), "two\n");
    spawnSync("bash", ["-eo", "pipefail", "-c", [...run, ...TAIL].join("\n")], {
      cwd: root,
      env: GIT_ENV,
    });
    return git(root, "show", "HEAD:state/" + ORG + "/state.json") === next;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a commit step is read as staging state/ only where the reader can place its git add", () => {
  const read: Record<string, string> = {};
  const expected: Record<string, string> = {};
  for (const [kind, name, run] of STEPS) {
    const root = repo({
      [OLD_STATE]: STATE,
      ".github/workflows/promotion.yml": workflow(
        [
          "      - run: |",
          ...[...run, ...TAIL].map((line) => "          " + line),
        ],
        "write",
      ),
    });
    read[name] = commitStepRead(root, {}).kind;
    expected[name] = kind;
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(read, expected);
});

test("every step read as staging state/ commits state/ when it is run", () => {
  const seen = STEPS.filter(([kind]) => kind === "seen");
  assert.deepEqual(
    seen.map(([, name, run]) => [name, stepCommitsStateFolder(run)]),
    seen.map(([, name]) => [name, true]),
  );
});

test("where a step runs decides whether its git add counts", () => {
  const kind = (step: string[], job: string[] = []) => {
    const root = repo({
      ".github/workflows/promotion.yml": [
        "on: push",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  promote:",
        ...job,
        "    steps:",
        "      - uses: actions/checkout@v4",
        ...step,
        "",
      ].join("\n"),
    });
    try {
      return commitStepRead(root, {}).kind;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  assert.deepEqual(
    {
      "at the repository root": kind([
        "      - run: git add -A && git commit -m s",
      ]),
      "a step's working-directory": kind([
        "      - run: git add -A && git commit -m s",
        "        working-directory: resources",
      ]),
      "the job's default working-directory": kind(
        ["      - run: git add -A && git commit -m s"],
        ["    defaults:", "      run:", "        working-directory: resources"],
      ),
      "a shell that isn't bash or sh": kind([
        "      - run: git add -A && git commit -m s",
        "        shell: pwsh",
      ]),
      "a checkout into a sub-folder": kind([
        "      - uses: actions/checkout@v4",
        "        with:",
        "          path: site",
        "      - run: git add -A && git commit -m s",
      ]),
      "another repository's git folder": kind(
        ["      - run: git add -A && git commit -m s"],
        ["    env:", "      GIT_DIR: /tmp/elsewhere/.git"],
      ),
    },
    {
      "at the repository root": "seen",
      "a step's working-directory": "unseen",
      "the job's default working-directory": "unseen",
      "a shell that isn't bash or sh": "unseen",
      "a checkout into a sub-folder": "unseen",
      "another repository's git folder": "unseen",
    },
  );
});

// ── Which jobs have to be seen ───────────────────────────────────────────

const SEEN_WORKFLOW = workflow(
  [
    "      - run: |",
    "          git add -A -- state ':(glob).vapi-state.*.json' resources",
    "          git commit -m state && git push",
  ],
  "write",
);
const job = (name: string, lines: string[]) => [
  "  " + name + ":",
  "    runs-on: ubuntu-latest",
  ...lines,
];

test("every job that shows a commit step has to be seen, in every workflow", () => {
  const kind = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) => {
    const root = repo(files);
    try {
      const step = commitStepRead(root, env);
      return step.kind + ("file" in step ? " " + step.file : "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const lint = (permissions: string[]) =>
    [
      "on: pull_request",
      ...permissions,
      "jobs:",
      ...job("lint", ["    steps:", "      - run: npm ci && npm run lint"]),
      "",
    ].join("\n");
  const readOnly = ["permissions:", "  contents: read"];
  const actions = (file: string): NodeJS.ProcessEnv => ({
    GITHUB_ACTIONS: "true",
    GITHUB_WORKFLOW_REF: `acme/repo/.github/workflows/${file}@refs/heads/main`,
  });
  const both = {
    ".github/workflows/promotion.yml": SEEN_WORKFLOW,
    ".github/workflows/lint.yml": lint([]),
  };
  assert.deepEqual(
    {
      "no workflow at all": kind({}),
      "one job, seen": kind({
        ".github/workflows/promotion.yml": SEEN_WORKFLOW,
      }),
      "a second job in the same file that stages in its own folder": kind({
        ".github/workflows/promotion.yml":
          workflow(
            ["      - run: ./scripts/stage-state.sh && git commit -m s"],
            "write",
          ) +
          job("docs", [
            "    steps:",
            "      - run: cd site && git init -q && git add -A && git commit -q -m docs",
          ]).join("\n") +
          "\n",
      }),
      "a second job in the same file with nothing to read": kind({
        ".github/workflows/promotion.yml":
          SEEN_WORKFLOW +
          job("deploy", ["    steps:", "      - run: ./deploy.sh"]).join("\n") +
          "\n",
      }),
      "a second workflow whose token can't write and that runs no git": kind({
        ".github/workflows/promotion.yml": SEEN_WORKFLOW,
        ".github/workflows/lint.yml": lint(readOnly),
      }),
      "a second workflow with no permissions block": kind(both),
      "a read-only token, alone": kind({
        ".github/workflows/lint.yml": lint(readOnly),
      }),
      "a read-only token that runs git commit": kind({
        ".github/workflows/lint.yml": lint(readOnly).replace(
          "npm run lint",
          "git commit -am x",
        ),
      }),
      "a workflow that doesn't parse": kind({
        ".github/workflows/broken.yml": "jobs: [",
      }),
      // In GitHub Actions the run is judged by the workflow running it.
      "in Actions, the seen workflow": kind(both, actions("promotion.yml")),
      "in Actions, the other workflow": kind(both, actions("lint.yml")),
      "in Actions, with no workflow named": kind(both, {
        GITHUB_ACTIONS: "true",
      }),
    },
    {
      "no workflow at all": "none",
      "one job, seen": "seen",
      "a second job in the same file that stages in its own folder":
        "unseen .github/workflows/promotion.yml",
      "a second job in the same file with nothing to read":
        "unseen .github/workflows/promotion.yml",
      "a second workflow whose token can't write and that runs no git": "seen",
      "a second workflow with no permissions block":
        "unseen .github/workflows/lint.yml",
      "a read-only token, alone": "none",
      "a read-only token that runs git commit":
        "unseen .github/workflows/lint.yml",
      "a workflow that doesn't parse": "unseen .github/workflows/broken.yml",
      "in Actions, the seen workflow": "seen",
      "in Actions, the other workflow": "unseen .github/workflows/lint.yml",
      "in Actions, with no workflow named": "unseen .github/workflows/lint.yml",
    },
  );
});

test("the workflows this repository ships are read as staging both places", () => {
  assert.deepEqual(commitStepRead(REPO, {}), { kind: "seen", stagesOld: true });
});

// ── npm run migrate ──────────────────────────────────────────────────────

test("migrate moves nothing until a commit step is seen or a person says theirs stages state/", async () => {
  const repos: Record<string, string>[] = [
    // A helper script, and no workflow at all: neither is seen.
    {
      ".github/workflows/promotion.yml": HELPER_WORKFLOW,
      "scripts/stage-state.sh": HELPER_SCRIPT,
    },
    {},
  ];
  for (const files of repos) {
    const root = repo({ [OLD_STATE]: STATE, ...files });
    try {
      const asked = commitStepAsk(root)?.join("\n") ?? "";
      const first = await migrateAll(root);
      const heldBack = !moved(root) && !existsSync(join(root, "state"));
      const said = commitStepAcknowledge(root);
      const second = await migrateAll(root);
      assert.deepEqual(
        {
          asked: [
            /Nothing moves into state\/ yet/.test(asked),
            asked.includes("git add -A -- state "),
            asked.includes("git add -A -- ':(glob).vapi-state.*.json'"),
            asked.includes("npm run migrate -- " + COMMIT_STEP_FLAG),
            /takes your word/.test(asked),
          ],
          first: [
            first.orgs[0]!.moved,
            first.commitStepAsk !== undefined,
            heldBack,
          ],
          said: /^✍️ {2}Wrote state\/commit-step\.json/.test(said),
          word: existsSync(commitStepFilePath(root)),
          second: [second.orgs[0]!.moved, second.commitStepAsk, moved(root)],
          // Said again before a later move, with the limit of a person's word.
          later: /takes that word/.test(stateMoveRead(root).lines.join("\n")),
        },
        {
          asked: [true, true, true, true, true],
          first: [[], true, true],
          said: true,
          word: true,
          second: [[OLD_STATE], undefined, true],
          later: true,
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the flag writes nothing where the engine can see for itself", () => {
  const root = repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": SEEN_WORKFLOW,
  });
  try {
    assert.deepEqual(
      [
        /is not needed here/.test(commitStepAcknowledge(root)),
        existsSync(commitStepFilePath(root)),
        commitStepAsk(root),
        stateMoveRead(root).open,
      ],
      [true, false, undefined, true],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function migrateCommand(root: string, ...args: string[]) {
  if (!existsSync(join(root, "src"))) {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  }
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
}

test("npm run migrate holds an unread commit step back, exits 0, and rejects an option it doesn't know", () => {
  const root = helperRepo();
  try {
    const plain = migrateCommand(root);
    const heldAfterPlain = !moved(root);
    const typo = migrateCommand(root, "--commit-step-stages-stat");
    const heldAfterTypo = !moved(root);
    const told = migrateCommand(root, COMMIT_STEP_FLAG);
    assert.deepEqual(
      {
        plain: [
          plain.code,
          plain.out.includes("git add -A -- state "),
          plain.out.includes("git add -A -- ':(glob).vapi-state.*.json'"),
          plain.out.includes("npm run migrate -- --commit-step-stages-state"),
          plain.out.includes("State stays where it is"),
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
        plain: [0, true, true, true, true, true],
        typo: [1, true, true],
        told: [0, true, true],
      },
      plain.out + typo.out + told.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm run migrate says what the commit step has to stage before it moves anything", () => {
  const root = repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": SEEN_WORKFLOW,
  });
  try {
    const first = migrateCommand(root);
    const again = migrateCommand(root);
    const at = (needle: string) => first.out.indexOf(needle);
    assert.deepEqual(
      [
        first.code,
        moved(root),
        at("git add -A -- state ") > 0,
        at("git add -A -- ':(glob).vapi-state.*.json'") > 0,
        at("is not read and needs the same two lines") > 0,
        at("git add -A -- state ") < at("📦 Moved"),
        // Nothing left to move, so nothing to say about the commit step.
        again.out.includes("git add -A -- state "),
      ],
      [0, true, true, true, true, true, false],
      first.out + again.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A CI run ─────────────────────────────────────────────────────────────

test("a CI run on the old layout keeps working under a commit step the engine can't read", () => {
  const root = helperRepo();
  try {
    assert.deepEqual(
      [
        stateLayoutPrepare(root, ORG, CI),
        existsSync(stateFileLegacyPath(root, ORG)),
        existsSync(join(root, "state")),
        stateFileWrite(root, ORG),
        // A new org is written where the others are.
        stateFileWrite(root, "new-org"),
        orgPinFileWrite(root, "new-org"),
      ],
      [
        [OLD_LAYOUT_NOTICE],
        true,
        false,
        stateFileLegacyPath(root, ORG),
        stateFileLegacyPath(root, "new-org"),
        orgPinFileLegacyPath(root, "new-org"),
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CI run stops before it writes state/ that its commit step isn't seen to stage", () => {
  const files = {
    ["state/" + ORG + "/state.json"]: STATE,
    ".github/workflows/promotion.yml": HELPER_WORKFLOW,
    "scripts/stage-state.sh": HELPER_SCRIPT,
  };
  const root = repo(files);
  const saidSo = repo({ ...files, "state/commit-step.json": WORD });
  // A pipeline the engine has no file for shows nothing to judge.
  const elsewhere = repo({
    ["state/" + ORG + "/state.json"]: STATE,
    ".gitlab-ci.yml": "deploy:\n  script:\n    - npm run apply -- acme\n",
  });
  try {
    const stopped = thrown(() => stateLayoutPrepare(root, ORG, CI));
    assert.deepEqual(
      [
        /promotion\.yml can commit to this repository and is not seen to stage state\//.test(
          stopped,
        ),
        /Stopped before reading or changing anything/.test(stopped),
        stopped.includes("npm run migrate -- " + COMMIT_STEP_FLAG),
        // On a person's machine the same checkout runs.
        stateLayoutPrepare(root, ORG, {}),
        // With a person's word the run goes on, and says whose word it is.
        stateLayoutPrepare(saidSo, ORG, CI).map((line) =>
          /commit-step\.json says this run's commit step stages state\//.test(
            line,
          ),
        ),
        stateLayoutPrepare(elsewhere, ORG, CI),
      ],
      [true, true, true, [], [true], []],
    );
  } finally {
    for (const dir of [root, saidSo, elsewhere])
      rmSync(dir, { recursive: true, force: true });
  }
});

test("a CI run stops when the old file it would write is no longer what the commit step stages", () => {
  // The workflow moved on to state/ and the state file was left behind.
  const ahead = repo({
    [OLD_STATE]: STATE,
    ".github/workflows/promotion.yml": workflow(
      ["      - run: git add -A -- state && git commit -m state && git push"],
      "write",
    ),
  });
  // The same, where the workflow can't be read and a person gave their word.
  const saidSo = helperRepo({ "state/commit-step.json": WORD });
  try {
    assert.deepEqual(
      [ahead, saidSo].map((root) => {
        const message = thrown(() => stateLayoutPrepare(root, ORG, CI));
        return [
          /is still at the repository root/.test(message),
          /Run `npm run migrate` on your machine/.test(message),
          existsSync(stateFileLegacyPath(root, ORG)),
          stateLayoutPrepare(root, ORG, {}),
        ];
      }),
      [
        [true, true, true, [OLD_LAYOUT_NOTICE]],
        [true, true, true, [OLD_LAYOUT_NOTICE]],
      ],
    );
  } finally {
    for (const dir of [ahead, saidSo])
      rmSync(dir, { recursive: true, force: true });
  }
});
