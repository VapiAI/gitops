import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPronunciationDictDrop,
  hashPayload,
  upsertState,
} from "../src/state-serialize.ts";
import type { ResourceState } from "../src/types.ts";

// Stack G — drift unit tests.
// `checkDriftForUpdate` itself fires GET against the Vapi platform; a unit
// test for that path requires either a fake fetch or live API access. Manual
// integration coverage is the right place. Here we cover the
// pronunciation-dict-drop detector, which is pure-data.
//
// ─────────────────────────────────────────────────────────────────────────────
// Section H (added 2026-05-19): three-way drift-direction classifier coverage.
//
// Plan: ~/.pi/plans/pull-drift-direction-classifier-2026-05-19T2235Z.md
//
// In-scope for this test file:
//   1. `classifyDrift` truth table — every cell of the 3-hash decision matrix,
//      including the both-diverged edge where local == platform but both
//      diverge from the baseline.
//   2. `formatDriftLabel` — non-empty + operator-actionable phrasing per
//      direction. The exact wording is the implementer's choice; the contract
//      is that the operator can read the label and know which command to run.
//   3. `checkDriftForUpdate` push-side direction-label surfacing — light
//      coverage via global.fetch stub (no engine refactor needed).
//
// Out of scope here (validated via the plan's smoke test, NOT by these
// adjacent specs):
//   - `pull.ts` direction labeling at the ✏️ log sites — requires a fixture
//     filesystem AND a mock of the platform list-fetch pipeline; properly an
//     integration test, not a unit test.
//   - `pull.ts --resolve=ours|theirs|fail` gate behavior — same reason
//     (state mutation + filesystem writes + argv parsing all interact).
//   - End-of-pull drift summary block — cosmetic; the truth is in the
//     direction counts, which `classifyDrift` already pins down.
//   - `--force` warning + 2s grace period — pure UX; covered by the smoke test.
//   - `audit.ts` default-on content-drift — same shape as the existing
//     audit.test.ts fixtures BUT also needs a platform-fetch stub; left to a
//     follow-up that extends audit.test.ts's DI surface to inject a
//     platform-payload-fetcher (parallel to the existing `stateLoader` /
//     `listLocalIds` injection points).
//   - `AGENTS.md` doc commit — no code, nothing to test.
// ─────────────────────────────────────────────────────────────────────────────
//
// `src/drift.ts` transits `src/config.ts`, which asserts argv[2] and
// VAPI_TOKEN at module load. Prime both BEFORE the dynamic import — same
// trick as tests/audit.test.ts / tests/validate.test.ts. The static imports
// above (state-serialize.ts) do NOT transit config.ts, so they remain.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const driftModule = await import("../src/drift.ts");
const { classifyDrift, formatDriftLabel, checkDriftForUpdate } = driftModule as {
  classifyDrift?: (input: {
    localHash: string;
    lastPulledHash?: string;
    platformHash: string;
  }) => string;
  formatDriftLabel?: (direction: string) => string;
  checkDriftForUpdate?: (options: {
    endpoint: string;
    resourceLabel: string;
    resourceId: string;
    state: { uuid: string; lastPulledHash?: string };
    overwrite: boolean;
  }) => Promise<{
    ok: boolean;
    reason: string;
    message?: string;
    platformHash?: string;
  }>;
};

test("checkPronunciationDictDrop: warns when prior had ID and new lost it", () => {
  const prior = {
    voice: { provider: "cartesia", pronunciationDictId: "pdict_X" },
  };
  const current = { voice: { provider: "cartesia" } };
  const msg = checkPronunciationDictDrop("agent-foo", prior, current);
  assert.ok(msg, "expected a warning message");
  assert.match(msg!, /pdict_X/);
  assert.match(msg!, /agent-foo/);
});

