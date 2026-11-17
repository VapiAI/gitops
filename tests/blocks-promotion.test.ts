import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BlockUsage, blocksRecordUpdate } from "../src/blocks.ts";
import { checksConfigParse } from "../src/check-config.ts";
import { checkAffectedBy } from "../src/check-select.ts";
import {
  promotionPlanApply,
  promotionPlanBuild,
  promotionStateParse,
} from "../src/promotion.ts";
import { FOLDER_MAP, orgResourcesRead } from "../src/resource-parse.ts";
import { assistantFile, filesWrite } from "./blocks-helpers.ts";

// Promotion compares file text between two orgs. A block edit changes no
// file, so without the blocks record it would never reach the next org.

// promote-cmd.ts binds its root at import, so one fixture serves the file.
const ROOT = mkdtempSync(join(tmpdir(), "blocks-promotion-"));
process.env.VAPI_GITOPS_ROOT = ROOT;
const { promotionCommandRun } = await import("../src/promote-cmd.ts");

const TRIAGE = assistantFile("Triage", "You triage.\n\n@include red-flags");
const STATE = promotionStateParse("{}");

async function recordSeed(org: string): Promise<void> {
  const usage = new Map<string, BlockUsage>();
  for (const resource of (await orgResourcesRead(ROOT, org)).values())
    usage.set(`${FOLDER_MAP[resource.type]}/${resource.id}`, resource.blocks);
  blocksRecordUpdate(ROOT, org, usage, usage.keys());
}

// dev and prod hold the same file, and prod was last pushed with the block
// as it stands.
async function fixtureReset(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  filesWrite(ROOT, {
    "promotion.yml":
      "version: 1\norgs:\n  dev: {}\n  prod: {}\npipelines:\n  release:\n    orgs: [dev, prod]\n    resources: ['**/*']\n",
    "templates/blocks/red-flags.md": "Call 999.\n",
    "resources/dev/assistants/triage.md": TRIAGE,
    "resources/dev/assistants/plain.md": assistantFile("Plain", "Hello."),
    "resources/prod/assistants/triage.md": TRIAGE,
    "resources/prod/assistants/plain.md": assistantFile("Plain", "Hello."),
    "state/dev/state.json": "{}\n",
    "state/prod/state.json": "{}\n",
    ".gitignore": "tmp/\n.env.*\n",
  });
  await recordSeed("prod");
}

function plan() {
  return promotionPlanBuild({
    rootDir: ROOT,
    source: "dev",
    target: "prod",
    patterns: ["**/*"],
    sourceState: STATE,
    targetState: STATE,
  });
}

test("a block-only change is planned as a sync of the target resources that use the block", async () => {
  await fixtureReset();
  assert.deepEqual((await plan()).changes, []);

  filesWrite(ROOT, { "templates/blocks/red-flags.md": "Call 999 now.\n" });
  const changed = await plan();
  assert.deepEqual(changed.changes, [
    {
      kind: "sync",
      path: "assistants/triage.md",
      blocks: ["blocks/red-flags.md"],
    },
  ]);

  // A sync entry carries no content: applying the plan must not touch the file.
  await promotionPlanApply(changed);
  assert.equal(
    readFileSync(join(ROOT, "resources/prod/assistants/triage.md"), "utf8"),
    TRIAGE,
  );
});

test("a target with its own block is not synced for a shared edit, and a block added to it is", async () => {
  await fixtureReset();
  filesWrite(ROOT, {
    "resources/prod/templates/blocks/red-flags.md": "Prod's wording.\n",
  });
  assert.deepEqual(
    (await plan()).changes.map((change) => change.kind),
    ["sync"],
  );
  await recordSeed("prod");

  filesWrite(ROOT, { "templates/blocks/red-flags.md": "Call 999 now.\n" });
  assert.deepEqual((await plan()).changes, []);
});

test("a file the target can't expand stops the plan and names the target", async () => {
  await fixtureReset();
  filesWrite(ROOT, {
    "resources/dev/templates/blocks/dev-only.md": "Only dev has this.\n",
    "resources/dev/assistants/triage.md": assistantFile(
      "Triage",
      "@include dev-only",
    ),
    "resources/prod/assistants/triage.md": assistantFile(
      "Triage",
      "@include dev-only",
    ),
  });
  await assert.rejects(
    plan(),
    /assistants\/triage\.md can't be expanded for prod: Unknown prompt block "dev-only"/,
  );
});

test("promote --apply deploys the synced files to the target", async () => {
  await fixtureReset();
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: ROOT, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");

  const applies: Array<[string, string[]]> = [];
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  const promote = (args: string[]) => {
    // The command clears this once it has read it.
    process.env.VAPI_PROMOTION_TOKENS = JSON.stringify({ dev: "t", prod: "t" });
    return promotionCommandRun(args, {
      childRun: (script, org, _connection, childArgs) => {
        if (script === "src/apply.ts") applies.push([org, childArgs]);
      },
    });
  };
  try {
    await promote(["--all", "--apply"]);
    assert.deepEqual(applies, []);

    filesWrite(ROOT, { "templates/blocks/red-flags.md": "Call 999 now.\n" });
    await promote(["--all", "--apply"]);
  } finally {
    console.log = log;
  }
  assert.deepEqual(applies, [
    [
      "prod",
      [
        "--force",
        "--allow-new-files",
        "--resolve=ours",
        "resources/prod/assistants/triage.md",
      ],
    ],
  ]);
  assert.ok(
    lines.includes(
      "  sync   assistants/triage.md (block changed: blocks/red-flags.md)",
    ),
    lines.join("\n"),
  );
});

test("a shared block edit selects every PR check; an org's own block selects that org's", () => {
  const { core, other } = checksConfigParse(
    "version: 1\nchecks:\n  core:\n    org: acme\n    targets: [squads/main]\n    suites: [core]\n  other:\n    org: other\n    targets: [squads/main]\n    suites: [core]\n",
  ).checks;
  const shared = "templates/blocks/red-flags.md";
  const own = "resources/acme/templates/config/voice.yml";
  assert.deepEqual(
    [
      checkAffectedBy(core!, [shared]),
      checkAffectedBy(other!, [shared]),
      checkAffectedBy(core!, [own]),
      checkAffectedBy(other!, [own]),
    ],
    [shared, shared, own, undefined],
  );
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
