// Loaded before every test file (package.json's test script). What it sets
// in the environment is inherited by every CLI a test spawns.
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Tests must never reach the real Vapi API or use a developer's real key. A
// test that needs a key sets a fake one itself.
process.env.VAPI_BASE_URL = "http://127.0.0.1:9";
delete process.env.VAPI_PRIVATE_API_KEY;
delete process.env.VAPI_TOKEN;
// Tests that stub fetch count requests; the org pin check's probes would add
// to them. tests/org-pin.test.ts turns it back on for itself.
process.env.VAPI_GITOPS_ORG_PIN = "off";
// Per-org keys (VAPI_PRIVATE_API_KEY_<ORG>) a developer exports in their shell.
for (const name of Object.keys(process.env))
  if (name.startsWith("VAPI_PRIVATE_API_KEY_")) delete process.env[name];

// Tests must never read, write or remove anything in the repository they run
// in. The engine loaded from this repository's src/ works in a temporary
// directory instead (src/base-dir.ts), so its state, baselines, snapshots and
// resources all resolve there, and so does any path a test derives from them.
// No test cleans the engine's folders up: this removes the whole directory.
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const box = mkdtempSync(join(tmpdir(), "vapi-gitops-test-"));
const root = join(box, "repo");
mkdirSync(root);
process.env.VAPI_GITOPS_TEST_REPO = repository;
process.env.VAPI_GITOPS_TEST_ROOT = root;
process.on("exit", () => rmSync(box, { recursive: true, force: true }));

// A test can also build a path to the repository itself. So in a test
// process, every node:fs call that creates, changes or removes something
// throws when its target is inside the repository. A test's files belong in
// a directory it made under os.tmpdir().
function inRepository(target: unknown): boolean {
  if (typeof target !== "string" && !(target instanceof URL)) return false;
  const path = resolve(target instanceof URL ? fileURLToPath(target) : target);
  return (
    (path === repository || path.startsWith(repository + sep)) &&
    !path.startsWith(join(repository, "node_modules") + sep)
  );
}

// Each name with the positions of the paths it changes.
const CHANGES: Record<string, number[]> = {
  appendFile: [0],
  chmod: [0],
  copyFile: [1],
  cp: [1],
  createWriteStream: [0],
  link: [1],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  symlink: [1],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  writeFile: [0],
};

function guard(holder: Record<string, unknown>, name: string, at: number[]) {
  const real = holder[name];
  if (typeof real !== "function") return;
  holder[name] = function (this: unknown, ...args: unknown[]) {
    for (const index of at)
      if (inRepository(args[index]))
        throw new Error(
          `A test called ${name} on ${String(args[index])}, inside the repository it runs in. Tests work in a directory they create under os.tmpdir().`,
        );
    return real.apply(this, args);
  };
}

for (const [name, at] of Object.entries(CHANGES)) {
  guard(fs as unknown as Record<string, unknown>, name, at);
  guard(fs as unknown as Record<string, unknown>, `${name}Sync`, at);
  guard(fs.promises as unknown as Record<string, unknown>, name, at);
}
// Opening a file to write it is a change too.
for (const [holder, name] of [
  [fs, "open"],
  [fs, "openSync"],
  [fs.promises, "open"],
] as const) {
  const real = (
    holder as unknown as Record<string, (...a: unknown[]) => unknown>
  )[name]!;
  (holder as unknown as Record<string, unknown>)[name] = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const flags = typeof args[1] === "string" ? args[1] : "r";
    if (flags !== "r" && inRepository(args[0]))
      throw new Error(
        `A test opened ${String(args[0])} for writing, inside the repository it runs in. Tests work in a directory they create under os.tmpdir().`,
      );
    return real.apply(this, args);
  };
}
syncBuiltinESMExports();
