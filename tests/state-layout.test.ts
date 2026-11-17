import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { assertStateMigrated, migrateAll } from "../src/migrate-hash-store.ts";
import {
  StateLayoutError,
  baselinesDir,
  orgPinFilePath,
  orgPinFileRead,
  orgPinFileWrite,
  snapshotsDir,
  stateFilePath,
  stateFileRead,
  stateFileWrite,
  stateLayoutPrepare,
  stateMoveBlocker,
  stateOrgsList,
} from "../src/state-paths.ts";

// Engine state used to sit under dot-names at the repository root and in
// resources/<org>/. It now lives in state/<org>/. Losing or half-moving the
// state file makes the next push create every resource again, so these tests
// pin every way an older repository reaches the new layout: read in place,
// moved by a command on a person's machine, held back in CI and under a
// workflow that would not commit the move, cut short, and in disagreement.

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

function layout(root: string): Record<string, string | undefined> {
  return {
    oldState: read(root, `.vapi-state.${ORG}.json`),
    oldPin: read(root, `resources/${ORG}/.vapi-org.json`),
    state: read(root, `state/${ORG}/state.json`),
    pin: read(root, `state/${ORG}/org.json`),
    baseline: read(root, `state/${ORG}/local/baselines/${UUID}`),
    snapshot: read(
      root,
      `state/${ORG}/local/snapshots/2026-01-01T00-00-00-000Z/assistants/intake.json`,
    ),
  };
}

const MOVED = {
  oldState: undefined,
  oldPin: undefined,
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

// ── Reading ──────────────────────────────────────────────────────────────

test("orgs are listed from both layouts, and an org with no state yet reads from state/", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    put(root, "state/beta/state.json", "{}\n");
    put(root, "state/README.md", "# state\n");
    put(root, "state/no-state-file/local/baselines/x", "h\n");
    assert.deepEqual(
      [
        stateOrgsList(root),
        stateFileRead(root, "fresh") === stateFilePath(root, "fresh"),
      ],
      [["acme", "beta"], true],
    );
  });
});

test("reads fall back to the old file only while the new one is absent", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    const before = [stateFileRead(root, ORG), orgPinFileRead(root, ORG)];
    put(root, `state/${ORG}/state.json`, STATE);
    put(root, `state/${ORG}/org.json`, PIN);
    assert.deepEqual(
      [before, stateFileRead(root, ORG), orgPinFileRead(root, ORG)],
      [
        [
          join(root, `.vapi-state.${ORG}.json`),
          join(root, `resources/${ORG}/.vapi-org.json`),
        ],
        stateFilePath(root, ORG),
        orgPinFilePath(root, ORG),
      ],
    );
  });
});

// ── Moving on a person's machine ─────────────────────────────────────────

test("a command on a person's machine moves everything and says so in one line", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    const notices = stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(
      {
        notices,
        layout: layout(root),
        leftovers: existsSync(join(root, ".vapi-state-hash")),
      },
      {
        notices: [
          `📦 Moved .vapi-state-hash/${ORG}/, .vapi-state.${ORG}.snapshots/, .vapi-state.${ORG}.json, resources/${ORG}/.vapi-org.json into state/${ORG}/. Commit the removal together with the new folder.`,
        ],
        layout: MOVED,
        leftovers: false,
      },
    );
  });
});

test("a second run moves nothing and says nothing", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(
      [stateLayoutPrepare(root, ORG, LOCAL), layout(root)],
      [[], MOVED],
    );
  });
});

test("a repository that never had the old layout is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "state-layout-"));
  return withRepo(root, () => {
    put(root, `state/${ORG}/state.json`, STATE);
    assert.deepEqual(
      [
        stateLayoutPrepare(root, ORG, LOCAL),
        stateLayoutPrepare(root, ORG, CI),
        stateFileWrite(root, ORG, CI) === stateFilePath(root, ORG),
        stateFileWrite(root, "new-org", CI) === stateFilePath(root, "new-org"),
        orgPinFileWrite(root, "new-org", CI) ===
          orgPinFilePath(root, "new-org"),
      ],
      [[], [], true, true, true],
    );
  });
});

test("machine-local files merge into a folder that already exists, newest side winning", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    put(root, `state/${ORG}/local/baselines/${UUID}`, "newer-hash\n");
    put(root, `.vapi-state-hash/${ORG}/other`, "other-hash\n");
    stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(
      [
        readdirSync(baselinesDir(root, ORG)).sort(),
        read(root, `state/${ORG}/local/baselines/${UUID}`),
        existsSync(join(root, ".vapi-state-hash")),
        readdirSync(snapshotsDir(root, ORG)),
      ],
      [
        [UUID, "other"].sort(),
        "newer-hash\n",
        false,
        ["2026-01-01T00-00-00-000Z"],
      ],
    );
  });
});

