import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  type BlockUsage,
  blocksRecordRead,
  blocksRecordUpdate,
} from "../src/blocks.ts";
import { FOLDER_MAP, orgResourcesRead } from "../src/resource-parse.ts";
import { syncBlocksRun } from "../src/sync-blocks-cmd.ts";
import {
  assistantFile,
  assistantPayload,
  cliRun,
  engineRepoCreate,
  filesWrite,
  repoCreate,
  stateFile,
  stubStart,
} from "./blocks-helpers.ts";

// A block edit changes no resource file, so nothing in git says which
// resources now run old text. sync-blocks finds them from the blocks record
// and pushes them through apply.

const TRIAGE = assistantFile("Triage", "You triage.\n\n@include red-flags");
const PHARMACY = assistantFile("Pharmacy", "Repeats.\n\n@include red-flags");
const SQUAD =
  "name: Front desk\nmembers:\n  - assistantId: triage\nmembersOverrides:\n  voice:\n    $include: voice\n";

// The blocks each resource of an org uses right now.
async function usageRead(
  root: string,
  org: string,
): Promise<Map<string, BlockUsage>> {
  const usage = new Map<string, BlockUsage>();
  for (const resource of (await orgResourcesRead(root, org)).values())
    usage.set(`${FOLDER_MAP[resource.type]}/${resource.id}`, resource.blocks);
  return usage;
}

// Mark every resource of an org as pushed with the blocks it uses right now.
async function recordSeed(root: string, org: string): Promise<void> {
  const usage = await usageRead(root, org);
  blocksRecordUpdate(root, org, usage, usage.keys());
}

async function threeOrgs(): Promise<string> {
  const root = repoCreate({
    "templates/blocks/red-flags.md": "Call 999.\n",
    "templates/config/voice.yml": "provider: 11labs\nvoiceId: burt\n",
    "resources/alpha/assistants/triage.md": TRIAGE,
    "resources/alpha/assistants/pharmacy.md": PHARMACY,
    "resources/alpha/assistants/plain.md": assistantFile("Plain", "Hello."),
    "resources/alpha/squads/front-desk.yml": SQUAD,
    // Beta has its own wording, so a shared edit does not reach it.
    "resources/beta/assistants/triage.md": TRIAGE,
    "resources/beta/templates/blocks/red-flags.md": "Beta's wording.\n",
    "resources/gamma/assistants/triage.md": TRIAGE,
  });
  for (const org of ["alpha", "beta", "gamma"]) await recordSeed(root, org);
  return root;
}

