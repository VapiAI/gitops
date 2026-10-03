import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checksConfigParse } from "../src/check-config.ts";
import { changedFilesRead, checkAffectedBy } from "../src/check-select.ts";

const { core, ci } = checksConfigParse(
  "version: 1\nchecks:\n  core:\n    org: acme\n    targets: [squads/main]\n    suites: [core]\n    paths: ['prompts/**']\n  ci:\n    org: acme-staging\n    runOrg: acme-ci\n    targets: [squads/main]\n    suites: [core]\n",
).checks as Record<
  string,
  ReturnType<typeof checksConfigParse>["checks"][string]
>;

test("a check is affected by its org's files, its run org, its state, the engine and its own paths", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    [
      "resources/acme/assistants/a.md",
      "resources/acme/assistants/a.md",
      undefined,
    ],
    [
      "resources/acme-ci/tools/t.yml",
      undefined,
      "resources/acme-ci/tools/t.yml",
    ],
    [".vapi-state.acme.json", ".vapi-state.acme.json", undefined],
    ["vapi-checks.yml", "vapi-checks.yml", "vapi-checks.yml"],
    ["src/push.ts", "src/push.ts", "src/push.ts"],
    ["package-lock.json", "package-lock.json", "package-lock.json"],
    ["prompts/shared/tone.md", "prompts/shared/tone.md", undefined],
    ["docs/readme.md", undefined, undefined],
    ["resources/acme-other/assistants/a.md", undefined, undefined],
  ];
  assert.deepEqual(
    cases.map(([file]) => [
      checkAffectedBy(core!, [file]),
      checkAffectedBy(ci!, [file]),
    ]),
    cases.map(([, a, b]) => [a, b]),
  );
});

test("changed files come from the merge base, so commits that landed on the base don't count", () => {
  const root = mkdtempSync(join(tmpdir(), "check-select-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: root, stdio: "pipe" },
    );
  const write = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), path);
  };
  try {
    git("init", "-q", "-b", "main");
    write("README.md");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("switch", "-qc", "feature");
    write("resources/acme/assistants/a.md");
    git("add", "-A");
    git("commit", "-qm", "feature");
    git("switch", "-q", "main");
    write("src/push.ts");
    git("add", "-A");
    git("commit", "-qm", "main moved on");
    git("switch", "-q", "feature");
    assert.deepEqual(
      [changedFilesRead(root, "main"), changedFilesRead(root, "no-such-ref")],
      [["resources/acme/assistants/a.md"], undefined],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
