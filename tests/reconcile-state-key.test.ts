import assert from "node:assert/strict";
import test from "node:test";

// reconcile-state-key.ts → state.ts → config.ts: config.ts asserts argv[2]
// and VAPI_TOKEN at module load. Prime both before dynamic import.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { reconcileStateKeyForResource } = await import(
  "../src/reconcile-state-key.ts"
);

import type { RemoteResource } from "../src/dep-dedup.ts";
import type { TouchedSets } from "../src/state-merge.ts";
import type {
  ResourceFile,
  ResourceState,
  ResourceType,
  StateFile,
} from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — every scenario is run twice (tools + structuredOutputs)
// to prove the helper is genuinely uniform. Each scenario builds the inputs
// with the helpers below, runs reconcileStateKeyForResource, then asserts on
// state mutations, touched sets, applied counters, and apply-fn invocations.
// ─────────────────────────────────────────────────────────────────────────────

type RType = "tools" | "structuredOutputs";

function emptyState(): StateFile {
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
  };
}

function emptyTouched(): TouchedSets {
  return {
    tools: new Set(),
    structuredOutputs: new Set(),
    assistants: new Set(),
    squads: new Set(),
    personalities: new Set(),
    scenarios: new Set(),
    simulations: new Set(),
    simulationSuites: new Set(),
    evals: new Set(),
    credentials: new Set(),
  };
}

function emptyApplied(): Record<ResourceType, number> {
  return {
    tools: 0,
    structuredOutputs: 0,
    assistants: 0,
    squads: 0,
    personalities: 0,
    scenarios: 0,
    simulations: 0,
    simulationSuites: 0,
    evals: 0,
  };
}

// Construct a payload whose canonical name slugifies to the same value for
// both types. Tools use `function.name`, SOs use top-level `name`.
function makePayload(rtype: RType, name: string): Record<string, unknown> {
  if (rtype === "tools") return { function: { name } };
  return { name };
}

function makeResource(
  rtype: RType,
  resourceId: string,
  name: string,
): ResourceFile<Record<string, unknown>> {
  return {
    resourceId,
    filePath: `/fake/${rtype}/${resourceId}.yml`,
    data: makePayload(rtype, name),
  };
}

interface Harness {
  state: StateFile;
  touched: TouchedSets;
  applied: Record<ResourceType, number>;
  autoApplied: Set<string>;
  autoAppliedList: ResourceFile<Record<string, unknown>>[];
  applyCalls: { resourceId: string }[];
}

function makeHarness(): Harness {
  return {
    state: emptyState(),
    touched: emptyTouched(),
    applied: emptyApplied(),
    autoApplied: new Set(),
    autoAppliedList: [],
    applyCalls: [],
  };
}

interface RunOpts {
  rtype: RType;
  resource: ResourceFile<Record<string, unknown>>;
  remoteList?: RemoteResource[];
  applyResult?: string | null;
  applyThrows?: Error;
  harness: Harness;
}

async function runReconcile(opts: RunOpts): Promise<void> {
  const { rtype, resource, remoteList = [], harness } = opts;
  await reconcileStateKeyForResource({
    resourceType: rtype,
    resource,
    state: harness.state,
    touched: harness.touched,
    applied: harness.applied,
    autoApplied: harness.autoApplied,
    pushToAutoAppliedList: (r) => harness.autoAppliedList.push(r),
    getRemoteList: async () => remoteList,
    applyFn: async (r, _state) => {
      harness.applyCalls.push({ resourceId: r.resourceId });
      if (opts.applyThrows) throw opts.applyThrows;
      // Default: return a UUID matching whatever state has under the
      // resourceId, falling back to a synthetic uuid. Mirrors what the real
      // applyTool would return after a successful PATCH/POST.
      if (opts.applyResult !== undefined) return opts.applyResult;
      const existing = harness.state[rtype][r.resourceId]?.uuid;
      return existing ?? `uuid-${r.resourceId}-created`;
    },
    vapiEnv: "test-env",
  });
}