test("checkPronunciationDictDrop: silent when both have it", () => {
  const prior = { voice: { pronunciationDictId: "pdict_X" } };
  const current = { voice: { pronunciationDictId: "pdict_X" } };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

test("checkPronunciationDictDrop: silent when neither has it", () => {
  const prior = { voice: {} };
  const current = { voice: {} };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

test("checkPronunciationDictDrop: silent when prior didn't have it (additive change)", () => {
  const prior = { voice: {} };
  const current = { voice: { pronunciationDictId: "pdict_X" } };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11labs `pronunciationDictionaryLocators` array shape (Vapi-documented).
// https://docs.vapi.ai/assistants/pronunciation-dictionaries
// ─────────────────────────────────────────────────────────────────────────────

test("checkPronunciationDictDrop: warns when 11labs locator array clears (1 → 0)", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        {
          pronunciationDictionaryId: "rjshI10OgN6KxqtJBqO4",
          versionId: "xJl0ImZzi3cYp61T0UQG",
        },
      ],
    },
  };
  const current = {
    voice: { provider: "11labs", pronunciationDictionaryLocators: [] },
  };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message");
  assert.match(msg!, /pronunciationDictionaryLocators/);
  assert.match(msg!, /1 entry\/entries .* to 0/);
  assert.match(msg!, /eleven-agent/);
});

test("checkPronunciationDictDrop: warns when 11labs locator array shrinks (2 → 1)", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
        { pronunciationDictionaryId: "id_b", versionId: "v_b" },
      ],
    },
  };
  const current = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message for partial drop");
  assert.match(msg!, /2 entry\/entries .* to 1/);
});

test("checkPronunciationDictDrop: warns when 11labs locator array goes missing entirely", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = { voice: { provider: "11labs" } };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message when array missing");
  assert.match(msg!, /1 entry\/entries .* to 0/);
});

test("checkPronunciationDictDrop: silent when 11labs locator array is unchanged", () => {
  const locators = [{ pronunciationDictionaryId: "id_a", versionId: "v_a" }];
  const prior = { voice: { pronunciationDictionaryLocators: locators } };
  const current = { voice: { pronunciationDictionaryLocators: [...locators] } };
  assert.equal(
    checkPronunciationDictDrop("eleven-agent", prior, current),
    null,
  );
});

test("checkPronunciationDictDrop: silent when 11labs locator array grows (additive)", () => {
  const prior = {
    voice: {
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = {
    voice: {
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
        { pronunciationDictionaryId: "id_b", versionId: "v_b" },
      ],
    },
  };
  assert.equal(
    checkPronunciationDictDrop("eleven-agent", prior, current),
    null,
  );
});

test("checkPronunciationDictDrop: detects either shape when prior has both somehow (Cartesia wins; 11labs check still runs)", () => {
  // Defensive — a payload that happens to carry both shapes (shouldn't
  // happen in practice but the function should not crash). The Cartesia
  // single-id check runs first; if it fires we return that message. If it
  // doesn't (because new still has Cartesia id), the 11labs check runs.
  const prior = {
    voice: {
      pronunciationDictId: "pdict_X",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = {
    voice: {
      pronunciationDictId: "pdict_X",
      pronunciationDictionaryLocators: [],
    },
  };
  const msg = checkPronunciationDictDrop("hybrid-agent", prior, current);
  assert.ok(msg, "expected a warning when locators dropped");
  assert.match(msg!, /pronunciationDictionaryLocators/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Section H — `classifyDrift` truth table.
//
// Three hashes → five direction outcomes. Each test exercises one row of the
// decision matrix described in the plan. Where the plan is silent, the test
// pins down the contract.
// ═════════════════════════════════════════════════════════════════════════════

// Fixture hashes — 16 hex chars so they are visually distinguishable in
// failure output. Real hashes are sha256 (64 hex) but the helper is
// content-agnostic; any string equality / inequality drives the classifier.
const H_BASE = "baseline00000000";
const H_LOCAL = "localXXXXXXXXXXX";
const H_PLATFORM = "platformYYYYYYYY";
const H_CONVERGED = "converged0000000"; // local == platform, ≠ baseline

test("classifyDrift: clean — local == lastPulled == platform", () => {
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_BASE,
    lastPulledHash: H_BASE,
    platformHash: H_BASE,
  });
  assert.equal(direction, "clean");
});

test("classifyDrift: dashboard-ahead — local == lastPulled, platform diverged", () => {
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_BASE,
    lastPulledHash: H_BASE,
    platformHash: H_PLATFORM,
  });
  assert.equal(direction, "dashboard-ahead");
});

test("classifyDrift: local-ahead — local diverged, platform == lastPulled", () => {
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_LOCAL,
    lastPulledHash: H_BASE,
    platformHash: H_BASE,
  });
  assert.equal(direction, "local-ahead");
});

test("classifyDrift: both-diverged — local, platform, lastPulled all differ", () => {
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_LOCAL,
    lastPulledHash: H_BASE,
    platformHash: H_PLATFORM,
  });
  assert.equal(direction, "both-diverged");
});