async function run(
  root: string,
  args: string[],
  applyRun: (org: string, paths: string[]) => boolean,
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  try {
    const code = await syncBlocksRun(args, { rootDir: root, applyRun });
    return { code, output: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function neverApply(): boolean {
  throw new Error("a dry run must not apply");
}

test("the dry run lists, across every org, the resources a block edit reached", async () => {
  const root = await threeOrgs();
  try {
    const clean = await run(root, [], neverApply);
    assert.equal(clean.code, 0);
    assert.match(clean.output, /Every resource is in sync with its blocks/);

    filesWrite(root, {
      "templates/blocks/red-flags.md": "Call 999 now.\n",
      "templates/config/voice.yml": "provider: 11labs\nvoiceId: sarah\n",
    });
    const dry = await run(root, [], neverApply);
    assert.equal(dry.code, 0);
    assert.deepEqual(dry.output.split("\n"), [
      "🧩 Blocks sync (dry run: nothing is changed)",
      "",
      "alpha",
      "  assistants/pharmacy.md (block changed: blocks/red-flags.md)",
      "  assistants/triage.md (block changed: blocks/red-flags.md)",
      "  squads/front-desk.yml (block changed: config/voice.yml)",
      "",
      "gamma",
      "  assistants/triage.md (block changed: blocks/red-flags.md)",
      "",
      "4 resource(s) still run the old block text. To push them: npm run sync-blocks -- --apply",
    ]);

    const scoped = await run(root, ["--org", "gamma"], neverApply);
    assert.doesNotMatch(scoped.output, /alpha/);
    assert.match(scoped.output, /1 resource\(s\) still run the old block text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--apply deploys each org's affected files and fails while any is left behind", async () => {
  const root = await threeOrgs();
  try {
    filesWrite(root, { "templates/blocks/red-flags.md": "Call 999 now.\n" });
    const calls: Array<[string, string[]]> = [];

    // An apply that pushes nothing, as when every resource is refused.
    const refused = await run(root, ["--apply"], (org, paths) => {
      calls.push([org, paths]);
      return true;
    });
    assert.deepEqual(calls, [
      [
        "alpha",
        [
          "resources/alpha/assistants/pharmacy.md",
          "resources/alpha/assistants/triage.md",
        ],
      ],
      ["gamma", ["resources/gamma/assistants/triage.md"]],
    ]);
    assert.equal(refused.code, 1);
    assert.match(
      refused.output,
      /alpha: 2 resource\(s\) still run the old block text/,
    );

    // An apply that pushes them, which is when push updates the record.
    const current = {
      alpha: await usageRead(root, "alpha"),
      gamma: await usageRead(root, "gamma"),
    };
    const pushed = await run(root, ["--apply"], (org) => {
      const usage = current[org as "alpha" | "gamma"];
      blocksRecordUpdate(root, org, usage, usage.keys());
      return true;
    });
    assert.equal(pushed.code, 0, pushed.output);
    assert.match(pushed.output, /Every resource is in sync with its blocks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken org is reported and the others are still listed", async () => {
  const root = await threeOrgs();
  try {
    filesWrite(root, {
      "templates/blocks/red-flags.md": "Call 999 now.\n",
      "resources/alpha/assistants/triage.md": assistantFile(
        "Triage",
        "@include no-such-block",
      ),
    });
    const result = await run(root, [], neverApply);
    assert.equal(result.code, 1);
    assert.match(result.output, /alpha\n {2}❌ .*Unknown prompt block/);
    assert.match(result.output, /gamma\n {2}assistants\/triage\.md/);
    await assert.rejects(
      run(root, ["--org", "nope"], neverApply),
      /No resources\/nope\/ folder/,
    );
    await assert.rejects(run(root, ["--push"], neverApply), /Unrecognized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// End to end, through the real apply → validate → pull → push path against
// a stub API: the resource whose dashboard copy is untouched is updated, and
// the one that was edited in the dashboard is refused by the drift check.
test("--apply pushes through the drift check: an untouched resource is updated, a dashboard-edited one is refused", async () => {
  const ORG = "alpha";
  const TRIAGE_ID = "aaaaaaaa-1111-1111-1111-111111111111";
  const PHARMACY_ID = "bbbbbbbb-2222-2222-2222-222222222222";
  const assistants = `resources/${ORG}/assistants`;
  const root = engineRepoCreate({
    "templates/blocks/red-flags.md": "Call 999.\n",
    [`${assistants}/triage.md`]: TRIAGE,
    [`${assistants}/pharmacy.md`]: PHARMACY,
    [`state/${ORG}/state.json`]: stateFile({
      triage: TRIAGE_ID,
      pharmacy: PHARMACY_ID,
    }),
  });
  const triage = (block: string) =>
    assistantPayload(TRIAGE_ID, "Triage", `You triage.\n\n${block}`);
  const pharmacy = (block: string) =>
    assistantPayload(PHARMACY_ID, "Pharmacy", `Repeats.\n\n${block}`);
  try {
    // Both in sync with the old block: a pull records that as the baseline.
    const before = await stubStart([
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [triage("Call 999."), pharmacy("Call 999.")],
      },
    ]);
    try {
      const seeded = cliRun(root, "src/pull.ts", [ORG], before.port);
      assert.equal(seeded.code, 0, seeded.output);
    } finally {
      await before.stop();
    }
    await recordSeed(root, ORG);
    const recorded = blocksRecordRead(root, ORG);

    // The block changes, and someone edits pharmacy in the dashboard.
    filesWrite(root, { "templates/blocks/red-flags.md": "Call 999 now.\n" });
    const edited = pharmacy("Call 999. Edited in the dashboard.");
    const stub = await stubStart([
      // An org with no credentials makes push re-pull its state first, which
      // resets every baseline to the dashboard's current content.
      {
        method: "GET",
        pathStartsWith: "/credential",
        body: [{ id: "cred-uuid-unused", name: "unused-credential" }],
      },
      {
        method: "GET",
        pathStartsWith: `/assistant/${TRIAGE_ID}`,
        body: triage("Call 999."),
      },
      {
        method: "PATCH",
        pathStartsWith: `/assistant/${TRIAGE_ID}`,
        body: triage("Call 999 now."),
      },
      {
        method: "GET",
        pathStartsWith: `/assistant/${PHARMACY_ID}`,
        body: edited,
      },
      {
        method: "GET",
        pathStartsWith: "/assistant",
        body: [triage("Call 999."), edited],
      },
    ]);
    try {
      const result = cliRun(
        root,
        "src/sync-blocks-cmd.ts",
        ["--org", ORG, "--apply"],
        stub.port,
      );
      const patched = (await stub.requests()).filter((request) =>
        request.startsWith("PATCH /assistant/"),
      );
      assert.deepEqual(
        {
          code: result.code,
          triagePatched: patched.some((r) => r.includes(TRIAGE_ID)),
          pharmacyPatched: patched.some((r) => r.includes(PHARMACY_ID)),
          refusal: /drift detected on assistant pharmacy/.test(result.output),
          leftBehind:
            /1 resource\(s\) still run the old block text:\n\s+- resources\/alpha\/assistants\/pharmacy\.md/.test(
              result.output,
            ),
        },
        {
          code: 1,
          triagePatched: true,
          pharmacyPatched: false,
          refusal: true,
          leftBehind: true,
        },
        result.output,
      );
    } finally {
      await stub.stop();
    }

    // Only the pushed resource is recorded with the new block.
    const after = blocksRecordRead(root, ORG);
    assert.notDeepEqual(after["assistants/triage"], recorded["assistants/triage"]);
    assert.deepEqual(
      after["assistants/pharmacy"],
      recorded["assistants/pharmacy"],
    );
    // And neither file lost its marker on the way through pull.
    assert.equal(readFileSync(join(root, assistants, "triage.md"), "utf8"), TRIAGE);
    assert.equal(
      readFileSync(join(root, assistants, "pharmacy.md"), "utf8"),
      PHARMACY,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
