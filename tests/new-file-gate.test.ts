import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// new-file-gate.ts → pull.ts → config.ts: config.ts asserts argv[2] /
// VAPI_TOKEN at module load. Prime both before importing the module under
// test. Same trick used in tests/audit.test.ts.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { detectOrphanYamls, formatGateMessage } = await import(
  "../src/new-file-gate.ts"
);

import type { OrphanReport } from "../src/new-file-gate.ts";
import type { ResourceState, ResourceType, StateFile } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — DI-style, filesystem-free.
// ─────────────────────────────────────────────────────────────────────────────

function makeStateEntry(uuid: string): ResourceState {
  return { uuid };
}

function makeStateFile(overrides: Partial<StateFile> = {}): StateFile {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
    ...overrides,
  };
}

// Mirror of src/pull.ts:extractBaseSlug — kept inline so the unit tests don't
// pull pull.ts transitively (which would re-run the filesystem walk). We
// already exercise the real helper through the integration fixtures.
function fakeExtractBaseSlug(resourceId: string): string {
  const match = resourceId.match(/^(.*)-([a-f0-9]{8})$/i);
  return match?.[1] ?? resourceId;
}

interface LocalsByType {
  tools?: string[];
  structuredOutputs?: string[];
  assistants?: string[];
  squads?: string[];
  personalities?: string[];
  scenarios?: string[];
  simulations?: string[];
  simulationSuites?: string[];
  evals?: string[];
}

