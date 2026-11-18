import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  OLD_LAYOUT_NOTICE,
  stateFileLegacyPath,
  stateFilePath,
  stateFileWrite,
  stateLayoutPrepare,
  stateNoticesPrint,
} from "../src/state-paths.ts";

// A repository with no engine state at all gets its first state file at the
// root unless a workflow is seen to stage state/, or a person has said their
// commit step does. A commit step the engine can't read (a script, a commit
// action, another CI system) might stage only state/, and then that first
// file would never be committed. The engine can't tell, so the run says
// where state goes and what has to stage it.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "dev";
const CI = { CI: "true" };
const WORKFLOW = ".github/workflows/promote.yml";

const workflow = (run: string): string =>
  [
    "name: promote",
    "on: push",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - run: ${run}`,
    "",
  ].join("\n");

const SCRIPT = workflow("./scripts/commit-state.sh");
const OLD_FILE_ONLY = workflow(
  "git add -A -- ':(glob).vapi-state.*.json' resources && git commit -m state && git push",
);
const BOTH = workflow(
  "git add -A -- state ':(glob).vapi-state.*.json' && git commit -m state && git push",
);

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "first-state-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function read(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  const root = repo(files);
  try {
    const notices = stateLayoutPrepare(root, ORG, env);
    return {
      notices,
      atRoot: stateFileWrite(root, ORG) === stateFileLegacyPath(root, ORG),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a first state file written at the root says where it goes and what has to stage it", () => {
  for (const env of [{}, CI]) {
    const script = read({ [WORKFLOW]: SCRIPT }, env);
    const none = read({}, env);
    const [line] = script.notices;
    assert.deepEqual(
      [
        script.notices.length,
        script.atRoot,
        line?.includes("\n"),
        line?.includes(".vapi-state.dev.json at the repository root"),
        // Why: which file may commit, and that it isn't seen to stage state/.
        line?.includes(
          `${WORKFLOW} can commit to this repository and is not seen to stage state/`,
        ),
        // What has to stage it.
        line?.includes("has to stage .vapi-state.*.json"),
        // What to do when the step stages state/ instead.
        line?.includes("npm run migrate -- --commit-step-stages-state"),
        none.notices.length,
        none.atRoot,
        none.notices[0]?.includes(
          "no workflow in .github/workflows/ is seen to stage state/",
        ),
        none.notices[0]?.includes("has to stage .vapi-state.*.json"),
      ],
      [1, true, false, true, true, true, true, 1, true, true, true],
    );
  }
});

test("a workflow seen to stage the old file gets the short line, and one seen to stage state/ gets none", () => {
  const stale = read({ [WORKFLOW]: OLD_FILE_ONLY });
  const seen = read({ [WORKFLOW]: BOTH });
  const said = read({
    [WORKFLOW]: SCRIPT,
    "state/commit-step.json": '{\n  "stagesStateFolder": true\n}\n',
  });
  assert.deepEqual(
    [
      stale.notices,
      stale.atRoot,
      seen.notices,
      seen.atRoot,
      said.notices,
      said.atRoot,
    ],
    [
      [
        `ℹ️  No engine state in this repository yet: it goes to .vapi-state.dev.json at the repository root, which ${WORKFLOW} stages.`,
      ],
      true,
      [],
      false,
      [],
      false,
    ],
  );
});

test("once a state file exists the line is the older-layout one, for that org and for a new one", () => {
  const root = repo({
    [WORKFLOW]: SCRIPT,
    ".vapi-state.dev.json": '{\n  "assistants": {}\n}\n',
  });
  try {
    assert.deepEqual(
      [stateLayoutPrepare(root, ORG, {}), stateLayoutPrepare(root, "prod", {})],
      [[OLD_LAYOUT_NOTICE], [OLD_LAYOUT_NOTICE]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command prints one layout line, also when its first step writes the first state file", () => {
  const root = repo({ [WORKFLOW]: SCRIPT });
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  try {
    const [first] = stateLayoutPrepare(root, ORG, {});
    // apply prints the line, then its pull writes the state file and its
    // push would print the older-layout line.
    const command: NodeJS.ProcessEnv = {};
    stateNoticesPrint([first!], command);
    stateNoticesPrint([OLD_LAYOUT_NOTICE], command);
    assert.deepEqual(printed, [first]);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});

// One pull, end to end, in a new repository whose workflow commits through a
// script.
async function pull(root: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VAPI_PRIVATE_API_KEY: "test-key",
      VAPI_BASE_URL:
        "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      VAPI_GITOPS_ORG_PIN: "off",
      VAPI_GITOPS_OLD_LAYOUT_NOTICE: "",
    };
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/pull-cmd.ts", ORG],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    const code = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    assert.equal(code, 0, out);
    return out;
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test("the first pull in a new repository prints the line once, and the next pull prints the older-layout line", async () => {
  const root = repo({ [WORKFLOW]: SCRIPT, ".gitignore": "node_modules\n" });
  try {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    const count = (out: string, text: string) => out.split(text).length - 1;
    const first = await pull(root);
    const wrote = [
      existsSync(stateFileLegacyPath(root, ORG)),
      existsSync(stateFilePath(root, ORG)),
    ];
    const second = await pull(root);
    assert.deepEqual(
      [
        count(first, "No engine state in this repository yet"),
        count(first, "has to stage .vapi-state.*.json"),
        count(first, OLD_LAYOUT_NOTICE),
        wrote,
        count(second, "No engine state in this repository yet"),
        count(second, OLD_LAYOUT_NOTICE),
      ],
      [1, 1, 0, [true, false], 0, 1],
      first + second,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
