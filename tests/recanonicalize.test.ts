import assert from "node:assert/strict";
import test from "node:test";

// recanonicalize.ts → config.ts: config.ts asserts argv[2] / VAPI_TOKEN at
// module load. Prime both before importing the module under test. Mirrors
// the pattern in tests/new-file-gate.test.ts.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { recanonicalizeStateKeys, formatRecanonicalizeReport } = await import(
  "../src/recanonicalize.ts"
);

import type { ResourceState, ResourceType, StateFile } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — DI-style, filesystem-free. The module exposes a `fileExists`
// seam; tests pass a stub keyed on the relative paths the production code
// would have probed.
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

function makeFileExists(paths: Set<string>) {
  return (relativePath: string): boolean => paths.has(relativePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — the recurring duplicate scenario the fix targets.
// ─────────────────────────────────────────────────────────────────────────────

test("recanonicalize: collapses UUID-suffixed key to canonical when local file present and canonical slot empty (the duplicate-generation root cause)", () => {
  // State has `foo-vmd-004c5108` (rekey'd by a prior pull during a name
  // collision). The conflicting twin has since been deleted on the
  // dashboard. Local has only `squads/foo-vmd.md`. Canonical slot in state
  // is empty. We should collapse.
  const state = makeStateFile({
    squads: {
      "foo-vmd-004c5108": makeStateEntry(
        "004c5108-aaaa-bbbb-cccc-dddddddddddd",
      ),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["squads/foo-vmd.yml"])),
  });
  assert.equal(report.rekeys.length, 1);
  assert.equal(report.rekeys[0]!.fromKey, "foo-vmd-004c5108");
  assert.equal(report.rekeys[0]!.toKey, "foo-vmd");
  assert.equal(report.conflicts.length, 0);
  assert.deepEqual(Object.keys(state.squads), ["foo-vmd"]);
  assert.equal(
    state.squads["foo-vmd"]!.uuid,
    "004c5108-aaaa-bbbb-cccc-dddddddddddd",
  );
});

test("recanonicalize: applies uniformly across every resource type", () => {
  // One stale UUID-suffixed entry per type. All should collapse — the pass
  // is type-agnostic. Folder paths come from FOLDER_MAP so the fileExists
  // stub keys must match those folders.
  const state = makeStateFile({
    tools: {
      "t-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
    structuredOutputs: {
      "s-bbbbbbbb": makeStateEntry("bbbbbbbb-0000-0000-0000-000000000000"),
    },
    assistants: {
      "a-cccccccc": makeStateEntry("cccccccc-0000-0000-0000-000000000000"),
    },
    squads: {
      "q-dddddddd": makeStateEntry("dddddddd-0000-0000-0000-000000000000"),
    },
    personalities: {
      "p-eeeeeeee": makeStateEntry("eeeeeeee-0000-0000-0000-000000000000"),
    },
    scenarios: {
      "sc-ffffffff": makeStateEntry("ffffffff-0000-0000-0000-000000000000"),
    },
    simulations: {
      "sim-12345678": makeStateEntry("12345678-0000-0000-0000-000000000000"),
    },
    simulationSuites: {
      "suite-87654321": makeStateEntry("87654321-0000-0000-0000-000000000000"),
    },
    evals: {
      "e-abcdef01": makeStateEntry("abcdef01-0000-0000-0000-000000000000"),
    },
  });
  const fileExists = makeFileExists(
    new Set([
      "tools/t.yml",
      "structuredOutputs/s.yml",
      "assistants/a.md",
      "squads/q.yml",
      "simulations/personalities/p.yml",
      "simulations/scenarios/sc.yml",
      "simulations/tests/sim.yml",
      "simulations/suites/suite.yml",
      "evals/e.yml",
    ]),
  );
  const report = recanonicalizeStateKeys({ state, fileExists });
  assert.equal(report.rekeys.length, 9);
  assert.equal(report.conflicts.length, 0);
  // Each section now keyed canonically.
  assert.deepEqual(Object.keys(state.tools), ["t"]);
  assert.deepEqual(Object.keys(state.structuredOutputs), ["s"]);
  assert.deepEqual(Object.keys(state.assistants), ["a"]);
  assert.deepEqual(Object.keys(state.squads), ["q"]);
  assert.deepEqual(Object.keys(state.personalities), ["p"]);
  assert.deepEqual(Object.keys(state.scenarios), ["sc"]);
  assert.deepEqual(Object.keys(state.simulations), ["sim"]);
  assert.deepEqual(Object.keys(state.simulationSuites), ["suite"]);
  assert.deepEqual(Object.keys(state.evals), ["e"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety preconditions — each one MUST block the rekey.
// ─────────────────────────────────────────────────────────────────────────────

test("recanonicalize: refuses when UUID suffix doesn't match entry's UUID prefix (user-named resource that coincidentally ends in -<8hex>)", () => {
  // The key looks suffixed but the captured 8 hex chars (`deadbeef`) are
  // NOT the prefix of the entry's UUID (`004c5108...`). This is a
  // user-given name like "my-tool-deadbeef" — DO NOT touch it.
  const state = makeStateFile({
    tools: {
      "my-tool-deadbeef": makeStateEntry(
        "004c5108-aaaa-bbbb-cccc-dddddddddddd",
      ),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["tools/my-tool.yml"])),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 0);
  assert.deepEqual(Object.keys(state.tools), ["my-tool-deadbeef"]);
});

test("recanonicalize: refuses when canonical slug is claimed by a DIFFERENT UUID (legitimate same-name twin)", () => {
  // Both `foo` (uuid_A, live) and `foo-bbbbbbbb` (uuid_B, live twin) exist
  // in state — the dashboard genuinely has two resources sharing a name.
  // Collapsing `foo-bbbbbbbb` onto `foo` would clobber uuid_A.
  const state = makeStateFile({
    squads: {
      foo: makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
      "foo-bbbbbbbb": makeStateEntry("bbbbbbbb-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["squads/foo.yml"])),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 1);
  assert.equal(
    report.conflicts[0]!.reason,
    "canonical-slug-claimed-by-different-uuid",
  );
  // State unchanged.
  assert.deepEqual(Object.keys(state.squads).sort(), ["foo", "foo-bbbbbbbb"]);
});

test("recanonicalize: AUTO-RESOLVES when canonical slug claims the SAME UUID (duplicate alias) — the H1 self-inflicted shape", () => {
  // After a scoped push that pre-dated the touched-aware fix, state on
  // disk can end up with both `foo` and `foo-aaaaaaaa` pointing at the
  // SAME uuid_A. This is not a twin — it's one resource aliased twice.
  // Safe action: drop the UUID-suffixed key (canonical wins). Reported
  // as a rekey, not a conflict.
  const state = makeStateFile({
    squads: {
      foo: {
        uuid: "aaaaaaaa-0000-0000-0000-000000000000",
        lastPulledHash: "canonical-hash",
      },
      "foo-aaaaaaaa": {
        uuid: "aaaaaaaa-0000-0000-0000-000000000000",
        lastPulledHash: "stale-hash",
      },
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    // No fileExists probing needed for the auto-resolve branch (skipped
    // before files are checked). Pass an empty set to prove that.
    fileExists: makeFileExists(new Set()),
  });
  assert.equal(report.rekeys.length, 1);
  assert.equal(report.rekeys[0]!.fromKey, "foo-aaaaaaaa");
  assert.equal(report.rekeys[0]!.toKey, "foo");
  assert.equal(report.conflicts.length, 0);
  // Canonical entry survives unchanged (its metadata is presumed
  // authoritative — we discard the stale alias, not merge metadata).
  assert.deepEqual(Object.keys(state.squads), ["foo"]);
  assert.equal(state.squads["foo"]!.lastPulledHash, "canonical-hash");
});

test("recanonicalize: refuses when canonical local file is missing (would create phantom state mapping)", () => {
  const state = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  // No local files at all.
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set()),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0]!.reason, "canonical-local-file-missing");
  assert.deepEqual(Object.keys(state.squads), ["foo-aaaaaaaa"]);
});

test("recanonicalize: respects all loader-recognized extensions (.yml/.yaml/.ts/.md) for precondition 4", () => {
  // VALID_EXTENSIONS in src/resources.ts includes `.ts` (TypeScript
  // resources via dynamic import). Without importing the canonical
  // list, precondition 4 would mis-report a `.ts`-authored canonical
  // file as missing. Regression guard for the should-fix surfaced in
  // post-merge review.
  for (const ext of [".yml", ".yaml", ".ts", ".md"]) {
    const state = makeStateFile({
      tools: {
        "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
      },
    });
    const report = recanonicalizeStateKeys({
      state,
      fileExists: makeFileExists(new Set([`tools/foo${ext}`])),
    });
    assert.equal(
      report.rekeys.length,
      1,
      `extension ${ext} should be recognized as a canonical file`,
    );
    assert.equal(report.conflicts.length, 0);
  }
});

test("recanonicalize: refuses when BOTH local files exist as `.ts` (precondition 5 covers every loader extension)", () => {
  // Direct regression guard for the data-loss shape: a `.ts`-authored
  // resource paired with a UUID-suffixed `.ts` twin must trigger the
  // "both files exist" conflict, not silently rekey.
  const state = makeStateFile({
    tools: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(
      new Set(["tools/foo.ts", "tools/foo-aaaaaaaa.ts"]),
    ),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0]!.reason, "both-local-files-exist");
});

test("recanonicalize: refuses when BOTH local files exist (would silently swap which file PATCHes which dashboard UUID)", () => {
  // The user has both `foo.yml` (original content) and `foo-aaaaaaaa.yml`
  // (the new twin's content) on disk. Rekeying state would make `foo.yml`
  // PATCH the wrong dashboard UUID. Refuse — operator must consolidate.
  const state = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(
      new Set(["squads/foo.yml", "squads/foo-aaaaaaaa.yml"]),
    ),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0]!.reason, "both-local-files-exist");
  assert.deepEqual(Object.keys(state.squads), ["foo-aaaaaaaa"]);
});

test("recanonicalize: ignores keys without UUID-suffix shape", () => {
  // Plain canonical keys are left alone.
  const state = makeStateFile({
    squads: {
      "ordinary-squad": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["squads/ordinary-squad.yml"])),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 0);
});

test("recanonicalize: handles UUID prefix match case-insensitively", () => {
  // UUIDs in state are typically lowercase, but be defensive.
  const state = makeStateFile({
    squads: {
      "foo-AAAAAAAA": makeStateEntry("AAAAAAAA-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["squads/foo.yml"])),
  });
  assert.equal(report.rekeys.length, 1);
  assert.equal(report.rekeys[0]!.toKey, "foo");
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-segment-before-uuid8 — the exact shape from the user's bug report.
// ─────────────────────────────────────────────────────────────────────────────

test("recanonicalize: collapses multi-dash base slug ('foo-vmd-<uuid8>') — the exact shape the orphan-gate pairing missed", () => {
  // From the live incident: state key was
  // `iform-voicemail-triage-squad-llm-only-vmd-004c5108`. The orphan-gate's
  // extractBaseSlug pairing failed because base = "...-vmd" not "...".
  // This pass operates on raw UUID-suffix shape, so it recanonicalizes
  // regardless of how many dash-segments precede the UUID8 — as long as
  // the canonical local file exists.
  const state = makeStateFile({
    squads: {
      "iform-voicemail-triage-squad-llm-only-vmd-004c5108": makeStateEntry(
        "004c5108-aaaa-bbbb-cccc-dddddddddddd",
      ),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(
      new Set(["squads/iform-voicemail-triage-squad-llm-only-vmd.yml"]),
    ),
  });
  assert.equal(report.rekeys.length, 1);
  assert.equal(
    report.rekeys[0]!.toKey,
    "iform-voicemail-triage-squad-llm-only-vmd",
  );
  assert.equal(report.conflicts.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoped-push integration — H1 regression guard
// ─────────────────────────────────────────────────────────────────────────────

test("recanonicalize: passing `touched` marks both old and new keys so mergeScoped flushes the rename (H1 regression)", async () => {
  // Without `touched`, mergeScoped re-overlays the on-disk stale key over
  // our in-memory rename, persisting a state file with BOTH keys pointing
  // at the same UUID. With `touched`, both the deleted UUID-suffixed key
  // (so the deletion flushes) and the new canonical key (so the new entry
  // is overlaid) are marked.
  const { mergeScoped } = await import("../src/state-merge.ts");
  const emptyTouched = () => ({
    tools: new Set<string>(),
    structuredOutputs: new Set<string>(),
    assistants: new Set<string>(),
    squads: new Set<string>(),
    personalities: new Set<string>(),
    scenarios: new Set<string>(),
    simulations: new Set<string>(),
    simulationSuites: new Set<string>(),
    evals: new Set<string>(),
    credentials: new Set<string>(),
  });

  const onDisk = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  // Simulate the push pipeline: load disk state → recanonicalize
  // (mutates in-place) → run apply phase → save via mergeScoped.
  const inMemory = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  const touched = emptyTouched();
  const report = recanonicalizeStateKeys({
    state: inMemory,
    fileExists: makeFileExists(new Set(["squads/foo.yml"])),
    touched,
  });
  assert.equal(report.rekeys.length, 1);
  assert.ok(touched.squads.has("foo-aaaaaaaa"));
  assert.ok(touched.squads.has("foo"));

  // The save-time merge must produce a state with ONLY the canonical key.
  const merged = mergeScoped(onDisk, inMemory, touched);
  assert.deepEqual(Object.keys(merged.squads), ["foo"]);
  assert.equal(
    merged.squads["foo"]!.uuid,
    "aaaaaaaa-0000-0000-0000-000000000000",
  );
});

test("recanonicalize: omitting `touched` is allowed (pull path saves wholesale)", () => {
  // Pull's saveState replaces the entire state file, so it doesn't need
  // `touched`. The pass should not throw when omitted.
  const state = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set(["squads/foo.yml"])),
  });
  assert.equal(report.rekeys.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-section safety
// ─────────────────────────────────────────────────────────────────────────────

test("recanonicalize: state.credentials section is never touched (credentials are name-keyed, not slug-uuid8)", () => {
  // Credentials use credential names as keys ('twilio-prod'), not the
  // engine-generated `<slug>-<uuid8>` shape. Even if a credential name
  // happened to look UUID-suffixed, recanonicalize must not touch the
  // credentials section because it's not in VALID_RESOURCE_TYPES.
  const state = makeStateFile({
    credentials: {
      "looks-suffixed-aaaaaaaa": makeStateEntry(
        "aaaaaaaa-0000-0000-0000-000000000000",
      ),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    fileExists: makeFileExists(new Set()),
  });
  assert.equal(report.rekeys.length, 0);
  assert.equal(report.conflicts.length, 0);
  assert.deepEqual(Object.keys(state.credentials), ["looks-suffixed-aaaaaaaa"]);
});

test("recanonicalize: `types` option restricts the pass to the named types only (typeFilter wiring)", () => {
  // Used by pull's typeFilter gate so a `--type squads` pull doesn't sweep
  // tools/assistants that this run didn't refresh.
  const state = makeStateFile({
    squads: {
      "foo-aaaaaaaa": makeStateEntry("aaaaaaaa-0000-0000-0000-000000000000"),
    },
    tools: {
      "bar-bbbbbbbb": makeStateEntry("bbbbbbbb-0000-0000-0000-000000000000"),
    },
  });
  const report = recanonicalizeStateKeys({
    state,
    types: ["squads"],
    fileExists: makeFileExists(new Set(["squads/foo.yml", "tools/bar.yml"])),
  });
  assert.equal(report.rekeys.length, 1);
  assert.equal(report.rekeys[0]!.type, "squads");
  // Tools section unchanged because it wasn't in `types`.
  assert.deepEqual(Object.keys(state.tools), ["bar-bbbbbbbb"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporter formatting
// ─────────────────────────────────────────────────────────────────────────────

test("formatRecanonicalizeReport: empty report renders empty string (callers can unconditionally log)", () => {
  const out = formatRecanonicalizeReport({ rekeys: [], conflicts: [] });
  assert.equal(out, "");
});

test("formatRecanonicalizeReport: rekeys section lists each from→to mapping", () => {
  const out = formatRecanonicalizeReport({
    rekeys: [
      {
        type: "squads" as ResourceType,
        fromKey: "foo-aaaaaaaa",
        toKey: "foo",
        uuid: "aaaaaaaa-0000-0000-0000-000000000000",
      },
    ],
    conflicts: [],
  });
  assert.match(out, /Recanonicalized 1 state key/);
  assert.match(out, /squads\/foo-aaaaaaaa → squads\/foo/);
});

test("formatRecanonicalizeReport: conflicts carry actionable per-reason hints", () => {
  const out = formatRecanonicalizeReport({
    rekeys: [],
    conflicts: [
      {
        type: "squads" as ResourceType,
        uuidSuffixedKey: "foo-aaaaaaaa",
        canonicalKey: "foo",
        reason: "both-local-files-exist",
        uuid: "aaaaaaaa-0000-0000-0000-000000000000",
      },
    ],
  });
  assert.match(out, /both .* exist/);
  assert.match(out, /pick one and delete the other/);
});