const RTYPES: RType[] = ["tools", "structuredOutputs"];

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — State hit, SAME uuid, redundant alias.
// State already has `<slug>-<uuid8>` pointing at the same UUID we'd be
// adopting from the dashboard. The alias should be dropped and marked
// touched; the canonical key keeps the adopted UUID. applyFn is called.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 1: state hit, same uuid, redundant alias dropped`, async () => {
    const h = makeHarness();
    const sharedUuid = "00000000-0000-0000-0000-000000000aaa";
    // Pre-existing alias under a bootstrap-renamed key, same UUID.
    h.state[rtype]["my-resource-12345678"] = { uuid: sharedUuid };
    const resource = makeResource(rtype, "my-resource", "my-resource");

    await runReconcile({
      rtype,
      resource,
      remoteList: [{ id: sharedUuid, name: "my-resource" }],
      harness: h,
    });

    // Canonical key now points at the adopted UUID (with lastPushedHash
    // populated after applyFn success).
    assert.equal(h.state[rtype]["my-resource"]?.uuid, sharedUuid);
    assert.ok(h.state[rtype]["my-resource"]?.lastPushedHash);
    // Alias was deleted.
    assert.equal(h.state[rtype]["my-resource-12345678"], undefined);
    // Both keys marked touched: the deletion AND the new canonical entry.
    assert.ok(h.touched[rtype].has("my-resource-12345678"));
    assert.ok(h.touched[rtype].has("my-resource"));
    // applyFn was called once.
    assert.equal(h.applyCalls.length, 1);
    // applied counter incremented, bookkeeping populated.
    assert.equal(h.applied[rtype], 1);
    assert.equal(h.autoAppliedList.length, 1);
    assert.ok(h.autoApplied.has(`${rtype}:my-resource`));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — State hit, DIFFERENT uuid, base-slug match.
