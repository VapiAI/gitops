import assert from "node:assert/strict";
import test from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// A 3-way conflict report used to show three 8-character hash prefixes and
// nothing else, which tells a human nothing about which side to keep. These
// tests pin the advisory timing line that replaced that gap.
//
// "Advisory" is the whole contract. The engine must keep refusing to choose,
// because neither timestamp is authoritative: `updatedAt` is bumped by our own
// pushes, local mtime is reset by clone and checkout, and two edits to different
// fields both deserve to survive regardless of which landed last.
// ─────────────────────────────────────────────────────────────────────────────

process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { conflictTimingHint } = await import("../src/pull.ts");

const T0 = Date.parse("2026-08-01T12:00:00.000Z");

test("reports both sides and which is newer when the dashboard moved later", () => {
  const hint = conflictTimingHint({
    dashboardUpdatedAt: new Date(T0 + 3 * 3_600_000).toISOString(),
    localModifiedMs: T0,
  });

  assert.match(hint as string, /dashboard changed 2026-08-01 15:00Z/);
  assert.match(hint as string, /your file 2026-08-01 12:00Z/);
  assert.match(hint as string, /dashboard is 3h newer/);
});

test("reports the local file as newer when it moved later", () => {
  const hint = conflictTimingHint({
    dashboardUpdatedAt: new Date(T0).toISOString(),
    localModifiedMs: T0 + 2 * 86_400_000,
  });

  assert.match(hint as string, /your file is 2d newer/);
});

test("edits within a minute are not called a winner", () => {
  // Sub-minute ordering is noise: clock skew between your machine and the
  // platform is the same order of magnitude as the gap.
  const hint = conflictTimingHint({
    dashboardUpdatedAt: new Date(T0 + 20_000).toISOString(),
    localModifiedMs: T0,
  });

  assert.match(hint as string, /within a minute of each other/);
  assert.doesNotMatch(hint as string, /newer/);
});

test("minutes are used below an hour", () => {
  const hint = conflictTimingHint({
    dashboardUpdatedAt: new Date(T0 + 25 * 60_000).toISOString(),
    localModifiedMs: T0,
  });

  assert.match(hint as string, /dashboard is 25m newer/);
});

test("one side alone still produces a usable line", () => {
  // A resource with no local file, or an unreadable stat, must not blank the
  // whole report.
  assert.match(
    conflictTimingHint({ dashboardUpdatedAt: new Date(T0).toISOString() }) as string,
    /^dashboard changed 2026-08-01 12:00Z$/,
  );
  assert.match(
    conflictTimingHint({ localModifiedMs: T0 }) as string,
    /^your file changed 2026-08-01 12:00Z$/,
  );
});

test("no usable timestamp yields no line at all", () => {
  // The caller appends this to an existing bullet, so an empty hint has to be
  // distinguishable from a hint that happens to be short.
  assert.equal(conflictTimingHint({}), undefined);
  assert.equal(conflictTimingHint({ dashboardUpdatedAt: 1754049600000 }), undefined);
  assert.equal(conflictTimingHint({ dashboardUpdatedAt: "not a date" }), undefined);
  assert.equal(conflictTimingHint({ localModifiedMs: Number.NaN }), undefined);
});

test("a malformed dashboard timestamp falls back to the local side", () => {
  const hint = conflictTimingHint({
    dashboardUpdatedAt: "2026-13-45T99:99:99Z",
    localModifiedMs: T0,
  });

  assert.match(hint as string, /^your file changed 2026-08-01 12:00Z$/);
});
