import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertStateMigrated, migrateAll } from "../src/migrate-hash-store.ts";
import {
  baselinesDir,
  commitStepAcknowledge,
  OLD_LAYOUT_NOTICE,
  orgPinFilePath,
  orgPinFileRead,
  orgPinFileWrite,
  StateLayoutError,
  snapshotsDir,
  stateFileLeftover,
  stateFilePath,
  stateFileRead,
  stateFileWrite,
  stateLayout,
  stateLayoutPrepare,
  stateNoticesPrint,
  stateOrgsList,
} from "../src/state-paths.ts";

// Engine state used to sit under dot-names at the repository root and in
// resources/<org>/. It now lives in state/<org>/. Losing or half-moving the
// state file makes the next push create every resource again, and a commit
// step that stages only the old place would leave moved state out of git.
// So an org is in one layout, every command reads and writes the layout it
// finds, and only `npm run migrate` moves an org. These tests pin that: an
// old repository left exactly where it is on a person's machine and in CI,
// a moved one, one cut short, two places in disagreement, and the move.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ORG = "acme";
const UUID = "11111111-1111-4111-8111-111111111111";
const STATE = `${JSON.stringify({ assistants: { intake: { uuid: UUID } } }, null, 2)}\n`;
const PIN = '{\n  "orgId": "org-a"\n}\n';
const LOCAL: NodeJS.ProcessEnv = {};
const CI: NodeJS.ProcessEnv = { CI: "true" };

// The step every repository had before state/ existed.
const OLD_WORKFLOW = [
  "jobs:",
  "  promote:",
  "    steps:",
  "      - name: Commit reconciled files and UUID state",
  "        run: |",
  "          git add -A -- ':(glob).vapi-state.*.json'",
  "          git add -A -- resources",
  '          git commit -m "chore: record promoted Vapi state [skip promotion]"',
  "",
].join("\n");

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string | undefined {
  return existsSync(join(root, path))
    ? readFileSync(join(root, path), "utf8")
    : undefined;
}

// A repository as it looked before state/ existed.
function oldRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "state-layout-"));
  put(root, `.vapi-state.${ORG}.json`, STATE);
  put(root, `resources/${ORG}/.vapi-org.json`, PIN);
  put(root, `.vapi-state-hash/${ORG}/${UUID}`, "baseline-hash\n");
  put(
    root,
    `.vapi-state.${ORG}.snapshots/2026-01-01T00-00-00-000Z/assistants/intake.json`,
    "{}\n",
  );
  return root;
}

// The workflows this repository ships, whose commit step stages state/.
function shippedWorkflows(root: string): void {
  cpSync(join(REPO, ".github/workflows"), join(root, ".github/workflows"), {
    recursive: true,
  });
}

function layout(root: string): Record<string, string | undefined> {
  return {
    oldState: read(root, `.vapi-state.${ORG}.json`),
    oldPin: read(root, `resources/${ORG}/.vapi-org.json`),
    oldBaseline: read(root, `.vapi-state-hash/${ORG}/${UUID}`),
    oldSnapshot: read(
      root,
      `.vapi-state.${ORG}.snapshots/2026-01-01T00-00-00-000Z/assistants/intake.json`,
    ),
    state: read(root, `state/${ORG}/state.json`),
    pin: read(root, `state/${ORG}/org.json`),
    baseline: read(root, `state/${ORG}/local/baselines/${UUID}`),
    snapshot: read(
      root,
      `state/${ORG}/local/snapshots/2026-01-01T00-00-00-000Z/assistants/intake.json`,
    ),
  };
}

const OLD = {
  oldState: STATE,
  oldPin: PIN,
  oldBaseline: "baseline-hash\n",
  oldSnapshot: "{}\n",
  state: undefined,
  pin: undefined,
  baseline: undefined,
  snapshot: undefined,
};

const MOVED = {
  oldState: undefined,
  oldPin: undefined,
  oldBaseline: undefined,
  oldSnapshot: undefined,
  state: STATE,
  pin: PIN,
  baseline: "baseline-hash\n",
  snapshot: "{}\n",
};

function withRepo(root: string, body: () => void | Promise<void>) {
  return Promise.resolve()
    .then(body)
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function emptyRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "state-layout-"));
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  return root;
}

// ── Which layout an org is in ────────────────────────────────────────────

