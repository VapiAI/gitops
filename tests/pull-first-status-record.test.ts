import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
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
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stateFixturePath } from "./state-fixture.ts";

// Pull asks git which files a person changed (getLocallyChangedFiles in
// src/pull.ts) and reads each record of "git status --porcelain -z" as
// "XY <path>", taking the path from the fourth character. An unstaged edit is
// " M <path>". When the output was trimmed before it was read, an unstaged
// edit in the first record lost its leading space and its path lost its first
// letter: "esources/dev/assistants/alex.md". That path was dropped as "not a
// resource file", and pull no longer knew the file was edited.
//
// On a machine with no baseline for that file (a new clone, a new machine)
// pull then wrote the platform's copy over the edit and said nothing. A
// staged edit ("M  <path>") was always read correctly.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "dev";
const IDS = {
  alex: "11111111-1111-4111-8111-111111111111",
  riley: "22222222-2222-4222-8222-222222222222",
};
const STATE = `${JSON.stringify(
  { assistants: { alex: { uuid: IDS.alex }, riley: { uuid: IDS.riley } } },
  null,
  2,
)}\n`;
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
}

const ON_PLATFORM = "What the platform holds.";
const EDITED = "A sentence a person is still writing.";
const file = (name: string, prompt: string): string =>
  `---\nname: ${name}\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\n${prompt}\n`;
const path = (name: string): string => `resources/dev/assistants/${name}.md`;
const NEW_TOOL =
  "type: function\nfunction:\n  name: new_tool\n  description: A tool being added.\n";

// A clone of a repository that is in step with the platform, with no
// baselines: what a teammate starts from.
function freshClone(): { root: string; drop: () => void } {
  const source = mkdtempSync(join(tmpdir(), "status-src-"));
  const root = mkdtempSync(join(tmpdir(), "status-"));
  cpSync(join(REPO, "src"), join(source, "src"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(source, "package.json"));
  put(source, ".gitignore", "node_modules\nstate/*/local/\n");
  put(source, path("alex"), file("Alex", ON_PLATFORM));
  put(source, path("riley"), file("Riley", ON_PLATFORM));
  put(source, relative(source, stateFixturePath(source, ORG)), STATE);
  git(source, "init", "-q", "-b", "main");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "in step with the platform");
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

// Run pull once and say which edits are still there.
async function editsKept(
  edit: (root: string) => void,
): Promise<Record<string, boolean>> {
  const assistant = (id: string, name: string) => ({
    id,
    orgId: "org-test",
    name,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: ON_PLATFORM }],
    },
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        (request.url ?? "").startsWith("/assistant")
          ? [assistant(IDS.alex, "Alex"), assistant(IDS.riley, "Riley")]
          : [],
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const clone = freshClone();
  try {
    edit(clone.root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VAPI_PRIVATE_API_KEY: "test-key",
      VAPI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      VAPI_GITOPS_ORG_PIN: "off",
    };
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/pull-cmd.ts", ORG],
      { cwd: clone.root, stdio: ["ignore", "pipe", "pipe"], env },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    const code = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    assert.equal(code, 0, out);
    const kept: Record<string, boolean> = {};
    for (const name of ["alex", "riley"])
      kept[name] = readFileSync(join(clone.root, path(name)), "utf8").includes(
        EDITED,
      );
    return kept;
  } finally {
    clone.drop();
    await new Promise((done) => server.close(done));
  }
}

const editBoth = (root: string): void => {
  put(root, path("alex"), file("Alex", EDITED));
  put(root, path("riley"), file("Riley", EDITED));
};

test("control: two staged edits are both kept by pull", async () => {
  assert.deepEqual(
    await editsKept((root) => {
      editBoth(root);
      git(root, "add", "-A");
    }),
    { alex: true, riley: true },
  );
});

test("two unstaged edits are both kept by pull, the first one git lists included", async () => {
  assert.deepEqual(await editsKept(editBoth), { alex: true, riley: true });
});

test("an unstaged edit is kept by pull when a new, untracked resource file sits beside it", async () => {
  // What a person has before their first apply in a new clone: one edited
  // assistant and one new tool. Git lists the edit first, then the new file.
  assert.deepEqual(
    await editsKept((root) => {
      put(root, path("riley"), file("Riley", EDITED));
      put(root, "resources/dev/tools/new-tool.yml", NEW_TOOL);
    }),
    { alex: false, riley: true },
  );
});

test("control: the same edit with an unstaged change that git lists before it is kept", async () => {
  assert.deepEqual(
    await editsKept((root) => {
      put(root, path("riley"), file("Riley", EDITED));
      put(
        root,
        "package.json",
        `${readFileSync(join(root, "package.json"), "utf8")}\n`,
      );
      put(root, "resources/dev/tools/new-tool.yml", NEW_TOOL);
    }),
    { alex: false, riley: true },
  );
});