test("classifyDrift: both-diverged edge — local == platform but both diverged from baseline", () => {
  // Real edge: two independent edits happen to converge on the same content
  // (e.g. both sides corrected the same typo). The classifier must still
  // report both-diverged — the baseline is what the operator pulled, and
  // BOTH sides have moved past it. Treating this as `clean` would lose the
  // signal that the operator's state pointer is stale.
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_CONVERGED,
    lastPulledHash: H_BASE,
    platformHash: H_CONVERGED,
  });
  assert.equal(direction, "both-diverged");
});

test("classifyDrift: no-baseline — lastPulledHash is undefined", () => {
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_LOCAL,
    lastPulledHash: undefined,
    platformHash: H_PLATFORM,
  });
  assert.equal(direction, "no-baseline");
});

test("classifyDrift: no-baseline — lastPulledHash is empty string (pinned: treated as no baseline)", () => {
  // Contract decision: the plan's reference implementation uses
  // `if (!lastPulledHash) return 'no-baseline'`. An empty string is falsy in
  // JS and is not a meaningful sha256 hash, so it is treated the same as
  // `undefined`. If a future implementer wants to distinguish "" from
  // `undefined`, this test will fail and the contract should be revisited
  // deliberately (not silently).
  assert.ok(classifyDrift, "classifyDrift export missing from src/drift.ts");
  const direction = classifyDrift!({
    localHash: H_LOCAL,
    lastPulledHash: "",
    platformHash: H_PLATFORM,
  });
  assert.equal(direction, "no-baseline");
});

// ═════════════════════════════════════════════════════════════════════════════
// Section H — `formatDriftLabel` operator-actionable phrasing.
//
// We do NOT pin the exact wording of each label (the implementer can word
// them naturally) — we pin the *operator action* each label must surface:
// dashboard-ahead points at `pull` (or the override path), local-ahead points
// at `push`, both-diverged points at the `--resolve` gate, no-baseline
// points at bootstrap, clean is silent. If a label loses its actionable
// keyword, the operator can't follow it without reading the source.
// ═════════════════════════════════════════════════════════════════════════════

const DIRECTIONS = [
  "clean",
  "dashboard-ahead",
  "local-ahead",
  "both-diverged",
  "no-baseline",
] as const;

test("formatDriftLabel: every direction returns a non-empty string", () => {
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  for (const direction of DIRECTIONS) {
    const label = formatDriftLabel!(direction);
    assert.equal(typeof label, "string", `${direction} label is not a string`);
    assert.ok(label.length > 0, `${direction} label is empty`);
  }
});

test("formatDriftLabel: dashboard-ahead label points operator at pull / overwrite", () => {
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  const label = formatDriftLabel!("dashboard-ahead");
  // Should mention at least one of the actionable verbs/flags so the
  // operator can act on the label without reading the source.
  assert.match(
    label,
    /pull|overwrite|--force/i,
    `dashboard-ahead label should mention pull/overwrite/--force, got: ${label}`,
  );
});

test("formatDriftLabel: local-ahead label points operator at push", () => {
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  const label = formatDriftLabel!("local-ahead");
  assert.match(
    label,
    /push/i,
    `local-ahead label should mention push, got: ${label}`,
  );
});

test("formatDriftLabel: both-diverged label points operator at --resolve or names the conflict", () => {
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  const label = formatDriftLabel!("both-diverged");
  assert.match(
    label,
    /--resolve|conflict/i,
    `both-diverged label should mention --resolve or conflict, got: ${label}`,
  );
});

test("formatDriftLabel: no-baseline label points operator at bootstrap / pull / baseline", () => {
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  const label = formatDriftLabel!("no-baseline");
  assert.match(
    label,
    /bootstrap|pull|baseline/i,
    `no-baseline label should mention bootstrap/pull/baseline, got: ${label}`,
  );
});