test("orgs are listed from both layouts", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    put(root, "state/beta/state.json", "{}\n");
    put(root, "state/README.md", "# state\n");
    put(root, "state/no-state-file/local/baselines/x", "h\n");
    assert.deepEqual(stateOrgsList(root), ["acme", "beta"]);
  });
});

test("a file is read and written where it is", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    const before = [stateFileRead(root, ORG), orgPinFileRead(root, ORG)];
    put(root, `state/${ORG}/state.json`, STATE);
    put(root, `state/${ORG}/org.json`, PIN);
    assert.deepEqual(
      [
        before,
        stateFileRead(root, ORG),
        orgPinFileRead(root, ORG),
        stateFileWrite === stateFileRead,
        orgPinFileWrite === orgPinFileRead,
      ],
      [
        [
          join(root, `.vapi-state.${ORG}.json`),
          join(root, `resources/${ORG}/.vapi-org.json`),
        ],
        stateFilePath(root, ORG),
        orgPinFilePath(root, ORG),
        true,
        true,
      ],
    );
  });
});

test("an org with no state yet goes where the repository's other orgs keep theirs", () => {
  const old = oldRepo();
  const moved = emptyRepo({ "state/beta/state.json": STATE });
  const mixed = emptyRepo({
    "state/beta/state.json": STATE,
    ".vapi-state.gamma.json": STATE,
  });
  try {
    assert.deepEqual(
      [
        stateLayout(old, "new-org"),
        stateFileWrite(old, "new-org"),
        orgPinFileWrite(old, "new-org"),
        stateLayout(moved, "new-org"),
        stateFileWrite(moved, "new-org"),
        orgPinFileWrite(moved, "new-org"),
        // One org still at the root means the commit step may still be the
        // old one, so a new org goes where that step looks.
        stateLayout(mixed, "new-org"),
      ],
      [
        "root",
        join(old, ".vapi-state.new-org.json"),
        join(old, "resources/new-org/.vapi-org.json"),
        "folder",
        stateFilePath(moved, "new-org"),
        orgPinFilePath(moved, "new-org"),
        "root",
      ],
    );
  } finally {
    for (const root of [old, moved, mixed])
      rmSync(root, { recursive: true, force: true });
  }
});

test("an org's pin decides its layout while it has no state file", () => {
  // Each org's pin says the opposite of where the other org keeps its state.
  const pinnedOld = emptyRepo({
    "state/beta/state.json": STATE,
    [`resources/${ORG}/.vapi-org.json`]: PIN,
  });
  const pinnedNew = emptyRepo({
    ".vapi-state.gamma.json": STATE,
    [`state/${ORG}/org.json`]: PIN,
  });
  try {
    assert.deepEqual(
      [stateLayout(pinnedOld, ORG), stateLayout(pinnedNew, ORG)],
      ["root", "folder"],
    );
  } finally {
    for (const root of [pinnedOld, pinnedNew])
      rmSync(root, { recursive: true, force: true });
  }
});

