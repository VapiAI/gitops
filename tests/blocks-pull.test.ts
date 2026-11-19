import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assistantFile,
  assistantPayload,
  cliRun,
  engineRepoCreate,
  filesWrite,
  stateFile,
  stubStart,
} from "./blocks-helpers.ts";

// Pull writes the platform's version of a resource over the local file in
// several situations: when the two already agree (it rewrites the file in
// canonical form), when only the dashboard changed, under --force, and under
// --resolve=theirs. The platform only ever holds the expanded text, so each
// of those would replace a marker with a copy of the block. None may touch a
// file that uses blocks.

const ORG = "test-blocks";
const TRIAGE = "aaaaaaaa-1111-1111-1111-111111111111";
const PLAIN = "bbbbbbbb-2222-2222-2222-222222222222";

const BLOCK = "Call 999 for chest pain at {{practice_name}}.";
const TRIAGE_FILE = assistantFile(
  "Triage",
  "You are the triage agent.\n\n@include red-flags",
);
const TRIAGE_EXPANDED = `You are the triage agent.\n\n${BLOCK}`;
const PLAIN_FILE = assistantFile("Plain", "No blocks here.");

const ASSISTANTS = `resources/${ORG}/assistants`;

function repo(): string {
  return engineRepoCreate({
    "templates/blocks/red-flags.md": `${BLOCK}\n`,
    [`${ASSISTANTS}/triage.md`]: TRIAGE_FILE,
    [`${ASSISTANTS}/plain.md`]: PLAIN_FILE,
    [`state/${ORG}/state.json`]: stateFile({ triage: TRIAGE, plain: PLAIN }),
  });
}

// Run pull against a dashboard holding these two prompts.
async function pull(
  root: string,
  prompts: { triage: string; plain: string },
  args: string[] = [],
): Promise<string> {
  const stub = await stubStart([
    {
      method: "GET",
      pathStartsWith: "/assistant",
      body: [
        assistantPayload(TRIAGE, "Triage", prompts.triage),
        assistantPayload(PLAIN, "Plain", prompts.plain),
      ],
    },
  ]);
  try {
    const run = cliRun(root, "src/pull.ts", [ORG, ...args], stub.port);
    assert.equal(run.code, 0, run.output);
    return run.output;
  } finally {
    await stub.stop();
  }
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function baseline(root: string, uuid: string): string | undefined {
  const path = join(root, "state", ORG, "local", "baselines", uuid);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

// The dashboard copies pull left beside triage.md.
function backups(root: string): string[] {
  return readdirSync(join(root, ASSISTANTS)).filter(
    (name) => name.startsWith("triage.") && name.includes(".bkp."),
  );
}

const IN_SYNC = { triage: TRIAGE_EXPANDED, plain: "No blocks here." };
const DASHBOARD_EDITED = {
  triage: `${TRIAGE_EXPANDED}\nAdded in the dashboard.`,
  plain: "Edited in the dashboard.",
};

test("pull leaves a file that uses blocks as written when it matches the dashboard", async () => {
  const root = repo();
  try {
    const output = await pull(root, IN_SYNC);
    assert.equal(read(root, `${ASSISTANTS}/triage.md`), TRIAGE_FILE);
    assert.match(output, /triage \(uses blocks, matches the dashboard/);
    // In sync is recorded, so a later dashboard edit is seen as drift.
    assert.ok(baseline(root, TRIAGE));
    assert.deepEqual(backups(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull keeps the marker when only the dashboard changed, and saves the dashboard version beside it", async () => {
  const root = repo();
  try {
    await pull(root, IN_SYNC);
    const seeded = baseline(root, TRIAGE);

    const output = await pull(root, DASHBOARD_EDITED);
    assert.equal(read(root, `${ASSISTANTS}/triage.md`), TRIAGE_FILE);
    assert.match(
      output,
      /triage: the dashboard version differs, but the file uses blocks, so it was not overwritten/,
    );
    const [copy] = backups(root);
    assert.ok(copy, output);
    assert.match(
      read(root, `${ASSISTANTS}/${copy}`),
      /Added in the dashboard\./,
    );
    // The edit is unresolved, so the baseline must not move: the next pull
    // and the push drift check still see it.
    assert.equal(baseline(root, TRIAGE), seeded);

    // The same pull does sync an ordinary file down, as before.
    assert.match(
      read(root, `${ASSISTANTS}/plain.md`),
      /Edited in the dashboard\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull --force overwrites ordinary files but not one that uses blocks", async () => {
  const root = repo();
  try {
    const output = await pull(root, DASHBOARD_EDITED, ["--force"]);
    assert.equal(read(root, `${ASSISTANTS}/triage.md`), TRIAGE_FILE);
    assert.match(output, /triage: the dashboard version differs/);
    assert.equal(backups(root).length, 1);
    assert.match(
      read(root, `${ASSISTANTS}/plain.md`),
      /Edited in the dashboard\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull --resolve=theirs does not overwrite a conflicted file that uses blocks", async () => {
  const root = repo();
  try {
    await pull(root, IN_SYNC);
    const seeded = baseline(root, TRIAGE);
    const edited = assistantFile(
      "Triage",
      "You are the triage agent. Edited locally.\n\n@include red-flags",
    );
    filesWrite(root, { [`${ASSISTANTS}/triage.md`]: edited });

    const output = await pull(root, DASHBOARD_EDITED, ["--resolve=theirs"]);
    assert.equal(read(root, `${ASSISTANTS}/triage.md`), edited);
    assert.match(output, /triage: the dashboard version differs/);
    assert.equal(backups(root).length, 1);
    assert.equal(baseline(root, TRIAGE), seeded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull keeps a block edit that has not been pushed yet", async () => {
  const root = repo();
  try {
    await pull(root, IN_SYNC);
    filesWrite(root, { "templates/blocks/red-flags.md": "New wording.\n" });

    const output = await pull(root, IN_SYNC);
    assert.equal(read(root, `${ASSISTANTS}/triage.md`), TRIAGE_FILE);
    assert.match(output, /triage \(local ahead of dashboard\)/);
    assert.deepEqual(backups(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