test("formatDriftLabel: clean label is benign (no error/warning markers)", () => {
  // The clean label should not include error symbols (❌) or warning
  // symbols (⚠️) — these labels are appended to per-resource log lines and
  // a clean line with a warning glyph is misleading.
  assert.ok(
    formatDriftLabel,
    "formatDriftLabel export missing from src/drift.ts",
  );
  const label = formatDriftLabel!("clean");
  assert.doesNotMatch(
    label,
    /❌|⚠/u,
    `clean label should not carry error/warning glyphs, got: ${label}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Section H — `checkDriftForUpdate` direction-aware messaging (light cov).
//
// Per the plan (item 6), the push-side drift-blocked message should include
// a bracketed direction label (e.g. `[dashboard-ahead]`). We stub global
// fetch — the function calls `fetch(`${VAPI_BASE_URL}${endpoint}`, ...)`
// and parses the JSON — so no engine refactor or live API is needed.
//
// Caveat for the implementer: `checkDriftForUpdate` currently only has
// `platformHash` and `state.lastPulledHash` in scope. `classifyDrift`
// requires `localHash` too. Three paths the implementer can take:
//   (a) thread `localHash` through `checkDriftForUpdate`'s options (caller
//       change), then call `classifyDrift`;
//   (b) read the local file inside `checkDriftForUpdate` and hash it
//       (adds I/O but keeps the API the same);
//   (c) hardcode `[dashboard-ahead]` for the push case (push-side drift IS
//       always `dashboard-ahead` relative to baseline when local hasn't
//       moved; it becomes `both-diverged` if local also changed, which the
//       push-side caller may or may not care about).
//
// This test does NOT pin which approach is taken — it only asserts that
// SOME bracketed direction label appears in the drift-blocked message. If
// the implementer picks (a) or (b) and the regex resolves to a specific
// direction, that is also fine.
// ═════════════════════════════════════════════════════════════════════════════

function makeFetchStub(remotePayload: unknown, status = 200) {
  // Minimal Response-like shape for what checkDriftForUpdate needs:
  //   `.status`, `.ok`, and `.json()` (only called when 2xx).
  return async (_input: unknown, _init?: unknown): Promise<Response> => {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => remotePayload,
      text: async () => JSON.stringify(remotePayload),
    } as unknown as Response;
  };
}

test("checkDriftForUpdate: drift-blocked message includes a bracketed direction label", async () => {
  assert.ok(
    checkDriftForUpdate,
    "checkDriftForUpdate export missing from src/drift.ts",
  );

  // Build a remote payload whose hash we can predict.
  // `stripServerFields` (private) removes id/orgId/etc — our fixture has
  // none of them, so hashPayload(remote) == platformHash inside the engine.
  const remote = { name: "intake-bot", systemPrompt: "hello" };
  const platformHash = hashPayload(remote);
  // Different baseline hash → drift detected.
  const lastPulledHash = `${platformHash}-stale`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(remote) as typeof globalThis.fetch;
  try {
    const result = await checkDriftForUpdate!({
      endpoint: "/assistant/test-uuid",
      resourceLabel: "assistants",
      resourceId: "intake-bot",
      state: { uuid: "test-uuid", lastPulledHash },
      overwrite: false,
    });
    assert.equal(result.ok, false, "drift should be blocked");
    assert.equal(result.reason, "drift-blocked");
    assert.ok(result.message, "drift-blocked must carry a message");
    assert.match(
      result.message!,
      /\[(dashboard-ahead|local-ahead|both-diverged|no-baseline|clean)\]/,
      `drift-blocked message should contain a bracketed direction label, got: ${result.message}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkDriftForUpdate: no-baseline path is unaffected by the new direction label", async () => {
  // Regression guard — when there's no lastPulledHash, the function returns
  // early without fetching. The new direction-label work should not break
  // the existing no-baseline contract.
  assert.ok(
    checkDriftForUpdate,
    "checkDriftForUpdate export missing from src/drift.ts",
  );

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called when lastPulledHash absent");
  }) as typeof globalThis.fetch;
  try {
    const result = await checkDriftForUpdate!({
      endpoint: "/assistant/test-uuid",
      resourceLabel: "assistants",
      resourceId: "new-bot",
      state: { uuid: "test-uuid" }, // no lastPulledHash
      overwrite: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no-baseline");
    assert.equal(fetchCalled, false, "fetch must not fire without a baseline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Section I (added 2026-05-20): canonicalizeForHash invariants.
//
// Pins down the symmetric hash basis used by ALL drift hash sites
// (pull-write, pull-classifier, audit, resolve-both). Any divergence in the
// pipeline (missing _platformDefault marker, different mutation order, etc.)
// makes lastPulledHash disagree with the next classifyDrift's localHash and
// produces permanent phantom `both-diverged` reports that only --overwrite
// can clear. This is the root cause of the simulation-suite drift in
// improvements.md and the `_platformDefault` asymmetry surfaced in code
// review on the drift-direction-classifier PR.
// ─────────────────────────────────────────────────────────────────────────────

const pullModule = await import("../src/pull.ts");
const { canonicalizeForHash } = pullModule as {
  canonicalizeForHash?: (
    resource: { id: string; orgId?: string | null; [key: string]: unknown },
    state: Record<string, Record<string, { uuid: string }>>,
    credReverse: Map<string, string>,
  ) => Record<string, unknown>;
};

const emptyState = {
  tools: {},
  structuredOutputs: {},
  assistants: {},
  squads: {},
  personalities: {},
  scenarios: {},
  simulations: {},
  simulationSuites: {},
  evals: {},
} as unknown as Parameters<NonNullable<typeof canonicalizeForHash>>[1];

const emptyCredReverse = new Map<string, string>();

test("canonicalizeForHash: applies _platformDefault when orgId === null", () => {
  assert.ok(canonicalizeForHash, "canonicalizeForHash export missing from src/pull.ts");
  const result = canonicalizeForHash!(
    { id: "abc", orgId: null, name: "Default Voice" },
    emptyState,
    emptyCredReverse,
  );
  assert.equal(result._platformDefault, true, "_platformDefault marker must be injected for null orgId");
});

test("canonicalizeForHash: applies _platformDefault when orgId is undefined", () => {
  assert.ok(canonicalizeForHash);
  const result = canonicalizeForHash!(
    { id: "abc", name: "Default Voice" },
    emptyState,
    emptyCredReverse,
  );
  assert.equal(result._platformDefault, true);
});

test("canonicalizeForHash: does NOT apply _platformDefault when orgId is a real org uuid", () => {
  assert.ok(canonicalizeForHash);
  const result = canonicalizeForHash!(
    { id: "abc", orgId: "org-12345", name: "Customer Resource" },
    emptyState,
    emptyCredReverse,
  );
  assert.equal(
    result._platformDefault,
    undefined,
    "customer-owned resources must NOT receive the _platformDefault marker",
  );
});

test("canonicalizeForHash: deterministic — same input produces same hash", () => {
  assert.ok(canonicalizeForHash);
  const input = {
    id: "abc",
    orgId: "org-12345",
    name: "Foo",
    voice: { provider: "11labs", voiceId: "v1" },
    model: { provider: "openai", model: "gpt-4" },
  };
  const a = hashPayload(canonicalizeForHash!(input, emptyState, emptyCredReverse));
  const b = hashPayload(canonicalizeForHash!(input, emptyState, emptyCredReverse));
  assert.equal(a, b, "canonicalizeForHash must be deterministic");
});

test("canonicalizeForHash: platform-default vs customer-owned produce DIFFERENT hashes for otherwise-identical content", () => {
  // This is the M1 regression test from the code review. Pre-fix, the
  // classifier+audit hash sites omitted the _platformDefault marker while
  // pull-write injected it before hashing — a 1-bit difference that made
  // every platform-default resource look like permanent dashboard-ahead.
  // Post-fix, BOTH sites apply the marker via this helper.
  assert.ok(canonicalizeForHash);
  const platformDefaultHash = hashPayload(
    canonicalizeForHash!(
      { id: "abc", orgId: null, name: "Foo" },
      emptyState,
      emptyCredReverse,
    ),
  );
  const customerOwnedHash = hashPayload(
    canonicalizeForHash!(
      { id: "abc", orgId: "org-12345", name: "Foo" },
      emptyState,
      emptyCredReverse,
    ),
  );
  assert.notEqual(
    platformDefaultHash,
    customerOwnedHash,
    "platform-default marker must produce a distinct hash from same content without it",
  );
});

test("canonicalizeForHash: strips server-managed fields (id, orgId, createdAt, updatedAt)", () => {
  assert.ok(canonicalizeForHash);
  const result = canonicalizeForHash!(
    {
      id: "abc",
      orgId: "org-12345",
      createdAt: "2026-01-01",
      updatedAt: "2026-05-19",
      name: "Foo",
    },
    emptyState,
    emptyCredReverse,
  );
  assert.equal(result.id, undefined);
  assert.equal(result.orgId, undefined);
  assert.equal(result.createdAt, undefined);
  assert.equal(result.updatedAt, undefined);
  assert.equal(result.name, "Foo");
});

// ─────────────────────────────────────────────────────────────────────────────
// Section J (added 2026-05-20): classifier short-circuit state preservation.
//
// Regression coverage for a bug introduced by the drift-direction-classifier
// PR (#38) and caught by the E2E both-diverged smoke test on mudflap-iform-test:
//
// pull.ts `newStateSection` starts EMPTY for a full pull (line 769). The
// classifier short-circuit branches (`dashboard-ahead`, `local-ahead`,
// `both-diverged`) previously called `upsertState(newStateSection, id, { uuid })`
// against this empty section — dropping `lastPulledHash` and `lastPulledAt`
// from state. The `both-diverged` branch was worse: it called no upsert at all,
// so the entry vanished entirely.
//
// After the per-type loop, `state[type] = newStateSection` (line 1040)
// persists the loss. The operator's NEXT pull sees no baseline → `no-baseline`
// classification → the classifier can never detect drift on this resource
// again until something writes a fresh baseline.
//
// These tests pin the upsertState patch SHAPE that the fix uses, plus the
// bare-{ uuid }-only failure mode so a future contributor can't silently
// revert without breaking a test.
// ─────────────────────────────────────────────────────────────────────────────

test("classifier short-circuit: full patch (uuid + lastPulledHash + lastPulledAt) survives empty newStateSection", () => {
  const newStateSection: Record<string, ResourceState> = {};
  upsertState(newStateSection, "r1", {
    uuid: "u1",
    lastPulledHash: "h-baseline",
    lastPulledAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(newStateSection.r1?.uuid, "u1");
  assert.equal(
    newStateSection.r1?.lastPulledHash,
    "h-baseline",
    "dashboard-ahead / local-ahead branches MUST pass lastPulledHash through; otherwise next pull sees no-baseline",
  );
  assert.equal(newStateSection.r1?.lastPulledAt, "2026-01-01T00:00:00.000Z");
});

test("classifier short-circuit: bare { uuid }-only patch DROPS lastPulledHash on empty section (regression hazard)", () => {
  // Pins the failure mode — if a future contributor reverts to passing only
  // { uuid: resource.id } to upsertState (the shape the original PR shipped
  // with), this test catches it. The fix is in the CALLER (pull.ts classifier
  // branches); upsertState's merge semantics are correct as-is.
  const newStateSection: Record<string, ResourceState> = {};
  upsertState(newStateSection, "r1", { uuid: "u1" });
  assert.equal(newStateSection.r1?.uuid, "u1");
  assert.equal(
    newStateSection.r1?.lastPulledHash,
    undefined,
    "bare patch must NOT magically materialize lastPulledHash — fix lives in the caller's patch",
  );
});

test("classifier both-diverged: direct assignment from existing state preserves all fields verbatim", () => {
  // both-diverged path does NOT call upsertState (resolveBothDivergedResources
  // takes over post-loop, with per-resolve-mode state mutation). Without the
  // preservation assignment in the branch, the entry vanishes from
  // newStateSection. With it, the operator can re-run pull with --resolve and
  // still have the baseline to compare against.
  const existingState: Record<string, ResourceState> = {
    r1: {
      uuid: "u1",
      lastPulledHash: "h-baseline",
      lastPulledAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const newStateSection: Record<string, ResourceState> = {};
  const existing = existingState.r1;
  if (existing) {
    newStateSection.r1 = existing;
  }
  assert.deepEqual(
    newStateSection.r1,
    existing,
    "both-diverged branch MUST preserve the existing entry verbatim; saveState writes newStateSection over state[type] at end of loop",
  );
});

test("upsertState merge: pre-existing entry + new patch produces union, NOT replacement", () => {
  // Sanity-check that upsertState's documented merge semantic still holds.
  // If a future refactor switches to replacement semantics, the classifier
  // short-circuits would lose lastPulledHash on subsequent calls.
  const section: Record<string, ResourceState> = {
    r1: {
      uuid: "u1",
      lastPulledHash: "h-old",
      lastPulledAt: "2026-01-01T00:00:00.000Z",
    },
  };
  upsertState(section, "r1", { uuid: "u1", lastPulledAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(section.r1?.lastPulledHash, "h-old", "upsertState must preserve fields not in the patch");
  assert.equal(section.r1?.lastPulledAt, "2026-02-01T00:00:00.000Z", "upsertState must overwrite fields in the patch");
});