test("a repository with no state at all uses state/ only where the commit step is seen or said to stage it", () => {
  const layoutOf = (files: Record<string, string>, shipped = false) => {
    const root = emptyRepo(files);
    if (shipped) shippedWorkflows(root);
    try {
      return stateLayout(root, ORG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const word = '{\n  "stagesStateFolder": true\n}\n';
  assert.deepEqual(
    {
      "no workflow": layoutOf({}),
      "the workflows this repository ships": layoutOf({}, true),
      "the step from before state/": layoutOf({
        ".github/workflows/promotion.yml": OLD_WORKFLOW,
      }),
      "no workflow, and a person's word": layoutOf({
        "state/commit-step.json": word,
      }),
      "the step from before state/, and a person's word": layoutOf({
        ".github/workflows/promotion.yml": OLD_WORKFLOW,
        "state/commit-step.json": word,
      }),
    },
    {
      "no workflow": "root",
      "the workflows this repository ships": "folder",
      "the step from before state/": "root",
      "no workflow, and a person's word": "folder",
      "the step from before state/, and a person's word": "root",
    },
  );
});

// ── A command leaves committed state where it is ─────────────────────────

test("a command leaves an old repository exactly where it is, on any machine and under any workflow", () => {
  for (const env of [LOCAL, CI, { GITHUB_ACTIONS: "true" }]) {
    for (const shipped of [false, true]) {
      const root = oldRepo();
      if (shipped) shippedWorkflows(root);
      const first = stateLayoutPrepare(root, ORG, env);
      const second = stateLayoutPrepare(root, ORG, env);
      const after = layout(root);
      const stateFolder = existsSync(join(root, "state"));
      rmSync(root, { recursive: true, force: true });
      assert.deepEqual(
        { first, second, after, stateFolder },
        {
          first: [OLD_LAYOUT_NOTICE],
          second: [OLD_LAYOUT_NOTICE],
          after: OLD,
          stateFolder: false,
        },
      );
    }
  }
});

test("the older-layout line is one line, printed once per command", () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  try {
    // apply prints it, then starts a pull and a push with the same environment.
    const command: NodeJS.ProcessEnv = {};
    stateNoticesPrint([OLD_LAYOUT_NOTICE], command);
    stateNoticesPrint([OLD_LAYOUT_NOTICE, "something else"], command);
    stateNoticesPrint([OLD_LAYOUT_NOTICE], command);
    // The next command starts with a fresh environment.
    stateNoticesPrint([OLD_LAYOUT_NOTICE], {});
  } finally {
    console.log = log;
  }
  assert.deepEqual(
    [
      printed,
      OLD_LAYOUT_NOTICE.includes("\n"),
      /npm run migrate/.test(OLD_LAYOUT_NOTICE),
    ],
    [[OLD_LAYOUT_NOTICE, "something else", OLD_LAYOUT_NOTICE], false, true],
  );
});

test("a repository in state/ gets no notice, and a new org joins it there", () => {
  const root = emptyRepo({ [`state/${ORG}/state.json`]: STATE });
  return withRepo(root, () => {
    assert.deepEqual(
      [
        stateLayoutPrepare(root, ORG, LOCAL),
        stateLayoutPrepare(root, ORG, CI),
        stateLayoutPrepare(root, "new-org", CI),
        stateFileWrite(root, "new-org") === stateFilePath(root, "new-org"),
      ],
      [[], [], [], true],
    );
  });
});

test("for an org in state/, this machine's baselines and snapshots follow, newest side winning", () => {
  // What a teammate's machine holds after someone else ran migrate.
  const root = oldRepo();
  return withRepo(root, () => {
    rmSync(join(root, `.vapi-state.${ORG}.json`));
    rmSync(join(root, `resources/${ORG}/.vapi-org.json`));
    put(root, `state/${ORG}/state.json`, STATE);
    put(root, `state/${ORG}/org.json`, PIN);
    put(root, `state/${ORG}/local/baselines/${UUID}`, "newer-hash\n");
    put(root, `.vapi-state-hash/${ORG}/other`, "other-hash\n");
    const notices = stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(
      [
        notices,
        readdirSync(baselinesDir(root, ORG)).sort(),
        read(root, `state/${ORG}/local/baselines/${UUID}`),
        existsSync(join(root, ".vapi-state-hash")),
        readdirSync(snapshotsDir(root, ORG)),
        stateLayoutPrepare(root, ORG, LOCAL),
      ],
      [
        [
          `📦 Moved .vapi-state-hash/${ORG}/, .vapi-state.${ORG}.snapshots/ into state/${ORG}/local/. Both places are gitignored.`,
        ],
        [UUID, "other"].sort(),
        "newer-hash\n",
        false,
        ["2026-01-01T00-00-00-000Z"],
        [],
      ],
    );
  });
});

// ── A CI run under a workflow that would not commit what it writes ───────

test("a CI run stops before it writes state/ its workflow would not commit", () => {
  const root = emptyRepo({
    [`state/${ORG}/state.json`]: STATE,
    ".github/workflows/promotion.yml": OLD_WORKFLOW,
  });
  return withRepo(root, () => {
    assert.throws(
      () => stateLayoutPrepare(root, ORG, CI),
      (error: unknown) =>
        error instanceof StateLayoutError &&
        /promotion\.yml stages \.vapi-state\.\*\.json but not state\//.test(
          error.message,
        ) &&
        /Stopped before reading or changing anything/.test(error.message),
    );
    // The same checkout on a person's machine runs: whoever commits there
    // sees what they stage.
    assert.deepEqual(stateLayoutPrepare(root, ORG, LOCAL), []);
  });
});

// ── Cut short, or in both places ─────────────────────────────────────────

test("a move cut short between two files is read where each file is, and migrate finishes it", async () => {
  const root = oldRepo();
  shippedWorkflows(root);
  try {
    // The state file moved; the run died before the pin did.
    put(root, `state/${ORG}/state.json`, STATE);
    rmSync(join(root, `.vapi-state.${ORG}.json`));
    stateLayoutPrepare(root, ORG, LOCAL);
    const cut = [
      stateFileRead(root, ORG),
      orgPinFileWrite(root, ORG),
      layout(root).oldPin,
      layout(root).pin,
    ];
    await migrateAll(root);
    assert.deepEqual(
      [cut, layout(root)],
      [
        [
          stateFilePath(root, ORG),
          join(root, `resources/${ORG}/.vapi-org.json`),
          PIN,
          undefined,
        ],
        MOVED,
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same content in both places: state/ is read, the old copy stays, and only migrate removes it", async () => {
  // Same mapping, different key order and spacing: a merge or a formatter.
  const copy = `{"assistants":{"intake":{"uuid":"${UUID}"}}}`;
  for (const env of [LOCAL, CI]) {
    const root = oldRepo();
    shippedWorkflows(root);
    put(root, `state/${ORG}/state.json`, copy);
    const notices = stateLayoutPrepare(root, ORG, env);
    const held = layout(root);
    const leftover = stateFileLeftover(root, ORG);
    await migrateAll(root);
    const after = layout(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(
      {
        notice: notices.at(-1),
        read: [held.oldState, held.state],
        leftover: leftover?.endsWith(`.vapi-state.${ORG}.json`),
        afterMigrate: [after.oldState, after.state, after.pin],
      },
      {
        notice:
          "ℹ️  .vapi-state.acme.json is still here beside its copy in state/acme/. `npm run migrate` removes it.",
        read: [STATE, copy],
        leftover: true,
        afterMigrate: [undefined, copy, PIN],
      },
    );
  }
});

test("two state files that disagree stop the command with both intact", () => {
  for (const [path, next] of [
    [`state/${ORG}/state.json`, '{"assistants":{}}\n'],
    [`state/${ORG}/org.json`, '{"orgId":"org-b"}\n'],
  ] as const) {
    const root = oldRepo();
    put(root, path, next);
    let message = "";
    try {
      stateLayoutPrepare(root, ORG, LOCAL);
    } catch (error) {
      message =
        error instanceof StateLayoutError ? error.message : "wrong error";
    }
    const after = layout(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(
      [
        /both exist and disagree/.test(message),
        message.includes(path),
        after.oldState,
        after.oldPin,
        path.endsWith("state.json") ? after.state : after.pin,
        // Nothing else moved either: the stop comes first.
        after.baseline,
      ],
      [true, true, STATE, PIN, next, undefined],
    );
  }
});

// ── npm run migrate and the legacy-format guard ──────────────────────────

const FAT_STATE = `${JSON.stringify({ assistants: { intake: { uuid: UUID, origin: "pulled", lastPulledAt: "2026-01-01T00:00:00Z" } } })}\n`;

test("the legacy-format guard reads the state file in either place", () => {
  const root = mkdtempSync(join(tmpdir(), "state-layout-"));
  return withRepo(root, () => {
    put(root, ".vapi-state.old.json", FAT_STATE);
    put(root, "state/new/state.json", FAT_STATE);
    put(root, "state/fine/state.json", STATE);
    assert.deepEqual(
      ["old", "new", "fine"].map((org) => {
        try {
          assertStateMigrated(stateFileRead(root, org));
          return "ok";
        } catch (error) {
          return /legacy format/.test((error as Error).message)
            ? "legacy"
            : "other";
        }
      }),
      ["legacy", "legacy", "ok"],
    );
  });
});

test("under a commit step seen to stage state/, migrate slims and moves every org, in a CI run too", async () => {
  const root = oldRepo();
  const ci = process.env.CI;
  process.env.CI = "true";
  try {
    shippedWorkflows(root);
    put(root, `.vapi-state.${ORG}.json`, FAT_STATE);
    put(root, "state/beta/state.json", STATE);
    const result = await migrateAll(root);
    const after = layout(root);
    assert.deepEqual(
      {
        orgs: result.orgs.map((org) => [
          org.org,
          org.stateFile,
          org.slimmed,
          org.moved,
        ]),
        after: { ...after, state: JSON.parse(after.state!) },
        rootLeftovers: readdirSync(root).filter((name) =>
          name.startsWith(".vapi-state"),
        ),
        again: (await migrateAll(root)).orgs.map((org) => [
          org.slimmed,
          org.moved,
        ]),
      },
      {
        orgs: [
          [
            ORG,
            "state/acme/state.json",
            true,
            [
              `.vapi-state.${ORG}.json`,
              `resources/${ORG}/.vapi-org.json`,
              `.vapi-state-hash/${ORG}/`,
              `.vapi-state.${ORG}.snapshots/`,
            ],
          ],
          ["beta", "state/beta/state.json", false, []],
        ],
        after: {
          ...MOVED,
          state: { assistants: { intake: { uuid: UUID, origin: "pulled" } } },
        },
        rootLeftovers: [],
        again: [
          [false, []],
          [false, []],
        ],
      },
    );
  } finally {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate slims in place and moves nothing while a workflow would drop state/, whatever a person says", async () => {
  const root = oldRepo();
  try {
    put(root, ".github/workflows/promotion.yml", OLD_WORKFLOW);
    put(root, `.vapi-state.${ORG}.json`, FAT_STATE);
    const result = await migrateAll(root);
    let refusal = "";
    try {
      commitStepAcknowledge(root);
    } catch (error) {
      refusal = error instanceof StateLayoutError ? error.message : "other";
    }
    assert.deepEqual(
      [
        result.orgs[0]!.stateFile,
        result.orgs[0]!.slimmed,
        result.orgs[0]!.moved,
        JSON.parse(layout(root).oldState!),
        layout(root).state,
        /is not true yet/.test(refusal),
        existsSync(join(root, "state")),
      ],
      [
        ".vapi-state.acme.json",
        true,
        [],
        { assistants: { intake: { uuid: UUID, origin: "pulled" } } },
        undefined,
        true,
        false,
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Real commands against a stub API ─────────────────────────────────────

const ON_PLATFORM = "What the platform holds.";
const ASSISTANT = (id: string, name: string) => ({
  id,
  orgId: "org-a",
  name,
  model: {
    provider: "openai",
    model: "gpt-4o",
    messages: [{ role: "system", content: ON_PLATFORM }],
  },
  voice: { provider: "11labs", voiceId: "burt" },
});
const UUID_NEW = "22222222-2222-4222-8222-222222222222";

async function engineRun(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        req.url?.startsWith("/assistant")
          ? [ASSISTANT(UUID, "Intake"), ASSISTANT(UUID_NEW, "Second")]
          : [],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  if (!existsSync(join(root, "src"))) {
    cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  }
  put(root, `.env.${ORG}`, "VAPI_TOKEN=fake-token-not-used\n");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    VAPI_BASE_URL: `http://127.0.0.1:${port}`,
    CI: "",
    GITHUB_ACTIONS: "",
    VAPI_GITOPS_OLD_LAYOUT_NOTICE: "",
    ...env,
  };
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", ...args], {
        cwd: root,
        env: childEnv,
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out, requests }));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("pull leaves an old repository where it is and keeps every mapping, on a person's machine and in CI", async () => {
  for (const env of [LOCAL, CI]) {
    const root = oldRepo();
    try {
      shippedWorkflows(root);
      const first = await engineRun(root, ["src/pull.ts", ORG, "--force"], env);
      const second = await engineRun(
        root,
        ["src/pull.ts", ORG, "--force"],
        env,
      );
      const state = JSON.parse(layout(root).oldState ?? "{}");
      assert.deepEqual(
        {
          codes: [first.code, second.code],
          told: [
            count(first.out, OLD_LAYOUT_NOTICE),
            count(second.out, OLD_LAYOUT_NOTICE),
          ],
          moved: count(first.out + second.out, "📦 Moved"),
          pin: [layout(root).oldPin, layout(root).pin],
          // The tracked resource kept its UUID; the new one was added beside it.
          tracked: state.assistants?.intake,
          uuids: Object.values(
            (state.assistants ?? {}) as Record<string, { uuid: string }>,
          )
            .map((entry) => entry.uuid)
            .sort(),
          // Nothing of the engine's is written under state/, baselines included.
          stateFolder: existsSync(join(root, "state")),
          newBaseline: existsSync(
            join(root, ".vapi-state-hash", ORG, UUID_NEW),
          ),
        },
        {
          codes: [0, 0],
          told: [1, 1],
          moved: 0,
          pin: [PIN, undefined],
          tracked: { uuid: UUID },
          uuids: [UUID, UUID_NEW],
          stateFolder: false,
          newBaseline: true,
        },
        first.out + second.out,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("pull keeps an old copy of the state file identical to the one in state/", async () => {
  const root = oldRepo();
  try {
    put(root, `state/${ORG}/state.json`, STATE);
    const run = await engineRun(root, ["src/pull.ts", ORG, "--force"], LOCAL);
    const after = layout(root);
    assert.deepEqual(
      [
        run.code,
        after.oldState === after.state,
        Object.keys(JSON.parse(after.state ?? "{}").assistants ?? {}).length,
      ],
      [0, true, 2],
      run.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull stops before any request when the two state files disagree", async () => {
  const root = oldRepo();
  try {
    put(root, `state/${ORG}/state.json`, '{"assistants":{}}\n');
    const run = await engineRun(root, ["src/pull.ts", ORG, "--force"], LOCAL);
    assert.deepEqual(
      [
        run.code === 0,
        run.requests,
        /both exist and disagree/.test(run.out),
        layout(root).oldState,
        layout(root).state,
      ],
      [false, [], true, STATE, '{"assistants":{}}\n'],
      run.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry-run push changes nothing", async () => {
  const root = oldRepo();
  try {
    await engineRun(root, ["src/push.ts", ORG, "--dry-run"], LOCAL);
    assert.deepEqual(layout(root), OLD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline is read from the old folder, where an old repository keeps it", async () => {
  const root = oldRepo();
  try {
    put(
      root,
      "probe.ts",
      `import { readBaseline } from "./src/hash-store.ts";\nconsole.log("baseline=" + readBaseline("${ORG}", "${UUID}"));\n`,
    );
    const run = await engineRun(root, ["probe.ts"], LOCAL);
    assert.deepEqual(
      [
        run.out.includes("baseline=baseline-hash"),
        existsSync(join(root, ".vapi-state-hash", ORG, UUID)),
      ],
      [true, true],
      run.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A file pull has no baseline for ──────────────────────────────────────
//
// With no baseline and nothing changed in git, pull has to pick between the
// file and the platform's copy. It keeps the file unless this machine's
// engine has saved state since the file was last written. It used to read
// that from the state file's timestamp, which in a fresh clone is only the
// order git wrote the files in: state at the root is written before
// resources/ and state/<org>/state.json after it.

const LOCAL_EDIT = "Edited here, not on the platform yet.";
const intakeFile = (prompt: string) =>
  "---\nname: Intake\nmodel:\n  provider: openai\n  model: gpt-4o\nvoice:\n  provider: 11labs\n  voiceId: burt\n---\n\n" +
  prompt +
  "\n";

for (const where of ["at the root", "in state/"] as const) {
  test(`with state ${where}, pull keeps a file it has no baseline for until this machine has saved state after it`, async () => {
    const root = emptyRepo({
      [where === "at the root"
        ? `.vapi-state.${ORG}.json`
        : `state/${ORG}/state.json`]: STATE,
    });
    const file = join(root, `resources/${ORG}/assistants/intake.md`);
    const kept = () => readFileSync(file, "utf8").includes(LOCAL_EDIT);
    try {
      put(
        root,
        `resources/${ORG}/assistants/intake.md`,
        intakeFile(LOCAL_EDIT),
      );
      // Written long before the state file, as a checkout may leave it.
      utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
      const first = await engineRun(root, ["src/pull.ts", ORG], LOCAL);
      const afterFirst = kept();
      // Edited again after the engine saved state: still the person's.
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      const second = await engineRun(root, ["src/pull.ts", ORG], LOCAL);
      const afterSecond = kept();
      // Untouched since the engine last saved state here: the platform's copy.
      utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
      const third = await engineRun(root, ["src/pull.ts", ORG], LOCAL);
      assert.deepEqual(
        {
          codes: [first.code, second.code, third.code],
          "no save here yet": afterFirst,
          "written after the last save": afterSecond,
          "older than the last save": kept(),
          platform: readFileSync(file, "utf8").includes(ON_PLATFORM),
        },
        {
          codes: [0, 0, 0],
          "no save here yet": true,
          "written after the last save": true,
          "older than the last save": false,
          platform: true,
        },
        first.out + second.out + third.out,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
