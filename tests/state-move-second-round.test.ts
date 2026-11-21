import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commitStepRead,
  stateFileLegacyPath,
  stateFilePath,
  stateLayoutPrepare,
} from "../src/state-paths.ts";

// Three things a repository that worked before state/ existed could lose once
// its state was in state/<org>/. Each was first seen end to end, in a
// pipeline where every CI run was green.
//
// 1. A CI runner's fresh clone. With no baselines and a clean git status,
//    pull keeps a file only when it is newer than the state file. Git writes
//    a checkout in path order: ".vapi-state.<org>.json" comes before
//    "resources/", "state/<org>/state.json" comes after it. So on main a
//    fresh clone keeps every file, and after the move it overwrites every
//    file with the platform's copy. A change merged to git and applied by CI
//    ("apply on merge") never reaches the platform, and the commit step then
//    commits the overwritten file, undoing the merge.
// 2. The commit-step reader counts any "git add ." or "git add -A" in the
//    workflow text as staging the whole repository, whatever directory it
//    runs in and whether it runs at all.
// 3. With no workflow that can commit and no promotion.yml, the first command
//    on a person's machine moves state by itself. A pipeline outside GitHub
//    Actions that stages .vapi-state.*.json then never commits state again.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "dev";
const UUID = "11111111-1111-4111-8111-111111111111";
const STATE =
  JSON.stringify({ assistants: { riley: { uuid: UUID } } }, null, 2) + "\n";
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

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  if (path.endsWith(".sh")) chmodSync(join(root, path), 0o755);
}

// ── 1. A merged change in a fresh clone ──────────────────────────────────

const MERGED = "Merged in git, not on the platform yet.";
const ON_PLATFORM = "What the platform holds.";
const rileyFile = (prompt: string): string =>
  "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\n" +
  prompt +
  "\n";

