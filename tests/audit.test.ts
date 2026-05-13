import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// audit.ts → config.ts: config.ts asserts argv[2] / VAPI_TOKEN at module load
// time. Prime both before importing the module under test — same trick used in
// tests/validate.test.ts and tests/path-matching.test.ts.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { _resetIgnoreCache } = await import("../src/config.ts");
const { formatFinding, runAudit, summarizeFindings } = await import(
  "../src/audit.ts"
);

import type { AuditFinding } from "../src/audit.ts";
import type { VapiResource } from "../src/pull.ts";
import type { ResourceState, ResourceType, StateFile } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — keep fixtures DI-friendly and avoid filesystem / network.
// ─────────────────────────────────────────────────────────────────────────────

function makeStateEntry(uuid: string, hash?: string): ResourceState {
  return hash ? { uuid, lastPulledHash: hash } : { uuid };
}

// All sections start empty so callers only populate the type(s) under test.
// StateFile requires every key — partial objects would not type-check.
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

// Default no-op DI bag so each test only overrides the surface it cares about.
function baseOpts(state: StateFile) {
  return {
    types: ["assistants"] as ResourceType[],
    fetchRemote: false as const,
    stateLoader: () => state,
    listLocalIds: (_t: ResourceType) => [] as string[],
    readAssistantTools: (_id: string) => [] as unknown[],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: orphan-yaml
// ─────────────────────────────────────────────────────────────────────────────

test("orphan-yaml: local file with no state entry produces 1 warn finding", async () => {
  const state = makeStateFile();
  const findings = await runAudit({
    ...baseOpts(state),
    listLocalIds: (t) => (t === "assistants" ? ["orphan-bot"] : []),
  });
  const orphans = findings.filter((f) => f.rule === "orphan-yaml");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.severity, "warn");
  assert.equal(orphans[0]!.type, "assistants");
  assert.deepEqual(orphans[0]!.resourceIds, ["orphan-bot"]);
});

test("orphan-yaml: local file that IS in state produces no orphan-yaml finding", async () => {
  const state = makeStateFile({
    assistants: { "known-bot": makeStateEntry("uuid-1") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    listLocalIds: (t) => (t === "assistants" ? ["known-bot"] : []),
  });
  const orphans = findings.filter((f) => f.rule === "orphan-yaml");
  assert.equal(orphans.length, 0);
});

test("orphan-yaml: state has entry but no local file → 0 orphan-yaml findings (inverse is state-ghost)", async () => {
  const state = makeStateFile({
    assistants: { "ghost-bot": makeStateEntry("uuid-1") },
  });
  // listLocalIds returns []; the state entry only contributes to state-ghost
  // (which is gated on fetchRemote=true) — not to orphan-yaml.
  const findings = await runAudit({
    ...baseOpts(state),
    listLocalIds: () => [],
  });
  const orphans = findings.filter((f) => f.rule === "orphan-yaml");
  assert.equal(orphans.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: state-ghost
// ─────────────────────────────────────────────────────────────────────────────

test("state-ghost: state uuid present on dashboard → 0 findings", async () => {
  const state = makeStateFile({
    assistants: { "live-bot": makeStateEntry("uuid-live") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: true,
    remoteFetcher: async (t) =>
      t === "assistants" ? [{ id: "uuid-live", name: "live-bot" }] : [],
  });
  const ghosts = findings.filter((f) => f.rule === "state-ghost");
  assert.equal(ghosts.length, 0);
});

test("state-ghost: state uuid missing from dashboard → 1 warn finding", async () => {
  const state = makeStateFile({
    assistants: { "dead-bot": makeStateEntry("uuid-dead") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: true,
    remoteFetcher: async () => [], // dashboard has nothing
  });
  const ghosts = findings.filter((f) => f.rule === "state-ghost");
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0]!.severity, "warn");
  assert.equal(ghosts[0]!.uuid, "uuid-dead");
  assert.deepEqual(ghosts[0]!.resourceIds, ["dead-bot"]);
});

test("state-ghost: fetchRemote=false short-circuits the check (0 findings)", async () => {
  const state = makeStateFile({
    assistants: { "dead-bot": makeStateEntry("uuid-dead") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: false,
  });
  const ghosts = findings.filter((f) => f.rule === "state-ghost");
  assert.equal(ghosts.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: state-uuid-collision
// ─────────────────────────────────────────────────────────────────────────────

test("state-uuid-collision: 2 slugs pointing at same uuid → 1 error finding", async () => {
  const state = makeStateFile({
    assistants: {
      "slug-a": makeStateEntry("uuid-shared"),
      "slug-b": makeStateEntry("uuid-shared"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const collisions = findings.filter((f) => f.rule === "state-uuid-collision");
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]!.severity, "error");
  assert.equal(collisions[0]!.uuid, "uuid-shared");
  assert.equal(collisions[0]!.resourceIds.length, 2);
  // Sorted output is part of the contract — tests rely on stable diffs.
  assert.deepEqual(collisions[0]!.resourceIds, ["slug-a", "slug-b"]);
});

test("state-uuid-collision: 1 slug per uuid → 0 findings", async () => {
  const state = makeStateFile({
    assistants: {
      "slug-a": makeStateEntry("uuid-1"),
      "slug-b": makeStateEntry("uuid-2"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const collisions = findings.filter((f) => f.rule === "state-uuid-collision");
  assert.equal(collisions.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: content-identical
// ─────────────────────────────────────────────────────────────────────────────

test("content-identical: 4 entries with same lastPulledHash (riley fixture) → 1 warn, 4 slugs", async () => {
  const state = makeStateFile({
    assistants: {
      "riley-1": makeStateEntry("uuid-r1", "hash-shared"),
      "riley-2": makeStateEntry("uuid-r2", "hash-shared"),
      "riley-3": makeStateEntry("uuid-r3", "hash-shared"),
      "riley-4": makeStateEntry("uuid-r4", "hash-shared"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const identicals = findings.filter((f) => f.rule === "content-identical");
  assert.equal(identicals.length, 1);
  assert.equal(identicals[0]!.severity, "warn");
  assert.equal(identicals[0]!.resourceIds.length, 4);
  assert.deepEqual(identicals[0]!.resourceIds, [
    "riley-1",
    "riley-2",
    "riley-3",
    "riley-4",
  ]);
});

test("content-identical: entries missing lastPulledHash are silently skipped (no crash, 0 findings)", async () => {
  const state = makeStateFile({
    assistants: {
      "no-hash-a": makeStateEntry("uuid-a"),
      "no-hash-b": makeStateEntry("uuid-b"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const identicals = findings.filter((f) => f.rule === "content-identical");
  assert.equal(identicals.length, 0);
});

test("content-identical: 2 entries share hash, 1 entry has distinct hash → 1 finding for the 2, the third absent", async () => {
  const state = makeStateFile({
    assistants: {
      "twin-a": makeStateEntry("uuid-a", "hash-twin"),
      "twin-b": makeStateEntry("uuid-b", "hash-twin"),
      lone: makeStateEntry("uuid-c", "hash-lone"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const identicals = findings.filter((f) => f.rule === "content-identical");
  assert.equal(identicals.length, 1);
  assert.deepEqual(identicals[0]!.resourceIds, ["twin-a", "twin-b"]);
  // The lone entry must not appear in any content-identical finding.
  assert.equal(identicals[0]!.resourceIds.includes("lone"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: sibling-base-slug
// ─────────────────────────────────────────────────────────────────────────────

test("sibling-base-slug: bare + 2 suffixed entries cluster under same base → 1 finding, 3 slugs", async () => {
  const state = makeStateFile({
    assistants: {
      "iform-barge": makeStateEntry("uuid-1"),
      "iform-barge-d98136d9": makeStateEntry("uuid-2"),
      "iform-barge-f6b53e27": makeStateEntry("uuid-3"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const siblings = findings.filter((f) => f.rule === "sibling-base-slug");
  assert.equal(siblings.length, 1);
  assert.equal(siblings[0]!.resourceIds.length, 3);
  assert.deepEqual(siblings[0]!.resourceIds, [
    "iform-barge",
    "iform-barge-d98136d9",
    "iform-barge-f6b53e27",
  ]);
  // No content-identical overlap here → message does NOT contain cross-ref.
  assert.equal(
    siblings[0]!.message.includes("overlaps with content-identical"),
    false,
  );
});

test("sibling-base-slug: siblings that share a hash get cross-reference to content-identical", async () => {
  const state = makeStateFile({
    assistants: {
      "iform-barge": makeStateEntry("uuid-1", "hash-shared"),
      "iform-barge-d98136d9": makeStateEntry("uuid-2", "hash-shared"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const siblings = findings.filter((f) => f.rule === "sibling-base-slug");
  assert.equal(siblings.length, 1);
  // Cross-ref token confirms the cascade-duplicate-risk hint fires when
  // sibling cluster overlaps content-identical cluster.
  assert.ok(
    siblings[0]!.message.includes("overlaps with content-identical"),
    `expected cross-ref in sibling message, got: ${siblings[0]!.message}`,
  );
});

test("sibling-base-slug: only one entry (no siblings) → 0 findings", async () => {
  const state = makeStateFile({
    assistants: {
      "iform-barge": makeStateEntry("uuid-1"),
    },
  });
  const findings = await runAudit(baseOpts(state));
  const siblings = findings.filter((f) => f.rule === "sibling-base-slug");
  assert.equal(siblings.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: dashboard-orphan (incl. .vapi-ignore suppression)
// ─────────────────────────────────────────────────────────────────────────────

test("dashboard-orphan: remote uuid present in state → 0 findings", async () => {
  const state = makeStateFile({
    assistants: { "live-bot": makeStateEntry("uuid-live") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: true,
    remoteFetcher: async () => [{ id: "uuid-live", name: "live-bot" }],
  });
  const orphans = findings.filter((f) => f.rule === "dashboard-orphan");
  assert.equal(orphans.length, 0);
});

test("dashboard-orphan: remote uuid NOT in state, no .vapi-ignore match → 1 warn finding", async () => {
  const state = makeStateFile();
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: true,
    remoteFetcher: async () => [{ id: "uuid-unknown", name: "wild-bot" }],
  });
  const orphans = findings.filter((f) => f.rule === "dashboard-orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.severity, "warn");
  assert.equal(orphans[0]!.uuid, "uuid-unknown");
  // Both candidate ids the suppression logic considers must be surfaced —
  // the bare slug and the `<slug>-<uuid8>` form pull.ts emits.
  assert.deepEqual(orphans[0]!.resourceIds, ["wild-bot", "wild-bot-uuid-unk"]);
});

test("dashboard-orphan: fetchRemote=false short-circuits the check (0 findings)", async () => {
  const state = makeStateFile();
  const findings = await runAudit({
    ...baseOpts(state),
    fetchRemote: false,
  });
  const orphans = findings.filter((f) => f.rule === "dashboard-orphan");
  assert.equal(orphans.length, 0);
});

test("dashboard-orphan: .vapi-ignore matching the candidate slug suppresses the finding", async () => {
  // matchesIgnore reads patterns from resources/<env>/.vapi-ignore via a
  // module-private cache. There is no DI seam for patterns on the audit
  // path, so prime the cache by writing a real fixture and resetting
  // between/around the test. Cleanup runs in finally so a thrown assertion
  // still scrubs the filesystem.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");
  const ignoreDir = join(repoRoot, "resources", "test-fixture-org");
  const ignorePath = join(ignoreDir, ".vapi-ignore");

  mkdirSync(ignoreDir, { recursive: true });
  writeFileSync(ignorePath, "assistants/wild-bot\n", "utf-8");
  _resetIgnoreCache();
  try {
    const state = makeStateFile();
    const remote: VapiResource[] = [{ id: "uuid-unknown", name: "wild-bot" }];
    const findings = await runAudit({
      ...baseOpts(state),
      fetchRemote: true,
      remoteFetcher: async () => remote,
    });
    const orphans = findings.filter((f) => f.rule === "dashboard-orphan");
    assert.equal(orphans.length, 0);
  } finally {
    rmSync(ignorePath, { force: true });
    // Best-effort dir cleanup; ignore failure if other tests populated it.
    try {
      rmSync(ignoreDir, { recursive: false });
    } catch {
      /* dir not empty — fine */
    }
    _resetIgnoreCache();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule: inline-tools
// ─────────────────────────────────────────────────────────────────────────────

test("inline-tools: assistant with non-empty model.tools array → 1 warn, message includes count", async () => {
  const state = makeStateFile({
    assistants: { "tool-laden": makeStateEntry("uuid-1") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    readAssistantTools: (id) =>
      id === "tool-laden" ? [{ type: "endCall" }, { type: "transfer" }] : [],
  });
  const inline = findings.filter((f) => f.rule === "inline-tools");
  assert.equal(inline.length, 1);
  assert.equal(inline[0]!.severity, "warn");
  assert.deepEqual(inline[0]!.resourceIds, ["tool-laden"]);
  assert.ok(
    inline[0]!.message.includes("2"),
    `expected tool count in message, got: ${inline[0]!.message}`,
  );
});

test("inline-tools: assistant with empty model.tools array → 0 findings", async () => {
  const state = makeStateFile({
    assistants: { clean: makeStateEntry("uuid-1") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    readAssistantTools: () => [],
  });
  const inline = findings.filter((f) => f.rule === "inline-tools");
  assert.equal(inline.length, 0);
});

test("inline-tools: readAssistantTools returns non-array (treated as no inline tools) → 0 findings", async () => {
  // The readAssistantTools DI surface is typed `unknown[] | Promise<unknown[]>`.
  // The default impl returns [] when model.tools is undefined, so this test
  // pins the contract for "no tools" by returning [] (the canonical empty).
  const state = makeStateFile({
    assistants: { "no-tools-field": makeStateEntry("uuid-1") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    readAssistantTools: () => [],
  });
  const inline = findings.filter((f) => f.rule === "inline-tools");
  assert.equal(inline.length, 0);
});

test("inline-tools: async readAssistantTools (Promise) still fires the finding", async () => {
  const state = makeStateFile({
    assistants: { "async-tool-bot": makeStateEntry("uuid-1") },
  });
  const findings = await runAudit({
    ...baseOpts(state),
    readAssistantTools: async (id) =>
      id === "async-tool-bot" ? [{ type: "endCall" }] : [],
  });
  const inline = findings.filter((f) => f.rule === "inline-tools");
  assert.equal(inline.length, 1);
  assert.deepEqual(inline[0]!.resourceIds, ["async-tool-bot"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — multiple checks coexist
// ─────────────────────────────────────────────────────────────────────────────

test("integration: orphan-yaml + collision + content-identical(4) + sibling-base(3-overlap) coexist", async () => {
  const state = makeStateFile({
    assistants: {
      // 2 distinct slugs sharing a uuid → 1 collision (error)
      "coll-a": makeStateEntry("dup-uuid"),
      "coll-b": makeStateEntry("dup-uuid"),
      // 4 distinct slugs sharing hash H1 → 1 content-identical (warn, 4 slugs)
      "riley-1": makeStateEntry("uuid-r1", "H1"),
      "riley-2": makeStateEntry("uuid-r2", "H1"),
      "riley-3": makeStateEntry("uuid-r3", "H1"),
      "riley-4": makeStateEntry("uuid-r4", "H1"),
      // 3 slugs sharing base "iform-barge"; 2 of them share hash H2 so
      // sibling-base-slug message picks up the cross-ref AND we get one
      // extra content-identical finding for those 2.
      "iform-barge": makeStateEntry("uuid-s1", "H2"),
      "iform-barge-d98136d9": makeStateEntry("uuid-s2", "H2"),
      "iform-barge-f6b53e27": makeStateEntry("uuid-s3"),
    },
  });

  const findings = await runAudit({
    types: ["assistants"],
    fetchRemote: false,
    stateLoader: () => state,
    // 1 orphan-yaml: a local file with no state entry.
    listLocalIds: (t) => (t === "assistants" ? ["stray-local"] : []),
    readAssistantTools: () => [],
  });

  // Total: 1 orphan-yaml + 1 collision + 2 content-identical + 1 sibling
  // = 5 findings, 1 error, 4 warns.
  assert.equal(findings.length, 5);
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  assert.equal(errors.length, 1);
  assert.equal(warns.length, 4);

  // Exact ordering: assistants is the only type, so insertion order follows
  // the check ordering inside runAudit:
  //   orphan-yaml → state-uuid-collision → content-identical → sibling-base-slug
  const rules = findings.map((f) => f.rule);
  assert.deepEqual(rules, [
    "orphan-yaml",
    "state-uuid-collision",
    "content-identical",
    "content-identical",
    "sibling-base-slug",
  ]);

  // The sibling finding must carry the cross-ref token because 2 of the 3
  // siblings (iform-barge, iform-barge-d98136d9) also appear in a
  // content-identical cluster.
  const sibling = findings.find((f) => f.rule === "sibling-base-slug")!;
  assert.ok(sibling.message.includes("overlaps with content-identical"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit-code mapping — spec'd via the same severity-bar logic audit-cmd uses.
//
// GAP: audit-cmd.ts inlines `process.exit(findings.length === 0 ? 0 : 1)`
// rather than delegating to an exported helper. Spec'ing the contract here
// (rather than a subprocess test) is the project pattern for CLI exit codes.
// ─────────────────────────────────────────────────────────────────────────────

function computeExitCode(findings: AuditFinding[]): 0 | 1 {
  return findings.length === 0 ? 0 : 1;
}

test("exit-code: 0 findings → exit 0; ≥1 finding → exit 1 (mirrors audit-cmd severity bar)", () => {
  assert.equal(computeExitCode([]), 0);
  const oneWarn: AuditFinding = {
    severity: "warn",
    type: "assistants",
    rule: "orphan-yaml",
    resourceIds: ["x"],
    message: "msg",
  };
  assert.equal(computeExitCode([oneWarn]), 1);
  const oneError: AuditFinding = { ...oneWarn, severity: "error" };
  assert.equal(computeExitCode([oneError]), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatter helpers
// ─────────────────────────────────────────────────────────────────────────────

test("formatFinding: multi-line output includes rule, severity icon, slugs, message, suggested action", () => {
  const f: AuditFinding = {
    severity: "error",
    type: "assistants",
    rule: "state-uuid-collision",
    resourceIds: ["slug-a", "slug-b"],
    uuid: "uuid-shared",
    message: "2 state slugs share UUID uuid-shared",
    suggestedAction: "manual state edit",
  };
  const out = formatFinding(f);
  const lines = out.split("\n");
  assert.ok(lines.length >= 3, `expected ≥3 lines, got ${lines.length}`);
  assert.ok(out.includes("[state-uuid-collision]"));
  assert.ok(out.includes("assistants/slug-a, slug-b"));
  assert.ok(out.includes("uuid=uuid-shared"));
  assert.ok(out.includes("2 state slugs share UUID uuid-shared"));
  assert.ok(out.includes("manual state edit"));
  // Error severity uses the ❌ icon (warn uses ⚠️).
  assert.ok(out.includes("❌"));
});

test("summarizeFindings: empty array → clean-pass message", () => {
  const out = summarizeFindings([]);
  assert.ok(
    out.includes("No audit findings") || out.includes("0 finding"),
    `expected clean-pass copy, got: ${out}`,
  );
});

test("summarizeFindings: 1 error + 5 warns → '6 finding(s)' with both counts", () => {
  const mk = (severity: "warn" | "error"): AuditFinding => ({
    severity,
    type: "assistants",
    rule: "orphan-yaml",
    resourceIds: ["x"],
    message: "m",
  });
  const findings: AuditFinding[] = [
    mk("error"),
    mk("warn"),
    mk("warn"),
    mk("warn"),
    mk("warn"),
    mk("warn"),
  ];
  const out = summarizeFindings(findings);
  assert.ok(out.includes("6"), `expected total count 6, got: ${out}`);
  assert.ok(out.includes("1"), `expected error count 1, got: ${out}`);
  assert.ok(out.includes("5"), `expected warn count 5, got: ${out}`);
  assert.ok(
    out.toLowerCase().includes("error"),
    `expected 'error' label, got: ${out}`,
  );
  assert.ok(
    out.toLowerCase().includes("warning"),
    `expected 'warning' label, got: ${out}`,
  );
});