function makeListLocalIds(locals: LocalsByType) {
  return (t: ResourceType): string[] => {
    return locals[t] ?? [];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// detectOrphanYamls — unit
// ─────────────────────────────────────────────────────────────────────────────

test("detectOrphanYamls: empty state + 1 local file produces 1 orphan and 0 rename sources", () => {
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds({ assistants: ["orphan-bot"] }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.type, "assistants");
  assert.equal(report.orphans[0]!.resourceId, "orphan-bot");
  assert.match(
    report.orphans[0]!.relativePath,
    /resources\/[^/]+\/assistants\/orphan-bot\.md/,
  );
  assert.equal(report.possibleRenameSources.length, 0);
  assert.equal(report.scopedToPaths, false);
});

test("detectOrphanYamls: all local files present in state produces empty report", () => {
  const report = detectOrphanYamls({
    state: makeStateFile({
      assistants: {
        "known-bot": makeStateEntry("uuid-1"),
      },
    }),
    listLocalIds: makeListLocalIds({ assistants: ["known-bot"] }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 0);
  assert.equal(report.possibleRenameSources.length, 0);
});

test("detectOrphanYamls: rename pairing — state entry without local file shares base slug with orphan", () => {
  // Scenario: state has `old-bot-aaaaaaaa` (UUID v1), user renamed it locally
  // to `new-bot-aaaaaaaa` (Flow F-ish — base slugs intentionally don't share
  // here, so we instead test the more common Flow G: dashboard rename produced
  // a new local file with the same base slug but a different UUID suffix.
  // The state still has the old suffix; the new file is the orphan).
  const report = detectOrphanYamls({
    state: makeStateFile({
      assistants: {
        "foo-aaaaaaaa": makeStateEntry("11111111-1111-1111-1111-111111111111"),
      },
    }),
    listLocalIds: makeListLocalIds({ assistants: ["foo-bbbbbbbb"] }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.resourceId, "foo-bbbbbbbb");
  assert.equal(report.possibleRenameSources.length, 1);
  assert.equal(report.possibleRenameSources[0]!.resourceId, "foo-aaaaaaaa");
  assert.equal(
    report.possibleRenameSources[0]!.uuid,
    "11111111-1111-1111-1111-111111111111",
  );
});

test("detectOrphanYamls: state entry without local file but no orphan sharing base slug → no rename pairing", () => {
  // A pure state-ghost (no orphan sharing the base) should NOT show up as a
  // rename source — that's the audit's `state-ghost` rule, not this gate's
  // concern.
  const report = detectOrphanYamls({
    state: makeStateFile({
      assistants: {
        "ghost-bot-aaaaaaaa": makeStateEntry("uuid-ghost"),
      },
    }),
    listLocalIds: makeListLocalIds({ assistants: ["totally-new-bot"] }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 1);
  // ghost-bot has base "ghost-bot"; orphan has base "totally-new-bot" — no
  // match → no rename source surfaced.
  assert.equal(report.possibleRenameSources.length, 0);
});

test("detectOrphanYamls: filePathFilter scopes detection to the selective-push file set", () => {
  // Two orphans across two types; only one matches the filter.
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds({
      assistants: ["foo"],
      tools: ["bar"],
    }),
    filePathFilter: ["resources/test/assistants/foo.md"],
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.scopedToPaths, true);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.type, "assistants");
  assert.equal(report.orphans[0]!.resourceId, "foo");
});

test("detectOrphanYamls: files matched by `.vapi-ignore` are excluded from orphans (M1 regression guard)", () => {
  // The user has explicitly opted certain on-disk files OUT of gitops
  // tracking via `.vapi-ignore`. Those files exist on disk but the engine
  // never uploads them. Without the .vapi-ignore skip here, the gate would
  // halt every push for a file the engine wouldn't have touched anyway —
  // defeating the workaround customers use to silence audit noise on stale
  // dashboard artifacts. Surfaced by canonical code review of feature/new-file-gate.
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds({
      assistants: ["ignored-stub", "real-orphan"],
    }),
    extractBaseSlug: fakeExtractBaseSlug,
    matchesIgnore: (_folder, resourceId) =>
      resourceId === "ignored-stub" ? "ignored-stub" : null,
  });
  // Only the non-ignored file appears as an orphan; the ignored file is gone.
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.resourceId, "real-orphan");
});

test("detectOrphanYamls: filePathFilter that excludes the orphan produces empty report", () => {
  // The gate must NOT fire when the orphan is outside the user's selective
  // push scope. This is the central case for Flow F (push assistants/foo.md
  // while tools/bar.yml happens to be orphan).
  const report = detectOrphanYamls({
    state: makeStateFile({
      assistants: { "known-foo": makeStateEntry("uuid-1") },
    }),
    listLocalIds: makeListLocalIds({
      assistants: ["known-foo"],
      tools: ["orphan-bar"],
    }),
    filePathFilter: ["resources/test/assistants/known-foo.md"],
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.scopedToPaths, true);
  assert.equal(report.orphans.length, 0);
});

test("detectOrphanYamls: empty state across ALL types → all locals flagged (bootstrap-like)", () => {
  // The gate caller suppresses on BOOTSTRAP_SYNC, but detectOrphanYamls
  // itself is stateless wrt that flag. Confirm it returns the full orphan
  // set when state is empty.
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds({
      assistants: ["a1"],
      tools: ["t1", "t2"],
      squads: ["s1"],
    }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 4);
  const byType = new Map<string, number>();
  for (const o of report.orphans) {
    byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  }
  assert.equal(byType.get("assistants"), 1);
  assert.equal(byType.get("tools"), 2);
  assert.equal(byType.get("squads"), 1);
});

test("detectOrphanYamls: covers all 9 resource types", () => {
  const everyType: LocalsByType = {
    assistants: ["a"],
    tools: ["t"],
    structuredOutputs: ["so"],
    squads: ["sq"],
    personalities: ["p"],
    scenarios: ["sc"],
    simulations: ["sim"],
    simulationSuites: ["suite"],
    evals: ["e"],
  };
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds(everyType),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  assert.equal(report.orphans.length, 9);
  const seen = new Set(report.orphans.map((o) => o.type));
  for (const t of [
    "assistants",
    "tools",
    "structuredOutputs",
    "squads",
    "personalities",
    "scenarios",
    "simulations",
    "simulationSuites",
    "evals",
  ] as ResourceType[]) {
    assert.equal(seen.has(t), true, `expected ${t} in orphan set`);
  }
});

test("detectOrphanYamls: relative path extension distinguishes assistants (.md) from others (.yml)", () => {
  const report = detectOrphanYamls({
    state: makeStateFile(),
    listLocalIds: makeListLocalIds({
      assistants: ["a1"],
      tools: ["t1"],
    }),
    extractBaseSlug: fakeExtractBaseSlug,
  });
  const a = report.orphans.find((o) => o.type === "assistants");
  const t = report.orphans.find((o) => o.type === "tools");
  assert.ok(a);
  assert.ok(t);
  assert.ok(a.relativePath.endsWith(".md"));
  assert.ok(t.relativePath.endsWith(".yml"));
});

// ─────────────────────────────────────────────────────────────────────────────
// formatGateMessage — unit
// ─────────────────────────────────────────────────────────────────────────────

function sampleReport(): OrphanReport {
  return {
    orphans: [
      {
        type: "assistants",
        resourceId: "foo",
        relativePath: "resources/test/assistants/foo.md",
      },
      {
        type: "tools",
        resourceId: "bar",
        relativePath: "resources/test/tools/bar.yml",
      },
    ],
    possibleRenameSources: [
      {
        type: "assistants",
        resourceId: "old-foo",
        uuid: "64df6206-aaaa-bbbb-cccc-dddddddddddd",
      },
    ],
    scopedToPaths: false,
  };
}

test("formatGateMessage: color=false produces NO ANSI escape sequences", () => {
  const out = formatGateMessage(sampleReport(), "test-env", { color: false });
  // ESC = \x1b — any occurrence is an ANSI code we should not emit.
  assert.doesNotMatch(
    out,
    // eslint-disable-next-line no-control-regex
    /\x1b\[/,
    `expected no ANSI; got: ${JSON.stringify(out)}`,
  );
});

test("formatGateMessage: color=true emits red, yellow, bold, reset escape codes", () => {
  const out = formatGateMessage(sampleReport(), "test-env", { color: true });
  assert.ok(out.includes("\x1b[31m"), "expected red");
  assert.ok(out.includes("\x1b[33m"), "expected yellow");
  assert.ok(out.includes("\x1b[1m"), "expected bold");
  assert.ok(out.includes("\x1b[0m"), "expected reset");
});

test("formatGateMessage: includes all orphan relative paths", () => {
  const out = formatGateMessage(sampleReport(), "test-env", { color: false });
  assert.ok(out.includes("resources/test/assistants/foo.md"));
  assert.ok(out.includes("resources/test/tools/bar.yml"));
});

test("formatGateMessage: includes the rename-sources block with state-only entries", () => {
  const out = formatGateMessage(sampleReport(), "test-env", { color: false });
  assert.match(out, /possible rename SOURCES/);
  assert.match(out, /assistants\/old-foo/);
  // Short UUID display (first 8 chars).
  assert.match(out, /64df6206/);
});

test("formatGateMessage: includes the AI-agent paragraph and the --allow-new-files hint", () => {
  const out = formatGateMessage(sampleReport(), "test-env", { color: false });
  assert.match(out, /FOR AI AGENTS/);
  assert.match(out, /do NOT auto-pass --allow-new-files/);
  assert.match(out, /--allow-new-files/);
});

test("formatGateMessage: scopedToPaths=true surfaces the scope note", () => {
  const report = { ...sampleReport(), scopedToPaths: true };
  const out = formatGateMessage(report, "test-env", { color: false });
  assert.match(out, /scoped to the selective-push file set/);
});

test("formatGateMessage: empty rename-sources block prints '(none — …)' message", () => {
  const report = { ...sampleReport(), possibleRenameSources: [] };
  const out = formatGateMessage(report, "test-env", { color: false });
  assert.match(out, /no plausible rename pairings found/);
});

test("formatGateMessage: environment name appears in the headline", () => {
  const out = formatGateMessage(sampleReport(), "prod-cluster", {
    color: false,
  });
  assert.match(out, /env "prod-cluster"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — fixture tree + spawnSync push
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface Fixture {
  dir: string;
  env: string;
  cleanup: () => void;
}

interface FixtureInit {
  env?: string;
  // Map of `<folder>/<resourceId>.<ext>` → file contents.
  resources?: Record<string, string>;
  // Pre-populated state file. Omit to leave the engine in "no state file" mode
  // (which the bootstrap path normally handles — used here for the
  // `--bootstrap` integration test).
  state?: Record<string, unknown> | null;
}

function setupFixture(init: FixtureInit = {}): Fixture {
  const env = init.env ?? "test-new-file-gate";
  const dir = mkdtempSync(join(tmpdir(), "vapi-new-file-gate-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );

  const resourceRoot = join(dir, "resources", env);
  mkdirSync(resourceRoot, { recursive: true });

  for (const [relPath, contents] of Object.entries(init.resources ?? {})) {
    const fullPath = join(resourceRoot, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }

  // Default state: every section empty BUT credentials populated so
  // `maybeBootstrapState` doesn't trigger an off-network bootstrap pull
  // (which would fail with a fake token). The gate runs after that step.
  const defaultState = {
    credentials: { fake: { uuid: "11111111-1111-1111-1111-111111111111" } },
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
  const stateToWrite =
    init.state === null ? null : (init.state ?? defaultState);
  if (stateToWrite !== null) {
    writeFileSync(
      join(dir, `.vapi-state.${env}.json`),
      JSON.stringify(stateToWrite, null, 2),
    );
  }

  writeFileSync(join(dir, `.env.${env}`), "VAPI_TOKEN=fake-token-not-used\n");

  return {
    dir,
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runPush(
  fx: Fixture,
  extraArgs: string[],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/push.ts", fx.env, ...extraArgs],
    {
      cwd: fx.dir,
      env: { ...process.env, VAPI_TOKEN: "fake-token-not-used" },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const MINIMAL_ASSISTANT_FOO = `---
name: foo
model:
  provider: openai
  model: gpt-4o
voice:
  provider: 11labs
  voiceId: burt
---

You are foo.
`;

const MINIMAL_TOOL_BAR = `type: endCall
async: false
function:
  name: bar
  description: stop the call
`;

// Sentinel state used by integration fixtures: every targeted resource type
// has at least one entry so `maybeBootstrapState` does NOT trigger a real
// bootstrap pull (which would burn an API call to a fake token and fail
// with a 401 before the gate gets to run). The sentinel entry's slug is
// intentionally NOT present on disk so we can also exercise the rename-
// source pairing in the "no flag" case below.
function stateWithSentinel() {
  return {
    credentials: { fake: { uuid: "11111111-1111-1111-1111-111111111111" } },
    assistants: {
      "sentinel-assistant": {
        uuid: "33333333-3333-3333-3333-333333333333",
      },
    },
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

test("integration: orphan + no flag + --dry-run → exit 1, gate fires, no API call attempted", () => {
  const fx = setupFixture({
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_FOO,
    },
    state: stateWithSentinel(),
  });
  try {
    const res = runPush(fx, ["--dry-run"]);
    assert.equal(
      res.code,
      1,
      `expected exit 1; stdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    assert.match(res.stderr, /Push refused/);
    assert.match(res.stderr, /resources\/[^/]+\/assistants\/foo\.md/);
    assert.match(res.stderr, /FOR AI AGENTS/);
    // The gate must fire BEFORE the apply loops — no "would PATCH/POST" lines
    // should appear for the orphan.
    assert.doesNotMatch(res.stdout, /would (PATCH|POST)/);
  } finally {
    fx.cleanup();
  }
});

test("integration: orphan + --allow-new-files + --dry-run → gate bypassed with single-line notice", () => {
  const fx = setupFixture({
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_FOO,
    },
    state: stateWithSentinel(),
  });
  try {
    const res = runPush(fx, ["--dry-run", "--allow-new-files"]);
    // The bypass notice must show, and exit code must NOT be 1 (the orphan
    // gate is the only thing that would exit 1 in this minimal fixture).
    assert.match(
      res.stdout,
      /bypassing new-file gate/,
      `expected bypass notice; stdout=${res.stdout}`,
    );
    // The gate's error message must NOT appear when bypassed.
    assert.doesNotMatch(res.stderr, /Push refused/);
  } finally {
    fx.cleanup();
  }
});

test("integration: orphan + --bootstrap → gate suppressed (bootstrap legitimately creates from scratch)", () => {
  const fx = setupFixture({
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_FOO,
    },
    state: null,
  });
  try {
    const res = runPush(fx, ["--dry-run", "--bootstrap"]);
    // The gate must not fire under --bootstrap.
    assert.doesNotMatch(res.stderr, /Push refused/);
    assert.doesNotMatch(res.stdout, /bypassing new-file gate/);
  } finally {
    fx.cleanup();
  }
});

test("integration: selective push with orphan OUTSIDE the selection → gate does NOT fire", () => {
  // Pre-populate state with the assistant we'll push so the gate doesn't
  // count it as an orphan, then leave an unrelated orphan tool on disk that
  // is NOT in the selective-push paths.
  const fx = setupFixture({
    resources: {
      "assistants/foo.md": MINIMAL_ASSISTANT_FOO,
      "tools/bar.yml": MINIMAL_TOOL_BAR,
    },
    state: {
      credentials: { fake: { uuid: "11111111-1111-1111-1111-111111111111" } },
      assistants: { foo: { uuid: "22222222-2222-2222-2222-222222222222" } },
      structuredOutputs: {},
      tools: {},
      squads: {},
      personalities: {},
      scenarios: {},
      simulations: {},
      simulationSuites: {},
      evals: {},
    },
  });
  try {
    const res = runPush(fx, [
      "--dry-run",
      "--",
      "resources/test-new-file-gate/assistants/foo.md",
    ]);
    // The orphan is `tools/bar` but the user only pushed `assistants/foo` —
    // the gate must scope to the file set and not block.
    assert.doesNotMatch(
      res.stderr,
      /Push refused/,
      `gate should not fire for orphan outside selection; stderr=${res.stderr}`,
    );
  } finally {
    fx.cleanup();
  }
});