// What a CI runner has: a clone of the committed repository and nothing else.
function freshClone(layout: "root" | "folder"): {
  root: string;
  drop: () => void;
} {
  const source = mkdtempSync(join(tmpdir(), "fresh-clone-src-"));
  const root = mkdtempSync(join(tmpdir(), "fresh-clone-"));
  cpSync(join(REPO, "src"), join(source, "src"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(source, "package.json"));
  put(
    source,
    ".gitignore",
    "node_modules\nstate/*/local/\n.vapi-state-hash/\n",
  );
  put(source, "resources/dev/assistants/riley.md", rileyFile(MERGED));
  put(
    source,
    layout === "root" ? ".vapi-state.dev.json" : "state/dev/state.json",
    STATE,
  );
  git(source, "init", "-q", "-b", "main");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "a merged change");
  rmSync(root, { recursive: true, force: true });
  git(tmpdir(), "clone", "-q", source, root);
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return {
    root,
    drop: () => {
      rmSync(source, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function pullInFreshClone(layout: "root" | "folder"): Promise<string> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        (request.url ?? "").startsWith("/assistant")
          ? [
              {
                id: UUID,
                orgId: "org-test",
                name: "Riley",
                model: {
                  provider: "openai",
                  model: "gpt-4o",
                  messages: [{ role: "system", content: ON_PLATFORM }],
                },
              },
            ]
          : [],
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { root, drop } = freshClone(layout);
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/pull-cmd.ts", ORG],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          VAPI_PRIVATE_API_KEY: "test-key",
          VAPI_BASE_URL:
            "http://127.0.0.1:" + (server.address() as AddressInfo).port,
          VAPI_GITOPS_ORG_PIN: "off",
        },
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    const code = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    assert.equal(code, 0, out);
    return readFileSync(
      join(root, "resources/dev/assistants/riley.md"),
      "utf8",
    );
  } finally {
    drop();
    await new Promise((done) => server.close(done));
  }
}

test("pull in a fresh clone keeps a merged change, wherever the state file is", async () => {
  const kept = {
    "state at the root": (await pullInFreshClone("root")).includes(MERGED),
    "state in state/dev/": (await pullInFreshClone("folder")).includes(MERGED),
  };
  assert.deepEqual(kept, {
    "state at the root": true,
    "state in state/dev/": true,
  });
});

// ── 2. A git add that does not stage state/ ──────────────────────────────

function workflow(run: string[], extraJob: string[] = []): string {
  return [
    "name: Promotion",
    "on: push",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  promote:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run promote -- --all --apply",
    "      - run: |",
    ...run.map((line) => "          " + line),
    ...extraJob,
    "",
  ].join("\n");
}

const TAIL = [
  "if git diff --cached --quiet; then exit 0; fi",
  'git commit -q -m "chore: record promoted Vapi state"',
];
const HELPER =
  "#!/bin/bash\ngit add -A -- ':(glob).vapi-state.*.json' 2>/dev/null || true\ngit add -A -- resources\n";

const STEPS: Record<string, { run: string[]; extraJob?: string[] }> = {
  "git add . after cd resources": {
    run: [
      "git add .vapi-state.*.json 2>/dev/null || true",
      "cd resources && git add . && cd ..",
      ...TAIL,
    ],
  },
  "git add -A in another job's folder": {
    run: ["./scripts/stage-state.sh", ...TAIL],
    extraJob: [
      "  docs:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: cd site && git init -q && git add -A && git commit -q -m docs",
    ],
  },
  "git add -A -- state inside an echo": {
    run: [
      'echo "state is staged by the helper, not by: git add -A -- state"',
      "./scripts/stage-state.sh",
      ...TAIL,
    ],
  },
};

// Run the commit step for real, after a run changed state/dev/state.json, and
// report whether the commit it makes holds the new state.
function stepCommitsStateFolder(run: string[]): boolean {
  const root = mkdtempSync(join(tmpdir(), "commit-step-"));
  try {
    put(root, "state/dev/state.json", STATE);
    put(root, "resources/dev/assistants/riley.md", rileyFile("one"));
    put(root, "scripts/stage-state.sh", HELPER);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const next = STATE.replace(UUID, "22222222-2222-4222-8222-222222222222");
    put(root, "state/dev/state.json", next);
    put(root, "resources/dev/assistants/riley.md", rileyFile("two"));
    spawnSync("bash", ["-eo", "pipefail", "-c", run.join("\n")], {
      cwd: root,
      env: GIT_ENV,
    });
    return git(root, "show", "HEAD:state/dev/state.json") === next;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a git add that leaves state/ out is not read as staging state/", () => {
  const seen: Record<string, { commitsState: boolean; readAs: string }> = {};
  const expected: typeof seen = {};
  for (const [name, step] of Object.entries(STEPS)) {
    const root = mkdtempSync(join(tmpdir(), "commit-step-read-"));
    try {
      put(root, ".vapi-state.dev.json", STATE);
      put(root, "promotion.yml", "version: 1\n");
      put(
        root,
        ".github/workflows/promotion.yml",
        workflow(step.run, step.extraJob),
      );
      const read = commitStepRead(root, {}).kind;
      seen[name] = {
        commitsState: stepCommitsStateFolder(step.run),
        readAs: read === "seen" ? "seen" : "not seen",
      };
      expected[name] = { commitsState: false, readAs: "not seen" };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(seen, expected);
});

// ── 3. A pipeline the engine has no file for ─────────────────────────────

test("with nothing seen to stage state/, a command that is not migrate leaves committed state where it is", () => {
  const root = mkdtempSync(join(tmpdir(), "no-workflow-"));
  try {
    // An apply-on-merge job in another CI system: no .github/workflows, no
    // promotion.yml, and a script that stages .vapi-state.*.json.
    put(root, ".vapi-state.dev.json", STATE);
    put(
      root,
      ".gitlab-ci.yml",
      "deploy:\n  script:\n    - npm run apply -- dev\n    - ./scripts/commit-state.sh\n",
    );
    put(root, "scripts/commit-state.sh", HELPER);
    stateLayoutPrepare(root, ORG, {});
    assert.deepEqual(
      {
        root: existsSync(stateFileLegacyPath(root, ORG)),
        folder: existsSync(stateFilePath(root, ORG)),
      },
      { root: true, folder: false },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
