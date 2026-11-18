import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

// Pull keeps a committed file it has no baseline for (a fresh clone, or a
// change that arrived through git and is not applied yet) only while git
// reports nothing changed under resources/<org>/. In the older layout the
// engine keeps files of its own in that folder, and none of them is a
// person's edit:
//
//   resources/<org>/.vapi-org.json    shown as deleted between migrate and its commit
//
// If pull counted one as a local edit, the keep rule would be off and pull
// would overwrite the committed change with the platform's copy.

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
}

const MERGED = "Merged in git, not on the platform yet.";
const ON_PLATFORM = "What the platform holds.";
const rileyFile = (prompt: string): string =>
  "---\nname: Riley\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\n" +
  prompt +
  "\n";

interface Clone {
  root: string;
  drop: () => void;
}

// A clone of the committed repository, with no baselines: what a teammate or
// a CI runner starts from. committed holds extra files in the first commit.
function freshClone(
  layout: "root" | "folder",
  committed: Record<string, string> = {},
): Clone {
  const source = mkdtempSync(join(tmpdir(), "records-src-"));
  const root = mkdtempSync(join(tmpdir(), "records-"));
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
  for (const [path, content] of Object.entries(committed))
    put(source, path, content);
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

// Run pull on a person's machine and return the resource file afterwards.
async function pullKeepsMerged(
  clone: Clone,
  before: (root: string) => void,
): Promise<boolean> {
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
  try {
    before(clone.root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VAPI_PRIVATE_API_KEY: "test-key",
      VAPI_BASE_URL:
        "http://127.0.0.1:" + (server.address() as AddressInfo).port,
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
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    const code = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    assert.equal(code, 0, out);
    return readFileSync(
      join(clone.root, "resources/dev/assistants/riley.md"),
      "utf8",
    ).includes(MERGED);
  } finally {
    clone.drop();
    await new Promise((done) => server.close(done));
  }
}

const PIN = "resources/dev/.vapi-org.json";

test("control: with nothing uncommitted, pull keeps a merged change in both layouts", async () => {
  assert.deepEqual(
    {
      root: await pullKeepsMerged(freshClone("root"), () => {}),
      folder: await pullKeepsMerged(freshClone("folder"), () => {}),
    },
    { root: true, folder: true },
  );
});

test("older layout: an org pin the engine wrote, not committed yet, is not a local edit", async () => {
  // A first pull with a real key writes the pin. Until it is committed git
  // shows it as untracked.
  const kept = await pullKeepsMerged(freshClone("root"), (root) =>
    put(root, PIN, '{\n  "orgId": "org-test"\n}\n'),
  );
  assert.equal(kept, true, "pull overwrote the merged change");
});

test("unchanged: a person's own uncommitted file in that folder still switches the keep rule off", async () => {
  // Only the engine's files are left out. Anything else under
  // resources/<org>/ counts as before, .vapi-ignore included.
  const kept = await pullKeepsMerged(freshClone("root"), (root) =>
    put(root, "resources/dev/.vapi-ignore", "assistants/scratch-*\n"),
  );
  assert.equal(kept, false);
});

test("after migrate, before the move is committed, the old pin shown as deleted is not a local edit", async () => {
  // The upgrade guide: "Pull does nothing differently because of it."
  // What migrate leaves until the commit: the state file and the pin gone
  // from their old places, and state/dev/ untracked.
  const kept = await pullKeepsMerged(
    freshClone("root", { [PIN]: '{\n  "orgId": "org-test"\n}\n' }),
    (root) => {
      mkdirSync(join(root, "state/dev"), { recursive: true });
      renameSync(
        join(root, ".vapi-state.dev.json"),
        join(root, "state/dev/state.json"),
      );
      renameSync(join(root, PIN), join(root, "state/dev/org.json"));
    },
  );
  assert.equal(kept, true, "pull overwrote the merged change");
});