// State has `<slug>-<uuid8>` pointing at uuid A; local file wants the
// canonical slot. We adopt uuid A, rekey state to the canonical key, and
// delete the suffixed entry.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 2: state hit, different uuid, adopts and rekeys`, async () => {
    const h = makeHarness();
    const adoptedUuid = "11111111-1111-1111-1111-111111111aaa";
    h.state[rtype]["end-call-67aea057"] = { uuid: adoptedUuid };
    const resource = makeResource(rtype, "end-call", "end-call");

    await runReconcile({
      rtype,
      resource,
      remoteList: [{ id: adoptedUuid, name: "end-call" }],
      harness: h,
    });

    assert.equal(h.state[rtype]["end-call"]?.uuid, adoptedUuid);
    assert.equal(h.state[rtype]["end-call-67aea057"], undefined);
    assert.ok(h.touched[rtype].has("end-call-67aea057"));
    assert.ok(h.touched[rtype].has("end-call"));
    assert.equal(h.applyCalls.length, 1);
    assert.equal(h.applied[rtype], 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Dashboard hit only (state empty, dashboard has same-name).
// Pure dashboard adoption: no prior state entry, but a live dashboard
// resource shares the slugified name. We adopt and PATCH.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 3: dashboard hit only, adopts remote UUID`, async () => {
    const h = makeHarness();
    const dashboardUuid = "22222222-2222-2222-2222-222222222aaa";
    const resource = makeResource(rtype, "my-resource", "My Resource");

    await runReconcile({
      rtype,
      resource,
      remoteList: [{ id: dashboardUuid, name: "My Resource" }],
      harness: h,
    });

    assert.equal(h.state[rtype]["my-resource"]?.uuid, dashboardUuid);
    assert.equal(h.applyCalls.length, 1);
    assert.equal(h.applied[rtype], 1);
    assert.ok(h.autoApplied.has(`${rtype}:my-resource`));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Ambiguous dashboard match.
// Two dashboard resources share the slugified name. We pick the
// lex-smallest, surface ambiguous=true via the warning log, and DO NOT
// touch the other UUIDs' state entries.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 4: ambiguous dashboard match, picks lex-smallest`, async () => {
    const h = makeHarness();
    const uuidA = "11111111-1111-1111-1111-111111111aaa";
    const uuidB = "22222222-2222-2222-2222-222222222aaa";
    const resource = makeResource(rtype, "dup", "dup");

    // Capture warning output to confirm the ambiguous path fired.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      await runReconcile({
        rtype,
        resource,
        remoteList: [
          { id: uuidB, name: "dup" },
          { id: uuidA, name: "dup" },
        ],
        harness: h,
      });
    } finally {
      console.warn = origWarn;
    }

    // Lex-smallest wins → uuidA.
    assert.equal(h.state[rtype]["dup"]?.uuid, uuidA);
    assert.ok(warnings.some((w) => w.includes("Multiple")));
    assert.ok(warnings.some((w) => w.includes(uuidB)));
    assert.equal(h.applied[rtype], 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — No match, pure create path.
// State empty, dashboard empty. We fall through to the create branch:
// applyFn called, state populated with the fresh UUID, applied++,
// autoApplied set populated, bookkeeping array pushed.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 5: no match, pure create path`, async () => {
    const h = makeHarness();
    const resource = makeResource(rtype, "brand-new", "brand-new");

    await runReconcile({
      rtype,
      resource,
      applyResult: "33333333-3333-3333-3333-333333333aaa",
      harness: h,
    });

    assert.equal(
      h.state[rtype]["brand-new"]?.uuid,
      "33333333-3333-3333-3333-333333333aaa",
    );
    assert.ok(h.state[rtype]["brand-new"]?.lastPushedHash);
    assert.equal(h.applied[rtype], 1);
    assert.equal(h.autoAppliedList.length, 1);
    assert.ok(h.autoApplied.has(`${rtype}:brand-new`));
    assert.ok(h.touched[rtype].has("brand-new"));
    assert.equal(h.applyCalls.length, 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — Idempotency.
// The caller (push.ts ensureToolExists / ensureStructuredOutputExists) is
// responsible for the autoApplied short-circuit; this helper itself runs
// unconditionally. We verify the caller's guard works by simulating two
// invocations from a wrapper that mimics the production short-circuit.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 6: caller-side autoApplied short-circuit prevents 2nd reconcile`, async () => {
    const h = makeHarness();
    const resource = makeResource(rtype, "once", "once");
    const autoAppliedKey = `${rtype}:once`;

    async function callOnce(): Promise<void> {
      if (h.autoApplied.has(autoAppliedKey)) return;
      await runReconcile({
        rtype,
        resource,
        applyResult: "44444444-4444-4444-4444-444444444aaa",
        harness: h,
      });
    }

    await callOnce();
    await callOnce();

    // Second call must short-circuit before reconcile runs.
    assert.equal(h.applyCalls.length, 1);
    assert.equal(h.applied[rtype], 1);
    assert.equal(h.autoAppliedList.length, 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7 — applyFn returns null.
// Matches push.ts:998 / push.ts:1093 semantics exactly: autoApplied IS
// recorded, but state hash, applied counter, bookkeeping array, and
// touched set are NOT updated for the resourceId.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 7: applyFn returns null — autoApplied recorded, counter not incremented`, async () => {
    const h = makeHarness();
    const resource = makeResource(rtype, "skipme", "skipme");

    await runReconcile({
      rtype,
      resource,
      applyResult: null,
      harness: h,
    });

    // autoApplied IS recorded (even on null result) — this is the
    // "we tried; don't try again this run" signal.
    assert.ok(h.autoApplied.has(`${rtype}:skipme`));
    // State NOT updated with hash, applied NOT incremented, bookkeeping
    // NOT populated, touched NOT marked for the resourceId.
    assert.equal(h.state[rtype]["skipme"], undefined);
    assert.equal(h.applied[rtype], 0);
    assert.equal(h.autoAppliedList.length, 0);
    assert.equal(h.touched[rtype].has("skipme"), false);
    assert.equal(h.applyCalls.length, 1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8 — Orphan-deletion guard scope.
// Only state keys pointing at the ADOPTED UUID are dropped. Keys pointing
// at OTHER UUIDs (including those flagged as match.duplicateUuids — real
// on-dashboard duplicates left for `npm run cleanup`) MUST be left alone.
// ─────────────────────────────────────────────────────────────────────────────

for (const rtype of RTYPES) {
  test(`[${rtype}] scenario 8: orphan-deletion only drops keys pointing at the adopted uuid`, async () => {
    const h = makeHarness();
    const adoptedUuid = "11111111-1111-1111-1111-111111111aaa";
    const duplicateUuid = "22222222-2222-2222-2222-222222222aaa";

    // Three state entries:
    //   - alias A pointing at the adopted uuid → MUST be deleted
    //   - alias B pointing at the duplicate uuid → MUST be preserved
    //   - alias C pointing at an unrelated uuid → MUST be preserved
    h.state[rtype]["dup-aaaaaaaa"] = { uuid: adoptedUuid };
    h.state[rtype]["dup-bbbbbbbb"] = { uuid: duplicateUuid };
    h.state[rtype]["unrelated-cccccccc"] = {
      uuid: "99999999-9999-9999-9999-999999999aaa",
    };

    const resource = makeResource(rtype, "dup", "dup");

    // Capture warning so the ambiguous test path doesn't pollute output.
    const origWarn = console.warn;
    console.warn = (): void => {};
    try {
      await runReconcile({
        rtype,
        resource,
        remoteList: [
          { id: adoptedUuid, name: "dup" },
          { id: duplicateUuid, name: "dup" },
        ],
        harness: h,
      });
    } finally {
      console.warn = origWarn;
    }

    // Canonical key adopts the lex-smallest UUID.
    assert.equal(h.state[rtype]["dup"]?.uuid, adoptedUuid);
    // Alias pointing at the adopted UUID: deleted.
    assert.equal(h.state[rtype]["dup-aaaaaaaa"], undefined);
    assert.ok(h.touched[rtype].has("dup-aaaaaaaa"));
    // Alias pointing at the duplicate UUID: preserved.
    const dupEntry: ResourceState | undefined = h.state[rtype]["dup-bbbbbbbb"];
    assert.equal(dupEntry?.uuid, duplicateUuid);
    assert.equal(h.touched[rtype].has("dup-bbbbbbbb"), false);
    // Unrelated entry: preserved.
    assert.equal(
      h.state[rtype]["unrelated-cccccccc"]?.uuid,
      "99999999-9999-9999-9999-999999999aaa",
    );
    assert.equal(h.touched[rtype].has("unrelated-cccccccc"), false);
  });
}