// ── Held back ────────────────────────────────────────────────────────────

test("a CI run leaves committed state where it is and writes it in place", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    const notices = stateLayoutPrepare(root, ORG, CI);
    assert.deepEqual(
      {
        notices,
        layout: layout(root),
        stateWrite: stateFileWrite(root, ORG, CI),
        pinWrite: orgPinFileWrite(root, ORG, CI),
      },
      {
        notices: [
          `📦 Moved .vapi-state-hash/${ORG}/, .vapi-state.${ORG}.snapshots/ into state/${ORG}/.`,
          "ℹ️  .vapi-state.acme.json and resources/acme/.vapi-org.json stays where it is: a CI run never moves state. Run `npm run migrate` on your machine and commit the result to move it into state/acme/.",
        ],
        // Gitignored files move anywhere: no workflow can lose them.
        layout: {
          ...MOVED,
          oldState: STATE,
          oldPin: PIN,
          state: undefined,
          pin: undefined,
        },
        stateWrite: join(root, `.vapi-state.${ORG}.json`),
        pinWrite: join(root, `resources/${ORG}/.vapi-org.json`),
      },
    );
  });
});

test("GITHUB_ACTIONS counts as a CI run", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    stateLayoutPrepare(root, ORG, { GITHUB_ACTIONS: "true" });
    assert.equal(layout(root).oldState, STATE);
  });
});

test("a workflow that stages only the old file holds the move back, on any machine", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    put(root, ".github/workflows/promotion.yml", OLD_WORKFLOW);
    const notices = stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(
      {
        blocker: stateMoveBlocker(root, LOCAL),
        warned: notices.at(-1),
        oldState: layout(root).oldState,
        state: layout(root).state,
        // A new org follows the layout the workflow commits.
        newOrgState: stateFileWrite(root, "new-org", LOCAL),
        newOrgPin: orgPinFileWrite(root, "new-org", LOCAL),
      },
      {
        blocker: { kind: "workflow", file: ".github/workflows/promotion.yml" },
        warned:
          "⚠️  .vapi-state.acme.json and resources/acme/.vapi-org.json stays where it is: .github/workflows/promotion.yml stages .vapi-state.*.json but not state/. Add `git add -A -- state` to that step, then run `npm run migrate`.",
        oldState: STATE,
        state: undefined,
        newOrgState: join(root, ".vapi-state.new-org.json"),
        newOrgPin: join(root, "resources/new-org/.vapi-org.json"),
      },
    );
  });
});

test("the workflow this repository ships does not hold the move back", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    cpSync(join(REPO, ".github/workflows"), join(root, ".github/workflows"), {
      recursive: true,
    });
    assert.deepEqual(
      [stateMoveBlocker(root, LOCAL), stateMoveBlocker(root, CI)],
      [undefined, { kind: "ci" }],
    );
  });
});

test("a CI run stops before it writes state its workflow would not commit", () => {
  const root = mkdtempSync(join(tmpdir(), "state-layout-"));
  return withRepo(root, () => {
    put(root, `state/${ORG}/state.json`, STATE);
    put(root, ".github/workflows/promotion.yml", OLD_WORKFLOW);
    assert.throws(
      () => stateLayoutPrepare(root, ORG, CI),
      (error: unknown) =>
        error instanceof StateLayoutError &&
        /promotion\.yml stages \.vapi-state\.\*\.json but not state\//.test(
          error.message,
        ) &&
        /Stopped before reading or changing anything/.test(error.message),
    );
    // The same checkout on a person's machine is warned, not stopped.
    assert.match(
      stateLayoutPrepare(root, ORG, LOCAL)[0]!,
      /^⚠️ {2}\.github\/workflows\/promotion\.yml/,
    );
  });
});

// ── Cut short, or in disagreement ────────────────────────────────────────

test("a move cut short between two files finishes on the next run", () => {
  const root = oldRepo();
  return withRepo(root, () => {
    // The state file moved; the run died before the pin did.
    put(root, `state/${ORG}/state.json`, STATE);
    rmSync(join(root, `.vapi-state.${ORG}.json`));
    stateLayoutPrepare(root, ORG, LOCAL);
    assert.deepEqual(layout(root), MOVED);
  });
});

test("the same content in both places is one state: the old copy goes, even in CI", () => {
  for (const env of [LOCAL, CI]) {
    const root = oldRepo();
    // Same mapping, different key order and spacing: a merge or a formatter.
    put(
      root,
      `state/${ORG}/state.json`,
      `{"assistants":{"intake":{"uuid":"${UUID}"}}}`,
    );
    stateLayoutPrepare(root, ORG, env);
    const after = layout(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(
      [after.oldState, after.state],
      [undefined, `{"assistants":{"intake":{"uuid":"${UUID}"}}}`],
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

const FAT_STATE = `${JSON.stringify({ assistants: { intake: { uuid: UUID, lastPulledHash: "h" } } })}\n`;

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

test("migrate slims and moves every org, in a CI run too", async () => {
  const root = oldRepo();
  const ci = process.env.CI;
  process.env.CI = "true";
  try {
    put(root, `.vapi-state.${ORG}.json`, FAT_STATE);
    put(root, "state/beta/state.json", STATE);
    const result = await migrateAll(root);
    assert.deepEqual(
      {
        orgs: result.orgs.map((org) => [
          org.org,
          org.stateFile,
          org.slimmed,
          org.notices.length,
        ]),
        oldState: layout(root).oldState,
        state: JSON.parse(layout(root).state!),
        pin: layout(root).pin,
        again: (await migrateAll(root)).orgs.map((org) => [
          org.slimmed,
          org.notices,
        ]),
      },
      {
        orgs: [
          [ORG, "state/acme/state.json", true, 1],
          ["beta", "state/beta/state.json", false, 0],
        ],
        oldState: undefined,
        state: { assistants: { intake: { uuid: UUID } } },
        pin: PIN,
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

test("migrate does not move state while a workflow would drop it", async () => {
  const root = oldRepo();
  try {
    put(root, ".github/workflows/promotion.yml", OLD_WORKFLOW);
    const result = await migrateAll(root);
    assert.deepEqual(
      [result.orgs[0]!.stateFile, layout(root).oldState, layout(root).state],
      [".vapi-state.acme.json", STATE, undefined],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Real commands against a stub API ─────────────────────────────────────

const ASSISTANT = (id: string, name: string) => ({
  id,
  orgId: "org-a",
  name,
  model: {
    provider: "openai",
    model: "gpt-4o",
    messages: [{ role: "system", content: "hi" }],
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

test("pull on a person's machine moves an old repository once and keeps every mapping", async () => {
  const root = oldRepo();
  try {
    const first = await engineRun(root, ["src/pull.ts", ORG, "--force"], LOCAL);
    const state = JSON.parse(layout(root).state ?? "{}");
    const second = await engineRun(
      root,
      ["src/pull.ts", ORG, "--force"],
      LOCAL,
    );
    assert.deepEqual(
      {
        codes: [first.code, second.code],
        moved: [count(first.out, "📦 Moved"), count(second.out, "📦 Moved")],
        oldState: layout(root).oldState,
        oldPin: layout(root).oldPin,
        pin: layout(root).pin,
        // The tracked resource kept its UUID; the new one was added beside it.
        tracked: state.assistants.intake,
        uuids: Object.values(
          state.assistants as Record<string, { uuid: string }>,
        )
          .map((entry) => entry.uuid)
          .sort(),
        rootLeftovers: readdirSync(root).filter((name) =>
          name.startsWith(".vapi-state"),
        ),
      },
      {
        codes: [0, 0],
        moved: [1, 0],
        oldState: undefined,
        oldPin: undefined,
        pin: PIN,
        tracked: { uuid: UUID },
        uuids: [UUID, UUID_NEW],
        rootLeftovers: [],
      },
      first.out + second.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull in a CI run updates an old repository's state file in place", async () => {
  const root = oldRepo();
  try {
    const run = await engineRun(root, ["src/pull.ts", ORG, "--force"], CI);
    const state = JSON.parse(layout(root).oldState ?? "{}");
    assert.deepEqual(
      {
        code: run.code,
        told: count(run.out, "a CI run never moves state"),
        state: layout(root).state,
        pin: [layout(root).oldPin, layout(root).pin],
        tracked: state.assistants?.intake,
        uuids: Object.values(
          (state.assistants ?? {}) as Record<string, { uuid: string }>,
        )
          .map((entry) => entry.uuid)
          .sort(),
      },
      {
        code: 0,
        told: 1,
        state: undefined,
        pin: [PIN, undefined],
        tracked: { uuid: UUID },
        uuids: [UUID, UUID_NEW],
      },
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

test("a dry-run push moves nothing", async () => {
  const root = oldRepo();
  try {
    const run = await engineRun(root, ["src/push.ts", ORG, "--dry-run"], LOCAL);
    assert.deepEqual(
      [count(run.out, "📦 Moved"), layout(root).oldState, layout(root).state],
      [0, STATE, undefined],
      run.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline is still read from the old folder until it moves", async () => {
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
